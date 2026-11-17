/**
 * 常驻启动 DSH 并**保持存活**，直到被显式停掉。
 *
 * ## 为什么需要它（与 `start-dsh.mjs` / `run-live.mjs` 的分工）
 *
 * 本机有一条硬约束：**Bash 工具调用结束时，会收掉该调用派生的整棵进程树**。
 * 于是三种起法各有分工：
 *
 * | 脚本 | 用途 | 能不能活过调用 |
 * |---|---|---|
 * | `run-live.mjs` | 「起 DSH → 跑一个验证脚本 → 收尾」一条龙 | 不需要活过（同进程内跑完） |
 * | `start-dsh.mjs` | 早期尝试用 `detached` 常驻 | **不能**（实测：报了就绪，调用一结束端口就没了） |
 * | 本脚本 | 真正常驻，供人打开浏览器用 | **能** —— 前提是**以后台任务方式运行** |
 *
 * 关键差别不在 `detached`，而在**由谁持有它**：`detached` 只是脱开父进程组，
 * 但本机的回收是按进程树做的，脱开了照样被收。只有当它挂在一个**由宿主托管的
 * 后台任务**上（`run_in_background`）时，才不会被那次调用带下去。
 *
 * ## 它做什么
 *
 * 1. 起 DSH（剔掉大小写重复的代理变量 —— 本机 `HTTP_PROXY`/`http_proxy` 会撞车）；
 * 2. 等端口就绪，把 token 与**可直接打开的 URL** 打到磁盘（`_dsh-serve.json`）+ stdout；
 * 3. **不退出**，一直挂着（每 10s 打一次心跳），直到进程被杀。
 *
 * ## 怎么用
 *
 * 以**后台任务**方式跑（在支持后台执行的工具里标 `run_in_background`），
 * 然后另起一次调用读 `tools/_dsh-serve.json` 拿 URL。
 * 停：按任务 id 停掉即可（本机建议再确认 3080 无监听）。
 *
 * 用法：`node tools/serve-dsh.mjs`
 */
import { spawn } from "node:child_process";
import { openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const BIN = "C:/Users/xqz19/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js";
const LOG = join(HERE, "_dsh-serve.log");
const ERR = join(HERE, "_dsh-serve.err");
const STATE = join(HERE, "_dsh-serve.json");

// 子进程环境：剔掉大小写重复的代理变量（本机 PowerShell/环境块对此敏感）。
const env = { ...process.env };
delete env.HTTP_PROXY;
delete env.HTTPS_PROXY;
for (const key of Object.keys(env)) {
	if (/^https?_proxy$/i.test(key) && key !== key.toUpperCase()) delete env[key];
}

const out = openSync(LOG, "w");
const err = openSync(ERR, "w");
console.log("启动 DSH（常驻模式）…");
const dsh = spawn(NODE, [BIN, "--profile", "web", "--no-open"], {
	stdio: ["ignore", out, err],
	env,
});

/** 探测端口是否已监听（TCP 层：DSH 没注册 `/health`，看 HTTP 状态会假绿）。 */
async function probe() {
	try {
		const response = await fetch("http://127.0.0.1:3080/", { signal: AbortSignal.timeout(2500) });
		return response.status;
	} catch {
		return null;
	}
}

/**
 * 从启动日志里取 token（按 mtime 直接读本脚本自己的日志，不用猜文件名）。
 *
 * ⚠️ **时序**：DSH 是先监听端口、**再**打印那行 `dsh web: …?token=…`。
 * 所以"探测到就绪"的瞬间日志里可能还没有 token（实测踩过：状态文件
 * 里 `token: ""`、URL 退化成不带 token 的形式）。就绪后要**有界重试**。
 *
 * @param timeoutMs - 最多等多久。
 * @returns token，或空串。
 */
async function readToken(timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const text = readFileSync(LOG, "utf8");
			const match = /token=([A-Za-z0-9_-]+)/.exec(text);
			if (match) return match[1];
		} catch {
			// 日志还没建。
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	return "";
}

const deadline = Date.now() + 90000;
let status = null;
while (Date.now() < deadline) {
	await new Promise((resolve) => setTimeout(resolve, 1500));
	status = await probe();
	if (status !== null) break;
	if (dsh.exitCode !== null) break;
}

if (status === null) {
	console.error(`90s 内没等到 3080 就绪。exit=${dsh.exitCode}`);
	try {
		console.error("stdout:", readFileSync(LOG, "utf8").slice(-1000) || "(空)");
		console.error("stderr:", readFileSync(ERR, "utf8").slice(-1000) || "(空)");
	} catch {
		// 读不到就算了。
	}
	process.exitCode = 1;
} else {
	const token = await readToken();
	const url = token === "" ? "http://127.0.0.1:3080/" : `http://127.0.0.1:3080/?token=${token}`;
	writeFileSync(STATE, `${JSON.stringify({ pid: dsh.pid, port: 3080, status, token, url, at: new Date().toISOString() }, null, 2)}\n`, "utf8");
	console.log(`DSH 已就绪（pid ${dsh.pid}，首页 ${status}）`);
	console.log(`打开这个 URL：${url}`);
	console.log(`状态文件：${STATE}`);
	// 心跳：让人能从日志确认它还活着（同时把进程钉住）。
	let beat = 0;
	setInterval(() => {
		beat += 1;
		const code = dsh.exitCode;
		if (code !== null) {
			console.log(`[心跳 ${beat}] DSH 已退出（code ${code}）`);
			process.exit(1);
		}
		if (beat % 6 === 0) console.log(`[心跳 ${beat}] 仍在运行（端口 ${status}）`);
	}, 10000);
}
