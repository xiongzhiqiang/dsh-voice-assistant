/**
 * 用 Chrome DevTools Protocol 打开 DSH 前端，抓取控制台异常。
 *
 * ## 为什么不用 Playwright / Puppeteer
 *
 * 只为看几条 console 报错去装一整套浏览器驱动不值得；Node 22 自带
 * WebSocket 客户端，直接用 CDP 裸协议就够：开页面 → 收
 * `Runtime.exceptionThrown` / `Runtime.consoleAPICalled` / `Log.entryAdded`。
 *
 * 用法（两种都行）：
 *   `node tools/cdp-probe.mjs <url> [等待秒数] [spike文本]`
 *   `node tools/run-live.mjs cdp-probe.mjs`   ← 不传 url 时用 run-live 注入的
 *                                               `DSH_TOKEN` 自动拼 127.0.0.1:3080
 * 自动拼这条是必要的：run-live 是同进程起 DSH 拿 token，它的 token 只从日志
 * 里取，手工复制既慢又容易拿到早就失效的那个（见 verify-live 注释）。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;
// 第一个参数**可能是 url 也可能是等待秒数**（run-live 会原样透传后面的参数）。
// 按内容判定：形如 http(s):// 的当作 url，其余当作秒数。这样
// `run-live.mjs cdp-probe.mjs 20 "帮我列一下 D 盘"` 也能正确解析。
const first = process.argv[2];
const hasUrl = typeof first === "string" && /^https?:\/\//i.test(first);
// 没给 url 但环境里有 token（run-live 注入）→ 自己拼一个。
const url = hasUrl
	? first
	: typeof process.env.DSH_TOKEN === "string" && process.env.DSH_TOKEN !== ""
		? `http://127.0.0.1:3080/?token=${process.env.DSH_TOKEN}`
		: undefined;
const rest = process.argv.slice(hasUrl ? 3 : 2);
const waitSeconds = Number(rest[0] ?? 15);
/** 可选：端到端 spike 文本。给了就调 __xfvDebug.ask 并轮询结果。 */
const askText = rest[1];

if (url === undefined) {
	console.error("用法: node tools/cdp-probe.mjs <url> [等待秒数] [spike文本]");
	console.error("  或: node tools/run-live.mjs cdp-probe.mjs [等待秒数] [spike文本]   （自动用 DSH_TOKEN 拼 URL）");
	process.exit(2);
}

const profileDir = mkdtempSync(join(tmpdir(), "dsh-cdp-"));
const chrome = spawn(
	CHROME,
	[
		"--headless=new",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--autoplay-policy=no-user-gesture-required",
		// 给个假麦克风：这样 start() 能真正走到 getUserMedia 成功分支，
		// 而不是一上来就因为"没有设备"失败，白白漏掉后面的装配问题。
		"--use-fake-ui-for-media-stream",
		"--use-fake-device-for-media-stream",
		`--user-data-dir=${profileDir}`,
		`--remote-debugging-port=${PORT}`,
		"about:blank",
	],
	{ stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function targets() {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
			const list = await response.json();
			const page = list.find((item) => item.type === "page");
			if (page !== undefined) return page;
		} catch {
			// 端口还没起来，继续等。
		}
		await sleep(200);
	}
	throw new Error("Chrome 调试端口未就绪");
}

const page = await targets();
const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
const events = [];
let nextId = 1;

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
		const detail = message.params.exceptionDetails;
		events.push({
			at: Date.now(),
			kind: "exception",
			text: detail.exception?.description ?? detail.text,
			where: `${detail.url ?? "?"}:${detail.lineNumber ?? 0}`,
		});
	}
	// 收**所有**级别：插件的 fail() 是走 console.warn 的（见 controller.js），
	// 只盯 error 会把"界面上挂了条错误提示但控制台只有 warn"这种情形漏掉。
	if (message.method === "Runtime.consoleAPICalled") {
		const type = message.params.type;
		if (type === "error" || type === "warning") {
			events.push({
				at: Date.now(),
				kind: type === "error" ? "console.error" : "console.warn",
				text: message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(" "),
			});
		}
	}
	if (message.method === "Log.entryAdded") {
		const entry = message.params.entry;
		if (entry.level === "error") events.push({ at: Date.now(), kind: `log.${entry.source}`, text: `${entry.text} ${entry.url ?? ""}` });
	}
});

