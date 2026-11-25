/**
 * 内置识别子进程：SenseVoice（sherpa-onnx）与本地 Whisper（whisper.cpp）。
 *
 * ## 为什么必须放子进程
 *
 * 两条推理路径都是**同步 native 调用**：SenseVoice 的 `decode()` 会占满
 * 一个线程几十秒，Whisper 的 addon 甚至有不可恢复的 native assertion。
 * 放在 DSH 宿主进程里，一次长音频就能卡住整个会话/API。子进程里失败
 * 只影响这一条识别，宿主可以杀掉重启。
 *
 * ## 代码来源
 *
 * SenseVoice 的 VAD 切句 / recognizer 配置逐字搬自官方
 * `dsh-experimental-speech-to-text-sensevoice/lib/worker.js`；
 * Whisper 的 `initWhisper` / `transcribeFile` 调用搬自 `dsh-ears/lib/asr/whisper-worker.js`。
 * 差别是：不再依赖 zod / schemastery / dsh-timeout，也不再从 DSH 的
 * 远程服务取模型路径 —— 全部由本项目的 manifest + HTTP API 提供。
 *
 * ## 协议
 *
 * 父进程通过 `DSH_ASR_WORKER_CONFIG`（JSON，环境变量）传初始化参数；
 * 加载完成后向 IPC 发 `{type:"ready"}`。之后每条请求是
 * `{id, type:"transcribe", audioBase64, language}`，回
 * `{id, ok, text, audioSeconds?, inferenceSeconds?}` 或 `{id, ok:false, error}`。
 */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VENDOR_MODULES } from "./manifest.js";

/** 从本项目 `vendor/node_modules` 解析原生包（不碰 DSH profile 的依赖树）。 */
const vendorRequire = createRequire(join(VENDOR_MODULES, "__xfv-noop__.cjs"));

/** 支持的语言（与 SenseVoice 官方一致）。 */
export const LANGUAGES = ["auto", "zh", "en", "yue", "ja", "ko"];

/** 校验 16 kHz 单声道 PCM16 WAV（与官方 `validateWave` 同款硬判据）。 */
function validateWave(audio, maxDurationSeconds) {
	const data = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
	if (
		data.length < 46 ||
		data.toString("ascii", 0, 4) !== "RIFF" ||
		data.toString("ascii", 8, 12) !== "WAVE" ||
		data.toString("ascii", 12, 16) !== "fmt " ||
		data.readUInt32LE(16) !== 16 ||
		data.readUInt16LE(20) !== 1 ||
		data.readUInt16LE(22) !== 1 ||
		data.readUInt32LE(24) !== 16000 ||
		data.readUInt32LE(28) !== 32000 ||
		data.readUInt16LE(32) !== 2 ||
		data.readUInt16LE(34) !== 16 ||
		data.toString("ascii", 36, 40) !== "data" ||
		data.readUInt32LE(4) !== data.length - 8 ||
		data.readUInt32LE(40) !== data.length - 44 ||
		(data.length - 44) % 2 !== 0
	) {
		throw new Error("audio must be a canonical 16 kHz mono PCM16 WAV recording");
	}
	const seconds = (data.length - 44) / 32000;
	if (seconds > maxDurationSeconds) throw new Error(`audio exceeds ${maxDurationSeconds} seconds`);
	return seconds;
}

