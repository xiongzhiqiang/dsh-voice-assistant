/**
 * 本地 Whisper 端到端探针：直接验证「原生运行时 + 模型 + 音频格式」这条链。
 *
 * ## 为什么要单独有个探针
 *
 * 本地 Whisper 最容易失败的不是推理本身，而是**上游的三件事**：
 *   ① 原生运行时（whisper.node）能不能按变体加载；
 *   ② 模型文件在不在、sha256 对不对（手动拷进来的会被判 `unverified`）；
 *   ③ **音频格式**对不对 —— 它只吃 16 kHz 单声道 PCM16 WAV，
 *      而浏览器 `MediaRecorder` 产出的是 webm/opus。
 *
 * 前两件事是环境问题，第三件是**代码问题**。把三者分开验，才能一眼看出
 * 「配好了却不回文字」到底卡在哪一层。
 *
 * 用法：
 *     node tools/probe-local-whisper.mjs            # 全量
 *     node tools/probe-local-whisper.mjs --silence  # 只验运行时与格式（不加载模型）
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const PROFILE = "C:/Users/xqz19/.dsh/profiles/web/node_modules";
const CACHE = join(process.env.LOCALAPPDATA ?? "", "dsh-ears", "whisper");

const line = (mark, text) => console.log(`${mark} ${text}`);
const ok = (t) => line("  [OK]  ", t);
const bad = (t) => line("  [FAIL]", t);
const info = (t) => line("  [..]  ", t);

let failures = 0;
const expect = (cond, label) => {
	if (cond) ok(label);
	else {
		bad(label);
		failures += 1;
	}
};

console.log("\n========== 本地 Whisper 端到端探针 ==========\n");

/* ── ① 原生运行时 ─────────────────────────────────────────────── */
console.log("① 原生运行时（whisper.node）");
const platform = `${process.platform}-${process.arch}`;
info(`平台：${platform}`);
const pkgName = `@fugood/node-whisper-${platform}`;
const pkgDir = join(PROFILE, pkgName);
expect(existsSync(pkgDir), `平台原生包存在：${pkgName}`);

let module;
try {
	module = require(join(PROFILE, "@fugood/whisper.node"));
	ok("@fugood/whisper.node 可加载");
} catch (error) {
	bad(`@fugood/whisper.node 加载失败：${error.message}`);
	process.exit(1);
}

const loaded = await module.loadWhisperModule("default");
const ctxs = Object.keys(loaded).filter((k) => /Context$/.test(k));
info(`原生导出：${ctxs.join(", ") || "(空)"}`);
expect(ctxs.includes("WhisperContext"), "WhisperContext 在场");
expect(ctxs.includes("WhisperVadContext"), "WhisperVadContext 在场（VAD 可用）");

/* ── ② 模型文件 ───────────────────────────────────────────────── */
console.log("\n② 模型文件");
info(`缓存目录：${CACHE}`);
expect(existsSync(CACHE), "缓存目录存在");

