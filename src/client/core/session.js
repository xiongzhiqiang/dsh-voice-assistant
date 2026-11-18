/**
 * 会话桥（客户端）：把语音指令送进 DSH 会话，并把回答读出来。
 *
 * ## 会话从哪来：常驻 agent 优先
 *
 * `persistent`（默认）：retain 宿主在 DSH 层创建的**常驻 agent**会话
 * （`config.agent.sessionId`，由宿主半 `lib/agent.js` 在启动时建好）。
 * 语音链路不创建、也不需要打开任何 UI 会话 —— 用户对着电脑说话就行。
 * 拿不到常驻 agent（精简 profile、宿主创建失败）时降级为 `dedicated`：
 * 自建「小凤语音会话」，行为与旧版一致。
 *
 * ## 为什么 retain 而不是 binding
 *
 * `ctx.sessions.binding(id)` 只借"已经存在"的绑定，会话被其他视图释放后
 * 就会失效（语音链路会在几分钟后静默断掉）。`retain` 显式持有一份引用，
 * 生命周期归本插件所有，直到插件卸载。
 *
 * ## 只念新的
 *
 * 订阅 `eventSource` 前先把当前窗口的最大 `seq` 记为水位线。否则会话一打开，
 * 历史里的所有 assistant 消息会被一次性念出来 —— 这是接入 TTS 时最经典的
 * 翻车现场。常驻模式同样要水位线：agent 跨休眠续存，历史只会长。
 */
import { assistantTextOf } from "./text.js";
import { log, warn } from "./runtime.js";

/** 事件水位线的初始值（早于任何真实 seq）。 */
const NO_SEQ = -1;

/**
 * 历史回放的时间容差（毫秒）。
 *
 * 判据是"事件的 `time` 是否早于绑定时刻"。留这段余量是为了容忍
 * 浏览器与 DSH 服务的时钟差（远程访问时可能差几秒）：没有余量的话，
 * 时钟快 1s 的浏览器会把**刚发生的新事件**也判成历史而丢掉。
 * 历史动辄早几分钟，2s 余量远小于两者间隔，不会漏放历史。
 */
const HISTORY_SKEW_MS = 2000;

/** 语音会话桥。 */
export class VoiceSession {
	/**
	 * @param options - `{ ctx, config, onTurnStart, onTurnEnd, onQuestionCall, onStatus, onError }`。
	 */
	constructor(options) {
		this.ctx = options.ctx;
		this.config = options.config;
		/**
		 * 会话 eq 水位的持久化存储（需求②，可空）。
		 *
		 * 由控制器注入（`createSeqWatermark()`）—— 放在这里而不是自己 new，
		 * 是为了让单测能把一个内存实现塞进来，也让"存储可不可用"这件事
		 * 有一个统一的出处。
		 */
		this.seqWatermark = options.seqWatermark ?? null;
		/** 绑定时采用持久化水位时的值（`null` = 用的是窗口水位，排障用）。 */
		this.savedCursorUsed = null;
		this.onTurnStart = options.onTurnStart ?? (() => {});
		this.onTurnEnd = options.onTurnEnd ?? (() => {});
		/**
		 * 发现一次 `ask_user_question` 调用时回调（主路径，见 `handleEvent`）。
		 *
		 * 为什么不走 `onTurnStart` 之类既有回调转一手：`tool/call` 与 turn
		 * 边界是**正交**的 —— 一次 turn 里可能既有工具调用又有最终回答，
		 * 混进 turn 回调会让"提问"和"回答"的语义互相污染。
		 */
		this.onQuestionCall = options.onQuestionCall ?? (() => {});
		this.onStatus = options.onStatus ?? (() => {});
		this.onError = options.onError ?? (() => {});

		this.sessionId = null;
		/** 会话来源：`persistent`（常驻 agent）| `dedicated` | `dedicated-fallback` | `switched`。 */
		this.mode = "";
		this.reference = null;
		this.binding = null;
		this.unsubscribe = null;
		/** 已处理到的事件序号。 */
		this.cursor = NO_SEQ;
		/** 当前 turn 里累积的 assistant 文本（按 step 覆盖，取最后一段）。 */
		this.turnText = "";
		this.ensuring = null;
		/**
		 * 显式指定的绑定目标（`switchTo` 设的）。
		 *
		 * 与 `sessionId` 的区别：`sessionId` 是"已经绑上了谁"，这个是"接下来要绑谁"。
		 * 分开是为了让 `createAndBind` 能区分三种意图 —— 跟随常驻 agent、自建一个、
		 * 还是绑死用户点名的那个。有了它，`switchTo` 不必重写整段绑定逻辑。
		 */
		this.pinnedId = null;
		/**
		 * 当前 pin 是否由**路由层**设置（区别于用户手动跨会话切换）。
		 *
		 * 两者都把 `mode` 置为 `switched`，但语义相反：
		 *   - 用户手动 pin（`routerPinned === false`）：比自动路由更强的意图
		 *     表达，路由让位，直到用户切回常驻助手；
		 *   - 路由 pin（`routerPinned === true`）：**每条指令都该重新路由**，
		 *     下一条话可能该换专家。
		 * 没有这个标记，第一次路由之后 `mode` 恒为 `switched`、路由被自己的
		 * 产物关掉（真机冒烟抓到：`smoke-questions` 报"期望 persistent
		 * 实际 switched"，即第一条指令路由后全部后续指令不再路由）。
		 */
		this.routerPinned = false;
		/**
		 * 最近几次 `prompt()` 的**原始**返回与异常（环形，保留 8 条）。
		 *
		 * 为什么留这个：`ask()` 把失败统一转成 `Error` 抛给上层，上层再包一层
		 * 人话提示。原始返回里那些 `ok:false` 的 `code` / `message` 就丢了，
		 * 而"提交到底被没被接受"恰恰只能从原始返回判断。排障时靠它一眼看清
		 * 「是提交被拒了」还是「提交成功、错误另有来源」。
		 */
		this.promptLog = [];
	}

