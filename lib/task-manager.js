/**
 * 任务归属中枢（V2.3，需求④）。
 *
 * ## 它把三样东西缝在一起
 *
 * ```
 *   任务台账（expert-tasks.js）   ← 记着"这位专家接过哪些任务、各在哪个会话"
 *   归属判定（task-route.js）     ← 答"这句新指令是老任务还是新任务"
 *   会话管理（session-manager.js）← 需要开新会话时由它建 agent
 *
 *   收到 /delegate(worker, task)
 *        │
 *        ├─ 老任务 → 用台账里那条的 sessionId 投递（需求④前半）
 *        └─ 新任务 → 新建会话 + 用任务名命名（需求④ + 需求③）→ 投递
 * ```
 *
 * ## 为什么单独一层而不是塞进 routes.js
 *
 * `/delegate` 是 HTTP handler，语音命令将来也要走同一条路；判定+建会话这套
 * 状态机如果写在 handler 里，两条入口就会各写一份（V1.7 的 expert-manager
 * 吃过这个亏：语音加的专家接口看不到）。抽成中枢之后，谁调都是同一套逻辑。
 *
 * ## 调用方必须能容忍它失败
 *
 * `assign()` 的契约是**永不抛**：任何一步出问题都退化成"投进该专家的活跃会话"。
 * 归属判定与台账都是**增强**—— 它们坏掉时用户最多看到"这条任务没被归类"，
 * 绝不能变成"指令发不出去"。
 */
import { TASKS_PER_WORKER_LIMIT, makeTaskId, taskContextText, titleFromTask } from "./expert-tasks.js";
import { attributeTask } from "./task-route.js";

/**
 * 创建任务归属中枢。
 *
 * @param options - `{ store, sessionManager, workerOf, logger }`。
 *   `store` = createExpertTaskStore 实例；
 *   `sessionManager` = createSessionManager 实例（需要 `create` 与 `activeOf`）；
 *   `workerOf(id)` 返回专家定义（要 label）。
 * @returns 中枢实例。
 */
