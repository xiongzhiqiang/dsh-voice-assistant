/**
 * V2.4 需求④：会话状态机在管理中枢（session-manager.js）里的行为单测。
 *
 * 这一层是"数据层状态机"与"宿主 HTTP / 派单路径"之间的胶水，最容易出的错
 * 是**自动路径偷偷改状态** —— 所以这里的重点全在"系统没有替用户做决定"：
 *   1. ensureReceiving 在没有活跃会话时**新建**，绝不把挂起/完结的改回活跃；
 *   2. 活跃会话的 agent 不可用时**明确失败**，不改投别的会话；
 *   3. setStatus(挂起/完结) 会清掉委托中枢的活跃指针。
 *
 * 用假的 store / delegation / buildAgent 跑，不依赖真 DSH。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExpertSessionStore } from "../lib/expert-sessions.js";
import { createSessionManager } from "../lib/session-manager.js";

const failures = [];
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures.push({ name, actual, expected });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` → ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`}`);
};

/**
 * 造一套最小可用的装配。
 * @param options - `{failBuild}`：让 buildAgent 失败，模拟 agent 起不来。
 */
function makeHarness(options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "xfv-sessmgr-"));
	const store = createExpertSessionStore(dir);
	const built = [];
	const removed = [];
	/** 假的委托中枢：只记活跃指针 + 已注册的 slot。 */
	const slots = new Set();
	const active = new Map();
	const delegation = {
		hasSlot: (id, sid) => slots.has(`${id}::${sid}`),
		addWorker: (row) => {
			slots.add(`${row.id}::${row.sessionId}`);
			if (row.active === true) active.set(row.id, row.sessionId);
			return true;
		},
		setActiveSession: (id, sid) => {
			if (!slots.has(`${id}::${sid}`)) return false;
			active.set(id, sid);
			return true;
		},
		closeSession: (id, sid) => slots.delete(`${id}::${sid}`),
		activeOf: (id) => active.get(id) ?? "",
		clearActiveSession: (id) => active.delete(String(id ?? "")),
	};
	const worker = { id: "w", label: "小因" };
	const manager = createSessionManager({
		store,
		normalized: { routing: { workers: [worker] } },
		delegation,
		getScope: () => null,
		ctx: {},
		workerOf: (id) => (id === "w" ? worker : null),
		buildAgent: async (w, session) => {
			if (options.failBuild === true) throw new Error("boom");
			built.push(session.sessionId);
			return { id: w.id, sessionId: session.sessionId, agent: { followup() {}, whenIdle: async () => {} } };
		},
		onSlotRemoved: (row) => removed.push(row),
	});
	return { store, manager, delegation, active, built, removed };
}

// ── 启动登记：全挂起/全完结是合法状态，不被偷偷激活 ──────────────────
{
	const { store, manager } = makeHarness();
	store.ensureDefault({ id: "w", sessionId: "s1" });
	// 用户把它挂起 → 该专家进入"无活跃会话"。
	await manager.setStatus("w", "s1", "suspended");
	check("挂起后无活跃会话", store.activeOf("w"), "");
	check("ensureDefault 不复活挂起会话", store.ensureDefault({ id: "w" }).changed, false);
	check("ensureDefault 后仍无活跃", store.activeOf("w"), "");
}

// ── 需求④ 核心：没有活跃会话时派单 → 新开一个（不改旧状态）───────────
{
	const { store, manager, built } = makeHarness();
	store.ensureDefault({ id: "w", sessionId: "s1" });
	await manager.setActive("w", "s1");
	await manager.setStatus("w", "s1", "suspended");
	built.length = 0;

	const picked = await manager.ensureReceiving("w", "帮我做差异分析");
	check("无活跃会话时派单成功", picked.ok, true);
	check("确实新建了会话", picked.created, true);
	check("新会话按任务名命名", picked.label, "做差异分析");
	check("新会话接单", store.activeOf("w"), picked.sessionId);
	check("挂起的旧会话保持挂起", store.listFor("w").sessions.find((s) => s.sessionId === "s1").status, "suspended");
	check("旧会话没被改回活跃", store.listFor("w").sessions.find((s) => s.sessionId === "s1").active, false);
	check("为新会话建了 agent", built.includes(picked.sessionId), true);

	// 再派一单：这次有活跃会话了，不新建。
	built.length = 0;
	const again = await manager.ensureReceiving("w", "再画个火山图");
	check("有活跃会话时不新建", again.created, false);
	check("复用同一会话", again.sessionId, picked.sessionId);
	check("不重复建 agent", built.length, 0);
	check("不改已命名的会话名", store.listFor("w").sessions.find((s) => s.sessionId === picked.sessionId).label, "做差异分析");
}