	/**
	 * 确保会话就绪（幂等；并发调用共享同一次创建）。
	 *
	 * @param options - `{ open }`：是否在界面上打开该会话。
	 * @returns 会话绑定，或 `null`（DSH 会话服务不可用）。
	 */
	async ensure(options = {}) {
		if (this.binding !== null) {
			if (options.open === true) this.openInUi();
			return this.binding;
		}
		if (this.ensuring !== null) return this.ensuring;

		this.ensuring = this.createAndBind(options).finally(() => {
			this.ensuring = null;
		});
		return this.ensuring;
	}

	/** 是否应使用常驻 agent 会话。 */
	usingPersistent() {
		return (
			this.config.session?.mode === "persistent" &&
			this.config.agent?.enabled === true &&
			typeof this.config.agent?.sessionId === "string" &&
			this.config.agent.sessionId !== ""
		);
	}

	/**
	 * 真正创建/绑定会话。
	 *
	 * persistent 模式：直接 retain 常驻 agent 的 sessionId；retain 失败
	 * （会话不存在/宿主没建成）就降级为自建会话，别让语音链路整体断掉。
	 * @param options - `{ open }`。
	 */
	async createAndBind(options) {
		const sessions = this.ctx.get("sessions");
		if (!sessions) {
			this.onError(new Error("sessions-service-unavailable"));
			return null;
		}
		try {
			if (this.sessionId === null && this.pinnedId !== null) {
				// 用户点名要绑的那个（跨会话切换）。优先级最高 —— 连常驻 agent 都让位。
				this.sessionId = this.pinnedId;
				this.mode = "switched";
				log("绑定指定会话", this.sessionId);
			}
			if (this.sessionId === null && this.usingPersistent()) {
				this.sessionId = this.config.agent.sessionId;
				this.mode = "persistent";
				log("使用常驻 agent 会话", this.sessionId);
			}
			if (this.sessionId === null) {
				const created = await sessions.create(
					this.config.session.workspace !== "" ? { cwd: this.config.session.workspace } : {},
				);
				this.sessionId = created;
				this.mode = "dedicated";
				log("已创建语音会话", created);
			}

			let reference;
			try {
				reference = sessions.retain(this.sessionId, { source: "voice-assistant" });
			} catch (error) {
				// 只有**常驻会话**失败才降级自建（agent 可能没建成）；
				// 用户点名的会话绑不上就是绑不上，降级会悄悄换走目标、更糟。
				if (this.mode !== "persistent") throw error;
				warn("常驻 agent 会话不可用，降级为自建会话", error);
				this.sessionId = null;
				this.mode = "dedicated-fallback";
				return this.createAndBind(options);
			}
			this.reference = reference;
			let binding = reference.binding;
			if (binding === undefined || binding === null) {
				try {
					binding = await reference.ready;
				} catch (error) {
					binding = reference.binding;
					if (binding === undefined || binding === null) throw error;
				}
			}
			this.binding = binding;
			this.bindEvents(binding);
			if (options.open === true) this.openInUi();
			this.onStatus({ kind: "session-ready", sessionId: this.sessionId });
			return binding;
		} catch (error) {
			warn("会话准备失败", error);
			this.onError(error instanceof Error ? error : new Error(String(error)));
			return null;
		}
	}

