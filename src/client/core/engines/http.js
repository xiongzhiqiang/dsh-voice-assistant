/**
 * 引擎 B：本机 VAD 分段 + 外部转写。
 *
 * 「外部」有两种接法，共用同一套采集与分段逻辑：
 *   - `recognize` 默认走本插件的 `/api/asr`（自带 OpenAI 兼容代理）；
 *   - 传入其他 `recognize` 即可接 **dsh-ears 的远程 `transcribe`**
 *     （见 `engines/ears.js`）—— 这样本插件不必自己实现 8 个 ASR 后端。
 *
 * ## 为什么不是"一直录、一直传"
 *
 * 那样既费流量又费钱（按秒计费的端点会哭），而且把静音片段传上去还会
 * 拉高幻觉率 —— Whisper 一类模型在长静音上极爱编出"谢谢观看"。
 *
 * 所以先在本地做**语音活动检测（VAD）**，只把真正有人说话的片段切出来上传。
 *
 * ## 为什么用 MediaRecorder 而不是自己编码 WAV
 *
 * MediaRecorder 直接产出 webm/opus（或浏览器支持的任意容器），
 * OpenAI 兼容端点普遍接受；自己把 Float32 转 WAV 要多写 40 行、多一次
 * 内存拷贝，还容易在采样率上翻车。交给浏览器更稳。
 *
 * ## VAD 的判据
 *
 * 用 RMS 能量 + **自适应噪声地板**：环境噪声在 0.002–0.02 之间浮动，
 * 写死阈值必然在某些房间失效。做法是维护一个滚动最小值作为地板，
 * 起音阈值取 `max(绝对下限, 地板 × 2.5)`。
 * 起音要连续 3 帧（150ms）确认，收音要连续 14 帧（700ms）静音才收尾 ——
 * 前者防咳嗽/敲键盘误触发，后者防句中换气被切断。
 */
import { UTTERANCE_SETTLE_MS } from "../constants.js";
import { transcribe, warn } from "../runtime.js";

/** 绝对能量下限（经验值：安静房间底噪约 0.002–0.006）。 */
const RMS_FLOOR = 0.008;

/** 起音确认帧数与收音确认帧数。 */
const ONSET_FRAMES = 3;
const HANGOVER_FRAMES = 14;

/** VAD 采样间隔（毫秒）。 */
const TICK_MS = 50;

/** 太短的片段直接丢弃（小于这个字节数基本是噪声）。 */
const MIN_BLOB_BYTES = 2000;

/** 探测本引擎的前置条件。 */
export function isAvailable() {
	return (
		typeof globalThis.navigator?.mediaDevices?.getUserMedia === "function" &&
		typeof globalThis.MediaRecorder === "function"
	);
}

/** 基于 VAD 分段 + 外部转写的引擎。 */
export class HttpAsrEngine {
	/**
	 * @param options - `{ language, maxSegmentMs, recognize?, onPartial, onFinal, onError, onClose }`。
	 *   `recognize(blob, language) => Promise<string>`；缺省走本插件 `/api/asr`。
	 */
	constructor(options) {
		this.options = options;
		this.recognize = options.recognize ?? ((blob, language) => transcribe(blob, language).then((r) => r?.text ?? ""));
		this.wanted = false;
		this.stream = null;
		this.context = null;
		this.analyser = null;
		this.buffer = null;
		this.timer = null;
		this.recorder = null;
		this.chunks = [];
		this.segmentStart = 0;
		this.loudFrames = 0;
		this.quietFrames = 0;
		this.inSpeech = false;
		this.busy = false;
		this.noiseFloor = RMS_FLOOR / 2;
	}

	/** 开始监听。 */
	async start() {
		if (this.wanted) return;
		this.wanted = true;
		try {
			await this.open();
		} catch (error) {
			this.wanted = false;
			this.options.onError?.(error);
		}
	}

