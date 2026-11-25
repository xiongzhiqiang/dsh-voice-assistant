/** V1.7 专家团队管理：清单重整、能力合并、注册表 CRUD、墓碑、语音命令解析。 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_WORKERS, mergeWorkerSources, normalizeWorkers,
} from "../lib/workers.js";
import { normalizeConfig } from "../lib/config.js";
import {
	EXPERT_ID_RE, normalizeExpertInput, createExpertRegistry,
} from "../lib/expert-registry.js";
import { expertDirFromConfig } from "../lib/expert-manager.js";
import {
	deriveExpertId, parseExpertCommand, formatCommandSpeech,
	parseSessionCommand, formatSessionSpeech,
} from "../src/client/core/expert-commands.js";

const failures = [];
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures.push({ name, actual, expected });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` → ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`}`);
};
const tempDir = (prefix) => mkdtempSync(join(tmpdir(), prefix));

// ── ① V2.2：专家定义唯一真相源是目录 JSON，代码里只剩 general 系统锚点 ────
check("代码里不再内置任何领域专家", DEFAULT_WORKERS.length, 1);
check("默认 id 清单（只剩 general）", DEFAULT_WORKERS.map((w) => w.id), ["general"]);
check("general 是系统兜底锚点、不是可增删的专家", DEFAULT_WORKERS[0].id, "general");
check("general 的 sessionId 留空（由 normalizeWorkers 指向根 agent）", DEFAULT_WORKERS[0].sessionId, "");
check("general 不声明技能", DEFAULT_WORKERS[0].skills, []);
check("general 描述仍约束「临床/生医/科研派给专家」", DEFAULT_WORKERS[0].description.includes("临床"), true);
{
	// 目录为空 / 没配目录时，专家层只剩 general，不再铺任何内置领域专家。
	const onlyAnchor = normalizeWorkers(null, "session-voice-assistant-root-v2");
	check("目录为空时只有 general 一位", onlyAnchor.map((w) => w.id), ["general"]);
	check("general 恒指向根 agent", onlyAnchor[0].sessionId, "session-voice-assistant-root-v2");
	const cfgEmpty = normalizeConfig({ routing: { expertDirs: [tempDir("xfv-empty-")] } });
	check("空目录配置里没有内置领域专家", cfgEmpty.routing.workers.map((w) => w.id), ["general"]);
}

// ── ② 输入校验 ──────────────────────────────────────────────────────────
check("id 合法判据：正常", EXPERT_ID_RE.test("chem-v2"), true);
check("id 合法判据：大写拒绝", EXPERT_ID_RE.test("Chem"), false);
check("id 合法判据：路径穿越拒绝", EXPERT_ID_RE.test("../etc"), false);
check("id 合法判据：数字开头允许", EXPERT_ID_RE.test("3d-lab"), true);
check("校验：缺 label", normalizeExpertInput({ id: "chem", description: "x" }).error, "label-required");
check("校验：缺 description", normalizeExpertInput({ id: "chem", label: "化学" }).error, "description-required");
check("校验：保留 id general", normalizeExpertInput({ id: "general", label: "x", description: "x" }).error, "reserved-id");
check("校验：非法 id", normalizeExpertInput({ id: "../x", label: "x", description: "x" }).error, "invalid-id");
check("校验：合法输入通过", normalizeExpertInput({ id: "chem", label: "小化", description: "化学分析" }).ok, true);
check("校验：skills 非数组被忽略", normalizeExpertInput({ id: "chem", label: "x", description: "x", skills: "bad" }).expert.skills, []);

// ── ③ 注册表 CRUD（真实临时目录）────────────────────────────────────────
{
	const dir = tempDir("xfv-reg-");
	const reg = createExpertRegistry(dir);
	check("空目录列出为空", reg.list().experts, []);
	const added = reg.add({ id: "chem", label: "小化 · 化学", description: "化学分析", skills: ["somatic-mutation-report"] });
	check("新增成功", added.ok, true);
	check("新增落盘为文件", existsSync(join(dir, "chem.json")), true);
	const listed = reg.list();
	check("列出含新专家", listed.experts.map((e) => e.id), ["chem"]);
	check("新专家带 skills", listed.experts[0].skills, ["somatic-mutation-report"]);
	// 覆盖同 id
	reg.add({ id: "chem", label: "改名", description: "新描述" });
	check("覆盖同 id 不重复", reg.list().experts.length, 1);
	check("覆盖生效", reg.list().experts[0].label, "改名");
	// 删自定义专家 → 删文件
	const removed = reg.remove("chem");
	check("删自定义专家是删文件", removed.mode, "file");
	check("文件已删", existsSync(join(dir, "chem.json")), false);
	// V2.2 已无内置专家；删一个目录里不存在的 id 时仍写 disabled 墓碑，
	// 保证「删除」这个动作幂等且一定落盘（兼容旧版本遗留的墓碑文件）。
	const tomb = reg.remove("coder");
	check("删不存在的 id 写墓碑（幂等落盘）", tomb.mode, "tombstone");
	check("墓碑文件存在", existsSync(join(dir, "coder.json")), true);
	check("墓碑内容 disabled", JSON.parse(readFileSync(join(dir, "coder.json"), "utf8")).disabled, true);
	check("墓碑在 list 里单独列出", reg.list().tombstones, ["coder"]);
	check("general 不可删", reg.remove("general").error, "reserved-id");
	check("路径穿越 id 不可删", reg.remove("../x").error, "invalid-id");
	// 重建注册表对象指向墓碑再删 → 清成墓碑（幂等）
	check("重复删已是墓碑的 id 仍是墓碑", reg.remove("coder").mode, "tombstone");
}

// ── ④ V2.2 单一数据源：目录可用时只认目录，内联来源不参与 ────────────────
{
	const dir = tempDir("xfv-tomb-");
	writeFileSync(join(dir, "coder.json"), JSON.stringify({ id: "coder", disabled: true }), "utf8");
	writeFileSync(join(dir, "chem.json"), JSON.stringify({ id: "chem", label: "小化 · 化学", description: "化学分析" }), "utf8");
	const merged = mergeWorkerSources(null, null, [dir], null);
	check("墓碑被收集", merged.disabled, ["coder"]);
	check("目录可用时只认目录 JSON", merged.items.map((i) => i.id), ["chem"]);
	check("墓碑不进花名册", merged.items.some((i) => i.id === "coder"), false);

	// 内联来源在目录可用时**不参与**（旧版本的双源漂移已被消除）。
	const withInline = mergeWorkerSources(
		[{ id: "legacy", label: "旧内联" }],
		[{ id: "legacy2", label: "旧内联2" }],
		[dir],
		null,
	);
	check("内联 workers 被忽略", withInline.items.some((i) => i.id === "legacy"), false);
	check("内联 experts 被忽略", withInline.items.some((i) => i.id === "legacy2"), false);
	check("内联忽略后仍是目录唯一来源", withInline.items.map((i) => i.id), ["chem"]);

	// 把 chem 改成墓碑 → 它从花名册消失；general 由 normalizeWorkers 恒补。
	writeFileSync(join(dir, "chem.json"), JSON.stringify({ id: "chem", disabled: true }), "utf8");
	const merged2 = mergeWorkerSources(null, null, [dir], null);
	check("墓碑删掉目录里已定义的专家", merged2.items.some((i) => i.id === "chem"), false);
	check("items 为空（general 不来自目录）", merged2.items.length, 0);
	check("general 恒补、不受墓碑影响", normalizeWorkers(merged2.items, "root").map((w) => w.id), ["general"]);

	// 目录里写 general.json 也不能覆盖系统锚点。
	writeFileSync(join(dir, "general.json"), JSON.stringify({ id: "general", label: "冒充" }), "utf8");
	const merged3 = mergeWorkerSources(null, null, [dir], null);
	check("目录里的 general.json 被忽略", merged3.items.some((i) => i.id === "general"), false);
	const cfg = normalizeConfig({ routing: { expertDirs: [dir] } });
	check("配置里 general 仍是系统锚点", cfg.routing.workers[0].label, "小凤 · 通用");
	check("删光后不会复活任何内置领域专家", cfg.routing.workers.map((w) => w.id), ["general"]);

	// 目录全部不可读时才回退内联来源（兼容旧配置）。
	const inlineOnly = normalizeConfig({ routing: { workers: [{ id: "legacy", label: "旧专家", description: "x" }] } });
	check("未配目录时回退内联 workers", inlineOnly.routing.workers.map((w) => w.id), ["general", "legacy"]);
	const gone = mergeWorkerSources([], [], [join(dir, "nope")], "");
	check("目录不存在（ENOENT）不记假红 problem", gone.problems.length, 0);
	check("目录不存在时由 normalizeWorkers 补 general", normalizeWorkers(gone.items, "root").map((w) => w.id), ["general"]);
}

// ── ⑤ 默认目录回退 ──────────────────────────────────────────────────────
check("有 expertDirs 时取第一个", expertDirFromConfig({ routing: { expertDirs: ["/a/experts", "/b"] } }), "/a/experts");
check("无配置时回退默认目录末尾", expertDirFromConfig({}).endsWith(join("voice-assistant", "experts")), true);

// ── ⑥ 语音命令解析 ──────────────────────────────────────────────────────
check("识别：列出专家", parseExpertCommand("列出专家")?.kind, "list");
check("识别：有哪些专家", parseExpertCommand("现在有哪些专家")?.kind, "list");
check("识别：专家列表", parseExpertCommand("看看专家列表")?.kind, "list");
check("识别：删除专家（英文 id）", parseExpertCommand("删除专家 coder")?.id, "coder");
check("识别：删掉专家（中文名）", parseExpertCommand("删掉专家小化")?.id, "小化");
check("识别：移除专家带 id 前缀", parseExpertCommand("移除专家 id chem-v2")?.id, "chem-v2");
check("删除空参数不识别", parseExpertCommand("删除专家"), null);
const addedCmd = parseExpertCommand("新增专家 化学分析，负责化学相关任务");
check("识别：新增命令 kind", addedCmd?.kind, "add");
check("新增命令 label", addedCmd?.expert?.label, "化学分析");
check("新增命令 description", addedCmd?.expert?.description, "化学相关任务");
check("新增命令生成合法 id", EXPERT_ID_RE.test(addedCmd?.expert?.id ?? ""), true);
const addedCmd2 = parseExpertCommand("添加一个专家 文献助手，专门查论文");
check("识别：添加别名", addedCmd2?.kind, "add");
check("添加别名 description", addedCmd2?.expert?.description, "查论文");
check("普通指令不误识别", parseExpertCommand("帮我看下这个突变有没有临床意义"), null);
check("闲聊不误识别", parseExpertCommand("你好"), null);
check("空串不识别", parseExpertCommand(""), null);
check("非字符串不识别", parseExpertCommand(null), null);

// ── ⑦ id 派生稳定性 ─────────────────────────────────────────────────────
check("英文 label 直接 slug", deriveExpertId("Chem Lab"), "chem-lab");
check("中文 label 稳定哈希", deriveExpertId("化学分析"), deriveExpertId("化学分析"));
check("不同中文 label 哈希不同", deriveExpertId("化学分析") !== deriveExpertId("蛋白设计"), true);
check("哈希 id 合法", EXPERT_ID_RE.test(deriveExpertId("化学分析")), true);

// ── ⑧ 播报文案 ──────────────────────────────────────────────────────────
check("成功播报用 speech", formatCommandSpeech({ ok: true, speech: "好了。" }, "add"), "好了。");
check("非法 id 播报", formatCommandSpeech({ ok: false, error: "invalid-id" }, "add"), "专家名字只能用字母、数字和横线。");
check("保留 id 播报", formatCommandSpeech({ ok: false, error: "reserved-id" }, "remove"), "小凤是默认助手，不能删。");
check("未知错误按命令类型兜底", formatCommandSpeech({ ok: false, error: "weird" }, "remove"), "没删成，请说出要删的专家名字。");

// ── ⑦ V1.8 专家会话命令解析 ──────────────────────────────────────────
check("列出会话", parseSessionCommand("列出会话")?.kind, "session-list");
check("有哪些会话", parseSessionCommand("专家有哪些会话")?.kind, "session-list");
check("给小因开个会话", parseSessionCommand("给小因开个会话")?.kind, "session-create");
check("开会话带专家名", parseSessionCommand("给小因开个会话")?.expertLabel, "小因");
check("新建专家会话", parseSessionCommand("新建小因会话")?.kind, "session-create");
check("新建会话专家名", parseSessionCommand("新建小因会话")?.expertLabel, "小因");
check("切换会话", parseSessionCommand("切换到小因会话")?.kind, "session-switch");
check("切换带序号", parseSessionCommand("用小因会话2")?.index, 2);
check("关闭会话", parseSessionCommand("关闭小因会话")?.kind, "session-close");
check("关闭带中文序号", parseSessionCommand("删掉小因的会话二")?.index, 2);
check("普通指令不误判为会话命令", parseSessionCommand("帮我分析这份数据"), null);
check("列出专家不误判为会话命令", parseSessionCommand("列出专家"), null);
check("会话错误播报", formatSessionSpeech({ ok: false, error: "last-session" }, "session-close"), "这是最后一个会话，得留一个。");
check("会话成功播报", formatSessionSpeech({ ok: true, speech: "好了。" }, "session-create"), "好了。");

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	for (const f of failures) console.error(`  - ${f.name}: ${JSON.stringify(f.actual)} != ${JSON.stringify(f.expected)}`);
	process.exit(1);
}
console.log("\nV1.7 专家管理纯函数全部通过");
