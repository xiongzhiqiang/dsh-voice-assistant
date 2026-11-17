/**
 * 播报器（客户端）。
 *
 * ## 两条引擎，一套接口
 *
 * - `browser`：`speechSynthesis`。零配置、零延迟、零流量，用系统自带的中文语音。
 *   缺点是音色取决于本机装了哪些语音包（Windows 上通常是"慧慧/晓晓"那一类）。
 * - `http`：宿主代理到 OpenAI 兼容 `/audio/speech`。音色统一、质量高，
 *   代价是有一次网络往返（首字延迟 300–800ms）。
 *
 * 两者都实现 `speak(text)` / `cancel()`，上层不必关心用的是哪条。
 *
 * ## 为什么逐句播而不是整段播
 *
 * 见 `text.js` 的 `splitForSpeech`：整段塞进去，用户中途想打断时取消粒度太粗，
 * 而且部分浏览器对超长 utterance 会静默截断（听起来像"念到一半没了"）。
 *
 * ## 为什么一定要 cancel 兜底
 *
 * `speechSynthesis` 有个著名坑：调用 `cancel()` 之后立刻 `speak()`，
 * 新的一句会被静默丢弃。做法是 cancel 之后 `await` 一个极短延时再开口。
 */
import { splitForSpeech, stripForSpeech } from "./text.js";
import { SPEECH_CHUNK_MAX } from "./constants.js";
import { synthesize, warn } from "./runtime.js";

/** cancel 之后的静默间隔（毫秒）。见文件头注释。 */
const CANCEL_SETTLE_MS = 60;

/**
 * 挑一个中文语音。
 *
 * 优先级：配置指定 > 精确语言匹配 > 语言前缀匹配 > 任意语音。
 * 之所以要兜底到"任意语音"，是因为有些 Linux 环境只装了一个英文语音：
 * 这时用英文语音念中文虽然难听，但**能听见**，比静默失败强。
 *
 * @param voices - `speechSynthesis.getVoices()` 的结果。
 * @param hint - 配置里的音色名（可为空）。
 * @param language - 目标语言。
 * @returns 选中的语音或 `null`。
 */
export function pickVoice(voices, hint, language) {
	if (!Array.isArray(voices) || voices.length === 0) return null;
	if (typeof hint === "string" && hint !== "") {
		const exact = voices.find((voice) => voice.name === hint);
		if (exact) return exact;
		const fuzzy = voices.find((voice) => voice.name.toLowerCase().includes(hint.toLowerCase()));
		if (fuzzy) return fuzzy;
	}
	const normalized = String(language ?? "zh-CN").toLowerCase();
	const prefix = normalized.split("-")[0];
	const exactLang = voices.find((voice) => String(voice.lang ?? "").toLowerCase() === normalized);
	if (exactLang) return exactLang;
	const prefixLang = voices.find((voice) => String(voice.lang ?? "").toLowerCase().startsWith(prefix));
	if (prefixLang) return prefixLang;
	return voices[0] ?? null;
}

/**
 * 等待语音列表就绪。
 *
 * `getVoices()` 在部分浏览器首次调用返回空数组，要等 `voiceschanged`。
 * 但**不能无限等**：某些环境（无音频设备的 CI、Linux 容器）永远不触发该事件，
 * 无限等会让第一句播报永远挂住。所以给一个上限。
 *
 * @param timeoutMs - 上限毫秒。
 * @returns 语音列表（可能为空数组）。
 */
function loadVoices(timeoutMs = 1200) {
	const synth = globalThis.speechSynthesis;
	if (!synth) return Promise.resolve([]);
	const immediate = synth.getVoices?.() ?? [];
	if (immediate.length > 0) return Promise.resolve(immediate);
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			synth.removeEventListener?.("voiceschanged", onChanged);
			clearTimeout(timer);
			resolve(synth.getVoices?.() ?? []);
		};
		const onChanged = () => finish();
		const timer = setTimeout(finish, timeoutMs);
		synth.addEventListener?.("voiceschanged", onChanged);
	});
}

/** 播报器。 */
export class Speaker {
	/**
	 * @param options - `{ getConfig: () => config, onChunk?: (text) => void }`。
	 */
	constructor(options) {
		this.getConfig = options.getConfig;
		this.onChunk = options.onChunk ?? (() => {});
		/** 当前代：每次 cancel 递增，用来让在途的异步链自废。 */
		this.generation = 0;
		/** 正在播放的 HTMLAudioElement（http 引擎用）。 */
		this.audio = null;
		this.speaking = false;
	}

