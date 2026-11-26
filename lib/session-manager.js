/**
 * 专家会话管理中枢（V1.8）：把"开/切/关会话"从注册表一路贯通到运行期。
 *
 * ## 为什么要这一层
 *
 * 会话注册表（expert-sessions.js）只管数据；真正"开一个专家会话"还要：
 *   1. 用新 sessionId 建一个常驻 agent（get→resume→create，与启动同路径）；
 *   2. 把它注册进委托中枢（带 sessionId + active，才能被派单）；
 *   3. 标注会话标题、归档自愈（与启动时两道防线一致）；
 *   4. 回传 health。
 *
 * HTTP 接口与语音命令共用同一个 manager —— 与 V1.7 的 expert-manager 同一纪律：
 * 两条入口落到同一套状态机，不会出现"语音开的会话接口看不到"。
 *
 * ## 会话与 agent 的生命周期
 *
 * agent 由调用方传入的 scope 持有（scope.effect 释放）；关闭会话时这里只从
 * 委托中枢注销 + 从注册表删除，agent 实例等 scope 卸载时统一释放 —— 避免
 * 二次 dispose（与 V1.7 removeWorker 同一条纪律）。
 */

/** 单会话建立超时（与 workers.js 同口径）。 */
const SESSION_CREATE_TIMEOUT_MS = 30000;

