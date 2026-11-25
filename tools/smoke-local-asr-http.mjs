/**
 * 真机 HTTP 冒烟：验证内置识别 API 在 DSH 里可用（不需要任何外部语音插件）。
 *
 *     node tools/smoke-local-asr-http.mjs
 *
 * 用 tools/_dsh-serve.json 里的 token 走 `/?token=` → cookie → 插件 API。
 * 检查 health 版本/自省、/asr/status 两路可用，并各喂 1 秒静音 WAV。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(join(HERE, "_dsh-serve.json"), "utf8"));
const base = `http://127.0.0.1:${state.port}`;
const prefix = "/plugins/dsh-voice-assistant/api";

const login = await fetch(`${base}/?token=${state.token}`, { redirect: "manual" });
const cookie = String(login.headers.get("set-cookie") ?? "").split(";")[0];
if (login.status !== 303 || cookie === "") throw new Error(`login failed: ${login.status} / ${cookie}`);
const headers = { cookie };

async function get(path) {
	const response = await fetch(`${base}${prefix}${path}`, { headers });
	if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${await response.text()}`);
	return response.json();
}
async function post(path, body) {
	const response = await fetch(`${base}${prefix}${path}`, {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw new Error(`POST ${path}: ${response.status} ${await response.text()}`);
	return response.json();
}
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

const result = { ok: true };
const health = await get("/health");
result.health = {
	version: health.version,
	problems: health.routing?.problems ?? [],
	asrLocal: health.asrLocal,
};
if (health.version !== "2.1.0") throw new Error(`unexpected version: ${health.version}`);
if ((health.routing?.problems ?? []).length > 0) throw new Error(`routing problems: ${JSON.stringify(health.routing.problems)}`);

const status = await get("/asr/status");
result.status = { sensevoice: status.sensevoice?.available, whisper: status.whisper?.available, dataRoot: status.dataRoot };
if (status.sensevoice?.available !== true || status.whisper?.available !== true) {
	throw new Error(`local ASR not ready: ${JSON.stringify(result.status)}`);
}

result.transcribe = {};
const wav = silenceWav(1).toString("base64");
for (const engine of ["sensevoice", "whisper"]) {
	const out = await post("/asr/local", { engine, audioBase64: wav, language: "zh" });
	result.transcribe[engine] = { ok: out.ok === true, via: out.via, text: out.text };
	if (out.ok !== true || out.via !== "local") throw new Error(`${engine} transcribe failed: ${JSON.stringify(out)}`);
}

console.log(JSON.stringify(result, null, 2));
console.log("SMOKE OK");
