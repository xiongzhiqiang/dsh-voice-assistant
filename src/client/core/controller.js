/**
 * 语音控制器：把状态机、识别引擎、播报器、会话桥接成一条闭环。
 *
 * ## 一条指令的完整生命周期
 *
 * ```
 * 待机 ──「小凤」──▶ 已唤醒（提示音）
 *                     │
 *                     ├─ 听到指令 ─▶ 润色(宿主) ─▶ 写入会话 ─▶ 思考中
 *                     │                                        │
 *                     └─ 12s 无话 ─▶ 待机                       ▼
 *                                                          播报中（麦克风关闭）
 *                                                              │
 *                                            播完 ─▶ 正在听（接着能说，不必再唤醒）
 *                                                              │
 *                                                    60s 无语音 ─▶ 休眠
 * ```
 *
 * 注意**播报不归"思考"**：`thinking` 是"指令已进会话、等 agent 回话"，
 * 一旦有回答落地就转 `speaking`。播完落到 `active` —— 助手说完就直接进入
 * 可续话的听写态，用户接着说话即可（含"不对，我是说…"这类纠正）。
 * 收尾交给 `active` 里的**休眠计时**（默认 60s 无语音）：这样"播报完没有
 * 语音输入 60 秒才休眠"这条需求才成立。
 *
 * 历史：播完曾经落到 `standby`，而 `standby` **不参与**休眠计时 ——
 * 于是每答完一轮都得重新喊「小凤」，多轮对话被硬切成一句一唤醒。
 * 见 `machine.js` 顶部对这一格的长注释。
 *
 * 休眠期间唯一的入向信号是**会话事件**：agent 跑完一轮（`turn/end`）就播报，
 * 实现需求 5 的"被 agent 消息唤醒后播报"。这一点不依赖麦克风，
 * 所以休眠真的可以关掉音频设备。
 *
 * V1.3 起多一条入向信号：**worker 汇报**。小凤路由到专家后留在根会话，只把
 * 任务交给 `/delegate`；专家完成后由宿主汇总要点入队，客户端经 `/reports`
 * 按完成先后逐条播报。全过程不切会话、不旁听中间输出。
 *
 * ## 三个必须守住的约束
 *
 * 1. **播报时关麦**。不关的话，TTS 的声音会被自己识别回去，
 *    形成"自问自答"的死循环 —— 这是语音助手最经典的翻车方式。
 * 2. **每次开口都重置休眠计时**。否则用户连续对话到第 59 秒，
 *    助手会在对方说到一半时睡过去。
 * 3. **late result 必须丢弃**。识别是流式的，回调可能在状态已切换
 *    （例如已进入 thinking）之后才到达；用 `epoch` 计数丢弃跨代结果，
 *    否则会出现"上一句被当成新指令又发一遍"。
 */
import { EVENTS, STATES, STATE_LABEL, WAKE_GRACE_MS, ECHO_GUARD_MS, SILENCE_SUBMIT_MS } from "./constants.js";
import { VoiceMachine } from "./machine.js";
import { findWake } from "./wakeword.js";
import { Speaker } from "./tts.js";
import { VoiceSession } from "./session.js";
import { TurnGate } from "./turn.js";
import { EchoGuard } from "./echo.js";
import { QuestionBridge, matchAnswer, speakQuestion } from "./questions.js";
import { playChime, unlockAudio } from "./chime.js";
import { createPlaybackLedger, createSeqWatermark, withinCatchup } from "./ledger.js";
import {
	polish, route, delegate, reports as fetchReports, interactions as fetchInteractions,
	listExperts, addExpert, removeExpert,
	listSessions, createSession, switchSession, closeSession,
	log, warn,
} from "./runtime.js";
import { parseExpertCommand, formatCommandSpeech, parseSessionCommand, formatSessionSpeech } from "./expert-commands.js";
import { WebSpeechEngine, isAvailable as webSpeechAvailable } from "./engines/webspeech.js";
import { HttpAsrEngine, isAvailable as httpAsrAvailable } from "./engines/http.js";
import { makeEarsRecognizer, probeEars } from "./engines/ears.js";
import { makeSpeechRecognizer, probeSpeech, SPEECH_LANGUAGES } from "./engines/speech.js";
import { readPreference, writePreference, normalizePreference } from "./asr-preference.js";

/** 通知在界面上停留的时长（毫秒）。 */
const NOTICE_TTL_MS = 4200;

/** 语音历史保留条数（HUD 只显示最近几条）。 */
const HISTORY_LIMIT = 4;

/** 语音控制器。 */
export class VoiceController {
	/**
	 * @param options - `{ ctx, config, fromHost }`。
	 */
	constructor(options) {
		this.ctx = options.ctx;
		this.config = options.config;
		this.fromHost = options.fromHost === true;

		/**
		 * 用户在 UI 里选的 ASR 偏好（`{ engine, language, manual }`）。
		 *
		 * `manual=true` 表示用户明确选过 —— 这一选择**优先于配置文件**，
		 * 刷新后从 localStorage 恢复。但"自动降级链"仍在：手动选的引擎若
		 * 运行时失败，照样按死名单回退到其它可用引擎（见 fail()）。
		 *
		 * ⚠️ 必须在 `createEngine()` 之前读：配置若强制 `sensevoice`，
		 * 引擎构造时就要取 `asrPreference.language`。曾在 V2.1 把它放在
		 * 构造函数末尾，结果首帧 `this.asrPreference` 还是 undefined，
		 * `Cannot read properties of undefined (reading 'language')`
		 * 直接让整个语音球装配失败（界面上看就是"卡通不见了"）。
		 */
		this.asrPreference = readPreference();
		if (this.asrPreference.manual === true) {
			// 用户选过 sensevoice 时语言一并带过来；其它引擎语言不影响。
			this.config = { ...this.config, asr: { ...this.config.asr, engine: this.asrPreference.engine } };
		}

		this.machine = new VoiceMachine(STATES.OFF);
		this.listeners = new Set();
		this.generation = 0;

		this.snapshot = {
			status: STATES.OFF,
			label: STATE_LABEL[STATES.OFF],
			partial: "",
			heard: "",
			answer: "",
			notice: "",
			noticeKind: "info",
			history: [],
			powered: false,
			engine: this.pickEngineName(),
			sessionId: null,
			polishVia: "",
			/** 两层架构：本条指令路由给了哪位 worker（空 = 未路由/路由失败）。 */
			routedWorker: "",
			routeVia: "",
			/**
			 * V2.3（需求④）：最近一次派单的**任务归属**结果。
			 * `lastTaskTitle` 是那条任务的名称（老任务用它的原名、新任务用新起的
			 * 任务名）；`lastTaskCreated` 为真表示这次开了新任务/新会话。
			 * 面板据此显示"接着老任务"还是"新开任务" —— 这是用户判断
			 * "为什么又多了个会话"的唯一可见线索。
			 */
			lastTaskTitle: "",
			lastTaskCreated: false,
			/**
			 * V1.3 委托汇报 / 需求④互动：当前已派给 worker、还在后台执行的任务数（界面显示"处理中"）。
			 */
			pendingDelegations: 0,
			/** 最近一条互动播报（HUD 显示用；三类共用这一条摘要）。 */
			lastReport: "",
			/** 最近一条互动的类型（`approval` / `question` / `report`；空 = 还没有）。 */
			lastInteractionKind: "",
			error: "",
			/** 已攒下、尚未提交的整轮发言（界面显示"听到（待提交）"）。 */
			pending: "",
			/** 本次静音计时的截止时刻（毫秒时间戳），`null` = 没有在计。 */
			pendingDueAt: null,
			/**
			 * 语音指令当前会进哪个会话（跨会话功能的唯一关键信息）。
			 *
			 * 为什么入快照而不是让 UI 现算：`describe()` 要读会话投影并做
			 * 标题查找，每次渲染都调一遍纯属浪费；而且切换后必须**主动**
			 * 推一次，UI 才知道要重渲染。跟着 `patch()` 走天然有这两点。
			 */
			sessionTarget: { mode: "", label: "尚未建立", id: null },
			/**
			 * 当前正等着用户语音作答的问题（没有则为 `null`）。
			 *
			 * 形状 `{ callId, state, spoken, questions }`：
			 *   - `state` 为 `open` / `continued`；只有 `continued` 能语音作答
			 *     （`open` 期界面问题卡还在，用户能直接点）；
			 *   - `spoken` 是念出来的那句原文，界面显示用（用户不一定听清）。
			 *
			 * 为什么入快照而不是让 UI 现算：问答桥是**回调驱动**的，
			 * UI 只有拿到一次推送才知道"现在有条问题在等答"。
			 */
			question: null,
		};

		/**
		 * 播报账本（需求②）：持久化"已播到哪个时间点" + "哪些内容播过了"。
		 *
		 * ## 为什么必须有它
		 *
		 * 刷新页面会把内存里的水位全部清零，而服务端队列活在宿主进程里
		 * 不受刷新影响 —— 两条合起来就是"用户每刷新一次，就再听一遍旧汇报"。
		 *
		 * 账本做两件事：
		 *   1. 记住毫秒水位（`cursor`），刷新后从它续上，不再靠 `latest` 猜；
		 *   2. 记住已播内容的身份（`kind:key`），同一条**无论走哪条通道、
		 *      被投递几次，一辈子只播一次**（这是兜底，比水位更硬）。
		 *
		 * 作用域按常驻会话 id 隔离：多个 DSH 实例共用同一个 origin 时，
		 * 各自的账本不会互相污染。
		 *
		 * **必须在 `questions` / `session` 之前建好**：提问旁听桥要拿它做
		 * "这个问题念过没有"的跨刷新判定。晚一步就是 `undefined`。
		 */
		this.ledger = createPlaybackLedger({ scope: this.config.agent?.sessionId ?? "default" });
		/**
		 * 会话 `seq` 水位（需求②的另一半）。
		 *
		 * 会话事件的去重靠 `seq`，而 `seq` 原先只在内存。刷新时代价是
		 * "窗口为空 → 水位 −1 → 历史整批灌入"，只剩时间地板兜着；
		 * 而时间地板对**没有 `time` 字段的事件**是放行的。
		 * `seq` 是单调整数、天生跨刷新可比，比时间戳硬得多。
		 */
		this.seqWatermark = createSeqWatermark();

		// ── 轮次门槛与回声抑制 ──────────────────────────────────────────
		//
		// 必须在 `engine` / `speaker` / `session` **之前**建好：它们注册的
		// 回调（识别结果、播报结束、会话事件）都可能同步触发状态迁移，
		// 而迁移处理里会用到这两个对象。晚建一步就是"偶发未定义"。
		//
		// 识别引擎给的是**片段**（900ms / 700ms 静音就切一段），片段不等于
		// "用户说完了"。要求是「声音停止足够久才算一轮」，所以中间加一道
		// 门槛：片段先攒着，静音到点（或手动 / 硬上限）才提交一次。
		// 中途文本照常显示在界面上，只是不提交。
		const turn = this.config.turn ?? {};
		this.turnGate = new TurnGate({
			silenceMs: Number.isFinite(turn.silenceMs) ? turn.silenceMs : SILENCE_SUBMIT_MS,
			maxTurnMs: turn.maxTurnMs,
			onCommit: (payload) => this.handleTurnCommit(payload),
		});

		// 播报时关麦只覆盖"播报期间"，而回声常出现在 `onend` 之后的那几百
		// 毫秒里。再补一道文本级防线：识别到的话若就是助手刚说的，丢掉。
		this.echoGuard = new EchoGuard();

		/**
		 * 内置识别的接线选择（`local` = 项目自有实现，`remote` = 旧插件兜底）。
		 *
		 * ⚠️ 必须在 `createEngine()` **之前**初始化：引擎里的 recognizer 会在
		 * 识别时读这两个字段。曾在 V2.1 把它们放在构造函数末尾，首帧
		 * `createEngine()` 时还是 undefined → recognizer 快照成 `remote`
		 * → 即使探测异步改成 `local` 也不生效 → 说话时报 speech-unavailable。
		 * 默认 `local`：V2.1 内置优先，remote 只在旧装配兜底时才用。
		 */
		this.earsVia = "local";
		this.speechVia = "local";

		this.engine = this.createEngine();
		this.speaker = new Speaker({
			getConfig: () => this.config,
			onChunk: (chunk) => {
				// 播报中的当前句显示在 HUD 上，用户能对上"现在念到哪"。
				this.patch({ partial: chunk });
			},
		});

		// ── 提问旁听（只做「模型提问」，不碰「工具审批」）─────────────────
		//
		// 必须在 `session` **之前**建好：`VoiceSession` 绑定成功后会在
		// `onStatus` 里回调，而那里要把 binding 交给问答桥接投影；同时
		// 会话桥的事件回调（`onQuestionCall`）也直接打到桥上。
		//
		// 为什么不注册应答者：DSH 的 `approval/request` / `user-questions/request`
		// 是 waterfall，官方 README 明说「同级监听器顺序**不是**策略优先级机制」
		// —— 并列注册无法保证排在官方 UI 之后，一旦提前就会把本该显示在界面上的
		// 问题抢走。详见 questions.js 顶部的长注释。
		//
		// 所以这里只**旁听**：主路径是原始事件流的 `tool/call`（不受 `timed`
		// 闸门限制），辅以 `userQuestions` 投影拿权威 state；作答走
		// `remote.userQuestions.answer` 的 `continued` 通道。
		this.questions = new QuestionBridge({
			ctx: this.ctx,
			// 需求②：提问播报也走同一份持久账本，否则「刷新后投影重放同一个
			// active 问题」会再念一遍（`announced` 是内存态）。共用一份账本
			// 还有个好处：身份空间按下述前缀区分（`question:` / `report:` /
			// 审批 id），不会互相顶掉。
			ledger: this.ledger,
			onQuestion: (payload) => this.handleQuestion(payload),
			onResolved: () => this.patch({ question: null }),
			log: (message) => log(message),
			warn: (message, detail) => warn(message, detail),
		});

		this.session = new VoiceSession({
			ctx: this.ctx,
			config: this.config,
			// 需求②：把会话 seq 水位也落持久化（刷新后不再靠时间戳猜历史）。
			seqWatermark: this.seqWatermark,
			onTurnStart: () => this.handleTurnStart(),
			onTurnEnd: (payload) => this.handleTurnEnd(payload),
			// 提问旁听**主路径**：原始事件流的 `tool/call`。
			// 之所以从这里接而不是只订阅投影：投影对 legacy 模式恒空
			// （`projection.js` 的 `if (!fold.timed) return fold`），
			// 而本机默认就是 legacy。详见 questions.js 顶部。
			onQuestionCall: (event) => this.questions.observeEvent(event),
			onStatus: (event) => {
				if (event?.kind === "session-ready") this.patch({ sessionId: event.sessionId });
				// 会话换绑（切换/新建/回常驻）都要刷新"现在说的话进哪儿"。
				// 放在 onStatus 里而不是各调用点：`session.js` 是所有换绑路径的
				// 唯一出口，在这里同步一次就不会漏（漏了的表现是面板显示的还是
				// 上一个会话，用户照着界面判断就会搞错目标）。
				if (
					event?.kind === "session-ready" ||
					event?.kind === "session-switched" ||
					event?.kind === "session-created"
				) {
					this.patch({ sessionTarget: this.session.describe() });
					// 问答桥的投影是**按会话**的：换会话必须换绑定，否则会念出
					// 上一个会话的问题（那个会话的用户根本没在等这条）。
					this.attachQuestions();
				}
			},
			onError: (error) => this.fail(error),
		});

		this.idleTimer = null;
		this.noticeTimer = null;
		this.echoTimer = null;
		this.disposed = false;
		/**
		 * 需求④统一互动流：审批 / 提问 / 汇报按 `at`（发生时间）排队，逐条播报。
		 *
		 * `interactionCursor` 是服务端的 monotonic 时间戳游标：首帧传
		 * `"latest"` 只同步不重放；之后只取 `at > cursor` 的新条目。
		 */
		this.interactionCursor = undefined;
		this.interactionQueue = [];
		this.interactionDraining = false;
		/**
		 * 统一互动流是否可用。
		 *
		 * 初始 `false`：`pollReports` 据此决定要不要走**旧的 `/reports` 口径**
		 * （老宿主没有 `/interactions`）。第一次成功拉到互动流就置真，此后
		 * `/reports` 完全不再播报 —— 否则宿主同时写两条流会造成同一条念两遍。
		 */
		this.interactionsAvailable = false;
		/** 旧的 `/reports` 游标（仅在统一流不可用时使用）。 */
		this.reportCursor = undefined;
		this.reportTimer = null;
		this.lastReportText = "";
		/**
		 * 是否已经跟服务端对齐过水位（首帧 `latest`）。
		 *
		 * 只对齐一次：之后靠**持久化账本**续上（见下），而不是每次启动
		 * 都退回到 `latest` —— 那正是"重开又播一遍"的成因之一。
		 */
		this.cursorSeeded = false;
		/**
		 * 在这台机器上**已确认不可用**的引擎名。
		 *
		 * 为什么需要这个集合：`engineUsable()` 只能测"浏览器有没有这个 API /
		 * 有没有填端点"，测不出"服务端到底通不通"。浏览器识别恰恰是"API 在、
		 * 服务不通"的典型（它依赖境外云端）。踩过一次的坑不该踩第二次 ——
		 * 记录在案，回退时跳过。
		 */
		this.deadEngines = new Set();
		/**
		 * `detectEars()` 的探测结论（`null` = 还没探过）。
		 *
		 * 记下来是因为回退时需要一个**确定的**答案：`ears` 能不能用无法靠
		 * 本地判据得出（要打一次远程），而"未探过"与"探过、不可用"必须分开 ——
		 * 前者可以试，后者不该再试。
		 */
		this.earsAvailable = null;
		// `earsVia` 已在 createEngine() 之前初始化（见构造函数开头），此处不再重复赋值。
		/**
		 * dsh-ears 当前后端是否要求**浏览器归一化后的 16 kHz PCM16 WAV**。
		 *
		 * 本地 Whisper 与腾讯/小米/火山三家的"录音文件识别"只吃 WAV，
		 * 而 `MediaRecorder` 产出的是 webm/opus。归一化的责任在**调用方**
		 * （`dsh-ears` 只在自己的录音按钮里做），所以本插件必须自己补。
		 * 具体判定见 `engines/ears.js` 的 `needsWavForEars()`。
		 *
		 * 存成字段而不是每次问远程：探测只跑一次，录音却每段都发生。
		 */
		this.earsNeedsWav = false;
		/** `detectEars()` 探到的后端清单（只读证据，供真机断言"哪家可用"）。 */
		this.earsBackends = [];
		/**
		 * `dsh-ears` 命名空间各条取法的命中情况（只读排障证据）。
		 *
		 * 为什么必须留：命名空间取不到时，`available:false` 这一个布尔
		 * **完全指不出方向** —— 是没装插件？还是装了但注册名不同？
		 * 还是被 cordis 的 inject 代理拦了？本项目反复栽在
		 * "状态快照查不出方向"上，所以把每条路径的命中情况摊开。
		 */
		this.earsPaths = [];
		/** ctx 的能力清单（排障"取不到命名空间"到底是没口、还是服务没上来"）。 */
		this.earsShape = null;

		/**
		 * DSH 官方 speech 识别（SenseVoice）的探测结论与语言清单。
		 *
		 * 与 dsh-ears 同为可选依赖：探测失败就标不可用，不影响其它引擎。
		 */
		this.speechAvailable = null;
		// `speechVia` 已在 createEngine() 之前初始化（见构造函数开头），此处不再重复赋值。
		this.speechLanguages = SPEECH_LANGUAGES.slice();
		this.speechPaths = [];

		/**
		 * 是否处于"刚唤醒、还没听到第一句话"。
		 *
		 * 决定 `armIdle()` 用哪个时限：等第一句用 `WAKE_GRACE_MS`（短），
		 * 对话中途用 `sleep.idleTimeoutMs`（长）。不能用"上一轮听到过什么"
		 * 来判断 —— 那个字段在上一轮结束时不清理，会把新唤醒误判成对话中途。
		 */
		this.awaitingFirstUtterance = false;
		/** 最近几次错误的调用来源（排障"念出来了却又报错"这种矛盾态）。 */
		this.failLog = [];
		/**
		 * 最近一次"把识别文本当回答"的判定（排障"为什么没答上"）。
		 *
		 * `tryAnswerQuestion()` 只返回布尔，于是**"没匹配上"与"匹配了但提交被拒"
		 * 在真机上看起来一模一样** —— 本项目反复踩这个坑（状态快照查不出方向）。
		 * 把判定摊成只读字段，真机冒烟就能断言到底断在哪一层。
		 */
		this.lastAnswerAttempt = null;

		this.machine.subscribe((to, from, event) => this.onTransition(to, from, event));

		// 异步探测 dsh-ears：可用就把识别后端交给它（复用本地 Whisper /
		// Groq / 阿里云 / 腾讯云等 8 个后端），不可用就保持浏览器识别。
		// 不 await：首帧必须立刻可渲染。
		this.detectEars().catch((error) => warn("dsh-ears 探测异常", error?.message ?? error));
		// 首探**极可能太早**（本插件 apply 早于 dsh-ears 挂服务，见 `watchEars`），
		// 所以必须挂一条"服务就位就接上"的路，否则本地 Whisper 配了也用不上。
		this.watchEars().catch((error) => warn("dsh-ears 就位等待异常", error?.message ?? error));
		// 官方 speech 识别同理（仅当 auto / 用户选了 sensevoice 时探测）。
		this.detectSpeech().catch((error) => warn("speech 探测异常", error?.message ?? error));
		this.watchSpeech().catch((error) => warn("speech 就位等待异常", error?.message ?? error));
	}

