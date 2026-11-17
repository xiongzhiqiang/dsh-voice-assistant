/**
 * 真机验证「播报完不必重新唤醒、静默 60 秒才休眠」（真浏览器里跑）。
 *
 * ## 这条需求为什么必须单独有一个真机脚本
 *
 * 需求原话：「语音助手回答完一轮就进入休眠了，用户必须重新重新唤醒，
 * 让它播报完没有语音输入 60S 才进入休眠」。
 *
 * 拆开是**两条**要求，而且它们各自对应一个**方向相反**的失败模式：
 *
 * | 要求 | 失败模式 | 症状 |
 * |---|---|---|
 * | 播完还能接着说（不必再喊唤醒词） | 播完落到 `standby` | 每答完一轮都要重新喊「小凤」 |
 * | 静默满 60 秒才休眠 | 计时压根没武装 | **永远不休眠** |
 *
 * 两次失败可以**同时发生** —— 这正是本需求报的那个 bug。而"症状指向错误方向"：
 * 用户说"回答完就进入休眠了"，实际代码里既没睡、又要求重新唤醒。
 * 所以断言必须把这两件事**分开钉**，只看终态是 `active` 会同时放过这两条
 * （落到 `standby` 时终态不是 active，但"计时没武装"和"终态活跃"可以并存）。
 *
 * ## 判据怎么做到又快又准
 *
 * 等满 60 秒太慢，而且"等了 60 秒确实睡了"只证明了上界，证明不了**不是**
 * 12 秒那一档。这里用两个**判别性**判据代替傻等：
 *
 * 1. **t+13.5s 仍为 `active`** —— 这一条专门证伪"落到 `WAKE_GRACE_MS`（12s）
 *    那一档"。若错档，12 秒就 `IDLE` 回 `standby` 了，13.5 秒必被抓住。
 * 2. **t+13.5s 时直接喂一句话、不带唤醒词，必须进门槛** —— 这是"不必重新
 *    唤醒"的**行为级**证明。若仍需唤醒词，`standby` 分支会把它当日常闲话丢掉。
 *
 * 最后再轮询到 `sleeping`，证明"确实会睡"（不是永远醒着），上界放宽到 120s
 * 以吸收"期间又跑了一轮 → 计时重排"带来的浮动。
 *
 * 用法：`node tools/smoke-reply-sleep.mjs`
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9335;
const BASE = "http://127.0.0.1:3080";
const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_DIRS = [HERE, "C:/Users/xqz19/WorkBuddy/DSH_dev/tools"];
const SERVE_INFO = join(HERE, "_dsh-serve.json");
/** 给假麦克风喂的静音文件（见下方 `--use-file-for-fake-audio-capture` 注释）。 */
const SILENT_WAV = join(HERE, "_silence-60s.wav");

/** 判定档位的观察点：必须**明显超过** `WAKE_GRACE_MS`（12s）留出余量。 */
const OBSERVE_MS = 13500;

const failures = [];
const results = [];
/**
 * 断一条。
 * @param name - 断言名。
 * @param ok - 是否通过。
 * @param detail - 失败时展示的细节。
 */
