/**
 * 互动队列（宿主半）—— 需求④：需要用户介入的信息**按时间先后**呈现。
 *
 * ## 这一层解决什么
 *
 * 专家在后台跑任务时，会冒出三类"需要用户知道/回应"的东西：
 *
 * | 类型 | 来源 | 用户要做什么 |
 * |---|---|---|
 * | 权限审核 | 会话事件 `approval/asked` | 去界面点允许/拒绝 |
 * | 模型提问 | 会话事件 `tool/call`（`ask_user_question`） | 去界面选一个答案 |
 * | 结果汇报 | 委托中枢 `reportQueue` | 不用做什么，听结论 |
 *
 * 这三条**各有自己的通道**，各自实时播报 —— 于是两件几乎同时发生的事，谁先
 * 出声取决于哪条通道先跑完，用户听到的顺序是乱的。本模块把它们收进**一条
 * 按时间排序的流**，客户端只按这一条流的顺序播报。
 *
 * ## 为什么审批必须在宿主侧捕获
 *
 * 客户端只 `retain` 常驻会话（根 agent），**worker 的会话它不看**。而审批
 * 恰恰主要发生在 worker 会话里（专家跑命令、写文件）。所以只靠客户端旁听
 * 会话事件是不够的 —— 必须在宿主侧听。
 *
 * `session/event` 是**scope 过滤的 emit**（见 dsh-session 的类型声明：
 * "receive only events from sessions entered through that agent's context"），
 * 而未打 scope tag 的监听器被**全局放行**（`dsh-scope` 的 `scopeTarget`：
 * `if (tag === void 0) return true`）。本插件的 `apply(ctx)` 拿的是宿主根
 * ctx（无 tag），所以这里能收到**全部会话**的事件 —— 包括 worker 的。
 *
 * ## 为什么听审计事件而不是拦截 `approval/request` 瀑布
 *
 * `approval/request` 是**会决定放行与否**的 waterfall：监听器必须原样
 * `return next()`。一旦返回值不在词表里（`allowed-once` / `rejected` /
 * `cancelled` / `unavailable`），`dsh-user-approval` 会把它 normalize 成
 * `unavailable` —— 即 **fail-closed，工具被拒**。一个只想"念一句"的旁听者
 * 绝不该站到那条路上。
 *
 * `approval/asked` / `approval/decided` 是**只写日志的审计对**
 * （`session.append`，log-only），天然只读、无副作用。用户的决定也是
 * 「只播报提醒、不语音代答」（语音误听会造成真实损害），审计事件正好
 * 只提供"该提醒了"这一件事，不提供作答通道 —— 与设计意图完全契合。
 *
 * ## 只播报已知会话（不去打扰用户自己的对话）
 *
 * 本模块**只对已知会话**（根 agent + worker 专家）的事件入队。否则用户在
 * 界面上自己开的会话里每一次提问、每一次审批都会被念出来 —— 那是骚扰，
 * 不是功能。会话白名单由 `sessionId → 展示名` 的映射给出。
 *
 * ## 时间戳口径
 *
 * `at` 取 `Math.max(Date.now(), cursor + 1)`，与 `lib/report.js` 同一条纪律：
 * 严格单调、跨刷新可比。客户端把互动与汇报合并排序时就靠这个字段。
 */
import { APPROVAL_KIND, INTERACTION_KINDS, QUESTION_KIND, REPORT_KIND } from "./interaction-kinds.js";

/** 队列保留条数上限（长期运行不让内存无界增长）。 */
export const INTERACTION_LIMIT = 200;

/** 念选项的上限（与客户端 `speakQuestion` 同口径）。 */
const MAX_SPOKEN_OPTIONS = 5;

/** 单条播报文案长度上限（TTS 太长会让人失去耐心）。 */
const SPEECH_LIMIT = 400;

/**
 * 取一句话的头几个字当摘要（用于 health / 调试，不进播报）。
 * @param text - 原文。
 * @param max - 上限。
 * @returns 截断文本。
 */