await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Page.navigate", { url });
await sleep(waitSeconds * 1000);

// 顺便把页面上的启动失败卡片文案取出来（前端把失败的条目名字直接写进 DOM）。
const probe = await send("Runtime.evaluate", {
	expression: `(() => {
		const card = document.querySelector('[data-dsh-boot]');
		const body = document.body?.innerText ?? '';
		return JSON.stringify({
			bootCard: card?.innerText ?? null,
			bodyHead: body.slice(0, 600),
			hasOrb: document.querySelector('.xfv-orb') !== null,
			// 根元素带 data-xfv="root"；球本身只有 class（没有独立 data 属性），
			// 所以判定球用 class、判定根用属性，别混。
			hasRoot: document.querySelector('[data-xfv="root"]') !== null,
			xfvNodes: document.querySelectorAll('[class*="xfv"]').length,
			xfvClasses: [...document.querySelectorAll('[class*="xfv"]')].slice(0, 6).map((node) => node.className),
			scripts: [...document.querySelectorAll('script[src]')].map((s) => s.src).slice(0, 20),
		});
	})()`,
	returnByValue: true,
});

console.log("=== DOM 探测 ===");
console.log(probe?.result?.value ?? JSON.stringify(probe));

// 点一下语音球：无头环境拿不到麦克风，点下去必然失败 —— 正好验证
// "拿不到麦克风"是显示提示，而不是抛异常把页面搞挂。
await send("Runtime.evaluate", {
	expression: `(() => { const orb = document.querySelector(".xfv-orb"); if (orb === null) return "no-orb"; orb.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); orb.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); return "clicked"; })()`,
});
await sleep(3000);
const afterClick = await send("Runtime.evaluate", {
	expression: `JSON.stringify({
		status: document.querySelector('.xfv-root')?.getAttribute('data-status') ?? null,
		text: document.querySelector('.xfv-root')?.innerText?.slice(0, 200) ?? null,
		configInjected: typeof globalThis.__VOICE_ASSISTANT_CONFIG__,
		engine: globalThis.__VOICE_ASSISTANT_CONFIG__?.asr?.engine ?? null,
		// ask **之前**的错误/提示状态：用来判定"界面上那条报错"是不是本次指令
		// 造成的。若不是（此处就已有值），说明它来自点击唤醒/会话 retain 阶段。
		errorBefore: globalThis.__xfvDebug?.snapshot?.()?.error ?? "(no-hook)",
		noticeBefore: globalThis.__xfvDebug?.snapshot?.()?.notice ?? "(no-hook)",
	})`,
	returnByValue: true,
});
console.log("=== 点击后 ===");
console.log(afterClick?.result?.value ?? JSON.stringify(afterClick));

