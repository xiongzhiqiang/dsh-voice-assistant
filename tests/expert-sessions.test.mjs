/** V1.8 专家会话注册表与共享记忆摘要单测。 */
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

process.exitCode = failures.length > 0 ? 1 : 0;
console.log(`\n${failures.length === 0 ? "全部通过" : `${failures.length} 项失败`}`);
