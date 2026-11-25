/**
 * 控制器单例。
 *
 * ## 为什么用模块级单例而不是 Cordis 服务
 *
 * 语音控制器需要被两处访问：槽里的 React 组件（渲染状态）与
 * 全局快捷键（监听键盘）。它们分属不同 fiber，用一个模块级引用最直接。
 * 若走 `ctx.reflect.provide`，就得处理"消费者早于提供者"的时序，
 * 对一个自包含插件来说是多余复杂度。
 *
 * 插件卸载时 `clearController()` 会清掉引用，React 组件那边读到 `null`
 * 会直接不渲染，不会访问到已释放的引擎。
 */

import { asrStatus } from "./runtime.js";

/** 当前控制器。 */
let current = null;

/**
 * 设置控制器。
 *
 * 附带一个**开发调试钩子** `globalThis.__xfvDebug`：`ask(text)` 直接把指令
 * 送进语音会话（跳过 ASR，但走完整的润色→prompt→事件→状态机链路），
 * `snapshot()` 取当前状态。真浏览器验证（tools/cdp-probe.mjs）靠它做
 * 端到端断言 —— 生产环境不删也没关系：它只暴露本来就要走公开 API 的
 * 两个方法，且 `ask` 前必须已有一次用户手势（音频上下文解锁）。
 *
 * ## 排障三件套
 *
 * 语音链路最难查的是"症状指向错误方向"的故障（例如**回答念出来了、
 * 界面却同时挂着一条报错**）。所以除了状态快照，另外暴露三条只读诊断线：
 *
 * | 钩子 | 回答的问题 |
 * |---|---|
 * | `prompts()` | `prompt()` 的原始返回是什么（提交到底被接受没有） |
 * | `fails()` | 最近几次错误的**调用来源栈**（是谁调的 `fail()`） |
 * | `hydration()` | 事件窗口的水合状态（历史是不是被当成新事件了） |
 *
 * 这三条一起看才能定案：只看状态会以为是"提交被拒"，
 * 实际可能是"提交成功、但旧历史被重放"。全部只读、异常不外抛。
 * @param controller - 语音控制器实例。
 */
