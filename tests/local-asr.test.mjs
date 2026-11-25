/**
 * V2.1 内置识别的接线哨兵。
 *
 * 这里只测**不需要 native 的那一层**：配置默认值、清单数值、UI 文案、
 * 以及"探测优先问本插件 API 而不是 remote"。native 加载与真实转写由
 * `tools/probe-local-asr.mjs` 在真机上验（需要几百 MB 模型）。
 */
import { normalizeConfig, clientConfig } from "../lib/config.js";
import { SENSEVOICE_ASSETS, WHISPER_MODELS } from "../lib/asr/manifest.js";
import { engineOptions } from "../src/client/core/asr-preference.js";
import { probeSpeech } from "../src/client/core/engines/speech.js";
import { asrStatus, asrTranscribe } from "../src/client/core/runtime.js";
import { VoiceController } from "../src/client/core/controller.js";

const failures = [];
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures.push({ name, actual, expected });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` → ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`}`);
};
const report = () => {
	if (failures.length > 0) {
		console.error(`\n${failures.length} 项失败：`);
		for (const item of failures) console.error(`  - ${item.name}: ${JSON.stringify(item.actual)} / 期望 ${JSON.stringify(item.expected)}`);
		process.exitCode = 1;
	} else {
		console.log("全部通过");
	}
};

console.log("── V2.1 内置识别配置与清单 ──");

const normalized = normalizeConfig({});
check("内置识别默认开启", normalized.asr.local.enabled, true);
check("Whisper 默认 small", normalized.asr.local.whisperModel, "small");
check("SenseVoice 默认 int8", normalized.asr.local.sensevoicePrecision, "int8");
check("Whisper 语言钉死中文（短片段自动检测必错）", normalized.asr.local.whisperLanguage, "zh");
check("非法 Whisper 档位回落 small", normalizeConfig({ asr: { local: { whisperModel: "huge" } } }).asr.local.whisperModel, "small");
check("可显式关闭内置识别", normalizeConfig({ asr: { local: { enabled: false } } }).asr.local.enabled, false);
check("客户端配置带出内置档位", clientConfig(normalized).asr.local.whisperModel, "small");

check("Whisper small 清单字节数", WHISPER_MODELS.small.bytes, 487601967);
check("SenseVoice int8 清单字节数", SENSEVOICE_ASSETS["model.int8.onnx"].bytes, 239233841);
check("Silero VAD 在清单里", Object.hasOwn(SENSEVOICE_ASSETS, "silero_vad.onnx"), true);

console.log("── UI 文案不再指向外部插件 ──");
const options = engineOptions({ ears: true, sensevoice: true });
check("Whisper 选项标为内置", options.find((o) => o.value === "ears").label.includes("内置"), true);
check("SenseVoice 选项标为内置", options.find((o) => o.value === "sensevoice").label.includes("内置"), true);
check("选项值保持兼容（不破坏已存偏好）", options.map((o) => o.value), ["auto", "webspeech", "ears", "sensevoice", "http"]);

/** 临时替换 fetch，记录请求路径，用后恢复。 */
async function withFetch(handler, run) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, options) => {
		calls.push({ url, options });
		return handler(url, options);
	};
	try {
		return await run(calls);
	} finally {
		globalThis.fetch = original;
	}
}

console.log("── 探测优先走本插件 API ──");
await withFetch(
	async () => ({
		ok: true,
		json: async () => ({
			ok: true,
			sensevoice: { available: true, model: "SenseVoice Small int8", precision: "int8" },
			whisper: { available: false, reason: "missing" },
		}),
	}),
	async (calls) => {
		// 即使 ctx 上挂着一个官方 remote.speech，也应先被内置探测截获。
		const fakeCtx = { get: (name) => (name === "remote.speech" ? { transcribe: () => {} } : undefined) };
		const probe = await probeSpeech(fakeCtx);
		check("内置可用时探测成功", probe.available, true);
		check("探测标记 via=local", probe.via, "local");
		check("探测证据含 local-asr-api", probe.paths.some((p) => p.from === "local-asr-api"), true);
		check("探测只打本插件状态接口", calls.length >= 1, true);
		check("状态接口路径正确", String(calls[0].url).endsWith("/asr/status"), true);
	},
);

await withFetch(
	async () => ({ ok: true, json: async () => ({ ok: true, text: "你好", via: "local" }) }),
	async (calls) => {
		const result = await asrTranscribe("whisper", "AAAA", "zh");
		check("转写请求打到 /asr/local", String(calls[0].url).endsWith("/asr/local"), true);
		check("请求体带 engine/audio/language", JSON.parse(calls[0].options.body).engine, "whisper");
		check("返回内置转写文本", result.text, "你好");
	},
);

await withFetch(
	async () => { throw new Error("no-server"); },
	async () => {
		const status = await asrStatus().catch((error) => ({ error: String(error.message) }));
		check("API 不可用时如实抛错（由调用方降级）", status.error, "no-server");
	},
);

console.log("── 首帧装配不能被强制引擎打断 ──");
// 回归：V2.1 曾把 asrPreference 的读取放在 createEngine() 之后。配置强制
// sensevoice 时，构造引擎当场读 `this.asrPreference.language` →
// TypeError → 语音球/桌宠整个不挂载（用户看到的就是"卡通消失了"）。
{
	let constructed = false;
	let error = null;
	try {
		const cfg = {
			language: "zh-CN",
			wake: {},
			sleep: { idleTimeoutMs: 60000 },
			asr: { engine: "sensevoice", maxSegmentMs: 15000 },
			tts: {},
			polish: {},
			session: {},
			agent: {},
			routing: {},
			answers: {},
			interactions: {},
			memory: {},
			turn: {},
			ui: {},
			capabilities: {},
		};
		const controller = new VoiceController({ ctx: {}, config: cfg });
		constructed = true;
		check("强制 SenseVoice 时偏好已就位", controller.asrPreference?.language, "auto");
	} catch (caught) {
		error = caught?.message ?? String(caught);
	}
	check("强制 SenseVoice 时控制器可正常构造", constructed, true);
	check("构造过程无异常", error, null);
}

console.log("── 可用性探测不受当前引擎门控（UI 两个选项都要如实标注）──");
// 回归：V2.1 的 detectEars() 有 `preferred !== auto/ears → return`，
// 配置固定 sensevoice 时 Whisper 根本没探测，UI 标「未检测到」，
// 但模型就在项目里、API 也报 available:true。
await withFetch(
	async () => ({
		ok: true,
		json: async () => ({
			ok: true,
			enabled: true,
			dataRoot: "C:/fake",
			sensevoice: { available: true, model: "SenseVoice Small int8", precision: "int8" },
			whisper: { available: true, model: "small", language: "zh" },
		}),
	}),
	async () => {
		const cfg = {
			language: "zh-CN",
			wake: {},
			sleep: { idleTimeoutMs: 60000 },
			asr: { engine: "sensevoice", httpReady: false, maxSegmentMs: 15000 },
			tts: {},
			polish: {},
			session: {},
			agent: {},
			routing: {},
			answers: {},
			interactions: {},
			memory: {},
			turn: {},
			ui: {},
			capabilities: {},
		};
		const controller = new VoiceController({ ctx: {}, config: cfg });
		await controller.detectEars({ silent: true });
		await controller.detectSpeech({ silent: true });
		check("强制 SenseVoice 时 Whisper 仍被探测", controller.earsAvailable, true);
		check("Whisper 探测走内置 API", controller.earsVia, "local");
		check("强制 SenseVoice 时 SenseVoice 可用", controller.speechAvailable, true);
		check("探测不抢引擎（仍是被选的 SenseVoice）", controller.getSnapshot().engine, "sensevoice");
	},
);

console.log("── 首帧引擎识别必须走内置 API（不能卡在 remote 抛 speech-unavailable）──");
// 回归：V2.1 曾让 createEngine() 早于 speechVia 初始化，recognizer 构造时把
// via=undefined 快照成 remote。探测异步改成 local 也没用 —— 说话时
// speechNamespace(ctx) 取不到 → 抛 speech-unavailable，即使模型全部就绪。
{
	const hadFileReader = Object.hasOwn(globalThis, "FileReader");
	const hadAudioContext = Object.hasOwn(globalThis, "AudioContext");
	globalThis.FileReader = class {
		readAsDataURL(blob) {
			blob.arrayBuffer().then((buf) => {
				this.result = `data:audio/wav;base64,${Buffer.from(buf).toString("base64")}`;
				this.onload?.();
			});
		}
	};
	globalThis.AudioContext = class {
		async decodeAudioData() {
			return { sampleRate: 16000, length: 1600, numberOfChannels: 1, getChannelData: () => new Float32Array(1600) };
		}
		async close() {}
	};
	try {
		await withFetch(
			async (url) => {
				if (String(url).includes("/asr/status")) {
					return {
						ok: true,
						json: async () => ({
							ok: true,
							enabled: true,
							sensevoice: { available: true, model: "SenseVoice Small int8", precision: "int8" },
							whisper: { available: true, model: "small", language: "zh" },
						}),
					};
				}
				if (String(url).includes("/asr/local")) return { ok: true, json: async () => ({ ok: true, text: "你好", via: "local" }) };
				return { ok: false, json: async () => ({}) };
			},
			async (calls) => {
				const cfg = {
					language: "zh-CN",
					wake: {},
					sleep: { idleTimeoutMs: 60000 },
					asr: { engine: "sensevoice", httpReady: false, maxSegmentMs: 15000 },
					tts: {}, polish: {}, session: {}, agent: {}, routing: {}, answers: {},
					interactions: {}, memory: {}, turn: {}, ui: {}, capabilities: {},
				};
				const controller = new VoiceController({ ctx: {}, config: cfg });
				check("首帧 speechVia 已就位（不早于 createEngine）", controller.speechVia, "local");
				await controller.detectSpeech({ silent: true });
				const blob = new Blob([new Uint8Array(3200)], { type: "audio/wav" });
				let text = null;
				let error = null;
				try {
					text = await controller.engine.recognize(blob);
				} catch (caught) {
					error = caught?.message ?? String(caught);
				}
				check("强制 SenseVoice 识别无异常（不再 speech-unavailable）", error, null);
				check("识别结果来自内置 API", text, "你好");
				check("实际请求了 /asr/local", calls.some((c) => String(c.url).includes("/asr/local")), true);
				controller.dispose?.();
			},
		);
	} finally {
		if (!hadFileReader) delete globalThis.FileReader;
		if (!hadAudioContext) delete globalThis.AudioContext;
	}
}

report();