	/** ── 对外只读状态 ─────────────────────────────────────────────── */

	/** 取当前快照（供 `useSyncExternalStore` 使用，引用稳定）。 */
	getSnapshot() {
		return this.snapshot;
	}

	/**
	 * 订阅状态变化。
	 * @param listener - 无参回调。
	 * @returns 取消订阅。
	 */
	subscribe(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * 合并补丁到快照并广播。
	 * @param patch - 局部字段。
	 */
	patch(patch) {
		let changed = false;
		for (const key of Object.keys(patch)) {
			if (this.snapshot[key] !== patch[key]) {
				changed = true;
				break;
			}
		}
		if (!changed) return;
		this.snapshot = { ...this.snapshot, ...patch };
		for (const listener of this.listeners) {
			try {
				listener();
			} catch (error) {
				console.error("[小凤] 订阅者异常", error);
			}
		}
	}

	/** ── 引擎选择 ─────────────────────────────────────────────────── */

	/**
	 * 决定用哪条识别引擎（同步初判）。
	 *
	 * `auto` 的初判先给浏览器识别：它不需要任何异步探测，首帧就能报出
	 * 一个确定的名字。真正的"能不能用 dsh-ears"要等一次远程调用，
	 * 由 `detectEars()` 异步升级 —— 界面先显示"浏览器识别"再变
	 * "dsh-ears 转写"，比先显示"未就绪"再跳变自然得多。
	 */
	pickEngineName() {
		const preferred = this.config.asr.engine;
		if (preferred === "sensevoice") {
			// 官方 SenseVoice 是可选依赖，可用性靠异步探测。首帧先标 sensevoice，
			// 探测失败由 detectSpeech() 回退（同 ears 的处理）。
			return "sensevoice";
		}
		if (preferred === "ears") return "ears";
		if (preferred === "http") {
			if (this.config.asr.httpReady && httpAsrAvailable()) return "http";
			if (webSpeechAvailable()) return "webspeech-fallback";
			return "none";
		}
		if (preferred === "webspeech") return webSpeechAvailable() ? "webspeech" : "none";
		// auto
		if (webSpeechAvailable()) return "webspeech";
		if (this.config.asr.httpReady && httpAsrAvailable()) return "http-fallback";
		// 浏览器没有 Web Speech 但 dsh-ears 可能可用：先标 ears，探测失败再降级。
		return "ears";
	}

	/**
	 * 异步探测 dsh-ears，可用则把引擎升级为它。
	 *
	 * 这是本插件与 dsh-ears 的**唯一耦合点**：识别后端交给它，
	 * 唤醒/编排/播报留在本插件。探测失败静默降级，不打扰用户。
	 */
	/**
	 * 异步探测 dsh-ears，可用则把引擎升级为它。
	 *
	 * 这是本插件与 dsh-ears 的**唯一耦合点**：识别后端交给它，
	 * 唤醒/编排/播报留在本插件。探测失败静默降级，不打扰用户。
	 *
	 * @param options - `{ silent? }`：`silent` 为真时连"显式 ears 失败"
	 *   的提示也不发（重试路径用 —— 第一次已经提示过，重试再提示就是刷屏）。
	 */
	async detectEars(options = {}) {
		if (this.disposed) return;
		const preferred = this.config.asr.engine;
		// V2.1：两个后端都已内置，探测成本只是一次本地 GET，且 UI 的
		// Whisper 选项可用性**必须**如实显示（用户要能自主切换）。
		// 旧版这里按 `preferred` 门控，配置固定 sensevoice 时 Whisper
		// 永远探不到 → UI 标「未检测到」，明明模型就在项目里。
		// 探测与"是否切过去"是两件事：下面的 forced/webspeech 判据负责
		// 不抢引擎，这里只管把可用性查清楚。
		const probe = await probeEars(this.ctx);
		if (this.disposed) return;
		this.earsAvailable = probe.available === true;
		this.earsVia = probe.via === "local" ? "local" : "remote";
		this.earsNeedsWav = probe.needsWav === true;
		this.earsBackends = Array.isArray(probe.backends) ? probe.backends : [];
		this.earsPaths = Array.isArray(probe.paths) ? probe.paths : [];
		this.earsShape = probe.shape ?? null;
		if (!probe.available) {
			if (this.snapshot.engine === "ears") {
				// 回退要**跳过已确认不可用的引擎**。老写法是
				// `webSpeechAvailable() ? "webspeech" : …` —— 只看浏览器有没有
				// 这个 API，不看它能不能真的工作。受限网络下浏览器识别连不上
				// 云端，于是"从 ears 退回 webspeech"等于退回一个已知坏掉的引擎，
				// 用户再说话又是同一条报错。
				//
				// 判据统一交给 `engineUsable()`（它内部按**族**比对死名单，
				// 顺带覆盖 `webspeech-fallback` 这类别名）。
				const candidates = ["http", "http-fallback", "webspeech", "webspeech-fallback"];
				this.swapEngine(candidates.find((name) => this.engineUsable(name)) ?? "none");
			}
			if (preferred === "ears" && options.silent !== true) {
				// 提示必须**在回退之后**发、并按**实际落点**措辞。
				// 老写法写死"已退回浏览器识别"，而回退目标可能是 `http` 或
				// `none`（浏览器识别不可用时）—— 那就成了一句假话，
				// 而且用户会照着它去排查一个根本不存在的引擎。
				const actual = this.snapshot.engine;
				this.notice(
					actual === "none"
						? "没有检测到可用的本地 Whisper 识别后端，且没有其它可用引擎。请在设置里配置 ASR。"
						: `没有检测到可用的本地 Whisper 识别后端，已退回「${this.engineLabel(actual)}」。`,
					"warn",
				);
			}
			return;
		}

		// ── 什么时候才把识别交给 dsh-ears ───────────────────────────────
		//
		// ⚠️ 这里曾是无条件 `swapEngine("ears")`。后果是**识别质量大幅下降**：
		// 本机 dsh-ears 的后端是本地 Whisper，而缓存里只有 6 档中最弱的
		// `ggml-tiny.bin`，且 `localWhisper.language` 默认空（自动检测对
		// 短片段极不可靠）⇒ 中文常被识别成英文/西语，并伴随 Whisper 专有幻觉
		// （`[BLANK_AUDIO]`、`（滋滋声）`、`（音乐）`、`[Subscribe]` 等）。
		//
		// 加"无条件"三个字是关键：`pickEngineName()` 明明**已经**选了
		// `webspeech`，但这一步只要探测到 dsh-ears 就把它顶掉 —— 于是浏览器
		// 识别**永远拿不到麦克风**，更新、更准的那条路被一条从没被验证过
		// 质量的路盖掉。
		//
		// 判据改为**只有浏览器识别不可用时才升级**：
		//   * `engine: 'ears'` —— 用户显式指定，那是他的选择，照办；
		//   * `engine: 'auto'` —— 浏览器识别优先（零配置，中文识别质量在
		//     网络可用时明显更好）。只有它被确认不可用（`deadEngines`）或
		//     浏览器根本没有这个 API 时，才轮到 dsh-ears。
		//
		// 这样两条都不丢：**网络可用时用更准的浏览器识别；受限网络下仍会
		// 自动退到本地 Whisper**（`asr-unreachable` → 死名单 → 回退）。
		const forced = preferred === "ears";
		// 探测无条件做（UI 要如实标注可用性），但**切换**必须尊重偏好：
		// 用户选了 sensevoice / webspeech / http 时，本地 Whisper 再可用
		// 也只记 availability，绝不顶掉他选的引擎。
		if (preferred !== "auto" && !forced) {
			log(`当前偏好 ${preferred}，只记录 Whisper 可用性，不切换引擎`);
			return;
		}
		if (!forced && this.snapshot.engine !== "ears" && this.engineUsable("webspeech")) {
			log("浏览器识别可用（auto 模式优先），不切到 dsh-ears");
			return;
		}
		this.swapEngine("ears");
	}

	/**
	 * 探测 DSH 官方 speech 识别（SenseVoice）。
	 *
	 * 与 dsh-ears 一样是可选依赖。职责边界：
	 *   - 只记录可用性 / 语言清单，供 UI 展示与回退判定；
	 *   - 仅当当前引擎是 `sensevoice` **且探测确认不可用**时，才回退到别的引擎；
	 *   - 绝不主动把别的引擎顶掉（用户没选就不抢麦克风）。
	 *
	 * @param options - `{ silent? }`：为真时连失败提示也不发（重试路径用）。
	 */
	async detectSpeech(options = {}) {
		if (this.disposed) return;
		const preferred = this.config.asr.engine;
		// 与 detectEars 同理（V2.1）：内置后端的可用性必须无条件探测，
		// UI 才能如实标注两个选项；切引擎仍由下面的回退判据与
		// selectAsr() 决定，探测本身不会抢麦克风。
		const probe = await probeSpeech(this.ctx);
		if (this.disposed) return;
		this.speechAvailable = probe.available === true;
		this.speechVia = probe.via === "local" ? "local" : "remote";
		if (Array.isArray(probe.languages) && probe.languages.length > 0) this.speechLanguages = probe.languages.slice();
		this.speechPaths = Array.isArray(probe.paths) ? probe.paths : [];
		// 广播一次，让设置面板的可用性标记 / 语言下拉刷新（纯字段变更不会重渲染）。
		this.patch({ speechProbeAt: Date.now() });

		if (!probe.available) {
			if (this.snapshot.engine === "sensevoice") {
				const candidates = ["ears", "http", "http-fallback", "webspeech", "webspeech-fallback"];
				this.swapEngine(candidates.find((name) => this.engineUsable(name)) ?? "none");
			}
			if (preferred === "sensevoice" && options.silent !== true) {
				const actual = this.snapshot.engine;
				this.notice(
					actual === "none"
						? "没有检测到内置 SenseVoice 识别，且没有其它可用引擎。"
						: `没有检测到内置 SenseVoice 识别，已退回「${this.engineLabel(actual)}」。`,
					"warn",
				);
			}
		}
	}

	/**
	 * 等服务就位后再探一次 speech（与 watchEars 同样的时序竞争问题）。
	 */
	async watchSpeech() {
		if (this.disposed) return;
		// V2.1：内置 API 无外部服务依赖，任何偏好下都允许重探，
		// 避免首探过早失败后 UI 永久标「未检测到」。切换由 detectSpeech 守门。
		if (this.speechAvailable === true) return;

		try {
			await this.ctx?.inject?.(["remote.speech"], () => {
				if (this.disposed || this.speechAvailable === true) return;
				log("speech 识别服务已就位，重新探测");
				this.detectSpeech({ silent: true }).catch((error) => warn("speech 重探异常", error?.message ?? error));
			});
		} catch (error) {
			warn("等待 speech 服务就位失败（改用重试兜底）", error?.message ?? error);
		}
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (this.disposed || this.speechAvailable === true) return;
			await new Promise((resolve) => setTimeout(resolve, 1500));
			if (this.disposed || this.speechAvailable === true) return;
			await this.detectSpeech({ silent: true });
		}
	}

