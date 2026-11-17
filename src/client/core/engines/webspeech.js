/**
 * 引擎 A：浏览器 Web Speech API（零配置）。
 *
 * ## 能力与代价
 *
 * 走浏览器内置的流式识别（Chrome/Edge 背后是云端服务）。好处是**零配置、
 * 零模型下载、连续识别、带中间结果**；代价是依赖浏览器实现，识别质量与
 * 网络状况挂钩，且部分环境（无语音服务的 Chromium 构建）根本不可用。
 *
 * 所以 `isAvailable()` 必须显式探测，不可用时要让上层换引擎或告知用户 ——
 * 静默失败会表现为"喊了没反应"，用户无从判断是自己声音小还是功能坏了。
 *
 * ## 三个必须处理的坑
 *
 * 1. **自动停止**：`continuous: true` 在 Chrome 上仍会因静默超时结束会话。
 *    必须在 `onend` 里重启，否则待机几分钟后唤醒词就失效了。
 * 2. **重启风暴**：若无条件重启，遇到权限被拒会无限循环刷错误。
 *    用指数退避 + 次数上限。
 * 3. **结果拼接**：`event.results` 里既有最终结果也有中间结果，
 *    必须按 `resultIndex` 增量拼接，否则会出现"那句话被重复念两遍"。
 */
import { UTTERANCE_SETTLE_MS } from "../constants.js";
import { warn } from "../runtime.js";

/** 重启退避的起始与上限（毫秒）。 */
const RESTART_MIN_MS = 300;
const RESTART_MAX_MS = 5000;

/** 连续重启失败多少次后放弃（交给上层提示用户）。 */
const RESTART_GIVE_UP = 6;

/** 探测 Web Speech API 是否可用。 */
export function isAvailable() {
	return typeof globalThis.SpeechRecognition === "function" || typeof globalThis.webkitSpeechRecognition === "function";
}

/** 基于 Web Speech API 的识别引擎。 */
export class WebSpeechEngine {
	/**
	 * @param options - `{ language, onPartial, onFinal, onError, onClose }`。
	 */
	constructor(options) {
		this.options = options;
		this.recognition = null;
		/** 用户是否希望它一直听（stop() 后置 false）。 */
		this.wanted = false;
		/** 已确认的最终文本缓冲。 */
		this.finals = "";
		/** 当前中间结果。 */
		this.interim = "";
		/** 一句话结束的判定定时器。 */
		this.settleTimer = null;
		this.restartCount = 0;
		this.restartTimer = null;
		this.fatal = false;
	}

	/** 是否处于"想听"的状态。 */
	isListening() {
		return this.wanted;
	}

	/** 开始（或恢复）连续识别。 */
	start() {
		if (this.recognition !== null) {
			this.wanted = true;
			return;
		}
		const Ctor = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
		if (typeof Ctor !== "function") {
			this.options.onError?.(new Error("webspeech-unavailable"));
			return;
		}

		this.wanted = true;
		this.fatal = false;
		const recognition = new Ctor();
		recognition.lang = this.options.language ?? "zh-CN";
		recognition.continuous = true;
		recognition.interimResults = true;
		// 单次结果里也带上更多备选，便于未来做置信度过滤；当前只用第一个。
		recognition.maxAlternatives = 1;

		recognition.onresult = (event) => {
			this.restartCount = 0;
			let interim = "";
			for (let i = event.resultIndex; i < event.results.length; i += 1) {
				const result = event.results[i];
				const transcript = result[0]?.transcript ?? "";
				if (result.isFinal) this.finals += transcript;
				else interim += transcript;
			}
			this.interim = interim;
			this.options.onPartial?.(`${this.finals}${this.interim}`.trim());
			this.scheduleSettle();
		};

		recognition.onerror = (event) => {
			const code = String(event?.error ?? "unknown");
			// `no-speech` / `aborted` 是常态（静默、主动停止），不是故障。
			if (code === "no-speech" || code === "aborted") return;
			if (code === "not-allowed" || code === "service-not-allowed") {
				this.fatal = true;
				this.wanted = false;
				this.options.onError?.(new Error("mic-denied"));
				return;
			}
			if (code === "network") {
				// `network` = **连不上识别服务**。
				//
				// 这条曾经被当成瞬时抖动，于是走下面的通用重试：退避 300ms 起、
				// 翻倍到 5s，最多 6 次（累计约 9 秒）。问题是这条路要么通、
				// 要么**根本不通**（Chrome/Edge 的识别在境外云端，受限网络下
				// 永远连不上），重试 6 次的结果只是把同一条错误刷 6 遍，然后
				// 以 `speech-restart-exhausted` 永久失效 —— 用户看到的是刷屏，
				// 却读不到"为什么"。
				//
				// 所以归到**环境不可用**（与 `not-allowed` 同类）：一次性如实
				// 报告并停止，把"换一条能用的路"交给上层（它知道有没有别的引擎）。
				// 真遇到瞬时抖动，用户再点一次即可 —— 代价远小于刷屏。
				warn("浏览器识别服务不可达", code);
				this.fatal = true;
				this.wanted = false;
				this.options.onError?.(new Error("asr-unreachable"));
				return;
			}
			warn("识别器报错", code);
			this.options.onError?.(new Error(`speech-${code}`));
		};

		recognition.onend = () => {
			this.recognition = null;
			this.flushSettle();
			if (!this.wanted || this.fatal) {
				this.options.onClose?.();
				return;
			}
			// 自动重启（带退避）。
			this.restartCount += 1;
			if (this.restartCount > RESTART_GIVE_UP) {
				this.fatal = true;
				this.options.onError?.(new Error("speech-restart-exhausted"));
				this.options.onClose?.();
				return;
			}
			const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** (this.restartCount - 1));
			clearTimeout(this.restartTimer);
			this.restartTimer = setTimeout(() => {
				if (this.wanted && this.recognition === null) this.start();
			}, delay);
		};

		this.recognition = recognition;
		try {
			recognition.start();
		} catch (error) {
			// 重复 start() 会抛 InvalidStateError，属正常竞态。
			if (String(error?.name ?? "") !== "InvalidStateError") {
				warn("识别器启动失败", error);
				this.options.onError?.(error);
			}
		}
	}

	/** 停止识别并释放麦克风。 */
	stop() {
		this.wanted = false;
		clearTimeout(this.restartTimer);
		this.restartTimer = null;
		this.flushSettle();
		const recognition = this.recognition;
		this.recognition = null;
		if (recognition !== null) {
			try {
				recognition.onend = null;
				recognition.stop();
			} catch {
				// 已经停了。
			}
		}
	}

	/**
	 * 重置文本缓冲（每次拿到一句最终结果后由上层调用）。
	 */
	reset() {
		this.finals = "";
		this.interim = "";
	}

	/** 排一次"这句话说完了"的判定。 */
	scheduleSettle() {
		clearTimeout(this.settleTimer);
		this.settleTimer = setTimeout(() => this.flushSettle(), UTTERANCE_SETTLE_MS);
	}

	/**
	 * 立即结算当前缓冲，作为一句最终文本抛给上层。
	 *
	 * 判据：非空白。文本本身不做任何清洗 —— 清洗是润色层的职责，
	 * 引擎越"笨"越好，这样换引擎时上层行为不变。
	 */
	flushSettle() {
		clearTimeout(this.settleTimer);
		this.settleTimer = null;
		const text = `${this.finals}${this.interim}`.trim();
		this.finals = "";
		this.interim = "";
		if (text !== "") this.options.onFinal?.(text);
	}
}
