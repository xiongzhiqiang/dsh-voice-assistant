/**
 * 调研：`userQuestions` 投影与提问作答 RPC 的**真实运行时形状**。
 *
 * ## 为什么必须实探
 *
 * 本项目的血泪教训（见 .workbuddy/memory/MEMORY.md）：
 * `@deepseek-ai/dsh-api-session-controller` 等包的绑定面在本机 profile 里
 * **没有实体目录**（被打进前端 bundle），类型声明读得到、运行时形状只能实探。
 * 形状猜错的表现是**静默失效** —— `listTargets()` 曾经因此"永远返回空列表
 * 且不报错"。
 *
 * 本轮要做的是「提问旁听 + 语音作答」，依赖三件事的形状，全都没写在
 * client-safe 类型里（`faceOf(key)` 的返回类型就是 `unknown`）：
 *   1. `binding.session.projections.faceOf("userQuestions")` 返回什么；
 *   2. `.getSnapshot()` 出来的是 `{ active, settled }` 还是别的层数；
 *   3. `ctx.remote.userQuestions.answer(...)` 在不在、签名几个参数。
 *
 * ## 用法
 *
 *   node tools/run-live.mjs research/probe-user-questions.mjs
 *
 * （必须走 run-live：本机每次 Bash 调用结束会收掉整棵进程树，
 *   见 tools/run-live.mjs 顶部注释。）
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9336;
const token = process.env.DSH_TOKEN ?? "";
const url = token === "" ? "http://127.0.0.1:3080/" : `http://127.0.0.1:3080/?token=${token}`;

const profileDir = mkdtempSync(join(tmpdir(), "dsh-probe-uq-"));
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

async function findPage() {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
			const list = await response.json();
			const page = list.find((item) => item.type === "page");
			if (page !== undefined) return page;
		} catch {
			// 端口未就绪。
		}
		await sleep(200);
	}
	throw new Error("Chrome 调试端口未就绪");
}

const page = await findPage();
const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;

await new Promise((resolve, reject) => {
	socket.addEventListener("open", resolve, { once: true });
	socket.addEventListener("error", reject, { once: true });
});
socket.addEventListener("message", (event) => {
	let payload;
	try {
		payload = JSON.parse(event.data);
	} catch {
		return;
	}
	if (payload.id !== undefined && pending.has(payload.id)) {
		pending.get(payload.id)(payload);
		pending.delete(payload.id);
	}
});

function send(method, params = {}) {
	const id = nextId;
	nextId += 1;
	return new Promise((resolve) => {
		pending.set(id, resolve);
		socket.send(JSON.stringify({ id, method, params }));
	});
}

/** 在页面里求值（awaitPromise 让 async 表达式也能用）。 */
async function evaluate(expression) {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result?.result?.exceptionDetails !== undefined) {
		return { __error: String(result.result.exceptionDetails.text ?? "eval-error") };
	}
	return result?.result?.result?.value ?? null;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url });
await sleep(9000);

console.log("=== 一、页面里有哪些 DSH 客户端服务（全局线索） ===");
console.log(
	JSON.stringify(
		await evaluate(`(() => {
			const keys = Object.keys(globalThis).filter((k) => /^(__|dsh|DSH)/i.test(k));
			return {
				globals: keys.slice(0, 40),
				hasConfig: typeof globalThis.__VOICE_ASSISTANT_CONFIG__ === "object",
				hasXfvDebug: typeof globalThis.__xfvDebug === "object",
				xfvKeys: typeof globalThis.__xfvDebug === "object" ? Object.keys(globalThis.__xfvDebug) : [],
			};
		})()`),
		null,
		1,
	),
);

console.log("\n=== 二、能否从插件调试面摸到 ctx / sessions / remote ===");
// `__xfvDebug` 是本插件留的排障面。它的方法闭包里握着 controller，
// 而 controller 握着 ctx。这里不直接摸私有字段（易碎），而是问一个问题：
// 插件的 ctx 上有没有 `remote.userQuestions`。
console.log(
	JSON.stringify(
		await evaluate(`(() => {
			// 从插件的 ctx 出发：ctx 挂在 controller 上，而 controller 可从
			// 调试面的 sessionTarget 反推（那条路不碰私有字段）。
			const out = {};
			out.debugKeys = typeof globalThis.__xfvDebug === "object" ? Object.keys(globalThis.__xfvDebug) : [];
			return out;
		})()`),
		null,
		1,
	),
);

console.log("\n=== 三、直接问 DSH 前端：会话绑定的 projections 面 ===");
// 前端把 `sessions` 服务挂在插件 ctx 上。本探针没法直接拿 ctx，
// 但可以从**官方 UI 的行为**反推：官方提问 UI 是否注册了接管。
// 更直接的做法是看 DOM 里有没有问题卡（说明 UI 活着）。
console.log(
	JSON.stringify(
		await evaluate(`(() => {
			return {
				// 官方提问 UI 的槽位产物：有问题时会出现对话里的问题卡。
				questionCardNodes: document.querySelectorAll('[class*="question"], [data-question]').length,
				composerNodes: document.querySelectorAll('[class*="composer"]').length,
				bodyLen: (document.body?.innerText ?? "").length,
				// 本插件自己的浮层（确认探针跑在正确的页面上）。
				hasOrb: document.querySelector('.xfv-orb') !== null,
			};
		})()`),
		null,
		1,
	),
);

