/**
 * 真机验证「跨会话」（需求 ②）：切换 / 新建 / 回常驻，浏览器内跑真 DSH。
 *
 * ## 为什么单测不够，必须真机再跑一遍
 *
 * `tests/client-core.test.mjs` 用假 ctx 覆盖了 `VoiceSession` 的**自己那半边**
 * （水位线重置、历史拦截、失败退回）。真机要补的是**接线层**：
 *
 *   1. `ctx.sessions.list` 的真实形状到底是不是 `{ state: { ids, byId } }` ——
 *      假 ctx 是按我的假设造的，真实投影若换了层数，单测会**全绿而功能全废**；
 *   2. `sessions.create()` 真实返回 `{ sessionId }` 而非字符串；
 *   3. `controller` 的转发、`__xfvDebug` 的钩子、UI 的面板是否真的接上了；
 *   4. 切换之后**指令真的落进新会话** —— 这是需求的核心，也是唯一
 *      必须靠一次真实 `prompt()` 才能确认的事（`prompts()` 里能看到落点）。
 *
 * 第 1 条尤其重要：`@deepseek-ai/dsh-client-store`（`SnapshotStore` 的来源包）
 * 在本机 profile 里**没有实体目录**，只有类型引用 —— 类型声明读得到，
 * 运行时形状只能实探。
 *
 * ## 为什么不用 ask() 验证落点
 *
 * 用。`ask()` 正是"真提交一轮"的唯一入口；本脚本关心的是**提交去了哪条会话**，
 * 不是识别链路，所以这里用 `ask` 而不是 `feed`（后者是 smoke-turn-gate 的活）。
 *
 * 用法：`node tools/smoke-switch-session.mjs [token]`
 * 缺省 token 自动从常驻启动器的描述文件 / 启动日志里取最新实例。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9336;
const HERE = dirname(fileURLToPath(import.meta.url));
/** 给假麦克风喂的静音文件（见 `--use-file-for-fake-audio-capture` 注释）。 */
const SILENT_WAV = join(HERE, "_silence-60s.wav");
const LOG_DIR = "C:/Users/xqz19/WorkBuddy/DSH_dev/tools";
const BASE = "http://127.0.0.1:3080";

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
 * 取访问 token（显式传入优先）。
 *
 * ## 为什么要扫两个目录 + 认结构化文件
 *
 * 本脚本最早只扫项目根的 `tools/_dsh-run*.log` —— 那是 `run-live.mjs`
 * （同进程起 DSH）写日志的地方。改用常驻启动器 `serve-dsh.mjs` 之后，
 * 日志落在**自己所在的目录**（`dsh-voice-assistant/tools/`），而且是
 * `_dsh-serve.log`，正则 `^_dsh-run` 压根匹配不上 → 拿到空 token →
 * 直接报"拿不到会话 cookie"。
 *
 * 这个症状比"401 首页"好一点（会明说拿不到 cookie），但根因是同一个：
 * **认不出当前实例把 token 写在哪**。所以三件事一起做：
 * 结构化文件优先（无编码问题、不会混进历次实例）→ 两个目录按 mtime
 * 取最新 → 自动判 UTF-16/UTF-8。
 *
 * @returns token 字符串，取不到为空串。
 */