function check(name, ok, detail) {
	results.push(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` → ${detail}`}`);
	if (!ok) failures.push(name);
}

/** 取访问 token（结构化文件优先 → 日志按 mtime 取最新 → 自动判编码）。 */
function resolveToken() {
	const explicit = process.env.DSH_TOKEN ?? process.argv[2] ?? "";
	if (explicit !== "") return explicit;
	if (existsSync(SERVE_INFO)) {
		try {
			const info = JSON.parse(readFileSync(SERVE_INFO, "utf8"));
			if (typeof info?.token === "string" && info.token !== "") return info.token;
		} catch {
			// 半写状态，退回日志扫描。
		}
	}
	let newest = null;
	for (const dir of LOG_DIRS) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir).filter((n) => /^_dsh-(run|serve)\d*\.log$/.test(n))) {
			const path = join(dir, name);
			const info = statSync(path);
			if (newest === null || info.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: info.mtimeMs };
		}
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

const profileDir = mkdtempSync(join(tmpdir(), "dsh-reply-sleep-"));
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
		// ## 为什么必须喂**静音**文件，不能只靠 `--use-fake-device`
		//
		// `--use-fake-device-for-media-stream` 造出来的假麦克风**不是静音**：
		// 它循环播放一段默认提示音（Chrome 用来让人确认"设备在工作"）。
		//
		// 这在早期版本里无害 —— 那时识别引擎是浏览器 Web Speech，本插件
		// 不碰麦克风。但**接上 dsh-ears 之后引擎会变成 `HttpAsrEngine`，
		// 它真的开麦克风做本地 VAD**。于是那段提示音每秒都在触发 VAD：
		// 起音 3 帧 → 录一段 → 上报 → 走完一轮 → 休眠计时被重排
		// → **永远等不到 60 秒静默**。
		//
		// 实测证据：接上本地 Whisper 后本脚本从"全绿"变成稳定失败，
		// 状态卡在 `active`；诊断显示 +17.5s 出现「（识别中…）」、
		// +20s `turn.fragments` 变 1 —— 就是假音频喂出来的假轮次。
		//
		// 这条**不是产品缺陷**，是测试夹具失真。喂真静音后 VAD 不会起音。
		...(existsSync(SILENT_WAV) ? [`--use-file-for-fake-audio-capture=${SILENT_WAV}`] : []),
		`--user-data-dir=${profileDir}`,
		`--remote-debugging-port=${PORT}`,
		"about:blank",
	],
	{ stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 等 Chrome 调试端口就绪并取页面 target。 */
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
const consoleEvents = [];
let nextId = 1;

await new Promise((resolve, reject) => {
	socket.addEventListener("open", resolve, { once: true });
	socket.addEventListener("error", reject, { once: true });
});

socket.addEventListener("message", (message) => {
	const payload = JSON.parse(message.data);
	if (payload.id !== undefined) {
		const resolve = pending.get(payload.id);
		if (resolve !== undefined) {
			pending.delete(payload.id);
			resolve(payload);
		}
		return;
	}
	if (payload.method === "Runtime.consoleAPICalled") {
		const text = (payload.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
		if (payload.params.type === "error") consoleEvents.push(`[error] ${text}`);
	}
	if (payload.method === "Runtime.exceptionThrown") {
		consoleEvents.push(`[exception] ${payload.params.exceptionDetails?.text ?? ""}`);
	}
});

/**
 * 发一条 CDP 命令。
 * @param method - 方法名。
 * @param params - 参数。
 * @returns CDP 响应。
 */
function send(method, params = {}) {
	const id = nextId;
	nextId += 1;
	socket.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve) => pending.set(id, resolve));
}

/**
 * 在页面里求值。
 * @param expression - 表达式。
 * @param awaitPromise - 是否等待 Promise。
 */
async function evaluate(expression, awaitPromise = false) {
	const response = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
	return response?.result?.result?.value ?? response?.result?.value;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");
await send(
	"Network.setCookie",
	{ name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), domain: "127.0.0.1", path: "/" },
);
await send("Page.navigate", { url: `${BASE}/` });
await sleep(9000);

// ── 0. 前提：调试钩子与休眠配置 ────────────────────────────────────────
const boot = await evaluate(`JSON.stringify({
	hook: typeof globalThis.__xfvDebug,
	hasTurnEnd: typeof globalThis.__xfvDebug?.turnEnd,
	hasFeed: typeof globalThis.__xfvDebug?.feed,
	idle: globalThis.__VOICE_ASSISTANT_CONFIG__?.sleep?.idleTimeoutMs ?? null,
	silence: globalThis.__VOICE_ASSISTANT_CONFIG__?.turn?.silenceMs ?? null,
})`);
const info = JSON.parse(boot ?? "{}");
check("调试钩子就位", info.hook === "object", info.hook);
check("钩子暴露 turnEnd（驱动播报主路径）", info.hasTurnEnd === "function", info.hasTurnEnd);
check("钩子暴露 feed（模拟识别片段）", info.hasFeed === "function", info.hasFeed);
// 这一条是整段判据的基准：下面所有时间断言都相对它。把实际值打出来，
// 免得"配的是 60 秒"这件事只是我以为的。
check("休眠时长下发为 60 秒", info.idle === 60000, String(info.idle));
console.log(`    → 休眠 ${info.idle} ms；静音提交 ${info.silence} ms；观察点 ${OBSERVE_MS} ms`);

// ── 1. 复刻"刚说完、agent 答完"这一步 ──────────────────────────────────
//
// 把状态直接摆到「思考中」再喂一段有文字的回答 —— 等同"用户刚说完、
// agent 正在答"。不这么做的话，本机 agent 的 `turn/end` 文本常常是空的，
// 空文本走的是另一条分支（`notice` + `REPLY`），根本走不到播报主路径。
const settled = await evaluate(
	`(async () => {
		if (typeof __xfvDebug?.forceState !== "function") return "no-hook";
		// 先确保语音已启用（off → standby），否则 forceState 摆不出有效链路。
		if (__xfvDebug.snapshot().status === "off") {
			__xfvDebug.wake();
			await new Promise((r) => setTimeout(r, 400));
		}
		__xfvDebug.forceState("thinking");
		await __xfvDebug.turnEnd("已经帮你把项目资料文件夹建好了，还需要我打开它吗");
		return JSON.stringify({ status: __xfvDebug.snapshot().status });
	})()`,
	true,
);
const settledInfo = JSON.parse(settled ?? "{}");
check("回答播完直接落在「正在听」（不必再喊唤醒词）", settledInfo.status === "active", settled);

// 轨迹级证据：必须真的出现 `speaking>active:speak-end`（而不是 `>standby`）。
const trace = JSON.parse((await evaluate(`JSON.stringify(globalThis.__xfvDebug?.trace?.() ?? [])`)) ?? "[]");
check(
	"轨迹里出现 speaking>active:speak-end（播完进听写）",
	trace.includes("speaking>active:speak-end"),
	trace.join(" | ").slice(-220),
);
check(
	"轨迹里**没有** speaking>standby:speak-end（那会导致每轮都要重新唤醒）",
	!trace.includes("speaking>standby:speak-end"),
	trace.join(" | ").slice(-220),
);

// ── 2. 关键判别点：播报后 13.5 秒仍必须是「正在听」────────────────────
//
// ## 这一条专门证伪"落到 12 秒那一档"
//
// `armIdle()` 有三档。播完若被算成"刚唤醒、还没开口"（`awaitingFirstUtterance`），
// 走的会是 `WAKE_GRACE_MS`（12s）→ `IDLE` 回 `standby`。那时用户**还是**要
// 重新唤醒，只是从"立刻"变成"12 秒后" —— 更难被发现，而且"60 秒"是空话。
//
// 终态断言完全挡不住这种情况（12s 档在 t<12s 时终态同样是 active，而
// `smoke-turn-gate` 的 `turnEnd` 断言恰好在那之前就读了状态）。
// 唯一可靠的办法是**跨过 12 秒再看一眼**。
const t0 = Date.now();
await sleep(OBSERVE_MS);
const afterGrace = await evaluate(`__xfvDebug?.snapshot?.()?.status ?? "unknown"`);
check(
	`播报后 ${Math.round(OBSERVE_MS / 1000)} 秒仍在「正在听」（证伪 12 秒短档）`,
	afterGrace === "active",
	`${afterGrace}（仍在听=按 60s 计时；已回 standby=错档成 12s）`,
);

// ── 3. 行为级证明：此刻**不带唤醒词**直接说话，必须被接受 ──────────────
//
// 这是"不必重新唤醒"最直接的证据。若状态还停在 `standby`，`handleFinal`
// 的待机分支会把不带唤醒词的话当**日常闲话丢掉**，门槛里什么都不会有。
// 所以断言"门槛确实收到了这句话"。
const fed = await evaluate(
	`(async () => {
		await __xfvDebug.feed("那你顺便把日志文件也清一下");
		await new Promise((r) => setTimeout(r, 600));
		const gate = __xfvDebug.turn?.() ?? null;
		return JSON.stringify({ text: gate?.text ?? "", status: __xfvDebug.snapshot().status });
	})()`,
	true,
);
const fedInfo = JSON.parse(fed ?? "{}");
check(
	"播报后直接说话（不带唤醒词）能进门槛 —— 不必重新唤醒",
	fedInfo.text.includes("日志文件"),
	JSON.stringify(fedInfo),
);

// ── 4. 最终一定会睡（不是永远醒着）────────────────────────────────────
//
// 上界放宽到 120 秒：期间若又跑完一轮，`armIdle()` 会重排计时（每轮重排是
// 刻意设计 —— 否则用户连续对话到第 59 秒会被打断）。所以只能断言"最终会睡"。
// 再补一条下界：睡的时间**明显晚于** 12 秒档（否则又回到"每轮都要重新唤醒"）。
const sleepStart = Date.now();
let finalStatus = "unknown";
for (;;) {
	finalStatus = String(await evaluate(`__xfvDebug?.snapshot?.()?.status ?? "unknown"`));
	if (finalStatus === "sleeping") break;
	if (Date.now() - sleepStart > 120000) break;
	await sleep(1000);
}
const waitedMs = Date.now() - sleepStart;
check("静默之后确实会入睡（不是永远醒着）", finalStatus === "sleeping", `${finalStatus}（等了 ${Math.round(waitedMs / 1000)}s）`);
check(
	"入睡时间明显晚于 12 秒档（确实是 60 秒这一档）",
	waitedMs > 12000,
	`${Math.round(waitedMs / 1000)}s`,
);

console.log(results.join("\n"));
if (consoleEvents.length > 0) {
	console.log("\n=== 控制台异常 ===");
	for (const item of consoleEvents.slice(0, 30)) console.log("  " + item);
}
console.log(failures.length === 0 ? "\n播报后续话与 60s 休眠验证通过" : `\n${failures.length} 项失败`);

const shot = await send("Page.captureScreenshot", { format: "png" });
if (typeof shot?.result?.data === "string") {
	const shotPath = fileURLToPath(new URL("./_reply-sleep-shot.png", import.meta.url));
	writeFileSync(shotPath, Buffer.from(shot.result.data, "base64"));
	console.log(`截图：${shotPath}`);
}

socket.close();
chrome.kill();
await sleep(300);
try {
	rmSync(profileDir, { recursive: true, force: true });
} catch {
	// 清理失败无所谓。
}
process.exitCode = failures.length === 0 ? 0 : 1;
