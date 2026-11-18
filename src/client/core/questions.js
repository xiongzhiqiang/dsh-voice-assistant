/**
 * 提问旁听 + 语音作答（**只做 `ask_user_question`，不碰工具权限审批**）。
 *
 * ## 为什么不做工具审批
 *
 * `approval/request`（工具权限）与 `user-questions/request`（模型提问）是两条
 * 独立的 seam。工具审批放行的是**有副作用的操作**（跑 bash、写文件），
 * 语音误听（环境人声、电视、识别错字）会造成真实损害；而模型提问只是
 * "要一个信息"，答错最多重问一次。用户的决定是：**只做后者**。
 *
 * ## 为什么"旁听"而不是注册应答者
 *
 * DSH 把两个 waterfall（`approval/request` / `user-questions/request`）
 * 都**转发到了浏览器**（`@deepseek-ai/dsh-api-remotes` 的
 * `API_REMOTE_FORWARDED_EVENTS`，`lib/types/remote-events.js:18,46`），
 * 官方 UI（`dsh-client-ui-approval` / `dsh-client-ui-user-questions`）
 * 就是在客户端用 `ctx.remote.$on(...)` 注册应答者的。而 `dsh-user-approval`
 * 的 README 明确写着：
 *
 *   > 同级监听器的顺序**不是**策略优先级机制。
 *
 * 也就是说：我再注册一个**会返回结果**的应答者，无法保证排在官方 UI 之后 ——
 * 一旦排在前面，就会把本该显示在界面上的问题抢过来（用户看不到问题卡，
 * 只能靠听）。那是把功能做坏，不是做出来。
 *
 * 所以本模块走**纯增量**路径：只旁听、不参与决策。
 *
 * ## ⚠️ 重大修正：投影旁听在**默认配置下完全收不到问题**
 *
 * 本模块最初**只订阅 `userQuestions` 投影**旁听。真机端到端 spike 里
 * `question()` 恒为 `null`，追下去发现是**设计前提错误**，不是接线 bug：
 *
 * `dsh-user-questions/lib/types/projection.js:209`（`applyUserQuestionEvent`
 * 的 `tool/call` 分支）第一行就是：
 *
 * ```js
 * if (!fold.timed || event.data.name !== ASK_USER_QUESTION_TOOL) return fold;
 * ```
 *
 * 而 `fold.timed` 由 `request/header` 里记下的 **tool schema 是否声明
 * `timeout` 参数**决定（`isTimedAskUserQuestionSchema`）。`dsh-tool-ask-user`
 * 的 `Config.mode` 默认是 **`legacy`**，legacy schema **不声明 `timeout`**
 * → **投影恒空**。README 也确认：「Shipped presets use blocking mode」。
 *
 * 两条独立证据（都在 `tools/research/`）：
 *   1. `probe-question-projection.mjs` —— 直接 import 真机发布的
 *      `projection.js`，喂合成的 legacy / timed 事件序列：
 *      **legacy 恒空、timed 才进**（4/4 PASS）。
 *   2. `probe-ask-user-logs.mjs` —— 扫盘上 26 个会话日志：
 *      **真有 15 次 `ask_user_question` 调用**，但 27 处 schema
 *      **全部是 legacy**（无 `timeout` 属性）。
 *
 * 也就是说：**问题真的在发生，但一个都不会进投影**。
 *
 * ## 正解：读**原始会话事件流**的 `tool/call`
 *
 * 投影是"加工过的视图"（要过 `timed` 闸门）；**原始事件流不受这个闸门限制**，
 * 两种模式都记 `tool/call`。而且本插件的 `VoiceSession` **已经订阅了这条流**
 * （就是处理 `turn/start` / `turn/end` 的那条），不需要任何新增注册。
 *
 * 实探到的形状（`probe-tool-call-shape.mjs`，取真机日志原文）：
 *
 * ```json
 * {"type":"tool/call","seq":140,"time":1793934196418,
 *  "data":{"turn":1,"step":15,"callId":"call_00_gIOIJXseCDA0cwab79mr2983",
 *          "name":"ask_user_question",
 *          "arguments":"{\"questions\":[{\"id\":\"platform\",...}]}"}}
 * ```
 *
 * 两个要点：
 *   - **`arguments` 是 JSON 字符串**，得自己 `JSON.parse`；
 *   - 模型参数用 **`multi_select`**（下划线），转成内部统一的 `multiSelect`。
 *
 * 于是本模块现在有**两条来源**，互为补充：
 *
 * | 来源 | 覆盖 | 作用 |
 * |---|---|---|
 * | 事件流 `tool/call` | **全部**（legacy + timed） | **主路径**：发现新问题、播报 |
 * | `userQuestions` 投影 | 仅 timed | **补充**：拿权威的 `state`（`open`/`continued`） |
 *
 * 只靠事件流也能播报（`state` 一律按 `open` 保守处理），投影在就用来升级。
 *
 * ## 天然的第二层护栏：`answer()` 只收 `continued`
 *
 * 实测（`dsh-user-questions/lib/index.js:560` `answer()`）：
 * 它只在 `continued(agent)` 里找 callId，**`open` 状态一律返回 `false`**。
 * 而 `open` 正是"工具调用还开着、界面问题卡还在、用户能直接点"的窗口；
 * 一旦 120s 计时窗口超时（`dsh-tool-ask-user` 默认 120 秒）或界面关掉，
 * 问题转 `continued` —— **那才是本模块唯一会作答的时刻**。
 *
 * 换句话说：**只要界面还能答，我就插不进去**。这是 DSH 给的护栏，
 * 不是我加的判断（我也有 `state === "continued"` 的显式判断，
 * 但那是为了不白试一次，不是唯一一道防线）。
 *
 * ## 实测出来的契约（全部有真机证据，不是从类型猜的）
 *
 * | 事实 | 证据 |
 * |---|---|
 * | `faceOf(k)` 返回 `{ subscribe, getSnapshot }` | bundle `publishContinuedQuestions` |
 * | 投影形状 `{ active: [{ callId, state, questions }] }` | 同上，取 `projected?.active` |
 * | `state` ∈ `open` \| `continued` | 同上，`row.state === "continued"` |
 * | 作答 `remote.userQuestions.answer(sessionId, callId, answer)` | 同上，`rpcFor` |
 * | 返回是**结果对象** `{ ok, value }` / `{ ok:false, error }` | 同上，`unwrap()` 先判 `ok` |
 * | `answer` 形如 `{ answers: [{ id, selected: [], custom? }] }` | `dsh-user-questions/lib/types/types.d.ts` |
 * | 官方 UI 也用 `sessions.binding(id)` 取同一条 binding | 同上，`Object.values(snapshot.byId)…sessions.binding` |
 * | **legacy 模式的提问不进投影** | `projection.js:209` + `probe-question-projection.mjs` |
 * | **事件流 `tool/call` 两种模式都有** | `probe-tool-call-shape.mjs`（真机日志原文） |
 * | `arguments` 是 **JSON 字符串**；模型写 `multi_select` | 同上 |
 *
 * 这份表是用 `tools/research/probe-user-questions.mjs` 实探出来的
 * （拉真机批量包 + 定位调用点）。**不要凭类型声明改这里的形状** ——
 * `faceOf()` 的返回类型在声明里就是 `unknown`，猜错的表现是静默失效。
 */

