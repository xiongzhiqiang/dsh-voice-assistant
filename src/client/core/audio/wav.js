/**
 * 把浏览器录到的音频转成**本地 Whisper 能吃的** 16 kHz 单声道 PCM16 WAV。
 *
 * ## 为什么必须有这个文件
 *
 * 本地 Whisper 走 whisper.cpp 原生层，它只认一种输入：**16 kHz 单声道
 * PCM16 WAV**。`dsh-ears` 宿主侧有一道硬校验（`assertPcm16Wav`），
 * 格式不对直接抛 `asrAudioInvalid`，连推理都不会进。
 *
 * 而浏览器 `MediaRecorder` 产出的是 **webm/opus**（压缩容器）。
 * 两者对不上 —— 于是出现那个最气人的现象：
 *
 * > 模型下好了、运行时也正常、设置里选了「本地 Whisper」，
 * > 一说话却报"音频无效"，且报错文案完全指不到"格式"这件事。
 *
 * ## 谁本来该做这件事
 *
 * `dsh-ears` **自己的** UI 在做（`prepareRecordedAudioForBackend` →
 * `normalizeRecordedAudioForLocalWhisper`）。但它只在自己的录音按钮里调，
 * 远程方法 `transcribe(audioBase64, mimeType)` 收到什么就送什么 ——
 * 归一化的责任在**调用方**。本插件正是调用方，所以要自己补上。
 *
 * ## 实现取舍
 *
 * - 用 `AudioContext.decodeAudioData` 解码：浏览器原生、支持 webm/opus，
 *   不用自己解容器。
 * - 重采样用**线性插值**（不是丢帧抽取）。丢帧会有混叠噪声，
 *   Whisper 对这种噪声很敏感，容易编出无关的句子。
 * - 混单声道走**声道平均**（不是只取左声道）。
 * - 公式与 `dsh-ears` 的实现保持一致，两边产出逐字节相同 ——
 *   这样"它自己的录音按钮能用"就能推出"我们的也能用"。
 */

/** 本地 Whisper 期望的采样率。 */
export const WHISPER_SAMPLE_RATE = 16000;

/** 标准 RIFF/WAVE 头长度。 */
const WAV_HEADER_BYTES = 44;

/** `data` 块长度字段是 uint32，PCM16 每帧 2 字节 —— 留出头部后的上限。 */
const MAX_WAV_SAMPLES = Math.floor(4294967251 / 2);

/** 把有限数以外的样本（NaN/Infinity）当静音。 */
function finiteSample(value) {
	return Number.isFinite(value) ? value : 0;
}

/** 裁到 [-1, 1]，防止溢出的 int16 环绕成刺耳噪声。 */
function clippedSample(value) {
	if (value <= -1) return -1;
	if (value >= 1) return 1;
	return value;
}

/** Float32 样本 → int16。负半轴乘 32768、正半轴乘 32767，与主流实现一致。 */
function pcm16Sample(value) {
	const clipped = clippedSample(finiteSample(value));
	return clipped < 0 ? Math.round(clipped * 32768) : Math.round(clipped * 32767);
}

/**
 * 把各种"像 AudioBuffer"的输入归一成 `{ sampleRate, channelData, frameCount }`。
 *
 * 兼容两种形态：真的 `AudioBuffer`（有 `getChannelData`），以及测试里
 * 手搓的 `{ sampleRate, channelData }` 对象。这样纯函数可以脱离浏览器测。
 *
 * @param input - `AudioBuffer` 或 `{ sampleRate, channelData }`。
 * @returns 归一化后的音源。
 */
function sourceFromInput(input) {
	if (input === null || typeof input !== "object") throw new TypeError("audio-input-invalid");
	const sampleRate = input.sampleRate;
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError("audio-sample-rate-invalid");
	if (Array.isArray(input.channelData)) {
		const channelData = input.channelData.map((channel) => (channel instanceof Float32Array ? channel : Float32Array.from(channel ?? [])));
		const frameCount = channelData[0]?.length ?? 0;
		for (const channel of channelData) {
			if (channel.length !== frameCount) throw new RangeError("audio-channels-mismatched");
		}
		return { sampleRate, channelData, frameCount };
	}
	const channels = input.numberOfChannels;
	if (!Number.isSafeInteger(channels) || channels < 0) throw new RangeError("audio-channels-invalid");
	const channelData = [];
	for (let channel = 0; channel < channels; channel += 1) {
		const samples = input.getChannelData(channel);
		if (!(samples instanceof Float32Array)) throw new TypeError("audio-channel-data-invalid");
		channelData.push(samples);
	}
	const frameCount = channelData[0]?.length ?? 0;
	for (const channel of channelData) {
		if (channel.length !== frameCount) throw new RangeError("audio-channels-mismatched");
	}
	if (frameCount !== input.length) throw new RangeError("audio-length-mismatched");
	return { sampleRate, channelData, frameCount };
}

/** 取某一帧的**单声道**样本（多声道平均）。 */
function monoSampleAt(source, frame) {
	const { channelData } = source;
	if (channelData.length === 0) return 0;
	let average = 0;
	for (const channel of channelData) average += finiteSample(channel[frame] ?? 0) / channelData.length;
	return clippedSample(average);
}

/** 重采样后的总帧数（四舍五入，至少 1 帧以保留极短片段）。 */
function whisperFrameCount(source) {
	if (source.frameCount === 0) return 0;
	return Math.max(1, Math.round((source.frameCount * WHISPER_SAMPLE_RATE) / source.sampleRate));
}

