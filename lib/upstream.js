/**
 * 上游语音服务代理（宿主半）。
 *
 * ## 为什么要有这一层
 *
 * 浏览器直连第三方 ASR/TTS 有两个硬问题：
 *   1. **密钥必然泄漏**。浏览器端的 key 等价于公开的 key，任何打开
 *      开发者工具的人都能拿走；
 *   2. **跨域**。多数语音端点不开 CORS，直连必然失败。
 *
 * 所以密钥只留在宿主进程，浏览器把音频/文本发给本机 DSH 的 `/api/asr`、
 * `/api/tts`，由宿主转发。代价是多一跳本机回环，可以忽略。
 *
 * ## 契约
 *
 * 只对接 **OpenAI 兼容**协议（`/audio/transcriptions`、`/audio/speech`）。
 * 这样一份代码能覆盖 OpenAI、DeepSeek 兼容网关、vLLM、one-api、FastGPT
 * 等一整片实现，而不是为每家写适配器。
 */

/** 请求上游的超时上界。语音是交互式的，超过这个时间用户已经重说了。 */
const ASR_TIMEOUT_MS = 30000;
const TTS_TIMEOUT_MS = 20000;

/** TTS 单次合成文本上限：多数端点对 input 有 4096 字符限制，留足余量。 */
const TTS_MAX_CHARS = 2000;

/**
 * 拼接上游 URL，处理 baseURL 末尾斜杠与已含 `/v1` 的两种写法。
 * @param baseURL - 用户填的基地址。
 * @param path - 形如 `audio/speech` 的路径（不带前导斜杠）。
 * @returns 完整 URL。
 */
function joinUrl(baseURL, path) {
	return `${baseURL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * 构造鉴权头；未填 key 时不发 Authorization（本地 vLLM 之类常见）。
 * @param apiKey - 可能为空的密钥。
 */
function authHeaders(apiKey) {
	const headers = {};
	if (apiKey !== "") headers.authorization = `Bearer ${apiKey}`;
	return headers;
}

/**
 * 调用上游语音转写。
 *
 * 直接把浏览器录好的音频字节透传，不改容器格式 —— 重编码会引入
 * 额外的 CPU 与质量损失，而 OpenAI 兼容端点本身就接受 webm/ogg/wav/mp3。
 *
 * @param http - 归一化后的 `asr.http` 配置。
 * @param audio - 音频字节。
 * @param mimeType - 音频容器的 MIME（用于给文件起合适的扩展名）。
 * @param language - 语言提示（可为空）。
 * @returns 识别出的文本。
 * @throws 上游非 2xx、超时、或返回体不含 text 时抛错。
 */
export async function transcribe(http, audio, mimeType, language) {
	if (http.baseURL === "") throw new Error("asr-not-configured");

	const extension = mimeType.includes("wav")
		? "wav"
		: mimeType.includes("ogg")
			? "ogg"
			: mimeType.includes("mp4") || mimeType.includes("m4a")
				? "m4a"
				: "webm";
	const form = new FormData();
	// Blob 的 type 不要带 codecs 参数，部分端点的类型嗅探会被它绊住。
	form.append("file", new Blob([audio], { type: mimeType.split(";")[0] }), `speech.${extension}`);
	form.append("model", http.model);
	if (language !== "") form.append("language", language);

	const response = await fetch(joinUrl(http.baseURL, "audio/transcriptions"), {
		method: "POST",
		headers: authHeaders(http.apiKey),
		body: form,
		signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`asr-http-${response.status}: ${detail.slice(0, 300)}`);
	}

	// 兼容两种返回体：`{ text }` 与纯文本。
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		const payload = await response.json();
		if (typeof payload?.text !== "string") throw new Error("asr-response-without-text");
		return payload.text;
	}
	return await response.text();
}

/**
 * 调用上游语音合成。
 *
 * @param http - 归一化后的 `tts.http` 配置。
 * @param text - 要念的文本。
 * @returns MP3 字节与 MIME。
 * @throws 上游非 2xx、超时、或文本为空时抛错。
 */
export async function synthesize(http, text) {
	if (http.baseURL === "") throw new Error("tts-not-configured");
	const input = String(text ?? "").trim();
	if (input === "") throw new Error("tts-empty-text");

	const response = await fetch(joinUrl(http.baseURL, "audio/speech"), {
		method: "POST",
		headers: { "content-type": "application/json", ...authHeaders(http.apiKey) },
		body: JSON.stringify({
			model: http.model,
			voice: http.voice ?? "alloy",
			input: input.slice(0, TTS_MAX_CHARS),
			response_format: "mp3",
		}),
		signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`tts-http-${response.status}: ${detail.slice(0, 300)}`);
	}

	const bytes = new Uint8Array(await response.arrayBuffer());
	return { bytes, contentType: response.headers.get("content-type") ?? "audio/mpeg" };
}
