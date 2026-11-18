/**
 * 真浏览器验证：需求② 的播报账本**跨刷新**真的记住了位置。
 *
 * ## 为什么必须在真浏览器里验，而不是靠单测
 *
 * 单测用的是内存里的假存储（`makeStore()`）。本需求的**全部价值**在于
 * "水位落到了 `localStorage`、刷新后还读得回来" —— 这一步只有真浏览器
 * 才能证。单测全绿而真机不生效的典型原因有三个，都在这一层：
 *
 *   1. `localStorage` 取不到（本插件此前**完全不用** localStorage，
 *      `resolveStorage` 的兜底路径从没在真机上走过）；
 *   2. 写进去了但 scope 不对（键按 `config.agent.sessionId` 分作用域，
 *      sessionId 拿不到时会退化成 `"default"` —— 那样刷新后**换了个键**，
 *      等于没记）；
 *   3. 代码根本没进产物（`src/client/**` 改完忘了 `node build.mjs`）。
 *
 * ## 怎么做到无竞态
 *
 * 最直觉的写法是"灌一个水位 → 刷新 → 读回来"。但那会和**轮询抢跑**：
 * 页面一加载 `startReportPolling()` 就跑，`advance(服务端游标)` 会把我
 * 灌进去的值覆盖掉（服务端游标≈当前时刻，比我灌的大），读回来时已经
 * 分不清"读到了存储"还是"被轮询改了"。
 *
 * 所以两条断言都刻意避开这个竞态：
 *
 *   - **已播 key**：只增不减，轮询绝不碰它。灌一个 key 进存储 → 刷新 →
 *     它还在 ⟺ 真的从存储读回来了。
 *   - **水位**：灌一个**略微超前**的值（`now + 60s`）。`advance` 只前进
 *     不后退，服务端游标（≈`now`）比它小 → 轮询不会改它。它若还能读到，
 *     就只可能来自存储。同时它落在 `CURSOR_FUTURE_TOLERANCE_MS`（5 分钟）
 *     之内，不会被"未来游标重置"误杀。
 *
 * 用法：`node tools/cdp-ledger-probe.mjs <url>`
 *   或 `node tools/run-live.mjs cdp-ledger-probe.mjs`
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9334;

const first = process.argv[2];
const url =
	typeof first === "string" && /^https?:\/\//i.test(first)
		? first
		: typeof process.env.DSH_TOKEN === "string" && process.env.DSH_TOKEN !== ""
			? `http://127.0.0.1:3080/?token=${process.env.DSH_TOKEN}`
			: undefined;

if (url === undefined) {
	console.error("用法: node tools/cdp-ledger-probe.mjs <url>");
	console.error("  或: node tools/run-live.mjs cdp-ledger-probe.mjs   （自动用 DSH_TOKEN 拼 URL）");
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail) => {
	const pass = Boolean(ok);
	if (!pass) failures.push({ name, detail });
	console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || detail === undefined ? "" : ` → ${detail}`}`);
};

const profileDir = mkdtempSync(join(tmpdir(), "dsh-ledger-"));
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

async function target() {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
			const list = await response.json();
			const page = list.find((item) => item.type === "page");
			if (page !== undefined) return page;
		} catch {
			// 端口还没起，继续等。
		}
		await sleep(200);
	}
	throw new Error("Chrome 调试端口未就绪");
}

const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
const consoleEvents = [];

function send(method, params = {}) {
	const id = nextId;
	nextId += 1;
	socket.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve) => pending.set(id, resolve));
}

socket.addEventListener("message", (event) => {
	const message = JSON.parse(event.data);
	if (message.id !== undefined) {
		pending.get(message.id)?.(message.result ?? message.error);
		pending.delete(message.id);
		return;
	}
	if (message.method === "Runtime.exceptionThrown") {
		consoleEvents.push({ kind: "exception", text: message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text });
	}
	if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
		consoleEvents.push({ kind: "console.error", text: message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(" ") });
	}
});

await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
await send("Runtime.enable");
await send("Page.enable");

/** 求值一个表达式并解析返回值（表达式须自行 `JSON.stringify`）。 */
async function evaluate(expression) {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result?.exceptionDetails !== undefined) {
		throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluate 抛错");
	}
	const value = result?.result?.value;
	if (typeof value !== "string") return value ?? null;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/** 等调试钩子就位（插件异步激活，且有历史水合）。 */
async function waitForHook(seconds = 60) {
	const deadline = Date.now() + seconds * 1000;
	while (Date.now() < deadline) {
		if ((await evaluate(`typeof globalThis.__xfvDebug?.playback === "function"`)) === true) return true;
		await sleep(1000);
	}
	return false;
}

/** 读一次账本自省快照（`ledger` 是 `snapshot()` 的返回）。 */
const readPlayback = () => evaluate(`JSON.stringify(globalThis.__xfvDebug?.playback?.() ?? null)`);

