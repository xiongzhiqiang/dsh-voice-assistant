/**
 * V1.8 真机专家会话管理接口冒烟（HTTP）；V2.4 加状态机与派单落点判定。
 *
 * 验证：
 *   1. 列出会话 / 开新会话（注册表 + delegation slot 热生效）/ 切换活跃 / 关闭；
 *   2. V2.4 状态机：挂起 → 完结 → 复活，唯一活跃约束；
 *   3. V2.4 需求③：手动改名落盘；
 *   4. V2.4 需求④：**没有活跃会话时派单自动新开一个**（核心新行为）；
 *   5. health 里每条会话都带 status。
 *
 * ⚠️ 这个脚本跑在用户的**真实 DSH** 上，所以：
 *   - 所有会改到用户状态的步骤都有还原（见 finally 的 restore）；
 *   - 派单走**显式 sessionId**（不触发自动新开），只有第 4 步故意触发一次，
 *     并且用完立刻把新会话关掉、把原活跃会话切回来；
 *   - 专家是**自适应挑**的（不硬编码 id）—— 用户的专家集会被增删，硬编码
 *     会让脚本在"换了专家"后必红，而那条红没有任何诊断价值。
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

/** 找一位可用的专家（有会话、且不是 general）。 */
async function pickWorker() {
	const data = await get("/sessions");
	const sessions = data?.sessions ?? {};
	const ids = Object.keys(sessions).filter((id) => (sessions[id]?.sessions ?? []).length > 0);
	if (ids.length === 0) return { id: "", view: null };
	// 优先挑只有 1 个会话的（状态测试对用户状态扰动最小）。
	const id = ids.slice().sort((a, b) => sessions[a].sessions.length - sessions[b].sessions.length)[0];
	return { id, view: sessions[id] };
}

