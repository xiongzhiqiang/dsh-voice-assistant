/**
 * 需求①（专家列表 + 技能）与需求④（统一互动流）的宿主半自检。
 *
 * 与 `host.test.mjs` 分开的原因：那两个需求各自新增了一整个模块
 * （`lib/skills.js` / `lib/interactions.js`），塞进既有文件会让"哪一块
 * 挂了"变难定位。这里只覆盖**纯函数**，不依赖 DSH 运行时。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeConfig, clientConfig } from "../lib/config.js";
import { PLUGIN_VERSION } from "../lib/version.js";
import { mergeWorkerSources, normalizeWorkers, workerTargets, DEFAULT_WORKERS, mergeSkillState } from "../lib/workers.js";
import {
	splitFrontmatter,
	frontmatterField,
	readSkillFile,
	scanSkillRoot,
	loadSkillCatalog,
	registerExpertSkills,
	describeExpertSkills,
} from "../lib/skills.js";
import {
	createInteractionQueue,
	createInteractionHub,
	questionCallOf,
	formatQuestionSpeech,
	formatApprovalSpeech,
	truncate,
	parseInteractionAfter,
	INTERACTION_LIMIT,
} from "../lib/interactions.js";
import { APPROVAL_KIND, QUESTION_KIND, REPORT_KIND, INTERACTION_KINDS, needsAction } from "../lib/interaction-kinds.js";

const failures = [];
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures.push({ name, actual, expected });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` → ${JSON.stringify(actual)}`}`);
};

/** 造一个临时目录；用完由下面的 cleanup 统一删。 */
const tempDirs = [];
const tempDir = (prefix) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
};

// ── frontmatter 解析（不引 YAML 依赖，只做够用的标量）──────────────────
check("无 frontmatter 时整篇是正文", splitFrontmatter("# 标题\n正文").front, "");
check("无 frontmatter 时正文完整", splitFrontmatter("# 标题\n正文").body, "# 标题\n正文");
check("切出 frontmatter", splitFrontmatter("---\nname: a-b\n---\n正文").front.trim(), "name: a-b");
check("切出正文", splitFrontmatter("---\nname: a-b\n---\n正文").body.trim(), "正文");
check("未闭合的 frontmatter 不误切", splitFrontmatter("---\nname: a-b\n正文").front, "");
{
	const front = "name: somatic-mutation-report\ndescription: \"带引号的描述\"\nwhenToUse: 需要出报告时";
	check("取普通标量", frontmatterField(front, "name"), "somatic-mutation-report");
	check("双引号被剥掉", frontmatterField(front, "description"), "带引号的描述");
	check("取 whenToUse", frontmatterField(front, "whenToUse"), "需要出报告时");
	check("取不存在的字段返回空串", frontmatterField(front, "nope"), "");
	check("单引号也被剥掉", frontmatterField("k: 'v'", "k"), "v");
	// `>` 折叠块必须拼成一行 —— 技能描述是多行 YAML 是很常见的写法。
	const folded = "description: >\n  第一行\n  第二行\nname: x";
	check("折叠块拼成一行", frontmatterField(folded, "description"), "第一行 第二行");
	check("折叠块后的字段仍能取到", frontmatterField(folded, "name"), "x");
	const literal = "description: |\n  字面块\n  第二行";
	check("字面块同样拼成一行", frontmatterField(literal, "description"), "字面块 第二行");
	// 值里的冒号不能被当成新字段（`description: 见下：xxx` 这种中文冒号也常见）。
	check("值内冒号不影响解析", frontmatterField("description: 步骤：第一步", "description"), "步骤：第一步");
	check("块标量里的键名不抢外层", frontmatterField("a: >\n  name: 假\nb: 真", "name"), "");
}

// ── 技能文件读取：名称以 frontmatter 为准 ──────────────────────────────
{
	const dir = tempDir("xfv-skill-");
	const file = join(dir, "SKILL.md");
	writeFileSync(file, "---\nname: real-name\ndescription: 真正描述\n---\n流程正文\n", "utf8");
	const skill = readSkillFile(file, "dir-name");
	check("名称以 frontmatter 为准", skill.name, "real-name");
	check("描述取 frontmatter", skill.description, "真正描述");
	check("正文不含 frontmatter", skill.content, "流程正文");
	check("whenToUse 缺省是空串", skill.whenToUse, "");

	// description 缺失 → 用正文首个非空行兜底（register 空描述会抛）。
	const noDesc = join(dir, "no-desc.md");
	writeFileSync(noDesc, "# 兜底标题\n正文", "utf8");
	check("缺描述时用正文首行兜底", readSkillFile(noDesc, "fallback").description, "兜底标题");

	// 名字非法（大写/下划线）→ 整个技能不可用，而不是注册时炸掉。
	const badName = join(dir, "bad.md");
	writeFileSync(badName, "---\nname: Bad_Name\ndescription: d\n---\n正文", "utf8");
	check("非法技能名判为不可用", readSkillFile(badName, "bad"), null);

	// 空正文 → 不可用（注册一个没内容的技能只会白占 context）。
	const emptyBody = join(dir, "empty.md");
	writeFileSync(emptyBody, "---\nname: empty-one\ndescription: d\n---\n", "utf8");
	check("空正文判为不可用", readSkillFile(emptyBody, "empty-one"), null);

	check("读不存在的文件返回 null", readSkillFile(join(dir, "nope.md"), "nope"), null);
}