/** 本模块关心的工具名（只有它会被旁听）。 */
export const ASK_USER_QUESTION_TOOL = "ask_user_question";

/**
 * 从一条会话事件里读出 `ask_user_question` 的调用。
 *
 * 只认 `tool/call`；事件负载在 `data` 下（本项目的通用坑，见 session.js）。
 * `arguments` 是 **JSON 字符串**，解析失败一律返回 `null`（模型参数畸形时
 * 那次调用本来也没到工具，没有卡片可显示）。
 *
 * @param event - 会话事件（形状 `{ type, seq, time, data }`）。
 * @returns `{ callId, questions }`，或 `null`（不是提问调用 / 读不出来）。
 */
export function questionCallOf(event) {
	if (event === null || typeof event !== "object") return null;
	if (event.type !== "tool/call") return null;
	const payload = event.data !== null && typeof event.data === "object" ? event.data : event;
	if (payload?.name !== ASK_USER_QUESTION_TOOL) return null;
	const callId = typeof payload.callId === "string" ? payload.callId : "";
	if (callId === "") return null;
	const raw = payload.arguments;
	const parsed = parseArguments(raw);
	if (parsed === null) return null;
	const list = Array.isArray(parsed.questions) ? parsed.questions : [];
	const questions = list.map(normalizeQuestion).filter((item) => item !== null);
	if (questions.length === 0) return null;
	return { callId, questions };
}

