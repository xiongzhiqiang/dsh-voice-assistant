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
} from "../src/client/core/expert-commands.js";

const failures = [];
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures.push({ name, actual, expected });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` → ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`}`);
};
const tempDir = (prefix) => mkdtempSync(join(tmpdir(), prefix));

// ── ① 专家清单重整（4 位领域专家，能力合并）────────────────────────────
check("默认 4 位专家", DEFAULT_WORKERS.length, 4);
check("默认 id 清单", DEFAULT_WORKERS.map((w) => w.id), ["general", "bioinfo", "pathologist", "protein-designer"]);
check("转录组未转成专家（用户要求一并删除）", DEFAULT_WORKERS.some((w) => w.id === "transcriptome-expert"), false);
for (const id of ["bioinfo", "pathologist", "protein-designer"]) {
	const w = DEFAULT_WORKERS.find((x) => x.id === id);
	check(`${id} persona 含编程能力`, w.persona.includes("编程"), true);
	check(`${id} persona 含调研能力`, w.persona.includes("调研"), true);
	check(`${id} persona 含本机操作能力`, w.persona.includes("本机操作"), true);
}
check("病理专家有独立会话", DEFAULT_WORKERS.find((w) => w.id === "pathologist").sessionId, "session-voice-worker-pathologist");
check("蛋白设计专家有独立会话", DEFAULT_WORKERS.find((w) => w.id === "protein-designer").sessionId, "session-voice-worker-protein-designer");
check("基因专家保留技能", DEFAULT_WORKERS.find((w) => w.id === "bioinfo").skills, ["somatic-mutation-report"]);

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
	// 删内置专家 → 墓碑
	const tomb = reg.remove("coder");
	check("删内置专家是写墓碑", tomb.mode, "tombstone");
	check("墓碑文件存在", existsSync(join(dir, "coder.json")), true);
	check("墓碑内容 disabled", JSON.parse(readFileSync(join(dir, "coder.json"), "utf8")).disabled, true);
	check("墓碑在 list 里单独列出", reg.list().tombstones, ["coder"]);
	check("general 不可删", reg.remove("general").error, "reserved-id");
	check("路径穿越 id 不可删", reg.remove("../x").error, "invalid-id");
	// 重建注册表对象指向墓碑再删 → 清成墓碑（幂等）
	check("重复删已是墓碑的 id 仍是墓碑", reg.remove("coder").mode, "tombstone");
}

// ── ④ 墓碑压过默认清单 ──────────────────────────────────────────────────
{
	const dir = tempDir("xfv-tomb-");
	writeFileSync(join(dir, "coder.json"), JSON.stringify({ id: "coder", disabled: true }), "utf8");
	const merged = mergeWorkerSources(null, null, [dir], null);
	check("墓碑被收集", merged.disabled, ["coder"]);
	check("合并后不含被删的 coder（默认清单里本来也没有，此处验证不误报）", merged.items.some((i) => i.id === "coder"), false);
	// 用旧代码里仍存在的默认专家做墓碑测试： bioinfo
	writeFileSync(join(dir, "bioinfo.json"), JSON.stringify({ id: "bioinfo", disabled: true }), "utf8");
	const merged2 = mergeWorkerSources(null, null, [dir], null);
	check("墓碑删默认专家 bioinfo", merged2.items.some((i) => i.id === "bioinfo"), false);
	check("墓碑不影响其它默认专家", merged2.items.some((i) => i.id === "pathologist"), true);
	check("general 永不被墓碑删掉", merged2.items.some((i) => i.id === "general"), true);
	// 全删光也不会恢复默认（避免 items 空被 normalizeWorkers 误判未配置）
	const dir2 = tempDir("xfv-tomball-");
	for (const w of DEFAULT_WORKERS) writeFileSync(join(dir2, `${w.id}.json`), JSON.stringify({ id: w.id, disabled: true }), "utf8");
	const all = mergeWorkerSources(null, null, [dir2], null);
	check("删光后 items 只剩 general", all.items.map((i) => i.id), ["general"]);
	const cfg = normalizeConfig({ routing: { expertDirs: [dir2] } });
	check("删光后配置里仍只有 general（没复活默认）", cfg.routing.workers.map((w) => w.id), ["general"]);
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

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	for (const f of failures) console.error(`  - ${f.name}: ${JSON.stringify(f.actual)} != ${JSON.stringify(f.expected)}`);
	process.exit(1);
}
console.log("\nV1.7 专家管理纯函数全部通过");