	/** 在界面上打开语音会话（用户能看到逐句文本）。 */
	openInUi() {
		if (this.sessionId === null) return;
		const workspace = this.ctx.get("uiWorkspace");
		if (workspace && typeof workspace.openSession === "function") {
			try {
				workspace.openSession(this.sessionId);
			} catch (error) {
				// 打开失败不影响语音链路本身，只是用户看不到文本。
				warn("打开语音会话失败", error);
			}
		}
	}

	/** ── 跨会话：列出 / 切换 / 新建 ─────────────────────────────────── */

	/**
	 * 列出可以"把语音指令投过去"的会话。
	 *
	 * 只读 `ctx.sessions.list` 的快照（本地投影，不发请求）；需要更新的
	 * 列表时调 `refresh()`，那是宿主往返，由调用方决定要不要付这个代价。
	 *
	 * 过滤掉两类：
	 *   - `origin === 'subagent'`：子代理会话，按普通 id 投喂会被宿主拒
	 *     （`session/agent-busy`），列出来只会让用户选了报错；
	 *   - `blank === true`：空白会话，还没内容，投进去等于新建。
	 *
	 * @returns `{ id, title, cwd, running, current }[]`，最近的在前。
	 */
	listTargets() {
		const sessions = this.ctx.get("sessions");
		const snapshot = sessions?.list?.getSnapshot?.();
		const state = snapshot?.state ?? snapshot;
		const ids = Array.isArray(state?.ids) ? state.ids : [];
		const byId = state?.byId !== null && typeof state?.byId === "object" ? state.byId : {};
		const out = [];
		for (const id of ids) {
			const row = byId[id];
			if (row === null || row === undefined) continue;
			if (row.origin === "subagent") continue;
			if (row.blank === true) continue;
			out.push({
				id: row.id ?? id,
				title: typeof row.displayTitle === "string" && row.displayTitle !== "" ? row.displayTitle : String(row.title ?? id),
				cwd: typeof row.cwd === "string" ? row.cwd : "",
				running: row.running === true,
				// 常驻模式下列表里那个就是当前目标；否则比 pinnedId/sessionId。
				current: this.binding !== null && (row.id ?? id) === this.sessionId,
			});
		}
		return out;
	}

	/**
	 * 把语音指令的目标**切到**另一个会话。
	 *
	 * ## 切换必须重建整条订阅链，不能只换 sessionId
	 *
	 * 水位线（`cursor`）与时间地板（`floorTime`）都是**相对某一条会话**算的：
	 *   - `cursor` 是那条会话的 seq，换会话后毫无意义；
	 *   - `floorTime` 是"绑定时刻 − 2s"，专为拦住那条会话的历史回放。
	 * 只换 id 不重置这两样，新会话的历史就会整批灌进来被当成新事件念出去 ——
	 * 正是本项目已经踩过的那类"翻车现场"（见 `bindEvents` 的长注释）。
	 * 所以这里先 `dispose()` 释放旧引用与订阅，再走一遍完整的 `ensure()`。
	 *
	 * @param sessionId - 目标会话 id。
	 * @param options - `{ router?: boolean }`：由路由层发起的切换置 `routerPinned`。
	 * @returns 是否切换成功。
	 */
	async switchTo(sessionId, options = {}) {
		const id = typeof sessionId === "string" ? sessionId.trim() : "";
		if (id === "") return false;
		if (this.binding !== null && this.sessionId === id) {
			// 目标没变也要刷新归属：用户手动 pin 之后路由想切回同一会话时，
			// 归属必须翻成路由的（否则后续指令会被"用户手动 pin"挡住不路由）。
			if (options.router === true) this.routerPinned = true;
			return true;
		}
		this.dispose();
		this.sessionId = null;
		this.mode = "";
		this.cursor = NO_SEQ;
		this.turnText = "";
		this.pinnedId = id;
		this.routerPinned = options.router === true;
		const binding = await this.ensure({ open: false });
		if (binding === null) {
			// 切不过去就退回常驻会话，别把用户留在"没有目标"的状态。
			this.pinnedId = null;
			this.routerPinned = false;
			this.sessionId = null;
			await this.ensure({ open: false });
			return false;
		}
		this.onStatus({ kind: "session-switched", sessionId: this.sessionId });
		return true;
	}