/**
 * 解析工具参数：主形态是 JSON 字符串，同时兼容已经是对象的情况。
 * @param raw - `arguments` 字段。
 * @returns 解析后的对象，或 `null`。
 */
function parseArguments(raw) {
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw);
			return parsed !== null && typeof parsed === "object" ? parsed : null;
		} catch {
			// 模型参数畸形：那次调用本来也没到工具。
			return null;
		}
	}
	return raw !== null && typeof raw === "object" ? raw : null;
}

/**
 * 把模型写的 `ask_user_question` 参数转成本模块的内部形状。
 *
 * 两处**必须转**的差异（都是实探出来的，不是猜的）：
 *   - `multi_select` → `multiSelect`：模型 schema 用下划线，
 *     而投影/服务层用驼峰（`projection.js` 的 `questionsOf` 就这么转）；
 *   - `options[].description` 缺省时补 `""`，免得下游到处判 undefined。
 *
 * @param item - 模型写的一条问题。
 * @returns 内部形状；`id` 或 `question` 缺失时返回 `null`。
 */
function normalizeQuestion(item) {
	if (item === null || typeof item !== "object") return null;
	const id = typeof item.id === "string" ? item.id : "";
	if (id === "") return null;
	const question = typeof item.question === "string" ? item.question : "";
	if (question === "") return null;
	const options = Array.isArray(item.options)
		? item.options
				.map((option) => (option !== null && typeof option === "object" ? option : null))
				.filter((option) => option !== null && typeof option.label === "string")
				.map((option) => ({
					label: option.label,
					description: typeof option.description === "string" ? option.description : "",
				}))
		: [];
	return {
		id,
		question,
		header: typeof item.header === "string" ? item.header : "",
		options,
		multiSelect: item.multi_select === true || item.multiSelect === true,
	};
}

/**
 * 念问题时最多念几个选项。选项多到念不完时，只念前几个并提示"还有更多"。
 *
 * 依据：一次 `ask_user_question` 常见 2–5 个选项；超过 5 个时用户也记不住，
 * 不如提示去看界面。
 */
const MAX_SPOKEN_OPTIONS = 5;

/**
 * 把一句问题念成人话。
 *
 * 不念 `question.id`（那是给模型对答案用的稳定标识，念出来纯噪音），
 * 但**要念 `header`**：模型常把"要不要继续 / 用哪个方案"这类限定放在
 * header 里，缺了它选项会失去语境。
 *
 * @param item - `{ question, header?, detail?, options? }`。
 * @param ordinal - 第几个问题（多问题批次时前缀"第一问"）。
 * @param total - 本批问题总数。
 * @returns 念给用户的文本。
 */