export function truncate(text, max = 80) {
	const value = String(text ?? "").trim();
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 从 `ask_user_question` 的工具调用参数里取出问题清单。
 *
 * 与客户端 `questions.js` 的 `questionCallOf` 同口径（**不改这里的形状**，
 * 那是真机实探出来的）：`arguments` 是 **JSON 字符串**、模型写
 * `multi_select`（下划线）而内部统一用 `multiSelect`。
 *
 * @param event - 会话事件。
 * @returns `{ callId, questions }` 或 `null`。
 */
export function questionCallOf(event) {
	if (event === null || typeof event !== "object") return null;
	if (event.type !== "tool/call") return null;
	const payload = event.data !== null && typeof event.data === "object" ? event.data : event;
	if (payload?.name !== "ask_user_question") return null;
	const callId = typeof payload.callId === "string" ? payload.callId : "";
	if (callId === "") return null;
	let parsed = payload.arguments;
	if (typeof parsed === "string") {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			return null;
		}
	}
	if (parsed === null || typeof parsed !== "object") return null;
	const list = Array.isArray(parsed.questions) ? parsed.questions : [];
	const questions = [];
	for (const item of list) {
		if (item === null || typeof item !== "object") continue;
		const text = typeof item.question === "string" ? item.question.trim() : "";
		if (text === "") continue;
		const options = Array.isArray(item.options)
			? item.options
					.filter((option) => option !== null && typeof option === "object" && typeof option.label === "string")
					.map((option) => String(option.label))
			: [];
		questions.push({
			header: typeof item.header === "string" ? item.header.trim() : "",
			question: text,
			options,
			multiSelect: item.multi_select === true || item.multiSelect === true,
		});
	}
	if (questions.length === 0) return null;
	return { callId, questions };
}

/**
 * 把一批问题念成人话（与客户端 `speakQuestion` 同口径）。
 * @param questions - 问题清单。
 * @returns 播报文案。
 */
export function formatQuestionSpeech(questions) {
	const list = Array.isArray(questions) ? questions : [];
	const parts = [];
	for (let index = 0; index < list.length; index += 1) {
		const item = list[index];
		const head = item.header === "" ? "" : `${item.header}：`;
		const prefix = list.length > 1 ? `第${["一", "二", "三", "四", "五"][index] ?? String(index + 1)}问，` : "";
		let text = `${prefix}${head}${item.question}`;
		if (item.options.length > 0) {
			const labels = item.options.slice(0, MAX_SPOKEN_OPTIONS);
			text += `。选项：${labels.map((label, order) => `${["一", "二", "三", "四", "五"][order]}是${label}`).join("，")}`;
			if (labels.length < item.options.length) text += `等 ${item.options.length} 个`;
		}
		parts.push(text);
	}
	return `${parts.join("；")}。请到界面上作答。`;
}

/**
 * 把一次权限审核念成人话。
 *
 * 注意措辞：说"需要你确认"，**不说**"我已拒绝/已允许" —— 本插件不代答，
 * 用户的决定是「只播报提醒，不语音代答」（语音误听放行有副作用的操作
 * 会造成真实损害）。文案必须让用户知道**要去界面处理**。
 *
 * @param entry - `{ label, toolName, reason }`。
 * @returns 播报文案。
 */
export function formatApprovalSpeech(entry) {
	const label = String(entry?.label ?? "").trim();
	const tool = String(entry?.toolName ?? "").trim();
	const who = label === "" ? "后台任务" : label;
	const what = tool === "" ? "执行一个操作" : `使用 ${tool}`;
	const reason = String(entry?.reason ?? "").trim();
	// reason 常带沙箱档位与理由（`escalate sandbox to <mode>: ...`）；太长就截断，
	// 完整内容在界面上，语音只要点到为止。
	const tail = reason === "" ? "" : `，说明：${truncate(reason, 60)}`;
	return `${who}需要你确认才能${what}${tail}。请到界面上允许或拒绝。`;
}

/**
 * 创建互动队列（严格单调 `at`，与汇报队列同一条纪律）。
 *
 * @param options - `{ limit }`。
 * @returns 队列对象（`push` / `after` / `cursor` / `size` / `snapshot` / `clear`）。
 */
