/**
 * V2.3（需求③④）任务列表记忆 + 归属判定 + 会话按任务名命名 —— 单测。
 *
 * 这一批逻辑的共同点是**判错很难从界面上看出来**：任务跑到别的会话去了，
 * 用户只会觉得"它怎么又开了一个新会话"。所以这里的断言全部围绕
 * "什么情况下必须复用、什么情况下必须新建、名字什么时候能被覆盖"。
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	makeTaskId,
	titleFromTask,
	normalizeForMatch,
	similarity,
	matchTask,
	normalizeTaskStore,
	upsertTask,
	renderTaskList,
	taskContextText,
	createExpertTaskStore,
	TASKS_PER_WORKER_LIMIT,
	TASK_MATCH_STRONG,
	IDLE_SESSION_LABEL,
} from "../lib/expert-tasks.js";
import { parseAttribution, attributeTask, TASK_MATCH_WEAK } from "../lib/task-route.js";
import { createExpertSessionStore, isIdleLabel } from "../lib/expert-sessions.js";
import { createTaskManager } from "../lib/task-manager.js";

const failures = [];
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures.push({ name, actual, expected });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` → ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`}`);
};

// ── 任务 id ───────────────────────────────────────────────────────────
{
	const a = makeTaskId("bioinfo", 1700000000000, "ab12");
	check("任务 id 带专家名", a.includes("bioinfo"), true);
	check("任务 id 有 task 前缀", a.startsWith("task-"), true);
	check("不同随机后缀不撞车", a !== makeTaskId("bioinfo", 1700000000000, "ab13"), true);
	check("非法字符被清洗", /[.]/.test(makeTaskId("a.b/c")), false);
}

// ── 标题提取（需求③：会话用任务名命名）────────────────────────────────
{
	check("剥掉礼貌前缀", titleFromTask("帮我分析一下 AG28 的差异表达"), "分析一下 AG28 的差异表达");
	check("叠层前缀反复剥", titleFromTask("麻烦帮我看看这个报错"), "看看这个报错");
	check("取第一个停顿前的分句", titleFromTask("先跑差异分析。然后再画火山图。"), "先跑差异分析");
	check("首分句过短时退回整句", titleFromTask("先看。然后再画火山图"), "先看。然后再画火山图");
	check("去尾部语气词", titleFromTask("跑一下差异分析吧"), "跑一下差异分析");
	check("超长标题截断加省略号", titleFromTask("x".repeat(60)).length, 24);
	check("截断后有省略号", titleFromTask("一".repeat(60)).endsWith("…"), true);
	check("空文本给占位名", titleFromTask("   "), "未命名任务");
	check("null 给占位名", titleFromTask(null), "未命名任务");
	check("纯前缀剥空后仍给可用名", titleFromTask("帮我").length > 0, true);
}

// ── 相似度 ────────────────────────────────────────────────────────────
{
	check("归一化去标点与大小写", normalizeForMatch("AG28_D3-1!"), "ag28d31");
	check("同一句话相似度为 1", similarity("分析AG28差异表达", "分析AG28差异表达"), 1);
	check("仅大小写不同视为相同", similarity("AG28差异", "ag28差异"), 1);
	check("空串相似度为 0", similarity("", "分析"), 0);
	check("无关任务相似度低", similarity("写个 README", "分析AG28差异表达") < TASK_MATCH_STRONG, true);
	const close = similarity("分析 AG28 的差异表达", "分析AG28差异表达");
	check("仅插入虚词仍高于强阈值", close >= TASK_MATCH_STRONG, true);
}

// ── 台账匹配 ──────────────────────────────────────────────────────────
{
	const tasks = [
		{ taskId: "t1", title: "分析 AG28 差异表达", task: "分析 AG28 的差异表达" },
		{ taskId: "t2", title: "写 README", task: "给这个仓库写个 README" },
	];
	check("命中第一条", matchTask(tasks, "分析 AG28 差异表达").task.taskId, "t1");
	check("空台账不命中", matchTask([], "任意").task, null);
	check("空台账得分 0", matchTask([], "任意").score, 0);
	check("脏条目被跳过不抛", matchTask([null, "x", {}], "任意").task !== undefined, true);
}

// ── 台账归一化与增改 ──────────────────────────────────────────────────
{
	const store = normalizeTaskStore({
		workers: {
			bioinfo: {
				tasks: [
					{ taskId: "t1", title: "甲", sessionId: "s1", task: "甲任务", count: 2, createdAt: 1, updatedAt: 2 },
					{ taskId: "t1", title: "重复", sessionId: "s2" },
					null,
					{ taskId: "", title: "空 id" },
				],
			},
			broken: "not-an-object",
		},
	});
	check("归一化保留合法任务", store.workers.bioinfo.tasks.length, 1);
	check("归一化去重 taskId", store.workers.bioinfo.tasks[0].title, "甲");
	check("归一化保留 count", store.workers.bioinfo.tasks[0].count, 2);
	check("归一化跳过坏 worker", store.workers.broken === undefined, true);

	// upsert：新建
	let tasks = upsertTask([], { taskId: "t9", title: "新任务", sessionId: "s9", task: "原文", at: 100 });
	check("upsert 新建一条", tasks.length, 1);
	check("upsert 初始 count 为 1", tasks[0].count, 1);
	check("upsert 记 createdAt", tasks[0].createdAt, 100);
	// upsert：续上（同一 taskId）
	tasks = upsertTask(tasks, { taskId: "t9", title: "应被忽略的新标题", sessionId: "s9", task: "追问原文", at: 200 });
	check("upsert 续上不新增", tasks.length, 1);
	check("upsert 保留首名（不被追问文本改掉）", tasks[0].title, "新任务");
	check("upsert 累计次数", tasks[0].count, 2);
	check("upsert 更新原文", tasks[0].task, "追问原文");
	check("upsert 更新 updatedAt", tasks[0].updatedAt, 200);
	check("空 taskId 不落账", upsertTask([], { taskId: "", title: "x" }).length, 0);
	// 上限
	let many = [];
	for (let i = 0; i < TASKS_PER_WORKER_LIMIT + 8; i += 1) many = upsertTask(many, { taskId: `t${i}`, title: `任务${i}` });
	check("台账条数受上限约束", many.length, TASKS_PER_WORKER_LIMIT);
	check("台账保留最新的", many[many.length - 1].taskId, `t${TASKS_PER_WORKER_LIMIT + 7}`);
}

// ── 台账渲染 ──────────────────────────────────────────────────────────
{
	const tasks = [
		{ taskId: "t1", title: "甲任务", status: "active" },
		{ taskId: "t2", title: "乙任务", status: "done" },
	];
	check("渲染含任务名", renderTaskList(tasks).includes("甲任务"), true);
	check("渲染最新在前", renderTaskList(tasks).split("\n")[0].includes("乙任务"), true);
	check("渲染标注进行中/已完成", renderTaskList(tasks).includes("已完成"), true);
	check("空台账渲染为空串", renderTaskList([]), "");
	check("注入文本带标题", taskContextText(tasks).includes("历史任务"), true);
	check("空台账注入为空串", taskContextText([]), "");
}

// ── 归属判定：解析 ────────────────────────────────────────────────────
{
	const ids = ["t1", "t2"];
	check("解析合法 id", parseAttribution('{"taskId":"t1"}', ids), "t1");
	check("解析代码块包裹", parseAttribution('```json\n{"taskId":"t2"}\n```', ids), "t2");
	check("前后带解释也能解析", parseAttribution('好的：{"taskId":"t1"} 就这个', ids), "t1");
	check("清单外的 id 视为新任务", parseAttribution('{"taskId":"t99"}', ids), "");
	check("空 taskId 视为新任务", parseAttribution('{"taskId":""}', ids), "");
	check("空输出视为新任务", parseAttribution("", ids), "");
	check("非 JSON 视为新任务", parseAttribution("我觉得是 t1", ids), "");
	check("非法 JSON 视为新任务", parseAttribution("{oops}", ids), "");
}

// ── 归属判定：三段决策 ────────────────────────────────────────────────
{
	// 假 ctx：无 llm 服务 → attributeWithModel 直接返回 ""，走到弱阈值兜底。
	const ctx = { get: () => undefined, logger: { warn: () => {} } };
	const config = { routing: { timeoutMs: 6000 } };
	const tasks = [
		{ taskId: "t1", title: "分析 AG28 差异表达", sessionId: "s1", task: "分析 AG28 的差异表达", updatedAt: 100 },
		{ taskId: "t2", title: "写仓库 README", sessionId: "s2", task: "给这个仓库写个 README", updatedAt: 200 },
	];

	// 强命中：规则直接拍板（不等模型）。
	const strong = await attributeTask(ctx, config, { workerId: "bioinfo", label: "小因", task: "分析 AG28 差异表达", tasks });
	check("几乎同一句话走规则命中", strong.via, "rule");
	check("规则命中复用原任务", strong.taskId, "t1");
	check("规则命中复用原会话", strong.sessionId, "s1");
	check("规则命中不算新任务", strong.created, false);

	// 空台账 → 直接新任务（连模型都不问）。
	const empty = await attributeTask(ctx, config, { workerId: "bioinfo", label: "小因", task: "随便什么", tasks: [] });
	check("空台账直接是新任务", empty.created, true);
	check("空台账 via 为 new", empty.via, "new");
	check("空台账给了标题", empty.title.length > 0, true);

	// LLM 不可用 + 字面重叠不足 → 新任务。
	const fresh = await attributeTask(ctx, config, { workerId: "bioinfo", label: "小因", task: "给这个仓库写个" + "完全无关的东西".repeat(3), tasks });
	check("LLM 不可用且不相似 → 新任务", fresh.created, true);

	// allowModel=false 时也不问模型，行为一致。
	const noModel = await attributeTask(ctx, config, { workerId: "bioinfo", label: "小因", task: "分析 AG28 差异表达", tasks, allowModel: false });
	check("关掉模型仍走规则命中", noModel.via, "rule");

	// 弱阈值兜底确实存在（构造一条相似度介于两档之间的文本）。
	const weakText = "分析 AG28 表达";
	const weak = await attributeTask(ctx, config, { workerId: "bioinfo", label: "小因", task: weakText, tasks });
	const score = matchTask(tasks, weakText).score;
	check("弱阈值小于强阈值", TASK_MATCH_WEAK < TASK_MATCH_STRONG, true);
	check("弱阈值场景可被兜底接住", score >= TASK_MATCH_WEAK || weak.created === true, true);
}

// ── 归属判定：LLM 命中路径 ────────────────────────────────────────────
{
	// 假 llm：无论问什么都答 t2。
	const llm = {
		stream: () => {
			let i = 0;
			const chunks = [
				{ type: "text-delta", text: '{"taskId"' },
				{ type: "text-delta", text: ': "t2"}' },
				// 思维链分片必须被丢弃（只认 text-delta）。
				{ type: "reasoning-delta", text: "ignore me" },
			];
			return {
				[Symbol.asyncIterator]: () => ({
					next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }),
				}),
			};
		},
	};
	const ctx = { get: (name) => (name === "llm" ? llm : undefined), logger: { warn: () => {} } };
	// resolveRoute 要能解析出模型：这里用显式 polish.provider/model 走最短路径。
	const config = { polish: { provider: "p", model: "m" }, routing: { timeoutMs: 6000 } };
	const tasks = [
		{ taskId: "t1", title: "分析 AG28 差异表达", sessionId: "s1", task: "分析 AG28 的差异表达", updatedAt: 100 },
		{ taskId: "t2", title: "写仓库 README", sessionId: "s2", task: "给这个仓库写个 README", updatedAt: 200 },
	];
	// 这句与两条都不够像 → 走模型 → 模型说是 t2。
	const result = await attributeTask(ctx, config, { workerId: "bioinfo", label: "小因", task: "把说明文档补一下", tasks });
	check("模型可介入并命中", result.taskId, "t2");
	check("模型命中标 via=llm", result.via, "llm");
	check("模型命中复用原会话", result.sessionId, "s2");
}

// ── 会话命名（需求③）──────────────────────────────────────────────────
{
	const tmp = mkdtempSync(join(tmpdir(), "xfv-task-"));
	const store = createExpertSessionStore(join(tmp, "experts"));

	check("默认会话占位名是待命", store.ensureDefault({ id: "bioinfo", label: "小因" }).session.label, IDLE_SESSION_LABEL);
	check("占位名判定：待命", isIdleLabel("待命"), true);
	check("占位名判定：旧版默认会话", isIdleLabel("默认会话"), true);
	check("占位名判定：会话 3", isIdleLabel("会话 3"), true);
	check("占位名判定：已命名不算占位", isIdleLabel("分析 AG28 差异表达"), false);

	const defSid = store.activeOf("bioinfo");
	const renamed = store.nameByTask("bioinfo", defSid, "分析 AG28 差异表达");
	check("首个任务可命名占位会话", renamed.ok === true && renamed.changed === true, true);
	check("名字已生效", store.listFor("bioinfo").sessions[0].label, "分析 AG28 差异表达");
	// 第二个任务名不该覆盖已定下的名字。
	const again = store.nameByTask("bioinfo", defSid, "另一个任务名");
	check("已有实名不被后续任务覆盖", again.changed, false);
	check("名字保持不变", store.listFor("bioinfo").sessions[0].label, "分析 AG28 差异表达");
	// 显式重命名允许覆盖（用户命令路径）。
	const forced = store.renameSession("bioinfo", defSid, "用户起的名字", { onlyIfIdle: false });
	check("显式重命名可覆盖", forced.changed, true);
	check("显式名字已生效", store.listFor("bioinfo").sessions[0].label, "用户起的名字");
	// 新建会话默认待命。
	const created = store.createSession("bioinfo");
	check("新建会话默认待命（不是会话 N）", created.session.label, IDLE_SESSION_LABEL);
	check("无效重命名被拒", store.renameSession("bioinfo", defSid, "").error, "invalid-rename");
	check("未知会话重命名被拒", store.renameSession("bioinfo", "nope", "x").error, "session-not-found");

	// 旧版「默认会话」标签读盘后迁成占位名，从而可被首个任务命名。
	writeFileSync(store.file, JSON.stringify({
		workers: { bioinfo: { sessions: [{ sessionId: "s-old", label: "默认会话", active: true }], activeSessionId: "s-old" } },
	}), "utf8");
	const store2 = createExpertSessionStore(join(tmp, "experts"));
	store2.reload();
	check("旧版默认会话迁移为待命", store2.listFor("bioinfo").sessions[0].label, IDLE_SESSION_LABEL);
	check("迁移后可被首任务命名", store2.nameByTask("bioinfo", "s-old", "老任务名").changed, true);
}

// ── 任务台账落盘 ──────────────────────────────────────────────────────
{
	const tmp = mkdtempSync(join(tmpdir(), "xfv-taskstore-"));
	const store = createExpertTaskStore(join(tmp, "experts"));
	check("台账文件在 _state 子目录", store.file.includes("_state"), true);
	check("初始无台账", store.list().bioinfo === undefined, true);

	const rec = store.record("bioinfo", { taskId: "t1", title: "甲任务", sessionId: "s1", task: "甲原文", at: 1 });
	check("记一条任务成功", rec.ok === true && rec.created === true, true);
	check("台账已落盘", existsSync(store.file), true);
	check("重复记同一 taskId 不算新建", store.record("bioinfo", { taskId: "t1", title: "甲任务", sessionId: "s1", task: "追问", at: 2 }).created, false);
	check("续上后 count 为 2", store.listFor("bioinfo")[0].count, 2);
	check("general 不记台账", store.record("general", { taskId: "t9", title: "x", sessionId: "s" }).ok, false);
	check("空 taskId 不记", store.record("bioinfo", { taskId: "", title: "x", sessionId: "s" }).ok, false);

	check("按会话反查任务", store.bySession("bioinfo", "s1").taskId, "t1");
	check("未知会话反查为 null", store.bySession("bioinfo", "nope"), null);

	store.patch("bioinfo", "t1", { status: "done", at: 5 });
	check("标记完成", store.listFor("bioinfo")[0].status, "done");

	// 重载保持。
	const store2 = createExpertTaskStore(join(tmp, "experts"));
	check("重载无 problem", store2.reload().length, 0);
	check("台账持久化", store2.listFor("bioinfo")[0].taskId, "t1");
	check("状态持久化", store2.listFor("bioinfo")[0].status, "done");

	// 删专家清台账。
	check("删专家清台账", store2.removeWorker("bioinfo").changed, true);
	check("删后无台账", store2.list().bioinfo === undefined, true);

	// 坏文件容错。
	writeFileSync(store.file, "{ not json", "utf8");
	const store3 = createExpertTaskStore(join(tmp, "experts"));
	const problems = store3.reload();
	check("坏文件记 problem 不抛", problems.length > 0 && problems[0].includes("解析失败"), true);
	check("坏文件后按空表处理", store3.list().bioinfo === undefined, true);
}

// ── 归属中枢（需求④ 端到端）──────────────────────────────────────────
{
	const base = mkdtempSync(join(tmpdir(), "xfv-tm-"));
	const taskStore = createExpertTaskStore(join(base, "experts"));
	const sessionStore = createExpertSessionStore(join(base, "experts"));

	// 假的会话管理中枢：create 建会话并命名，list 反映注册表。
	const sessionManager = {
		create: async (workerId, label) => {
			const created = sessionStore.createSession(workerId, label);
			return created.ok === true ? { ok: true, session: created.session } : created;
		},
		activeOf: (workerId) => sessionStore.activeOf(workerId),
		list: (workerId) => ({ [workerId]: sessionStore.listFor(workerId) }),
		store: sessionStore,
	};
	const workers = { bioinfo: { id: "bioinfo", label: "小因 · 基因分析" } };
	const manager = createTaskManager({
		store: taskStore,
		sessionManager,
		workerOf: (id) => workers[id] ?? null,
		logger: { info: () => {}, warn: () => {} },
	});

	sessionStore.ensureDefault({ id: "bioinfo", sessionId: "sess-default", label: "小因" });
	const ctx = { get: () => undefined, logger: { warn: () => {} } };
	const config = { routing: { timeoutMs: 6000 } };

	// 第一条指令：台账为空 → 新任务 → 开新会话（入口 A）。
	const first = await manager.resolveTarget(ctx, config, { workerId: "bioinfo", task: "分析 AG28 的差异表达" });
	check("首条指令判为新任务", first.created, true);
	check("首条指令开了会话", first.sessionId !== "", true);
	check("首个任务名来自任务文本", first.title, "分析 AG28 的差异表达");
	check("新会话名字就是任务名", sessionStore.listFor("bioinfo").sessions.find((s) => s.sessionId === first.sessionId).label, "分析 AG28 的差异表达");
	check("台账已记一条", manager.listFor("bioinfo").length, 1);

	// 第二条：几乎同一句话复述 → 复用老会话（规则强命中）。
	const repeat = await manager.resolveTarget(ctx, config, { workerId: "bioinfo", task: "分析 AG28 差异表达" });
	check("复述归入老任务", repeat.taskId, first.taskId);
	check("复述回老会话", repeat.sessionId, first.sessionId);
	check("复述不再新建会话", sessionStore.listFor("bioinfo").sessions.length, 2);
	check("复述不新增台账条目", manager.listFor("bioinfo").length, 1);
	check("复述累计次数为 2", manager.listFor("bioinfo")[0].count, 2);

	// 第三条：完全无关 → 新任务 + 新会话。
	const other = await manager.resolveTarget(ctx, config, { workerId: "bioinfo", task: "给这个仓库写一个安装说明并做代码审查" });
	check("无关指令判为新任务", other.created, true);
	check("无关指令另开会话", other.sessionId !== first.sessionId, true);
	check("台账累到两条", manager.listFor("bioinfo").length, 2);
	check("新会话也按任务名命名", sessionStore.listFor("bioinfo").sessions.find((s) => s.sessionId === other.sessionId).label.includes("安装说明"), true);

	// 台账注入文本包含两条任务。
	const injected = manager.contextText("bioinfo");
	check("注入文本含第一条任务", injected.includes("分析 AG28 的差异表达"), true);
	check("注入文本含第二条任务", injected.includes("安装说明"), true);

	// 会话关闭 → 任务重指（不能留着指向死会话）。
	const fallback = sessionStore.activeOf("bioinfo");
	manager.onSessionClosed("bioinfo", other.sessionId, fallback);
	const otherTask = manager.listFor("bioinfo").find((t) => t.taskId === other.taskId);
	check("会话关闭后任务已重指", otherTask.sessionId, fallback);

	// 会话被用户手删后，老任务的会话不在 liveSessions 里 → 续成新会话
	// （而不是错误地接到别的任务上）。
	const orphanTmp = mkdtempSync(join(tmpdir(), "xfv-orphan-"));
	const orphanTasks = createExpertTaskStore(join(orphanTmp, "experts"));
	const orphanSessions = createExpertSessionStore(join(orphanTmp, "experts"));
	orphanSessions.ensureDefault({ id: "bioinfo", sessionId: "sess-live" });
	orphanTasks.record("bioinfo", { taskId: "t-old", title: "分析 AG28 的差异表达", sessionId: "sess-gone", task: "分析 AG28 的差异表达", at: 1 });
	const orphanManager = createTaskManager({
		store: orphanTasks,
		sessionManager: {
			create: async (workerId, label) => {
				const created = orphanSessions.createSession(workerId, label);
				return created.ok === true ? { ok: true, session: created.session } : created;
			},
			activeOf: (workerId) => orphanSessions.activeOf(workerId),
			list: (workerId) => ({ [workerId]: orphanSessions.listFor(workerId) }),
			store: orphanSessions,
		},
		workerOf: () => ({ id: "bioinfo", label: "小因" }),
		logger: { info: () => {}, warn: () => {} },
	});
	const revived = await orphanManager.resolveTarget(ctx, config, { workerId: "bioinfo", task: "分析 AG28 的差异表达" });
	check("原会话不存在时改开新会话", revived.sessionId !== "sess-gone", true);
	check("复用原 taskId 而不是另起一条", revived.taskId, "t-old");
	check("台账里的会话已更新", orphanTasks.listFor("bioinfo")[0].sessionId, revived.sessionId);

	// 会话数达上限 → 退活跃会话照常投递（不拒绝派单）。
	const cappedTmp = mkdtempSync(join(tmpdir(), "xfv-capped-"));
	const cappedTasks = createExpertTaskStore(join(cappedTmp, "experts"));
	const cappedSessions = createExpertSessionStore(join(cappedTmp, "experts"));
	cappedSessions.ensureDefault({ id: "bioinfo", sessionId: "sess-0" });
	for (let i = 1; i < 16; i += 1) cappedSessions.createSession("bioinfo");
	const cappedManager = createTaskManager({
		store: cappedTasks,
		sessionManager: {
			create: async (workerId, label) => {
				const created = cappedSessions.createSession(workerId, label);
				return created.ok === true ? { ok: true, session: created.session } : created;
			},
			activeOf: (workerId) => cappedSessions.activeOf(workerId),
			list: (workerId) => ({ [workerId]: cappedSessions.listFor(workerId) }),
			store: cappedSessions,
		},
		workerOf: () => ({ id: "bioinfo", label: "小因" }),
		logger: { info: () => {}, warn: () => {} },
	});
	const capped = await cappedManager.resolveTarget(ctx, config, { workerId: "bioinfo", task: "一个全新的任务" });
	check("会话达上限时不拒绝派单", capped.ok, true);
	check("达上限时退到活跃会话", capped.sessionId, cappedSessions.activeOf("bioinfo"));
	check("达上限时标 via=fallback", capped.via, "fallback");

	// 参数不合法 → 明确失败（调用方据此拒绝派单）。
	const bad = await cappedManager.resolveTarget(ctx, config, { workerId: "", task: "" });
	check("空参数明确失败", bad.ok, false);
	check("空参数标 via=invalid", bad.via, "invalid");

	// 未知专家 → 失败（workerOf 明确返回 null）。
	const strictManager = createTaskManager({
		store: cappedTasks,
		sessionManager: {
			create: async () => ({ ok: false, error: "worker-not-found" }),
			activeOf: () => "",
			list: () => ({}),
			store: cappedSessions,
		},
		workerOf: () => null,
		logger: { info: () => {}, warn: () => {} },
	});
	const unknown = await strictManager.resolveTarget(ctx, config, { workerId: "nobody", task: "x" });
	check("未知专家失败", unknown.ok, false);
}

// ── 台账 JSON 可序列化（health 会下发）────────────────────────────────
{
	const tmp = mkdtempSync(join(tmpdir(), "xfv-json-"));
	const store = createExpertTaskStore(join(tmp, "experts"));
	store.record("bioinfo", { taskId: "t1", title: "甲", sessionId: "s1", task: "甲任务", at: 1 });
	let ok = true;
	let text = "";
	try {
		text = JSON.stringify(store.state());
	} catch {
		ok = false;
	}
	check("台账状态可 JSON 序列化", ok, true);
	check("序列化结果含条目", text.includes("甲"), true);
	check("落盘文件是合法 JSON", (() => {
		try { JSON.parse(readFileSync(store.file, "utf8")); return true; } catch { return false; }
	})(), true);
}

process.exitCode = failures.length > 0 ? 1 : 0;
console.log(`\n${failures.length === 0 ? "全部通过" : `${failures.length} 项失败`}`);