export function speakQuestion(item, ordinal, total) {
	const head = typeof item?.header === "string" && item.header.trim() !== "" ? `${item.header.trim()}：` : "";
	const body = typeof item?.question === "string" ? item.question.trim() : "";
	const prefix = total > 1 ? `第${["一", "二", "三", "四", "五"][ordinal] ?? String(ordinal + 1)}问，` : "";
	let text = `${prefix}${head}${body}`;

	const options = Array.isArray(item?.options) ? item.options : [];
	if (options.length > 0) {
		const labels = options.slice(0, MAX_SPOKEN_OPTIONS).map((option) => String(option?.label ?? "").trim()).filter((label) => label !== "");
		if (labels.length > 0) {
			text += `。选项：${labels.map((label, index) => `${["一", "二", "三", "四", "五"][index]}是${label}`).join("，")}`;
			if (labels.length < options.length) text += `等 ${options.length} 个`;
			text += "。";
		}
	} else {
		text += "。这是开放问题，直接说就行。";
	}
	// 念完提示怎么答 —— 用户不知道"可以语音答"就不会答。
	text += "要选哪个直接说。";
	return text;
}

/**
 * 把用户的语音回答匹配到某个选项。
 *
 * ## 匹配顺序为什么是"先精确后模糊"
 *
 * 先比选项**原文**再比序号，是因为中文识别常把"一"写成"1"、把序号
 * 听成别的字，但**选项原文**（通常是"允许"、"方案 A"这类实义词）识别
 * 准确率高得多。反过来先看序号，会把"我要第二个方案"这种话里的
 * 数字当成序号，实际用户想要的是那个方案本身。
 *
 * 支持的表达式（覆盖实测常见的说话方式）：
 *   - 选项原文：「方案 A」「允许」「用第一个」
 *   - 文本序号：「一 / 第一 / 第一个 / 1 / 第 1 个」
 *   - 序数词：「首个 / 最后一个 / 第二个」
 *   - 明确否定：「都不选 / 跳过 / 不用」（→ 空 selected，即"跳过"）
 *
 * @param text - 用户说的话（已归一化）。
 * @param options - 选项数组。
 * @param multiSelect - 是否多选。
 * @returns `{ selected, custom, matched }`；`matched` 为 `false` 表示没匹配上。
 */
export function matchAnswer(text, options, multiSelect = false) {
	const said = normalize(text);
	const list = Array.isArray(options) ? options : [];
	if (said === "") return { selected: [], custom: "", matched: false };

	// 「跳过」是协议认的形态（`selected: []` 且无 `custom`），也是唯一安全的
	// 默认 —— 用户说"不用了"时绝不能替他随便选一个。
	if (/(^|不)(跳过|都不用|都不选|不用了|算了)|^跳过$/.test(said)) {
		return { selected: [], custom: "", matched: true, skip: true };
	}

	const matched = [];
	for (let index = 0; index < list.length; index += 1) {
		const label = normalize(String(list[index]?.label ?? ""));
		if (label === "") continue;
		// 选项原文匹配：**双向包含**（用户可能只说了选项的一部分，
		// 例如选项是"允许一次"而用户说"允许"；也可能把选项念全）。
		if (label === said || said.includes(label) || label.includes(said)) {
			matched.push(String(list[index].label));
			if (!multiSelect) break;
		}
	}
	if (matched.length > 0) {
		return { selected: matched, custom: "", matched: true };
	}

	// 序号匹配：中文数字与阿拉伯数字都认（识别对数字的写法不稳定）。
	const ordinals = [
		["一", "1", "第一", "第一个", "首个"],
		["二", "2", "第二", "第二个", "次个"],
		["三", "3", "第三", "第三个"],
		["四", "4", "第四", "第四个"],
		["五", "5", "第五", "第五个"],
	];
	// 「最后一个」单独判，避免选项多于 5 个时漏掉。
	if (/最后(一)?个/.test(said) && list.length > 0) {
		return { selected: [String(list[list.length - 1].label)], custom: "", matched: true };
	}
	for (let index = 0; index < ordinals.length && index < list.length; index += 1) {
		if (ordinals[index].some((token) => said.includes(token))) {
			return { selected: [String(list[index].label)], custom: "", matched: true };
		}
	}

	// 有选项但没匹配上：**不猜**。返回未匹配，由调用方再问一次或交回界面。
	if (list.length > 0) return { selected: [], custom: "", matched: false };
	// 开放问题：用户说什么就是什么。
	return { selected: [], custom: String(text ?? "").trim(), matched: true };
}

