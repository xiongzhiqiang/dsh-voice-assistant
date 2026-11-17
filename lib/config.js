/**
 * 配置归一化（宿主半）。
 *
 * ## 为什么宿主半要重做一遍归一化
 *
 * `cordis.patch.yml` 是**用户可编辑**的 YAML，没有任何 schema 校验：类型写错、
 * 数值越界、枚举拼错都是常态。客户端半不能因为一个 `rate: "1.2"`（字符串）
 * 就整片语音链路崩掉，所以把「容错 + 夹取」全部收在宿主半，客户端拿到的
 * 永远是已归一化的值。
 *
 * ## 为什么密钥不进客户端的配置
 *
 * ASR/TTS 走宿主代理时，`apiKey` 只应存在于宿主进程。`clientConfig()`
 * 显式做白名单拷贝（而不是黑名单删除）：以后往配置里加敏感字段时，
 * 忘记加进白名单只会"功能没生效"，不会"密钥泄漏到浏览器"。
 */
import { DEFAULT_PERSONA } from "./agent.js";
import { normalizeWorkers, workerTargets } from "./workers.js";
import { ROUTE_LIMITS } from "./router.js";

/** 语速夹取范围（speechSynthesis 与多数 TTS 端点都接受 0.5–2）。 */
const RATE_MIN = 0.5;
const RATE_MAX = 2;

/** 休眠超时夹取范围：低于 5s 会在正常一句话的停顿里误睡，高于 10min 等于没有休眠。 */
const IDLE_MIN = 5000;
const IDLE_MAX = 600000;

/** 单段录音夹取范围：低于 2s 录不全一句话，高于 60s 会让转录延迟不可接受。 */
const SEG_MIN = 2000;
const SEG_MAX = 60000;

/** 润色超时夹取范围：低于 2s 几乎必然超时，高于 30s 用户已经说完下一句了。 */
const POLISH_MIN = 2000;
const POLISH_MAX = 30000;

/** 委托任务的完成等待夹取范围：太短会误杀长任务，太长会让卡住的任务永远占着队列。 */
const JOB_TIMEOUT_MIN = 30000;
const JOB_TIMEOUT_MAX = 900000;

/** 审批/提问的语音应答窗口夹取范围：太短听不完问题，太长 agent 干等。 */
const ANSWER_MIN = 5000;
const ANSWER_MAX = 300000;

/**
 * "一轮说完"的静音阈值夹取范围。
 *
 * 下界 3s：再短就回到"一句一提交"的老毛病，用户说到一半就被打断。
 * 上界 10min：再长等于永不自动提交，只能靠单击语音球，交互上不可接受。
 *
 * 默认取 10s（见 `normalizeConfig`）。为什么不是更长：人说话的句中停顿
 * 一般在 2–5 秒，10s 已能稳稳跨过；再往上加只会让每轮多等，边际收益为零。
 */
const SILENCE_MIN = 3000;
const SILENCE_MAX = 600000;

/** 单轮硬上限夹取范围：必须**大于**静音阈值才有意义（否则静音判据永远轮不到）。 */
const MAXTURN_MIN = 10000;
const MAXTURN_MAX = 1800000;

/**
 * 取字符串，剥空白；非字符串或空串时用兜底值。
 * @param value - 原始值。
 * @param fallback - 兜底值。
 */
function text(value, fallback) {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	return trimmed === "" ? fallback : trimmed;
}

/**
 * 取字符串数组（去空、去重、保序）。
 * @param value - 原始值；接受字符串（单个）或数组。
 * @param fallback - 兜底数组。
 */
function textList(value, fallback) {
	if (typeof value === "string") {
		const one = value.trim();
		return one === "" ? fallback : [one];
	}
	if (!Array.isArray(value)) return fallback;
	const out = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (trimmed === "" || out.includes(trimmed)) continue;
		out.push(trimmed);
	}
	return out.length === 0 ? fallback : out;
}

/**
 * 取布尔；只认真正的布尔值，避免 `"false"` 被当成真。
 * @param value - 原始值。
 * @param fallback - 兜底值。
 */
function bool(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}