export function setController(controller) {
	current = controller;
	// 状态迁移轨迹。只读、有界（50 条）。
	//
	// 为什么需要它：状态迁移是**转瞬即逝**的。靠外部轮询快照去判断
	// "刚才是不是经过 speaking"，会在播报很短时整段漏掉 —— 于是
	// "播报期其实停在 thinking"这种 bug 能侥幸通过测试（真机上已经踩过）。
	// 记录轨迹后，"思考→播报→待机"这条链路可以被**确定性地**断言。
	const trace = [];
	controller.machine.subscribe((to, from, event) => {
		trace.push(`${from}>${to}:${event}`);
		if (trace.length > 50) trace.shift();
	});
	if (typeof globalThis !== "undefined") {
		globalThis.__xfvDebug = {
			// 复刻真实链路的前置状态：standby 先唤醒、off 先启动，
			// 否则状态机停在待机，COMMAND 迁移不生效。
			ask: async (text) => {
				const status = controller.getSnapshot().status;
				if (status === "off") controller.start();
				else if (status === "standby" || status === "sleeping") controller.wake();
				return controller.runCommand(String(text ?? ""));
			},
			steer: (text) => controller.session?.steer(String(text ?? "")),
			wake: () => controller.wake(),
			/**
			 * 模拟识别器产出一个**片段**（走真实的 `handleFinal`，含回声抑制
			 * 与轮次门槛）。`ask` 是"绕过识别直接提交"，`feed` 是"识别到了一段
			 * 话"—— 验证"静音满阈值才提交"必须用后者，因为门槛就在这条路径上。
			 */
			feed: (text) => controller.handleFinal(String(text ?? "")),
			/**
			 * 把一条**真实形状的会话事件**推进真实入口（`VoiceSession.handleEvent`）。
			 *
			 * ## 为什么必须有它
			 *
			 * 提问旁听的**主路径是事件流**，而单测里 `observeEvent` 是我直接调的
			 * —— 绕过了 `VoiceSession`。只测 `observeEvent` 等于"模块是对的，
			 * 但可能压根没被调用"，本项目已经栽过一次（`TurnGate` 没被
			 * `handleFinal` 调用，类单测照样全绿）。
			 *
			 * 这条与 `feed()` 是同源思路：`feed()` 走真实 `handleFinal`，
			 * `feedEvent()` 走真实 `handleEvent`。两者都**不许绕过接线层**。
			 *
			 * 注意：`tool/call` 事件在 `handleEvent` 里只触发提问旁听那一条
			 * （`switch` 里没有它的分支），所以喂进去不会污染 turn 状态。
			 *
			 * @param event - 会话事件（形状 `{ type, seq, time, data }`）。
			 * @returns 喂完之后问答桥的诊断快照（便于一步断言计数）。
			 */
			feedEvent: (event) => {
				controller.session.handleEvent(event);
				return controller.questions.inspect();
			},
			/** 立即提交当前这一轮（等同单击语音球），返回是否真的提交了。 */
			submit: () => controller.submitTurn(),
			/**
			 * 模拟"agent 回完话，回答落地"——直接走 `handleTurnEnd` 的**主路径**
			 * （`AGENT_MESSAGE` → 播报 → `SPEAK_END`）。
			 *
			 * ## 为什么必须单独有这么一个钩子
			 *
			 * 真机上跑回环时，`turn/end` 的 text 常常是**空的**：模型没配好、
			 * 或这一轮只调了工具。空文本走的是另一条分支（`notice` + `REPLY`），
			 * 于是"播报期归错状态"这个 bug **在真机上一条断言都碰不到** ——
			 * 它藏那么久的直接原因就是这个。要确定性地覆盖主路径，只能直接
			 * 把一段有文字的 turn/end 送进去。
			 *
			 * @param text - 回答文本。
			 * @returns 播报完成后 resolve。
			 */
			turnEnd: (text) =>
				controller.handleTurnEnd({ text: String(text ?? ""), reason: null, turn: null }),
			/**
			 * 直接把状态机拨到某个状态（**仅测试用**，不触发订阅者）。
			 *
			 * ## 为什么需要
			 *
			 * 要复现"回答落地时正处在思考中"这个场景，本来得先真的提交一轮、
			 * 等状态进 `thinking`。但真机上那一轮会**同时**产生一个空文本的
			 * `turn/end`（模型没配好、或只调了工具），它会抢先走完
			 * `reply → speak-end`，把状态带离 `thinking` —— 断言于是变成
			 * 一场和真实事件流的赛跑，偶发假失败。
			 *
			 * 把状态直接摆好再喂回答，可以**确定性地**只测控制器这一段接线，
			 * 不掺进会话层。会话层到控制器的那段接线由既有流程覆盖，各测各的。
			 *
			 * @param state - 目标状态名（`STATES` 里的值）。
			 * @returns 拨好之后的状态。
			 */
			forceState: (state) => {
				controller.machine.state = String(state ?? "");
				return controller.machine.get();
			},
			snapshot: () => controller.getSnapshot(),
			/**
			 * 状态迁移轨迹（最近的 `旧>新:事件` 列表）。
			 *
			 * 判"播报期到底停在哪个状态"必须看它 —— 轮询快照会漏掉短促的
			 * 中间状态，"播报归错状态"这类 bug 正是这样躲过测试的。
			 * @param count - 取尾部多少条（默认全部，最多 50）。
			 */
			trace: (count) => (typeof count === "number" && count > 0 ? trace.slice(-count) : trace.slice()),
			/** 最近几次错误的调用来源（排障"念出来了却又报错"）。 */
			fails: () => controller.failLog ?? [],
			/** 最近几次 `prompt()` 的原始返回（排障"提交到底被接受没有"）。 */
			prompts: () => controller.session?.promptLog ?? [],
			/**
			 * 轮次门槛状态（排障"说了半天没反应 / 提交太早"）。
			 *
			 * `pending=false` 且 `fragments=0` 却"感觉说了话"，
			 * 通常是那几句被回声抑制吃掉了 —— 对照 `echo()` 看。
			 */
			turn: () => controller.turnGate?.inspect() ?? null,
			/** 回声抑制状态：`suppressed` 大于 0 说明确实拦下了自说自话。 */
			echo: () => controller.echoGuard?.inspect() ?? null,
			/**
			 * dsh-ears 探测结论（排障"本地 Whisper 配了却不通"）。
			 *
			 * 为什么必须有这一条：`engine` 从 `ears` 掉到别的引擎时，
			 * 界面上球**照旧还在**、只是识别走了另一条路 —— 光看界面
			 * 完全看不出来。而"本地 Whisper 到底有没有接上"还要再分两层：
			 *
			 *   - `available`：`dshEars.transcribe` 通不通；
			 *   - `needsWav`：当前后端是不是**只吃 16 kHz PCM16 WAV** 的那种。
			 *
			 * 第二层是本项目最贵的一课：模型下好了、运行时也正常、
			 * 后端也选了本地 Whisper，但发出去的是 webm/opus，
			 * 宿主侧 `assertPcm16Wav` 直接拒 —— 报错还完全指不到"格式"。
			 * 留着这条，真机上一条断言就能确认"它知道该转 WAV"。
			 *
			 * @returns `{ available, needsWav, backends }`。
			 */
			ears: () => ({
				available: controller.earsAvailable,
				via: controller.earsVia,
				needsWav: controller.earsNeedsWav === true,
				backends: controller.earsBackends ?? [],
				// 各条取法的命中情况：命名空间取不到时靠它定位方向。
				paths: controller.earsPaths ?? [],
				// ctx 有没有那几个口：区分"没这个方法"与"服务还没注册上来"。
			shape: controller.earsShape ?? null,
		}),
		/**
		 * DSH 官方 speech 识别（SenseVoice）的探测结论（只读，供真机断言）。
		 *
		 * 与 `ears()` 同一思路：把可用性、语言清单、命名空间各取法的命中
		 * 情况摊开，才能区分"没装 bundle"与"装了但注册名不同 / 取太早"。
		 */
		speech: () => ({
			available: controller.speechAvailable === true,
			via: controller.speechVia,
			languages: Array.isArray(controller.speechLanguages) ? controller.speechLanguages.slice() : [],
			paths: Array.isArray(controller.speechPaths) ? controller.speechPaths : [],
		}),
		/**
		 * V2.1：直接问本插件的内置识别 API（绕过 remote 探测），供真机断言
		 * "两个外部插件都没装时，识别仍然可用"。
		 */
		localAsr: async () => {
			try {
				return await asrStatus();
			} catch (error) {
				return { available: false, error: String(error?.message ?? error) };
			}
		},
		/** 当前 ASR 偏好与生效引擎（真机验证 UI 选择持久化用）。 */
		asr: () => ({
			preference: controller.asrPreference ?? null,
			engine: controller.getSnapshot().engine,
		}),
			/**
			 * 再探一次 dsh-ears（排障"时序竞争"用）。
			 *
			 * 为什么需要：`detectEars()` 在 `apply` 之后**只跑一次**，
			 * 探不到就永久降级。如果真相是"本插件 apply 早于 dsh-ears
			 * 注册服务"，那"晚点再探一次能探到"就是这个假设的直接证据
			 * —— 而这条证据靠 `snapshot()` 永远看不出来。
			 *
			 * @returns 重探后的引擎名与探测结论。
			 */
			retryEars: async () => {
				await controller.detectEars();
				return { engine: controller.getSnapshot().engine, ears: globalThis.__xfvDebug.ears() };
			},

			/**
			 * V1.7：当前状态快照（只读）。供真浏览器探针验证"命令是否被识别"
			 * —— routeVia / heard / lastReport 这些字段只在快照里，DOM 上不全有。
			 */
			snapshot: () => controller.getSnapshot(),

			// ── 跨会话（需求 ②）─────────────────────────────────────────
			//
			// 这四条都是控制器公开方法的**透传**，不额外暴露内部结构：
			// 验"切过去了"和"切完话真的进新会话"必须分开断言 ——
			// 前者只看 `sessionId`，后者要看 `prompts()` 里那条 prompt 的
			// 落点，而落点只能通过 `ask()` 真跑一轮才能确认。
			/** 列出可投喂的会话（本地投影，不发请求）。 */
			sessions: () => controller.listSessions(),
			/** 拉一次宿主最新列表（RPC）。 */
			refreshSessions: () => controller.refreshSessions(),
			/** 切到指定会话；返回是否成功。 */
			switchSession: (id) => controller.switchSession(String(id ?? "")),
			/** 新建会话并切过去；返回新 id 或 null。 */
			newSession: (options) => controller.newSession(options ?? {}),
			/** 切回常驻助手。 */
			backToAssistant: () => controller.backToAssistant(),
			/** 当前绑定的人类可读描述 + 原始 mode（断言用）。 */
			sessionTarget: () => ({
				...controller.session.describe(),
				mode: controller.session.mode,
				pinnedId: controller.session.pinnedId,
			}),
			// ── 提问应答（只做「模型提问」，不碰「工具审批」）──────────────
			//
			// 这几条让"念问题 → 语音作答 → 提交"能被真机验证。分开暴露
			// 而不是只给一个 `answer()`，是因为**每一步都可能单独坏**：
			// 桥没接上（`question()` 恒为 null）、匹配没命中（`tryAnswer`
			// 返回 false）、提交被拒（`submit` 的 reason）。合成一个方法的话，
			// 失败时只能看到"没生效"，不知道坏在哪一层。
			/** 当前等答的问题（`null` = 没有）。 */
			question: () => controller.getSnapshot().question,
			/**
			 * 问答桥是否已记下当前会话 id。
			 *
			 * 语义要读准：`attach(sessionId, binding)` **无条件**先记 `sessionId`
			 * 再去试投影，所以这条只说明"会话绑过了"，**不等于投影接上了**
			 * （投影在 `questionBridge().projectionAttached`）。
			 *
			 * 而"到底能不能收到问题"也**不看这两条** —— 主路径是事件流
			 * （`observeEvent`），它连 `attach` 都不需要。判"收到没有"要看
			 * `questionBridge()` 的 `known` / `announced`。
			 */
			questionsAttached: () => controller.questions.sessionId !== null,
			/**
			 * 问答桥的内部计数（排障"念不出来"到底是哪一层断的）。
			 *
			 * | 字段 | 含义 |
			 * |---|---|
			 * | `projectionAttached` | 投影是否接上（timed 模式才有意义） |
			 * | `known` | 事件流已发现的提问调用数 |
			 * | `announced` | 已播报的提问数 |
			 * | `answered` | 已提交作答数 |
			 * | `states` | 各 callId 的权威 state（只有 timed 投影会给） |
			 */
			questionBridge: () => controller.questions.inspect(),
			/**
			 * 把一段文本当成"对当前问题的回答"走一遍（**不发声、不改状态**）。
			 *
			 * 与 `ask()` 的区别：`ask()` 直接提交给模型；这条走
			 * `tryAnswerQuestion`（匹配 → 提交作答），用于验证匹配与提交。
			 * @param text - 模拟的识别文本。
			 * @returns 是否被当作回答处理。
			 */
			answerQuestion: (text) => controller.tryAnswerQuestion(String(text ?? "")),
			/**
			 * 最近一次"把文本当回答"的判定结果（排障"为什么没答上"）。
			 *
			 * `answerQuestion()` 只返回布尔，于是"没匹配上"和"匹配了但提交被拒"
			 * 在真机上**看起来一样** —— 本项目反复踩这个坑。这里把内部判定
			 * 摊开：`outcome` ∈ `no-question` / `no-match` / `multi-question` /
			 * `not-answerable` / `failed` / `submitted`。
			 * @returns `{ text, outcome, reason?, selected? }` 或 `null`。
			 */
			lastAnswerAttempt: () => controller.lastAnswerAttempt ?? null,
			/**
			 * 清掉"当前待答问题"（**仅测试用**）。
			 *
			 * 为什么需要：`answerWith` 读的是快照里的 `question`，喂过一条
			 * `tool/call` 之后它就非空了 —— 想测"无问题时如实报 `no-question`"
			 * 这条分支，就必须先能把它清掉。
			 */
			clearQuestion: () => {
				controller.patch({ question: null });
				return true;
			},
			/**
			 * 直接按选项作答（跳过文本匹配），用于验证提交链路本身。
			 * @param selected - 选项标签数组。
			 */
			answerWith: (selected) => {
				const current = controller.getSnapshot().question;
				if (current === null || current === undefined) return Promise.resolve({ ok: false, reason: "no-question" });
				const first = current.questions[0];
				if (first === undefined) return Promise.resolve({ ok: false, reason: "no-question" });
				return controller.questions.submit(current.callId, {
					answers: [{ id: first.id, selected: Array.isArray(selected) ? selected.map(String) : [] }],
				});
			},
			/**
			 * 模拟"助手刚念了一句话"，用于验证回声抑制。
			 * @param text - 刚播报的文本。
			 */
			remember: (text) => controller.echoGuard?.remember(String(text ?? "")),
			/**
			 * 事件窗口的水合状态（排障"历史被当成新事件")。
			 *
			 * 常驻 agent 的历史**不是**在 retain 时同步就位的：绑定时窗口可能
			 * 还是空的（水位线 = −1），随后历史整批灌入，于是旧的 `turn/end`
			 * 会被当成刚发生的事处理。
			 */
			hydration: () => {
				const session = controller.session;
				const binding = session?.binding;
				const snap = binding?.eventSource?.getSnapshot?.();
				const entries = snap?.entries ?? [];
				return {
					bindEntryCount: session?.bindEntryCount ?? null,
					cursorAtBind: session?.cursorAtBind ?? null,
					boundAt: session?.boundAt ?? null,
					floorTime: session?.floorTime ?? null,
					skippedHistory: session?.skippedHistory ?? null,
					cursorNow: session?.cursor ?? null,
					entryCountNow: entries.length,
					snapshotKeys: snap === null || typeof snap !== "object" ? null : Object.keys(snap),
					snapshotMeta: snap === null || typeof snap !== "object" ? null : safeMeta(snap),
				};
			},
			/**
			 * 事件窗口的原始条目（`seq` / `time` / `type`）。
			 *
			 * 用来判定"事件自带的 `time` 是不是可靠的过去/现在分界"：
			 * 若历史事件的 `time` 一律早于 `boundAt`，就可以用 `time` 做水位线，
			 * 不必依赖"绑定时窗口里有没有东西"这个不可靠的前提。
			 * @param count - 取尾部多少条（默认 60）。
			 */
			rawWindow: (count) => {
				const binding = controller.session?.binding;
				const entries = binding?.eventSource?.getSnapshot?.()?.entries ?? [];
				const limit = typeof count === "number" && count > 0 ? count : 60;
				return entries
					.slice(-limit)
					.filter((entry) => entry?.type === "event")
					.map((entry) => ({
						seq: entry.event?.seq ?? null,
						time: entry.event?.time ?? null,
						type: entry.event?.type ?? null,
						timeType: typeof entry.event?.time,
					}));
			},
			/**
			 * 播报账本（需求②）：已播到哪、记住了哪些内容、是不是真落盘了。
			 *
			 * ## 为什么必须暴露这条
			 *
			 * "刷新后不再重复播报"这件事**只有跨会话才观察得到** —— 单测里
			 * 建两次控制器可以覆盖逻辑，但真机上"到底有没有写进 localStorage"
			 * （隐私模式 / 配额满 / 被别的插件清了）只能靠这条看。
			 * `persistent: false` 就是那类静默降级的直接证据。
			 *
			 * @returns `{ ledger, seq }`。
			 */
			playback: () => ({
				ledger: controller.ledger?.snapshot?.() ?? null,
				seq: controller.seqWatermark?.snapshot?.() ?? null,
				interactionCursor: controller.interactionCursor ?? null,
				reportCursor: controller.reportCursor ?? null,
				interactionsAvailable: controller.interactionsAvailable === true,
			}),
			/**
			 * 清掉播报账本（**仅测试用**）：让"首次打开"这条路径可复现。
			 * @returns 清完之后的账本快照。
			 */
			resetPlayback: () => {
				controller.ledger?.clear?.();
				controller.seqWatermark?.clear?.();
				controller.interactionCursor = undefined;
				controller.reportCursor = undefined;
				controller.cursorSeeded = false;
				return globalThis.__xfvDebug.playback();
			},
			// 最近 40 条会话事件（type + 摘要），排障 turn 为何空转用。
			// 注意事件负载在 `data` 下（见 session.js handleEvent 的说明）。
			events: () => {
				const binding = controller.session?.binding;
				const snap = binding?.eventSource?.getSnapshot?.();
				const entries = snap?.entries ?? [];
				return entries
					.slice(-40)
					.filter((entry) => entry?.type === "event")
					.map((entry) => {
						const event = entry.event;
						const payload = event?.data !== null && typeof event?.data === "object" ? event.data : event;
						const brief =
							event?.type === "assistant/message"
								? `text=${(payload?.message?.content ?? [])
										.filter((block) => block?.type === "text")
										.map((block) => block.text)
										.join(" ")
										.slice(0, 120)}`
								: event?.type === "turn/end"
									? `reason=${JSON.stringify(payload?.reason ?? null)}`
									: event?.type?.startsWith("agent/inbox")
										? `data=${JSON.stringify(payload).slice(0, 400)}`
										: "";
						return `${event?.seq} ${event?.type} ${brief}`.trim();
					});
			},
		};
	}
}

/** 取控制器（可能为 `null`）。 */
export function getController() {
	return current;
}

/**
 * 取事件窗口快照里与"水合进度"相关的浅层字段（只读、防异常、限长）。
 * @param snapshot - `getSnapshot()` 的返回。
 * @returns 精简后的键值（值一律转成字符串或数字）。
 */
function safeMeta(snapshot) {
	const meta = {};
	for (const key of Object.keys(snapshot)) {
		if (key === "entries") continue;
		const value = snapshot[key];
		const type = typeof value;
		meta[key] = type === "string" || type === "number" || type === "boolean" ? value : type;
	}
	return meta;
}

/** 清除引用（插件卸载时调用）。 */
export function clearController() {
	current = null;
	if (typeof globalThis !== "undefined" && "__xfvDebug" in globalThis) {
		delete globalThis.__xfvDebug;
	}
}
