/**
 * 真浏览器验证 V1.8 语音专家会话命令。
 *
 * 用 `__xfvDebug.ask()` 走真实 runCommand 入口（唤醒 → 润色前命令拦截 →
 * 执行 → 播报），验证：
 *   1. "列出会话" 被识别为会话命令（heard 是润色前原文）；
 *   2. "给小因开个会话" 真开新会话（health 的 delegation slot +1）；
 *   3. "关闭小因会话" 真关会话（slot 恢复）；
 *   4. 无插件相关 JS 异常。
 *
 * 用法：`node tools/cdp-session-cmd-probe.mjs <url>`
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9343;
const first = process.argv[2];
const url = typeof first === "string" && /^https?:\/\//i.test(first) ? first : undefined;
if (url === undefined) {
	console.error("用法: node tools/cdp-session-cmd-probe.mjs <url>");
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail) => {
	const pass = Boolean(ok);
	if (!pass) failures.push({ name, detail });
	console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || detail === undefined ? "" : ` → ${detail}`}`);
};

const profileDir = mkdtempSync(join(tmpdir(), "dsh-sesscmd-"));
const chrome = spawn(CHROME, [
	"--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
	"--disable-extensions", `--user-data-dir=${profileDir}`, `--remote-debugging-port=${PORT}`, "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
	for (let i = 0; i < 60; i += 1) {
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
			const list = await r.json();
			const page = list.find((x) => x.type === "page");
			if (page !== undefined) return page;
		} catch { /* 端口未起 */ }
		await sleep(200);
	}
	throw new Error("Chrome 调试端口未就绪");
}

let socket;
try {
	const page = await target();
	socket = new WebSocket(page.webSocketDebuggerUrl);
	const pending = new Map();
	let nextId = 1;
	const errors = [];
	function send(method, params = {}) {
		const id = nextId;
		nextId += 1;
		socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve) => pending.set(id, resolve));
	}
	socket.addEventListener("message", (e) => {
		const m = JSON.parse(e.data);
		if (m.id !== undefined) { pending.get(m.id)?.(m.result ?? m.error); pending.delete(m.id); return; }
		if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
		if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
	});
	await new Promise((r) => socket.addEventListener("open", r, { once: true }));
	await send("Runtime.enable");
	await send("Page.enable");
	await send("Page.navigate", { url });
	let ready = false;
	for (let i = 0; i < 80; i += 1) {
		const r = await send("Runtime.evaluate", { expression: "typeof globalThis.__xfvDebug?.ask === 'function'", returnByValue: true });
		if (r?.result?.value === true) { ready = true; break; }
		await sleep(250);
	}
	check("__xfvDebug.ask 就绪（bundle 已加载）", ready, ready ? "" : "等待超时");

	const evaluate = async (expression) => {
		const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (r?.exceptionDetails !== undefined) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate 抛错");
		return r?.result?.value;
	};
	const health = async () => JSON.parse(await evaluate(`(async()=>{const r=await fetch('/plugins/dsh-voice-assistant/api/health');return JSON.stringify(await r.json())})()`));
	const slots = async () => (await health()).delegation?.slots?.length ?? -1;
	const ask = async (text) => evaluate(`(async()=>{ await globalThis.__xfvDebug.ask(${JSON.stringify(text)}); return JSON.stringify(globalThis.__xfvDebug.snapshot?.() ?? {}); })()`);

	// 先唤醒（真实链路里唤醒与说话是两轮，分开做避免 generation 冲突）。
	await evaluate(`(async()=>{ const s=globalThis.__xfvDebug.snapshot(); if(s.status==='off') globalThis.__xfvDebug.start?.(); else if(s.status==='standby'||s.status==='sleeping') globalThis.__xfvDebug.wake(); return true; })()`);
	await sleep(600);

	// 1) 列出会话 —— heard 是润色前原文即证明被会话命令拦截。
	const snap1Raw = await ask("列出会话");
	const snap1 = typeof snap1Raw === "string" ? JSON.parse(snap1Raw) : {};
	check("列出会话 heard 是润色前原文", (snap1.heard ?? "") === "列出会话", snap1.heard);

	// 2) 开新会话 —— slot 数 +1。
	const slots0 = await slots();
	await ask("给小因开个会话");
	await sleep(400);
	const slots1 = await slots();
	check("语音开会话真的新增了 slot", slots1 === slots0 + 1, `${slots0} → ${slots1}`);

	// 3) 关闭会话（关活跃的那个新会话）—— slot 恢复。
	await ask("关闭小因会话");
	await sleep(400);
	const slots2 = await slots();
	check("语音关会话真的移除了 slot", slots2 === slots0, `${slots1} → ${slots2}`);

	const relevant = errors.filter((e) => /xfv|voice|小凤|session|route|专家/i.test(String(e)));
	check("无插件相关 JS 异常", relevant.length === 0, relevant.slice(0, 3).join(" | "));
} catch (error) {
	console.error("探针异常:", error?.stack ?? error);
	process.exitCode = 1;
} finally {
	try { socket?.close(); } catch { /* ignore */ }
	try { chrome.kill(); } catch { /* ignore */ }
}

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	process.exit(1);
}
console.log("\nV1.8 真浏览器语音会话命令验证通过");