/**
 * 取数字并夹取；非有限数时用兜底值。
 * @param value - 原始值（字符串数字也接受，YAML 里引号很常见）。
 * @param fallback - 兜底值。
 * @param min - 下界。
 * @param max - 上界。
 */
function number(value, fallback, min, max) {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

/**
 * 取枚举值；不在白名单内时用兜底值（并保持大小写不敏感，`WebSpeech` 也认）。
 * @param value - 原始值。
 * @param allowed - 白名单。
 * @param fallback - 兜底值。
 */
function oneOf(value, allowed, fallback) {
	if (typeof value !== "string") return fallback;
	const lowered = value.trim().toLowerCase();
	for (const candidate of allowed) {
		if (candidate.toLowerCase() === lowered) return candidate;
	}
	return fallback;
}

/**
 * 归一化一个 HTTP 端点配置。
 *
 * `baseURL` 为空 = 该能力未配置（客户端据此把对应引擎标为不可用），
 * 而不是"用默认值偷偷发请求" —— 语音数据外发必须由用户显式填地址。
 *
 * @param raw - 原始配置。
 * @param model - 默认模型名。
 * @param voice - 默认音色名（仅 TTS 用）。
 */
function endpoint(raw, model, voice) {
	const source = raw !== null && typeof raw === "object" ? raw : {};
	const out = {
		baseURL: text(source.baseURL, ""),
		apiKey: text(source.apiKey, ""),
		model: text(source.model, model),
	};
	if (voice !== undefined) out.voice = text(source.voice, voice);
	if (source.maxSegmentMs !== undefined) out.maxSegmentMs = number(source.maxSegmentMs, 15000, SEG_MIN, SEG_MAX);
	return out;
}

/**
 * 归一化整份插件配置。
 * @param raw - `cordis.patch.yml` 里的 `config`。
 * @returns 结构稳定的配置对象（字段齐全，无 `undefined`）。
 */
export function normalizeConfig(raw) {
	const source = raw !== null && typeof raw === "object" ? raw : {};

	const wake = source.wake !== null && typeof source.wake === "object" ? source.wake : {};
	const sleep = source.sleep !== null && typeof source.sleep === "object" ? source.sleep : {};
	const asr = source.asr !== null && typeof source.asr === "object" ? source.asr : {};
	const tts = source.tts !== null && typeof source.tts === "object" ? source.tts : {};
	const polish = source.polish !== null && typeof source.polish === "object" ? source.polish : {};
	const session = source.session !== null && typeof source.session === "object" ? source.session : {};
	const ui = source.ui !== null && typeof source.ui === "object" ? source.ui : {};
	const agent = source.agent !== null && typeof source.agent === "object" ? source.agent : {};
	const answers = source.answers !== null && typeof source.answers === "object" ? source.answers : {};
	const turn = source.turn !== null && typeof source.turn === "object" ? source.turn : {};
	const memory = source.memory !== null && typeof source.memory === "object" ? source.memory : {};
	const routing = source.routing !== null && typeof source.routing === "object" ? source.routing : {};

	const wakeWord = text(wake.word, "小凤");
	// 别名里剔掉唤醒词本身，避免匹配表里重复。
	const aliases = textList(wake.aliases, ["小风", "晓凤", "小枫", "小丰", "小峰"]).filter(
		(alias) => alias !== wakeWord,
	);

	// 「声音停止多久 = 这一轮说完了」。先夹取出来，下面 maxTurnMs 的下界依赖它。
	const silence = number(turn.silenceMs, 10000, SILENCE_MIN, SILENCE_MAX);

	return {
		wake: {
			word: wakeWord,
			aliases,
			inlineCommand: bool(wake.inlineCommand, true),
		},
		language: text(source.language, "zh-CN"),
		sleep: {
			idleTimeoutMs: number(sleep.idleTimeoutMs, 60000, IDLE_MIN, IDLE_MAX),
			keepWakeWord: bool(sleep.keepWakeWord, false),
			chime: bool(sleep.chime, true),
		},
		asr: {
			// auto     = 优先复用已装的 dsh-ears（8 个识别后端），否则浏览器识别
			// ears     = 强制走 dsh-ears 远程 transcribe
			// webspeech= 只用浏览器 Web Speech
			// http     = 只用本插件宿主代理的 OpenAI 兼容端点
			engine: oneOf(asr.engine, ["auto", "ears", "webspeech", "http"], "auto"),
			http: endpoint(asr.http, "whisper-1"),
		},
		tts: {
			engine: oneOf(tts.engine, ["browser", "http"], "browser"),
			voice: text(tts.voice, ""),
			rate: number(tts.rate, 1, RATE_MIN, RATE_MAX),
			http: endpoint(tts.http, "tts-1", "alloy"),
		},
		polish: {
			enabled: bool(polish.enabled, true),
			style: oneOf(polish.style, ["clean", "concise", "structured"], "clean"),
			provider: text(polish.provider, ""),
			model: text(polish.model, ""),
			timeoutMs: number(polish.timeoutMs, 8000, POLISH_MIN, POLISH_MAX),
			fallback: bool(polish.fallback, true),
		},
		session: {
			mode: oneOf(session.mode, ["persistent", "dedicated", "active"], "persistent"),
			title: text(session.title, "小凤语音会话"),
			workspace: text(session.workspace, ""),
			// 常驻会话在侧边栏的标注名。
			//
			// 为什么是"标注"而不是"隐藏"：DSH **没有**安全的隐藏机制，两条候选
			// 路都会把助手弄坏（实测 + 读源码确认）：
			//   - `archiveSession(id)`：本 profile 注册了 `ArchivedSessionGate`，
			//     它对 `agent/pre-step` 直接 reject —— 归档后助手再也跑不了模型。
			//   - `meta.origin:'subagent'`：宿主按普通 id 访问时抛
			//     `session/agent-busy`（"subagent Sessions require their durable
			//     parent address"），而插件的会话桥正是按普通 id retain 的。
			// 与其做一条"看不见但连不上"的会话，不如让它在侧边栏**一眼可辨**：
			// 用户知道那是常驻助手，不会误以为是自己的对话。
			//
			// 空字符串 = 不改名（用户自己管理标题）。
			//
			// 注意这里**不能**用 `text(...)`：那个 helper 把空串当"没填"而回落到
			// 兜底值，于是注释承诺的"留空即关闭"会变成静默失效 —— 用户写了
			// `label: ''` 以为关掉了标注，实际仍被改成默认名。所以显式区分
			// 「非字符串（没配）」与「空串（明确要求关闭）」两种意图。
			label:
				typeof session.label === "string" ? session.label.trim() : "小凤 · 常驻助手",
		},
		ui: {
			position: oneOf(ui.position, ["bottom-right", "bottom-left", "bottom-center"], "bottom-right"),
			accent: /^#[0-9a-fA-F]{6}$/.test(String(ui.accent ?? "")) ? String(ui.accent) : "#2f6bff",
			showTranscript: bool(ui.showTranscript, true),
		},
		agent: {
			enabled: bool(agent.enabled, true),
			sessionId: text(agent.sessionId, "session-voice-assistant-root"),
			cwd: text(agent.cwd, ""),
			persist: bool(agent.persist, true),
			persona: text(agent.persona, DEFAULT_PERSONA),
			// 模型路由。**两项都留空**（默认）表示跟随宿主 agentDefaultModel，
			// 即用户在界面上选的那个模型 —— 常驻 agent 会和 UI 会话用同一个。
			// 都填了才覆盖。只填一项视为无效，回落到默认。
			provider: text(agent.provider, ""),
			model: text(agent.model, ""),
			// 能力集 preset（坑十三）：`registry.create()` 的 agent 不带 preset 时
			// 没有文件/命令工具；这里指定挂哪个（默认 standard，与 web 界面会话
			// 同款）。写 `none` = 显式关闭（回到只有全局插件工具的旧行为）。
			preset: text(agent.preset, "standard"),
			// 是否**允许**在思考中插话纠偏（steer）。
			// 注意这只是"允许"，真正开麦还要 `turn.steerWhileThinking` 也为真 ——
			// 两个都开才会在思考中保持麦克风。默认只允许、不开麦：常驻 agent
			// 跑长任务时，环境里任何人声都会被当成插话注入正在跑的 turn。
			steer: bool(agent.steer, true),
		},
		routing: {
			// 两层 agent 架构的第一层：语音助手做 router，把指令派给 worker 专家。
			// 关闭时行为与旧版本完全一致（全部进根 agent「小凤」）。
			enabled: bool(routing.enabled, true),
			// 路由 LLM 调用超时（毫秒）。超时/失败一律降级 general + 原文。
			timeoutMs: number(routing.timeoutMs, 6000, ROUTE_LIMITS.min, ROUTE_LIMITS.max),
			// 客户端轮询 /reports 的间隔（毫秒）。worker 完成后的要点汇总靠它取回。
			reportPollMs: number(routing.reportPollMs, 1500, 500, 10000),
			// 单个委托任务的最长等待时间（毫秒）。超时按失败汇报，绝不无限挂着。
			// 典型触发场景：worker 请求沙箱提权/人工确认，而语音助手按设计不代答。
			jobTimeoutMs: number(routing.jobTimeoutMs, 300000, JOB_TIMEOUT_MIN, JOB_TIMEOUT_MAX),
			// worker 清单（与默认清单按 id 合并；general 恒在且指向根 agent）。
			workers: normalizeWorkers(routing.workers, text(agent.sessionId, "session-voice-assistant-root")),
		},
		answers: {
			// 语音应答：**只做「模型提问」（`ask_user_question`），不做「工具审批」**。
			//
			// 为什么不做工具审批（`approval/request`）：那条 seam 放行的是
			// **有副作用的操作**（跑 bash、写文件），语音误听（环境人声、
			// 识别错字）会造成真实损害；而提问只是"要一个信息"，答错最多
			// 重问一次。所以工具审批一律交回界面，语音只念、不答。
			//
			// 历史：这里曾有 `approvalTimeoutMs`，在范围收窄后成了**死配置**
			// —— 读它没有任何代码路径，留着只会让用户以为开了就有审批播报。
			questionTimeoutMs: number(answers.questionTimeoutMs, 60000, ANSWER_MIN, ANSWER_MAX),
			// 念问题前响一声提示音（沿用 `sleep.chime` 的总开关）。
			chime: bool(answers.chime, true),
			// 用户没答上时把问题再念一遍（**最多一次**：重复念会变成骚扰，
			// 而且问题本来就在界面上，用户不看屏幕是他自己的选择）。
			repeatOnce: bool(answers.repeatOnce, true),
		},
		memory: {
			// 是否把「记忆」注册成**全局** prompt 段（对 DSH 里所有会话生效）。
			//
			// 与 `agent.persona` 的关键区别就是**作用域**：
			//   - `agent.persona` 注册在 **agent 作用域**（composeAgentScope 里
			//     用的是 agent 的 ctx），只对常驻这一只 agent 生效；
			//   - 本项注册在**根作用域**（插件 apply 拿到的 ctx），对全部会话生效。
			// 这正是"记忆为全局记忆"这条需求的落点。
			//
			// 默认 **false**：往全局系统提示里注入文字是有代价的（每个会话、每一轮
			// 都占 token，还可能影响用户自己的会话行为），必须由用户显式开启。
			global: bool(memory.global, false),
			// 全局记忆正文。留空 = 不注册（即使 global 为真）。
			text: text(memory.text, ""),
		},
		turn: {
			// 「声音停止多久 = 这一轮说完了」。默认 60s（需求：不要还没说完就提交）。
			silenceMs: silence,
			// 单轮硬上限：连续不断说话时的安全阀，保证总会提交一次。
			// 夹取时**下界抬到 silenceMs + 5s** —— 若上限小于静音阈值，
			// 静音判据永远轮不到，语义就反了。
			maxTurnMs: number(turn.maxTurnMs, Math.max(silence + 5000, 300000), Math.max(silence + 5000, MAXTURN_MIN), MAXTURN_MAX),
			// 识别到的话若就是助手自己刚说的，丢弃（防"自说自话"）。
			echoGuard: bool(turn.echoGuard, true),
			// 思考中是否开麦插话纠偏。默认 **false**：开着的话，环境里任何
			// 人声/噪声都会被当成"插话"注入正在跑的 turn，是自说自话的另一入口。
			steerWhileThinking: bool(turn.steerWhileThinking, false),
		},
	};
}

/**
 * 裁出可以安全下发到浏览器的配置。
 *
 * 白名单式拷贝：`*Key` 一律不出现。同时补上两个**派生**字段，
 * 让客户端不必自己判断"这个引擎到底能不能用"：
 *   - `asr.httpReady` / `tts.httpReady`：baseURL 是否已填。
 *   - `polish.available`：宿主是否注入了 llm 服务（由调用方传入）。
 *
 * @param config - `normalizeConfig` 的产物。
 * @param capabilities - 宿主自省得到的能力事实。
 * @returns 纯 JSON 可序列化、无密钥的配置。
 */
export function clientConfig(config, capabilities = {}) {
	return {
		wake: { word: config.wake.word, aliases: config.wake.aliases.slice(), inlineCommand: config.wake.inlineCommand },
		language: config.language,
		sleep: { ...config.sleep },
		asr: {
			engine: config.asr.engine,
			httpReady: config.asr.http.baseURL !== "",
			httpModel: config.asr.http.model,
			maxSegmentMs: config.asr.http.maxSegmentMs ?? 15000,
		},
		tts: {
			engine: config.tts.engine,
			voice: config.tts.voice,
			rate: config.tts.rate,
			httpReady: config.tts.http.baseURL !== "",
			httpModel: config.tts.http.model,
		},
		polish: {
			enabled: config.polish.enabled,
			style: config.polish.style,
			timeoutMs: config.polish.timeoutMs,
			available: capabilities.polishAvailable === true,
			model: capabilities.polishModel ?? "",
		},
		session: {
			// `active` 在当前 ui-workspace 契约下拿不到"当前选中会话"的公共可观测面，
			// 因此强制降级为 dedicated，并把降级事实显式告诉客户端（界面会提示）。
			// `persistent` = 常驻 agent 模式（默认）：retain 宿主创建的常驻 agent 会话。
			mode: "persistent",
			requestedMode: config.session.mode,
			title: config.session.title,
			workspace: config.session.workspace,
			label: config.session.label,
		},
		ui: { ...config.ui },
		agent: {
			// 常驻 agent 的身份与能力事实（客户端据此决定 retain 谁）。
			enabled: config.agent.enabled,
			sessionId: config.agent.sessionId,
			personaActive: config.agent.persona !== "",
			steer: config.agent.steer,
		},
		routing: {
			enabled: config.routing.enabled,
			// 只下发 id/label/sessionId —— persona 正文留在宿主（与 memory.text
			// 同一条纪律：专家人格可能含用户的定制上下文，不进浏览器明文全局）。
			workers: workerTargets(config.routing.workers),
			// V1.3：结果回传轮询间隔（worker 完成 → 宿主汇总 → 客户端依次播报）。
			reportPollMs: config.routing.reportPollMs,
		},
		answers: {
			// 只下发"提问"这一块 —— 工具审批不在本插件的范围内，下发一个
			// 用不到的窗口只会让客户端界面显示一个永远不会发生的能力。
			questionTimeoutMs: config.answers.questionTimeoutMs,
			chime: config.answers.chime,
			repeatOnce: config.answers.repeatOnce,
		},
		memory: {
			// 只下发"有没有生效"这个事实，**不下发正文**：
			// 记忆正文可能含用户的私人上下文，而浏览器的配置全局是明文的。
			global: config.memory.global,
			active: capabilities.memoryActive === true,
		},
		turn: {
			// 轮次门槛的三个参数都要下发：判据在客户端跑，宿主只管夹取。
			silenceMs: config.turn.silenceMs,
			maxTurnMs: config.turn.maxTurnMs,
			echoGuard: config.turn.echoGuard,
			steerWhileThinking: config.turn.steerWhileThinking,
		},
		capabilities: {
			polishAvailable: capabilities.polishAvailable === true,
			asrHttpReady: config.asr.http.baseURL !== "",
			ttsHttpReady: config.tts.http.baseURL !== "",
			agentAvailable: capabilities.agentAvailable === true,
			memoryActive: capabilities.memoryActive === true,
		},
	};
}