	/** 立刻停止播报（幂等）。 */
	cancel() {
		this.generation += 1;
		this.speaking = false;
		if (this.audio !== null) {
			try {
				this.audio.pause();
				this.audio.src = "";
			} catch {
				// 音频已被回收，忽略。
			}
			this.audio = null;
		}
		const synth = globalThis.speechSynthesis;
		if (synth) {
			try {
				synth.cancel();
			} catch {
				// 同上。
			}
		}
	}

	/**
	 * 播报一段文本。
	 *
	 * @param text - 原始文本（可以是 Markdown，内部会清洗）。
	 * @returns 播完（或被取消）后 resolve；`{ spoken, reason }` 描述结果。
	 */
	async speak(text) {
		this.cancel();
		const generation = this.generation;
		const config = this.getConfig();
		const cleaned = stripForSpeech(text);
		const chunks = splitForSpeech(cleaned, SPEECH_CHUNK_MAX);
		if (chunks.length === 0) return { spoken: false, reason: "empty" };

		this.speaking = true;
		try {
			if (config.tts.engine === "http" && config.tts.httpReady) {
				try {
					await this.speakViaHttp(chunks, config, generation);
					return { spoken: true, reason: "http" };
				} catch (error) {
					// 上游不可用时**不能哑火**：退回系统语音，用户至少能听见。
					warn("上游 TTS 失败，退回系统语音：", error?.message ?? error);
				}
			}
			await this.speakViaBrowser(chunks, config, generation);
			return { spoken: true, reason: "browser" };
		} finally {
			if (generation === this.generation) this.speaking = false;
		}
	}

	/**
	 * 用 `speechSynthesis` 逐句播。
	 * @param chunks - 句子片段。
	 * @param config - 归一化配置。
	 * @param generation - 调用时的代号。
	 */
	async speakViaBrowser(chunks, config, generation) {
		const synth = globalThis.speechSynthesis;
		if (!synth || typeof globalThis.SpeechSynthesisUtterance !== "function") {
			throw new Error("speech-synthesis-unavailable");
		}
		const voices = await loadVoices();
		const voice = pickVoice(voices, config.tts.voice, config.language);

		for (const chunk of chunks) {
			if (generation !== this.generation) return;
			this.onChunk(chunk);
			await new Promise((resolve) => {
				const utterance = new globalThis.SpeechSynthesisUtterance(chunk);
				utterance.lang = config.language;
				utterance.rate = config.tts.rate;
				utterance.pitch = 1;
				if (voice) utterance.voice = voice;
				let done = false;
				const finish = () => {
					if (done) return;
					done = true;
					resolve();
				};
				utterance.onend = finish;
				// `interrupted`/`canceled` 是主动取消的产物，不算错误。
				utterance.onerror = finish;
				try {
					synth.speak(utterance);
				} catch (error) {
					warn("speak 调用失败", error);
					finish();
				}
				// 安全兜底：个别浏览器不触发 onend（尤其切标签页后），
				// 按字数估一个上限，避免整条播报链永远挂住。
				setTimeout(finish, Math.max(3000, chunk.length * 320));
			});
			// cancel 后立即 speak 会被吞掉，这里给一帧间隔。
			await new Promise((resolve) => setTimeout(resolve, CANCEL_SETTLE_MS));
		}
	}

	/**
	 * 用上游音频逐句播。
	 * @param chunks - 句子片段。
	 * @param config - 归一化配置。
	 * @param generation - 调用时的代号。
	 */
	async speakViaHttp(chunks, config, generation) {
		for (const chunk of chunks) {
			if (generation !== this.generation) return;
			this.onChunk(chunk);
			const { blob } = await synthesize(chunk);
			if (generation !== this.generation) return;
			const url = URL.createObjectURL(blob);
			try {
				await new Promise((resolve, reject) => {
					const audio = new Audio(url);
					this.audio = audio;
					audio.playbackRate = config.tts.rate;
					audio.onended = () => resolve();
					audio.onerror = () => reject(new Error("audio-playback-failed"));
					audio.play().catch(reject);
				});
			} finally {
				URL.revokeObjectURL(url);
				this.audio = null;
			}
		}
	}
}