/**
 * 线性插值取重采样后的第 `outputFrame` 帧。
 *
 * 为什么不是 `source[floor(frame * ratio)]`：抽取会引入混叠，
 * 说话里的高频摩擦音（s/sh）会变成宽频噪声，Whisper 容易听错。
 */
function resampledSampleAt(source, outputFrame, outputFrameCount) {
	if (source.frameCount === 0) return 0;
	if (outputFrameCount <= 1) return monoSampleAt(source, 0);
	const position = (outputFrame * (source.frameCount - 1)) / (outputFrameCount - 1);
	const lower = Math.floor(position);
	const upper = Math.min(lower + 1, source.frameCount - 1);
	const fraction = position - lower;
	const lowerValue = monoSampleAt(source, lower);
	if (upper === lower) return lowerValue;
	return lowerValue + (monoSampleAt(source, upper) - lowerValue) * fraction;
}

/** 往 DataView 里写 ASCII（避免 `String.fromCharCode` 与编码歧义）。 */
function writeAscii(view, offset, value) {
	for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

/** 写 44 字节标准 RIFF/WAVE 头（PCM、单声道、16 bit）。 */
function writeWavHeader(view, sampleRate, sampleCount) {
	const dataBytes = sampleCount * 2;
	writeAscii(view, 0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	writeAscii(view, 8, "WAVE");
	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true); // fmt 块长度
	view.setUint16(20, 1, true); // 1 = PCM
	view.setUint16(22, 1, true); // 单声道
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // 字节率
	view.setUint16(32, 2, true); // 块对齐
	view.setUint16(34, 16, true); // 位深
	writeAscii(view, 36, "data");
	view.setUint32(40, dataBytes, true);
}

/**
 * `AudioBuffer`（或等价的声道数组）→ 16 kHz 单声道 PCM16 WAV。
 *
 * @param input - `AudioBuffer` 或 `{ sampleRate, channelData }`。
 * @returns WAV 字节。
 */
export function audioToPcm16Wav(input) {
	const source = sourceFromInput(input);
	const outputFrameCount = whisperFrameCount(source);
	if (!Number.isSafeInteger(outputFrameCount) || outputFrameCount < 0 || outputFrameCount > MAX_WAV_SAMPLES) {
		throw new RangeError("audio-too-large");
	}
	const wav = new Uint8Array(WAV_HEADER_BYTES + outputFrameCount * 2);
	const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
	writeWavHeader(view, WHISPER_SAMPLE_RATE, outputFrameCount);
	for (let frame = 0; frame < outputFrameCount; frame += 1) {
		view.setInt16(WAV_HEADER_BYTES + frame * 2, pcm16Sample(resampledSampleAt(source, frame, outputFrameCount)), true);
	}
	return wav;
}

/**
 * 校验字节是不是**宿主侧会接受**的那种 WAV。
 *
 * 这份判定是 `dsh-ears` 宿主侧 `isPcm16Mono16kWav` 的忠实复刻。
 * 本地留一份的目的：编码出错时能**在这里**就报出来，
 * 而不是等一个远程调用回一句看不懂的 `asrAudioInvalid`。
 *
 * @param bytes - WAV 字节。
 * @returns 是否通过。
 */
export function isPcm16Mono16kWav(bytes) {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength < WAV_HEADER_BYTES) return false;
	if (String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF") return false;
	if (String.fromCharCode(...bytes.subarray(8, 12)) !== "WAVE") return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 12;
	let validFormat = false;
	let hasData = false;
	while (offset + 8 <= bytes.byteLength) {
		const chunk = String.fromCharCode(...bytes.subarray(offset, offset + 4));
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (body + size > bytes.byteLength) return false;
		if (chunk === "fmt " && size >= 16) {
			validFormat =
				view.getUint16(body, true) === 1 &&
				view.getUint16(body + 2, true) === 1 &&
				view.getUint32(body + 4, true) === WHISPER_SAMPLE_RATE &&
				view.getUint16(body + 14, true) === 16;
		}
		if (chunk === "data" && size > 0) hasData = true;
		offset = body + size + (size % 2);
	}
	return validFormat && hasData;
}

/**
 * Blob → 16 kHz 单声道 PCM16 WAV Blob。
 *
 * @param blob - 浏览器录到的音频（通常是 webm/opus）。
 * @param options - `{ createAudioContext? }`，测试可注入假上下文。
 * @returns `{ blob, mimeType }`；`mimeType` 恒为 `audio/wav`。
 */
export async function blobToPcm16Wav(blob, options = {}) {
	const create = options.createAudioContext ?? createBrowserAudioContext;
	const context = create();
	try {
		const decoded = await context.decodeAudioData(await blob.arrayBuffer());
		const wav = audioToPcm16Wav(decoded);
		return { blob: new Blob([wav], { type: "audio/wav" }), mimeType: "audio/wav", bytes: wav };
	} finally {
		try {
			await context.close?.();
		} catch {
			// 关不掉就算了，不能因此让识别失败。
		}
	}
}

/** 造一个浏览器 `AudioContext`（本地解码要用真的）。 */
export function createBrowserAudioContext() {
	const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
	if (Ctor === undefined) throw new Error("audio-decoding-unavailable");
	return new Ctor();
}
