/**
 * 需求 ① 可行性探针：`origin:'subagent'` 的会话还能不能 `retain`。
 *
 * ## 为什么必须实测而不是读类型定义
 *
 * 类型定义上 `meta.origin?: 'subagent'` 完全合法，`createAgent` 也收。
 * 但宿主在**按普通会话 id 访问**时有一道校验
 * （`dsh-api-session-controller/lib/index.js:1156`）：
 *
 * ```
 * if (header.origin === "subagent")
 *   throw new RemoteError("session/agent-busy",
 *     "subagent Sessions require their durable parent address", …)
 * ```
 *
 * 而语音插件的会话桥正是**用普通 id 去 retain** 的（`session.js` 的
 * `sessions.retain(this.sessionId, …)`）。如果 retain 也撞这道校验，
 * 那么"用 subagent 标记来隐藏常驻会话"这条路就**直接不通** ——
 * 助手会变成一个看不见、也连不上的孤儿。
 *
 * 探针在真浏览器里跑：create 一个带 `origin:'subagent'` 的会话，
 * 然后按普通 id retain，观察两者各自的成败与报错原文。
 *
 * 用法：`node tools/probe-subagent-retain.mjs`
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9336;
const LOG_DIR = "C:/Users/xqz19/WorkBuddy/DSH_dev/tools";
const BASE = "http://127.0.0.1:3080";

/**
 * 取访问 token（显式优先，否则按 mtime 取最新日志）。
 * @returns token 字符串。
 */
function resolveToken() {
	const explicit = process.env.DSH_TOKEN ?? process.argv[2] ?? "";
	if (explicit !== "") return explicit;
	let newest = null;
	for (const name of readdirSync(LOG_DIR).filter((n) => /^_dsh-run\d*\.log$/.test(n))) {
		const path = join(LOG_DIR, name);
		const info = statSync(path);
		if (newest === null || info.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: info.mtimeMs };
	}
	if (newest === null) return "";
	const buffer = readFileSync(newest.path);
	const text = buffer.includes(0) ? buffer.toString("utf16le") : buffer.toString("utf8");
	const match = /token=([A-Za-z0-9_-]+)/.exec(text);
	return match ? match[1] : "";
}

const token = resolveToken();
const login = await fetch(`${BASE}/?token=${token}`, { redirect: "manual" }).catch(() => null);
const setCookies = login === null || login.headers.getSetCookie === undefined ? [] : login.headers.getSetCookie();
const cookie = setCookies.length === 0 ? "" : setCookies[0].split(";")[0];
if (cookie === "") {
	console.error("拿不到会话 cookie：请确认 DSH 在 3080 运行，且 token 正确。");
	process.exit(2);
}

const profileDir = mkdtempSync(join(tmpdir(), "dsh-subagent-"));
const chrome = spawn(
	CHROME,
	[
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		`--user-data-dir=${profileDir}`,
		`--remote-debugging-port=${PORT}`,
		"about:blank",
	],
	{ stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanup = () => {
	try {
		chrome.kill();
	} catch {
		// 已经退出。
	}
	try {
		rmSync(profileDir, { recursive: true, force: true });
	} catch {
		// 目录被占用时留着也无妨。
	}
};

/**
 * 等 Chrome 调试端口就绪并取页面 target。
 * @returns 页面 target。
 */
async function pageTarget() {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
			const list = await response.json();
			const page = list.find((item) => item.type === "page");
			if (page !== undefined) return page;
		} catch {
			// 端口还没起来。
		}
		await sleep(200);
	}
	throw new Error("Chrome 调试端口未就绪");
}

const page = await pageTarget();
const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;

socket.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	if (message.id === undefined) return;
	const entry = pending.get(message.id);
	if (entry === undefined) return;
	pending.delete(message.id);
	if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)));
	else entry.resolve(message.result?.result?.value ?? message.result);
});
await new Promise((resolve, reject) => {
	socket.addEventListener("open", resolve);
	socket.addEventListener("error", reject);
});

/**
 * 发一条 CDP 命令。
 * @param method - 方法名。
 * @param params - 参数。
 * @returns 命令结果。
 */
function send(method, params = {}) {
	const id = nextId++;
	socket.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				reject(new Error(`${method} 超时`));
			}
		}, 30000);
	});
}

/**
 * 在页面里求值。
 * @param expression - 表达式。
 * @param awaitPromise - 是否等待 Promise。
 * @returns 结果值。
 */
async function evaluate(expression, awaitPromise = false) {
	const result = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: true });
	return result;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: `${BASE}/` });
await sleep(10000);

const probe = `
(async () => {
	const out = { steps: [] };
	const ctx = globalThis.__CODEBUDDY_CTX__ ?? null;
	out.hasGlobalCtx = ctx !== null;
	// 从插件槽位上拿 ctx：插件 register 的组件带 props.ctx，但更稳妥的是
	// 直接从 DSH 前端暴露的根上下文取。逐个候选试。
	const candidates = [
		globalThis.__dsCtx,
		globalThis.__DSH_CTX__,
		globalThis.__CODEBUDDY_CTX__,
		globalThis.__cordis_ctx,
	];
	out.candidateNames = Object.keys(globalThis).filter((k) => /ctx|cordis|dsh/i.test(k)).slice(0, 30);
	return JSON.stringify(out);
})()
`;

const probeResult = await evaluate(probe, true);
console.log("=== 根上下文探测 ===");
console.log(probeResult);

cleanup();
process.exit(0);
