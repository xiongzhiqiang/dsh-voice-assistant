/**
 * 真机验证「轮次门槛」与「回声抑制」两条需求（浏览器内跑，不碰麦克风）。
 *
 * ## 为什么必须真机跑
 *
 * 这两条需求的判据都长在 `handleFinal` 这条真实路径上：识别片段进来 → 回声
 * 过滤 → 攒进 `TurnGate` → 静音到点才 `runCommand`。纯逻辑测试（tests/）只
 * 验证了 `TurnGate` / `EchoGuard` 两个类本身，验证不了"控制器有没有把它接上、
 * 接线是否漏了状态分支"。这里用无头 Chrome 打开真页面，调 `__xfvDebug.feed()`
 * 模拟"识别到一段话"，直接观察门槛有没有按阈值计时、回声有没有被丢掉。
 *
 * ## 为什么不用 ask()
 *
 * `ask()` 是"绕过识别直接提交"，走不到门槛。`feed()` 才是"识别到了"。
 * 这是本脚本与 `cdp-probe.mjs` 的关键区别 —— 后者验证的是会话链路，
 * 本脚本验证的是**轮次边界**。
 *
 * 用法：`node tools/smoke-turn-gate.mjs [url]`
 * 缺省 url 自动从最新实例的启动日志 / 结构化描述文件里取 token 拼出。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9334;
const BASE = "http://127.0.0.1:3080";
/**
 * 启动器把日志写到哪儿，这里就要去哪儿找。
 *
 * 两个目录都要扫：`serve-dsh.mjs`（常驻实例）写在**本目录**，
 * 而早期的一次性启动脚本（`run-live.mjs`）写在项目根的 `tools/`。
 * 只扫一个的话，另一种启动方式的 token 就找不到 —— 症状是
 * "`/health` 通但首页 401"，看起来像鉴权坏了，实际是拿到了过期 token。
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_DIRS = [HERE, "C:/Users/xqz19/WorkBuddy/DSH_dev/tools"];
const SERVE_INFO = join(HERE, "_dsh-serve.json");
/** 给假麦克风喂的静音文件（见上方 fake-audio-capture 注释）。 */
const SILENT_WAV = join(HERE, "_silence-60s.wav");

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

/**
 * 取访问 token：显式传入（环境变量 / 命令行）**优先于**日志探测。
 *
 * 日志探测有三个坑：`_dsh-run*.log` 里躺着历次实例的 token，取错了会
 * 落到"首页 401 但 /health 通"这种自相矛盾的现象上；日志还可能是
 * UTF-16（PowerShell `Out-File` 的默认编码）；常驻启动器根本不写
 * `_dsh-run*.log`，它写 `_dsh-serve.json`。所以三件事一起做：
 * **结构化文件优先 → 日志按 mtime 取最新 → 自动判编码**，
 * 同时让显式传入压倒一切。
 */
