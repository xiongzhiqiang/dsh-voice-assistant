/**
 * 专家会话管理中枢（V1.8；V2.4 起管状态机）。
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
 * ## V2.4 需求④：只有活跃会话收任务
 *
 * `ensureReceiving(workerId, task)` 是派单前的唯一入口，它回答一个问题：
 * **这个专家现在该由哪个会话接这单活？**
 *   - 有活跃会话且它的 agent 就绪 → 用它（顺手按任务名命名，如果还是占位名）；
 *   - 没有活跃会话（全挂起/全完结）→ **新开一个**再接（需求④原文）；
 *   - 有活跃会话但 agent 掉了 → 先尝试补建，补不上才新开（避免静默丢单）。
 *
 * 状态变更**只走 `setStatus()`**，而它只被"用户明确操作"的入口调用
 * （HTTP/语音/面板）。任务路径永远只新建、不改旧会话的状态。
 *
 * ## 会话与 agent 的生命周期
 *
 * agent 由调用方传入的 scope 持有（scope.effect 释放）；关闭会话时这里只从
 * 委托中枢注销 + 从注册表删除，agent 实例等 scope 卸载时统一释放 —— 避免
 * 二次 dispose（与 V1.7 removeWorker 同一条纪律）。
 *
 * 「挂起/完结」**不释放 agent**：状态是"暂不收任务"，不是"销毁"。用户随时
 * 可以把它改回活跃，不必重跑一次几十秒的 agent 冷启动。
 */