console.log("\n=== 四、用一次真实的 ask 触发链路，读投影 ===");
// 关键实验：让常驻 agent 问一个问题，然后立刻读 `userQuestions` 投影，
// 看形状。用 `__xfvDebug.ask` 把话投进会话，模型会（大概率）调用
// ask_user_question —— 但那需要模型配合，不确定。
//
// 更可靠：直接在这个页面上**检查 remote 面是否存在**。remote 是 DSH 的
// 客户端 Remote 运行时，挂在插件 ctx 上；官方 UI 用 `ctx.remote.$on`。
// 本探针能做的确定性检查是：看 bundle 里有没有暴露 remote 命名空间。
console.log(
	JSON.stringify(
		await evaluate(`(() => {
			// 前端把 Remote 的 namespace 服务名投影在 window 上时会有痕迹。
			const candidates = Object.keys(globalThis).filter((k) => /remote|typert|gateway/i.test(k));
			return { remoteish: candidates, total: candidates.length };
		})()`),
		null,
		1,
	),
);

console.log("\n=== 五、静态取证：bundle 里 userQuestions 的调用形状 ===");
// 运行时拿不到 ctx，就回到**代码取证**：拉批量包，看官方提问 UI 调用
// `answer` / `faceOf` 的实参形状 —— 这是唯一真源（类型里是 `unknown`）。
//
// 取包手法与 verify-live 一致：从**首页 HTML** 里正则提 `href="plugins/??..."`，
// 再用 `?token=` 换来的 cookie 拉。在浏览器里 fetch 会因 cookie 域/凭据
// 问题拿不到，所以这一步不经 Chrome，直接在 Node 侧做。
const BASE = "http://127.0.0.1:3080";

async function fetchBundle() {
	// 换 cookie。注意 `redirect:"manual"` 下 303 的响应头里才有 Set-Cookie。
	const handshake = await fetch(`${BASE}/?token=${token}`, { redirect: "manual" });
	const cookie = (handshake.headers?.getSetCookie?.() ?? []).map((entry) => entry.split(";")[0]).join("; ");
	const authHeaders = {
		cookie,
		...(token === "" ? {} : { authorization: `Bearer ${token}` }),
	};
	const home = await fetch(`${BASE}/`, { headers: authHeaders });
	const html = await home.text();
	// 批量包 URL 有两种写法：`href="plugins/??..."`（modulepreload）和
	// `src="..."`；统统抓。
	const hrefs = [...html.matchAll(/(?:href|src)="((?:\.\/)?plugins\/\?\?[^"]+)"/g)].map((match) =>
		// HTML 里 `&` 会被转义成 `&amp;`（`...client.js&amp;rev=xxx`）——
		// 不还原就必然 404，而原因看起来像"鉴权坏了"。
		match[1].replace(/^\.\//, "").replace(/&amp;/g, "&"),
	);
	console.log(`首页 ${html.length} 字节，批量包 URL ${hrefs.length} 条；cookie ${cookie === "" ? "空" : "已拿到"}`);
	if (hrefs.length === 0) return null;
	// 逐个试，取第一个 200 且体积合理的（合并包里含全部插件，一定 >100KB）。
	// **关键**：不同批量包装的是不同插件，官方提问 UI 不在第一个包里
	// （实测第一个包 `userQuestions` 只出现 2 次、`attachWait` 0 次）。
	// 所以要把所有包都拉下来、哪个含 `attachWait` 就用哪个。
	const wanting = process.argv[2] ?? "attachWait";
	for (const href of hrefs) {
		const res = await fetch(`${BASE}/${href}`, { headers: authHeaders });
		const body = await res.text();
		const hits = body.split(wanting).length - 1;
		console.log(`  ${href.slice(0, 52)}… → ${res.status}，${body.length} 字节，含「${wanting}」${hits} 次`);
		if (res.ok && body.length > 100_000 && hits > 0) return body;
	}
	// 一个都没含：返回最大的那个（便于看整体情况）。
	return null;
}

const bundle = await fetchBundle();
if (bundle === null) {
	console.log("取包失败，跳过静态取证");
} else {
	const marks = [
		"userQuestions.answer",
		"userQuestions",
		"attachWait",
		'faceOf("userQuestions")',
		"user-questions/request",
		"approval/request",
		"ask_user_question",
		"answers",
	];
	console.log("包体积:", bundle.length);
	for (const mark of marks) {
		// 出现次数比"命中/未命中"更有信息量：能区分"完全不在包里"和
		// "只在别处出现一次"（前者说明包选错了）。
		const count = bundle.split(mark).length - 1;
		console.log(`  ${mark} → ${count} 次`);
	}
	// 把包落盘：7MB 的文本在终端里没法细看，落盘后可以用 Grep 精确定位。
	// 产物名以 `_` 开头，属于运行产物（见 README 的文件地图）。
	try {
		writeFileSync(fileURLToPath(new URL("../../_probe-bundle.js", import.meta.url)), bundle);
		console.log("已落盘: dsh-voice-assistant/_probe-bundle.js（供 Grep 精查）");
	} catch (error) {
		console.log("落盘失败:", String(error?.message ?? error));
	}
	// 把 attachWait 附近的原文截出来 —— 这是实参形状的唯一真源。
	const atWait = bundle.indexOf("attachWait");
	if (atWait !== -1) console.log("\nattachWait 调用点原文:\n" + bundle.slice(Math.max(0, atWait - 420), atWait + 300));
	// `answer` 的调用点要精确定位到 `userQuestions.answer`，不能搜裸 `answer`
	// （满屏都是 `this.answer`、`store.answer`）。
	const atAnswer = bundle.indexOf("userQuestions.answer");
	if (atAnswer !== -1) {
		console.log("\nuserQuestions.answer 调用点原文:\n" + bundle.slice(Math.max(0, atAnswer - 620), atAnswer + 320));
	} else {
		console.log("\n未找到字面 `userQuestions.answer`（可能是解构后调用，见落盘文件）");
	}
}

socket.close();
chrome.kill();
await sleep(300);
try {
	rmSync(profileDir, { recursive: true, force: true });
} catch {
	// 清理失败无所谓。
}
