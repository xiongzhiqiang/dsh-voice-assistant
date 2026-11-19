/**
 * 常量与状态词表。
 *
 * 单独成文件的原因：状态名同时被状态机、UI 文案、日志三处消费。
 * 散着写字面量，改名时必然漏一处（表现为日志说 `awake`、界面显示 `active`，
 * 排查时对不上号）。
 */

/** 本机 API 前缀，必须与宿主半 `lib/routes.js` 的 `API_PREFIX` 一致。 */
export const API_PREFIX = "/plugins/dsh-voice-assistant/api";

/** 六态状态机。 */
export const STATES = {
	/** 未启用：没有申请麦克风，没有识别，也不占音频设备。 */
	OFF: "off",
	/** 待机：麦克风常开，只等唤醒词。这是"一直在线"的状态。 */
	STANDBY: "standby",
	/** 已唤醒：正在听这一轮指令。 */
	ACTIVE: "active",
	/** 思考中：指令已进会话，等 agent 回话。 */
	THINKING: "thinking",
	/** 播报中：正在念回答。 */
	SPEAKING: "speaking",
	/** 休眠：麦克风已释放，只能靠点击/提示音/agent 消息唤醒。 */
	SLEEPING: "sleeping",
};

/** 界面文案（中文，直接显示）。 */
export const STATE_LABEL = {
	[STATES.OFF]: "未启用",
	[STATES.STANDBY]: "待机中",
	[STATES.ACTIVE]: "正在听",
	[STATES.THINKING]: "思考中",
	[STATES.SPEAKING]: "播报中",
	[STATES.SLEEPING]: "休眠",
};

/** 状态 → 语音球主色（与 accent 叠加，不改用户设的强调色）。 */
export const STATE_TONE = {
	[STATES.OFF]: "muted",
	[STATES.STANDBY]: "calm",
	[STATES.ACTIVE]: "live",
	[STATES.THINKING]: "work",
	[STATES.SPEAKING]: "speak",
	[STATES.SLEEPING]: "sleep",
};

/**
 * 事件名。
 *
 * 用 `动词` 而不是 `状态` 命名：`wake` 而不是 `awake`、`reply` 而不是 `replied`。
 * 状态机处理的是"发生了什么"，不是"现在是什么" —— 后者会把推断逻辑
 * 从状态机里漏到调用方。
 */
export const EVENTS = {
	START: "start",
	STOP: "stop",
	WAKE: "wake",
	COMMAND: "command",
	THINKING: "thinking",
	REPLY: "reply",
	SPEAK_END: "speak-end",
	AGENT_MESSAGE: "agent-message",
	IDLE: "idle",
	SLEEP: "sleep",
	ERROR: "error",
	RESUME: "resume",
};

/**
 * 识别器把连续语音切成**片段**所需的静音时长（毫秒）。
 *
 * 注意这是**引擎内部的切段粒度**，不是"一轮说完了"的判据 ——
 * 片段会被上层（`controller`）累加成整轮，见 `SILENCE_SUBMIT_MS`。
 *
 * 为什么引擎还要切：Web Speech 会因静默自动结束会话、VAD 段太长会拉高
 * 转写延迟；切成小段可以让字幕实时出现、让转写尽早开始。
 * 这个值**越小**，"一轮结束"的判定越贴近 `SILENCE_SUBMIT_MS`
 * （总延迟 ≈ 本值 + `SILENCE_SUBMIT_MS`），所以保持得比较短。
 */
export const UTTERANCE_SETTLE_MS = 900;

/**
 * 判定"这一轮说完了"所需的静音时长（毫秒），默认 **5 秒**。
 *
 * ## 为什么不能贴着引擎的切段粒度
 *
 * 旧设计把"引擎切段"直接当成了"一轮说完了"：900ms（网页识别）/ 700ms（VAD）
 * 静音就提交。这对**打字**够用，对**说话**完全不够 —— 人表达一段完整意图时，
 * 句中的停顿（想词、换气、列举）轻松超过 1 秒。结果助手在用户说到一半时
 * 就把半句话提交上去，用户看到的是"它只回了我前半句"。
 *
 * 现在的语义：**声音停止超过 5 秒才算一轮结束**。
 * 中途转录照常累积、界面照常显示，只是**不提交**。
 *
 * ## 为什么是 5 秒
 *
 * 这个值要同时满足两个方向的要求，是个**折中**：
 *   - 下界由"人说话的自然停顿"决定：想词、换气约 2–5 秒，
 *     要**大于**典型停顿，否则回到"半句被截"。
 *   - 上界由"等待是否像卡死"决定：数值越大越不会打断用户，
 *     但每轮都要多等这么久才得到回应。
 *
 * 历史：最初按需求设成 60 秒（宁可多等也不截半句），实测「说完要干等
 * 一分钟」太长 → 收到 10 秒；2026-11-19 按用户要求再收到 **5 秒**，
 * 进一步缩短等待。若发现"话说到一半被提交"，调大 `cordis.patch.yml`
 * 的 `turn.silenceMs` 即可（下限 3s / 上限 10min）。注意单击语音球始终
 * 是"立即提交"的逃生口，与这个阈值无关。
 *
 * ## 逃生口
 *
 * 不必干等：单击语音球（`controller.primaryAction`）＝「我说完了，现在提交」。
 *
 * 唤醒词判定**不受**它影响：走的是中间结果（`handlePartial`），
 * 喊「小凤」依旧实时响应，否则用户会以为喊不动。
 */
export const SILENCE_SUBMIT_MS = 5000;

/**
 * 播报结束后，重新打开麦克风前的保护间隔（毫秒）。
 *
 * `speechSynthesis` / `HTMLAudio` 的 `onend` 可能在**音频真正放完**之前就触发
 * （外放设备还有余响）。若此时立刻重开麦克风，助手会把自己刚念的尾音录回去、
 * 当成用户的新指令提交 —— 这正是"自说自话"闭环的声学入口。
 * 留一段静默再开麦，从物理上切断这条回路。
 *
 * 取值权衡：太短挡不住余响，太长会吃掉用户抢答的第一个词。
 * 700ms 约等于典型房间混响 + 一句短词的时长。
 */
export const ECHO_GUARD_MS = 700;

/**
 * "回声"比对的回溯窗口（毫秒）。
 *
 * 只把手动/播报说过的文本在近一段时间内视为可能的回声来源；
 * 太久以前说过的话不该再挡住用户的新指令（用户完全可能重复同一个词）。
 */
export const ECHO_WINDOW_MS = 30000;

/**
 * 单轮累积的硬上限（毫秒）。
 *
 * 判据是"静音满 `SILENCE_SUBMIT_MS` 才算说完"，那么**连续不断**说话就永远
 * 不会触发提交：用户唠 10 分钟，累积文本会无限膨胀，最后把模型的上下文撑爆。
 * 这是纯逻辑上的缺陷，不是用户意图，所以加一道安全阀：到点无论如何提交一次。
 * 取 5 分钟 —— 长到不会打断任何正常表达，短到能兜住极端情况。
 */
export const MAX_TURN_MS = 300000;

/** 唤醒后，如果一句话都没听到，多久回到待机（避免一直"正在听"却不回应）。 */
export const WAKE_GRACE_MS = 12000;

/** 播报分句长度上限：过长的句子会一次性占满 TTS 队列，打断响应变慢。 */
export const SPEECH_CHUNK_MAX = 80;