// 端到端 spike：直接把一句指令灌进语音链路（跳过 ASR，其余全真），
// 轮询快照直到 turn 结束（answer 非空 / 状态回到非 thinking）。
if (typeof askText === "string" && askText !== "") {
	console.log(`=== 端到端（ask：${askText}）===`);
	const sent = await send("Runtime.evaluate", {
		expression: `(async () => {
			if (globalThis.__xfvDebug === undefined) return JSON.stringify({ error: "no-debug-hook" });
			await __xfvDebug.ask(${JSON.stringify(askText)});
			return "sent";
		})()`,
		awaitPromise: true,
		returnByValue: true,
	});
	console.log("提交:", sent?.result?.value ?? JSON.stringify(sent));
	const deadline = Date.now() + 90000;
	for (;;) {
		await sleep(2500);
		const poll = await send("Runtime.evaluate", {
			expression: `JSON.stringify(globalThis.__xfvDebug?.snapshot?.() ?? null)`,
			returnByValue: true,
		});
		const snap = poll?.result?.value;
		let parsed = null;
		try {
			parsed = JSON.parse(snap);
		} catch {
			console.log("snapshot:", snap);
		}
		if (parsed !== null) {
			console.log(
				`  [${parsed.status}] session=${parsed.sessionId} answer=${parsed.answer.slice(0, 120)} partial=${parsed.partial.slice(0, 60)} notice=${parsed.notice} error=${parsed.error}`,
			);
			// 只有真正拿到回答、或整个链路终止（off/sleeping）才退出；
			// standby 可能只是"润色还没回来"，提前退出会误判成失败。
			if (parsed.answer !== "" && parsed.status !== "thinking") break;
			if (parsed.status === "sleeping" || parsed.status === "off") break;
			if (parsed.error !== "" && parsed.status !== "thinking") break;
		}
		if (Date.now() > deadline) {
			console.log("  （超时：90s 内没等到回答）");
			break;
		}
	}
	// 把最近的事件打出来，空 turn / 报错一眼可见。
	const eventsOut = await send("Runtime.evaluate", {
		expression: `JSON.stringify(globalThis.__xfvDebug?.events?.() ?? [])`,
		returnByValue: true,
	});
	console.log("=== 会话事件（尾部）===");
	try {
		for (const line of JSON.parse(eventsOut.result.value)) console.log("  " + line);
	} catch {
		console.log(eventsOut?.result?.value ?? "(不可用)");
	}

	// 两条诊断线：错误的调用来源 + prompt 的原始返回。
	// 「回答念出来了、界面却同时挂着报错」这类矛盾态只有靠这两条才能定死。
	const diag = await send("Runtime.evaluate", {
		expression: `JSON.stringify({
			fails: globalThis.__xfvDebug?.fails?.() ?? null,
			prompts: globalThis.__xfvDebug?.prompts?.() ?? null,
			hydration: globalThis.__xfvDebug?.hydration?.() ?? null,
			rawWindow: globalThis.__xfvDebug?.rawWindow?.(80) ?? null,
			// 轮次门槛与回声抑制：排障"说了半天没反应"（提交太早/太晚）
			// 与"助手自说自话"（回声没拦住）这两类问题。
			turn: globalThis.__xfvDebug?.turn?.() ?? null,
			echo: globalThis.__xfvDebug?.echo?.() ?? null,
		})`,
		returnByValue: true,
	});
	console.log("=== 诊断（错误来源 / 提交原始返回 / 水合 / 轮次 / 回声）===");
	try {
		const parsed = JSON.parse(diag.result.value);
		console.log("  提交记录:", JSON.stringify(parsed.prompts, null, 2).replace(/\n/g, "\n  "));
		console.log("  水合:", JSON.stringify(parsed.hydration, null, 2).replace(/\n/g, "\n  "));
		console.log("  轮次门槛:", JSON.stringify(parsed.turn, null, 2).replace(/\n/g, "\n  "));
		console.log("  回声抑制:", JSON.stringify(parsed.echo, null, 2).replace(/\n/g, "\n  "));
		console.log(
			"  错误来源:",
			JSON.stringify(parsed.fails?.map?.((f) => ({ at: f.at, status: f.status, message: f.message, from: String(f.from).slice(0, 200) })) ?? null, null, 2).replace(
				/\n/g,
				"\n  ",
			),
		);
		console.log("  窗口原始条目:", JSON.stringify(parsed.rawWindow?.slice?.(-24) ?? null));
	} catch {
		console.log(diag?.result?.value ?? "(不可用)");
	}
}
console.log("=== 事件 ===");
if (events.length === 0) console.log("(无异常/错误)");
for (const item of events) console.log(`[${item.kind}] ${item.text}${item.where === undefined ? "" : ` @ ${item.where}`}`);

// 存一张截图，肉眼看一眼浮层位置是否正常（写盘交给调用方决定要不要看）。
const shot = await send("Page.captureScreenshot", { format: "png" });
if (typeof shot?.data === "string") {
	const shotPath = fileURLToPath(new URL("./_shot.png", import.meta.url));
	writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
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
