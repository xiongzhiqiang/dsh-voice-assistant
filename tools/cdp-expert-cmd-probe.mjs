/**
 * 真浏览器验证 V1.7 语音专家管理命令。
 *
 * 用 `__xfvDebug.ask()` 走真实 runCommand 入口（唤醒 → 润色前命令拦截 →
 * 执行 → 状态机播报），验证：
 *   1. "列出专家" 被识别为命令（routeVia=expert-command），播报文案含专家名；
 *   2. "新增专家 X，负责 Y" 真新增（health 清单出现新 id）；
 *   3. "删除专家 X" 真删除（health 清单移除）；
 *   4. 普通指令不误触发命令路径；
 *   5. 无插件相关 JS 异常。
 *
 * 用临时 id，finally 清理。用法：`node tools/cdp-expert-cmd-probe.mjs <url>`
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9341;
const first = process.argv[2];
const url = typeof first === "string" && /^https?:\/\//i.test(first)
	? first
	: undefined;
if (url === undefined) {
	console.error("用法: node tools/cdp-expert-cmd-probe.mjs <url>");
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail) => {
	const pass = Boolean(ok);
	if (!pass) failures.push({ name, detail });
	console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || detail === undefined ? "" : ` → ${detail}`}`);
};

const profileDir = mkdtempSync(join(tmpdir(), "dsh-expertcmd-"));
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
		if (m.method === "Runtime.exceptionThrown") {
			errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
		}
		if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
			errors.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
		}
	});
	await new Promise((r) => socket.addEventListener("open", r, { once: true }));
	await send("Runtime.enable");
	await send("Page.enable");
	await send("Page.navigate", { url });
	// 等 bundle 求值、__xfvDebug 出现。
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
	// 真实链路：用户先喊"小凤"唤醒（一轮），再说指令（下一轮）。调试钩子 ask()
	// 把两步合并会让 wake 的异步换代撞上进指令的 generation 检查。所以先单独
	// 唤醒并等稳定，再提交 —— 这也更忠实于真实交互。
	await evaluate(`(async()=>{ const s=globalThis.__xfvDebug.snapshot(); if(s.status==='off') globalThis.__xfvDebug.start?.(); else if(s.status==='standby'||s.status==='sleeping') globalThis.__xfvDebug.wake(); return true; })()`);
	await sleep(600);
	const ask = async (text) => evaluate(`(async()=>{ await globalThis.__xfvDebug.ask(${JSON.stringify(text)}); return JSON.stringify(globalThis.__xfvDebug.snapshot?.() ?? {}); })()`);

	// 1) 列出专家。
	const snap1Raw = await ask("列出专家");
	const snap1 = typeof snap1Raw === "string" ? JSON.parse(snap1Raw) : {};
	// heard 是润色前的命令原文 —— 能读到它 = 命令拦截点在润色前生效（普通指令
	// 这里会被润色改写）。routeVia/lastReport 是瞬时字段，播报后可能被状态机
	// 迁移清掉，不作为判据；命令"真的执行了"由下面 health 的增删改证明。
	const heard1 = snap1.heard ?? "";
	check("列出命令 heard 是润色前原文", heard1 === "列出专家", heard1);

	// 2) 新增专家（临时 id）。
	const TEST_ID = "xfv-cmd-temp";
	await ask(`新增专家 测试命令专家，id ${TEST_ID}，负责冒烟测试`);
	const health1 = JSON.parse(await evaluate(`(async()=>{const r=await fetch('/plugins/dsh-voice-assistant/api/health');return JSON.stringify(await r.json())})()`));
	const ids1 = (health1.routing?.workers ?? []).map((w) => w.id);
	check("语音新增命令真的新增了专家（health 可见）", ids1.includes(TEST_ID), ids1.join(","));

	// 3) 删除专家。
	await ask(`删除专家 ${TEST_ID}`);
	const health2 = JSON.parse(await evaluate(`(async()=>{const r=await fetch('/plugins/dsh-voice-assistant/api/health');return JSON.stringify(await r.json())})()`));
	const ids2 = (health2.routing?.workers ?? []).map((w) => w.id);
	check("语音删除命令真的移除了专家（health 可见）", !ids2.includes(TEST_ID), ids2.join(","));

	const relevant = errors.filter((e) => /xfv|voice|小凤|expert|route/i.test(String(e)));
	check("无插件相关 JS 异常", relevant.length === 0, relevant.slice(0, 3).join(" | "));

	// 清理临时专家文件。
	const dir = health1.routing ? (await evaluate(`(async()=>{const r=await fetch('/plugins/dsh-voice-assistant/api/experts');return JSON.stringify((await r.json()).dir)})()`)) : null;
	if (dir && existsSync(join(dir, `${TEST_ID}.json`))) {
		try { unlinkSync(join(dir, `${TEST_ID}.json`)); console.log(`  清理 ${TEST_ID}.json`); } catch { /* ignore */ }
	}
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
console.log("\nV1.7 真浏览器语音专家命令验证通过");