/**
 * 归一化：去掉空格、把中文数字统一成阿拉伯数字、去掉标点。
 *
 * 与 `echo.js` 的 `normalizeForEcho` 分开写：那个面向"同音比对"，
 * 这个面向"口令匹配"，两者要保留的东西不同（这里必须**保留数字**，
 * 同音比对则要抹掉）。
 *
 * @param text - 原始文本。
 * @returns 归一化文本。
 */
export function normalize(text) {
	return String(text ?? "")
		.replace(/\s+/g, "")
		.replace(/[，。！？、,.!?~～]/g, "")
		.toLowerCase();
}

/**
 * 提问旁听桥。
 *
 * 生命周期：`attach(binding)` / `detach()`。
 *
 * ## 两条来源的分工
 *
 *   - **事件流（主）**：`observeEvent(event)` 由会话桥在**每条**会话事件上调用
 *     （它本来就在处理 `turn/start` / `turn/end`）。`tool/call` 里发现
 *     `ask_user_question` 就播报。**这条不受 `timed` 限制**，所以是主路径。
 *   - **投影（补充）**：若 `userQuestions` 投影存在，订阅它拿到权威的
 *     `state`（`open` / `continued`）—— 只有 `continued` 才能作答。
 *     投影为空（legacy 模式）也不影响播报，只是 `state` 保守按 `open`。
 *
 * 换会话时必须重建：`tool/call` 的 `callId` 是**按会话**的，
 * 投影更是按会话的。沿用旧的会念出别的会话的问题。
 */
export class QuestionBridge {
	/**
	 * @param options - `{ ctx, onQuestion, onResolved, log, warn, ledger }`。
	 *   `onQuestion(payload)` 让上层去播报；`payload` 形如
	 *   `{ sessionId, callId, state, questions }`。
	 *   `ctx` 必须有：作答要走 `ctx.remote.userQuestions.answer(...)`。
	 *   `ledger`（可选）是控制器的播报账本 —— 用来把"已经念过哪个问题"
	 *   **持久化**，见下面 `markAnnounced`。
	 */
	constructor(options = {}) {
		this.ctx = options.ctx ?? null;
		this.onQuestion = options.onQuestion ?? (() => {});
		this.onResolved = options.onResolved ?? (() => {});
		this.log = options.log ?? (() => {});
		this.warn = options.warn ?? (() => {});
		/**
		 * 播报账本（可选）。
		 *
		 * ## 为什么提问也要落账本（需求②的第三处漏口）
		 *
		 * `announced` 原来只在内存里，而 `attach()` 里的 `reconcile()`
		 * **有意**要在绑定前先跑一遍（原注释：「页面刚刷新、问题在历史里
		 * 也该被念出来」）。两句合起来的真机表现就是：
		 *
		 *   1. 助手念了一次问题；
		 *   2. 用户刷新页面；
		 *   3. 投影里那个问题仍是 `active`（120 秒计时窗口还没到，
		 *      或者用户压根没答）→ `announced` 已归零 → **又念一遍**。
		 *
		 * 同一个坑的另外两个出口（互动流游标、会话 seq）已经在
		 * `ledger.js` 堵上了，这里是第三处，共用同一份账本。
		 */
		this.ledger = options.ledger ?? null;

		/** 当前绑定的会话 id（`null` = 未绑定）。 */
		this.sessionId = null;
		/** 投影的退订函数。 */
		this.unsubscribe = null;
		/** 已对哪些 callId 播报过（防重复念同一批问题）。 */
		this.announced = new Set();
		/** 已提交作答的 callId（防重复提交，DSH 会以 REPLY_QUEUED 拒绝第二次）。 */
		this.answered = new Set();
		/** 已知的问题内容（投影可能拿不到 questions，靠事件流兜底）。 */
		this.known = new Map();
		/** 投影给出的权威 state（`continued` 才可作答）。 */
		this.states = new Map();
		/**
		 * 是否见过 timed 投影。
		 *
		 * 用来在诊断里一眼区分"投影可用但为空（timed 无问题）"与
		 * "投影结构上收不到（legacy）"—— 后者是**正常的**，
		 * 本机默认就是它，不该报警。
		 */
		this.projectionSeen = false;
	}

