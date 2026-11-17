/**
 * 装机验收：直接打真实 dsh webserver，确认插件真的被加载了。
 *
 * ## 为什么要走真实服务而不是只看单元测试
 *
 * DSH 的插件装配有三层（bundle 层 → patch 层 → 客户端模块清单），
 * 任一环出错的表现都是"界面里什么都没有"，且不报错。这里逐层验证：
 *   1. 宿主 bundle 被加载 → `/health` 能自报；
 *   2. 配置下发到位 → 首帧 HTML 里有 `__VOICE_ASSISTANT_CONFIG__`；
 *   3. 客户端模块进了 boot manifest → 首页的批量脚本 URL 里含本包；
 *   4. 模块内容真的被返回 → 批量响应里能找到我们的 module id 与槽名。
 *
 * ## 鉴权
 *
 * dsh webserver 用 `?token=` 换 cookie（303 → Set-Cookie），后续请求带 cookie。
 * 直接 `?token=` 打 API 也行，但静态资源只认 cookie，所以两步都做。
 *
 * ## 取 token 的两个坑（都踩过）
 *
 * 1. **日志是 UTF-16 的**。PowerShell 重定向出来的启动日志带 BOM 与 NUL 字节，
 *    按 utf8 读会得到一堆乱码，`/token=/` 直接匹配不到。
 * 2. **日志文件会累积**。`_dsh-run.log`、`_dsh-run2.log` … 每重启一次多一个，
 *    写死第一个文件名就会拿到**早就失效的 token**，症状是 `/health` 通
 *    （它接受 Bearer，无需 cookie）但首页 401 —— 看起来像 cookie 机制坏了，
 *    其实只是 token 过期了。
 *
 * 所以这里：按 mtime 选**最新**的日志、自动判编码、且显式传入优先。
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 本脚本所在目录（日志与状态文件都写在这里）。 */
const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.DSH_BASE ?? "http://127.0.0.1:3080";

