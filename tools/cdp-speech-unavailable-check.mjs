/**
 * 真浏览器验收：SenseVoice 实际识别不再抛 speech-unavailable。
 *
 * 关键不是看 /asr/status（那只证明模型可用），而是用 feedAudio() 走一遍
 * 当前引擎的实际 recognize 链，确认它调用内置 API 并返回结果。
 *
 * 用法：node tools/cdp-speech-unavailable-check.mjs [等待秒数]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9349;
const STATE = "C:/Users/xqz19/WorkBuddy/DSH_dev/dsh-voice-assistant/tools/_dsh-serve.json";
const url = JSON.parse(readFileSync(STATE, "utf8")).url;
const waitSeconds = Number(process.argv[2] ?? 18);

const profileDir = mkdtempSync(join(tmpdir(), "dsh-speech-check-"));
const chrome = spawn(CHROME, [
	"--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
	"--disable-extensions", "--autoplay-policy=no-user-gesture-required",
	"--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
	`--user-data-dir=${profileDir}`, `--remote-debugging-port=${PORT}`, "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
	for (let i = 0; i < 50; i += 1) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
			const page = (await res.json()).find((x) => x.type === "page");
			if (page) return page;
		} catch { /* 端口未起 */ }
		await sleep(200);
	}
	throw new Error("Chrome 调试端口未就绪");
}

const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
const consoleErrors = [];
function send(method, params = {}) {
	const id = nextId;
	nextId += 1;
	socket.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve) => pending.set(id, resolve));
}
socket.addEventListener("message", (event) => {
	const msg = JSON.parse(event.data);
	if (msg.id !== undefined) {
		pending.get(msg.id)?.(msg.result ?? msg.error);
		pending.delete(msg.id);
		return;
	}
	if (msg.method === "Runtime.exceptionThrown") {
		consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "exception");
	} else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
		consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
	}
});
await new Promise((r) => socket.addEventListener("open", r, { once: true }));
await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url });
await sleep(waitSeconds * 1000);

const evaluate = async (expr) => {
	const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
	if (r?.exceptionDetails) return { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
	return r?.result?.value ?? null;
};

const asObj = (v) => (typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v);
const snap = asObj(await evaluate(`globalThis.__xfvDebug?.snapshot?.()`));
const speech = asObj(await evaluate(`globalThis.__xfvDebug?.speech?.()`));
const feed = asObj(await evaluate(`(async () => await globalThis.__xfvDebug?.feedAudio?.(1))()`));

const result = {
	engine: snap?.engine ?? null,
	speech,
	feedAudio: feed,
	consoleErrors: consoleErrors.slice(0, 10),
};
console.log(JSON.stringify(result, null, 2));

const failures = [];
if (feed?.ok !== true) failures.push(`feedAudio 失败: ${feed?.error ?? "无结果"}`);
if (String(feed?.error ?? "").includes("speech-unavailable")) failures.push("仍抛 speech-unavailable");
if (feed?.via !== "local") failures.push(`via 不是 local: ${feed?.via}`);
if (failures.length > 0) {
	console.error("FAIL:", failures.join(" | "));
	process.exitCode = 1;
} else {
	console.log("PASS: SenseVoice 实际识别走内置 API，无 speech-unavailable");
}

try { chrome.kill(); } catch { /* noop */ }
try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* Chrome 可能仍占用 crashpad 文件，忽略 */ }