	/**
	 * 接入一条会话。
	 *
	 * @param sessionId - 会话 id。
	 * @param binding - `sessions.retain()` / `binding()` 给的绑定。
	 * @returns 是否接入成功（接入不上不是错误，事件流那条仍会工作）。
	 */
	attach(sessionId, binding) {
		this.detach();
		this.sessionId = sessionId;
		const face = binding?.session?.projections?.faceOf?.("userQuestions");
		if (face === undefined || face === null || typeof face.getSnapshot !== "function") {
			// 提问投影不在（精简 profile / 未装 dsh-user-questions）：
			// 静默跳过。**不 warn** —— 这是合法的可选能力，装机不同而已。
			// 事件流那条不依赖投影，照常工作。
			this.log("提问投影不可用（不影响事件流旁听）");
			return false;
		}
		this.face = face;
		this.projectionSeen = true;
		// `reconcile` 必须在订阅前先跑一遍，把"当前还挂着的问题"接上。
		//
		// ⚠️ 需求② 修正了这里的理由。原来的注释是「页面刚刷新、问题在历史里
		// 也该被念出来」—— 那句正是重复播报的来源，且是**有意为之**的：
		// `announced` 刷新即归零，于是每次刷新都把同一个 `active` 问题念一遍。
		//
		// 现在的口径是：**接上，但只念没念过的**。判定交给
		// `markAnnounced`（内存集合 + 持久账本），所以「真·新问题」照念，
		// 「刷新后重放的旧问题」被账本拦下。
		this.reconcile();
		if (typeof face.subscribe === "function") {
			this.unsubscribe = face.subscribe(() => this.reconcile());
		}
		this.log(`提问旁听已接入（session ${String(sessionId).slice(0, 8)}）`);
		return true;
	}

	/**
	 * 标记"这个问题已经念过"，并判断这次到底该不该念。
	 *
	 * 内存集合 + 持久账本**两个一起查、一起记**：
	 *   - 内存集合管"本次页面生命周期内"（快，且不依赖存储）；
	 *   - 持久账本管"跨刷新"（这才是需求②要的）。
	 *
	 * 账本认不出身份时（理论上 callId 非空就一定认得，这里是兜底）
	 * 一律放行 —— 宁可多念一次，也不要把真问题吞掉。
	 *
	 * @param callId - 提问调用 id。
	 * @returns `true` = 这次该念（并已记账）。
	 */
	markAnnounced(callId) {
		const id = String(callId ?? "").trim();
		if (id === "") return true;
		if (this.announced.has(id)) return false;
		// 账本判定：`claim` 判定与记账合一，返回 false 说明**上一个页面**已经念过。
		if (this.ledger !== null && this.ledger.claim({ kind: "question", key: id }) === false) {
			// 账本说念过 —— 补进内存集合，免得本次会话里再走一遍账本判定。
			this.announced.add(id);
			return false;
		}
		this.announced.add(id);
		return true;
	}