	/**
	 * 用户在 UI 里选择识别引擎 / 语言。**即时切换 + 持久化**。
	 *
	 * 这是 UI 选择器唯一应该调用的入口：它同时更新偏好、落盘、切引擎，
	 * 保证"界面显示"与"实际生效"永远一致（分开做就会漂移）。
	 *
	 * @param engine - 引擎名（`auto` / `webspeech` / `ears` / `sensevoice` / `http`）。
	 * @param language - SenseVoice 语言提示（可选）。
	 * @returns 结果 `{ ok, engine, language, notice }`。
	 */
	selectAsr(engine, language) {
		const next = normalizePreference({
			engine,
			language: language ?? this.asrPreference.language,
			manual: true,
		});
		this.asrPreference = writePreference(next);
		// 让 config 也反映用户选择，detectEars/detectSpeech 的 preferred 判据才对。
		this.config = { ...this.config, asr: { ...this.config.asr, engine: next.engine } };

		const target = this.pickEngineName();
		this.swapEngine(target);
		// 新引擎可能是异步探测的可选依赖，立刻补一次探测（silent：选择场景
		// 不弹"没检测到"的警告，面板上的可用性标记已经足够表达）。
		if (target === "ears") this.detectEars({ silent: true }).catch(() => {});
		if (target === "sensevoice") this.detectSpeech({ silent: true }).catch(() => {});

		return { ok: true, engine: target, language: this.asrPreference.language };
	}

	/**
	 * 等服务就位后自动接上 dsh-ears（**事件驱动**，不是轮询）。
	 *
	 * ## 为什么必须有这一步
	 *
	 * 真机证据（tools/probe-local-ears.mjs）：本插件 `apply` 时探测
	 * `remote.dshEars` **取不到**，而 6 秒后重探**能取到** ——
	 * 是**时序竞争**：`dsh-ears` 的客户端 `apply` 是 `async`，
	 * 里面要 `await ctx.remote.$mount(TYPERT_REMOTE)` 才把服务挂上去，
	 * 而本插件的 `apply` 跑在它前面。
	 *
	 * 症状极具误导性：`ctx.get("remote.dshEars")` 返回 `undefined`，
	 * 看起来像"注册名写错了"，于是会去反复试各种名字（**我第一版就这么
	 * 白忙了一场**）。真实原因是"问得太早"。
	 *
	 * ## 为什么用 `ctx.inject` 而不是 `setTimeout` 重试
	 *
	 * `ctx.inject([name], cb)` 是 cordis 给的**就绪回调**：服务一旦注册，
	 * `cb` 立刻被调用；没装就永远不调用（不报错、不卡住）。
	 * 这正是 `dsh-ears` 自己的接法：
	 *
	 *     await ctx.inject(["slots", "locale", "remote.dshEars"], (c) => {
	 *         const earsRemote = c.remote.dshEars;
	 *     });
	 *
	 * 相比之下"定时重试"有三个坏处：慢（要么定得短、要么让用户干等）、
	 * 白跑（服务永远不会来时还一直试）、以及**无法区分**"还没来"与
	 * "根本没有"。就绪回调把这三件事一次说清。
	 *
	 * ## 为什么还要留一次重试
	 *
	 * `inject` 只保证"注册的那一刻"回调。若本插件加载时服务**早已**
	 * 注册好（热重载、或 dsh-ears 恰好先 apply），`inject` 会立即回调 ——
	 * 那是正常路径。真正需要兜底的是：某些 profile 里 `inject` 的
	 * 声明式等待**不触发**（本项目在精简 profile 上见过静默不回调）。
	 * 所以补一次短延迟重探，两条路取先到者。
	 */
	async watchEars() {
		if (this.disposed) return;
		// V2.1：同上——任何偏好下都允许重探 Whisper 可用性（UI 要如实标注）。
		// 是否切到 ears 由 detectEars 里的 preferred 判据守住，这里只催探测。
		if (this.snapshot.engine === "ears") return;
		const started = Date.now();

		// ① 就绪回调（正路）。
		try {
			await this.ctx?.inject?.(["remote.dshEars"], () => {
				if (this.disposed || this.earsAvailable === true) return;
				log(`local Whisper 服务已就位（等待 ${Date.now() - started} ms），重新探测`);
				this.detectEars({ silent: true }).catch((error) => warn("Whisper 重探异常", error?.message ?? error));
			});
		} catch (error) {
			// `inject` 在精简 profile 上可能不支持或抛错，不当致命。
			warn("等待 Whisper 服务就位失败（改用重试兜底）", error?.message ?? error);
		}

		// ② 重试兜底：等在途的 `apply` 收敛。
		//
		//    2 次、间隔 1.5s —— 够覆盖"应用还没 await 完"。V2.1 起终止条件
		//    改成 `earsAvailable === true`（可用性探到即可，不必等到切引擎），
		//    否则 preferred=sensevoice 时引擎永远不会变成 ears，循环白跑满。
		for (let attempt = 0; attempt < 2; attempt += 1) {
			if (this.disposed || this.earsAvailable === true) return;
			await new Promise((resolve) => setTimeout(resolve, 1500));
			if (this.disposed || this.earsAvailable === true) return;
			await this.detectEars({ silent: true });
			if (this.earsAvailable === true) return;
		}
	}

	/**
	 * 换引擎：保留"是否正在听"，换完立刻恢复监听。
	 * @param name - 引擎名。
	 */
	swapEngine(name) {
		if (this.snapshot.engine === name) return;
		const wasListening = this.engine.wanted === true;
		this.engine.stop();
		this.patch({ engine: name });
		this.engine = this.createEngine();
		if (wasListening) this.engine.start();
		log(`识别引擎切换为 ${name}`);
	}

	/** 按 `engine` 字段构造识别引擎。 */
	createEngine() {
		const name = this.snapshot?.engine ?? this.pickEngineName();
		const handlers = () => ({
			language: this.config.language,
			maxSegmentMs: this.config.asr.maxSegmentMs ?? 15000,
			onPartial: (text) => this.handlePartial(text),
			onFinal: (text) => this.handleFinal(text),
			onError: (error) => this.fail(error),
			onClose: () => {},
		});
		if (name === "ears") {
			// 复用 dsh-ears 的远程 transcribe：VAD 采集在本插件，识别在它那边。
			// `needsWav` 传函数而不是布尔值 —— 用户可能在会话中途去
			// dsh-ears 设置页换后端（例如从云端换成本地 Whisper）。
			return new HttpAsrEngine({
				...handlers(),
				recognize: makeEarsRecognizer(this.ctx, { needsWav: () => this.earsNeedsWav, via: () => this.earsVia }),
			});
		}
		if (name === "sensevoice") {
			// DSH 官方语音输入：remote `speech` → SenseVoice 本地识别。
			// 宿主侧 validateWave 只收 WAV，识别器内部会做归一化。
			return new HttpAsrEngine({
				...handlers(),
				recognize: makeSpeechRecognizer(this.ctx, { language: () => this.asrPreference.language, via: () => this.speechVia }),
			});
		}
		if (name === "http" || name === "http-fallback") return new HttpAsrEngine(handlers());
		return new WebSpeechEngine(handlers());
	}

	/** ── 生命周期 ─────────────────────────────────────────────────── */

	/**
	 * 启用语音（必须在用户手势的调用栈里被调用，否则浏览器不给麦克风、也不给出声）。
	 * @returns 是否成功进入待机。
	 */
	start() {
		unlockAudio();
		if (this.snapshot.engine === "none") {
			this.notice("当前浏览器既没有 Web Speech，也没有配置上游 ASR，无法启用语音。", "error");
			return false;
		}
		if (this.machine.get() !== STATES.OFF) return true;
		this.patch({ powered: true, error: "" });
		this.machine.send(EVENTS.START);
		// 若之前已有委托在途（例如休眠/停用期间提交的），恢复后继续取汇报。
		if (this.interactionQueue.length > 0 || this.snapshot.pendingDelegations > 0) {
			this.startReportPolling();
			this.pollReports();
			this.pollInteractions();
		}
		return true;
	}