/** 给 promise 加超时。 */
function withTimeout(promise, ms, label) {
	let timer = null;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(label)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

/**
 * 创建会话管理中枢。
 *
 * @param options - `{ store, normalized, delegation, skillCatalog, getScope, ctx,
 *   workerOf, buildAgent, onSlotBuilt, onSlotRemoved, logger }`。
 *   `store` = createExpertSessionStore 实例；`workerOf(id)` 返回专家定义；
 *   `buildAgent(worker, session)` 建立 agent 的函数（默认用 ensureWorkerAgents
 *   的单会话逻辑，测试可注入假实现）。
 * @returns 管理器实例。
 */
export function createSessionManager(options) {
	const {
		store,
		normalized,
		delegation,
		getScope,
		ctx,
		workerOf = () => null,
		buildAgent = null,
		onSlotBuilt = null,
		onSlotRemoved = null,
		onSessionClosed = null,
		logger = null,
	} = options;
	const log = (level, msg) => {
		if (logger && typeof logger[level] === "function") logger[level](msg);
	};

	/**
	 * 为一批 (worker, session) 建立 agent 并注册进委托中枢。
	 * 复用 workers.js 的 ensureWorkerAgents，传 sessionsOf 展开单个会话。
	 * @returns 建立结果行数组。
	 */
	async function buildSlots(targets) {
		const built = [];
		for (const { worker, session } of targets) {
			if (!worker || !session) continue;
			try {
				let row;
				if (typeof buildAgent === "function") {
					// 注入式（测试/特殊场景）：期望返回 {agent, ...}。
					row = await buildAgent(worker, session);
				} else {
					// 默认：复用 ensureWorkerAgents 的单会话路径。延迟 import 避免环。
					const { ensureWorkerAgents } = await import("./workers.js");
					const rows = await withTimeout(
						ensureWorkerAgents(
							ctx,
							getScope(),
							normalized,
							[worker],
							null,
							null,
							() => [session],
						),
						SESSION_CREATE_TIMEOUT_MS,
						"session-agent-build-timeout",
					);
					row = rows.find((r) => r.sessionId === session.sessionId) ?? rows[0];
				}
				if (!row || !row.agent) {
					log("warn", `voice-assistant: 会话 agent 未建立（${worker.id}/${session.sessionId}）`);
					continue;
				}
				delegation?.addWorker?.({
					id: worker.id,
					label: worker.label ?? worker.id,
					sessionId: session.sessionId,
					active: session.active,
					agent: row.agent,
				});
				built.push({ ...row, id: worker.id });
				if (typeof onSlotBuilt === "function") {
					try { onSlotBuilt({ ...row, id: worker.id }); } catch { /* health 同步失败不影响主流程 */ }
				}
			} catch (error) {
				log("warn", `voice-assistant: 会话 agent 建立失败（${worker.id}/${session.sessionId}）—— ${String(error?.message ?? error)}`);
			}
		}
		return built;
	}

	/** 列出全部会话（HTTP GET /sessions）。 */
	function list(workerId = null) {
		const all = store.list();
		if (workerId !== null && workerId !== "") {
			return { [workerId]: all[workerId] ?? { sessions: [], activeSessionId: "", digest: [] } };
		}
		return all;
	}

	/**
	 * 开一个新会话（写注册表 + 建 agent + 注册委托）。
	 * @returns `{ok, session?, error?}`。
	 */
	async function create(workerId, label = "") {
		const worker = workerOf(workerId);
		if (worker === null || worker === undefined) return { ok: false, error: "worker-not-found" };
		const created = store.createSession(workerId, label);
		if (!created.ok) return created;
		const built = await buildSlots([{ worker, session: created.session }]);
		// 需求③：新会话先以占位名（待命）建起来，等第一条任务落进来才按任务名
		// 重命名。播报要说清这一点，否则用户看到侧边栏一条「待命」会以为出错。
		return {
			ok: true,
			session: created.session,
			workerId,
			agentReady: built.length > 0,
			speech: `已为${worker.label ?? workerId}新建会话（暂名「待命」）。${built.length > 0 ? "派给它第一个任务时，会自动用任务名命名。" : "agent 稍后就绪。"}`,
		};
	}

	/** 切换活跃会话（注册表 + 委托中枢）。 */
	function setActive(workerId, sessionId) {
		const result = store.setActive(workerId, sessionId);
		if (!result.ok) return result;
		const ok = delegation?.setActiveSession?.(workerId, sessionId) ?? false;
		return { ...result, delegationUpdated: ok };
	}

	/** 关闭会话（注册表 + 委托中枢注销；agent 等 scope 卸载统一释放）。 */
	function close(workerId, sessionId) {
		const result = store.closeSession(workerId, sessionId);
		if (!result.ok) return result;
		const ok = delegation?.closeSession?.(workerId, sessionId) ?? false;
		if (typeof onSlotRemoved === "function") {
			try { onSlotRemoved({ id: workerId, sessionId }); } catch { /* 同上 */ }
		}
		// V2.3（需求④）：关掉的会话可能还有任务指着它 —— 交给 onSessionClosed
		// 把那些任务改指到当前活跃会话，否则它们永远只能"续成新会话"。
		if (typeof onSessionClosed === "function") {
			try {
				onSessionClosed({ id: workerId, sessionId, fallbackSessionId: store.activeOf(workerId) });
			} catch { /* 台账收尾失败不影响关闭本身 */ }
		}
		return { ...result, delegationUpdated: ok };
	}

	/** 某专家当前活跃会话。 */
	function activeOf(workerId) {
		return store.activeOf(workerId);
	}

	/** 取记忆摘要注入文本（委托中枢回调）。 */
	function digestText(workerId) {
		return store.digestText(workerId);
	}

	/** 回写记忆摘要（委托中枢回调）。 */
	function appendDigest(workerId, entry) {
		return store.appendDigest(workerId, entry);
	}

	/**
	 * V2.3（需求③）：按任务名命名会话。
	 * 只覆盖占位名（待命 / 会话 N / 旧版默认会话），不覆盖用户或首个任务
	 * 已经定下的名字 —— 否则同一任务的后续追问会把侧边栏标题越改越模糊。
	 * @returns `{ok, changed, session?}`。
	 */
	function nameByTask(workerId, sessionId, title) {
		return store.nameByTask(workerId, sessionId, title);
	}

	/** V2.3：显式重命名（用户命令用，允许覆盖已有名字）。 */
	function rename(workerId, sessionId, label) {
		return store.renameSession(workerId, sessionId, label, { onlyIfIdle: false });
	}

	return { list, create, setActive, close, activeOf, digestText, appendDigest, buildSlots, nameByTask, rename, store };
}