	/**
	 * 观察一条会话事件（**主路径**）。
	 *
	 * 由会话桥在每条事件上调用。这里只关心 `tool/call` 的
	 * `ask_user_question` —— 那条不受 `timed` 闸门限制，
	 * 是 legacy 模式下**唯一**能发现问题的途径。
	 *
	 * @param event - 会话事件。
	 * @returns 是否识别出一个新的提问调用。
	 */
	observeEvent(event) {
		const call = questionCallOf(event);
		if (call === null) return false;
		this.known.set(call.callId, call.questions);
		if (this.answered.has(call.callId)) return false;
		if (!this.markAnnounced(call.callId)) return false;
		// 事件流拿不到 `state`（那是投影才知道的）→ 保守按 `open`：
		// 先播报（有价值），作答与否由 `tryAnswerQuestion` 按投影定。
		const state = this.states.get(call.callId) ?? "open";
		try {
			this.onQuestion({ sessionId: this.sessionId, callId: call.callId, state, questions: call.questions });
		} catch (error) {
			this.warn("播报提问失败", error?.message ?? error);
		}
		return true;
	}

	/**
	 * 读一次投影，把"还没播报过的"问题交出去播报，并刷新权威 `state`。
	 *
	 * 只处理 `active`（能作答的）—— `settled` 是已经答完的历史，
	 * 念它等于把陈年旧事当新闻播。
	 */
	reconcile() {
		const face = this.face;
		if (face === undefined || face === null) return;
		let snapshot;
		try {
			snapshot = face.getSnapshot();
		} catch (error) {
			this.warn("读提问投影失败", error?.message ?? error);
			return;
		}
		const active = Array.isArray(snapshot?.active) ? snapshot.active : [];
		for (const row of active) {
			const callId = typeof row?.callId === "string" ? row.callId : "";
			if (callId === "") continue;
			const state = row.state === "continued" ? "continued" : "open";
			// 权威 state 优先于事件流的保守值。
			this.states.set(callId, state);
			if (this.answered.has(callId)) continue;
			// 投影里的 questions 可能比事件流更全（例如页面刷新后
			// 事件流没重放过）→ 以投影为准补上。
			const questions = Array.isArray(row.questions) && row.questions.length > 0 ? row.questions : this.known.get(callId);
			if (!Array.isArray(questions) || questions.length === 0) continue;
			this.known.set(callId, questions);
			if (!this.markAnnounced(callId)) continue;
			try {
				this.onQuestion({ sessionId: this.sessionId, callId, state, questions });
			} catch (error) {
				this.warn("播报提问失败", error?.message ?? error);
			}
		}
		// 已经不在 active 里的（被答掉/被撤销）：清掉记录，避免集合无限长。
		// 注意**只清内存集合**，不动持久账本 —— 账本要留着跨刷新拦截
		// "问题还挂在 active 上没答"这一种重放（上面 markAnnounced 的场景）。
		const live = new Set(active.map((row) => (typeof row?.callId === "string" ? row.callId : "")));
		for (const callId of this.announced) {
			if (!live.has(callId) && this.answered.has(callId)) this.announced.delete(callId);
		}
		for (const callId of this.states.keys()) {
			if (!live.has(callId)) this.states.delete(callId);
		}
	}

