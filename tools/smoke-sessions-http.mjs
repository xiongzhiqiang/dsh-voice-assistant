/**
 * V1.8 真机专家会话管理接口冒烟（HTTP）；V2.4 加状态机。
 *
 * 验证：列出会话 → 开新会话（注册表 + delegation slot 热生效）→
 *       切换活跃 → 改状态（挂起/完结/复活）→ 关闭会话 → 注册表恢复。
 *
 * 用 `bioinfo` 专家开一个临时新会话，测完关闭。新建会话会在 sessions/ 里留下
 * 一个合法的 DSH 会话目录（header.id 与目录名一致，不影响工作区完整性）——
 * 这是"开会话"功能的真实产物，不删除。
 *
 * ⚠️ 状态测试会把真实注册表改掉，所以**每个被改的会话最后都要复位**
 * （见 finally 里的 restore）：这个脚本跑在用户的真实 DSH 上。
 */
import { readFileSync } from "node:fs";

const state = JSON.parse(readFileSync(new URL("./_dsh-serve.json", import.meta.url), "utf8"));
const BASE = "http://127.0.0.1:3080/plugins/dsh-voice-assistant/api";
const HEADERS = { "content-type": "application/json", cookie: `dsh_token=${state.token}` };

const failures = [];
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures.push({ name, actual, expected });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` → ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`}`);
};
const get = async (path) => (await fetch(BASE + path, { headers: HEADERS })).json();
const post = async (path, body) => (await fetch(BASE + path, { method: "POST", headers: HEADERS, body: JSON.stringify(body) })).json();
const del = async (path) => (await fetch(BASE + path, { method: "DELETE", headers: HEADERS })).json();

const WORKER = "bioinfo";
let createdSid = "";
let defaultSid = "";
/** 状态测试前该专家的活跃会话（收尾要还原，别把用户的状态改掉）。 */
let originalActiveSid = "";
try {
	const health0 = await get("/health");
	check("health 版本 2.4.0", health0.version, "2.4.0");
	check("root 会话是干净 v2", health0.agent?.sessionId, "session-voice-assistant-root-v2");

	const list0 = await get("/sessions");
	check("GET /sessions 成功", list0.ok, true);
	const view0 = list0.sessions?.[WORKER];
	check("bioinfo 有默认会话", Array.isArray(view0?.sessions) && view0.sessions.length >= 1, true);
	defaultSid = view0.activeSessionId;
	originalActiveSid = view0.activeSessionId;
	check("默认会话 id 兼容旧值", defaultSid, "session-voice-worker-bioinfo-v2");
	// V2.4：health 里的每条会话都必须带 status。
	check("会话带 status 字段", typeof view0.sessions?.[0]?.status, "string");
	const slots0 = (health0.delegation?.slots ?? []).length;

	// 开新会话
	const created = await post(`/sessions/${WORKER}`, { label: "冒烟测试会话" });
	check("开新会话成功", created.ok, true);
	createdSid = created.session?.sessionId ?? "";
	check("新会话 id 独立", createdSid !== "" && createdSid !== defaultSid, true);
	check("新会话成为活跃", (await get(`/sessions/${WORKER}`)).sessions?.[WORKER]?.activeSessionId, createdSid);
	check("新会话状态是 active", created.session?.status, "active");
	const health1 = await get("/health");
	check("delegation slot +1", (health1.delegation?.slots ?? []).length, slots0 + 1);
	check("slot 带新 sessionId", (health1.delegation?.slots ?? []).some((s) => s.id === WORKER && s.sessionId === createdSid && s.active), true);

	// 切回默认
	const switched = await post(`/sessions/${WORKER}/switch`, { sessionId: defaultSid });
	check("切换活跃会话成功", switched.ok, true);
	check("活跃已切回默认", (await get(`/sessions/${WORKER}`)).sessions?.[WORKER]?.activeSessionId, defaultSid);
	const health2 = await get("/health");
	check("切换后 delegation 活跃标记更新", (health2.delegation?.slots ?? []).some((s) => s.sessionId === defaultSid && s.active), true);

	// ── V2.4 需求④：状态机 ────────────────────────────────────────────
	const suspended = await post(`/sessions/${WORKER}/status`, { sessionId: createdSid, status: "suspended" });
	check("标挂起成功", suspended.ok, true);
	check("挂起后状态正确", (await get(`/sessions/${WORKER}`)).sessions?.[WORKER]?.sessions.find((s) => s.sessionId === createdSid)?.status, "suspended");

	const finished = await post(`/sessions/${WORKER}/status`, { sessionId: createdSid, status: "finished" });
	check("标完结成功", finished.ok, true);
	check("完结后状态正确", (await get(`/sessions/${WORKER}`)).sessions?.[WORKER]?.sessions.find((s) => s.sessionId === createdSid)?.status, "finished");
	check("完结会话仍在列表（不是关闭）", (await get(`/sessions/${WORKER}`)).sessions?.[WORKER]?.sessions.some((s) => s.sessionId === createdSid), true);

	const revived = await post(`/sessions/${WORKER}/status`, { sessionId: createdSid, status: "active" });
	check("完结可复活为活跃", revived.ok, true);
	const afterRevive = (await get(`/sessions/${WORKER}`)).sessions?.[WORKER];
	check("复活后成为唯一活跃", afterRevive?.activeSessionId, createdSid);
	check("复活后其余活跃被降挂起", afterRevive?.sessions.filter((s) => s.status === "active").length, 1);

	check("非法状态被拒", (await post(`/sessions/${WORKER}/status`, { sessionId: createdSid, status: "bogus" })).ok, false);
	check("不存在的会话被拒", (await post(`/sessions/${WORKER}/status`, { sessionId: "nope", status: "active" })).ok, false);

	// ── 需求③：手动改名 ──────────────────────────────────────────────
	const renamed = await post(`/sessions/${WORKER}/rename`, { sessionId: createdSid, label: "冒烟改名" });
	check("改名成功", renamed.ok, true);
	check("改名已生效", (await get(`/sessions/${WORKER}`)).sessions?.[WORKER]?.sessions.find((s) => s.sessionId === createdSid)?.label, "冒烟改名");

	// 关闭新会话（先切回默认，再关它）
	await post(`/sessions/${WORKER}/switch`, { sessionId: defaultSid });
	const closed = await del(`/sessions/${WORKER}/${createdSid}`);
	check("关闭会话成功", closed.ok, true);
	check("关闭后只剩默认", (await get(`/sessions/${WORKER}`)).sessions?.[WORKER]?.sessions.length, 1);
	const health3 = await get("/health");
	check("delegation slot 恢复", (health3.delegation?.slots ?? []).length, slots0);
	createdSid = "";

	// 最后一个会话不可关
	const last = await del(`/sessions/${WORKER}/${defaultSid}`);
	check("最后一个会话不可关", last.ok, false);
	check("拒绝原因 last-session", last.error, "last-session");
} finally {
	// 兜底清理：若中途失败留下了新会话，尝试关闭它。
	if (createdSid) {
		try {
			const view = (await get(`/sessions/${WORKER}`)).sessions?.[WORKER];
			if (view?.sessions?.some((s) => s.sessionId === createdSid)) {
				await post(`/sessions/${WORKER}/switch`, { sessionId: originalActiveSid });
				await del(`/sessions/${WORKER}/${createdSid}`);
			}
		} catch { /* 清理失败不影响测试结论 */ }
	}
	// 还原用户原本的活跃会话（状态测试可能把它改过）。
	if (originalActiveSid !== "") {
		try {
			await post(`/sessions/${WORKER}/status`, { sessionId: originalActiveSid, status: "active" });
		} catch { /* 同上 */ }
	}
}

console.log(`\n${failures.length === 0 ? "V1.8/V2.4 会话管理真机冒烟全部通过" : `${failures.length} 项失败`}`);
process.exitCode = failures.length > 0 ? 1 : 0;