console.log(`导航到 ${url.replace(/token=[^&]+/, "token=***")}`);
await send("Page.navigate", { url });
const hooked = await waitForHook();
check("客户端调试钩子已就位（插件确实加载了）", hooked, hooked ? undefined : "60s 内没等到 __xfvDebug.playback");
if (!hooked) {
	chrome.kill();
	process.exit(1);
}

// ── 1. 先清掉残留，从干净状态开始 ────────────────────────────────────
await evaluate(`(() => { globalThis.__xfvDebug.resetPlayback?.(); return JSON.stringify(true); })()`);
await sleep(500);

const fresh = await readPlayback();
const scope = fresh?.ledger?.scope ?? "";
console.log("账本 scope:", JSON.stringify(scope));
console.log("初始账本:", JSON.stringify(fresh?.ledger));

check("账本用的是持久化存储（不是内存兜底）", fresh?.ledger?.persistent === true, JSON.stringify(fresh?.ledger));
// 这条是"scope 明明拿得到 sessionId 却退化成 default"的探测器 —— 真机上
// 一旦退化，刷新后就是换了个存储键，用户每开一次页面都会被重念一遍。
check(
	"账本 scope 是真实 sessionId（不是退化默认值）",
	typeof scope === "string" && scope !== "" && scope !== "default" && /^session-/.test(scope),
	JSON.stringify(scope),
);

// ── 2. 灌一份账本进 localStorage（模拟"助手已经播过 job-probe-1"）─────
//
// 注意：**直接写 localStorage**，不经过插件 —— 因为这正是要验的契约
// （插件换个进程/刷新后能不能把上次写的读回来）。写入值刻意让水位
// 略微超前（见文件头"怎么做到无竞态"）。
const stamp = await evaluate(`(() => {
	const scope = globalThis.__xfvDebug.playback()?.ledger?.scope ?? "default";
	const key = "xfv:v1:played:" + scope;
	const cursor = Date.now() + 60000;
	const payload = { cursor, keys: ["report:job-probe-1", "question:call-probe-1"] };
	globalThis.localStorage.setItem(key, JSON.stringify(payload));
	return JSON.stringify({ key, cursor, wrote: globalThis.localStorage.getItem(key) !== null });
})()`);
check("能写入账本存储键", stamp?.wrote === true, JSON.stringify(stamp));

// ── 3. 真刷新（Page.reload，不是重建 JS 对象）─────────────────────────
await send("Page.reload", { ignoreCache: false });
const hookedAgain = await waitForHook();
check("刷新后调试钩子仍在", hookedAgain === true);

// 稍等一轮轮询，确认"轮询不会把灌进去的值冲掉"（advance 只前进不后退）。
await sleep(3000);
const after = await readPlayback();
console.log("刷新后账本:", JSON.stringify(after?.ledger));

// 断言 ①：已播 key 从存储读回 —— **这就是需求②的本体**。
check(
	"刷新后已播 key 从存储读回（同一内容不会再念一遍）",
	Array.isArray(after?.ledger?.keys) && after.ledger.keys.includes("report:job-probe-1"),
	JSON.stringify(after?.ledger?.keys),
);
check(
	"刷新后已播的提问 key 也读回",
	Array.isArray(after?.ledger?.keys) && after.ledger.keys.includes("question:call-probe-1"),
	JSON.stringify(after?.ledger?.keys),
);
// 断言 ②：超前水位没被轮询冲掉 ⟺ 它确实来自存储（见文件头）。
check(
	"刷新后水位从存储读回（没被轮询重置）",
	Number.isFinite(after?.ledger?.cursor) && after.ledger.cursor > Date.now() + 30000,
	`cursor=${after?.ledger?.cursor}, now=${Date.now()}`,
);
check(
	"刷新后账本数量对得上",
	after?.ledger?.size === 2,
	String(after?.ledger?.size),
);
// 断言 ③：会话 seq 水位那一路也要落盘（需求②的另一半）。
check(
	"会话 seq 水位存储可用",
	after?.seq !== null && after?.seq !== undefined && after.seq.persistent === true,
	JSON.stringify(after?.seq),
);

// ── 4. 清干净，别把探针数据留给用户 ──────────────────────────────────
const cleaned = await evaluate(`(() => {
	const snap = globalThis.__xfvDebug.resetPlayback();
	const scope = snap?.ledger?.scope ?? "default";
	return JSON.stringify({ cursor: snap?.ledger?.cursor, left: globalThis.localStorage.getItem("xfv:v1:played:" + scope) });
})()`);
check("resetPlayback 清干净（不留探针残留）", cleaned?.cursor === 0 && cleaned?.left === null, JSON.stringify(cleaned));

// ── 5. 页面不应有与插件相关的异常 ───────────────────────────────────
const errors = consoleEvents.filter((e) => e.kind === "exception" || /xfv|voice-assistant|ledger|playback/i.test(e.text));
check("页面没有与插件相关的异常", errors.length === 0, JSON.stringify(errors.slice(0, 3)));

chrome.kill();

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	for (const failure of failures) console.error(`  - ${failure.name}: ${failure.detail}`);
	process.exitCode = 1;
} else {
	console.log("\n需求② 真浏览器账本验证通过");
}
