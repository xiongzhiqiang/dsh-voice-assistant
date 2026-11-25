/**
 * 自包含本地识别服务（宿主侧）。
 *
 * ## 它替代了什么
 *
 * V2.0 之前，`sensevoice` 走 DSH 官方 `voice-input-bundle` 的 `remote.speech`，
 * `ears` 走 `dsh-ears` 的 `remote.dshEars`。两个都是**外部插件**，没装就没得用。
 * V2.1 把这两条推理链连同原生包、模型清单一起搬进本项目：
 *
 *     浏览器 PCM16 WAV → 本插件 HTTP API → 本项目子进程 → vendored native → 文本
 *
 * 全程不经过 DSH 的 remote/typert 通道，也不读任何插件目录。
 *
 * ## 可用性判定
 *
 * `status()` 只查"原生包在不在 + 模型字节数/SHA256 对不对"，**不加载 addon**。
 * 加载 native 放到第一次真实转写（子进程）里做 —— 宿主进程不能承担
 * native assertion 的风险。校验结果按 `{size,mtimeMs}` 缓存，避免每次
 * health 都重新哈希几百 MB 模型。
 *
 * ## 一个引擎一个子进程
 *
 * native recognizer 不是并发安全的；同一引擎的请求用 promise 链串行。
 * 不同引擎各有独立子进程，可以并行。子进程退出（崩溃/超时）后置空，
 * 下一条请求会重新拉起。
 */
import { fork } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	PROJECT_ROOT, SENSEVOICE_ASSETS, WHISPER_MODELS, asrDataRoot,
	nativeRuntimeState, sensevoiceAssetPath, verifyFile, whisperModelPath,
} from "./manifest.js";

/** worker 入口（绝对路径，避免 cwd 差异）。 */
const WORKER_PATH = fileURLToPath(new URL("./worker.js", import.meta.url));

/** 子进程启动等待（首次要加载几百 MB 模型，给足时间）。 */
const READY_TIMEOUT_MS = 180000;
/** 单条转写超时。 */
const TRANSCRIBE_TIMEOUT_MS = 180000;
/** 子进程最近一段 stderr（诊断用，防止无限增长）。 */
const STDERR_LIMIT = 8192;

