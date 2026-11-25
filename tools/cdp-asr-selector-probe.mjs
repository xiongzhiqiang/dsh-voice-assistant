/**
 * V2.0 真浏览器验证：官方 SenseVoice 识别接入 + UI 自主选择。
 *
 * 验证四件事：
 *   ① speech 命名空间探测结论（可用 / 语言清单 / 各取法命中）；
 *   ② 设置面板里识别方式选择器渲染出来（5 个选项齐全）；
 *   ③ 用户切换到 sensevoice → 引擎立刻生效 + 偏好落 localStorage；
 *   ④ 语言下拉在 sensevoice 下出现，选 zh 后偏好更新。
 *
 * 用法：node tools/cdp-asr-selector-probe.mjs <url> [等待秒数]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9339;
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
if (url === undefined && typeof process.env.DSH_TOKEN === "string") url = `http://127.0.0.1:3080/?token=${process.env.DSH_TOKEN}`;
if (url === undefined) {
	console.error("用法: node tools/cdp-asr-selector-probe.mjs <url> [等待秒数]");
	process.exit(2);
}
const waitSeconds = Number((hasUrl ? process.argv[3] : process.argv[2]) ?? 18);

const profileDir = mkdtempSync(join(tmpdir(), "dsh-asrsel-"));
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

// ① speech 探测结论
const speechRaw = await evaluate(`JSON.stringify(globalThis.__xfvDebug?.speech?.() ?? null)`);
const speech = speechRaw === null || speechRaw === undefined ? null : JSON.parse(speechRaw);
console.log("=== speech 探测 ===");
console.log(JSON.stringify(speech, null, 2));
check("speech 调试面在场", speech !== null, true);
if (speech !== null) {
	check("speech 命名空间至少一条取法命中", speech.paths.some((p) => p.hit === true), true);
	// 官方 bundle 已启用，这个布尔应为 true；若 false 说明注册名没猜对，
	// paths 会给出到底哪条通，便于下一步修正。
	check("官方 SenseVoice 探测可用", speech.available, true);
	check("语言清单非空", Array.isArray(speech.languages) && speech.languages.length > 0, true);
}

// ② 打开设置面板，验证选择器渲染
await evaluate(`(() => {
  const orb = document.querySelector('.xfv-orb');
  if (orb) orb.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 700, clientY: 400 }));
  return true;
})()`);
await sleep(900);
const panel = await evaluate(`(() => {
  const p = document.querySelector('.xfv-panel');
  if (!p) return null;
  const sels = [...p.querySelectorAll('.xfv-select')];
  const engineSel = sels[0];
  return JSON.stringify({
    panel: true,
    selectCount: sels.length,
    options: engineSel ? [...engineSel.options].map(o => ({ value: o.value, disabled: o.disabled })) : [],
    engineValue: engineSel?.value ?? null,
  });
})()`);
const panelState = panel === null || panel === undefined ? null : JSON.parse(panel);
console.log("=== 设置面板 ===");
console.log(JSON.stringify(panelState, null, 2));
check("设置面板已打开", panelState?.panel, true);
check("识别方式选择器在场", (panelState?.selectCount ?? 0) >= 1, true);
check("识别方式选项齐全（5 项）", (panelState?.options ?? []).map((o) => o.value), ["auto", "webspeech", "ears", "sensevoice", "http"]);

// ③ 切到 sensevoice → 引擎生效 + 偏好落盘
await evaluate(`(() => {
  const sel = document.querySelector('.xfv-panel .xfv-select');
  if (!sel) return false;
  sel.value = 'sensevoice';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await sleep(1200);
const afterSelect = await evaluate(`JSON.stringify({
  asr: globalThis.__xfvDebug?.asr?.() ?? null,
  stored: (() => { try { return localStorage.getItem('xfv:v1:asr-preference'); } catch { return null; } })(),
  languageSelect: !!document.querySelector('.xfv-panel .xfv-asr-row:nth-child(2) .xfv-select'),
})`);
const selected = JSON.parse(afterSelect);
console.log("=== 切换后 ===");
console.log(JSON.stringify(selected, null, 2));
check("引擎切到 sensevoice", selected.asr?.engine, "sensevoice");
check("偏好已记 manual", selected.asr?.preference?.manual, true);
check("偏好已落 localStorage", JSON.parse(selected.stored ?? "{}").engine, "sensevoice");
check("语言下拉在 sensevoice 下出现", selected.languageSelect, true);

// ④ 选语言 zh → 偏好更新
await evaluate(`(() => {
  const sels = document.querySelectorAll('.xfv-panel .xfv-select');
  const lang = sels[1];
  if (!lang) return false;
  lang.value = 'zh';
  lang.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await sleep(800);
const langPref = await evaluate(`JSON.stringify(globalThis.__xfvDebug?.asr?.()?.preference ?? null)`);
const pref = JSON.parse(langPref);
check("语言偏好更新为 zh", pref?.language, "zh");

console.log("\n=== 结果 ===");
if (failures.length > 0) {
	console.log(`${failures.length} 项失败:`);
	for (const failure of failures) console.log(`  - ${failure}`);
} else {
	console.log("V2.0 识别方式选择真机验证通过");
}
chrome.kill();
await sleep(800);
try {
	rmSync(profileDir, { recursive: true, force: true });
} catch {
	// Windows 上 chrome 子进程可能短暂锁住 Crashpad 文件，忽略清理失败。
}
process.exit(failures.length > 0 ? 1 : 0);