export function createTaskManager(options) {
	const {
		store,
		sessionManager,
		workerOf = () => null,
		logger = null,
	} = options;
	const log = (level, msg) => {
		if (logger && typeof logger[level] === "function") logger[level](msg);
	};

	/** 取某专家台账（JSON 安全副本）。 */
	function listFor(workerId) {
		return store.listFor(workerId);
	}

	/** 全部台账（health 用）。 */
	function list() {
		return store.list();
	}

	/**
	 * 台账 → 可注入专家的背景文本。
	 * @param workerId - 专家 id。
	 * @returns 文本；无台账返回空串。
	 */
	function contextText(workerId) {
		return taskContextText(store.listFor(workerId));
	}

	/**
	 * 判定归属并把"该用哪个会话"定下来（不投递，纯决策 + 副作用：可能建会话/落台账）。
	 *
	 * 三种出口：
	 *   - `hit`：老任务命中，返回它的 sessionId（若那个会话已不存在则退化为新建）；
	 *   - `created`：新任务，已新建会话并命名为任务名；
	 *   - `fallback`：判定或建会话出问题，返回当前活跃会话（"照常投递"）。
	 *
	 * @param ctx - 宿主 Cordis 上下文（LLM 用）。
	 * @param config - 归一化配置。
	 * @param params - `{ workerId, task, allowModel }`。
	 * @returns `{ ok, sessionId, taskId, title, via, created, error? }`。
	 */
	async function resolveTarget(ctx, config, params) {
		const workerId = String(params?.workerId ?? "").trim();
		const task = String(params?.task ?? "").trim();
		const worker = workerOf(workerId);
		if (worker === null || worker === undefined || task === "") {
			return { ok: false, sessionId: "", taskId: "", title: "", via: "invalid", created: false, error: "invalid-params" };
		}

		const activeSessionId = sessionManager?.activeOf?.(workerId) ?? "";
		/** 该专家当前真实存在的会话 id 集合（判断台账里的会话是否还有效）。 */
		const liveSessions = new Set(
			(sessionManager?.list?.(workerId)?.[workerId]?.sessions ?? []).map((s) => s.sessionId).filter((id) => typeof id === "string" && id !== ""),
		);

		const tasks = listFor(workerId);
		const attribution = await attributeTask(ctx, config, {
			workerId,
			label: worker.label ?? workerId,
			task,
			tasks,
			allowModel: params?.allowModel !== false,
		});

		// ── 出口 A：老任务命中，且它的会话还在 → 回原会话。 ──────────────
		if (attribution.created === false && attribution.taskId !== "") {
			const sid = attribution.sessionId;
			// 台账可能指着已被关闭的会话（用户手删过）。这时**不**回退到活跃会话
			// （那会把这条任务的上下文接到别的任务上），而是开一条新的续上它。
			if (sid !== "" && liveSessions.has(sid)) {
				store.record(workerId, {
					taskId: attribution.taskId,
					title: attribution.title,
					sessionId: sid,
					task,
					at: Date.now(),
				});
				log("info", `voice-assistant: 「${worker.label}」指令归入已有任务「${attribution.title}」（${attribution.via}）`);
				return { ok: true, sessionId: sid, taskId: attribution.taskId, title: attribution.title, via: attribution.via, created: false };
			}
			log("warn", `voice-assistant: 任务「${attribution.title}」的原会话已不存在，改为新建会话续上`);
		}

		// ── 出口 B：新任务 → 建会话 + 按任务名命名 + 落台账。 ──────────────
		const title = attribution.title !== "" ? attribution.title : titleFromTask(task);
		const created = await createNamedSession(workerId, title);
		if (created.ok === true) {
			const taskId = attribution.taskId !== "" ? attribution.taskId : makeTaskId(workerId);
			store.record(workerId, { taskId, title, sessionId: created.sessionId, task, at: Date.now() });
			log("info", `voice-assistant: 「${worker.label}」新任务「${title}」→ 新会话（${attribution.via}）`);
			return { ok: true, sessionId: created.sessionId, taskId, title, via: attribution.via, created: true };
		}

		// ── 出口 C：⾛不到新会话（达上限/worker 没了）→ 退活跃会话照常投递。 ──
		// 这一档必须存在：会话数上限是 16，撞上限时若直接失败，用户会看到
		// "派单被拒"——而实际上只是台账满了，指令本身完全合法。
		log("warn", `voice-assistant: 为「${worker.label}」新建任务会话失败（${created.error ?? "unknown"}），改用活跃会话投递`);
		if (activeSessionId !== "") {
			return { ok: true, sessionId: activeSessionId, taskId: "", title, via: "fallback", created: false };
		}
		return { ok: false, sessionId: "", taskId: "", title, via: "fallback", created: false, error: created.error ?? "no-session" };
	}

	/**
	 * 新建一个会话并用任务名命名。
	 *
	 * 走 `sessionManager.create(workerId, title)` 而不是自己造 sessionId 再写
	 * 注册表：那条路径已经包含了"建 agent + 注册委托中枢 + 回传 health"的
	 * 全套动作（见 session-manager.js）。只传 label 的话新会话就是任务名，
	 * 天然满足需求③；`record()` 里再补一次 `nameByTask` 是为了兜住"会话建好时
	 * 还是占位名"的场景（例如显式建会话后接的第一条任务）。
	 *
	 * @param workerId - 专家 id。
	 * @param title - 任务名。
	 * @returns `{ok, sessionId?, error?}`。
	 */
	async function createNamedSession(workerId, title) {
		try {
			const created = await sessionManager.create(workerId, title);
			if (created?.ok !== true) return { ok: false, error: created?.error ?? "create-failed" };
			const sessionId = created.session?.sessionId ?? "";
			return { ok: true, sessionId };
		} catch (error) {
			return { ok: false, error: `create-threw: ${String(error?.message ?? error)}` };
		}
	}

	/**
	 * 记一条任务（不判定归属，直接落到指定会话）。
	 *
	 * 用于两种"已经知道该落哪"的场景：会话管理命令显式新建会话后接的第一条任务、
	 * 以及排障/测试注入。
	 *
	 * @param workerId - 专家 id。
	 * @param params - `{ task, sessionId, title?, taskId? }`。
	 * @returns `{ok, taskId, created}`。
	 */
	function record(workerId, params) {
		const task = String(params?.task ?? "").trim();
		const sessionId = String(params?.sessionId ?? "").trim();
		if (workerId === "" || sessionId === "") return { ok: false, error: "invalid-record" };
		const title = typeof params?.title === "string" && params.title.trim() !== "" ? params.title.trim() : titleFromTask(task);
		const taskId = typeof params?.taskId === "string" && params.taskId.trim() !== "" ? params.taskId.trim() : makeTaskId(workerId);
		const result = store.record(workerId, { taskId, title, sessionId, task, at: Date.now() });
		if (result.ok === true) {
			// 顺手把会话名对齐到任务名（占位名才会被覆盖，见 renameSession 的 onlyIfIdle）。
			try {
				sessionManager?.store?.nameByTask?.(workerId, sessionId, title);
			} catch { /* 命名失败不影响台账 */ }
		}
		return { ...result, title };
	}

	/**
	 * 把某条任务钉到另一个会话（会话被关时重指）。
	 * @returns `{ok, changed}`。
	 */
	function repoint(workerId, taskId, sessionId) {
		return store.patch(workerId, taskId, { sessionId, at: Date.now() });
	}

	/**
	 * 标记一条任务已完成（不再作为归属候选）。
	 * 注意：`attributeTask` 仍会看到 `done` 条目（它可能被用户"接着说"，故故意
	 * 不排除），只是清单渲染里会注明"已完成"。
	 * @returns `{ok, changed}`。
	 */
	function markDone(workerId, taskId) {
		return store.patch(workerId, taskId, { status: "done", at: Date.now() });
	}

	/**
	 * 会话被关闭时的收尾：把指向它的任务改指到该专家当前活跃会话。
	 *
	 * 不这样做的话，台账会一直指着一个不存在的会话 —— 后果是那条任务永远
	 * 只能"续成新会话"（`resolveTarget` 出口 A 的 liveSessions 检查会拦下），
	 * 用户会觉得"我明明说过这事，它怎么又开了一个新会话"。
	 *
	 * @returns `{ok, changed}`。
	 */
	function onSessionClosed(workerId, sessionId, fallbackSessionId) {
		const affected = store.listFor(workerId).filter((task) => task.sessionId === sessionId);
		if (affected.length === 0) return { ok: true, changed: false };
		if (typeof fallbackSessionId !== "string" || fallbackSessionId === "") {
			// 没有可回指的会话：把任务标成完成，它就不会再被误归属。
			let changed = false;
			for (const task of affected) changed = markDone(workerId, task.taskId).changed || changed;
			return { ok: true, changed };
		}
		let changed = false;
		for (const task of affected) changed = repoint(workerId, task.taskId, fallbackSessionId).changed || changed;
		return { ok: true, changed };
	}

	/** 删除专家时清掉它的台账。 */
	function removeWorker(workerId) {
		return store.removeWorker(workerId);
	}

	/** 宿主自省（health 可见：只报条数与最近几条标题，不下发全文）。 */
	function state() {
		const all = store.list();
		const out = {};
		for (const [workerId, view] of Object.entries(all)) {
			const tasks = view.tasks ?? [];
			out[workerId] = {
				count: tasks.length,
				limit: TASKS_PER_WORKER_LIMIT,
				recent: tasks.slice(-5).map((task) => ({
					taskId: task.taskId,
					title: task.title,
					sessionId: task.sessionId,
					status: task.status,
					count: task.count,
				})),
			};
		}
		return out;
	}

	return {
		file: store.file,
		list,
		listFor,
		contextText,
		resolveTarget,
		record,
		repoint,
		markDone,
		onSessionClosed,
		removeWorker,
		state,
		store,
	};
}
