/**
 * V1.8 真机专家会话管理接口冒烟（HTTP）。
 *
 * 验证：列出会话 → 开新会话（注册表 + delegation slot 热生效）→
 *       切换活跃 → 关闭会话 → 注册表恢复。
 *
 * 用 `bioinfo` 专家开一个临时新会话，测完关闭。新建会话会在 sessions/ 里留下
 * 一个合法的 DSH 会话目录（header.id 与目录名一致，不影响工作区完整性）——
 * 这是"开会话"功能的真实产物，不删除。
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
try {
	const health0 = await get("/health");
	check("health 版本 1.8.0", health0.version, "1.8.0");
	check("root 会话是干净 v2", health0.agent?.sessionId, "session-voice-assistant-root-v2");

	const list0 = await get("/sessions");
	check("GET /sessions 成功", list0.ok, true);
	const view0 = list0.sessions?.[WORKER];
	check("bioinfo 有默认会话", Array.isArray(view0?.sessions) && view0.sessions.length >= 1, true);
	defaultSid = view0.activeSessionId;
	check("默认会话 id 兼容旧值", defaultSid, "session-voice-worker-bioinfo-v2");
	const slots0 = (health0.delegation?.slots ?? []).length;

	// 开新会话
	const created = await post(`/sessions/${WORKER}`, { label: "冒烟测试会话" });
	check("开新会话成功", created.ok, true);
	createdSid = created.session?.sessionId ?? "";
	check("新会话 id 独立", createdSid !== "" && createdSid !== defaultSid, true);
	check("新会话成为活跃", (await get(`/sessions/${WORKER}`)).sessions?.[WORKER]?.activeSessionId, createdSid);
	const health1 = await get("/health");
	check("delegation slot +1", (health1.delegation?.slots ?? []).length, slots0 + 1);
	check("slot 带新 sessionId", (health1.delegation?.slots ?? []).some((s) => s.id === WORKER && s.sessionId === createdSid && s.active), true);

	// 切回默认
	const switched = await post(`/sessions/${WORKER}/switch`, { sessionId: defaultSid });
	check("切换活跃会话成功", switched.ok, true);
	check("活跃已切回默认", (await get(`/sessions/${WORKER}`)).sessions?.[WORKER]?.activeSessionId, defaultSid);
	const health2 = await get("/health");
	check("切换后 delegation 活跃标记更新", (health2.delegation?.slots ?? []).some((s) => s.sessionId === defaultSid && s.active), true);

	// 关闭新会话
	const closed = await del(`/sessions/${WORKER}/${createdSid}`);
	check("关闭会话成功", closed.ok, true);
	check("关闭后只剩默认", (await get(`/sessions/${WORKER}`)).sessions?.[WORKER]?.sessions.length, 1);
	const health3 = await get("/health");
	check("delegation slot 恢复", (health3.delegation?.slots ?? []).length, slots0);

	// 最后一个会话不可关
	const last = await del(`/sessions/${WORKER}/${defaultSid}`);
	check("最后一个会话不可关", last.ok, false);
	check("拒绝原因 last-session", last.error, "last-session");
} finally {
	// 兜底清理：若中途失败留下了新会话，尝试关闭它。
	if (createdSid) {
		try {
			const view = (await get(`/sessions/${WORKER}`)).sessions?.[WORKER];
			if (view?.sessions?.some((s) => s.sessionId === createdSid)) await del(`/sessions/${WORKER}/${createdSid}`);
		} catch { /* 清理失败不影响测试结论 */ }
	}
}

console.log(`\n${failures.length === 0 ? "V1.8 会话管理真机冒烟全部通过" : `${failures.length} 项失败`}`);
process.exitCode = failures.length > 0 ? 1 : 0;