function resolveToken() {
	const explicit = process.env.DSH_TOKEN ?? process.argv[2] ?? "";
	if (explicit !== "") return explicit;

	// 常驻启动器的结构化描述文件：比扫日志可靠得多（无编码问题、
	// 不会被历次实例混进来）。
	if (existsSync(SERVE_INFO)) {
		try {
			const info = JSON.parse(readFileSync(SERVE_INFO, "utf8"));
			if (typeof info?.token === "string" && info.token !== "") return info.token;
		} catch {
			// 文件损坏 / 半写状态，退回日志扫描。
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

// 取一次 cookie，供页面直接带鉴权打开（避免落到登录页）。
const login = await fetch(`${BASE}/?token=${token}`, { redirect: "manual" }).catch(() => null);
const setCookies = login === null || login.headers.getSetCookie === undefined ? [] : login.headers.getSetCookie();
const cookie = setCookies.length === 0 ? "" : setCookies[0].split(";")[0];
if (cookie === "") {
	console.error("拿不到会话 cookie：请确认 DSH 在 3080 运行，且 token 正确。");
	process.exit(2);
}

const profileDir = mkdtempSync(join(tmpdir(), "dsh-turn-"));
const chrome = spawn(
	CHROME,
	[
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--autoplay-policy=no-user-gesture-required",
		// 假麦克风：让 start() 能走到 getUserMedia 成功分支，好让状态机真的进 active。
		"--use-fake-ui-for-media-stream",
		"--use-fake-device-for-media-stream",
		// 假麦克风必须喂**静音**：`--use-fake-device-for-media-stream` 自带的
		// 默认提示音会被本地 VAD 当成说话，反复产生假轮次（详见 smoke-reply-sleep）。
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

// 必须等 socket 真正 open 才能发 CDP 命令，否则 `send()` 抛
// InvalidStateError: Sent before connected —— 而错误发生在 await 之外，
// 表现为整个脚本直接崩掉，看不出是时序问题。
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
		if (payload.params.type === "error" || payload.params.type === "warning") {
			consoleEvents.push(`[${payload.params.type}] ${text}`);
		}
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
await send("Network.setCookie", { name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), domain: "127.0.0.1", path: "/" });
await send("Page.navigate", { url: `${BASE}/` });
await sleep(9000);

// ── 0. 前提：调试钩子与轮次配置就位 ──────────────────────────────────
const boot = await evaluate(`JSON.stringify({
	hook: typeof globalThis.__xfvDebug,
	hasFeed: typeof globalThis.__xfvDebug?.feed,
	hasSubmit: typeof globalThis.__xfvDebug?.submit,
	hasTurn: typeof globalThis.__xfvDebug?.turn,
	hasEcho: typeof globalThis.__xfvDebug?.echo,
	turnCfg: globalThis.__VOICE_ASSISTANT_CONFIG__?.turn ?? null,
	steer: globalThis.__VOICE_ASSISTANT_CONFIG__?.agent?.steer ?? null,
})`);
const bootInfo = JSON.parse(boot ?? "{}");
check("调试钩子就位", bootInfo.hook === "object", bootInfo.hook);
check("钩子暴露 feed（模拟识别片段）", bootInfo.hasFeed === "function", bootInfo.hasFeed);
check("钩子暴露 submit（手动提交）", bootInfo.hasSubmit === "function", bootInfo.hasSubmit);
check("钩子暴露 turn 诊断线", bootInfo.hasTurn === "function", bootInfo.hasTurn);
check("钩子暴露 echo 诊断线", bootInfo.hasEcho === "function", bootInfo.hasEcho);

// 这一条是本脚本的核心：宿主半必须把 turn 块下发下来。
// 没下发的话客户端只能用内置默认，用户改 cordis.patch.yml 会"改了不生效"。
check("首帧下发了 turn 配置", bootInfo.turnCfg !== null && typeof bootInfo.turnCfg === "object", JSON.stringify(bootInfo.turnCfg));
check("完成判据是 5 秒", bootInfo.turnCfg?.silenceMs === 5000, String(bootInfo.turnCfg?.silenceMs));
check(
	"完成判据在合理区间（明显大于引擎切段、又不至于干等）",
	bootInfo.turnCfg?.silenceMs > 1000 && bootInfo.turnCfg?.silenceMs <= 30000,
	String(bootInfo.turnCfg?.silenceMs),
);
check("回声抑制默认开启", bootInfo.turnCfg?.echoGuard === true, String(bootInfo.turnCfg?.echoGuard));

// ── 进入 active ──────────────────────────────────────────────────────
//
// 注意要**两次**：初始是 `off`，第一次 `wake()` 走的是 `start()` 分支
// （off → standby，"单击启用语音"），第二次才从 standby 进 active。
// 这是产品设计（未启用时单击只负责启用），不是缺陷 —— 脚本必须照着走。
const toActive = await evaluate(`(async () => {
	if (globalThis.__xfvDebug === undefined) return "no-hook";
	__xfvDebug.wake();            // off → standby（或 standby → active）
	await new Promise((r) => setTimeout(r, 300));
	if (globalThis.__xfvDebug.snapshot().status !== "active") {
		__xfvDebug.wake();        // standby → active
		await new Promise((r) => setTimeout(r, 300));
	}
	return globalThis.__xfvDebug.snapshot().status;
})()`, true);
await sleep(500);
const armedInfo = JSON.parse((await evaluate(`JSON.stringify({ status: globalThis.__xfvDebug?.snapshot?.()?.status ?? null })`)) ?? "{}");
check("唤醒后进入正在听", armedInfo.status === "active", `${toActive} / ${armedInfo.status}`);

// ── 1. 需求一：静音不满阈值绝不提交 ──────────────────────────────────
//
// 连送三个片段（模拟"说到一半停一下又说"），其间只等几秒。
// 断言：一次都没提交（prompts 为空），片段全部攒在门槛里。
// 注意每次间隔必须**明显小于** silenceMs（默认 5s），否则脚本自己会把
// 门槛提前触发 —— 那样测出来的是"正常提交"，不是"沉住气不提交"。
const beforePrompts = (await evaluate(`JSON.stringify(globalThis.__xfvDebug?.prompts?.() ?? [])`)) ?? "[]";
await evaluate(`(async () => {
	await __xfvDebug.feed("帮我打开D盘");
	return "ok";
})()`, true);
await sleep(1500); // 远小于 60s
await evaluate(`(async () => { await __xfvDebug.feed("然后建一个文件夹"); return "ok"; })()`, true);
await sleep(1500);
await evaluate(`(async () => { await __xfvDebug.feed("名字叫项目资料"); return "ok"; })()`, true);
await sleep(2500);

const gateState = JSON.parse((await evaluate(`JSON.stringify(globalThis.__xfvDebug?.turn?.() ?? null)`)) ?? "null");
check("片段被攒成整轮", gateState?.text === "帮我打开D盘然后建一个文件夹名字叫项目资料", JSON.stringify(gateState));
check("静音未满不提交（commits=0）", gateState?.commits === 0, String(gateState?.commits));
check("倒计时已武装（dueInMs 在 0..silenceMs）", typeof gateState?.dueInMs === "number" && gateState.dueInMs > 0 && gateState.dueInMs <= 5000, String(gateState?.dueInMs));

const midPrompts = (await evaluate(`JSON.stringify(globalThis.__xfvDebug?.prompts?.() ?? [])`)) ?? "[]";
check("静音期间没有向模型提交", JSON.parse(midPrompts).length === JSON.parse(beforePrompts).length, `before=${JSON.parse(beforePrompts).length} now=${JSON.parse(midPrompts).length}`);

const midSnap = JSON.parse((await evaluate(`JSON.stringify(globalThis.__xfvDebug?.snapshot?.() ?? null)`)) ?? "null");
check("界面显示待提交内容", (midSnap?.pending ?? "").includes("项目资料"), JSON.stringify(midSnap?.pending));

// ── 2. 需求一逃生口：单击语音球立即提交 ───────────────────────────────
const submitted = await evaluate(`__xfvDebug.submit()`);
check("手动提交返回 true", submitted === true, String(submitted));

/**
 * 等到 `prompts()` 里出现一条含指定文本的 `queue` 提交。
 *
 * ## 为什么不能写成固定 `sleep(2500)`
 *
 * 提交到落进 `promptLog` 之间隔着**一次润色网络往返**（宿主 `/api/polish` →
 * `deepseek-flash`）。这个往返的耗时不受本脚本控制：冷缓存/网络抖动时能轻松
 * 超过 2.5 秒，于是固定等待会**偶发**读到空的 `prompts()`，报出一条
 * "整轮内容一次性提交给模型 → []" 的假失败。
 *
 * 本轮实测就撞上了：重建 bundle 后的**第一次**跑（冷）挂 3 条，之后连跑
 * 4 次全绿 —— 典型的时序竞态，不是代码问题。本项目已有明确教训：
 * **固定 sleep 与真实耗时挂上钩时，要么重算步长、要么改成轮询**。
 * 这里选轮询（上界 30s），断言就变成确定性的。
 *
 * @param needle - 提交文本里必须包含的片段。
 * @param timeoutMs - 最长等待毫秒数。
 * @returns `promptLog` 全量（无论是否等到）。
 */
async function waitForCommit(needle, timeoutMs = 30000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const log = JSON.parse((await evaluate(`JSON.stringify(globalThis.__xfvDebug?.prompts?.() ?? [])`)) ?? "[]");
		if (log.some((entry) => entry.mode === "queue" && String(entry.text).includes(needle))) return log;
		if (Date.now() > deadline) return log;
		await sleep(500);
	}
}

const promptsAfter = await waitForCommit("项目资料");
// 诊断线：`prompts()` 空有两种可能 —— "压根没调 ask()"（提交路径被状态挡掉、
// 或 `runCommand` 在润色期间被换代打断）与"调了但没记上"。这两者对用户的
// 含义完全不同，所以失败时把旁证一起打出来（本项目反复踩"症状指向错误方向"）。
if (promptsAfter.length === 0) {
	const diag = JSON.parse(
		(await evaluate(
			`JSON.stringify({
				status: __xfvDebug?.snapshot?.()?.status ?? null,
				fails: __xfvDebug?.fails?.() ?? null,
				trace: __xfvDebug?.trace?.() ?? null,
				gate: __xfvDebug?.turn?.() ?? null,
			})`,
		)) ?? "{}",
	);
	console.log("    → 提交后诊断：" + JSON.stringify(diag).slice(0, 900));
}
const afterSubmit = JSON.parse((await evaluate(`JSON.stringify(globalThis.__xfvDebug?.turn?.() ?? null)`)) ?? "null");
check("手动提交计入 commits", afterSubmit?.commits === 1, String(afterSubmit?.commits));
check("手动提交归因是 manual", afterSubmit?.lastReason === "manual", afterSubmit?.lastReason);

const manualRecord = promptsAfter.find((p) => p.mode === "queue" && p.text.includes("项目资料"));
check("整轮内容一次性提交给模型", manualRecord !== undefined, JSON.stringify(promptsAfter.map((p) => p.text)));
// 提交文本会经过润色（补标点、引号转向），不能精确比对；
// 关键是三个片段的**内容全都在**，证明攒的是整轮而不是半句。
check(
	"提交的是整轮（三个片段都在）",
	manualRecord !== undefined &&
		manualRecord.text.includes("打开") &&
		manualRecord.text.includes("文件夹") &&
		manualRecord.text.includes("项目资料"),
	manualRecord?.text,
);
check(
	"只提交了一次（没拆成三句）",
	promptsAfter.filter((p) => p.mode === "queue").length === 1,
	String(promptsAfter.filter((p) => p.mode === "queue").length),
);

// ── 等 agent 把回答播完、状态落到「正在听」────────────────────────────
//
// 播报期间状态是 `speaking`，此时到达的识别结果会被**正确丢弃**
// （既有设计：播报时关麦，避免把自己的声音当指令）。脚本用 `feed()`
// 绕过麦克风，所以必须自己等播完，否则会测出"新指令没进门槛"这种假失败。
//
// 判据必须走**状态迁移轨迹**而不是轮询快照：播报可能很短，轮询会整段
// 漏掉中间的 `speaking`。曾经这里只等 `active`，而假麦克风报的识别错误
// 会让 `thinking + error → active` 误打误撞满足条件 ——
// "播报期其实停在 thinking"这个 bug 因此被掩盖了很久。
// （那个错误现在是 `asr-unreachable`；旧名 `speech-network` 见 README 坑七。）
/**
 * 等状态落到 `active`（播报结束 + 回声保护期已过，可以接着说话）。
 *
 * 为什么终态是 `active` 而不是 `standby`：播报收尾现在回**正在听**，
 * 收尾由 `active` 的 60s 休眠计时负责（"播报完没语音输入 60 秒才休眠"）。
 * 所以这里等 `active` 恰好等于"助手说完、可以继续说"。
 *
 * @param timeoutMs - 最长等待毫秒数。
 * @returns 最终状态。
 */
async function waitListening(timeoutMs = 90000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const status = String(await evaluate(`globalThis.__xfvDebug?.snapshot?.()?.status ?? "unknown"`));
		if (status === "active") return status;
		if (Date.now() > deadline) return status;
		await sleep(500);
	}
}
const settled = await waitListening();
check("回答播完后回到「正在听」（可继续接话，不必再唤醒）", settled === "active", settled);

// ── 3. 需求八 / 本轮修复：播报期是「播报中」、播完回「正在听、静默 60s 才睡」──
//
// ## 这一段为什么必须"手动摆状态"，而不是等真实事件流
//
// 本机 agent 没有配模型，`turn/end` 的文本**恒为空** —— 空文本走的是
// 另一条分支（`notice` + `REPLY` → `SPEAK_END`），落到状态机上就是
// `thinking>speaking:reply`。而用户报的 bug 长在**有文字回答**的主路径
// （`handleTurnEnd` → `AGENT_MESSAGE`）。这条路径真机上根本走不到，
// 所以"播报期归错状态"能长期躲过回归 —— 实证：改这段之前跑本脚本，
// 轨迹里出现的正是 `thinking>speaking:reply`，一条 agent-message 都没有。
//
// 因此这里直接调 `turnEnd(text)` 把"回答落地"这件事喂进控制器：
// **主路径的接线**（thinking 能否收 agent-message、播完落到哪个状态）
// 就变成确定性的了，不再取决于模型有没有配好。
//
// 用**出现次数差分**而不是索引切片来取"这一段新产生的轨迹"：
// 轨迹是有界的（满 50 条即 `shift()` 掉最老的），一旦溢出，
// 按索引切会整体错位、把旧条目当成新的，断言随之失真。
// 数次数天然免疫位移。
const countOf = (trace, line) => trace.filter((item) => item === line).length;
const traceBefore = JSON.parse((await evaluate(`JSON.stringify(globalThis.__xfvDebug?.trace?.() ?? [])`)) ?? "[]");
const beforeAgentMessage = countOf(traceBefore, "thinking>speaking:agent-message");
const beforeSpeakEnd = countOf(traceBefore, "speaking>active:speak-end");

// 把状态直接摆到「思考中」，再喂回答 —— 等同于"用户刚说完、agent 正在答"。
const forced = await evaluate(`(() => {
	if (typeof globalThis.__xfvDebug?.forceState !== "function") return "no-hook";
	return __xfvDebug.forceState("thinking");
})()`);
check("能确定性摆到「思考中」（为覆盖主路径）", forced === "thinking", String(forced));

const hasTurnEnd = await evaluate(`typeof globalThis.__xfvDebug?.turnEnd`);
check("钩子暴露 turnEnd（驱动播报主路径）", hasTurnEnd === "function", String(hasTurnEnd));

const spoken = await evaluate(
	`(async () => {
		if (typeof globalThis.__xfvDebug?.turnEnd !== "function") return "no-hook";
		await __xfvDebug.turnEnd("已经帮你把项目资料文件夹建好了");
		return __xfvDebug.snapshot().status;
	})()`,
	true,
);

const traceAfterSpeak = JSON.parse((await evaluate(`JSON.stringify(globalThis.__xfvDebug?.trace?.() ?? [])`)) ?? "[]");
check(
	"回答落地时状态切到「播报中」（不是停在思考中）",
	countOf(traceAfterSpeak, "thinking>speaking:agent-message") > beforeAgentMessage,
	traceAfterSpeak.join(" | ").slice(-240),
);
check(
	"播报结束后状态迁到「正在听」（不是退回待机、不必重新喊唤醒词）",
	countOf(traceAfterSpeak, "speaking>active:speak-end") > beforeSpeakEnd,
	traceAfterSpeak.join(" | ").slice(-240),
);
check("播报收尾后确实停在「正在听」（可继续接话）", spoken === "active", String(spoken));
// 反面断言：一旦退回 `standby`，症状就是"每轮都要重新喊小凤"。
// 这条专门盯着本次修复的那个迁移，避免它被改回去。
check(
	"播报收尾**不得**退回待机（那会导致每轮都要重新唤醒）",
	countOf(traceAfterSpeak, "speaking>standby:speak-end") === 0,
	traceAfterSpeak.join(" | ").slice(-240),
);
// ── 4. 需求二：助手自己刚念的话不得当成用户指令 ────────────────────────
//
// 直接调 remember() 模拟"助手刚念完一句"，再 feed 同一句的识别结果
// （带标点差异与同音错字，模拟真实转写）。断言：不进门槛、被丢掉。
//
// 前置：播报收尾后已经是**正在听**（本轮修复的结果），理论上可以直接
// 接着说。下面这段兜底仍然保留 —— 它是幂等的，而且在"播报没触发（例如
// 本机 agent 空轮）"时能把状态拉到 active，避免这段测出假失败。
// 顺带验证"播完可直接接话"这条链路是通的。
await evaluate(`(async () => {
	if (__xfvDebug.snapshot().status !== "active") {
		__xfvDebug.wake();
		await new Promise((r) => setTimeout(r, 300));
		if (__xfvDebug.snapshot().status !== "active") __xfvDebug.wake();
	}
	return __xfvDebug.snapshot().status;
})()`, true);
await sleep(600);

const answerText = "已经帮你把项目资料文件夹建好了，还需要我打开它吗";
await evaluate(`__xfvDebug.remember(${JSON.stringify(answerText)})`);
await sleep(200);

const gateBeforeEcho = JSON.parse((await evaluate(`JSON.stringify(globalThis.__xfvDebug?.turn?.() ?? null)`)) ?? "null");
const commitsBeforeEcho = gateBeforeEcho?.commits ?? 0;

// 带标点差异 + 同音错字（"文件加"、"词盘"风格）的转写
await evaluate(`(async () => { await __xfvDebug.feed("已经帮你把项目资料文件加建好了，还需要我打开它吗"); return "ok"; })()`, true);
await sleep(1500);

const echoState = JSON.parse((await evaluate(`JSON.stringify(globalThis.__xfvDebug?.echo?.() ?? null)`)) ?? "null");
const gateAfterEcho = JSON.parse((await evaluate(`JSON.stringify(globalThis.__xfvDebug?.turn?.() ?? null)`)) ?? "null");

check("回声被拦下（suppressed>0）", (echoState?.suppressed ?? 0) > 0, JSON.stringify(echoState));
check("回声记下了拦下的那条", String(echoState?.lastSuppressed ?? "").includes("文件"), echoState?.lastSuppressed);
check("回声没有进门槛（commits 不变）", (gateAfterEcho?.commits ?? -1) === commitsBeforeEcho, `${commitsBeforeEcho} → ${gateAfterEcho?.commits}`);
check("回声没有留在待提交里", (gateAfterEcho?.text ?? "") === "" || !String(gateAfterEcho?.text).includes("文件加"), gateAfterEcho?.text);

// ── 4. 需求二：用户的新指令不受回声防线影响 ────────────────────────────
await evaluate(`(async () => { await __xfvDebug.feed("那你顺便把日志文件也清一下"); return "ok"; })()`, true);
await sleep(1500);
const gateAfterUser = JSON.parse((await evaluate(`JSON.stringify(globalThis.__xfvDebug?.turn?.() ?? null)`)) ?? "null");
check("用户的新指令正常进门槛", (gateAfterUser?.text ?? "").includes("日志文件"), JSON.stringify(gateAfterUser));
check("新指令没被误判成回声", (gateAfterUser?.commits ?? 0) === commitsBeforeEcho, String(gateAfterUser?.commits));

// ── 5. 界面文案：倒计时必须能被用户看见 ───────────────────────────────
const uiText = await evaluate(`document.querySelector('.xfv-root')?.innerText ?? ''`);
check("界面显示待提交与倒计时", /待提交|还有 \d+ 秒/.test(String(uiText)), String(uiText).slice(0, 160));

console.log(results.join("\n"));
if (consoleEvents.length > 0) {
	console.log("\n=== 控制台告警/异常 ===");
	for (const item of consoleEvents.slice(0, 40)) console.log("  " + item);
}
console.log(failures.length === 0 ? "\n轮次门槛与回声抑制验证通过" : `\n${failures.length} 项失败`);

const shot = await send("Page.captureScreenshot", { format: "png" });
if (typeof shot?.result?.data === "string") {
	const shotPath = fileURLToPath(new URL("./_turn-shot.png", import.meta.url));
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