	/** 打开麦克风并启动 VAD 循环。 */
	async open() {
		const stream = await globalThis.navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
		});
		if (!this.wanted) {
			for (const track of stream.getTracks()) track.stop();
			return;
		}
		this.stream = stream;
		const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
		this.context = new Ctor();
		const source = this.context.createMediaStreamSource(stream);
		this.analyser = this.context.createAnalyser();
		this.analyser.fftSize = 1024;
		this.analyser.smoothingTimeConstant = 0.4;
		source.connect(this.analyser);
		this.buffer = new Float32Array(this.analyser.fftSize);
		this.timer = setInterval(() => this.tick(), TICK_MS);
	}

	/** 停止监听并释放设备。 */
	stop() {
		this.wanted = false;
		clearInterval(this.timer);
		this.timer = null;
		this.abortSegment();
		if (this.stream !== null) {
			for (const track of this.stream.getTracks()) track.stop();
			this.stream = null;
		}
		if (this.context !== null) {
			this.context.close().catch(() => {});
			this.context = null;
		}
		this.analyser = null;
		this.buffer = null;
		this.options.onClose?.();
	}

	/**
	 * 一帧 VAD 判定。
	 */
	tick() {
		if (!this.analyser || !this.buffer) return;
		this.analyser.getFloatTimeDomainData(this.buffer);
		let sum = 0;
		for (let i = 0; i < this.buffer.length; i += 1) sum += this.buffer[i] * this.buffer[i];
		const rms = Math.sqrt(sum / this.buffer.length);

		// 噪声地板：只用"安静帧"更新，且缓慢下降，避免把说话音量当底噪。
		if (rms < this.noiseFloor) this.noiseFloor = this.noiseFloor * 0.98 + rms * 0.02;
		else this.noiseFloor = this.noiseFloor * 0.9995 + Math.min(rms, this.noiseFloor * 3) * 0.0005;

		const threshold = Math.max(RMS_FLOOR, this.noiseFloor * 2.5);

		if (!this.inSpeech) {
			if (rms > threshold) {
				this.loudFrames += 1;
				if (this.loudFrames >= ONSET_FRAMES) this.beginSegment();
			} else {
				this.loudFrames = 0;
			}
			return;
		}

		// 已在说话中：检查收音，或超过单段上限强制切段。
		if (rms < threshold * 0.7) this.quietFrames += 1;
		else this.quietFrames = 0;

		const duration = Date.now() - this.segmentStart;
		const reachedHangover = this.quietFrames >= HANGOVER_FRAMES;
		const reachedLimit = duration >= this.options.maxSegmentMs;
		if (reachedHangover || reachedLimit) this.endSegment();
	}

	/** 开始一段录音。 */
	beginSegment() {
		if (this.busy || this.recorder !== null) return;
		this.inSpeech = true;
		this.quietFrames = 0;
		this.loudFrames = 0;
		this.segmentStart = Date.now();
		this.chunks = [];
		try {
			this.recorder = new globalThis.MediaRecorder(this.stream, { mimeType: this.pickMimeType() });
		} catch (error) {
			warn("无法创建 MediaRecorder", error);
			this.inSpeech = false;
			return;
		}
		this.recorder.ondataavailable = (event) => {
			if (event.data && event.data.size > 0) this.chunks.push(event.data);
		};
		this.recorder.onstop = () => this.onSegmentReady();
		this.recorder.start();
	}

	/** 结束当前段。 */
	endSegment() {
		this.inSpeech = false;
		this.quietFrames = 0;
		const recorder = this.recorder;
		if (recorder === null) return;
		this.recorder = null;
		try {
			recorder.stop();
		} catch {
			// 已经停了。
		}
	}

	/** 丢弃当前段（停止监听时用）。 */
	abortSegment() {
		this.inSpeech = false;
		const recorder = this.recorder;
		this.recorder = null;
		this.chunks = [];
		if (recorder !== null) {
			recorder.onstop = null;
			recorder.ondataavailable = null;
			try {
				recorder.stop();
			} catch {
				// 忽略。
			}
		}
	}

	/** 选一个当前浏览器支持的容器。 */
	pickMimeType() {
		const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
		for (const candidate of candidates) {
			if (globalThis.MediaRecorder.isTypeSupported?.(candidate)) return candidate;
		}
		return "";
	}

	/** 一段录完：上传转写。 */
	async onSegmentReady() {
		const chunks = this.chunks;
		this.chunks = [];
		if (chunks.length === 0) return;
		const blob = new Blob(chunks, { type: chunks[0].type || "audio/webm" });
		if (blob.size < MIN_BLOB_BYTES) return;

		this.busy = true;
		this.options.onPartial?.("（识别中…）");
		try {
			const text = await this.recognize(blob, this.options.language ?? "zh-CN");
			const trimmed = typeof text === "string" ? text.trim() : "";
			if (trimmed !== "") this.options.onFinal?.(trimmed);
		} catch (error) {
			warn("转写失败", error);
			this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
		} finally {
			this.busy = false;
			this.options.onPartial?.("");
		}
	}
}