	/** 停用语音：释放麦克风与音频（已在途的后台委托保留，重新启用后继续取汇报）。 */
	stop() {
		this.stopReportPolling();
		this.machine.send(EVENTS.STOP);
		this.patch({ powered: false, partial: "", heard: "", answer: "" });
	}

	/** 在启用/停用之间切换（给按钮用）。 */
	toggle() {
		if (this.machine.get() === STATES.OFF) this.start();
		else this.stop();
	}

	/**
	 * 手动唤醒（点击语音球 / 快捷键 / 提示音唤醒）。
	 *
	 * 休眠中走 `RESUME`（先回待机，再进听），未启用则先启用。
	 * 唤醒时播一声提示音 —— 这是"我听到了"的即时反馈，没有它用户会怀疑。
	 */
	wake() {
		unlockAudio();
		const status = this.machine.get();
		if (status === STATES.OFF) {
			this.start();
			return;
		}
		if (status === STATES.SLEEPING) {
			this.chime("wake");
			this.machine.send(EVENTS.RESUME);
			// 休眠唤醒后直接进入"听指令"，省掉用户再喊一次唤醒词。
			this.machine.send(EVENTS.WAKE);
			return;
		}
		if (status === STATES.STANDBY) {
			this.chime("wake");
			this.machine.send(EVENTS.WAKE);
			return;
		}
		// 已唤醒/思考/播报：再点一次表示"我要说话"，打断播报。
		this.speaker.cancel();
		this.machine.send(EVENTS.WAKE);
	}

	/** 进入休眠（用户手动 / 计时到点）。 */
	sleep() {
		if (this.machine.get() === STATES.SLEEPING) return;
		this.speaker.cancel();
		this.machine.send(EVENTS.SLEEP);
	}

	/** ── 状态迁移副作用 ───────────────────────────────────────────── */

	/**
	 * 状态迁移时统一处理音频设备与计时器。
	 * @param to - 新状态。
	 * @param from - 旧状态。
	 * @param event - 触发事件。
	 */
	onTransition(to, from, event) {
		this.patch({ status: to, label: STATE_LABEL[to] });
		// 每迁一次就换代：在途的识别/播报回调据此自废，避免跨代串台。
		this.generation += 1;

		if (to === STATES.SLEEPING) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
			clearTimeout(this.echoTimer);
			this.echoTimer = null;
			this.engine.stop();
			// 休眠时丢弃未提交的片段：用户已经离开了，攒着的话下次唤醒
			// 会被当成新指令一起提交（"你十分钟前说的话又发了一遍"）。
			this.turnGate.reset();
			this.echoGuard.reset();
			this.patch({ partial: "", pending: "", pendingDueAt: null });
			if (to !== from) this.chime("sleep");
			return;
		}