const failures = [];
const check = (name, ok, detail) => {
	if (!ok) failures.push(name);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` → ${detail}`}`);
};

/**
 * 按 mtime 找最新的启动日志并解出 token。
 *
 * ## 为什么要跨两个目录找
 *
 * 本机的启动日志分两处，取决于用哪个启动器：
 *   - `tools/run-live.mjs`     → 写在**本目录**（`_dsh-run12.log`）；
 *   - 本机早期探索脚本         → 写在 `DSH_dev/tools/`。
 * 只盯一个目录会在换启动器时静默拿不到 token（本轮踩过：常驻实例明明写好了
 * `_dsh-serve.log`，脚本却去 `DSH_dev/tools/_dsh-run12.log` 找旧 token，
 * 于是首页 401 —— 看起来像"插件没加载"，实际只是 token 过期）。
 *
 * 优先读 `_dsh-serve.json`（常驻启动器写的结构化状态，含现成 token），
 * 它比"翻日志正则"可靠得多；没有再退回日志扫描。
 *
 * 编码自动判定：有 NUL 字节就按 utf16le 解，否则按 utf8。
 * （PowerShell 的 `>` 重定向产出 UTF-16LE；`Out-File -Encoding utf8` 是 UTF-8。）
 */
function readToken() {
	// ① 常驻启动器的状态文件（最可靠）。
	const statePath = join(HERE, "_dsh-serve.json");
	if (existsSync(statePath)) {
		try {
			const state = JSON.parse(readFileSync(statePath, "utf8"));
			if (typeof state?.token === "string" && state.token !== "") {
				return { token: state.token, log: statePath };
			}
		} catch {
			// 状态文件坏了/还在写：退回日志扫描。
		}
	}

	// ② 扫两个目录里的 `_dsh-run*.log`，按 mtime 取最新。
	const dirs = [HERE, "C:/Users/xqz19/WorkBuddy/DSH_dev/tools"];
	let newest = null;
	for (const dir of dirs) {
		let files = [];
		try {
			files = readdirSync(dir).filter((name) => /^_dsh-(run\d*|serve)\.log$/.test(name));
		} catch {
			continue;
		}
		for (const name of files) {
			const path = join(dir, name);
			try {
				const info = statSync(path);
				if (newest === null || info.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: info.mtimeMs };
			} catch {
				// 文件刚被删/被占：跳过。
			}
		}
	}
	if (newest === null) return { token: "", log: "" };

	const buffer = readFileSync(newest.path);
	const text = buffer.includes(0) ? buffer.toString("utf16le") : buffer.toString("utf8");
	const match = /token=([A-Za-z0-9_-]+)/.exec(text);
	return { token: match ? match[1] : "", log: newest.path };
}

// 显式传入（环境变量或命令行参数）优先于日志探测 —— 否则日志里的过期 token
// 会把正确的那个压掉。
const fromLog = readToken();
const explicit = process.env.DSH_TOKEN ?? process.argv[2] ?? "";
const token = explicit !== "" ? explicit : fromLog.token;
check(
	"拿到访问 token",
	token !== "",
	explicit === "" ? "最新启动日志里没有 token" : "已显式传入",
);
if (explicit === "") console.log(`    → 取自 ${fromLog.log || "（没找到日志）"}`);
else console.log("    → 取自显式传入（DSH_TOKEN 或命令行参数）");

// 换 cookie
const handshake = await fetch(`${BASE}/?token=${token}`, { redirect: "manual" }).catch((error) => ({ error }));
const cookie = (handshake.headers?.getSetCookie?.() ?? []).map((entry) => entry.split(";")[0]).join("; ");
check("换到会话 cookie", cookie !== "", `set-cookie 为空（status=${handshake.status}）`);

const authHeaders = { cookie, ...(token === "" ? {} : { authorization: `Bearer ${token}` }) };

// 1. 宿主 API
const health = await fetch(`${BASE}/plugins/dsh-voice-assistant/api/health`, { headers: authHeaders }).catch((error) => ({ error }));
check("/health 可达", health.status === 200, health.status ?? health.error?.message);
if (health.status === 200) {
	const body = await health.json();
	check("/health 报出本插件", body.plugin === "dsh-voice-assistant", body.plugin);
	check("/health 报出润色模型", typeof body.capabilities?.polishModel === "string", JSON.stringify(body.capabilities));
	console.log(`    → 润色 ${body.capabilities?.polishAvailable ? "可用" : "不可用"}（${body.capabilities?.polishModel || "无模型"}），休眠 ${body.sleep?.idleTimeoutMs} ms`);

	// 归档自愈的结论必须可见：常驻会话一旦躺在归档集合里，本 profile 的
	// `ArchivedSessionGate` 会让**每一轮** `agent/pre-step` 被 reject ——
	// turn 一开就结束、永远不发起模型请求。而客户端提交是**成功**的
	// （`prompt()` 返回 `{ok:true}`），所以界面上完全看不出异常。
	// 详见 lib/identity.js 的 `ensureSessionNotArchived`。
	//
	// 断言"查过了并且不在归档里"，而不是断言"解除过"：
	// 解除只在**曾经**归档过的那一次发生，正常启动应当是 `not-archived`。
	const archived = body.archivedFix;
	console.log(`    → 归档自愈 ${archived === null || archived === undefined ? "（未跑）" : `${archived.reason}（checked=${archived.checked}，仍归档=${archived.archived}）`}`);
	check("常驻会话不在归档集合里（否则助手会哑掉）", archived?.archived !== true, JSON.stringify(archived));
	check("归档自愈确实查过了", archived?.checked === true, JSON.stringify(archived));
}

// 2. 首帧配置 + 客户端模块清单
const page = await fetch(`${BASE}/`, { headers: authHeaders }).catch((error) => ({ error }));
check("首页可达", page.status === 200, page.status ?? page.error?.message);
const html = page.status === 200 ? await page.text() : "";

check("首帧注入了配置全局", html.includes("__VOICE_ASSISTANT_CONFIG__"));
check("首帧配置含唤醒词", html.includes("小凤"));
check("客户端模块进了 boot manifest", html.includes("dsh-voice-assistant/client.js"), "清单里没有本包");

// 3. 取回真实批量脚本，确认模块内容被服务
const batchHrefs = [...html.matchAll(/href="(plugins\/\?\?[^"]+)"/g)]
	.map((match) => match[1].replace(/&amp;/g, "&"))
	.filter((href) => href.includes("dsh-voice-assistant"));
check("找到含本包的批量脚本 URL", batchHrefs.length > 0, `found=${batchHrefs.length}`);

if (batchHrefs.length > 0) {
	const res = await fetch(`${BASE}/${batchHrefs[0]}`, { headers: authHeaders });
	const bundle = res.status === 200 ? await res.text() : "";
	check("批量脚本返回 200", res.status === 200, res.status);
	check("响应里含本包 module id", bundle.includes('"dsh-voice-assistant"'));
	check("响应里注册了 shell.overlay", bundle.includes("shell.overlay"));
	// `shell.overlay` 是 list 槽，注册时必须带唯一 id；漏了会在浏览器里
	// 抛 "list slot ... requires options.id"，把整个 web boot 带崩。
	check("shell.overlay 注册项带 id", /name:\s*"shell\.overlay",\s*id:\s*"[^"]+"/.test(bundle));
	check("响应体积合理（>100KB 合并包）", bundle.length > 100000, `${bundle.length} bytes`);
}

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败：${failures.join(" / ")}`);
	process.exitCode = 1;
} else {
	console.log("\n装机验收通过");
}
