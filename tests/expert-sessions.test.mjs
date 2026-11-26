/** V1.8 专家会话注册表与共享记忆摘要单测；V2.4 加会话状态机与命名。 */
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	makeSessionId,
	normalizeSessionStore,
	appendDigestEntry,
	renderDigest,
	createExpertSessionStore,
	DIGEST_LIMIT,
	IDLE_SESSION_LABEL,
	isIdleLabel,
	titleFromTask,
	SESSION_STATUS,
} from "../lib/expert-sessions.js";

const failures = [];
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures.push({ name, actual, expected });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` → ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`}`);
};

// ── 会话 id 生成 ──────────────────────────────────────────────────────
{
	const a = makeSessionId("bioinfo", 1700000000000, "ab12");
	const b = makeSessionId("bioinfo", 1700000000000, "ab13");
	check("会话 id 带 worker 名", a.includes("bioinfo"), true);
	check("会话 id 带 session-voice-worker 前缀", a.startsWith("session-voice-worker-"), true);
	check("不同随机后缀不撞车", a !== b, true);
	check("非法字符被清洗", /[.]/.test(makeSessionId("a.b/c")), false);
}

// ── 注册表归一化：容错 ────────────────────────────────────────────────
{
	const store = normalizeSessionStore({
		workers: {
			bioinfo: {
				sessions: [
					{ sessionId: "s1", label: "默认", active: false, createdAt: 1 },
					{ sessionId: "s2", label: "第二", active: true, createdAt: 2 },
					{ sessionId: "s1", label: "重复", active: false },
					null,
				],
				activeSessionId: "s2",
				digest: [{ text: "要点一", at: 10 }, { text: "", at: 11 }, null],
			},
			broken: "not-an-object",
		},
	});
	check("归一化保留合法会话", store.workers.bioinfo.sessions.length, 2);
	check("归一化去重 sessionId", store.workers.bioinfo.sessions.some((s) => s.label === "重复"), false);
	check("归一化活跃会话正确", store.workers.bioinfo.activeSessionId, "s2");
	check("归一化过滤空摘要", store.workers.bioinfo.digest.length, 1);
	check("归一化跳过坏 worker", store.workers.broken === undefined, true);
}

// ── 摘要累积：去重 + 上限 ─────────────────────────────────────────────
{
	let d = [];
	d = appendDigestEntry(d, { text: "第一条", at: 1 });
	d = appendDigestEntry(d, { text: "第一条", at: 2 }); // 与最后一条相同 → 跳过
	check("摘要连续重复不记", d.length, 1);
	d = appendDigestEntry(d, { text: "第二条", at: 3 });
	check("摘要不同条目累积", d.length, 2);
	let capped = [];
	for (let i = 0; i < DIGEST_LIMIT + 10; i += 1) capped = appendDigestEntry(capped, { text: `点${i}`, at: i });
	check("摘要长度受上限约束", capped.length, DIGEST_LIMIT);
	check("摘要保留最新的", capped[capped.length - 1].text, `点${DIGEST_LIMIT + 9}`);
	check("摘要渲染含标题", renderDigest(d).includes("跨会话记忆"), true);
	check("空摘要渲染为空串", renderDigest([]), "");
}

// ── 注册表 CRUD（落盘） ───────────────────────────────────────────────
{
	const tmp = mkdtempSync(join(tmpdir(), "xfv-sess-"));
	const store = createExpertSessionStore(join(tmp, "experts"));
	check("注册表文件在 _state 子目录", store.file.includes("_state"), true);
	check("初始无会话", store.list().bioinfo === undefined, true);

	const def = store.ensureDefault({ id: "bioinfo", sessionId: "session-voice-worker-bioinfo-v2", label: "小因" });
	check("建默认会话成功且 sessionId 兼容旧值", def.changed === true && def.session.sessionId === "session-voice-worker-bioinfo-v2", true);
	check("默认会话已落盘", existsSync(store.file), true);
	check("重复 ensureDefault 不改", store.ensureDefault({ id: "bioinfo", sessionId: "other" }).changed, false);
	check("general 不建会话", store.ensureDefault({ id: "general" }).changed, false);

	const created = store.createSession("bioinfo", "新分析任务");
	check("新建会话成功", created.ok, true);
	check("新建后成为活跃", store.activeOf("bioinfo"), created.session.sessionId);
	check("列出两个会话", store.listFor("bioinfo").sessions.length, 2);

	const switched = store.setActive("bioinfo", def.session.sessionId);
	check("切换活跃会话", switched.ok && store.activeOf("bioinfo") === def.session.sessionId, true);

	store.appendDigest("bioinfo", { text: "做过体细胞突变报告", at: 1, sessionId: created.session.sessionId });
	check("摘要可注入", store.digestText("bioinfo").includes("体细胞突变报告"), true);

	const closed = store.closeSession("bioinfo", created.session.sessionId);
	check("关闭会话成功", closed.ok, true);
	check("关闭后回到默认会话", store.activeOf("bioinfo"), def.session.sessionId);
	check("最后一个会话不可关", store.closeSession("bioinfo", def.session.sessionId).error, "last-session");

	// 重载后状态保持（含摘要）。
	const store2 = createExpertSessionStore(join(tmp, "experts"));
	check("重载无 problem", store2.reload().length, 0);
	check("会话状态持久化", store2.activeOf("bioinfo"), def.session.sessionId);
	check("摘要持久化", store2.digestText("bioinfo").includes("体细胞突变报告"), true);

	// 写坏文件容错。
	writeFileSync(store.file, "{ this is not json", "utf8");
	const store3 = createExpertSessionStore(join(tmp, "experts"));
	const problems = store3.reload();
	check("坏文件记 problem 不抛", problems.length > 0 && problems[0].includes("解析失败"), true);
	check("坏文件后按空表处理", store3.list().bioinfo === undefined, true);
}

// ── V2.4 需求③：任务名 → 会话名 ──────────────────────────────────────
{
	check("剥掉礼貌前缀", titleFromTask("帮我分析这批 RNA-seq 数据"), "分析这批 RNA-seq 数据");
	check("剥掉多层前缀", titleFromTask("请你帮我看看这个报告"), "看看这个报告");
	check("取第一个分句", titleFromTask("做差异分析，然后画火山图"), "做差异分析");
	check("首分句太短则用整句", titleFromTask("分析，然后画图"), "分析，然后画图");
	check("超长截断加省略号", titleFromTask("把这份特别特别特别特别特别特别特别特别长的任务描述处理完").endsWith("…"), true);
	check("空任务用占位名", titleFromTask(""), IDLE_SESSION_LABEL);
	check("占位名不是空串", IDLE_SESSION_LABEL, "待命");
	check("占位名可识别", isIdleLabel("待命"), true);
	check("旧占位名可识别", isIdleLabel("默认会话"), true);
	check("序号占位名可识别", isIdleLabel("会话 3"), true);
	check("用户起的名字不识别为占位", isIdleLabel("做差异分析"), false);
}

// ── V2.4 需求④：状态归一化与唯一活跃约束 ─────────────────────────────
{
	// 旧数据（只有布尔 active、没有 status）必须能迁成三态，不能把活跃弄丢。
	const legacy = normalizeSessionStore({
		workers: {
			a: { sessions: [{ sessionId: "s1", label: "默认会话", active: false }, { sessionId: "s2", label: "x", active: true }], activeSessionId: "s2" },
		},
	});
	check("旧 active=true 迁成 active 状态", legacy.workers.a.sessions.find((s) => s.sessionId === "s2").status, SESSION_STATUS.ACTIVE);
	check("旧 active=false 迁成挂起", legacy.workers.a.sessions.find((s) => s.sessionId === "s1").status, SESSION_STATUS.SUSPENDED);
	check("旧占位名迁成待命", legacy.workers.a.sessions.find((s) => s.sessionId === "s1").label, IDLE_SESSION_LABEL);

	// 坏数据：两个都标 active → 只留一个（指名道姓的那个赢）。
	const dual = normalizeSessionStore({
		workers: {
			a: { sessions: [{ sessionId: "s1", label: "a", active: true }, { sessionId: "s2", label: "b", active: true }], activeSessionId: "s1" },
		},
	});
	check("唯一活跃约束：只留一个", dual.workers.a.sessions.filter((s) => s.status === SESSION_STATUS.ACTIVE).length, 1);
	check("唯一活跃约束：指名者胜出", dual.workers.a.sessions.find((s) => s.sessionId === "s1").status, SESSION_STATUS.ACTIVE);
	check("被降级的那个变挂起", dual.workers.a.sessions.find((s) => s.sessionId === "s2").status, SESSION_STATUS.SUSPENDED);

	// 显式 status 优先于布尔 active（新格式不该被老字段带偏）。
	const mixed = normalizeSessionStore({
		workers: { a: { sessions: [{ sessionId: "s1", status: "finished", active: true }], activeSessionId: "s1" } },
	});
	check("显式 status 优先", mixed.workers.a.sessions[0].status, SESSION_STATUS.FINISHED);
	check("完结会话不算活跃指针", mixed.workers.a.activeSessionId, "");
}

// ── V2.4 需求④：状态机 CRUD（落盘） ──────────────────────────────────
{
	const tmp = mkdtempSync(join(tmpdir(), "xfv-status-"));
	const store = createExpertSessionStore(join(tmp, "experts"));
	store.ensureDefault({ id: "w", sessionId: "s-first" });
	const second = store.createSession("w", "任务二");
	check("新会话天然活跃", store.activeOf("w"), second.session.sessionId);
	check("原活跃降为挂起（不是被删）", store.listFor("w").sessions.find((s) => s.sessionId === "s-first").status, SESSION_STATUS.SUSPENDED);

	// 挂起活跃会话 → 该专家进入"无活跃会话"。
	const suspended = store.setStatus("w", second.session.sessionId, SESSION_STATUS.SUSPENDED);
	check("挂起活跃会话成功", suspended.ok, true);
	check("挂起后无活跃会话", store.activeOf("w"), "");
	check("挂起不删会话", store.listFor("w").sessions.length, 2);

	// 完结：保留在列表里，且可以复活（需求确认：完结≠关闭）。
	const finished = store.setStatus("w", "s-first", SESSION_STATUS.FINISHED);
	check("标完结成功", finished.ok, true);
	check("完结后仍在列表", store.listFor("w").sessions.some((s) => s.sessionId === "s-first"), true);
	const revived = store.setStatus("w", "s-first", SESSION_STATUS.ACTIVE);
	check("完结可复活为活跃", revived.ok && store.activeOf("w") === "s-first", true);
	check("复活后状态是 active", store.listFor("w").sessions.find((s) => s.sessionId === "s-first").status, SESSION_STATUS.ACTIVE);

	check("非法状态被拒", store.setStatus("w", "s-first", "bogus").error, "invalid-status");
	check("不存在的会话被拒", store.setStatus("w", "nope", SESSION_STATUS.SUSPENDED).error, "session-not-found");

	// 命名：只动占位名。
	store.renameSession("w", second.session.sessionId, "手工命名", { onlyIfIdle: false });
	const kept = store.nameByTask("w", second.session.sessionId, "帮我做点别的");
	check("改名不覆盖用户起的名", kept.changed, false);
	check("用户起的名字保住", store.listFor("w").sessions.find((s) => s.sessionId === second.session.sessionId).label, "手工命名");
	const named = store.nameByTask("w", "s-first", "帮我做差异分析");
	check("占位名可被任务名覆盖", named.changed, true);
	check("任务名已生效", store.listFor("w").sessions.find((s) => s.sessionId === "s-first").label, "做差异分析");

	// 状态持久化。
	const store2 = createExpertSessionStore(join(tmp, "experts"));
	store2.reload();
	check("状态持久化", store2.listFor("w").sessions.find((s) => s.sessionId === "s-first").status, SESSION_STATUS.ACTIVE);
	check("名字持久化", store2.listFor("w").sessions.find((s) => s.sessionId === "s-first").label, "做差异分析");

	// 关掉活跃会话：剩下的全是完结 → 不擅自复活，进入"无活跃会话"。
	store2.setStatus("w", second.session.sessionId, SESSION_STATUS.FINISHED);
	const closed = store2.closeSession("w", "s-first");
	check("关掉活跃会话成功", closed.ok, true);
	check("剩下全是完结时不擅自复活", store2.activeOf("w"), "");
}

process.exitCode = failures.length > 0 ? 1 : 0;
console.log(`\n${failures.length === 0 ? "全部通过" : `${failures.length} 项失败`}`);
