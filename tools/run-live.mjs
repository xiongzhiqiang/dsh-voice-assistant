/**
 * 单进程内跑完「启动 DSH → 等就绪 → 跑真机验证 → 收尾」。
 *
 * ## 为什么必须合成一个进程（本机环境的硬约束）
 *
 * 本机 CLI 的每次 Bash 工具调用结束时，会把该调用派生的**整棵进程树**一起收掉。
 * 所以"先起 DSH，再在另一次调用里跑验证"这条路走不通：第二次调用开始时，
 * 上一次起的 DSH 已经没了（表现为 `fetch failed` / `ECONNREFUSED`，
 * 而不是任何有意义的错误）。
 *
 * 另外两个已踩的坑也一并处理（详见 tools/start-dsh.mjs 的注释）：
 *   - `Start-Process` 因环境块里 `HTTP_PROXY`/`http_proxy` 重复键直接抛异常；
 *   - 分离启动若不给 stdio，DSH 会静默退出。
 *
 * 用法：`node tools/run-live.mjs <脚本名> [额外参数...]`
 *   例：`node tools/run-live.mjs smoke-switch-session.mjs`
 */
import { spawn } from "node:child_process";
import { openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const BIN = "C:/Users/xqz19/.dsh/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js";
const LOG = join(HERE, "_dsh-run12.log");
const ERR = join(HERE, "_dsh-run12.log.err");

const script = process.argv[2];
if (script === undefined) {
	console.error("用法: node tools/run-live.mjs <脚本名> [额外参数...]");
	process.exit(2);
}

// 子进程环境：剔掉大小写重复的代理变量（Windows 环境块对此敏感）。
const env = { ...process.env };
delete env.HTTP_PROXY;
delete env.HTTPS_PROXY;
for (const key of Object.keys(env)) {
	if (/^https?_proxy$/i.test(key) && key !== key.toUpperCase()) delete env[key];
}

const out = openSync(LOG, "w");
const err = openSync(ERR, "w");
console.log("启动 DSH…");
const dsh = spawn(NODE, [BIN, "--profile", "web", "--no-open"], {
	stdio: ["ignore", out, err],
	windowsHide: true,
	env,
});

/** 等端口就绪。 */
async function waitReady(timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 1200));
		try {
			const response = await fetch("http://127.0.0.1:3080/health", { signal: AbortSignal.timeout(2500) });
			if (response.status < 500) return true;
		} catch {
			// 还没起来。
		}
	}
	return false;
}

try {
	if (!(await waitReady(70000))) {
		console.error("DSH 没能在 70s 内就绪。输出：");
		try {
			console.error(readFileSync(LOG, "utf8").slice(-1500));
			console.error(readFileSync(ERR, "utf8").slice(-1500));
		} catch {
			// 读不到就算了。
		}
		process.exitCode = 1;
	} else {
		// 宿主半的 `webserver/index-inject` 在首个请求时才会把配置塞进首帧；
		// 刚监听成功时插件可能还没装配完，多等一会儿再跑验证，
		// 否则会出现"第一次跑全红、重跑全绿"的假失败。
		await new Promise((resolve) => setTimeout(resolve, 6000));
		const tokenMatch = /token=([A-Za-z0-9_-]+)/.exec(readFileSync(LOG, "utf8"));
		const token = tokenMatch ? tokenMatch[1] : "";
		console.log(`DSH 已就绪（token ${token === "" ? "未取到" : `${token.slice(0, 10)}…`}）`);
		console.log(`运行 ${script} …\n`);

		const child = spawn(NODE, [join(HERE, script), ...process.argv.slice(3)], {
			stdio: "inherit",
			env: { ...env, DSH_TOKEN: token },
		});
		const code = await new Promise((resolve) => child.on("exit", (value) => resolve(value ?? 1)));
		process.exitCode = code;
	}
} finally {
	try {
		dsh.kill();
	} catch {
		// 已经退了。
	}
}