// ── 需求④：活跃会话的 agent 不可用 → 明确失败，不偷偷改投 ─────────────
{
	const { store, manager } = makeHarness({ failBuild: true });
	store.ensureDefault({ id: "w", sessionId: "s1" });
	// ensureDefault 建的会话是活跃的，但它的 slot 从未注册（agent 建不起来）。
	const picked = await manager.ensureReceiving("w", "做点事");
	check("活跃会话不可用时明确失败", picked.ok, false);
	check("失败原因可诊断", picked.error, "session-agent-unavailable");
	check("活跃指针未被改动", store.activeOf("w"), "s1");
	check("没有偷偷新建会话", store.listFor("w").sessions.length, 1);
}

// ── 需求④：直接派单到活跃会话时用任务名命名占位会话（需求③）─────────
{
	const { store, manager } = makeHarness();
	store.ensureDefault({ id: "w", sessionId: "s1" });
	await manager.setActive("w", "s1");
	check("初始是占位名", store.listFor("w").sessions[0].label, "待命");
	const picked = await manager.ensureReceiving("w", "帮我分析这批 RNA-seq 数据");
	check("复用活跃会话不新建", picked.created, false);
	check("占位名被任务名覆盖", store.listFor("w").sessions[0].label, "分析这批 RNA-seq 数据");
	check("没多出会话", store.listFor("w").sessions.length, 1);
}

// ── 需求④：活跃/挂起/完结三态切换与播报 ──────────────────────────────
{
	const { store, manager, active } = makeHarness();
	store.ensureDefault({ id: "w", sessionId: "s1" });
	await manager.setActive("w", "s1");
	const second = await manager.create("w", "任务二");
	check("新会话成为活跃", store.activeOf("w"), second.session.sessionId);
	check("原活跃降挂起", store.listFor("w").sessions.find((s) => s.sessionId === "s1").status, "suspended");

	const finished = await manager.setStatus("w", second.session.sessionId, "finished");
	check("标完结成功", finished.ok, true);
	check("完结后委托活跃指针被清", active.get("w") ?? "", "");
	check("完结播报提到无活跃会话", /没有活跃会话/.test(finished.speech ?? ""), true);
	check("完结的会话仍在列表", store.listFor("w").sessions.some((s) => s.sessionId === second.session.sessionId), true);

	const revived = await manager.setStatus("w", "s1", "active");
	check("挂起可复活为活跃", revived.ok && store.activeOf("w") === "s1", true);
	check("复活后委托指针同步", active.get("w"), "s1");
	check("非法状态被拒", (await manager.setStatus("w", "s1", "bogus")).error, "invalid-status");
	check("未知专家被拒", (await manager.setStatus("nope", "s1", "active")).error, "worker-not-found");
}

// ── 关闭：与完结并存，关的是活跃会话时进入"无活跃" ──────────────────
{
	const { store, manager, removed } = makeHarness();
	store.ensureDefault({ id: "w", sessionId: "s1" });
	await manager.setActive("w", "s1");
	const second = await manager.create("w", "任务二");
	const closed = manager.close("w", second.session.sessionId);
	check("关闭会话成功", closed.ok, true);
	check("关闭后回到挂起的 s1 并激活", store.activeOf("w"), "s1");
	check("onSlotRemoved 被调", removed.length, 1);
	check("最后一个会话不可关", manager.close("w", "s1").error, "last-session");
}

// ── 需求③：手动改名允许覆盖（与任务路径的 onlyIfIdle 区分）───────────
{
	const { store, manager } = makeHarness();
	store.ensureDefault({ id: "w", sessionId: "s1" });
	await manager.setActive("w", "s1");
	manager.rename("w", "s1", "我自己起的名");
	check("手动改名可覆盖占位名", store.listFor("w").sessions[0].label, "我自己起的名");
	manager.rename("w", "s1", "再改一次");
	check("手动改名可二次覆盖", store.listFor("w").sessions[0].label, "再改一次");
	check("空名字被拒", manager.rename("w", "s1", "  ").error, "label-required");
}

process.exitCode = failures.length > 0 ? 1 : 0;
console.log(`\n${failures.length === 0 ? "全部通过" : `${failures.length} 项失败`}`);