/** 带超时的 promise 竞速；超时后由调用方决定如何处理子进程。 */
function withTimeout(promise, ms, label) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label}-timeout-${ms}ms`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

/**
 * 创建自包含识别服务。
 *
 * @param config - 归一化配置（用 `config.asr.local`）。
 * @param logger - 可选 logger（只用于成功/失败的可观测日志）。
 */
export function createLocalAsr(config, logger = null) {
	const local = config?.asr?.local ?? {};
	const enabled = local.enabled !== false;
	const whisperModel = Object.hasOwn(WHISPER_MODELS, local.whisperModel) ? local.whisperModel : "small";
	const precision = local.sensevoicePrecision === "fp32" ? "fp32" : "int8";
	const whisperLanguage = typeof local.whisperLanguage === "string" && local.whisperLanguage !== ""
		? local.whisperLanguage
		: "zh";

	/** engine → 子进程运行态 `{ child, pending, next, stderr, modelKey }`。 */
	const workers = new Map();
	/** 模型校验缓存：`path` → `{ sig, result }`。 */
	const verifyCache = new Map();
	let disposed = false;

	/** 校验结果缓存（模型几百 MB，不能每次 status 都重新哈希）。 */
	async function cachedVerify(filePath, spec) {
		let sig = "missing";
		try {
			const stat = statSync(filePath);
			sig = `${stat.size}:${stat.mtimeMs}`;
		} catch {
			// 文件不存在：直接返回 missing，不进缓存。
			verifyCache.delete(filePath);
			return { ok: false, reason: "missing" };
		}
		const cached = verifyCache.get(filePath);
		if (cached !== undefined && cached.sig === sig) return cached.result;
		const result = await verifyFile(filePath, spec);
		verifyCache.set(filePath, { sig, result });
		return result;
	}

	/** SenseVoice 推理所需的全部文件是否齐备。 */
	async function sensevoiceStatus() {
		if (!enabled) return { available: false, reason: "disabled", model: "", files: [] };
		const native = nativeRuntimeState();
		if (!native.sensevoice) return { available: false, reason: "native-runtime-missing", model: "", files: [] };
		const keys = precision === "fp32"
			? ["model.onnx", "tokens.txt", "silero_vad.onnx"]
			: ["model.int8.onnx", "tokens.txt", "silero_vad.onnx"];
		const files = [];
		for (const key of keys) {
			const path = sensevoiceAssetPath(key);
			const result = await cachedVerify(path, SENSEVOICE_ASSETS[key]);
			files.push({ key, path, ok: result.ok, reason: result.reason ?? "" });
		}
		const missing = files.filter((file) => !file.ok);
		return {
			available: missing.length === 0,
			reason: missing.length === 0 ? "" : `invalid:${missing.map((file) => file.key).join(",")}`,
			model: precision === "fp32" ? "SenseVoice Small fp32" : "SenseVoice Small int8",
			precision,
			files,
		};
	}

	/** 本地 Whisper 模型是否齐备。 */
	async function whisperStatus() {
		if (!enabled) return { available: false, reason: "disabled", model: "", files: [] };
		const native = nativeRuntimeState();
		if (!native.whisper) return { available: false, reason: "native-runtime-missing", model: "", files: [] };
		const path = whisperModelPath(whisperModel);
		const result = await cachedVerify(path, WHISPER_MODELS[whisperModel]);
		return {
			available: result.ok,
			reason: result.ok ? "" : result.reason ?? "invalid",
			model: whisperModel,
			language: whisperLanguage,
			files: [{ key: whisperModel, path, ok: result.ok, reason: result.reason ?? "" }],
		};
	}

	/** 对外状态（health / UI 探测共用）。 */
	function status() {
		return Promise.all([sensevoiceStatus(), whisperStatus()]).then(([sensevoice, whisper]) => ({
			enabled,
			dataRoot: asrDataRoot(),
			sensevoice,
			whisper,
		}));
	}

	/** 组装子进程初始化参数。 */
	function workerConfig(engine) {
		if (engine === "whisper") {
			return {
				engine,
				paths: { model: whisperModelPath(whisperModel) },
				language: whisperLanguage,
			};
		}
		return {
			engine: "sensevoice",
			paths: {
				model: sensevoiceAssetPath(precision === "fp32" ? "model.onnx" : "model.int8.onnx"),
				tokens: sensevoiceAssetPath("tokens.txt"),
				vad: sensevoiceAssetPath("silero_vad.onnx"),
			},
			threads: 2,
			segmentSeconds: 30,
			vadThreshold: 0.5,
			minSilenceSeconds: 0.5,
			minSpeechSeconds: 0.25,
			vadOnsetPaddingSeconds: 0.3,
			maxAudioBytes: 4 * 1024 * 1024,
		};
	}

	/** 启动一个引擎的子进程（并发调用共享同一个 promise）。 */
	function ensureWorker(engine) {
		const existing = workers.get(engine);
		if (existing !== undefined) return existing;
		const runtime = {
			child: null,
			pending: new Map(),
			next: Promise.resolve(),
			stderr: "",
			seq: 0,
		};
		workers.set(engine, runtime);

		const child = fork(WORKER_PATH, [], {
			cwd: PROJECT_ROOT,
			env: { ...process.env, DSH_ASR_WORKER_CONFIG: JSON.stringify(workerConfig(engine)) },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		runtime.child = child;
		child.stderr?.on("data", (chunk) => {
			runtime.stderr = (runtime.stderr + String(chunk)).slice(-STDERR_LIMIT);
		});
		child.stdout?.on("data", (chunk) => {
			runtime.stderr = (runtime.stderr + String(chunk)).slice(-STDERR_LIMIT);
		});

		// 就绪 / 失败信号：只在启动阶段关心。
		const started = new Promise((resolveReady, rejectReady) => {
			const onMessage = (message) => {
				if (message?.type === "ready") {
					// 不能在这里 off：同一个监听器还负责后续每条 transcribe 的回包。
					resolveReady();
				} else if (message?.type === "error") {
					child.off("message", onMessage);
					rejectReady(new Error(String(message.message ?? "worker-init-failed")));
				} else if (typeof message?.id === "number") {
					const pending = runtime.pending.get(message.id);
					if (pending === undefined) return;
					runtime.pending.delete(message.id);
					clearTimeout(pending.timer);
					if (message.ok === true) pending.resolve(message);
					else pending.reject(new Error(String(message.error ?? "transcribe-failed")));
				}
			};
			child.on("message", onMessage);
			child.once("exit", (code, signal) => {
				for (const pending of runtime.pending.values()) {
					clearTimeout(pending.timer);
					pending.reject(new Error(`asr-worker-exited:${code ?? signal}:${runtime.stderr.trim()}`));
				}
				runtime.pending.clear();
				if (workers.get(engine) === runtime) workers.delete(engine);
				logger?.warn?.(`voice-assistant: ${engine} 识别子进程退出（${code ?? signal}） ${runtime.stderr.trim()}`);
			});
			child.once("error", (error) => {
				rejectReady(new Error(`worker-spawn-failed:${error.message}`));
			});
		});

		runtime.ready = withTimeout(started, READY_TIMEOUT_MS, "asr-worker-ready")
			.then(() => {
				logger?.info?.(`voice-assistant: 内置 ${engine} 识别子进程已就绪`);
				return runtime;
			})
			.catch((error) => {
				try {
					child.kill();
				} catch {
					// 已退出：忽略。
				}
				if (workers.get(engine) === runtime) workers.delete(engine);
				throw new Error(`${error.message}${runtime.stderr.trim() ? `: ${runtime.stderr.trim()}` : ""}`);
			});
		return runtime.ready;
	}

	/** 真正发一条转写请求（同一引擎串行）。 */
	function transcribeOn(engine, audio, language) {
		const run = async () => {
			const runtime = await ensureWorker(engine);
			const id = ++runtime.seq;
			return withTimeout(
				new Promise((resolve, reject) => {
					const timer = setTimeout(() => {
						runtime.pending.delete(id);
						reject(new Error("asr-transcribe-timeout"));
					}, TRANSCRIBE_TIMEOUT_MS);
					runtime.pending.set(id, { resolve, reject, timer });
					runtime.child.send({
						id,
						type: "transcribe",
						audioBase64: Buffer.from(audio).toString("base64"),
						language: language ?? "auto",
					});
				}),
				TRANSCRIBE_TIMEOUT_MS + 1000,
				"asr-transcribe",
			);
		};
		const runtime = workers.get(engine);
		if (runtime === undefined) return run();
		const chained = runtime.next.then(run, run);
		runtime.next = chained.then(() => {}, () => {});
		return chained;
	}

	/** 对外转写入口：`engine` 只接受 `sensevoice` / `whisper`。 */
	async function transcribe(engine, audio, language = "auto") {
		if (disposed) throw new Error("asr-local-disposed");
		if (engine !== "sensevoice" && engine !== "whisper") throw new Error("asr-unsupported-engine");
		if (!Buffer.isBuffer(audio) || audio.length === 0) throw new Error("empty-audio");
		const result = await transcribeOn(engine, audio, language);
		return {
			text: typeof result.text === "string" ? result.text : "",
			via: "local",
			engine,
			...(Number.isFinite(result.audioSeconds) ? { audioSeconds: result.audioSeconds } : {}),
			...(Number.isFinite(result.inferenceSeconds) ? { inferenceSeconds: result.inferenceSeconds } : {}),
		};
	}

	/** 简易健康视图（同步字段 + 最新校验结果由 status() 另取）。 */
	function state() {
		return {
			enabled,
			whisperModel,
			precision,
			whisperLanguage,
			dataRoot: asrDataRoot(),
			workers: [...workers.entries()].map(([engine, runtime]) => ({
				engine,
				pid: runtime.child?.pid ?? null,
				pending: runtime.pending.size,
			})),
			native: nativeRuntimeState(),
		};
	}

	/** 卸载：杀掉所有子进程，拒绝在途请求。 */
	function dispose() {
		disposed = true;
		for (const runtime of workers.values()) {
			for (const pending of runtime.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error("asr-local-disposed"));
			}
			runtime.pending.clear();
			try {
				runtime.child?.kill();
			} catch {
				// 已退出：忽略。
			}
		}
		workers.clear();
	}

	return { status, transcribe, state, dispose };
}
