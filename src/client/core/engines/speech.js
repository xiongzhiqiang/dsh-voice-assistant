/**
 * 复用 DSH 官方 `voice-input-bundle` 的 SenseVoice 本地识别能力。
 *
 * ## 这是什么
 *
 * DSH 官方的实验性语音输入 bundle 会装上一组 `speech-to-text` 插件，默认注册
 * 一个 `sensevoice-local` provider：本地 SenseVoice Small（sherpa-onnx ONNX，
 * CPU 推理）+ Silero VAD 切句。它对外暴露一个 typert 远程命名空间 `speech`：
 *
 *     speech/transcribe({ audioBase64, providerId?, language? })
 *       → { text, audioSeconds, inferenceSeconds }
 *
 * 本插件只需唤醒 / 会话 / 播报 / 休眠这套编排，识别后端交给它即可 ——
 * 用户在 DSH 侧下的模型、选的语言都直接生效。
 *
 * ## 为什么取值要试多条候选
 *
 * 与 `ears.js` 同一个坑：cordis 对**未声明 inject** 的服务访问会同步抛
 * `cannot get property "remote.X" without inject`。而这是**可选依赖** ——
 * 不能把它写进 inject，否则没装这个 bundle 的 profile 里整只语音球永不激活。
 * 正解是用服务全名 `ctx.get("remote.speech")`（免 inject），再兜几条别的取法。
 *
 * ## 音频格式：必须 16k 单声道 PCM16 WAV
 *
 * 宿主侧 `speechController.transcribe()` 会先 `validateWave(audio, …)`，
 * 只收 WAV；而浏览器 `MediaRecorder` 产出 webm/opus。所以和本地 Whisper 一样，
 * 发送前必须归一化（责任在调用方）。
 *
 * ## 探测必须便宜且可失败
 *
 * `catalog()` 只读本地 provider 清单，不打网络。取不到就静默判"不可用"，
 * 让主链路降级到其它引擎 —— 一个可选依赖不该让语音助手崩掉。
 */
import { blobToPcm16Wav } from "../audio/wav.js";
import { warn } from "../runtime.js";

/**
 * 按优先级列出 `speech` 命名空间的所有可能取法（不筛方法）。
 * 单独抽出来是为了排障时能看清"到底哪条路通、取到的是什么形状"。
 *
 * @param ctx - 客户端 Cordis 上下文。
 * @returns `{ from, value, error? }` 列表。
 */
export function speechCandidates(ctx) {
	const probe = (name, read) => {
		try {
			return { from: name, value: read() };
		} catch (error) {
			return { from: name, value: undefined, error: String(error?.message ?? error) };
		}
	};
	return [
		// ① 正解：带点号的完整注册名（免 inject）。
		probe("ctx.get(remote.speech)", () => ctx?.get?.("remote.speech")),
		probe("ctx.get(remote.speechController)", () => ctx?.get?.("remote.speechController")),
		probe("ctx.reflect.get(remote.speech)", () => ctx?.reflect?.get?.("remote.speech")),
		// ② 有些装配把它直接注册成 speechController / speech。
		probe("ctx.get(speechController)", () => ctx?.get?.("speechController")),
		probe("ctx.get(speech)", () => ctx?.get?.("speech")),
		// ③ 取到 remote 目录再取属性（宿主已声明 inject 时可用）。
		probe("ctx.remote.speech", () => ctx?.remote?.speech),
		probe("ctx.get(remote).speech", () => ctx?.get?.("remote")?.speech),
	];
}

/**
 * 取 `speech` 远程命名空间。
 *
 * @param ctx - 客户端 Cordis 上下文。
 * @returns 命名空间对象（需有 transcribe 或 catalog 方法），或 null。
 */
export function speechNamespace(ctx) {
	for (const candidate of speechCandidates(ctx)) {
		const namespace = candidate?.value;
		if (namespace && (typeof namespace.transcribe === "function" || typeof namespace.catalog === "function")) {
			return namespace;
		}
	}
	return null;
}

/** 剥掉 typert 远程信封（与 ears.js 一致）。 */
function unwrap(value) {
	if (value !== null && typeof value === "object" && "ok" in value) {
		if (value.ok === false) {
			const failure = value.error ?? {};
			throw new Error(String(failure.message ?? failure.code ?? "remote-failed"));
		}
		return value.value;
	}
	return value;
}

/**
 * 把 Blob 编成 base64（不走 btoa，避免大数组爆栈）。
 * @param blob - 音频。
 * @returns 纯 base64（不含 data URI 前缀）。
 */
function blobToBase64(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error("audio-read-failed"));
		reader.onload = () => {
			const result = String(reader.result ?? "");
			const comma = result.indexOf(",");
			resolve(comma >= 0 ? result.slice(comma + 1) : result);
		};
		reader.readAsDataURL(blob);
	});
}

/** SenseVoice 支持的语言（供 UI 下拉用）。 */
export const SPEECH_LANGUAGES = ["auto", "zh", "en", "yue", "ja", "ko"];

/**
 * 探测官方 speech 识别是否可用，并取回 provider / 语言清单。
 *
 * @param ctx - 客户端 Cordis 上下文。
 * @returns `{ available, providers, languages, selection, paths }`。
 */
export async function probeSpeech(ctx) {
	const paths = speechCandidates(ctx).map(({ from, value, error }) => ({
		from,
		hit: value !== undefined && value !== null,
		hasTranscribe: typeof value?.transcribe === "function",
		hasCatalog: typeof value?.catalog === "function",
		...(error === undefined ? {} : { error }),
	}));
	const namespace = speechNamespace(ctx);
	if (namespace === null) return { available: false, providers: [], languages: [], selection: null, paths };
	try {
		let catalog = null;
		if (typeof namespace.catalog === "function") catalog = unwrap(await namespace.catalog());
		const providers = Array.isArray(catalog?.providers) ? catalog.providers : [];
		const languages = Array.isArray(catalog?.languages)
			? catalog.languages
			: Array.isArray(catalog?.selection?.languages)
				? catalog.selection.languages
				: SPEECH_LANGUAGES.slice();
		// 有 transcribe 就认为可用（catalog 可能因为版本差异形状不同）。
		const available = typeof namespace.transcribe === "function";
		return { available, providers, languages, selection: catalog?.selection ?? null, paths };
	} catch (error) {
		warn("speech 识别探测失败，跳过该引擎", error?.message ?? error);
		return { available: false, providers: [], languages: [], selection: null, paths };
	}
}

/**
 * 构造一个走 DSH 官方 speech 识别的 `recognize` 函数。
 *
 * @param ctx - 客户端 Cordis 上下文。
 * @param options - `{ language? }`：语言提示（auto/zh/en/yue/ja/ko）。
 * @returns `(blob) => Promise<string>`。
 */
export function makeSpeechRecognizer(ctx, options = {}) {
	const language = typeof options.language === "string" && options.language !== "" ? options.language : "auto";
	return async (blob) => {
		const namespace = speechNamespace(ctx);
		if (namespace === null) throw new Error("speech-unavailable");

		// 宿主侧 validateWave 只收 WAV —— 必须先归一化，否则换来无指向性的
		// speech/transcription-failed。
		let payload;
		try {
			payload = (await blobToPcm16Wav(blob)).blob;
		} catch (error) {
			throw new Error(`asr-audio-format: ${error?.message ?? error}`);
		}
		const audioBase64 = await blobToBase64(payload);
		const result = unwrap(await namespace.transcribe({ audioBase64, language }));
		if (typeof result === "string") return result;
		if (result !== null && typeof result === "object" && typeof result.text === "string") return result.text;
		return "";
	};
}