	/**
	 * 当前绑定的人类可读描述（界面用）。
	 *
	 * `sessionId` 是 8 位十六进制串，直接显示给用户等于没显示。这里把它
	 * 翻成"常驻助手 / 某个会话的标题 / 语音专用会话"，用户才看得懂
	 * 现在说的话会进哪儿 —— 跨会话功能唯一真正重要的信息就是这个。
	 *
	 * @returns `{ mode, label, id }`。
	 */
	describe() {
		const id = this.sessionId;
		if (id === null || id === undefined) return { mode: "", label: "尚未建立", id: null };
		if (this.mode === "persistent") return { mode: this.mode, label: "小凤 · 常驻助手", id };
		if (this.mode === "dedicated-fallback") return { mode: this.mode, label: "语音专用会话（常驻不可用，已降级）", id };
		if (this.mode === "dedicated") return { mode: this.mode, label: "语音专用会话", id };
		const row = this.listTargets().find((item) => item.id === id);
		if (row !== undefined) return { mode: this.mode, label: row.title, id };
		return { mode: this.mode, label: String(id).slice(0, 8), id };
	}

	/**
	 * 新建一个会话，并把语音目标切过去。
	 *
	 * 用 `ctx.sessions.create()`（宿主侧创建）而不是 `uiWorkspace.startSession()`：
	 * 后者要往编辑器草稿里放文本、依赖 UI 导航选中，语音链路没有"当前选中"
	 * 这个概念（`uiWorkspace` 也不暴露读面）。直接 create + switchTo 更确定：
	 * 建好就绑上，随后 `ask()` 的指令自然落进这个新会话。
	 *
	 * @param options - `{ cwd, title }`。
	 * @returns 新会话 id，或 `null`（服务不可用/创建失败）。
	 */
	async createAndSwitch(options = {}) {
		const sessions = this.ctx.get("sessions");
		if (sessions === null || sessions === undefined || typeof sessions.create !== "function") {
			this.onError(new Error("sessions-service-unavailable"));
			return null;
		}
		const cwd = typeof options.cwd === "string" && options.cwd.trim() !== "" ? options.cwd.trim() : this.config.session.workspace;
		try {
			const created = await sessions.create(cwd === "" ? {} : { cwd });
			const id = typeof created === "string" ? created : created?.sessionId;
			if (typeof id !== "string" || id === "") throw new Error("create-returned-no-id");
			const ok = await this.switchTo(id);
			if (!ok) return null;
			this.onStatus({ kind: "session-created", sessionId: id, title: options.title ?? "" });
			return id;
		} catch (error) {
			warn("新建会话失败", error);
			this.onError(error instanceof Error ? error : new Error(String(error)));
			return null;
		}
	}

	/** 切回常驻助手会话（跨会话聊完之后的"回家"）。 */
	async switchToPersistent() {
		if (!this.usingPersistent()) return false;
		this.dispose();
		this.sessionId = null;
		this.mode = "";
		this.cursor = NO_SEQ;
		this.turnText = "";
		this.pinnedId = null;
		this.routerPinned = false;
		const binding = await this.ensure({ open: false });
		return binding !== null;
	}