import { SESSION_STATUS, SESSION_STATUS_LABEL, titleFromTask } from "./expert-sessions.js";

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
	 * 新会话天然活跃；该专家原活跃会话被降为挂起（唯一活跃约束）。
	 * @returns `{ok, session?, error?, speech?}`。
	 */
	async function create(workerId, label = "") {
		const worker = workerOf(workerId);
		if (worker === null || worker === undefined) return { ok: false, error: "worker-not-found" };
		const created = store.createSession(workerId, label);
		if (!created.ok) return created;
		const built = await buildSlots([{ worker, session: created.session }]);
		return {
			ok: true,
			session: created.session,
			workerId,
			agentReady: built.length > 0,
			suspended: created.suspended ?? [],
			speech: `已为${worker.label ?? workerId}新建会话。${built.length > 0 ? "现在可以派任务了。" : "agent 稍后就绪。"}`,
		};
	}

	/**
	 * 切换活跃会话（注册表 + 委托中枢）。
	 *
	 * 目标会话的 agent 若还没建（理论上不该发生：启动时会把该专家所有会话
	 * 都建起来），先补建再切 —— 否则会出现"切过去了但派单报 worker-unavailable"。
	 */
	async function setActive(workerId, sessionId) {
		const result = store.setActive(workerId, sessionId);
		if (!result.ok) return result;
		await ensureSlot(workerId, sessionId);
		const ok = delegation?.setActiveSession?.(workerId, sessionId) ?? false;
		return { ...result, delegationUpdated: ok };
	}

	/** 保证某个 (worker, session) 的 slot 已在委托中枢注册（不在则补建 agent）。 */
	async function ensureSlot(workerId, sessionId) {
		if (delegation?.hasSlot?.(workerId, sessionId) === true) return true;
		const worker = workerOf(workerId);
		if (worker === null || worker === undefined) return false;
		const view = store.listFor(workerId);
		const session = view.sessions.find((s) => s.sessionId === sessionId);
		if (session === undefined) return false;
		const built = await buildSlots([{ worker, session }]);
		return built.length > 0;
	}

	/**
	 * V2.4 需求④：改会话状态（**唯一**的状态变更入口，只被用户操作调用）。
	 *
	 * - `active`   → 该会话接任务；同专家其余活跃会话自动降挂起；
	 * - `suspended`/`finished` → 原地标记。若被标记的是活跃会话，则清空该专家的
	 *   活跃指针（进入"没有活跃会话"），下次来任务新开一个。
	 *
	 * @param workerId - 专家 id。
	 * @param sessionId - 目标会话。
	 * @param status - `active` / `suspended` / `finished`。
	 * @returns `{ok, session?, error?, speech?}`。
	 */
	async function setStatus(workerId, sessionId, status) {
		const worker = workerOf(workerId);
		// 先校验专家存在：否则未知 id 会从 store 层漏出 `not-found`，
		// 播报落到兜底文案，用户看不出到底是"专家没找到"还是"会话没找到"。
		if (worker === null || worker === undefined) return { ok: false, error: "worker-not-found" };
		const label = worker.label ?? workerId;
		const next = String(status ?? "").trim();
		if (next !== SESSION_STATUS.ACTIVE && next !== SESSION_STATUS.SUSPENDED && next !== SESSION_STATUS.FINISHED) {
			return { ok: false, error: "invalid-status" };
		}
		if (next === SESSION_STATUS.ACTIVE) {
			const result = await setActive(workerId, sessionId);
			if (result.ok !== true) return result;
			return {
				...result,
				speech: `已把${label}的「${result.session?.label ?? "该会话"}」设为活跃，之后的语音指令都进这里。`,
			};
		}
		const result = store.setStatus(workerId, sessionId, next);
		if (result.ok !== true) return result;
		// 被标记的正是活跃会话 → 清活跃指针，让下次派单新开会话（需求④）。
		if (delegation?.activeOf?.(workerId) === sessionId) {
			delegation?.clearActiveSession?.(workerId);
		}
		const statusText = SESSION_STATUS_LABEL[next] ?? next;
		const tail = result.activeSessionId === "" ? "，这位专家现在没有活跃会话，下次派任务会新开一个。" : "。";
		return {
			...result,
			speech: `已把${label}的「${result.session?.label ?? "该会话"}」标为${statusText}${tail}`,
		};
	}

	/**
	 * V2.4 需求③④：派单前的落点判定 —— 这单活该由哪个会话来接。
	 *
	 * 三条路径（按优先级）：
	 *   1. 有活跃会话 + agent 就绪 → 用它；若它还是占位名「待命」，用任务名命名；
	 *   2. 有活跃会话但 agent 没建起来 → 补建；补不上就**明确失败**（见下）；
	 *   3. 没有活跃会话（全挂起/全完结）→ **新开一个**，直接用任务名命名。
	 *
	 * 两条纪律：
	 *   - 绝不在任务路径上改旧会话的状态（状态变更只能来自用户）；
	 *   - 活跃会话不可用时**不偷偷改投别的会话** —— 那样会把任务塞进一个用户
	 *     明确挂起的会话里，违反需求④。此时宁可回一个可见的错误。
	 *
	 * @param workerId - 专家 id。
	 * @param task - 任务原文（同时用作新会话名）。
	 * @returns `{ok, sessionId?, created?, label?, error?}`。
	 */
	async function ensureReceiving(workerId, task) {
		const worker = workerOf(workerId);
		if (worker === null || worker === undefined) return { ok: false, error: "worker-not-found" };
		const view = store.listFor(workerId);
		const activeSid = view.activeSessionId;
		if (activeSid !== "") {
			const ready = await ensureSlot(workerId, activeSid);
			if (!ready) {
				log("warn", `voice-assistant: ${workerId} 的活跃会话 agent 未就绪（${activeSid}）—— 本次委托无法投递`);
				return { ok: false, error: "session-agent-unavailable", sessionId: activeSid };
			}
			// 顺手命名：只在占位名时生效，绝不动用户自己起的名字。
			const renamed = store.nameByTask(workerId, activeSid, task);
			return { ok: true, sessionId: activeSid, created: false, label: renamed.label ?? "" };
		}
		// 没有活跃会话 → 新开一个，按任务名命名（需求③）。
		const label = titleFromTask(task);
		const created = await create(workerId, label);
		if (created.ok !== true) return created;
		const sid = created.session.sessionId;
		if (delegation?.hasSlot?.(workerId, sid) !== true) {
			log("warn", `voice-assistant: 为 ${workerId} 新开的会话 agent 未就绪（${sid}）—— 本次委托无法投递`);
			return { ok: false, error: "session-agent-unavailable", sessionId: sid };
		}
		log("info", `voice-assistant: ${workerId} 无活跃会话，已按任务「${label}」新开一个（${sid}）`);
		return { ok: true, sessionId: sid, created: true, label };
	}

	/** V2.4 需求③：手动给会话改名（面板/语音）。默认允许覆盖。 */
	function rename(workerId, sessionId, label) {
		return store.renameSession(workerId, sessionId, label, { onlyIfIdle: false });
	}

	/** 关闭会话（注册表 + 委托中枢注销；agent 等 scope 卸载统一释放）。 */
	function close(workerId, sessionId) {
		const result = store.closeSession(workerId, sessionId);
		if (!result.ok) return result;
		const ok = delegation?.closeSession?.(workerId, sessionId) ?? false;
		if (typeof onSlotRemoved === "function") {
			try { onSlotRemoved({ id: workerId, sessionId }); } catch { /* 同上 */ }
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

	return {
		list, create, setActive, setStatus, ensureReceiving, ensureSlot, rename, close,
		activeOf, digestText, appendDigest, buildSlots, store,
	};
}