const MANIFEST = {
	tiny: { file: "ggml-tiny.bin", sha: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21", bytes: 77691713 },
	base: { file: "ggml-base.bin", sha: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe", bytes: 147951465 },
	small: { file: "ggml-small.bin", sha: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b", bytes: 487601967 },
};

let modelPath = null;
let modelId = null;
if (existsSync(CACHE)) {
	for (const [id, def] of Object.entries(MANIFEST)) {
		const bin = join(CACHE, def.file);
		const marker = `${bin}.dsh-ears-done`;
		if (!existsSync(bin)) {
			info(`${id}：未下载`);
			continue;
		}
		const size = statSync(bin).size;
		const digest = createHash("sha256").update(readFileSync(bin)).digest("hex");
		const hasMarker = existsSync(marker);
		const sizeOk = size === def.bytes;
		const shaOk = digest === def.sha;
		info(`${id}：${size} B，marker=${hasMarker}，sha256 ${shaOk ? "匹配" : "不匹配"}`);
		if (sizeOk && shaOk && hasMarker && modelPath === null) {
			modelPath = bin;
			modelId = id;
		}
	}
}
expect(modelPath !== null, "至少有一个模型通过校验（size + sha256 + 完成标记）");
if (modelPath === null) {
	console.log("\n=> 没有可用模型。若 huggingface.co 不可达，用镜像：");
	console.log("   DSH_EARS_WHISPER_MODEL_BASE_URL=https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main\n");
}

/* ── ③ 音频格式闸门（最容易被忽略的一层） ─────────────────────── */
console.log("\n③ 音频格式闸门");
const HEADER = 44;
/** 按 dsh-ears 的 `audioToPcm16Wav` 生成 16 kHz 单声道 PCM16 WAV（此处为静音）。 */
function makeWav(seconds, sampleRate = 16000) {
	const frames = Math.round(seconds * sampleRate);
	const buf = Buffer.alloc(HEADER + frames * 2);
	buf.write("RIFF", 0, "ascii");
	buf.writeUInt32LE(36 + frames * 2, 4);
	buf.write("WAVE", 8, "ascii");
	buf.write("fmt ", 12, "ascii");
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20); // PCM
	buf.writeUInt16LE(1, 22); // 单声道
	buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(sampleRate * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write("data", 36, "ascii");
	buf.writeUInt32LE(frames * 2, 40);
	return buf;
}
const wav = makeWav(1);
/** 复刻 dsh-ears 宿主侧的 `isPcm16Mono16kWav` 判定。 */
function isPcm16Mono16kWav(b) {
	// `Buffer.toString(encoding, start, end)` —— 第三个参数是**结束下标**，不是长度。
	if (b.byteLength < 44 || b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") return false;
	let off = 12;
	let fmtOk = false;
	let dataOk = false;
	while (off + 8 <= b.byteLength) {
		const chunk = b.toString("ascii", off, off + 4);
		const size = b.readUInt32LE(off + 4);
		const body = off + 8;
		if (body + size > b.byteLength) return false;
		if (chunk === "fmt " && size >= 16)
			fmtOk = b.readUInt16LE(body) === 1 && b.readUInt16LE(body + 2) === 1 && b.readUInt32LE(body + 4) === 16000 && b.readUInt16LE(body + 14) === 16;
		if (chunk === "data" && size > 0) dataOk = true;
		off = body + size + (size % 2);
	}
	return fmtOk && dataOk;
}
expect(isPcm16Mono16kWav(wav), "自造 WAV 通过宿主侧 16k/单声道/PCM16 判定");
info("注意：本插件引擎现在发的是 webm/opus —— 本地 Whisper 会直接判 asrAudioInvalid");

if (process.argv.includes("--silence") || modelPath === null) {
	console.log(`\n========== 结果：${failures === 0 ? "通过" : failures + " 项失败"} ==========\n`);
	process.exit(failures === 0 ? 0 : 1);
}

/* ── ④ 真跑一次推理 ───────────────────────────────────────────── */
console.log("\n④ 真机推理（静音 1s，只验链路是否跑通）");
	const started = Date.now();
	try {
		const context = await module.initWhisper({ filePath: modelPath });
		// 原生层要的是 `ArrayBuffer`，不是 Node 的 `Buffer`（两者不同源）。
		const audio = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
		const { promise } = context.transcribeData(audio, { language: "zh" });
		const result = await promise;
	ok(`推理完成，耗时 ${Date.now() - started} ms`);
	const text = typeof result === "string" ? result : (result?.text ?? JSON.stringify(result));
	info(`识别结果（静音，预期为空或空白）："${String(text).trim()}"`);
	await context.release?.();
} catch (error) {
	bad(`推理失败：${error.message}`);
	failures += 1;
}

console.log(`\n========== 结果：${failures === 0 ? "全部通过" : failures + " 项失败"} ==========\n`);
process.exit(failures === 0 ? 0 : 1);