export function createInteractionQueue(options = {}) {
	const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : INTERACTION_LIMIT;
	let items = [];
	let cursor = 0;
	/**
	 * 真正的序号（1、2、3…），与 `at` 分开。
	 *
	 * 别拿 `cursor` 兼职序号：`cursor` 是**毫秒时间戳**，`cursor + 1` 会得出
	 * 一个 1.7e12 量级的"序号"，读日志时完全没法用（`lib/report.js` 曾有
	 * 同样的写法，那里也一并改正）。两者职责不同：`at` 管**排序与增量拉取**，
	 * `seq` 管**人读序号**。
	 */
	let sequence = 0;

	return {
		/**
		 * 追加一条互动。
		 * @param entry - `{ kind, key, sessionId, label, speech, at? }`。
		 * @returns 带 `at`/`seq` 的完整条目。
		 */
		push(entry) {
			const item = {
				seq: (sequence += 1),
				at: Math.max(Date.now(), Number(entry?.at) || 0, cursor + 1),
				kind: String(entry?.kind ?? ""),
				key: String(entry?.key ?? ""),
				sessionId: String(entry?.sessionId ?? ""),
				label: String(entry?.label ?? ""),
				speech: String(entry?.speech ?? "").slice(0, SPEECH_LIMIT),
				detail: entry?.detail === undefined ? null : entry.detail,
			};
			cursor = item.at;
			items.push(item);
			if (items.length > limit) items = items.slice(-limit);
			return item;
		},
		/**
		 * 取游标之后的互动（按 `at` 升序 = 发生先后）。
		 * @param after - 毫秒时间戳，或 `"latest"`（首帧：只要游标，不重放历史）。
		 * @returns `{ interactions, cursor }`。
		 */
		after(after) {
			if (after === "latest" || after === undefined || after === null || after === "") {
				return { interactions: [], cursor };
			}
			const bound = Number(after);
			const floor = Number.isFinite(bound) ? bound : 0;
			return {
				interactions: items.filter((entry) => entry.at > floor).sort((a, b) => a.at - b.at),
				cursor,
			};
		},
		/** 当前游标。 */
		get cursor() {
			return cursor;
		},
		/** 队列长度。 */
		get size() {
			return items.length;
		},
		/**
		 * 最近若干条（health / 调试用，副本）。
		 * @param count - 条数。
		 */
		snapshot(count = 8) {
			return items.slice(-Math.max(0, count)).map((entry) => ({ ...entry }));
		},
		/** 清空（仅测试用）。 */
		clear() {
			items = [];
			cursor = 0;
			sequence = 0;
		},
	};
}

/**
 * 创建互动中枢：旁听会话事件，把审批与提问按时间入队。
 *
 * @param ctx - 宿主根上下文（**必须是根 ctx** —— 未打 scope tag 才收得到
 *   全部会话的事件，这是 worker 会话里审批唯一能被看见的原因）。
 * @param config - 归一化配置（读 `interactions.*` 与 `routing.workers`）。
 * @param options - `{ queue, logger }`。
 * @returns 中枢（`.queue` / `.state()` / `.dispose()` / `.labelOf()`）。
 */