	/**
	 * 订阅事件窗口。
	 *
	 * ## 为什么光有 seq 水位线不够（真机实测踩坑）
	 *
	 * 常驻 agent 的**历史是异步水合的**，不是在 `retain()` 返回时就位：
	 *
	 * ```
	 * retain() 返回 → getSnapshot().entries === []   → 水位线 = -1
	 *        ↓ 84ms
	 * 116 条历史整批灌入（seq 0..115，含几分钟前的 turn）
	 * ```
	 *
	 * 水位线按"窗口里有多大 seq"算，窗口是空的就只能定成 −1，于是**没挡住任何东西**。
	 * 紧接着历史里那条**上一轮失败的 `turn/end`**（`reason.kind === "error"`）
	 * 被当成刚发生的事重放 —— 现象极具误导性：
	 * **回答念出来了，界面却同时挂着一条陈年报错**，而且每次刷新页面都复现。
	 *
	 * 实测证据（`__xfvDebug.hydration()` + `fails()`）：
	 * `bindEntryCount:0`、`cursorAtBind:-1`、绑定后 84ms 触发 `fail()`，
	 * 而 `prompt()` 的原始返回是 `{"ok":true,"value":{"accepted":true}}` —— 提交本身成功。
	 *
	 * ## 改用事件自带的 `time` 当前置地板
	 *
	 * 每条事件都有服务端时间戳（`{ type, seq, time, data }`），它**不受水合时机影响**：
	 * 历史事件的 `time` 一律远早于我们绑定的时刻，新事件一律晚于。
	 * 所以判据是：
	 *
	 * ```
	 * time < boundAt - HISTORY_SKEW_MS  →  历史回放：只推进游标，不触发回调
	 * ```
	 *
	 * ## 这套判据的适用前提（重要）
	 *
	 * 它依赖「浏览器时钟 ≈ 服务端时钟」。设 δ = 浏览器时钟 − 服务端时钟：
	 *
	 * | 情形 | 结果 |
	 * |---|---|
	 * | `δ ≈ 0`（本机 / 同机部署） | 正确：历史被拦、新事件放行 |
	 * | `δ > +2s`（浏览器偏快） | **新事件也会被当历史拦掉** |
	 * | `δ < 0`（浏览器偏慢） | 历史可能漏放（不会漏掉新事件） |
	 *
	 * 本插件面向的是**同机部署**（`127.0.0.1:3080`，浏览器与服务在同一台机器，
	 * δ 基本为 0），所以取 2s 余量足够。两处保险：
	 * ① seq 水位线仍然生效 —— 窗口在绑定时已就绪（非本机首次加载之外的多数情形）
	 * 时由它兜住，时间地板只是补"窗口为空"那个缺口；
	 * ② 若真要用于远程访问且两端时钟差很大，应把 `HISTORY_SKEW_MS` 调大，
	 * 或改为由服务端下发"水合完成"标记（见第九节升级路线）。
	 *
	 * 兜底：若某个旧 `turn/start`…`turn/end` 整段因时钟差漏放，
	 * 它同样是**完整**漏放，`turnText` 非空 → 会念出陈年回答。
	 * 也就是说本机制**防的是"历史整批涌入"，防不了时钟严重错位** ——
	 * 后者属于环境问题，不该用逻辑去猜。
	 *
	 * @param binding - 会话绑定。
	 */
	bindEvents(binding) {
		const source = binding.eventSource;
		if (!source || typeof source.subscribe !== "function") return;

		// 先取水位线，再做订阅：两次调用之间到达的事件会被下一次回调看到。
		const initial = source.getSnapshot();
		const initialEntries = initial?.entries ?? [];
		this.cursor = maxSeq(initialEntries, NO_SEQ);
		this.turnText = "";
		// 诊断留痕：绑定时窗口里有没有东西，决定了水位线可不可信。
		this.boundAt = Date.now();
		this.bindEntryCount = countEvents(initialEntries);
		// ## 需求②：持久化水位
		//
		// 窗口为空时 `this.cursor` 是 −1，随后历史整批灌入；那道时间地板
		// （`floorTime`）对**没有 `time` 字段的事件**是**放行**的
		// （`if (time !== null && time < floorTime)`，`time` 为 null 就不判）。
		// 于是没有时间戳的历史会被当新事件处理，助手把旧回答又念一遍。
		//
		// `seq` 是**按会话单调的整数**，天生跨刷新可比 —— 比时间戳硬得多。
		// 这里从持久化水位里取"上回处理到哪"，取它和窗口最大 seq 的较大值：
		// 窗口里有内容时用它（更可信），窗口为空时靠持久化记录兜住。
		const savedSeq = this.seqWatermark?.read(this.sessionId);
		if (Number.isFinite(savedSeq) && savedSeq > this.cursor) {
			this.cursor = savedSeq;
			this.savedCursorUsed = savedSeq;
		} else {
			this.savedCursorUsed = null;
		}
		this.cursorAtBind = this.cursor;
		/** 历史回放的时间地板（见方法注释）。 */
		this.floorTime = this.boundAt - HISTORY_SKEW_MS;
		/** 被判定为历史回放而拦下的事件数（诊断用）。 */
		this.skippedHistory = 0;

		this.unsubscribe = source.subscribe(() => {
			const snapshot = source.getSnapshot();
			const entries = snapshot?.entries ?? [];
			for (const entry of entries) {
				if (entry === null || typeof entry !== "object") continue;
				if (entry.type !== "event") continue;
				const event = entry.event;
				const seq = typeof event?.seq === "number" ? event.seq : null;
				if (seq !== null && seq <= this.cursor) continue;
				// 历史回放：推进游标（避免反复评估）但不触发回调。
				const time = typeof event?.time === "number" ? event.time : null;
				if (time !== null && time < this.floorTime) {
					this.skippedHistory += 1;
					this.advanceCursor(seq);
					continue;
				}
				// ## 需求②：没有时间戳的事件不能默认放行
				//
				// 旧实现只判 `time !== null`，于是 `time` 缺失的事件**直接放行**
				// （见上面那句 `time !== null && …`）。刷新时代价是水位归零、
				// 历史整批灌入，其中的无时间戳事件会被当成新事件念出来 ——
				// 表现就是"前面汇报过的内容再打开又播一遍"。
				//
				// 绑定时刻已有一批历史（`bindEntryCount > 0`）说明窗口是
				// "带着历史"进来的：这时 `seq <= cursorAtBind` 的一律算历史。
				// 反过来窗口为空（本机首次加载）时不能这么判 —— 那时后续
				// 整批灌入的都是要处理的新事件。
				if (time === null && this.bindEntryCount > 0 && seq !== null && seq <= this.cursorAtBind) {
					this.skippedHistory += 1;
					this.advanceCursor(seq);
					continue;
				}
				this.advanceCursor(seq);
				this.handleEvent(event);
			}
		});
	}

