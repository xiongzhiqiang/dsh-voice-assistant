/**
 * 后台启动 DSH（本机专用）。
 *
 * ## 为什么需要这个脚本（而不是一行 PowerShell）
 *
 * 三个已踩过的坑叠在一起，缺一条就走不通：
 *
 * 1. **Bash 的 shim 会静默失败**：用 Bash 起后台 DSH，命令不执行也不报错，
 *    表现为"改了配置却还是旧进程在跑"。所以要用 Node 起。
 * 2. **`Start-Process` 在本机直接抛异常**：环境块里同时存在 `HTTP_PROXY`
 *    与 `http_proxy`（大小写不同、语义相同），PowerShell 的大小写不敏感
 *    字典判定为重复键，报 `已添加项。字典中的关键字:"HTTP_PROXY"`。
 *    所以交给 Node 控制子进程环境。
 * 3. **分离启动必须显式给 stdio**：DSH 启动时会往 stdout 写 token，
 *    不重定向的话 detached 进程拿不到可写的句柄，会**静默退出**
 *    （既不监听端口，也不留任何日志）—— 这是本次排查里最费时的一条。
 *    所以这里把 stdout/stderr 都指到磁盘文件。
 *
 * 用法：`node tools/start-dsh.mjs`
 */
import { spawn } from "node:child_process";
import { openSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = "C:/Users/xqz19/.workbuddy/binaries/node/versions/22.22.2-6/node.exe";
const BIN = "C:/Users/xqz19/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js";
const LOG = join(HERE, "_dsh-run12.log");
const ERR = join(HERE, "_dsh-run12.log.err");

// 子进程环境：剔掉大小写重复的代理变量（见文件头第 2 条）。
const env = { ...process.env };
delete env.HTTP_PROXY;
delete env.HTTPS_PROXY;
for (const key of Object.keys(env)) {
	if (/^https?_proxy$/i.test(key) && key !== key.toUpperCase()) delete env[key];
}

mkdirSync(HERE, { recursive: true });
const out = openSync(LOG, "w");
const err = openSync(ERR, "w");

const child = spawn(NODE, [BIN, "--profile", "web", "--no-open"], {
	detached: true,
	stdio: ["ignore", out, err],
	windowsHide: true,
	env,
});
child.unref();
console.log(`已启动 DSH（pid ${child.pid}）`);
console.log(`  stdout → ${LOG}`);
console.log(`  stderr → ${ERR}`);

// 等端口就绪并打印 token（从启动日志里取）。
const deadline = Date.now() + 60000;
let ready = false;
while (Date.now() < deadline) {
	await new Promise((resolve) => setTimeout(resolve, 1500));
	try {
		const response = await fetch("http://127.0.0.1:3080/health", { signal: AbortSignal.timeout(2500) });
		if (response.status < 500) {
			ready = true;
			break;
		}
	} catch {
		// 还没起来。
	}
}

if (!ready) {
	console.error("60 秒内没等到 3080 就绪。最近的输出：");
	try {
		console.error(readFileSync(LOG, "utf8").slice(-1200));
		console.error(readFileSync(ERR, "utf8").slice(-1200));
	} catch {
		// 日志都读不到就只报超时。
	}
	process.exitCode = 1;
} else {
	const text = readFileSync(LOG, "utf8");
	const match = /token=([A-Za-z0-9_-]+)/.exec(text);
	console.log(`3080 已就绪。token：${match ? match[1] : "(未在日志里找到，请查看上面的 stdout 文件)"}`);
}