// ── 根目录扫描：深度只有一层 ───────────────────────────────────────────
{
	const root = tempDir("xfv-root-");
	// 单层目录 + SKILL.md（标准形态）
	mkdirSync(join(root, "alpha"));
	writeFileSync(join(root, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: 甲\n---\n甲正文", "utf8");
	// 扁平单文件 `<name>.md`
	writeFileSync(join(root, "beta.md"), "---\nname: beta\ndescription: 乙\n---\n乙正文", "utf8");
	// 双层目录 —— DSH 口径下**不被发现**（本机踩过这个坑）
	mkdirSync(join(root, "gamma", "gamma"), { recursive: true });
	writeFileSync(join(root, "gamma", "gamma", "SKILL.md"), "---\nname: gamma\ndescription: 丙\n---\n丙正文", "utf8");
	// 点开头的目录要跳过
	mkdirSync(join(root, ".hidden"));
	writeFileSync(join(root, ".hidden", "SKILL.md"), "---\nname: hidden\ndescription: 隐\n---\n隐正文", "utf8");

	const found = scanSkillRoot(root);
	check("单层目录被发现", found.has("alpha"), true);
	check("扁平 md 被发现", found.has("beta"), true);
	check("双层目录不被发现（与 DSH 同口径）", found.has("gamma"), false);
	check("点开头目录被跳过", found.has("hidden"), false);
	check("扫描结果可序列化（Map 转数组）", [...found.keys()].sort(), ["alpha", "beta"]);
	check("不存在的根目录返回空表而不是抛", scanSkillRoot(join(root, "nope")).size, 0);
}

// ── 内置优先 + 用户补位 ────────────────────────────────────────────────
{
	const builtin = tempDir("xfv-bi-");
	const user = tempDir("xfv-us-");
	mkdirSync(join(builtin, "shared"));
	writeFileSync(join(builtin, "shared", "SKILL.md"), "---\nname: shared\ndescription: 内置版\n---\n内置正文", "utf8");
	mkdirSync(join(user, "shared"));
	writeFileSync(join(user, "shared", "SKILL.md"), "---\nname: shared\ndescription: 用户版\n---\n用户正文", "utf8");
	mkdirSync(join(user, "extra"));
	writeFileSync(join(user, "extra", "SKILL.md"), "---\nname: extra\ndescription: 用户独有\n---\n用户正文", "utf8");

	const catalog = loadSkillCatalog({ builtinDir: builtin, userDir: user });
	check("同名时内置胜出", catalog.skills.get("shared").description, "内置版");
	check("用户独有技能被收进来", catalog.skills.has("extra"), true);
	check(
		"被遮蔽的同名要如实上报（否则用户以为改了没生效）",
		catalog.sources.filter((s) => s.from === "user-shadowed").map((s) => s.name),
		["shared"],
	);
	check("三个来源都记录在案", catalog.sources.length, 3);
	check("两个根目录都回传（health 要显示）", [catalog.builtinDir, catalog.userDir], [builtin, user]);
}

// ── 技能注册：挂在 agent 作用域上 ──────────────────────────────────────
{
	const dir = tempDir("xfv-reg-");
	mkdirSync(join(dir, "one"));
	writeFileSync(join(dir, "one", "SKILL.md"), "---\nname: one\ndescription: 一号\nwhenToUse: 需要时\n---\n一号正文", "utf8");
	const catalog = loadSkillCatalog({ builtinDir: dir, userDir: join(dir, "nope") });

	const registered = [];
	const agentCtx = {
		get: (name) => (name === "skills" ? { register: (skill) => registered.push(skill) } : undefined),
	};
	const outcome = registerExpertSkills(agentCtx, ["one"], catalog);
	check("注册成功的名字被回报", outcome.registered, ["one"]);
	check("注册参数 = 技能定义（带 whenToUse）", registered[0], {
		name: "one",
		description: "一号",
		content: "一号正文",
		whenToUse: "需要时",
	});
	check("注册内容不含 frontmatter", registered[0].content.includes("description:"), false);

	// 空清单：不碰服务（避免无谓的 get，也避免 absent-service 噪声）。
	let touched = false;
	const outcome2 = registerExpertSkills({ get: () => { touched = true; return undefined; } }, [], catalog);
	check("空清单直接返回", outcome2, { registered: [], missing: [], reason: "" });
	check("空清单不访问 skills 服务", touched, false);

	// 服务缺席：降级但不抛（Cordis 里未声明 inject 的服务 get 会**同步抛**）。
	const missing = registerExpertSkills({ get: () => { throw new Error("service not declared"); } }, ["one"], catalog);
	check("服务取用时抛错被兜住（不连坐插件）", missing.registered, []);
	check("原因可读", String(missing.reason).startsWith("get-threw:"), true);
	check("缺失名单如实上报", missing.missing, ["one"]);

	// catalog 里没有这个名字（用户写错了技能名）→ missing，不抛。
	const absent = registerExpertSkills({ get: () => ({ register() {} }) }, ["nope"], catalog);
	check("技能名不存在时进 missing", absent.missing, ["nope"]);

	// 单个技能注册抛错（比如同层重名）不吃掉其它技能。
	const partial = registerExpertSkills(
		{ get: () => ({ register: (skill) => { if (skill.name === "one") throw new Error("duplicate"); } }) },
		["one"],
		catalog,
	);
	check("注册失败进 missing", partial.missing, ["one"]);
	check("失败原因带技能名", partial.reason.includes("register-failed(one)"), true);

	// 重复点名只注册一次。
	const twice = [];
	registerExpertSkills({ get: () => ({ register: (s) => twice.push(s.name) }) }, ["one", "one"], catalog);
	check("重复点名只注册一次", twice, ["one"]);

	check("describeExpertSkills 报可用与缺失", describeExpertSkills(["one", "nope"], catalog), {
		declared: ["one", "nope"],
		available: ["one"],
		missing: ["nope"],
	});
}

// ── 内置技能真实可读（回归：文件被误删/写坏要立刻报警）──────────────────
{
	const catalog = loadSkillCatalog();
	check("插件内置技能目录里有 somatic-mutation-report", catalog.skills.has("somatic-mutation-report"), true);
	const skill = catalog.skills.get("somatic-mutation-report");
	check("内置技能有描述", typeof skill?.description === "string" && skill.description.length > 10, true);
	check("内置技能正文有实质内容", (skill?.content ?? "").length > 500, true);
	// frontmatter 里写 `>` 折叠标量时校验器会误判（skill-creator 的坑），
	// 这里顺带守住"描述必须是单行"。
	check("描述不含换行", /\n/.test(skill?.description ?? ""), false);
}

// ── mergeWorkerSources：目录唯一真相源 + 坏文件不连坐 ────────────────────
{
	const dir = tempDir("xfv-exp-");
	writeFileSync(join(dir, "chem.json"), JSON.stringify({ id: "chem", label: "小化 · 化学", description: "分子建模。", skills: ["somatic-mutation-report"] }), "utf8");
	writeFileSync(join(dir, "broken.json"), "{ 这不是 JSON", "utf8");
	writeFileSync(join(dir, "no-id.json"), JSON.stringify({ label: "缺 id" }), "utf8");
	writeFileSync(join(dir, "ignored.txt"), "不是 json", "utf8");

	// V2.2：目录可用时，内联 workers/experts 一律不参与 —— 单一数据源，
	// 不再有"YAML 里还活着、目录里已删"的双源漂移。
	const merged = mergeWorkerSources(
		[{ id: "coder", label: "我的码神" }],
		[{ id: "bioinfo", label: "我的小因" }, { id: "coder", label: "应被高优先级盖住" }],
		[dir],
		"",
	);
	check("目录可用时只认目录 JSON", merged.items.map((item) => item.id), ["chem"]);
	check("内联 workers 不参与花名册", merged.items.some((i) => i.id === "coder"), false);
	check("内联 experts 不参与花名册", merged.items.some((i) => i.id === "bioinfo"), false);
	check("目录里的专家被读进来", merged.items.find((i) => i.id === "chem").label, "小化 · 化学");
	check("坏 JSON 被跳过并记入 problems", merged.problems.filter((p) => p.includes("broken.json")).length, 1);
	check("缺 id 被跳过并记入 problems", merged.problems.filter((p) => p.includes("no-id.json")).length, 1);
	check("非 json 文件不当专家", merged.items.some((i) => i.id === "ignored"), false);
	// 目录不存在（ENOENT）是正常初始态：不记假红 problem，items 为空由
	// normalizeWorkers 补 general —— 不再铺任何内置领域专家。
	const goneDir = mergeWorkerSources([], [], [join(dir, "nope")], "");
	check("目录不存在不记 problems", goneDir.problems.length, 0);
	check("目录不存在时 items 为空（不再铺内置专家）", goneDir.items.map((i) => i.id), []);
	check("目录不存在时补 general 锚点", normalizeWorkers(goneDir.items, "session-voice-assistant-root").map((i) => i.id), ["general"]);

	// 目录 JSON 是完整定义：不存在"与默认模板合并 / 继承默认人格"。
	const workers = normalizeWorkers(merged.items, "session-voice-assistant-root");
	const chem = workers.find((w) => w.id === "chem");
	check("目录专家带展示名", chem.label, "小化 · 化学");
	check("目录专家声明的技能被保留", chem.skills, ["somatic-mutation-report"]);
	check("目录专家有兜底 sessionId", chem.sessionId, "session-voice-worker-chem");
	check("general 恒在首位且不带技能", workers[0].skills, []);

	// 技能名归一化：去空、去重、去空白（内联来源在目录未配时仍可用，顺带守住
	// 旧配置路径）。
	//
	// 注意**不按文法过滤**非法名（`Bad_Name` 会留在清单里）：这样
	// `describeExpertSkills` 能把它报成 `missing`，用户在 health 里看得见
	// "我拼错了一个技能名"。若这里静默滤掉，用户只会看到"声明了 0 个技能"，
	// 反而更难查 —— 真正的防线是注册时 `catalog.skills.get()` 取不到就不挂。
	const messy = normalizeConfig({
		routing: { workers: [{ id: "x", label: "X", skills: ["ok-name", "Bad_Name", 42, "", "ok-name", "  spaced  "] }] },
	});
	check("技能名去空、去重、去空白", messy.routing.workers.find((w) => w.id === "x").skills, ["ok-name", "Bad_Name", "spaced"]);
	check("非字符串项被丢掉", messy.routing.workers.find((w) => w.id === "x").skills.includes(42), false);
	// 单个字符串按"一位技能"解释（YAML 里写 `skills: my-skill` 是常见笔误，
	// 直接当数组用比报错友好）。
	check("字符串形式的 skills 当作单项", normalizeConfig({ routing: { workers: [{ id: "y", skills: "nope" }] } }).routing.workers.find((w) => w.id === "y").skills, ["nope"]);
	check("归一化结果里 problems 恒存在", Array.isArray(messy.routing.problems), true);
}

// ── 配置下发：能力名要给，正文不给 ─────────────────────────────────────
{
	const dir = tempDir("xfv-client-exp-");
	writeFileSync(join(dir, "chem.json"), JSON.stringify({
		id: "chem", label: "小化 · 化学", description: "分子建模。",
		persona: "你是小化。", skills: ["somatic-mutation-report"],
	}), "utf8");
	const cfg = normalizeConfig({ routing: { expertDirs: [dir] } });
	const client = clientConfig(cfg, {});
	check("客户端能拿到专家描述", client.routing.workers.every((w) => typeof w.description === "string"), true);
	check("客户端能拿到专家技能名", client.routing.workers.find((w) => w.id === "chem").skills, ["somatic-mutation-report"]);
	check("客户端配置不含技能正文", JSON.stringify(client).includes("AMP/ASCO/CAP"), false);
	check("花名册 = general 锚点 + 1 位目录专家", client.routing.workers.map((w) => w.id), ["general", "chem"]);
	check("workerTargets 与 clientConfig 同形", workerTargets(cfg.routing.workers)[0].skills, []);
	check("未配目录时只下发 general", clientConfig(normalizeConfig(undefined), {}).routing.workers.map((w) => w.id), ["general"]);
}

// ── 互动队列：严格单调 at（按时间先后呈现的地基）───────────────────────
{
	const queue = createInteractionQueue({ limit: 3 });
	check("首帧 latest 只同步游标、不重放", queue.after("latest").interactions.length, 0);
	check("首帧 latest 回传当前游标", queue.after("latest").cursor, 0);

	const a = queue.push({ kind: "approval", key: "a1", speech: "甲需要确认" });
	const b = queue.push({ kind: "question", key: "q1", speech: "乙要问一句" });
	check("第二条严格晚于第一条（同毫秒也不撞）", b.at > a.at, true);
	// seq 是人读序号，必须从 1 开始递增 —— 不能拿毫秒戳 `at` 兼职
	// （`cursor + 1` 会得到 1.7e12，日志里没法看）。
	check("seq 是人读序号（从 1 起递增）", [a.seq, b.seq], [1, 2]);
	check("seq 与 at 职责分开（at 是毫秒戳）", b.at > 1e12, true);
	check("after(0) 按发生先后升序", queue.after(0).interactions.map((e) => e.kind), ["approval", "question"]);
	check("游标落在最后一条", queue.after(0).cursor, b.at);
	check("after 之前的取不到（严格大于）", queue.after(b.at).interactions.length, 0);
	check("游标非数字时退化为 0（不吞历史）", queue.after("garbage").interactions.length, 2);
	check("size 反映条数", queue.size, 2);

	// 溢出时丢最旧的（长期运行不能让内存无界增长）。
	queue.push({ kind: "report", key: "r1", speech: "丙干完了" });
	queue.push({ kind: "report", key: "r2", speech: "丁干完了" });
	check("超上限丢最旧的", queue.size, 3);
	check("保留的是最新的三条", queue.snapshot(9).map((e) => e.key), ["q1", "r1", "r2"]);
	check("播报文案超长被截断（TTS 长了没人听）", createInteractionQueue().push({ speech: "字".repeat(500) }).speech.length, 400);
	check("缺字段不崩且补空串", createInteractionQueue().push({}).kind, "");
	check("snapshot 是副本（外部改不动队列）", (() => {
		const q = createInteractionQueue();
		q.push({ kind: "report", key: "k", speech: "s" });
		const copy = q.snapshot(1)[0];
		copy.speech = "改了";
		return q.snapshot(1)[0].speech;
	})(), "s");
	check("默认上限是 200", INTERACTION_LIMIT, 200);

	queue.clear();
	check("clear 后为空", queue.size, 0);
	check("clear 后游标归零", queue.after(0).cursor, 0);
}

// ── 提问事件解析（与客户端 questions.js 同口径，形状不能改）─────────────
{
	const call = {
		type: "tool/call",
		data: {
			name: "ask_user_question",
			callId: "call-1",
			arguments: JSON.stringify({
				questions: [
					{ header: "风格", question: "要哪种风格？", options: [{ label: "简洁" }, { label: "详细" }], multi_select: true },
				],
			}),
		},
	};
	const parsed = questionCallOf(call);
	check("抠出 callId", parsed.callId, "call-1");
	check("抠出问题文本", parsed.questions[0].question, "要哪种风格？");
	check("选项标签被解析", parsed.questions[0].options, ["简洁", "详细"]);
	check("multi_select 转成 multiSelect", parsed.questions[0].multiSelect, true);
	check("header 带出来", parsed.questions[0].header, "风格");
	check("已是对象时不再 JSON.parse", questionCallOf({ type: "tool/call", data: { name: "ask_user_question", callId: "c", arguments: { questions: [{ question: "q" }] } } }).questions.length, 1);
	check("别的工具不认", questionCallOf({ type: "tool/call", data: { name: "bash", callId: "c" } }), null);
	check("别的事件类型不认", questionCallOf({ type: "tool/result", data: { name: "ask_user_question", callId: "c" } }), null);
	check("坏 JSON 不认", questionCallOf({ type: "tool/call", data: { name: "ask_user_question", callId: "c", arguments: "{坏" } }), null);
	check("缺 callId 不认", questionCallOf({ type: "tool/call", data: { name: "ask_user_question", arguments: "{\"questions\":[]}" } }), null);
	check("问题清单为空不认", questionCallOf({ type: "tool/call", data: { name: "ask_user_question", callId: "c", arguments: "{\"questions\":[]}" } }), null);
	check("null 事件不崩", questionCallOf(null), null);

	check("单问播报带选项", formatQuestionSpeech(parsed.questions), "风格：要哪种风格？。选项：一是简洁，二是详细。请到界面上作答。");
	// 措辞必须让用户知道"要去界面"：本插件不代答是硬约束。
	check("多问按序播报", formatQuestionSpeech([{ header: "", question: "A？", options: [] }, { header: "", question: "B？", options: [] }]), "第一问，A？；第二问，B？。请到界面上作答。");
	check("空清单也能给出收尾句", formatQuestionSpeech([]), "。请到界面上作答。");
}

// ── 审批文案：只说"需要你确认"，绝不说"已允许/已拒绝" ──────────────────
{
	const speech = formatApprovalSpeech({ label: "小因", toolName: "bash", reason: "escalate sandbox to danger-full-access: 需要写文件" });
	check("念出专家名", speech.includes("小因"), true);
	check("念出工具名", speech.includes("bash"), true);
	check("点明要去界面处理", speech.includes("请到界面上允许或拒绝"), true);
	check("绝不声称已代答", /已(允许|拒绝|同意)/.test(speech), false);
	check("缺 label 时用泛称", formatApprovalSpeech({ toolName: "bash" }).startsWith("后台任务"), true);
	check("缺工具名时用泛称", formatApprovalSpeech({ label: "阿码" }).includes("执行一个操作"), true);
	check("超长 reason 被截断", formatApprovalSpeech({ reason: "x".repeat(300) }).length < 200, true);

	check("truncate 不动短文本", truncate("短", 10), "短");
	check("truncate 加省略号", truncate("一二三四五", 3), "一二…");
	check("truncate 对 null 安全", truncate(null), "");
}

// ── 互动中枢：只对白名单会话入队 ───────────────────────────────────────
{
	/** 最小事件总线。 */
	const makeCtx = () => {
		const handlers = new Map();
		return {
			on(name, callback) {
				const set = handlers.get(name) ?? new Set();
				set.add(callback);
				handlers.set(name, set);
				return () => set.delete(callback);
			},
			emit(name, ...args) {
				for (const callback of handlers.get(name) ?? []) callback(...args);
			},
			get: () => undefined,
			logger: { info() {}, warn() {} },
		};
	};

	// V2.2：专家来自目录 JSON，这里显式造一位 bioinfo 供互动中枢监听测试。
	const hubDir = tempDir("xfv-hub-exp-");
	writeFileSync(join(hubDir, "bioinfo.json"), JSON.stringify({ id: "bioinfo", label: "小因 · 基因分析", description: "基因分析" }), "utf8");
	const config = normalizeConfig({ routing: { enabled: true, expertDirs: [hubDir] } });
	const ctx = makeCtx();
	const hub = createInteractionHub(ctx, config);
	const rootSession = { id: config.agent.sessionId };
	const bioinfoSession = { id: config.routing.workers.find((w) => w.id === "bioinfo").sessionId };
	const strangerSession = { id: "session-someone-else" };

	check("监听到的会话数 = 去重后的会话数（general 与根 agent 同一会话）",
		hub.state().watching,
		1 + config.routing.workers.filter((w) => w.sessionId !== "" && w.sessionId !== config.agent.sessionId).length);
	check("general 的 sessionId 就是根会话（不另开一条）",
		config.routing.workers.find((w) => w.id === "general").sessionId,
		config.agent.sessionId);

	// 陌生会话（用户自己的对话）绝不入队 —— 否则用户会被自己的审批刷屏。
	ctx.emit("session/event", strangerSession, { type: "approval/asked", data: { id: "s1", toolName: "bash" } });
	check("陌生会话的审批不入队", hub.queue.size, 0);

	ctx.emit("session/event", bioinfoSession, { type: "approval/asked", data: { id: "a1", toolName: "bash", reason: "要写文件" } });
	check("worker 会话的审批入队", hub.queue.size, 1);
	check("审批类型正确", hub.queue.after(0).interactions[0].kind, APPROVAL_KIND);
	check("带上专家展示名", hub.queue.after(0).interactions[0].label, "小因 · 基因分析");
	ctx.emit("session/event", bioinfoSession, { type: "approval/asked", data: { id: "a1", toolName: "bash" } });
	check("同一审批 id 不重复念", hub.queue.size, 1);
	// decided 是结果，不重复念（否则同一件事响两次）。
	ctx.emit("session/event", bioinfoSession, { type: "approval/decided", data: { id: "a1" } });
	check("approval/decided 不入队", hub.queue.size, 1);

	ctx.emit("session/event", rootSession, {
		type: "tool/call",
		data: { name: "ask_user_question", callId: "c1", arguments: JSON.stringify({ questions: [{ question: "选哪个？" }] }) },
	});
	check("根会话的提问入队", hub.queue.size, 2);
	check("提问类型正确", hub.queue.after(0).interactions[1].kind, QUESTION_KIND);
	check("提问按发生先后排在审批之后", hub.queue.after(0).interactions.map((e) => e.kind), [APPROVAL_KIND, QUESTION_KIND]);
	ctx.emit("session/event", rootSession, {
		type: "tool/call",
		data: { name: "ask_user_question", callId: "c1", arguments: JSON.stringify({ questions: [{ question: "选哪个？" }] }) },
	});
	check("同一 callId 不重复念", hub.queue.size, 2);

	// 汇报并进同一条流（需求④的三类合流）。
	hub.pushReport({ jobId: "j1", label: "阿码", speech: "阿码回报：修好了。", ok: true });
	check("汇报并进同一条流", hub.queue.after(0).interactions.map((e) => e.kind), [APPROVAL_KIND, QUESTION_KIND, REPORT_KIND]);
	check("汇报在最后（发生最晚）", hub.queue.after(0).interactions.at(-1).kind, REPORT_KIND);

	check("state 暴露开关", [hub.state().enabled, hub.state().announceApprovals, hub.state().announceQuestions], [true, true, true]);
	check("state 暴露最近条目（health 用）", hub.state().recent.length, 3);
	check("中枢带出类型白名单", hub.kinds, INTERACTION_KINDS);

	hub.dispose();
	ctx.emit("session/event", bioinfoSession, { type: "approval/asked", data: { id: "a9", toolName: "bash" } });
	check("dispose 后不再入队", hub.queue.size, 3);
}

// ── 互动中枢：两个开关各自生效 ─────────────────────────────────────────
{
	const makeCtx = () => {
		const handlers = new Map();
		return {
			on(name, callback) {
				const set = handlers.get(name) ?? new Set();
				set.add(callback);
				handlers.set(name, set);
				return () => set.delete(callback);
			},
			emit(name, ...args) {
				for (const callback of handlers.get(name) ?? []) callback(...args);
			},
			get: () => undefined,
			logger: { info() {}, warn() {} },
		};
	};

	{
		const config = normalizeConfig({ interactions: { announceApprovals: false } });
		const ctx = makeCtx();
		const hub = createInteractionHub(ctx, config);
		const session = { id: config.agent.sessionId };
		ctx.emit("session/event", session, { type: "approval/asked", data: { id: "a", toolName: "bash" } });
		check("关掉审批播报后审批不入队", hub.queue.size, 0);
		ctx.emit("session/event", session, { type: "tool/call", data: { name: "ask_user_question", callId: "c", arguments: "{\"questions\":[{\"question\":\"q\"}]}" } });
		check("但提问仍入队（两个开关互不影响）", hub.queue.size, 1);
		hub.dispose();
	}
	{
		const config = normalizeConfig({ interactions: { enabled: false } });
		const ctx = makeCtx();
		const hub = createInteractionHub(ctx, config);
		const session = { id: config.agent.sessionId };
		ctx.emit("session/event", session, { type: "approval/asked", data: { id: "a", toolName: "bash" } });
		ctx.emit("session/event", session, { type: "tool/call", data: { name: "ask_user_question", callId: "c", arguments: "{\"questions\":[{\"question\":\"q\"}]}" } });
		check("总闸关掉后一类都不入队", hub.queue.size, 0);
		hub.pushReport({ jobId: "j", label: "阿码", speech: "x" });
		check("总闸关掉后汇报也不入队", hub.queue.size, 0);
		check("state 如实报关闭", hub.state().enabled, false);
		hub.dispose();
	}
	{
		// 监听不上不该让插件挂掉（降级可见）。
		const ctx = { on: () => { throw new Error("no session service"); }, get: () => undefined, logger: { warn() {} } };
		const hub = createInteractionHub(ctx, normalizeConfig(undefined));
		check("无法旁听时仍返回可用的中枢", typeof hub.pushReport, "function");
		hub.pushReport({ jobId: "j", label: "阿码", speech: "照常汇报" });
		check("无法旁听时汇报链路仍通", hub.queue.size, 1);
		hub.dispose();
	}
}

// ── interactions 配置归一化 ────────────────────────────────────────────
{
	const d = normalizeConfig(undefined).interactions;
	check("互动流默认开启", d.enabled, true);
	check("审批播报默认开", d.announceApprovals, true);
	check("提问播报默认开", d.announceQuestions, true);
	check("轮询间隔默认 1500", d.pollMs, 1500);
	check("队列上限默认 200", d.limit, 200);
	check("轮询间隔下界夹取", normalizeConfig({ interactions: { pollMs: 1 } }).interactions.pollMs, 500);
	check("轮询间隔上界夹取", normalizeConfig({ interactions: { pollMs: 999999 } }).interactions.pollMs, 10000);
	check("队列上限下界夹取", normalizeConfig({ interactions: { limit: 1 } }).interactions.limit, 10);
	check("队列上限上界夹取", normalizeConfig({ interactions: { limit: 999999 } }).interactions.limit, 1000);
	check("字符串 true 不算真（只认真布尔）", normalizeConfig({ interactions: { enabled: "true" } }).interactions.enabled, true);
	check("字符串 false 不算假", normalizeConfig({ interactions: { enabled: "false" } }).interactions.enabled, true);
	check("显式关可关闭", normalizeConfig({ interactions: { enabled: false } }).interactions.enabled, false);
	check("下发配置带 pollMs（客户端据此定时）", clientConfig(d2()).interactions.pollMs, 3000);
	check("下发配置带两个开关", [clientConfig(d2()).interactions.announceApprovals, clientConfig(d2()).interactions.announceQuestions], [false, true]);
	check("下发配置不含 limit（队列在宿主侧）", "limit" in clientConfig(d2()).interactions, false);

	/** 造一份自定义互动配置用于下发检查。 */
	function d2() {
		return normalizeConfig({ interactions: { pollMs: 3000, announceApprovals: false } });
	}
}

// ── after 参数解析 ─────────────────────────────────────────────────────
check("无参数为 null", parseInteractionAfter("/plugins/dsh-voice-assistant/api/interactions"), null);
check("latest 原样返回", parseInteractionAfter("/plugins/dsh-voice-assistant/api/interactions?after=latest"), "latest");
check("数字原样返回", parseInteractionAfter("/api/interactions?after=1700000000000"), "1700000000000");
check("空值当无参", parseInteractionAfter("/api/interactions?after="), null);
check("多个参数中能挑出 after", parseInteractionAfter("/api/interactions?x=1&after=latest&y=2"), "latest");
check("编码过的值会解码", parseInteractionAfter("/api/interactions?after=a%20b"), "a b");
check("url 为 null 不崩", parseInteractionAfter(null), null);

// ── 类型常量（宿主与客户端共用的白名单）─────────────────────────────────
check("三类互动齐全", INTERACTION_KINDS, ["approval", "question", "report"]);
check("审批需要用户去界面处理", needsAction(APPROVAL_KIND), true);
check("提问需要用户去界面处理", needsAction(QUESTION_KIND), true);
check("汇报只需听结论", needsAction(REPORT_KIND), false);

// ── 用户自定义专家目录入口（V2.2：唯一真相源）────────────────────────────
{
	const dir = tempDir("xfv-user-exp-");
	writeFileSync(join(dir, "my-expert.json"), JSON.stringify({ id: "mine", label: "我的专家", description: "干我的事。", skills: [] }), "utf8");
	const cfg = normalizeConfig({ routing: { expertDirs: [dir] } });
	check("目录里新加一位专家即生效", cfg.routing.workers.some((w) => w.id === "mine"), true);
	check("新专家带上展示名", cfg.routing.workers.find((w) => w.id === "mine").label, "我的专家");
	check("新专家有兜底 sessionId", cfg.routing.workers.find((w) => w.id === "mine").sessionId, "session-voice-worker-mine");
	// V2.2：代码里不再内置任何领域专家，花名册 = general 锚点 + 目录 JSON。
	check("不再有内置领域专家 bioinfo", cfg.routing.workers.some((w) => w.id === "bioinfo"), false);
	check("总数 = general 锚点 + 目录 1 位", cfg.routing.workers.length, 2);
	check("旧写法单值 expertDir 也认", normalizeConfig({ routing: { expertDir: dir } }).routing.workers.some((w) => w.id === "mine"), true);
	check("runtime 下发的 expertDirs 与归一化一致", normalizeConfig({ routing: { expertDirs: [dir] } }).routing.expertDirs, [dir]);
	check("problems 为空（没有坏文件）", cfg.routing.problems, []);
}
{
	// 目录 JSON 是**完整定义**：改 label / 加技能都直接生效，不存在"继承默认模板"。
	const dir = tempDir("xfv-user-exp2-");
	writeFileSync(join(dir, "bioinfo.json"), JSON.stringify({
		id: "bioinfo", label: "我的小因", description: "基因分析",
		persona: "你是小因。", skills: ["somatic-mutation-report"],
	}), "utf8");
	const cfg = normalizeConfig({ routing: { expertDirs: [dir] } });
	const bioinfo = cfg.routing.workers.find((w) => w.id === "bioinfo");
	check("目录文件的展示名生效", bioinfo.label, "我的小因");
	check("目录文件的描述生效", bioinfo.description, "基因分析");
	check("目录文件的人格生效", bioinfo.persona, "你是小因。");
	check("目录文件声明的技能生效", bioinfo.skills, ["somatic-mutation-report"]);
	check("花名册只有 general + 这一位目录专家", cfg.routing.workers.map((w) => w.id), ["general", "bioinfo"]);
}
{
	// 目录可用时，内联 workers **完全不参与**（旧版本"内联优先"已废弃）。
	const dir = tempDir("xfv-user-exp3-");
	writeFileSync(join(dir, "coder.json"), JSON.stringify({ id: "coder", label: "目录里的码神", description: "x" }), "utf8");
	writeFileSync(join(dir, "chem.json"), JSON.stringify({ id: "chem", label: "小化", description: "x" }), "utf8");
	const cfg = normalizeConfig({ routing: { workers: [{ id: "coder", label: "YAML 里的码神" }], expertDirs: [dir] } });
	check("内联定义不再盖掉目录专家", cfg.routing.workers.find((w) => w.id === "coder").label, "目录里的码神");
	check("目录里的第二位专家也在", cfg.routing.workers.some((w) => w.id === "chem"), true);
	check("花名册严格 = general + 目录两位", cfg.routing.workers.map((w) => w.id), ["general", "chem", "coder"]);
}

// ── 技能状态合成：只报 catalog 可用会谎报 ──────────────────────────────
{
	// 关键场景：技能文件**存在**（available 有），但 `registry.register()` 失败
	// （比如同层重名）。只报 available 会显示"技能正常"，而专家其实不会那个
	// 流程 —— 这正是最需要被看见的静默故障。
	const described = { declared: ["a", "b"], available: ["a", "b"], missing: [] };
	check("注册成功时 registered = 声明的技能", mergeSkillState(described, { registered: ["a", "b"], missing: [], reason: "" }).registered, ["a", "b"]);
	check(
		"注册失败时 registered 不含它（不谎报可用）",
		mergeSkillState(described, { registered: ["a"], missing: ["b"], reason: "register-failed(b): duplicate" }).registered,
		["a"],
	);
	check(
		"注册失败的技能进 missing（并集）",
		mergeSkillState(described, { registered: ["a"], missing: ["b"], reason: "" }).missing,
		["b"],
	);
	check(
		"missing 是并集（找不到 + 挂不上都算）",
		mergeSkillState({ declared: ["a", "typo"], available: ["a"], missing: ["typo"] }, { registered: ["a"], missing: [], reason: "" }).missing,
		["typo"],
	);
	check("reason 透传（排障要用）", mergeSkillState(described, { registered: [], missing: [], reason: "skills-service-missing" }).reason, "skills-service-missing");
	// 没接技能桥（该专家没声明技能）时，registered 退回 available 的副本，
	// 不能让 health 报一个"声明了但一个都没挂"的假故障。
	check("未接线时 registered 等于 available", mergeSkillState({ declared: [], available: [], missing: [] }, null).registered, []);
	check("未接线时状态可读", mergeSkillState({ declared: ["a"], available: ["a"], missing: [] }, undefined).registered, ["a"]);
	check("declared/available 原样保留", mergeSkillState(described, { registered: ["a"], missing: [] }).declared, ["a", "b"]);
}

// ── 版本号与打包清单不漂移 ─────────────────────────────────────────────
{
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	// health 里的版本号曾长期停在 0.1.0，排查时会把人带偏。
	check("health 版本号与 package.json 一致", PLUGIN_VERSION, pkg.version);
	// `files` 漏掉 `skills/` 的后果很隐蔽：junction 安装（开发机）看不出问题，
	// 打包安装后内置技能全部消失，专家"忽然不会那个流程了"。这里钉住它。
	check("打包清单包含 skills/（内置技能要随包走）", pkg.files.includes("skills/"), true);
	check("包名为 dsh-voice-assistant", pkg.name, "dsh-voice-assistant");
}

// ── 临时目录清理 ───────────────────────────────────────────────────────
for (const dir of tempDirs) {
	try {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	} catch {
		// 清理失败不影响结论。
	}
}

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	for (const failure of failures) console.error(`  - ${failure.name}: ${JSON.stringify(failure.actual)} / 期望 ${JSON.stringify(failure.expected)}`);
	process.exitCode = 1;
} else {
	console.log("\n全部通过");
}