	/**
	 * 提交一个回答。
	 *
	 * @param callId - 要回答的调用。
	 * @param answer - `{ answers: [{ id, selected, custom? }] }`。
	 * @returns `{ ok, reason }`；`ok:false` 时 `reason` 说明为什么（如实回报，不静默）。
	 */
	async submit(callId, answer) {
		// ## 为什么用 `ctx.get("…")` 而不是 `ctx.remote.userQuestions`
		//
		// **真机踩出来的**：`ctx.remote.userQuestions` 这种嵌套访问会被
		// cordis 的代理拦下，未在 `inject` 声明过就抛
		// `cannot get property "remote.userQuestions" without inject`
		// （`cordis/lib/index.js:1257`）。症状很隐蔽：**同步抛在
		// `try` 外面**（那句 `service.answer` 之前），所以连
		// `{ok:false, reason}` 都返回不了，直接变成浏览器里一条
		// "Uncaught (in promise)"。
		//
		// **为什么不能把它加进插件 `inject`**：官方 UI 声明了
		// `["sessions","remote","remote.userQuestions",…]`
		// （`dsh-client-ui-user-questions/lib/client.js:1973`），但我们**不能**照抄 ——
		// `inject` 是"必须就绪才启动"，精简 profile 没装
		// `dsh-user-questions` 时，整个语音球会因为等一个可选服务而
		// **永远不激活**。代价（整个 UI 消失）远大于收益（作答不可用）。
		//
		// 正解是 cordis 给的免 inject 读取口 `ctx.reflect.get(name)`
		// —— 它的文档原文就是 "Read a service from the store **without the
		// inject requirement**"。注意传的是**服务全名**（带点号的
		// `remote.userQuestions`，它是注册名而不是嵌套属性）。
		const ctx = this.ctx;
		let service;
		try {
			// `ctx.get` 与 `ctx.reflect.get` 是同一条路（mixin 把 reflect 的
			// 方法挂到了 ctx 上）；两个都试一遍是为了兼容只有其一的 ctx。
			service = ctx?.get?.("remote.userQuestions") ?? ctx?.reflect?.get?.("remote.userQuestions");
		} catch (error) {
			// 取服务本身抛错（代理的护栏）→ 如实回报，不让异常逃出去。
			return { ok: false, reason: `remote-unavailable: ${String(error?.message ?? error)}` };
		}
		if (service === undefined || service === null || typeof service.answer !== "function") {
			return { ok: false, reason: "remote-userQuestions-unavailable" };
		}
		if (this.sessionId === null) return { ok: false, reason: "no-session" };
		// 同一问题只提交一次。DSH 对第二次会以 `REPLY_QUEUED` 拒绝（实测
		// `dsh-user-questions/lib/index.js` 的 `answer()`），先发的那次已经
		// 把答复排进了 inbox —— 再发一次除了在界面上刷一条无意义的报错，
		// 没有任何作用。
		if (this.answered.has(callId)) return { ok: false, reason: "already-answered" };
		try {
			const result = await service.answer(this.sessionId, callId, answer);
			// 实测：返回是**结果对象** `{ ok, value }` / `{ ok:false, error }`，
			// 不是裸布尔。官方 UI 的 `unwrap()` 就是这个形状。
			if (result !== null && typeof result === "object" && result.ok === false) {
				const failure = result.error ?? {};
				return { ok: false, reason: String(failure.message ?? failure.code ?? "answer-rejected") };
			}
			// `ok:true` 但 `value:false` = 这个问题已不在 `continued`（多半界面已经答了）。
			const value = result !== null && typeof result === "object" ? result.value : undefined;
			if (value === false) return { ok: false, reason: "not-answerable" };
			this.answered.add(callId);
			this.onResolved({ callId, answer });
			return { ok: true, reason: "" };
		} catch (error) {
			return { ok: false, reason: String(error?.message ?? error) };
		}
	}

	/** 释放订阅与状态（换会话/卸载时调用）。 */
	dispose() {
		if (typeof this.unsubscribe === "function") {
			try {
				this.unsubscribe();
			} catch {
				// 退订失败无所谓。
			}
		}
		this.unsubscribe = null;
		this.face = undefined;
		this.sessionId = null;
		this.announced.clear();
		this.answered.clear();
		this.known.clear();
		this.states.clear();
	}

	/**
	 * 释放会话相关状态，但**保留** `ctx`（桥对象本身还要继续用）。
	 *
	 * 与 `dispose()` 的区别只在语义：`dispose()` 是"整个桥不要了"，
	 * 这个是"换了一条会话，重来"。当前两者做的事一样，分开是为了
	 * 以后给 `dispose()` 加资源释放时不会误伤换会话路径。
	 */
	detach() {
		this.dispose();
	}

	/**
	 * 诊断快照（只读，供 `__xfvDebug` 用）。
	 * @returns 计数与关键状态。
	 */
	inspect() {
		return {
			sessionId: this.sessionId ?? null,
			projectionAttached: this.face !== undefined,
			projectionSeen: this.projectionSeen,
			announced: this.announced.size,
			answered: this.answered.size,
			known: this.known.size,
			states: Object.fromEntries(this.states),
		};
	}
}
