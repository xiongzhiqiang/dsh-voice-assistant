/**
 * 自检内置识别链（不需要启动 DSH）。
 *
 *     node tools/probe-local-asr.mjs
 *
 * 依次验证：模型校验通过 → vendored native 可加载 → 两路子进程就绪 →
 * 喂一段合成的 16 kHz 单声道 PCM16 WAV 都能返回（静音返回空文本属正常）。
 * 任一步失败都会把子进程 stderr 打到屏幕上，方便定位是模型/原生包/代码。
 */
import { normalizeConfig } from "../lib/config.js";
import { createLocalAsr } from "../lib/asr/runtime.js";

/** 合成一段 `seconds` 秒的静音 WAV（16 kHz / mono / PCM16）。 */
function silenceWav(seconds = 1) {
	const samples = 16000 * seconds;
	const buffer = Buffer.alloc(44 + samples * 2);
	buffer.write("RIFF", 0, "ascii");
	buffer.writeUInt32LE(36 + samples * 2, 4);
	buffer.write("WAVE", 8, "ascii");
	buffer.write("fmt ", 12, "ascii");
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(16000, 24);
	buffer.writeUInt32LE(32000, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write("data", 36, "ascii");
	buffer.writeUInt32LE(samples * 2, 40);
	return buffer;
}

const localAsr = createLocalAsr(normalizeConfig({}), {
	info: (message) => console.log(`[info] ${message}`),
	warn: (message) => console.warn(`[warn] ${message}`),
});

const report = { ok: true, checks: [] };
try {
	const status = await localAsr.status();
	console.log(JSON.stringify(status, null, 2));
	for (const engine of ["sensevoice", "whisper"]) {
		if (status[engine].available !== true) {
			report.ok = false;
			report.checks.push({ engine, ok: false, reason: status[engine].reason });
			continue;
		}
		try {
			const result = await localAsr.transcribe(engine, silenceWav(1), "zh");
			report.checks.push({ engine, ok: true, text: result.text, inferenceSeconds: result.inferenceSeconds });
		} catch (error) {
			report.ok = false;
			report.checks.push({ engine, ok: false, error: String(error?.message ?? error) });
		}
	}
} finally {
	localAsr.dispose();
}
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
