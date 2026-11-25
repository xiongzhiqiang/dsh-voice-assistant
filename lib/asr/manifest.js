/**
 * 内置语音识别的资源清单（模型 / 原生运行时）。
 *
 * ## 为什么把清单抄进本项目
 *
 * 官方 `voice-input-bundle` 与 `dsh-ears` 各自把模型 URL、字节数、SHA256
 * 写死在自己的包里。本插件不再依赖它们安装，就必须自己持有这份清单 ——
 * 否则"模型在不在、完不完整"这件事无从判断，只能等原生推理报一个没有
 * 指向性的错误。下面的数值逐字来自：
 *   - SenseVoice：`dsh-experimental-speech-to-text-sensevoice/runtime/assets.json`
 *   - Whisper：`dsh-ears/lib/index.js` 的 `WHISPER_MODEL_MANIFEST`
 *
 * ## 模型放哪
 *
 * 默认 `<项目根>/.data/asr/`，可用 `DSH_VOICE_ASR_HOME` 覆盖。绝不复用
 * `%LOCALAPPDATA%/dsh-ears` 或 `~/.dsh/speech-to-text` —— 那些目录归插件
 * 所有，会被用户卸载/升级清掉；本项目必须自己管自己的模型。
 *
 * `.data/` 不进 git（几百 MB 二进制），由 `tools/setup-asr.mjs` 安装。
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根目录（`lib/asr/manifest.js` 往上两层）。 */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 自包含运行时（原生包）根目录；`vendor/node_modules/<pkg>` 按 Node 规则可解析。 */
export const VENDOR_MODULES = join(PROJECT_ROOT, "vendor", "node_modules");

/** 模型根目录（可用环境变量挪走）。 */
export function asrDataRoot() {
	const override = process.env.DSH_VOICE_ASR_HOME;
	return override !== undefined && override !== "" ? resolve(override) : join(PROJECT_ROOT, ".data", "asr");
}

/**
 * Whisper ggml 模型清单（`tiny` / `small` 本机已下载，其余是官方同款数值）。
 * `file` 与 `sha256` 必须与 dsh-ears 的 marker 完全匹配，否则验证不过。
 */
export const WHISPER_MODELS = {
	tiny: {
		file: "ggml-tiny.bin",
		bytes: 77691713,
		sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
		url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
	},
	base: {
		file: "ggml-base.bin",
		bytes: 147951465,
		sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
		url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
	},
	small: {
		file: "ggml-small.bin",
		bytes: 487601967,
		sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
		url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
	},
	medium: {
		file: "ggml-medium.bin",
		bytes: 1533763059,
		sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
		url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
	},
	large: {
		file: "ggml-large-v3.bin",
		bytes: 3095033483,
		sha256: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
		url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
	},
	turbo: {
		file: "ggml-large-v3-turbo.bin",
		bytes: 1624555275,
		sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
		url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
	},
};

/** SenseVoice 资源清单（`runtime/assets.json` 的四个资产）。 */
export const SENSEVOICE_ASSETS = {
	"model.int8.onnx": {
		file: "sensevoice-onnx/model.int8.onnx",
		bytes: 239233841,
		sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
		url: "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx",
	},
	"model.onnx": {
		file: "sensevoice-onnx/model.onnx",
		bytes: 937617178,
		sha256: "977016bd9c79f9eb343430b5cc305e07ab64d5212dff41b0dcfa1694bee9a8cb",
		url: "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.onnx",
	},
	"tokens.txt": {
		file: "sensevoice-onnx/tokens.txt",
		bytes: 315894,
		sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
		url: "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt",
	},
	"silero_vad.onnx": {
		file: "silero/silero_vad.onnx",
		bytes: 1807522,
		sha256: "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28",
		url: "https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx",
	},
};

/** Whisper 模型目录（项目自有）。 */
export function whisperModelPath(model) {
	return join(asrDataRoot(), "whisper", WHISPER_MODELS[model].file);
}

/** SenseVoice 模型目录中某个资产的路径。 */
export function sensevoiceAssetPath(key) {
	return join(asrDataRoot(), "sensevoice", "models", SENSEVOICE_ASSETS[key].file);
}

/**
 * 流式校验一个文件：大小 + SHA256 全量匹配。
 *
 * 大小先判是为了省时间：不对的文件（下载中断、放错文件）没必要读几百 MB。
 * 注意**不能只看标记文件** —— 用户手写一个 `.done` 不等于模型真在。
 *
 * @param filePath - 绝对路径。
 * @param spec - `{ bytes, sha256 }`。
 * @returns `{ ok, reason, sha256? }`。
 */
export async function verifyFile(filePath, spec) {
	if (!existsSync(filePath)) return { ok: false, reason: "missing" };
	const stat = statSync(filePath);
	if (stat.size !== spec.bytes) return { ok: false, reason: `size:${stat.size}` };
	const hash = createHash("sha256");
	await new Promise((resolvePromise, rejectPromise) => {
		const stream = createReadStream(filePath);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", rejectPromise);
		stream.on("end", resolvePromise);
	});
	const sha256 = hash.digest("hex");
	if (sha256 !== spec.sha256) return { ok: false, reason: "sha256-mismatch", sha256 };
	return { ok: true, sha256 };
}

/**
 * 原生运行时是否齐备（只查文件存在，不加载 addon —— 加载 native 有不可恢复的断言风险）。
 */
export function nativeRuntimeState() {
	const sherpaMain = join(VENDOR_MODULES, "sherpa-onnx-node", "sherpa-onnx.js");
	const sherpaBinary = join(VENDOR_MODULES, "sherpa-onnx-win-x64", "sherpa-onnx.node");
	const whisperMain = join(VENDOR_MODULES, "@fugood", "whisper.node", "lib", "index.js");
	const whisperBinary = join(VENDOR_MODULES, "@fugood", `node-whisper-${process.platform}-${process.arch}`, "index.node");
	return {
		sensevoice: existsSync(sherpaMain) && existsSync(sherpaBinary),
		whisper: existsSync(whisperMain) && existsSync(whisperBinary),
		paths: { sherpaMain, sherpaBinary, whisperMain, whisperBinary },
	};
}