let WORKER = "";
let createdSid = "";
/** 收尾要还原的状态。 */
let originalActiveSid = "";
/** 需求④测试新开出来的会话（用完要关掉）。 */
let autoOpenedSid = "";
try {
	const health0 = await get("/health");
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	check("health 版本与 package.json 一致", health0.version, pkg.version);
	check("root 会话是干净 v2", health0.agent?.sessionId, "session-voice-assistant-root-v2");
	check("专家来源无问题", (health0.routing?.problems ?? []).length, 0);

	const picked = await pickWorker();
	WORKER = picked.id;
	check("至少有一位带会话的专家", WORKER !== "", true);
	if (WORKER === "") throw new Error("no-worker-with-session");
	console.log(`      （本次测试用专家：${WORKER}）`);

	const list0 = await get("/sessions");
	check("GET /sessions 成功", list0.ok, true);
	const view0 = list0.sessions?.[WORKER];
	const baseCount = (view0?.sessions ?? []).length;
	originalActiveSid = view0?.activeSessionId ?? "";
	check("该专家有活跃会话", originalActiveSid !== "", true);
	check("会话带 status 字段", typeof view0.sessions?.[0]?.status, "string");
	check("至多一个活跃会话", view0.sessions.filter((s) => s.status === "active").length <= 1, true);
	const slots0 = (health0.delegation?.slots ?? []).length;

	// ── 开新会话 ──────────────────────────────────────────────────────
	const created = await post(`/sessions/${WORKER}`, { label: "冒烟测试会话" });
	check("开新会话成功", created.ok, true);
	createdSid = created.session?.sessionId ?? "";
	check("新会话 id 独立", createdSid !== "" && createdSid !== originalActiveSid, true);
	check("新会话状态是 active", created.session?.status, "active");
	const afterCreate = (await get(`/sessions/${WORKER}`)).sessions?.[WORKER];
	check("新会话成为唯一活跃", afterCreate?.activeSessionId, createdSid);
	check("原活跃降为挂起（不是被删）", afterCreate?.sessions.find((s) => s.sessionId === originalActiveSid)?.status, "suspended");
	const health1 = await get("/health");
	check("delegation slot +1", (health1.delegation?.slots ?? []).length, slots0 + 1);
	check("slot 带新 sessionId", (health1.delegation?.slots ?? []).some((s) => s.id === WORKER && s.sessionId === createdSid && s.active), true);

	// ── 切回原活跃 ────────────────────────────────────────────────────
	const switched = await post(`/sessions/${WORKER}/switch`, { sessionId: originalActiveSid });
	check("切换活跃会话成功", switched.ok, true);
	check("活跃已切回", (await get(`/sessions/${WORKER}`)).sessions?.[WORKER]?.activeSessionId, originalActiveSid);
	const health2 = await get("/health");
	check("切换后 delegation 活跃标记更新", (health2.delegation?.slots ?? []).some((s) => s.sessionId === originalActiveSid && s.active), true);

	// ── V2.4 需求④：状态机 ────────────────────────────────────────────
	const suspended = await post(`/sessions/${WORKER}/status`, { sessionId: createdSid, status: "suspended" });
	check("标挂起成功", suspended.ok, true);
	check("挂起后状态正确", (await get(`/sessions/${WORKER}`)).sessions?.[WORKER]?.sessions.find((s) => s.sessionId === createdSid)?.status, "suspended");

	const finished = await post(`/sessions/${WORKER}/status`, { sessionId: createdSid, status: "finished" });
	check("标完结成功", finished.ok, true);
	const afterFinish = (await get(`/sessions/${WORKER}`)).sessions?.[WORKER];
	check("完结后状态正确", afterFinish?.sessions.find((s) => s.sessionId === createdSid)?.status, "finished");
	check("完结会话仍在列表（不是关闭）", afterFinish?.sessions.some((s) => s.sessionId === createdSid), true);

	const revived = await post(`/sessions/${WORKER}/status`, { sessionId: createdSid, status: "active" });
	check("完结可复活为活跃", revived.ok, true);
	const afterRevive = (await get(`/sessions/${WORKER}`)).sessions?.[WORKER];
	check("复活后成为唯一活跃", afterRevive?.activeSessionId, createdSid);
	check("复活后其余活跃被降挂起", afterRevive?.sessions.filter((s) => s.status === "active").length, 1);

	check("非法状态被拒", (await post(`/sessions/${WORKER}/status`, { sessionId: createdSid, status: "bogus" })).ok, false);
	check("不存在的会话被拒", (await post(`/sessions/${WORKER}/status`, { sessionId: "nope", status: "active" })).ok, false);

	// ── V2.4 需求③：手动改名 ──────────────────────────────────────────
	const renamed = await post(`/sessions/${WORKER}/rename`, { sessionId: createdSid, label: "冒烟改名" });
	check("改名成功", renamed.ok, true);
	check("改名已生效", (await get(`/sessions/${WORKER}`)).sessions?.[WORKER]?.sessions.find((s) => s.sessionId === createdSid)?.label, "冒烟改名");

	// ── V2.4 需求④ 核心：没有活跃会话时派单 → 自动新开一个 ────────────
	// 把两个会话都挂起，使该专家进入"无活跃会话"。
	await post(`/sessions/${WORKER}/status`, { sessionId: createdSid, status: "suspended" });
	const noActive = await post(`/sessions/${WORKER}/status`, { sessionId: originalActiveSid, status: "suspended" });
	check("全部挂起后无活跃会话", noActive?.activeSessionId, "");
	check("挂起不清空会话列表", (await get(`/sessions/${WORKER}`)).sessions?.[WORKER]?.sessions.length, baseCount + 1);

	// 派一单**不指定 sessionId**：宿主应新开一个，并用任务名命名。
	// 任务刻意极短（只让它回两个字），把真实 token 消耗压到最小。
	const taskText = "只回复两个字：收到";
	const delegated = await post("/delegate", { worker: WORKER, task: taskText });
	check("无活跃会话时派单成功", delegated?.ok, true);
	check("回报标记为新开会话", delegated?.openedSession, true);
	autoOpenedSid = typeof delegated?.sessionId === "string" ? delegated.sessionId : "";
	check(
		"回报的目标是新建的会话",
		autoOpenedSid !== "" && autoOpenedSid !== createdSid && autoOpenedSid !== originalActiveSid,
		true,
	);
	const afterAuto = (await get(`/sessions/${WORKER}`)).sessions?.[WORKER];
	check("新会话自动成为活跃", afterAuto?.activeSessionId, autoOpenedSid);
	check("新会话按任务名命名（需求③）", afterAuto?.sessions.find((s) => s.sessionId === autoOpenedSid)?.label, "只回复两个字：收到");
	check("挂起的旧会话没被改回活跃（需求④）", afterAuto?.sessions.filter((s) => s.status === "active").length, 1);
	check("原活跃会话保持挂起", afterAuto?.sessions.find((s) => s.sessionId === originalActiveSid)?.status, "suspended");

	// ── 收尾：关掉新会话（先切走，再关）──────────────────────────────
	await post(`/sessions/${WORKER}/switch`, { sessionId: createdSid });
	const closed = await del(`/sessions/${WORKER}/${createdSid}`);
	check("关闭会话成功", closed.ok, true);
	createdSid = "";
	check("关闭后回到基准数量", (await get(`/sessions/${WORKER}`)).sessions?.[WORKER]?.sessions.length, baseCount + 1);
} catch (error) {
	failures.push({ name: "真机会话冒烟异常", detail: String(error?.stack ?? error) });
	console.error(error);
} finally {
	// 还原用户的真实状态：删掉冒烟新建的会话、清掉自动新开的会话、把原活跃会话切回来。
	const safeDelete = async (sid) => {
		if (sid === "") return;
		try {
			const view = (await get(`/sessions/${WORKER}`)).sessions?.[WORKER];
			if (!view?.sessions?.some((s) => s.sessionId === sid)) return;
			if (view.sessions.length <= 1) return;
			// 要删的可能正好是活跃会话：先切到别的，再删。
			if (view.activeSessionId === sid) {
				const other = view.sessions.find((s) => s.sessionId !== sid);
				if (other) await post(`/sessions/${WORKER}/switch`, { sessionId: other.sessionId });
			}
			await del(`/sessions/${WORKER}/${sid}`);
		} catch { /* 清理失败不影响测试结论 */ }
	};
	try {
		await safeDelete(autoOpenedSid);
		await safeDelete(createdSid);
		if (originalActiveSid !== "") {
			await post(`/sessions/${WORKER}/status`, { sessionId: originalActiveSid, status: "active" });
		}
	} catch { /* 同上 */ }
}

console.log(`\n${failures.length === 0 ? "V1.8/V2.4 会话管理真机冒烟全部通过" : `${failures.length} 项失败`}`);
process.exitCode = failures.length > 0 ? 1 : 0;