	/**
	 * 推进事件水位（需求②：落持久化，让"处理到哪"跨刷新有效）。
	 * @param seq - 事件序号（`null` = 该事件没有 seq，忽略）。
	 */
	advanceCursor(seq) {
		if (seq === null || !Number.isFinite(seq) || seq <= this.cursor) return;
		this.cursor = seq;
		// 落盘失败只是丢持久化，不该影响本轮处理（`write` 内部只前进不后退）。
		try {
			this.seqWatermark?.write(this.sessionId, seq);
		} catch {
			// 存储不可用：退化成旧的"仅内存"行为，不抛。
		}
	}

	/**
	 * 处理单个会话事件。
	 *
	 * ## 负载在 `data` 里（实测踩坑）
	 *
	 * DSH 的会话事件形状是 `{ type, seq, time, data }` —— **业务字段全在
	 * `data` 下**，顶层只有 type/seq/time。早期版本按扁平结构读
	 * （`event.turn` / `event.reason` / `event.message`），结果全部拿到
	 * `undefined`：turn 边界照常触发（type 是对的）但 reason 永远为空、
	 * assistant 文本永远是空串 —— 现象是"回答念不出来"却又"看不出哪里错"。
	 *
	 * 这里统一先解一层 `data`，同时**兼容扁平形态**（老版本/测试桩），
	 * 免得把已有桩件全打翻。
	 *
	 * @param event - 会话事件。
	 */
	handleEvent(event) {
		if (event === null || typeof event !== "object") return;
		const payload = event.data !== null && typeof event.data === "object" ? event.data : event;
		// 提问旁听走**同一条事件流**（在 switch 之前，因为它与 turn 边界正交：
		// `tool/call` 发生在 turn 中间，不该等 turn 结束才处理）。
		//
		// 为什么必须从这里读、而不是只订阅 `userQuestions` 投影：
		// 投影对 `tool/call` 先判 `fold.timed`，而 `timed` 由 tool schema
		// 是否声明 `timeout` 决定；`dsh-tool-ask-user` 默认 `mode: legacy`
		// → **投影恒空**。原始事件流没有这道闸门。详见 questions.js 顶部。
		if (event.type === "tool/call") this.onQuestionCall(event);
		switch (event.type) {
			case "turn/start":
				this.turnText = "";
				this.onTurnStart({ turn: payload.turn });
				break;
			case "assistant/message": {
				// 每个 step 一条 assistant/message；取**最后一条**作为本 turn 的回答，
				// 因为多步任务里真正给用户看的结论在最后。
				// assistantTextOf 自己兼容 {data:{message}} 与 {message} 两种形态。
				const text = assistantTextOf(event);
				if (text.trim() !== "") this.turnText = text;
				break;
			}
			case "turn/end":
				this.onTurnEnd({ turn: payload.turn, reason: payload.reason, text: this.turnText });
				this.turnText = "";
				break;
			default:
				break;
		}
	}