/** 建立 SenseVoice + Silero VAD 的一次性 recognizer。 */
function createSensevoiceTranscriber(config) {
	const sherpa = vendorRequire("sherpa-onnx-node");
	const nativeConfig = {
		featConfig: { sampleRate: 16000, featureDim: 80 },
		modelConfig: {
			senseVoice: {
				model: config.paths.model,
				language: "auto",
				useInverseTextNormalization: 1,
			},
			tokens: config.paths.tokens,
			numThreads: config.threads ?? 2,
			provider: "cpu",
			debug: 0,
		},
	};
	const recognizer = new sherpa.OfflineRecognizer(nativeConfig);
	const detector = new sherpa.Vad(
		{
			sileroVad: {
				model: config.paths.vad,
				threshold: config.vadThreshold ?? 0.5,
				minSilenceDuration: config.minSilenceSeconds ?? 0.5,
				minSpeechDuration: config.minSpeechSeconds ?? 0.25,
				maxSpeechDuration: config.segmentSeconds ?? 30,
				windowSize: 512,
			},
			sampleRate: 16000,
			numThreads: config.threads ?? 2,
			provider: "cpu",
			debug: 0,
		},
		(config.segmentSeconds ?? 30) + (config.minSilenceSeconds ?? 0.5) + 1,
	);
	return (audio, language) => {
		const audioSeconds = validateWave(audio, (config.maxAudioBytes ?? 4 * 1024 * 1024) / 32000);
		const pcm = new DataView(audio.buffer, audio.byteOffset + 44, audio.byteLength - 44);
		const samples = Float32Array.from({ length: pcm.byteLength / 2 }, (_, i) => pcm.getInt16(i * 2, true) / 32768);
		nativeConfig.modelConfig.senseVoice.language = LANGUAGES.includes(language) ? language : "auto";
		recognizer.setConfig(nativeConfig);
		detector.reset();
		const started = performance.now();
		const texts = [];
		const onsetPadding = Math.round((config.vadOnsetPaddingSeconds ?? 0.3) * 16000);
		let isFirstSegment = true;
		const drain = () => {
			while (!detector.isEmpty()) {
				const segment = detector.front(false);
				let speech = segment.samples;
				if (isFirstSegment) {
					isFirstSegment = false;
					const from = Math.max(0, segment.start - onsetPadding);
					if (from < segment.start) {
						const restored = new Float32Array(segment.start - from + speech.length);
						restored.set(samples.subarray(from, segment.start));
						restored.set(speech, segment.start - from);
						speech = restored;
					}
				}
				const stream = recognizer.createStream();
				stream.acceptWaveform({ sampleRate: 16000, samples: speech });
				recognizer.decode(stream);
				texts.push(recognizer.getResult(stream).text.trim());
				detector.pop();
			}
		};
		for (let offset = 0; offset < samples.length; offset += 512) {
			detector.acceptWaveform(samples.subarray(offset, offset + 512));
			drain();
		}
		detector.flush();
		drain();
		return {
			text: texts.filter(Boolean).join(" ").trim(),
			audioSeconds,
			inferenceSeconds: (performance.now() - started) / 1000,
		};
	};
}

/** 建立本地 Whisper 的 recognizer，并固定语言避免短片段自动检测幻觉。 */
async function createWhisperTranscriber(config) {
	const module = vendorRequire("@fugood/whisper.node");
	await module.loadWhisperModule("default");
	const context = await module.initWhisper({ filePath: config.paths.model, useGpu: false }, "default");
	return async (audio, language) => {
		validateWave(audio, 60);
		const tempPath = join(tmpdir(), `xfv-asr-${process.pid}-${randomUUID()}.wav`);
		writeFileSync(tempPath, audio);
		try {
			const hint = language && language !== "auto" ? language : config.language || undefined;
			const job = context.transcribeFile(tempPath, {
				language: hint,
				translate: false,
				temperature: 0,
			});
			const result = await job.promise;
			return { text: String(result?.result ?? "").trim(), isAborted: result?.isAborted === true };
		} finally {
			try {
				unlinkSync(tempPath);
			} catch {
				// 临时文件删不掉不影响识别结果，别让它盖掉真正的成功。
			}
		}
	};
}

function send(message) {
	if (typeof process.send !== "function" || !process.connected) return;
	try {
		process.send(message, () => {});
	} catch {
		// 父进程已退出：无需再报。
	}
}

async function main() {
	const config = JSON.parse(process.env.DSH_ASR_WORKER_CONFIG ?? "{}");
	const transcribe = config.engine === "whisper"
		? await createWhisperTranscriber(config)
		: createSensevoiceTranscriber(config);
	send({ type: "ready", engine: config.engine });

	process.on("message", async (message) => {
		if (message?.type !== "transcribe") return;
		try {
			const audio = Buffer.from(message.audioBase64 ?? "", "base64");
			if (audio.length === 0) throw new Error("empty audio");
			const result = await transcribe(audio, message.language ?? "auto");
			send({ id: message.id, ok: true, ...result });
		} catch (error) {
			send({ id: message.id, ok: false, error: String(error?.message ?? error) });
		}
	});
	process.on("disconnect", () => process.exit(0));
	for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
}

main().catch((error) => {
	process.stderr.write(`${String(error?.stack ?? error)}\n`);
	send({ type: "error", message: String(error?.message ?? error) });
	setTimeout(() => process.exit(1), 50).unref();
});
