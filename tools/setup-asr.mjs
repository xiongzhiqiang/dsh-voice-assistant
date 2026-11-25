/**
 * 安装内置语音识别模型（不依赖 dsh-ears / voice-input-bundle 是否安装）。
 *
 *     node tools/setup-asr.mjs                 # Whisper small + SenseVoice int8
 *     node tools/setup-asr.mjs --model tiny    # 换 Whisper 档位
 *     node tools/setup-asr.mjs --no-download   # 只从本机已有插件目录搬运，不联网
 *
 * 顺序：已校验的目标文件 → 本机旧插件目录（校验通过后复制）→ 下载（带镜像回退）。
 * 每一步都做 字节数 + SHA256 全量校验：随便拷一个同名文件不算装好，
 * 这是 dsh-ears 原先的纪律，搬过来继续用。
 *
 * 目标目录默认是项目内 `.data/asr/`，可用 `DSH_VOICE_ASR_HOME` 改。
 * `.data/` 不进 git；源码仓库只带清单和脚本。
 */
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
	PROJECT_ROOT, SENSEVOICE_ASSETS, WHISPER_MODELS, asrDataRoot,
	sensevoiceAssetPath, whisperModelPath,
} from "../lib/asr/manifest.js";

/** 解析命令行（只认 `--model <name>` / `--no-download`）。 */
function args(argv) {
	let model = "small";
	let allowDownload = true;
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--model" && i + 1 < argv.length) model = argv[++i];
		else if (argv[i] === "--no-download") allowDownload = false;
		else if (argv[i] === "--help") {
			console.log("Usage: node tools/setup-asr.mjs [--model tiny|base|small|medium|large|turbo] [--no-download]");
			process.exit(0);
		}
	}
	if (!Object.hasOwn(WHISPER_MODELS, model)) throw new Error(`unknown whisper model: ${model}`);
	return { model, allowDownload };
}

/** 流式校验。 */
async function digest(path) {
	const hash = createHash("sha256");
	await new Promise((ok, fail) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", fail);
		stream.on("end", ok);
	});
	return hash.digest("hex");
}

/** 校验一个文件是否符合清单。 */
async function verified(path, spec) {
	if (!existsSync(path)) return false;
	try {
		if (statSync(path).size !== spec.bytes) return false;
		return (await digest(path)) === spec.sha256;
	} catch {
		return false;
	}
}

/** 本机旧插件目录里的候选源（只读，校验通过才复制）。 */
function legacySources(key, spec, whisperModel) {
	const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
	if (key === "whisper") return [join(localAppData, "dsh-ears", "whisper", spec.file)];
	return [join(homedir(), ".dsh", "speech-to-text", "sensevoice", "models", spec.file)];
}

/** 下载（hf → hf-mirror 回退），写入 `.partial` 后原子改名。 */
async function download(url, target) {
	mkdirSync(dirname(target), { recursive: true });
	const partial = `${target}.partial`;
	const urls = [url];
	if (url.startsWith("https://huggingface.co/")) {
		urls.push(url.replace("https://huggingface.co/", "https://hf-mirror.com/"));
	}
	let lastError = null;
	for (const candidate of urls) {
		try {
			const response = await fetch(candidate, { redirect: "follow" });
			if (!response.ok) throw new Error(`http-${response.status}`);
			const writer = createWriteStream(partial);
			for await (const chunk of response.body) writer.write(chunk);
			await new Promise((ok, fail) => writer.end(ok));
			renameSync(partial, target);
			return;
		} catch (error) {
			lastError = error;
			try {
				unlinkSync(partial);
			} catch {
				// 文件本来就不存在：忽略。
			}
		}
	}
	throw new Error(`download failed: ${String(lastError?.message ?? lastError)}`);
}

/** 安装一个资产：已有 → 旧目录复制 → 下载。 */
async function installAsset(label, key, spec, target, allowDownload) {
	if (await verified(target, spec)) return { key, status: "valid", path: target, bytes: spec.bytes };
	for (const source of legacySources(key, spec, label)) {
		if (!existsSync(source)) continue;
		if (!(await verified(source, spec))) continue;
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(source, target);
		return { key, status: "copied", from: source, path: target, bytes: spec.bytes };
	}
	if (!allowDownload) return { key, status: "missing", path: target, reason: "not-found-locally" };
	await download(spec.url, target);
	if (!(await verified(target, spec))) throw new Error(`${label}: downloaded file failed verification`);
	return { key, status: "downloaded", path: target, bytes: spec.bytes };
}

async function main() {
	const { model, allowDownload } = args(process.argv.slice(2));
	const root = asrDataRoot();
	console.log(`[setup-asr] 目标目录 ${root}（项目根 ${PROJECT_ROOT}）`);
	const results = [];

	// Whisper（只装选中的一档，默认 small；tiny 作为可选项可再跑一次）。
	const whisperSpec = WHISPER_MODELS[model];
	results.push(await installAsset(`whisper:${model}`, "whisper", whisperSpec, whisperModelPath(model), allowDownload));

	// SenseVoice：int8 模型 + tokens + Silero VAD（fp32 894MB 按需另行下载）。
	for (const key of ["model.int8.onnx", "tokens.txt", "silero_vad.onnx"]) {
		results.push(await installAsset(`sensevoice:${key}`, "sensevoice", SENSEVOICE_ASSETS[key], sensevoiceAssetPath(key), allowDownload));
	}

	console.log(JSON.stringify({ ok: true, root, results }, null, 2));
}

main().catch((error) => {
	console.error(`[setup-asr] FAILED: ${error?.stack ?? error}`);
	process.exitCode = 1;
});
