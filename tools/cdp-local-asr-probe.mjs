/**
 * V2.1 真浏览器验证：内置识别在 UI 里可用，且两条引擎都走项目自有实现。
 *
 * 验证四件事：
 *   ① `/asr/status` 在浏览器里报 SenseVoice / Whisper 双可用；
 *   ② ears() / speech() 的 `via` 都是 `local`（不依赖 remote 插件）；
 *   ③ 设置面板两个选项都标「内置」，可切换且偏好落 localStorage；
 *   ④ 切到 Whisper 后引擎立刻生效。
 *
 * 用法：node tools/cdp-local-asr-probe.mjs [url] [等待秒数]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9341;
const STATE = "C:/Users/xqz19/WorkBuddy/DSH_dev/dsh-voice-assistant/tools/_dsh-serve.json";

const first = process.argv[2];
const hasUrl = typeof first === "string" && /^https?:\/\//i.test(first);
let url = hasUrl ? first : undefined;
if (url === undefined) {
	try {
		url = JSON.parse(readFileSync(STATE, "utf8")).url;
	} catch {
		// fall through
	}
}
if (url === undefined) {
	console.error("用法: node tools/cdp-local-asr-probe.mjs <url> [等待秒数]");
	process.exit(2);
}
const waitSeconds = Number((hasUrl ? process.argv[3] : process.argv[2]) ?? 18);

const profileDir = mkdtempSync(join(tmpdir(), "dsh-v21-asr-"));
const chrome = spawn(
	CHROME,
	[
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--autoplay-policy=no-user-gesture-required",
		"--use-fake-ui-for-media-stream",
		"--use-fake-device-for-media-stream",
		`--user-data-dir=${profileDir}`,
		`--remote-debugging-port=${PORT}`,
		"about:blank",
	],
	{ stdio: "ignore" },
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function target() {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
			const page = (await response.json()).find((item) => item.type === "page");
			if (page !== undefined) return page;
		} catch {
			// 端口还没起。
		}
		await sleep(200);
	}
	throw new Error("Chrome 调试端口未就绪");
}

const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
function send(method, params = {}) {
	const id = nextId;
	nextId += 1;
	socket.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve) => pending.set(id, resolve));
}
socket.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	if (message.id !== undefined) {
		pending.get(message.id)?.(message.result ?? message.error);
		pending.delete(message.id);
	}
});
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url });
await sleep(waitSeconds * 1000);

const failures = [];
const check = (label, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures.push(`${label}: ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` → ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`}`);
};
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	return result?.result?.value;
};

const debugRaw = await evaluate(`JSON.stringify({
  localAsr: null,
  ears: globalThis.__xfvDebug?.ears?.() ?? null,
  speech: globalThis.__xfvDebug?.speech?.() ?? null,
})`);
const debug = JSON.parse(debugRaw ?? "{}");
const localAsrRaw = await evaluate(`(async () => {
  try { return JSON.stringify(await globalThis.__xfvDebug.localAsr()); }
  catch (error) { return JSON.stringify({ error: String(error?.message ?? error) }); }
})()`);
const localAsr = JSON.parse(localAsrRaw ?? "null");
console.log("=== 内置识别探测 ===");
console.log(JSON.stringify({ localAsr, ears: debug.ears, speech: debug.speech }, null, 2));
check("调试面在场", debug.ears !== null && debug.speech !== null, true);
check("SenseVoice 模型可用", localAsr?.sensevoice?.available, true);
check("Whisper 模型可用", localAsr?.whisper?.available, true);
check("Whisper 钉死中文", localAsr?.whisper?.language, "zh");
check("Whisper 探测走内置", debug.ears?.via, "local");
check("SenseVoice 探测走内置", debug.speech?.via, "local");
check(
	"ears 的 local-asr-api 命中",
	(debug.ears?.paths ?? []).some((p) => p.from === "local-asr-api" && p.hit === true),
	true,
);
check(
	"speech 的 local-asr-api 命中",
	(debug.speech?.paths ?? []).some((p) => p.from === "local-asr-api" && p.hit === true),
	true,
);

// 打开设置面板，确认两个选项都标「内置」。
await evaluate(`(() => {
  const orb = document.querySelector('.xfv-orb');
  if (orb) orb.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 700, clientY: 400 }));
  return true;
})()`);
await sleep(900);
const panel = JSON.parse(
	(await evaluate(`(() => {
  const p = document.querySelector('.xfv-panel');
  if (!p) return null;
  const sels = [...p.querySelectorAll('.xfv-select')];
  return JSON.stringify({
    panel: true,
    options: sels[0] ? [...sels[0].options].map(o => ({ value: o.value, label: o.text, disabled: o.disabled })) : [],
  });
})()`)) ?? "null",
);
check("设置面板已打开", panel?.panel, true);
check(
	"Whisper 选项标内置且未被禁用",
	panel?.options?.find((o) => o.value === "ears")?.label?.includes("内置") &&
		panel?.options?.find((o) => o.value === "ears")?.disabled === false,
	true,
);
check(
	"SenseVoice 选项标内置且未被禁用",
	panel?.options?.find((o) => o.value === "sensevoice")?.label?.includes("内置") &&
		panel?.options?.find((o) => o.value === "sensevoice")?.disabled === false,
	true,
);

// 切到 Whisper（引擎值沿用 ears 以兼容旧偏好）。
await evaluate(`(() => {
  const sel = document.querySelector('.xfv-panel .xfv-select');
  if (!sel) return false;
  sel.value = 'ears';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await sleep(1200);
const afterSelect = JSON.parse(
	(await evaluate(`JSON.stringify({
  asr: globalThis.__xfvDebug?.asr?.() ?? null,
  stored: (() => { try { return localStorage.getItem('xfv:v1:asr-preference'); } catch { return null; } })(),
})`)) ?? "null",
);
check("引擎切到本地 Whisper", afterSelect.asr?.engine, "ears");
check("偏好落盘", JSON.parse(afterSelect.stored ?? "{}").engine, "ears");

console.log("\n=== 结果 ===");
if (failures.length > 0) {
	console.log(`${failures.length} 项失败:`);
	for (const failure of failures) console.log(`  - ${failure}`);
} else {
	console.log("V2.1 内置识别真机验证通过");
}
chrome.kill();
await sleep(800);
try {
	rmSync(profileDir, { recursive: true, force: true });
} catch {
	// Windows 上 Chrome 子进程可能短暂锁住 Crashpad 文件，忽略清理失败。
}
process.exit(failures.length > 0 ? 1 : 0);