export function createInteractionHub(ctx, config, options = {}) {
	const queue = options.queue ?? createInteractionQueue();
	const logger = options.logger ?? ctx?.logger ?? null;
	const disposers = [];
	let disposed = false;

	/** 会话 id → 展示名（只对这些会话入队，避免打扰用户自己的对话）。 */
	const labels = new Map();
	const remember = (sessionId, label) => {
		const id = typeof sessionId === "string" ? sessionId.trim() : "";
		if (id === "") return;
		labels.set(id, typeof label === "string" && label.trim() !== "" ? label.trim() : id);
	};
	remember(config?.agent?.sessionId, "小凤");
	for (const worker of config?.routing?.workers ?? []) {
		if (worker.sessionId !== "") remember(worker.sessionId, worker.label);
		// general 的 sessionId 就是根 agent（上面已登记），这里不必重复。
	}

	/**
	 * 已入队的审批 id（`approval/asked` 与 `approval/decided` 是一对，
	 * 只在前者入队；防同一 id 因重放/重复派发被念两遍）。
	 */
	const seenApprovals = new Set();
	/** 已入队的提问 callId。 */
	const seenQuestions = new Set();

	const settings = config?.interactions ?? {};
	const announceApprovals = settings.announceApprovals !== false;
	const announceQuestions = settings.announceQuestions !== false;

	/**
	 * 一条事件是否该被处理：只认已知会话，且互动功能开启。
	 * @param session - 会话对象（取 `id`）。
	 * @returns 该会话的展示名，或 `null`（不处理）。
	 */
	const labelOf = (session) => {
		if (disposed || settings.enabled === false) return null;
		const id = typeof session?.id === "string" ? session.id : "";
		if (id === "") return null;
		return labels.get(id) ?? null;
	};

	try {
		disposers.push(
			ctx.on("session/event", (session, event) => {
				if (disposed || event === null || typeof event !== "object") return;
				const label = labelOf(session);
				if (label === null) return;
				const sessionId = typeof session?.id === "string" ? session.id : "";
				const type = String(event.type ?? "");

				// ① 权限审核：只见 `approval/asked`（decided 是结果，不重复念）。
				if (type === "approval/asked") {
					if (!announceApprovals) return;
					const data = event.data !== null && typeof event.data === "object" ? event.data : {};
					const key = typeof data.id === "string" ? data.id : `seq-${String(event.seq ?? "")}`;
					if (seenApprovals.has(key)) return;
					seenApprovals.add(key);
					const toolName = typeof data.toolName === "string" ? data.toolName : "";
					const reason = typeof data.reason === "string" ? data.reason : "";
					queue.push({
						kind: APPROVAL_KIND,
						key,
						sessionId,
						label,
						speech: formatApprovalSpeech({ label, toolName, reason }),
						detail: { toolName, reason, callId: typeof data.callId === "string" ? data.callId : "" },
					});
					logger?.info?.(`voice-assistant: 权限审核待处理（${label} 要用 ${toolName || "某工具"}）已入互动队列`);
					return;
				}

				// ② 模型提问：从原始事件流的 `tool/call` 取（不受投影的 timed 闸门限制）。
				if (type === "tool/call") {
					if (!announceQuestions) return;
					const call = questionCallOf(event);
					if (call === null) return;
					if (seenQuestions.has(call.callId)) return;
					seenQuestions.add(call.callId);
					queue.push({
						kind: QUESTION_KIND,
						key: call.callId,
						sessionId,
						label,
						speech: formatQuestionSpeech(call.questions),
						detail: { callId: call.callId, questions: call.questions },
					});
					return;
				}
			}),
		);
	} catch (error) {
		// 监听不上不让插件挂掉：互动播报退化（审批只能去界面看），但语音链路照常。
		logger?.warn?.(`voice-assistant: 无法旁听会话事件（审批/提问播报将不可用）—— ${String(error?.message ?? error)}`);
	}

	/**
	 * 把一条**结果汇报**也放进同一条流（由委托中枢调用）。
	 *
	 * 这样需求④的"按时间先后呈现"覆盖全部三类：汇报与审批/提问共用一条
	 * 有序流，用户听到的顺序就是事件发生的顺序。
	 *
	 * @param report - 汇报条目（同 `lib/report.js` 的形状）。
	 */
	function pushReport(report) {
		if (disposed || settings.enabled === false) return;
		queue.push({
			kind: REPORT_KIND,
			key: String(report?.jobId ?? ""),
			sessionId: "",
			label: String(report?.label ?? ""),
			speech: String(report?.speech ?? ""),
			detail: { jobId: String(report?.jobId ?? ""), ok: report?.ok !== false },
		});
	}

	/** 宿主自省（health 可见）。 */
	function state() {
		return {
			enabled: settings.enabled !== false,
			announceApprovals,
			announceQuestions,
			watching: [...labels.keys()].length,
			cursor: queue.cursor,
			recent: queue.snapshot(6),
		};
	}

	/** 释放监听。 */
	function dispose() {
		disposed = true;
		for (const off of disposers) {
			try {
				if (typeof off === "function") off();
			} catch {
				// 已释放。
			}
		}
		disposers.length = 0;
	}

	return { queue, state, dispose, pushReport, labelOf, kinds: INTERACTION_KINDS };
}

/**
 * 从 `request.url` 里取 `after` 查询参数。
 *
 * 与 `lib/report.js` 的 `parseReportAfter` 分开写而不是共用：两者是不同
 * 端点的参数解析，未来各自加参数时不该互相牵动。逻辑刻意保持同口径。
 *
 * @param url - 形如 `/plugins/.../api/interactions?after=latest`。
 * @returns `"latest"` 或数字字符串（无参数时为 `null`）。
 */
export function parseInteractionAfter(url) {
	const raw = String(url ?? "").split("?")[1] ?? "";
	for (const pair of raw.split("&")) {
		const eq = pair.indexOf("=");
		const key = eq === -1 ? pair : pair.slice(0, eq);
		if (key !== "after") continue;
		const value = eq === -1 ? "" : decodeURIComponent(pair.slice(eq + 1));
		return value === "" ? null : value;
	}
	return null;
}