function resolveToken() {
	const explicit = process.env.DSH_TOKEN ?? process.argv[2] ?? "";
	if (explicit !== "") return explicit;
	const here = dirname(fileURLToPath(import.meta.url));
	const serveInfo = join(here, "_dsh-serve.json");
	if (existsSync(serveInfo)) {
		try {
			const info = JSON.parse(readFileSync(serveInfo, "utf8"));
			if (typeof info?.token === "string" && info.token !== "") return info.token;
		} catch {
			// 半写状态，退回日志扫描。
		}
	}
	let newest = null;
	for (const dir of [here, LOG_DIR]) {
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

const profileDir = mkdtempSync(join(tmpdir(), "dsh-switch-"));
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

/** 等 Chrome 调试端口就绪并取页面 target。 */
async function pageTarget() {
	for (let attempt = 0; attempt < 60; attempt += 1) {
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
 * 在页面里求值并把结果解析成 JSON。
 * @param expression - 表达式（应返回 JSON 字符串）。
 * @returns 解析后的值；失败返回 `null`。
 */
async function evaluate(expression) {
	const response = await send("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
	});
	const raw = response?.result?.result?.value;
	if (typeof raw !== "string") return raw ?? null;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Network.enable");
// 带 cookie 打开，避免落到登录页。
await send("Network.setCookie", { name: cookie.split("=")[0], value: cookie.split("=").slice(1).join("="), url: BASE });
await send("Page.navigate", { url: `${BASE}/` });
await sleep(9000);

// 先确认插件真的装上了 —— 后面所有断言都依赖它。
const ready = await evaluate(`JSON.stringify({
	hook: typeof globalThis.__xfvDebug,
	hasSwitch: typeof globalThis.__xfvDebug?.switchSession,
	hasSessions: typeof globalThis.__xfvDebug?.sessions,
	hasNew: typeof globalThis.__xfvDebug?.newSession,
	hasBack: typeof globalThis.__xfvDebug?.backToAssistant,
	hasTarget: typeof globalThis.__xfvDebug?.sessionTarget,
	configMemory: JSON.stringify(globalThis.__VOICE_ASSISTANT_CONFIG__?.memory ?? null),
	configLabel: globalThis.__VOICE_ASSISTANT_CONFIG__?.session?.label ?? null,
})`);
check("页面已装配（__xfvDebug 就位）", ready?.hook === "object", JSON.stringify(ready));
check("跨会话钩子已暴露（sessions/switchSession/newSession/backToAssistant）",
	ready?.hasSessions === "function" && ready?.hasSwitch === "function" && ready?.hasNew === "function" && ready?.hasBack === "function",
	JSON.stringify(ready));
check("sessionTarget 钩子就位", ready?.hasTarget === "function", String(ready?.hasTarget));
check("宿主下发了 session.label（需求①标注）", typeof ready?.configLabel === "string", String(ready?.configLabel));
check("宿主下发了 memory 块（需求①全局记忆）", typeof ready?.configMemory === "string" && ready.configMemory !== "null", String(ready?.configMemory));

// 让链路就绪：先按一次语音球（无头环境有假麦克风，能真进待机）。
await send("Runtime.evaluate", {
	expression: `(() => { const orb = document.querySelector(".xfv-orb"); if (orb === null) return "no-orb"; orb.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); orb.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); return "clicked"; })()`,
});
await sleep(2500);

// ── 1. 会话列表的真实形状（本节是全脚本的地基）──────────────────────
//
// 断言的是**真实投影结构**，而不是"函数返回了数组"：假 ctx 里
// `getSnapshot()` 返回的是我假设的 `{ state: { ids, byId } }`，
// 真实 DSH 若换了层数，`listTargets()` 会静默返回空数组 ——
// 不报错、只是"永远没得选"，是最难被发现的一类失效。
const listProbe = await evaluate(`JSON.stringify((() => {
	const ctx = globalThis.__xfvDebug;
	if (ctx === undefined) return { error: "no-hook" };
	const rows = ctx.sessions();
	return {
		isArray: Array.isArray(rows),
		count: Array.isArray(rows) ? rows.length : -1,
		firstKeys: Array.isArray(rows) && rows.length > 0 ? Object.keys(rows[0]).sort() : [],
		hasHome: Array.isArray(rows) && rows.some((r) => r.id === "session-voice-assistant-root"),
		anySubagent: Array.isArray(rows) && rows.some((r) => r.id === undefined || r.title === undefined),
	};
})())`);
check("sessions() 返回数组", listProbe?.isArray === true, JSON.stringify(listProbe));
// 字段集合要**精确**匹配：多一个少一个都说明契约变了。
// 注意字母序是 current < cwd（'u' < 'w'），别按直觉手写。
check("列表字段形状与实现一致（id/title/cwd/running/current）",
	JSON.stringify(listProbe?.firstKeys ?? []) === JSON.stringify(["current", "cwd", "id", "running", "title"]),
	JSON.stringify(listProbe?.firstKeys));
check("列表里含常驻助手会话（说明真实投影读到了）", listProbe?.hasHome === true, JSON.stringify(listProbe));
check("列表项字段齐全（无 undefined id/title）", listProbe?.anySubagent === false, JSON.stringify(listProbe));

// 若列表为空，后续切换无从谈起 —— 明确报出来而不是让断言连环失败。
if (listProbe?.count === 0) {
	console.log("!! 真实会话列表为空：无法验证切换。请先手建一个会话后重跑。");
}

// ── 2. 基线：当前目标是常驻助手 ───────────────────────────────────────
//
// 必须先提交一轮把会话**真正绑上**再查：`ensure()` 是懒的（第一次 ask 时
// 才建绑定），而点一下语音球只是进待机 —— 那时 `sessionTarget` 还停在
// 初始值 `尚未建立`，断言会误判成"绑定错了"。这一轮同时也就验了
// "默认目标就是常驻助手"。
const prime = await evaluate(`(async () => {
	await globalThis.__xfvDebug.ask("跨会话基线：请回复收到");
	return JSON.stringify({ target: globalThis.__xfvDebug.sessionTarget(), prompts: globalThis.__xfvDebug.prompts() });
})()`);
const primePrompt = Array.isArray(prime?.prompts) ? prime.prompts[prime.prompts.length - 1] : null;
check("默认指令发往常驻助手（prompt 被接受）", primePrompt?.ok === true, JSON.stringify(primePrompt));

const baseline = await evaluate(`JSON.stringify(globalThis.__xfvDebug.sessionTarget())`);
check("基线：目标为常驻助手", baseline?.mode === "persistent" && baseline?.id === "session-voice-assistant-root", JSON.stringify(baseline));
check("基线：describe 给出人话标签", typeof baseline?.label === "string" && baseline.label !== "", JSON.stringify(baseline));

// ── 3. 新建会话并切过去（需求原句："根据用户需求开启新的会话分配任务"）──
const created = await evaluate(`(async () => {
	const id = await globalThis.__xfvDebug.newSession({});
	return JSON.stringify({ id, target: globalThis.__xfvDebug.sessionTarget(), snapshot: globalThis.__xfvDebug.snapshot() });
})()`);
check("新建会话拿到新 id", typeof created?.id === "string" && created.id !== "", JSON.stringify(created?.id));
check("新建后 mode 为 switched（真的换绑了，不是沿用常驻）", created?.target?.mode === "switched", JSON.stringify(created?.target));
check("新建后绑定到新会话", created?.target?.id === created?.id, JSON.stringify(created?.target));
check("快照里的 sessionId 同步更新（面板才显示得对）", created?.snapshot?.sessionId === created?.id, JSON.stringify({ snap: created?.snapshot?.sessionId, id: created?.id }));
check("快照里的 sessionTarget 同步更新", created?.snapshot?.sessionTarget?.id === created?.id, JSON.stringify(created?.snapshot?.sessionTarget));

// ── 4. 核心断言：指令**真的落进新会话** ───────────────────────────────
//
// 这是需求 ② 唯一不能靠单测确认的事：`switchTo` 改了 `sessionId`，
// 但 `ask()` 是否真的走新绑定、prompt 是否被宿主接受，只有真机一轮才知道。
const asked = await evaluate(`(async () => {
	await globalThis.__xfvDebug.ask("跨会话验证：请回复收到");
	return JSON.stringify({ prompts: globalThis.__xfvDebug.prompts(), target: globalThis.__xfvDebug.sessionTarget() });
})()`);
const lastPrompt = Array.isArray(asked?.prompts) ? asked.prompts[asked.prompts.length - 1] : null;
check("切换后指令成功提交（prompt 被接受）", lastPrompt?.ok === true, JSON.stringify(lastPrompt));
check("提交内容正确", typeof lastPrompt?.text === "string" && lastPrompt.text.includes("跨会话验证"), JSON.stringify(lastPrompt?.text));
check("提交后目标仍是新会话（没被 ensure 悄悄换走）", asked?.target?.id === created?.id, JSON.stringify(asked?.target));

// ── 5. 切回常驻 ───────────────────────────────────────────────────────
const back = await evaluate(`(async () => {
	const ok = await globalThis.__xfvDebug.backToAssistant();
	return JSON.stringify({ ok, target: globalThis.__xfvDebug.sessionTarget(), snapshot: globalThis.__xfvDebug.snapshot() });
})()`);
check("切回常驻成功", back?.ok === true, JSON.stringify(back));
check("切回后 mode 回到 persistent", back?.target?.mode === "persistent", JSON.stringify(back?.target));
check("切回后绑定常驻会话", back?.target?.id === "session-voice-assistant-root", JSON.stringify(back?.target));
check("切回后 pinnedId 已清空", back?.target?.pinnedId === null, JSON.stringify(back?.target?.pinnedId));

// 切回之后再提交一次：确认没有残留状态把指令继续发去旧目标。
const askedHome = await evaluate(`(async () => {
	await globalThis.__xfvDebug.ask("跨会话验证：已回到常驻");
	return JSON.stringify({ prompts: globalThis.__xfvDebug.prompts(), target: globalThis.__xfvDebug.sessionTarget() });
})()`);
const homePrompt = Array.isArray(askedHome?.prompts) ? askedHome.prompts[askedHome.prompts.length - 1] : null;
check("切回后指令仍能提交", homePrompt?.ok === true, JSON.stringify(homePrompt));
check("切回后目标确为常驻", askedHome?.target?.id === "session-voice-assistant-root", JSON.stringify(askedHome?.target));

// ── 6. 切到不存在的会话必须优雅失败（不能把用户留在无目标状态）────────
const bogus = await evaluate(`(async () => {
	const ok = await globalThis.__xfvDebug.switchSession("session-does-not-exist-xyz");
	return JSON.stringify({ ok, target: globalThis.__xfvDebug.sessionTarget() });
})()`);
check("切到不存在的会话返回 false", bogus?.ok === false, JSON.stringify(bogus));
check("失败后仍绑定常驻（没被留在无目标状态）", bogus?.target?.id === "session-voice-assistant-root", JSON.stringify(bogus?.target));

// ── 7. UI：面板里能看到"语音去向"与会话列表 ───────────────────────────
const ui = await evaluate(`JSON.stringify((() => {
	const orb = document.querySelector(".xfv-orb");
	if (orb === null) return { error: "no-orb" };
	// 长按打开面板（右键等价）。
	orb.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
	return { opened: true };
})())`);
await sleep(600);
const panel = await evaluate(`JSON.stringify((() => {
	const text = document.querySelector(".xfv-panel")?.innerText ?? "";
	const root = document.querySelector(".xfv-root");
	return {
		panelText: text.slice(0, 400),
		hasTargetRow: text.includes("语音去向"),
		hasSwitchBtn: text.includes("切换会话"),
		hasNewBtn: text.includes("新建会话"),
		hasLabelRow: text.includes("常驻会话标注"),
		hasMemoryRow: text.includes("全局记忆"),
		classes: [...(root?.querySelectorAll('[class*="xfv"]') ?? [])].map((n) => n.className).slice(0, 12),
	};
})())`);
check("面板已打开", panel?.panelText?.length > 0, JSON.stringify(ui));
check("面板有「语音去向」行", panel?.hasTargetRow === true, String(panel?.panelText).slice(0, 200));
check("面板有「切换会话」按钮", panel?.hasSwitchBtn === true, String(panel?.panelText).slice(0, 200));
check("面板有「新建会话」按钮", panel?.hasNewBtn === true, String(panel?.panelText).slice(0, 200));
check("面板有「常驻会话标注」行（需求①）", panel?.hasLabelRow === true, String(panel?.panelText).slice(0, 200));
check("面板有「全局记忆」行（需求①）", panel?.hasMemoryRow === true, String(panel?.panelText).slice(0, 200));

// 展开列表并确认渲染出了可点的条目。
const expanded = await evaluate(`JSON.stringify((() => {
	const buttons = [...document.querySelectorAll(".xfv-panel .xfv-btn")];
	const toggle = buttons.find((b) => (b.textContent ?? "").includes("切换会话"));
	if (toggle === undefined) return { error: "no-toggle" };
	toggle.click();
	return { clicked: true };
})())`);
await sleep(1800);
const listUi = await evaluate(`JSON.stringify((() => {
	const items = [...document.querySelectorAll(".xfv-session-item")];
	return {
		count: items.length,
		texts: items.slice(0, 6).map((n) => (n.innerText ?? "").replace(/\\n/g, " | ").slice(0, 80)),
		hasCurrent: items.some((n) => n.getAttribute("data-current") === "true"),
	};
})())`);
check("切换列表渲染出条目", listUi?.count > 0, JSON.stringify(expanded) + " " + JSON.stringify(listUi));
check("列表里标记了当前会话", listUi?.hasCurrent === true, JSON.stringify(listUi?.texts));

// ── 8. 控制台必须干净（跨会话代码不能引入异常）──────────────────────
//
// 排除三类**预期内**的噪声，否则断言会被自己的测试用例带偏：
//   * favicon / 401 这类与插件无关的资源噪声；
//   * 第 6 节**故意**切到不存在会话时，插件自己 warn 的那条
//     （"会话准备失败 … unknown session"）—— 那是被测行为本身，
//     不是缺陷。它反而是"失败被如实报告"的证据。
const noisy = consoleEvents.filter(
	(line) =>
		!/favicon|Failed to load resource.*401|net::ERR_/.test(line) &&
		!/unknown session session-does-not-exist-xyz/.test(line) &&
		// `[deepseek-account] account read failed` —— **账号服务**的错误，
		// 在无登录态的本地实例上偶发。判据：它同时出现在
		// `probe-local-ears.mjs`（只读探针，根本不碰会话切换）里 ⇒ 与本插件无关。
		// 不过滤的话它会随机把这一项染红，看起来像"跨会话流程引入了异常"。
		!/deepseek-account|account read failed/.test(line),
);
check("跨会话流程没有引入控制台异常", noisy.length === 0, noisy.slice(0, 4).join(" ;; "));
// 反过来也要确认：那条预期的失败提示**确实**出现了（失败没被静默吞掉）。
check("切到不存在会话时如实报了错（不是静默失败）",
	consoleEvents.some((line) => /unknown session session-does-not-exist-xyz/.test(line)),
	consoleEvents.length === 0 ? "(无任何控制台输出)" : "未出现预期的失败提示");

console.log("\n=== 断言 ===");
for (const line of results) console.log(line);
if (consoleEvents.length > 0) {
	console.log("\n=== 控制台（error/warning）===");
	for (const line of consoleEvents.slice(0, 12)) console.log(line);
}
console.log(`\n${failures.length === 0 ? "全部通过" : `${failures.length} 项失败`}`);

socket.close();
chrome.kill();
await sleep(300);
try {
	rmSync(profileDir, { recursive: true, force: true });
} catch {
	// 清理失败无所谓。
}
process.exitCode = failures.length === 0 ? 0 : 1;