		if (to === STATES.OFF) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
			clearTimeout(this.echoTimer);
			this.echoTimer = null;
			this.turnGate.reset();
			this.echoGuard.reset();
			this.engine.stop();
			this.speaker.cancel();
			this.patch({ pending: "", pendingDueAt: null });
			return;
		}

		if (to === STATES.STANDBY) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
			// 回待机的成因之一是"唤醒后 12s 没听到话"（ACTIVE + IDLE）——
			// 这时若还攒着内容必须丢掉，否则会静静地留着，等下一次唤醒
			// 时和新的指令拼成一句莫名其妙的话。
			this.turnGate.reset();
			this.patch({ partial: "", pending: "", pendingDueAt: null });
			// 这里的 `from === SPEAKING` 在当前迁移表下**已不可达**
			// （`SPEAKING` 的 `SPEAK_END` / `WAKE` 都指向 `ACTIVE`，见 `machine.js`）
			// —— 保留它是防御性的：回声静默期本质上属于"从播报里出来"这个
			// 成因，将来若有人加回一条 `speaking → standby` 的迁移，这里必须
			// 跟着走 700ms 静默，否则外放余响会被当成唤醒词或新指令。
			if (from === STATES.SPEAKING) this.armEchoGuard();
			// 休眠时若配置了保留唤醒词，麦克风不关；否则这里重新开。
			else if (!this.engine.wanted) this.engine.start();
			return;
		}

		if (to === STATES.ACTIVE) {
			// 只有"重新开始听"时才清掉上一条回答；从**播报**过来不算 ——
			// 那是"刚念完、接着能听"，用户可能还在看/回味刚念的那句，
			// 清掉会让界面（与 `answer` 诊断线）在说完的瞬间把它抹掉。
			if (from !== STATES.SPEAKING) this.patch({ answer: "" });
			// 从待机/休眠进来 = 刚唤醒，等第一句话（12s 没开口就退回待机）；
			// 从播报/思考进来 = 对话中途，按 `sleep.idleTimeoutMs`（默认 60s）计时。
			//
			// 「播报完不必重新唤醒」正是靠这里：`from === SPEAKING` 落到
			// `false` → 走 60s 那一档，于是"播报完没有语音输入 60 秒才休眠"。
			this.awaitingFirstUtterance = from === STATES.STANDBY || from === STATES.SLEEPING;
			this.armIdle();
			// 从**播报**过来时要留一段静默再开麦：`speechSynthesis` / `HTMLAudio`
			// 的 onend 可能在音频真正放完之前就触发，外放设备还有余响。
			// 立刻开麦就会把自己刚念的尾音录回去、当成新指令提交 ——
			// 这正是"自说自话"的声学入口。留 700ms 从物理上切断这条路。
			if (from === STATES.SPEAKING) this.armEchoGuard();
			else if (!this.engine.wanted) this.engine.start();
			return;
		}

		if (to === STATES.THINKING) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
			this.patch({ partial: "", notice: "" });
			// 思考中是否开麦是两难：
			//   关麦 = 环境噪声不会误入（默认）；开麦 = 用户能当场纠偏
			//   （"不对，是 D 盘"），agent 在下一个 step 边界吃进插话。
			// 默认**关麦**：常驻 agent 跑一个长任务时，环境里任何人声/噪声
			// 都会被当成"插话"注入正在跑的 turn，是自说自话的另一入口。
			// 要插话纠偏就把 `turn.steerWhileThinking` 打开。
			if (this.config.turn?.steerWhileThinking === true && this.config.agent?.steer !== false) {
				// 这里不需要回声延迟：刚才是用户在说话，没有 TTS 余响。
				if (!this.engine.wanted) this.engine.start();
			} else {
				this.engine.stop();
			}
			return;
		}

		if (to === STATES.SPEAKING) {
			this.engine.stop();
			// 停止识别后丢掉攒下的片段：那是上一代识别器的残留，
			// 留着会在下一轮被一起提交（表现为"你上次说的话又发了一遍"）。
			this.turnGate.reset();
			this.patch({ pending: "", pendingDueAt: null });
			return;
		}
		// 其他情况不额外处理（event 仅用于诊断时打印）。
		void event;
	}

	/**
	 * 播报结束后延迟重开麦克风（切断声学回环）。
	 *
	 * 用 `generation` 做守卫：延迟期间用户可能又点了播报/休眠，
	 * 那时不该把这个旧定时器兑现成一次"擅自开麦"。
	 */
	armEchoGuard() {
		clearTimeout(this.echoTimer);
		const generation = this.generation;
		this.echoTimer = setTimeout(() => {
			this.echoTimer = null;
			if (this.disposed || generation !== this.generation) return;
			if (!this.engine.wanted) this.engine.start();
		}, ECHO_GUARD_MS);
	}

	/**
	 * 重置并武装"本轮结束"计时器。
	 *
	 * ## 三个截止点，取最早的那个
	 *
	 * | 情形 | 到点做什么 | 时限 |
	 * |---|---|---|
	 * | 唤醒后一直没开口 | 回待机继续等唤醒词 | `WAKE_GRACE_MS`（12s）|
	 * | 已攒下内容、静音了 | **提交这一轮**（`TurnGate` 自己管） | `turn.silenceMs` |
	 * | 彻底没动静了 | 休眠、释放麦克风 | `sleep.idleTimeoutMs` |
	 *
	 * ## 为什么休眠下限要随静音阈值抬高
	 *
	 * 两者都长在"静音"上，很容易撞在一起：默认休眠 60s、静音提交 60s，
	 * 若同时到点，休眠先执行 → 状态离开 `active` → 整轮发言被丢掉，
	 * 用户说了半天什么也没发生。这是最隐蔽的一类"说了没反应"。
	 *
	 * 所以本轮已有内容时，休眠下限抬到 `silenceMs + 5s`，保证提交一定
	 * 发生在休眠之前。（`TurnGate` 是唯一提交入口，它自己保证会提交。）
	 */
	armIdle() {
		clearTimeout(this.idleTimer);

		// 已攒下内容：等门槛提交，休眠要排在它后面。
		if (this.turnGate.pending) {
			const need = (this.turnGate.silenceMs ?? SILENCE_SUBMIT_MS) + 5000;
			this.idleTimer = setTimeout(() => {
				if (this.machine.get() === STATES.ACTIVE) this.sleep();
			}, Math.max(this.config.sleep.idleTimeoutMs, need));
			return;
		}

		// 刚唤醒、一句话还没听到：用短时限回待机 —— 避免界面一直显示
		// "正在听"却什么都不发生，用户会以为功能坏了。
		if (this.awaitingFirstUtterance) {
			const grace = Math.min(WAKE_GRACE_MS, this.config.sleep.idleTimeoutMs);
			this.idleTimer = setTimeout(() => {
				if (this.machine.get() !== STATES.ACTIVE) return;
				// 期间用户开口了：改按"已攒下内容"那档，别把内容丢了。
				if (this.turnGate.pending) {
					this.armIdle();
					return;
				}
				this.machine.send(EVENTS.IDLE);
			}, grace);
			return;
		}

		// 已经聊过：等休眠静默时长。每次开口都会重新调用本方法，计时重排。
		this.idleTimer = setTimeout(() => {
			if (this.machine.get() === STATES.ACTIVE) this.sleep();
		}, this.config.sleep.idleTimeoutMs);
	}

	/** 播放提示音（受配置开关控制）。 */
	chime(kind) {
		if (this.config.sleep.chime === false) return;
		playChime(kind);
	}

	/** ── 识别事件 ─────────────────────────────────────────────────── */

	/**
	 * 中间结果：用于快速唤醒与实时字幕。
	 *
	 * 唤醒必须吃中间结果 —— 等最终结果要 900ms 静默，用户会觉得"喊完半天没反应"。
	 * @param text - 中间文本。
	 */
	handlePartial(text) {
		const status = this.machine.get();
		const text_ = String(text ?? "");
		// 回声过滤必须放在最前：待机时的回声虽然不提交，但它可能**含唤醒词**
		// （助手念"小凤…"时），会把机器从待机唤醒 —— 那就等于自己喊自己。
		if (this.config.turn?.echoGuard !== false && this.echoGuard.check(text_).echo) return;
		if (status === STATES.STANDBY) {
			const hit = findWake(text_, this.wakeOptions());
			if (hit.hit) {
				this.chime("wake");
				this.machine.send(EVENTS.WAKE);
				this.engine.reset?.();
				this.patch({ partial: hit.rest });
			}
			return;
		}
		if (status === STATES.ACTIVE) {
			// 唤醒词在已唤醒状态下也吸收掉（"小凤，小凤帮我…"）。
			const hit = findWake(text_, { ...this.wakeOptions(), inline: true });
			this.patch({ partial: hit.hit ? hit.rest : text_ });
			this.armIdle();
		}
	}

	/**
	 * 最终结果：唤醒判定，或**攒进本轮**。
	 *
	 * ## 为什么这里不再直接提交
	 *
	 * 识别引擎的"最终结果"是**片段**（900ms / 700ms 静音就切一段），
	 * 不是**一轮发言**。直接把片段当指令提交会出两个真实故障：
	 * 用户说到一半（想词、换气）就被提交上半句；一个意图被拆成好几轮对话。
	 *
	 * 所以片段一律先经 `TurnGate` 攒着，只有
	 *   - 静音满 `turn.silenceMs`（默认 5 秒），或
	 *   - 用户单击语音球（手动「我说完了」），或
	 *   - 触到单轮硬上限（连续不断说话的安全阀）
	 * 才真正走 `runCommand` 提交一次。
	 *
	 * @param text - 一段识别文本。
	 */
	async handleFinal(text) {
		const content = String(text ?? "").trim();
		if (content === "") return;
		const status = this.machine.get();

		// ── 回声抑制 ──────────────────────────────────────────────────────
		//
		// 助手自己刚念的话被麦克风录回来，绝不能当成用户指令 —— 那是
		// "自说自话"闭环的声学入口。放在状态分支**之前**：任何状态下
		// 识别到的回声都该丢掉（播报余响可能在状态已切走之后才送达）。
		if (this.config.turn?.echoGuard !== false) {
			const echo = this.echoGuard.check(content);
			if (echo.echo) {
				warn("丢弃识别到的回声", echo.matched);
				this.patch({ partial: "" });
				return;
			}
		}

		if (status === STATES.STANDBY) {
			const hit = findWake(content, this.wakeOptions());
			if (!hit.hit) return; // 待机时的日常说话不理会。
			this.chime("wake");
			this.machine.send(EVENTS.WAKE);
			// 唤醒词后面带的内容同样进轮次门槛：用户可能还要接着说。
			if (hit.rest !== "") this.pushFragment(hit.rest);
			else this.notice(`我在，请说。`, "info");
			return;
		}

		if (status === STATES.ACTIVE) {
			this.armIdle();
			// 已唤醒状态仍需剥掉可能的唤醒词前缀。
			const hit = findWake(content, { ...this.wakeOptions(), inline: true });
			const fragment = (hit.hit ? hit.rest : content).trim();
			if (fragment === "") {
				this.notice("我在，请说。", "info");
				return;
			}
			this.pushFragment(fragment);
			return;
		}

		if (
			status === STATES.THINKING &&
			this.config.turn?.steerWhileThinking === true &&
			this.config.agent?.steer !== false
		) {
			// 插话纠偏：思考中说的话 steer 进当前 turn，agent 在下一个
			// step 边界消费。不开新 turn —— 那会变成"排队等下一轮"。
			// 默认**关闭**（`turn.steerWhileThinking=false`）且思考中不开麦：
			// 开着的话环境里任何人声都会被注入正在跑的 turn。
			const hit = findWake(content, { ...this.wakeOptions(), inline: true });
			const steerText = (hit.hit ? hit.rest : content).trim();
			if (steerText === "") return;
			this.patch({ partial: `插话：${steerText}` });
			const accepted = await this.session.steer(steerText);
			if (accepted) this.notice("已插话纠偏。", "info");
			return;
		}
		// speaking / sleeping 期间到达的最终结果一律丢弃：
		// 那是上一代识别器的残留，处理它会造成重复提交。
	}

	/**
	 * 把一个识别片段攒进本轮发言（不提交）。
	 *
	 * 重复片段会被门槛丢掉（引擎 `onend` 重启时可能把同一句再送一遍）。
	 * @param fragment - 片段文本。
	 */
	pushFragment(fragment) {
		if (!this.turnGate.push(fragment)) return;
		this.awaitingFirstUtterance = false;
		// 先 push 再 armIdle：`armIdle` 要按"本轮在攒"抬高下限，
		// 否则休眠静默会和静音提交撞在同一刻，睡着就把整轮丢了。
		this.armIdle();
		// `partial` 必须清空：引擎的 `onPartial` 给的是"已确认最终文本 +
		// 当前中间结果"的**累计**串，片段入队后那部分已经进了 `pending`，
		// 不清的话界面会把同一句显示两遍（`pending` 一份、`partial` 一份）。
		this.patch({ partial: "", pending: this.turnGate.text, pendingDueAt: this.turnGate.deadline });
	}

	/**
	 * 轮次门槛到点：真正把整轮发言提交进会话。
	 * @param payload - `{ text, reason }`；`reason` 为 `silence` / `cap` / `manual`。
	 */
	async handleTurnCommit(payload) {
		const text = String(payload?.text ?? "").trim();
		this.patch({ pending: "", pendingDueAt: null });
		if (text === "") return;
		// 状态已不是"正在听"（用户打断了、休眠了、或这轮已被提交）就别再发了。
		if (this.machine.get() !== STATES.ACTIVE) return;
		if (payload?.reason !== "silence") {
			log(`本轮提交（${payload?.reason}，${text.length} 字）`);
		}
		// 有未答问题时，这一轮发言**先当成回答**去匹配。
		//
		// 放在这里而不是 `handleFinal`：回答也是一个"整轮发言"，同样要
		// 等用户说完（静音满阈值）再匹配 —— 否则用户刚说"第一个"就会被
		// 立刻当成答案提交，而他其实还要补充"不是，我是说第三个"。
		//
		// 匹配不上时会返回 `false` 并继续走指令路径（见 `tryAnswerQuestion`
		// 的注释：宁可当新指令，也不能猜一个选项替用户答）。
		if (await this.tryAnswerQuestion(text)) return;
		await this.runCommand(text);
	}

	/**
	 * 手动提交当前这一轮（单击语音球）。
	 *
	 * 等满静音阈值是默认行为，但人总有"我说完了，快答"的时候，所以留这个逃生口。
	 * @returns 是否真的提交了（没有攒下内容时为 `false`）。
	 */
	submitTurn() {
		if (!this.turnGate.pending) return false;
		this.turnGate.flush("manual");
		return true;
	}

	/** 唤醒匹配参数。 */
	wakeOptions() {
		return {
			word: this.config.wake.word,
			aliases: this.config.wake.aliases,
			inline: this.config.wake.inlineCommand,
		};
	}

	/**
	 * 执行一条指令：润色 → 写入会话。
	 * @param raw - 原始转录文本。
	 */
	async runCommand(raw) {
		const generation = this.generation;
		this.patch({ heard: raw, partial: raw, error: "" });

		// V1.7：专家管理命令在**润色前**用规则识别（润色会把结构化命令改写成
		// 自然语言，反而丢参数）。命中就执行并口头回报，不再走 LLM 路由。
		const command = parseExpertCommand(raw);
		if (command !== null) {
			await this.runExpertManagement(command, generation);
			return;
		}
		// V1.8：专家会话命令（列/开/切/关会话），同样在润色前用规则识别。
		const sessionCommand = parseSessionCommand(raw);
		if (sessionCommand !== null) {
			await this.runSessionManagement(sessionCommand, generation);
			return;
		}

		let text = raw;
		let via = "off";
		if (this.config.polish.enabled) {
			try {
				const result = await polish(raw);
				if (generation !== this.generation) return;
				if (typeof result?.text === "string" && result.text.trim() !== "") {
					text = result.text.trim();
					via = typeof result.via === "string" ? result.via : "llm";
				}
			} catch (error) {
				// 润色失败不影响主链路：原话照发，但要让用户知道这次没润色。
				warn("润色不可用", error);
				this.notice("润色服务不可用，已按原话发送。", "warn");
			}
		}
		this.patch({ heard: text, polishVia: via });

		// ── 两层架构第一层：意图路由（润色之后、提交之前）──────────────
		//
		// 为什么在润色之后：路由模型拿到的是干净指令，分类质量更高。
		// 为什么尊重"用户手动切换"：用户用跨会话功能**点名**了目标会话时，
		// 那是比自动路由更强的意图表达 —— 路由让位，直到用户切回常驻。
		//
		// V1.3 起这里**不再切会话**：非 general 的 worker 走 /delegate 后台
		// 执行，客户端留在根会话；worker 完成后由宿主汇总要点入队，再经
		// /reports 按完成先后依次播报（见下面的轮询器）。
		// 降级链：路由失败/关闭 → 进根 agent「小凤」；委托失败 → 也进根 agent。
		let task = text;
		let delegated = false;
		if (
			this.config.routing?.enabled === true &&
			Array.isArray(this.config.routing.workers) &&
			this.config.routing.workers.length > 0 &&
			!(this.session.mode === "switched" && this.session.routerPinned !== true)
		) {
			try {
				const outcome = await route(text);
				if (generation !== this.generation) return;
				if (typeof outcome?.task === "string" && outcome.task.trim() !== "") task = outcome.task.trim();
				const workerId = typeof outcome?.worker === "string" ? outcome.worker : "general";
				const worker =
					this.config.routing.workers.find((row) => row.id === workerId) ??
					this.config.routing.workers.find((row) => row.id === "general");
				const routeVia = typeof outcome.via === "string" ? outcome.via : "llm";

				if (worker !== undefined && worker.id !== "general") {
					// 真正的专家：提交给宿主后台执行，不切会话、不旁听中间过程。
					// V2.3（需求④）：宿主侧会先判任务归属 —— 老任务回它原来的会话、
					// 新任务用任务名开新会话。返回的 attribution 供界面显示"落在哪条任务"。
					try {
						const result = await delegate(worker.id, task);
						if (generation !== this.generation) return;
						if (result?.ok === true) {
							delegated = true;
							const attribution = result.attribution ?? null;
							this.patch({
								routedWorker: worker.label,
								routeVia,
								pendingDelegations: this.snapshot.pendingDelegations + 1,
								sessionTarget: this.session.describe(),
								// 最近一次归属（面板显示"归入已有任务/新任务"）。
								lastTaskTitle: typeof attribution?.title === "string" ? attribution.title : "",
								lastTaskCreated: attribution?.created === true,
							});
							// 播报口径要说清"是接着老任务做，还是开了新任务" ——
							// 用户听到"已交给阿码处理"时脑子里真正想知道的就是这个。
							this.notice(
								attribution === null
									? `已交给${worker.label}处理，完成后我会汇报要点。`
									: attribution.created === true
										? `已为${worker.label}开新任务「${attribution.title}」，完成后我会汇报要点。`
										: `已接着${worker.label}的任务「${attribution.title}」继续，完成后我会汇报要点。`,
								"info",
							);
							// 立刻探一次（worker 可能几百毫秒就完成），并启动轮询。
							this.startReportPolling();
							this.pollReports();
							this.pollInteractions();
							return;
						}
						warn("委托被拒，指令改投根会话", worker.id, result?.error);
						this.notice(`${worker.label}暂时不可用，我先来处理。`, "warn");
					} catch (error) {
						warn("委托提交失败，指令改投根会话", error);
						this.notice("专家派单暂不可用，我先来处理。", "warn");
					}
					this.patch({ routedWorker: "", routeVia });
				} else if (worker !== undefined && worker.id === "general") {
					// general = 根 agent「小凤」：**回家**（回常驻绑定），不 pin。
					if (this.session.usingPersistent() && this.session.mode !== "persistent") {
						await this.session.switchToPersistent();
					}
					this.patch({ routedWorker: "", routeVia, sessionTarget: this.session.describe() });
				} else {
					this.patch({ routedWorker: "", routeVia });
				}
			} catch (error) {
				warn("意图路由不可用，按原目标发送", error);
				this.patch({ routedWorker: "", routeVia: "error" });
			}
		} else {
			this.patch({ routedWorker: "", routeVia: "" });
		}

		// 非委托路径：正常把任务写进（根）会话，等它的 turn/end 播报。
		this.machine.send(EVENTS.COMMAND);
		// 迁移会换代，所以要在 send 之后重新取一次代号再比较，
		// 否则 `accepted` 的失败处理会被自己刚触发的迁移判成"过期的回调"而跳过。
		const afterSend = this.generation;
		const accepted = await this.session.ask(task);
		if (afterSend !== this.generation) return;
		if (!accepted) {
			this.fail(new Error("prompt-rejected"));
		}
	}

	/**
	 * V1.7：执行一条专家管理命令（增 / 删 / 列）并口头回报。
	 *
	 * 与正常指令不同：管理命令不写会话、不派单，执行完直接说话。走完整的
	 * COMMAND → AGENT_MESSAGE → SPEAK_END 状态机，避免播完停在"思考中"。
	 *
	 * @param command - `parseExpertCommand()` 的结果。
	 * @param generation - 进入时的代号，用于检测期间被打断。
	 */
	async runExpertManagement(command, generation) {
		this.machine.send(EVENTS.COMMAND);
		let result;
		let speech;
		try {
			if (command.kind === "list") {
				const data = await listExperts();
				const names = (data?.workers ?? []).map((w) => w.label ?? w.id).join("、");
				result = { ok: data?.ok === true, ...data };
				speech = result.ok && names !== "" ? `现在的专家有：${names}。` : "现在没有可用专家。";
				if (Array.isArray(data?.workers)) this.refreshExperts(data.workers);
			} else if (command.kind === "add") {
				result = await addExpert(command.expert);
				speech = formatCommandSpeech(result, "add");
				if (result?.ok === true) {
					// 带上生成的 id，方便用户后续用名字删除。
					speech += `它的编号是 ${result.expert.id}。`;
					await this.syncExpertsAfterChange();
				}
			} else if (command.kind === "remove") {
				result = await removeExpert(command.id);
				speech = formatCommandSpeech(result, "remove");
				if (result?.ok === true) await this.syncExpertsAfterChange();
			}
		} catch (error) {
			warn("专家管理命令失败", error?.message ?? error);
			result = { ok: false, error: String(error?.message ?? error) };
			speech = formatCommandSpeech(result, command.kind);
		}
		if (generation !== this.generation) return;

		this.notice(speech, result?.ok === true ? "info" : "warn");
		this.patch({ lastReport: speech, answer: speech, routedWorker: "", routeVia: "expert-command" });
		this.pushHistory("assistant", speech);
		this.echoGuard.remember(speech);
		try {
			await this.speaker.speak(speech);
		} catch (error) {
			warn("管理命令播报失败", error?.message ?? error);
		}
		if (generation !== this.generation) return;
		this.machine.send(EVENTS.SPEAK_END);
		this.patch({ partial: "" });
	}

	/**
	 * V1.8：执行一条专家会话命令（列出 / 开 / 切 / 关会话）并口头回报。
	 *
	 * 与专家管理命令同一状态机：不写会话、不派单，直接说话。
	 *
	 * @param command - `parseSessionCommand()` 的结果。
	 * @param generation - 代号，检测期间被打断。
	 */
	async runSessionManagement(command, generation) {
		this.machine.send(EVENTS.COMMAND);
		let result;
		let speech;
		try {
			if (command.kind === "session-list") {
				const data = await listSessions();
				const sessions = data?.sessions ?? {};
				const parts = [];
				for (const [id, view] of Object.entries(sessions)) {
					const worker = (this.config.routing?.workers ?? []).find((w) => w.id === id);
					const label = worker?.label ?? id;
					const list = (view.sessions ?? []).map((s, i) => `${i + 1}${s.active ? "（当前）" : ""}`).join("、");
					parts.push(`${label}：${list || "无"}`);
				}
				result = { ok: data?.ok === true, ...data };
				speech = parts.length > 0 ? `专家会话情况：${parts.join("；")}。` : "现在还没有会话。";
			} else {
				// 把中文 label 解析成专家 id。
				const worker = this.resolveExpertByIdOrLabel(command.expertLabel);
				if (!worker) {
					result = { ok: false, error: "worker-not-found" };
					speech = formatSessionSpeech(result, command.kind);
				} else {
					const id = worker.id;
					if (command.kind === "session-create") {
						result = await createSession(id);
						speech = formatSessionSpeech(result, "session-create");
					} else if (command.kind === "session-switch") {
						const data = await listSessions(id);
						const view = data?.sessions?.[id];
						const sessions = (view?.sessions ?? []).map((s) => s.sessionId);
						const target = this.pickSessionId(sessions, command.index, view?.activeSessionId);
						if (!target) {
							result = { ok: false, error: "session-not-found" };
							speech = formatSessionSpeech(result, "session-switch");
						} else {
							result = await switchSession(id, target);
							speech = result?.ok === true ? `已切换到${worker.label}的会话。` : formatSessionSpeech(result, "session-switch");
						}
					} else if (command.kind === "session-close") {
						const data = await listSessions(id);
						const view = data?.sessions?.[id];
						const sessions = (view?.sessions ?? []).map((s) => s.sessionId);
						const target = this.pickSessionId(sessions, command.index, view?.activeSessionId);
						if (!target) {
							result = { ok: false, error: "session-not-found" };
							speech = formatSessionSpeech(result, "session-close");
						} else {
							result = await closeSession(id, target);
							speech = result?.ok === true ? `已关闭${worker.label}的一个会话。` : formatSessionSpeech(result, "session-close");
						}
					}
				}
			}
		} catch (error) {
			warn("会话命令失败", error?.message ?? error);
			result = { ok: false, error: String(error?.message ?? error) };
			speech = formatSessionSpeech(result, command.kind);
		}
		if (generation !== this.generation) return;

		this.notice(speech, result?.ok === true ? "info" : "warn");
		this.patch({ lastReport: speech, answer: speech, routedWorker: "", routeVia: "session-command" });
		this.pushHistory("assistant", speech);
		this.echoGuard.remember(speech);
		try {
			await this.speaker.speak(speech);
		} catch (error) {
			warn("会话命令播报失败", error?.message ?? error);
		}
		if (generation !== this.generation) return;
		this.machine.send(EVENTS.SPEAK_END);
		this.patch({ partial: "" });
	}

	/** 按 id 或展示名（含部分匹配）解析专家。 */
	resolveExpertByIdOrLabel(text) {
		const raw = String(text ?? "").trim().toLowerCase();
		if (raw === "") return null;
		const workers = this.config.routing?.workers ?? [];
		return workers.find((w) => w.id === raw || String(w.label ?? "").toLowerCase() === raw)
			?? workers.find((w) => String(w.label ?? "").toLowerCase().includes(raw) || w.id.includes(raw))
			?? null;
	}

	/** 按序号（1-based）挑会话 id；序号为 0 时用活跃会话。 */
	pickSessionId(sessionIds, index, activeId) {
		if (!Array.isArray(sessionIds) || sessionIds.length === 0) return "";
		if (Number.isInteger(index) && index > 0) return sessionIds[Math.min(index, sessionIds.length) - 1];
		return sessionIds.includes(activeId) ? activeId : sessionIds[sessionIds.length - 1];
	}

	/** 增删后重新拉清单，更新本地配置（卡通桌宠浮层据此增减）。 */
	async syncExpertsAfterChange() {
		try {
			const data = await listExperts();
			if (Array.isArray(data?.workers)) this.refreshExperts(data.workers);
		} catch (error) {
			warn("刷新专家清单失败", error?.message ?? error);
		}
	}

	/** 原地替换本地专家清单（保住配置对象引用）。 */
	refreshExperts(workers) {
		if (!Array.isArray(this.config.routing?.workers)) return;
		this.config.routing.workers.splice(0, this.config.routing.workers.length, ...workers);
	}

	/** ── 需求④ 统一互动流：按发生时间依次播报 ──────────────────────────
	 *
	 * ## 为什么是"一条流"而不是"各播各的"
	 *
	 * 三类需要用户介入的事来自不同通道：
	 *   - 权限审核 —— 宿主旁听会话事件的 `approval/asked`；
	 *   - 模型提问 —— 客户端自己旁听当前会话的 `tool/call`；
	 *   - 结果汇报 —— 委托中枢完成后入队。
	 *
	 * 各播各的话，两件几乎同时发生的事谁先出声取决于哪条通道先跑完，用户
	 * 听到的顺序是乱的。这里全部收进 `interactionQueue`（一个**按 `at` 排序**
	 * 的队列），由单一 drain 循环串行播报 —— 听到的顺序 = 发生的顺序。
	 *
	 * ## 游标为什么要 `"latest"` 起步
	 *
	 * 队列在宿主侧跨刷新存活。首帧从 0 拉会把上次会话（甚至几天前）的事
	 * 一次性全念出来。所以首帧只同步水位、不重放。
	 *
	 * ## 与 `/reports` 的关系（不重复播报）
	 *
	 * 宿主把汇报**同时**放进了 `/reports`（旧口径，冒烟脚本与既有调用仍在用）
	 * 与 `/interactions`（新口径）。本控制器只播报**后者**。开启统一流时
	 * 就不再单独轮询 `/reports`，否则同一条汇报会被念两遍。
	 * 统一流不可用时（老宿主）自动退回 `/reports` —— 降级链不断。
	 */

	/**
	 * 启动互动流轮询（幂等）。首次成功委托后调用（没有后台任务就无需轮询）。
	 *
	 * ## 起点：账本优先，`latest` 只是最后手段
	 *
	 * 早先的实现每次启动都把游标设成 `"latest"`（"只对齐水位、不重放历史"）。
	 * 那条策略挡得住"整批历史涌入"，但有两个洞 —— 也正是真机上"前面汇报过的
	 * 内容再打开又播一遍"的成因：
	 *
	 *   1. `latest` 对齐的是**服务端当前游标**，而它是 `max(Date.now(), …)`。
	 *      刷新发生在两次播报之间时，上次已播的条目会重新落进增量窗口；
	 *   2. 双通道：`/reports` 与 `/interactions` 是同一条汇报的两个端点，
	 *      首帧各拉一次，谁先到谁念（`interactionsAvailable` 要到第二轮才生效）。
	 *
	 * 现在改为：**有账本就从账本续**（水位 + 已播集合双重去重），
	 * 只有账本为空（首次使用、或用户清了存储）才退回 `latest` 对齐。
	 */
	startReportPolling() {
		if (this.disposed || this.reportTimer !== null) return;
		// 账本里有水位 → 从它续上（这就是"记住回答到哪个位置"）。
		if (this.interactionCursor === undefined) {
			const saved = this.ledger.cursor;
			this.interactionCursor = saved > 0 ? saved : "latest";
		}
		if (this.reportCursor === undefined) {
			const saved = this.ledger.cursor;
			this.reportCursor = saved > 0 ? saved : "latest";
		}
		const interval = Number.isFinite(this.config.interactions?.pollMs)
			? Math.max(500, this.config.interactions.pollMs)
			: Number.isFinite(this.config.routing?.reportPollMs)
				? Math.max(500, this.config.routing.reportPollMs)
				: 1500;
		this.reportTimer = setInterval(() => {
			this.pollReports();
			this.pollInteractions();
		}, interval);
		log(`互动流轮询已启动（间隔 ${interval}ms，水位 ${this.ledger.cursor > 0 ? this.ledger.cursor : "首次"}）`);
	}

	/** 停止互动流轮询。 */
	stopReportPolling() {
		if (this.reportTimer !== null) {
			clearInterval(this.reportTimer);
			this.reportTimer = null;
		}
	}

	/**
	 * 拉一次新汇报，入队后依次播报（**仅统一流不可用时走这条**）。
	 *
	 * ## 为什么"首帧 latest"不能省
	 *
	 * 常驻 agent / 汇报队列跨会话、跨刷新存活。若首帧从 0 开始拉，会把上次
	 * 会话（甚至几天前）的汇报一次性全念出来 —— 与会话事件的水位线同一类
	 * 事故。首帧只同步游标，之后才取增量。
	 */
	async pollReports() {
		if (this.disposed) return;
		// 统一互动流可用时由 pollInteractions 独占播报（避免同一条念两遍）。
		if (this.interactionsAvailable) return;
		try {
			const payload = await fetchReports(this.reportCursor);
			if (this.disposed) return;
			if (typeof payload?.cursor === "number") {
				if (this.cursorSeeded) this.ledger.advance(payload.cursor);
				else {
					this.ledger.seed(payload.cursor);
					this.cursorSeeded = true;
				}
				this.reportCursor = payload.cursor;
			}
			const incoming = Array.isArray(payload?.reports) ? payload.reports : [];
			if (incoming.length > 0) {
				// 服务端已按完成时间升序；客户端只做去重。
				//
				// 去重用**同一个账本**（`kind:"report"` + jobId）：这样降级通道
				// 与统一流共享一份"播过了"的记录 —— 即便两条通道同时活着、
				// 同一条汇报两边都拿到，也只会念一次（需求②的硬防线）。
				let queued = 0;
				for (const report of incoming) {
					const entry = {
						kind: "report",
						at: typeof report?.at === "number" ? report.at : undefined,
						key: String(report?.jobId ?? ""),
						label: String(report?.label ?? ""),
						speech: String(report?.speech ?? report?.summary ?? ""),
					};
					if (!this.ledger.claim(entry)) continue;
					if (!withinCatchup(entry, { now: Date.now(), windowMs: this.catchupWindowMs() })) {
						log("跳过过期汇报（太老了不补播）");
						continue;
					}
					this.interactionQueue.push(entry);
					queued += 1;
				}
				if (queued > 0) {
					this.patch({ pendingDelegations: Math.max(0, this.snapshot.pendingDelegations - queued) });
					this.drainInteractions();
				}
			}
		} catch (error) {
			// 轮询失败不打扰用户（间隔短、会重试），但要留一条可见结论。
			warn("汇报轮询失败（稍后重试）", error?.message ?? error);
		}
	}

	/**
	 * 拉一次统一互动流（权限审核 / 模型提问 / 结果汇报），入队后依次播报。
	 *
	 * 失败一次就把 `interactionsAvailable` 置假并退回报废的 `/reports` 轮询：
	 * 老宿主没有这个端点，持续 404 刷屏没有意义。但**每次**都会重试探测
	 * （见下面的恢复逻辑），所以临时故障不会永久降级。
	 */
	async pollInteractions() {
		if (this.disposed) return;
		if (this.config.interactions?.enabled === false) return;
		try {
			const payload = await fetchInteractions(this.interactionCursor);
			if (this.disposed) return;
			if (typeof payload?.cursor === "number") {
				// 首次（游标是 `latest`）只**对齐水位**不记账；之后每轮都推进账本，
				// 这样"重开时从哪儿续"有一个跨刷新可用的答案。
				if (this.cursorSeeded) this.ledger.advance(payload.cursor);
				else {
					this.ledger.seed(payload.cursor);
					this.cursorSeeded = true;
				}
				this.interactionCursor = payload.cursor;
			}
			if (!this.interactionsAvailable) {
				this.interactionsAvailable = true;
				log("统一互动流已接入（审批 / 提问 / 汇报按时间播出）");
			}
			const incoming = Array.isArray(payload?.interactions) ? payload.interactions : [];
			if (incoming.length === 0) return;
			const settings = this.config.interactions ?? {};
			let queued = 0;
			for (const entry of incoming) {
				// 宿主已按类型过滤过一遍，客户端再按配置守一次：两头都判才能
				// 保证"关掉审批播报"这件事在任一端改配置都立刻生效。
				if (entry?.kind === "approval" && settings.announceApprovals === false) continue;
				if (entry?.kind === "question" && settings.announceQuestions === false) continue;
				// 需求②的硬防线：同一条内容（按 `kind:key`）一辈子只播一次。
				// 跨刷新有效 —— 刷新后游标可能把旧条目重新纳入窗口，但账本认得它。
				if (!this.ledger.claim(entry)) continue;
				// 追补窗口：太老的条目记账（在上面 claim 里已记）但不真出声。
				// 用户关页面一天再回来时，不至于被一次性念完整个队列。
				if (!withinCatchup(entry, { now: Date.now(), windowMs: this.catchupWindowMs() })) {
					log(`跳过过期互动（${String(entry?.kind ?? "")}，太老了不补播）`);
					continue;
				}
				this.interactionQueue.push(entry);
				queued += 1;
				if (entry?.kind === "report") {
					this.patch({ pendingDelegations: Math.max(0, this.snapshot.pendingDelegations - 1) });
				}
			}
			if (queued > 0) this.drainInteractions();
		} catch (error) {
			if (this.interactionsAvailable) {
				this.interactionsAvailable = false;
				warn("统一互动流不可用，回退到汇报轮询", error?.message ?? error);
			}
		}
	}

	/**
	 * 追补窗口长度（毫秒）。配置可覆盖；`0` = 关掉窗口限制（全部补播）。
	 * @returns 窗口长度。
	 */
	catchupWindowMs() {
		const raw = this.config.interactions?.catchupWindowMs;
		return Number.isFinite(raw) ? Math.max(0, raw) : undefined;
	}

	/**
	 * 逐条播报互动队列（发生先后 = `at` 升序 = 入队顺序）。
	 *
	 * ## 为什么必须串行 + 等 SPEAK_END
	 *
	 * 多项几乎同时发生时，如果各自直接 `speak()`，后一条会 cancel 前一条
	 * —— 用户只听到最后一句。这里用 `interactionDraining` 做互斥，一条
	 * 播完（含回声静默）再播下一条，保证"按时间先后依次呈现"。
	 */
	async drainInteractions() {
		if (this.disposed || this.interactionDraining) return;
		this.interactionDraining = true;
		try {
			while (this.interactionQueue.length > 0 && !this.disposed) {
				// 用户停用语音：队列留着，等下次 start() 再播，不擅自出声。
				if (this.machine.get() === STATES.OFF) break;
				const entry = this.interactionQueue.shift();
				const text = String(entry?.speech ?? "").trim();
				if (text === "") continue;

				this.patch({ lastReport: text, lastInteractionKind: String(entry?.kind ?? ""), answer: text });
				this.pushHistory("assistant", text);
				const wasSleeping = this.machine.get() === STATES.SLEEPING;
				if (wasSleeping) this.chime("wake");
				this.machine.send(EVENTS.AGENT_MESSAGE);
				this.echoGuard.remember(text);

				const generation = this.generation;
				try {
					await this.speaker.speak(text);
				} catch (error) {
					warn("互动播报失败", error?.message ?? error);
				}
				if (generation !== this.generation) break; // 期间被打断/休眠。
				this.machine.send(EVENTS.SPEAK_END);
				this.patch({ partial: "" });
				// 两条之间留一小段静默，避免连读糊成一句。
				await new Promise((resolve) => setTimeout(resolve, 400));
			}
		} finally {
			this.interactionDraining = false;
		}
	}

	/** ── 跨会话：列出 / 切换 / 新建（需求 ②） ───────────────────────── */

	/**
	 * 列出可以把语音指令投过去的会话（界面用）。
	 *
	 * 只读本地投影（不发请求）；要最新的宿主列表先 `refreshSessions()`。
	 * @returns `{ id, title, cwd, running, current }[]`，宿主顺序。
	 */
	listSessions() {
		return this.session.listTargets();
	}

	/**
	 * 拉一次宿主最新的会话列表（网络往返）。
	 *
	 * 与 `listSessions()` 分开，是因为两者代价差一个数量级：界面每次渲染
	 * 都读投影是免费的，而 refresh 要走一次 RPC。只有用户点"刷新"或
	 * 打开会话选择器时才该付这个代价。
	 * @returns 是否刷新成功。
	 */
	async refreshSessions() {
		const sessions = this.ctx.get("sessions");
		if (sessions === null || sessions === undefined || typeof sessions.refresh !== "function") return false;
		try {
			await sessions.refresh();
			return true;
		} catch (error) {
			warn("刷新会话列表失败", error?.message ?? error);
			return false;
		}
	}

	/**
	 * 把语音指令的目标切到另一个会话。
	 *
	 * ## 为什么必须先把界面切过去（`openInUi`）而不是切完就算了
	 *
	 * 用户是**用眼睛确认**目标换对了没有。切完不打开，界面上还停在
	 * 原来的会话，用户会以为没生效 —— 接着说的话进了新会话，自己却
	 * 在旧会话里找回答。所以这里切成功后**主动打开**那个会话。
	 *
	 * @param sessionId - 目标会话 id。
	 * @returns 是否切换成功。
	 */
	async switchSession(sessionId) {
		const ok = await this.session.switchTo(sessionId);
		if (!ok) {
			this.notice("没能切到那个会话，已退回当前会话。", "error");
			return false;
		}
		this.patch({ sessionId: this.session.sessionId });
		const label = this.listSessions().find((row) => row.id === this.session.sessionId)?.title ?? "";
		this.notice(`已切到「${label === "" ? String(this.session.sessionId).slice(0, 8) : label}」。`, "info");
		await this.session.ensure({ open: true });
		return true;
	}

	/**
	 * 新建一个会话并把语音目标切过去（"开个新会话派任务"）。
	 * @param options - `{ cwd, title }`；只填一项也可以。
	 * @returns 新会话 id，失败为 `null`。
	 */
	async newSession(options = {}) {
		const id = await this.session.createAndSwitch(options);
		if (id === null) {
			this.notice("新建会话失败，请稍后重试。", "error");
			return null;
		}
		this.patch({ sessionId: id });
		this.notice("已开一个新会话，接下来我说的都进这里。", "info");
		await this.session.ensure({ open: true });
		return id;
	}

	/**
	 * 切回常驻助手会话（跨会话聊完之后的"回家"）。
	 * @returns 是否成功。
	 */
	async backToAssistant() {
		const ok = await this.session.switchToPersistent();
		if (!ok) {
			this.notice("没找到常驻助手会话（可能未启用）。", "warn");
			return false;
		}
		this.patch({ sessionId: this.session.sessionId });
		this.notice("已切回小凤常驻助手。", "info");
		return true;
	}

	/** ── 提问应答（只做「模型提问」，不碰「工具审批」）────────────────── */

	/**
	 * 把问答桥接到当前会话的投影上（换会话/首次绑定后都要调）。
	 *
	 * @returns 是否接上（接不上不是错误：精简 profile 没装 `dsh-user-questions`）。
	 */
	attachQuestions() {
		const binding = this.session.binding;
		const sessionId = this.session.sessionId;
		if (binding === null || sessionId === null) return false;
		// 换绑时把"正在等答"清掉：那条问题是上一个会话的。
		this.patch({ question: null });
		return this.questions.attach(sessionId, binding);
	}

	/**
	 * 收到一个新问题：响提示音 → 念出来 → 进"等作答"状态。
	 *
	 * ## 为什么 `open` 状态也要念
	 *
	 * `open` = 工具调用还开着、界面问题卡还在。这时**我不能替用户答**
	 * （`answer()` 只收 `continued`），但用户可能根本没在看屏幕 ——
	 * 念出来仍然有价值（他可以抬手点界面）。念完在界面上标注
	 * "请到界面上确认"，让他知道该看哪儿。
	 *
	 * @param payload - `{ sessionId, callId, state, questions }`。
	 */
	async handleQuestion(payload) {
		if (this.disposed) return;
		// 用户已停用语音时不要突然开口。
		if (this.machine.get() === STATES.OFF) return;
		const questions = Array.isArray(payload?.questions) ? payload.questions : [];
		if (questions.length === 0) return;

		const spoken = questions
			.map((item, index) => speakQuestion(item, index, questions.length))
			.join(" ");
		this.patch({
			question: {
				callId: payload.callId,
				state: payload.state,
				spoken,
				questions: questions.map((item) => ({
					id: String(item?.id ?? ""),
					question: String(item?.question ?? ""),
					header: typeof item?.header === "string" ? item.header : "",
					multiSelect: item?.multiSelect === true,
					options: Array.isArray(item?.options)
						? item.options.map((option) => ({
								label: String(option?.label ?? ""),
								description: typeof option?.description === "string" ? option.description : "",
							}))
						: [],
				})),
			},
		});

		// 响一声再念：用户可能正在做别的事，直接开口会被当成环境噪声。
		if (this.config.answers?.chime !== false) this.chime("wake");
		// 提示文案按有无权威 state 分开说：
		//   - `continued`：前台窗口已结束，语音能答；
		//   - `open`（含 legacy 模式下的保守值）：界面问题卡还在，
		//     DSH 的 `answer()` 会拒绝语音代答 → 让用户去界面点。
		// 不把话说死成"只能去界面"：timed 模式下 `continued` 是能语音答的。
		this.notice(
			payload.state === "continued" ? "有个问题要确认，您可以直接说答案。" : "有个问题要确认，请在界面上选（我念给您听）。",
			"info",
		);

		// 念问题本身不改状态机 —— 提问与"思考中/播报中"是两条正交的线：
		// agent 可能还在跑（`thinking`），而问题只是它中途要的信息。
		// 复用播报器意味着会打断当前播报，这正是想要的（问题更紧急）。
		this.echoGuard.remember(spoken);
		try {
			await this.speaker.speak(spoken);
		} catch (error) {
			warn("念问题失败", error?.message ?? error);
		}
	}

	/**
	 * 尝试把一段识别文本当成"对当前问题的回答"。
	 *
	 * ## 为什么返回 `true` 就不再走指令路径
	 *
	 * 有未答问题时，用户说的话**几乎一定**是在回答问题 —— 这时把它当
	 * 新指令投给模型，会造成"模型和用户各说各话"（用户以为在答问，
	 * 模型以为来了新任务）。所以只要**匹配上了**就拦下来作答。
	 *
	 * 反过来，**没匹配上就交回指令路径**：用户可能就是在说一件别的事
	 * （"先别管那个，帮我看下 D 盘"）。宁可让这句话变成一条新指令，
	 * 也不能猜一个选项替他答 —— 猜错的代价是替用户做了决定。
	 *
	 * @param text - 识别文本。
	 * @returns 是否已当作回答处理（`true` = 不要再当指令提交）。
	 */
	async tryAnswerQuestion(text) {
		const question = this.snapshot.question;
		if (question === null || question === undefined) {
			this.lastAnswerAttempt = { text, outcome: "no-question" };
			return false;
		}
		const first = question.questions[0];
		if (first === undefined) {
			this.lastAnswerAttempt = { text, outcome: "no-question" };
			return false;
		}
		const matched = matchAnswer(text, first.options, first.multiSelect);
		if (matched.matched !== true) {
			// 没匹配上：不猜。交给上层当普通指令处理。
			this.lastAnswerAttempt = { text, outcome: "no-match" };
			this.notice("没听清您选哪个，再说一次，或到界面上点。", "info");
			return false;
		}

		// 多问题批次：一次只答一个会更稳（模型要的是每个问题各一条答案），
		// 但语音场景下用户通常只面对一个问题。多个问题时**只答第一个**，
		// 其余留给界面 —— 这比瞎猜其余几个安全。
		if (question.questions.length > 1) {
			// 必须凑齐每个问题各一条（DSH 的 `answer()` 会校验条数），
			// 凑不齐时如实退回界面，不硬造答案。
			this.lastAnswerAttempt = { text, outcome: "multi-question" };
			this.notice("这组问题有多个，请到界面上一次答完。", "info");
			return false;
		}
		const batch = { answers: [{ id: first.id, selected: matched.selected, ...(matched.custom === "" ? {} : { custom: matched.custom }) }] };

		// ## 为什么不再预先按 `state` 拒绝
		//
		// 原实现是 `if (state !== "continued") 直接拒绝`。那在**默认配置下
		// 等于永远拒绝** —— 因为 legacy 模式根本进不了投影（见 questions.js
		// 顶部），事件流给出的 `state` 恒为保守值 `open`。
		//
		// 改为**先尝试、再按结果如实回报**：DSH 的 `answer()` 只在 `continued`
		// 里找 callId（`dsh-user-questions/lib/index.js:560`），所以界面还能答时
		// 它会返回 `false` → 我们据此告诉用户"去界面点"。这样既不越权，
		// 又不会把"宿主其实能收"的情况一起挡掉。
		const result = await this.questions.submit(question.callId, batch);
		if (result.ok) {
			this.lastAnswerAttempt = { text, outcome: "submitted", selected: matched.selected };
			log(`已按语音作答（${matched.skip === true ? "跳过" : matched.selected.join("/") || matched.custom}）`);
			this.pushHistory("user", matched.skip === true ? "（跳过这个问题）" : text);
			this.notice("已提交您的回答。", "info");
			return true;
		}
		// `not-answerable` = 问题还挂在界面上（DSH 的护栏：界面能答时我插不进去）。
		// 这不是错误，是预期行为，用 info 而不是 error 播报。
		//
		// ## 为什么"没提交成功"也要返回 `true`（**已消费这句话**）
		//
		// 返回值表达的是"这句话**是不是在回答问题**"，不是"答上了没有"。
		// 匹配上了就说明用户在对那个问题说话 —— 这时若返回 `false`，
		// 上层会把「第一个」当成**新指令**投给模型，正是本函数开头要避免的
		// "模型和用户各说各话"。真实结果由 `lastAnswerAttempt()` 如实记录
		// （真机冒烟就是这么把这两种情况分开断言的）。
		if (result.reason === "not-answerable") {
			this.lastAnswerAttempt = { text, outcome: "not-answerable", selected: matched.selected };
			this.notice("这个问题请在界面上点选（界面还能答时语音不代答）。", "info");
			return true;
		}
		// 其余失败要如实说 —— 用户以为答了、实际没答是最坏的情形。
		this.lastAnswerAttempt = { text, outcome: "failed", reason: result.reason, selected: matched.selected };
		this.notice(`回答没能提交（${result.reason}），请到界面上确认。`, "error");
		return true;
	}

	/** ── 会话事件 ─────────────────────────────────────────────────── */

	/** turn 开始：确保处于"思考中"（含用户手打触发的 turn）。 */
	handleTurnStart() {
		const status = this.machine.get();
		if (status === STATES.ACTIVE || status === STATES.STANDBY || status === STATES.SLEEPING) {
			this.patch({ answer: "" });
		}
	}

	/**
	 * turn 结束：把回答念出来，或按原因如实收尾。
	 *
	 * 休眠中被唤醒的情形（需求 5）正是走这里：
	 * `machine.send(AGENT_MESSAGE)` 让状态从 `sleeping` 直接进 `speaking`，
	 * 于是先响提示音、再播报，播完回到 `active`（**正在听**）等用户继续。
	 *
	 * ## 播完的落点是「正在听」，不是「待机」（本轮修复）
	 *
	 * `SPEAK_END` 现在迁到 `ACTIVE`：助手说完就直接进入可续话的听写态，
	 * 用户接着说话即可 —— **不必每轮重新喊唤醒词**。收尾交给 `active` 里的
	 * 休眠计时（`sleep.idleTimeoutMs`，默认 60s）：静默满 60 秒才休眠。
	 *
	 * 曾经的落点是 `standby`，而 `standby` **不参与**计时，于是症状是
	 * "每答完一轮都要重新唤醒、同时永远不休眠" —— 两个极端同时出现，
	 * 而且方向相反，光看状态名（`standby` 看起来挺正常）完全看不出问题。
	 *
	 * ## 三种"空 turn"必须分开对待（真机踩坑）
	 *
	 * turn 没有文字有三种成因，对用户的含义完全不同：
	 *
	 * | reason.kind | 真相 | 该怎么说 |
	 * |---|---|---|
	 * | `error` | 这一轮**失败了**（例如模型路由缺失） | 把错误说出来 |
	 * | `blocked` | 这一轮被**闸门拒了**，压根没跑（例如会话在归档集合里） | 说清是"没跑起来" |
	 * | 其它（如 `completed`） | **纯工具轮**：agent 只调了工具、没说话 | 静默收尾即可 |
	 *
	 * 早期只特判了 `error`，`blocked` 掉进"纯工具轮"分支 —— 等于把最严重的
	 * 故障伪装成正常（见下）。现在按 reason 三分流。
	 *
	 * ## 为什么 `blocked` 必须单独说（本项目最坏的一次失败模式）
	 *
	 * 本 profile 注册了 `ArchivedSessionGate`：会话一旦在
	 * `workspaceRegistry.archivedSessionIds` 里，**每一轮** `agent/pre-step`
	 * 都被 reject，`dsh-agent-loop` 于是记成
	 * `turn/end reason={"kind":"blocked"}` 并**不发起任何模型请求**。
	 *
	 * 关键坑在于：`prompt()` 的原始返回是 `{"ok":true,"value":{"accepted":true}}`
	 * —— **提交是成功的**。于是客户端这边"提交成功、状态回弹、界面无报错"，
	 * 看起来一切正常，只是永远没有回答。用户只能猜"是不是我没说清"。
	 *
	 * `blocked` 的具体成因（归档）由宿主半自愈
	 * （`lib/identity.js` 的 `ensureSessionNotArchived`），客户端这一层保证
	 * "万一还是发生了，用户一定看得见"。
	 *
	 * @param payload - `{ text, reason, turn }`。
	 */
	async handleTurnEnd(payload) {
		const text = typeof payload?.text === "string" ? payload.text.trim() : "";
		// 用户已停用语音时不要突然开口 —— 会话仍在订阅，事件照样会到。
		if (this.machine.get() === STATES.OFF) return;

		const reason = payload?.reason;
		const kind = reason !== null && typeof reason === "object" ? String(reason.kind ?? "") : "";
		const isError = kind === "error";
		if (text === "") {
			if (this.machine.get() === STATES.THINKING) {
				if (isError) {
					const detail = String(reason.error?.message ?? reason.error?.code ?? "未知原因");
					// 错误优先走统一错误出口：语音场景下用户不看屏幕，静默失败等于没发生。
					// 注意 fail() 会按状态发 ERROR 事件，这里就不再补 REPLY/SPEAK_END。
					this.fail(new Error(detail));
					return;
				}
				if (kind === "blocked") {
					// 这一轮被闸门拒了（最典型：常驻会话在归档集合里），根本没跑。
					// 见过 `blocked` 就等于见过"提交成功却永远没回答"，必须说出来。
					this.notice(
						"这一轮没跑起来（会话被系统拦下了，通常是常驻会话被归档）。可在界面点开会话确认，或重启 DSH 让插件自动解除归档。",
						"error",
					);
					this.machine.send(EVENTS.REPLY);
					this.machine.send(EVENTS.SPEAK_END);
					return;
				}
				// 纯工具轮（只调工具、没有文本）是正常路径。
				this.notice("这一轮没有可播报的文字。", "info");
				this.machine.send(EVENTS.REPLY);
				this.machine.send(EVENTS.SPEAK_END);
			}
			return;
		}

		const wasSleeping = this.machine.get() === STATES.SLEEPING;
		if (wasSleeping) this.chime("wake");
		this.machine.send(EVENTS.AGENT_MESSAGE);
		this.patch({ answer: text });

		// 记下"我即将说什么"，供回声抑制比对。
		//
		// 放在**播报之前**而不是之后，是为了覆盖被中途打断的情形：用户
		// 打断时播报器被 cancel，那句回答已经念出去一部分，尾音照样会被
		// 录回来；若等播报返回再记，那条记录就永远补不上。窗口只有 30s，
		// 提前一点点记不会误伤用户的新指令。
		this.echoGuard.remember(text);

		const generation = this.generation;
		const result = await this.speaker.speak(text);
		if (generation !== this.generation) return;
		if (result.spoken === false && result.reason === "empty") {
			this.machine.send(EVENTS.SPEAK_END);
			return;
		}
		this.pushHistory("assistant", text);
		this.patch({ partial: "" });
		this.machine.send(EVENTS.SPEAK_END);
	}

	/** ── 用户可调的操作 ───────────────────────────────────────────── */

	/** 让助手主动说一句（界面上的"试听"按钮）。 */
	async say(text) {
		unlockAudio();
		const content = String(text ?? "").trim();
		if (content === "") return;
		if (this.machine.get() === STATES.OFF) {
			// 试听不改变状态机，直接借用播报器。
			await this.speaker.speak(content);
			return;
		}
		this.machine.send(EVENTS.AGENT_MESSAGE);
		// 试听同样要登记：否则"试听"的内容被录回去会被当成用户指令。
		this.echoGuard.remember(content);
		await this.speaker.speak(content);
		this.machine.send(EVENTS.SPEAK_END);
	}

	/**
	 * 打断当前播报（用户主动）。
	 *
	 * 与"助手自然说完"区分开的是**语义**，不是目标状态：
	 *   - **自然说完**（`handleTurnEnd` 播完）→ 发 `SPEAK_END`，落到**正在听**，
	 *     接着说话即可（不必再喊唤醒词）；
	 *   - **用户点击打断** → 发 `WAKE`，同样落到**正在听**。
	 *
	 * 两者现在都进 `ACTIVE`（用户点那个正在说话的球，意思基本是"我要说"），
	 * 且都从 `SPEAKING` 出发 —— 所以都会走那 700ms 回声静默期：
	 * 无论哪种情况，外放余响都已经存在，不能立刻开麦。
	 */
	interrupt() {
		this.speaker.cancel();
		if (this.machine.get() === STATES.SPEAKING) this.machine.send(EVENTS.WAKE);
	}

	/** 停止当前 turn（在会话里点"停止"）。 */
	async cancelTurn() {
		this.speaker.cancel();
		await this.session.cancel();
		if (this.machine.get() === STATES.THINKING) this.machine.send(EVENTS.ERROR);
	}

	/**
	 * 记一条历史。
	 * @param role - `user` | `assistant`。
	 * @param text - 文本。
	 */
	pushHistory(role, text) {
		const history = [...this.snapshot.history, { role, text, time: Date.now() }].slice(-HISTORY_LIMIT);
		this.patch({ history });
	}

	/**
	 * 在界面上显示一条短提示。
	 * @param message - 文本。
	 * @param kind - `info` | `warn` | `error`。
	 */
	notice(message, kind = "info") {
		clearTimeout(this.noticeTimer);
		this.patch({ notice: message, noticeKind: kind });
		this.noticeTimer = setTimeout(() => this.patch({ notice: "" }), NOTICE_TTL_MS);
	}

	/**
	 * 统一错误出口：界面提示 + 状态回退。
	 * @param error - 任意错误。
	 */
	fail(error) {
		const message = String(error?.message ?? error);
		warn("语音链路错误", message);
		this.patch({ error: message });
		// 记下调用来源。语音场景里"回答念出来了、同时却报错"这种自相矛盾
		// 的状态必须能一眼定位到是哪条路径调进来的（prompt 被拒 / 错误轮 /
		// 引擎异常），否则只能靠猜。
		this.failLog.push({
			at: Date.now(),
			message: message.slice(0, 200),
			status: this.machine.get(),
			from: (new Error().stack ?? "").split("\n").slice(1, 5).map((line) => line.trim()).join(" <- "),
		});
		if (this.failLog.length > 8) this.failLog.shift();

		if (message === "mic-denied") {
			this.notice("麦克风被拒绝。请在浏览器地址栏允许麦克风后重试。", "error");
			this.machine.send(EVENTS.STOP);
			this.patch({ powered: false });
			return;
		}
		if (message === "prompt-rejected") {
			this.notice("指令没能送进会话，请稍后重试。", "error");
			this.machine.send(EVENTS.ERROR);
			return;
		}
		if (message === "asr-unreachable") {
			// 浏览器识别（Chrome/Edge 的 Web Speech）把音频送到**境外云端**
			// 做识别。受限网络下这条永远不通 —— 实测 `www.google.com` 超时。
			// 界面上原样抛 `speech-network` 等于没说：用户既不知道是网络，
			// 也不知道下一步能做什么。这里翻译成能照着做的话，并**主动**
			// 尝试换一条能用的路（若配置里有）。
			// 标的是**浏览器识别这个族**，而不是 `snapshot.engine`。
			//
			// 为什么不按当前引擎标：`asr-unreachable` 这个错误码**只可能**来自
			// `WebSpeechEngine`（`engines/webspeech.js` 独家抛出），来源是确定的；
			// 而 `snapshot.engine` 在启动早期可能是 `none`（还没定下来），
			// 拿它去标会把 "none" 记进死名单、真正该禁的 webspeech 反而漏掉。
			// 又因为 `engineFamily()` 会把 `webspeech-fallback` 归到
			// `webspeech`，标一次就覆盖了降级态。
			this.markEngineDead("webspeech");
			const switched = this.tryFallbackFromDeadEngine();
			this.notice(
				switched
					? `浏览器识别连不上识别服务（它依赖境外云端）。已自动改用「${this.engineLabel(this.snapshot.engine)}」。`
					: "浏览器识别连不上识别服务（它依赖境外云端）。请在设置里改用内置本地识别或上游 ASR 端点。",
				"error",
			);
			return;
		}
		this.notice(`语音出错：${message}`, "error");
		const status = this.machine.get();
		if (status === STATES.THINKING) this.machine.send(EVENTS.ERROR);
	}

	/** 引擎名 → 中文标签（与界面面板同一套词）。 */
	engineLabel(name) {
		return (
			{
				webspeech: "浏览器识别",
				"webspeech-fallback": "浏览器识别（已降级）",
				http: "上游转写",
				"http-fallback": "上游转写（已降级）",
				ears: "内置本地 Whisper",
				sensevoice: "内置本地 SenseVoice",
				none: "无可用引擎",
			}[name] ?? name
		);
	}

	/**
	 * 引擎的**族名**：`webspeech-fallback` 与 `webspeech` 是同一个引擎的
	 * 两种标注（有没有降级），底层能力完全一样。
	 *
	 * 为什么必须归一：判断"这条路是不是已经确认不通"时若按字面比，
	 * 只把 `webspeech` 记进死名单、当前引擎却是 `webspeech-fallback` 时
	 * 就认不出，回退时又会把死引擎选回来。
	 * @param name - 引擎名。
	 * @returns 族名。
	 */
	engineFamily(name) {
		return String(name).replace(/-fallback$/, "");
	}

	/** 记下"这个引擎在这台机器上不可用"，供回退时跳过（按族归一）。 */
	markEngineDead(name) {
		this.deadEngines.add(this.engineFamily(name));
	}

	/**
	 * 从"已确认不可用"的引擎换到一条可用的路。
	 *
	 * 为什么需要它：`detectEars()` 在探测失败时会回退到
	 * `webSpeechAvailable() ? "webspeech" : ...` —— 只看**浏览器有没有这个 API**，
	 * 不看它**能不能真的工作**。于是受限网络下会出现"从 ears 退回 webspeech、
	 * 而 webspeech 恰好就是那个连不上服务的" —— 回退到一个已知坏掉的引擎，
	 * 用户再说话又是同一条报错。
	 *
	 * 候选按可靠性排序：dsh-ears（多后端，确认可用才选）→ 上游 HTTP → 其余。
	 * @returns 是否真的换了。
	 */
	tryFallbackFromDeadEngine() {
		if (!this.deadEngines.has(this.engineFamily(this.snapshot.engine))) return false;
		// `ears` 的可否用是异步探测出来的，这里只能信 `earsAvailable` 这个结论；
		// 贸然切过去会与 `detectEars()` 的失败回退形成来回横跳。
		if (this.earsAvailable && !this.deadEngines.has("ears")) {
			this.swapEngine("ears");
			return true;
		}
		if (this.speechAvailable && !this.deadEngines.has("sensevoice")) {
			this.swapEngine("sensevoice");
			return true;
		}
		for (const name of ["http", "http-fallback", "webspeech", "webspeech-fallback"]) {
			if (this.deadEngines.has(this.engineFamily(name))) continue;
			if (!this.engineUsable(name)) continue;
			this.swapEngine(name);
			return true;
		}
		return false;
	}

	/**
	 * 某个引擎"看起来能用吗"（纯本地判据，不打网络）。
	 * @param name - 引擎名。
	 * @returns 是否可用作回退目标。
	 */
	engineUsable(name) {
		if (this.deadEngines.has(this.engineFamily(name))) return false;
		if (name === "webspeech" || name === "webspeech-fallback") return webSpeechAvailable();
		if (name === "http" || name === "http-fallback") return this.config.asr.httpReady && httpAsrAvailable();
		if (name === "ears") return this.earsAvailable === true;
		if (name === "sensevoice") return this.speechAvailable === true;
		return false;
	}

	/** 释放所有资源。 */
	dispose() {
		this.disposed = true;
		this.stopReportPolling();
		clearTimeout(this.idleTimer);
		clearTimeout(this.noticeTimer);
		clearTimeout(this.echoTimer);
		this.turnGate.dispose();
		this.engine.stop();
		this.speaker.cancel();
		// 先释放问答桥再释放会话：桥持有会话投影的订阅，反过来会留下
		// 一个指向已释放 binding 的回调（下次变更时在里面读空值）。
		this.questions.dispose();
		this.session.dispose();
		this.listeners.clear();
	}
}