	/**
	 * 把一句（已润色的）指令送进会话。
	 *
	 * @param text - 指令文本。
	 * @param mode - `"queue"`（默认，开新 turn）或 `"steer"`（插进正在跑的 turn）。
	 * @returns 是否被宿主接受。
	 */
	async ask(text, mode = "queue") {
		// 常驻 / 切换模式下都不自动打开 UI：语音就是"不占会话"的使用方式；
		// 想看记录可以自己点开（dedicated 模式仍自动打开，沿用旧行为）。
		const binding = await this.ensure({ open: this.mode === "dedicated" });
		if (binding === null) return false;
		const content = String(text ?? "").trim();
		if (content === "") return false;
		try {
			const result = await binding.session.prompt([{ type: "text", text: content }], mode);
			this.recordPrompt(mode, content, result, null);
			if (result !== null && typeof result === "object" && result.ok === false) {
				const failure = result.error ?? {};
				throw new Error(String(failure.message ?? failure.code ?? "prompt-rejected"));
			}
			return true;
		} catch (error) {
			this.recordPrompt(mode, content, undefined, error);
			warn(mode === "steer" ? "插话提交失败" : "指令提交失败", error);
			this.onError(error instanceof Error ? error : new Error(String(error)));
			return false;
		}
	}

	/**
	 * 记一条 `prompt()` 的原始结果。
	 * @param mode - `queue` | `steer`。
	 * @param content - 提交的文本。
	 * @param result - `prompt()` 的原始返回（异常时为 `undefined`）。
	 * @param error - 抛出的异常，或 `null`。
	 */
	recordPrompt(mode, content, result, error) {
		this.promptLog.push({
			at: Date.now(),
			mode,
			text: content.slice(0, 80),
			ok: error === null ? result?.ok ?? "(非对象)" : "(throws)",
			error: error === null ? undefined : String(error?.message ?? error),
			raw: error === null ? safeJson(result) : undefined,
		});
		if (this.promptLog.length > 8) this.promptLog.shift();
	}

	/**
	 * 思考中插话纠偏：steer 进正在运行的 turn（agent 在下一个 step 边界消费）。
	 * @param text - 纠偏文本。
	 * @returns 是否被接受。
	 */
	async steer(text) {
		return this.ask(text, "steer");
	}

	/** 中断当前 turn（用户说"停"或点击打断时用）。 */
	async cancel() {
		if (this.binding === null) return;
		try {
			await this.binding.session.cancel();
		} catch (error) {
			warn("取消失败", error);
		}
	}

	/** 释放引用与订阅。 */
	dispose() {
		if (typeof this.unsubscribe === "function") {
			try {
				this.unsubscribe();
			} catch {
				// 已经释放。
			}
			this.unsubscribe = null;
		}
		if (this.reference !== null) {
			try {
				this.reference.release();
			} catch (error) {
				warn("释放会话引用失败", error);
			}
			this.reference = null;
		}
		this.binding = null;
	}
}

/**
 * 取事件窗口里最大的 seq。
 * @param entries - `SessionEventLikeEntry[]`。
 * @param fallback - 无 seq 时的兜底。
 */
function maxSeq(entries, fallback) {
	let max = fallback;
	for (const entry of entries) {
		if (entry === null || typeof entry !== "object" || entry.type !== "event") continue;
		const seq = entry.event?.seq;
		if (typeof seq === "number" && seq > max) max = seq;
	}
	return max;
}

/**
 * 数一数窗口里有多少条真正的事件（诊断用）。
 * @param entries - 事件窗口条目。
 * @returns 事件条数。
 */
function countEvents(entries) {
	let total = 0;
	for (const entry of entries) {
		if (entry !== null && typeof entry === "object" && entry.type === "event") total += 1;
	}
	return total;
}

/**
 * 安全序列化（用于诊断日志，任何异常都不该影响主链路）。
 * @param value - 任意值。
 * @returns 截断后的 JSON 字符串。
 */
function safeJson(value) {
	if (value === undefined) return "(undefined)";
	try {
		const text = JSON.stringify(value);
		return typeof text === "string" ? text.slice(0, 400) : String(value);
	} catch {
		return "(unserializable)";
	}
}
