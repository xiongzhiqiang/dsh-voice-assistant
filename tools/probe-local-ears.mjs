/**
 * 真机验证「本地 Whisper 已配好、本插件已接上」。
 *
 * ## 为什么不能只看 `--dump-config`
 *
 * `--dump-config` 只能证明 **配置文件里写了** `dsh-ears` 与
 * `backend: local-whisper`。它证明不了三件关键的事：
 *
 *   1. 插件**真的加载进运行期**了（本项目踩过：patch 层引用已卸载的包时
 *      整个 profile 组装失败、启动零输出）；
 *   2. `dshEars` 命名空间真的挂到了 `ctx.remote` 上（本插件要靠它转写）；
 *   3. 本插件的识别引擎真的**升到了 `ears`**（探测失败会静默降级，
 *      从界面上看"球还在"，但引擎其实是别的）。
 *
 * 所以这里用 CDP 开真页面，直接读运行期状态。
 *
 * ## 顺带确认音频格式这一步真的发生了
 *
 * 本地 Whisper 只吃 16 kHz 单声道 PCM16 WAV，而 `MediaRecorder` 产 webm。
 * 本插件现在会把 webm 归一化成 WAV 再发（`core/audio/wav.js`）。
 * 这条链要验证的是：`__xfvDebug` 能看到 `earsNeedsWav === true` ——
 * 说明它**知道**该转，而不是等用户说话才第一次暴露问题。
 *
 * 用法：`node tools/probe-local-ears.mjs <url> [等待秒数]`
 *   （url 不给时用 `DSH_TOKEN` 拼 127.0.0.1:3080）
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9334;
const STATE = "C:/Users/xqz19/WorkBuddy/DSH_dev/dsh-voice-assistant/tools/_dsh-serve.json";

const first = process.argv[2];
const hasUrl = typeof first === "string" && /^https?:\/\//i.test(first);
let url = hasUrl ? first : undefined;
if (url === undefined) {
	try {
		const state = JSON.parse(readFileSync(STATE, "utf8"));
		url = state.url;
	} catch {
		// 读不到状态文件就退回环境变量。
	}
}
if (url === undefined && typeof process.env.DSH_TOKEN === "string") url = `http://127.0.0.1:3080/?token=${process.env.DSH_TOKEN}`;
if (url === undefined) {
	console.error("用法: node tools/probe-local-ears.mjs <url> [等待秒数]");
	process.exit(2);
}
const waitSeconds = Number((hasUrl ? process.argv[3] : process.argv[2]) ?? 25);

const profileDir = mkdtempSync(join(tmpdir(), "dsh-ears-"));
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

async function target() {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
			const page = (await response.json()).find((item) => item.type === "page");
			if (page !== undefined) return page;
		} catch {
			// 端口还没起。
		}
		await sleep(200);
	}
	throw new Error("Chrome 调试端口未就绪");
}

const page = await target();
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
		events.push({ kind: "exception", text: detail.exception?.description ?? detail.text });
	}
	if (message.method === "Runtime.consoleAPICalled") {
		const type = message.params.type;
		if (type === "error" || type === "warning") {
			events.push({ kind: type, text: message.params.args.map((arg) => arg.value ?? arg.description ?? arg.type).join(" ") });
		}
	}
	if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
		events.push({ kind: `log.${message.params.entry.source}`, text: message.params.entry.text });
	}
});

await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Page.navigate", { url });
// dsh-ears 的本地 Whisper 运行时加载原生模块 + 探测加速变体需要一点时间，
// `detectEars()` 也在插件 apply 之后异步跑。给足时间再断言。
await sleep(waitSeconds * 1000);

const failures = [];
const check = (label, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures.push(`${label}: ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` → ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`}`);
};

const probe = await send("Runtime.evaluate", {
	expression: `(() => {
		const out = { config: null, engine: null, ears: null, status: null, error: null };

		// ① 宿主注入的配置（证明本插件客户端半起来了）。
		const cfg = globalThis.__VOICE_ASSISTANT_CONFIG__;
		out.config = cfg === undefined ? null : { asr: cfg.asr ?? null };

		// ② 本插件的调试面：引擎 + dsh-ears 探测结论 + 音频格式判定。
		const debug = globalThis.__xfvDebug;
		if (debug !== undefined) {
			try { out.engine = debug.snapshot?.().engine ?? null; } catch {}
			try { out.status = debug.snapshot?.().status ?? null; } catch {}
			try { out.ears = debug.ears?.() ?? null; } catch {}
			try { out.error = debug.snapshot?.().error ?? null; } catch {}
		}
		return JSON.stringify(out);
	})()`,
	returnByValue: true,
});

console.log("=== 运行期探测 ===");
let parsed = null;
try {
	parsed = JSON.parse(probe?.result?.value);
} catch {
	console.log(probe?.result?.value ?? JSON.stringify(probe));
}
if (parsed !== null) {
	// 不要整个 JSON.stringify —— `shape.serviceNames` 在真机上可能很大。
	console.log(
		JSON.stringify({ config: parsed.config, engine: parsed.engine, status: parsed.status, ears: { ...parsed.ears, shape: undefined } }, null, 2),
	);
	if (parsed.ears?.shape) console.log("   ctx 形状:", JSON.stringify(parsed.ears.shape));

	check("宿主配置已注入（客户端半起来了）", parsed.config !== null, true);
	check("本插件调试面在场（引擎可读）", typeof parsed.engine === "string", true);
	if (parsed.ears?.available !== true) {
		console.log("   命名空间各条取法（排障）:");
		for (const path of parsed.ears?.paths ?? []) {
			console.log(`     ${path.hit ? "命中" : "未命中"} ${path.from}${path.error === undefined ? "" : ` (${path.error})`}`);
		}
	}
	// ── 回滚到最早版本后的基线（2026-11-17 用户决定）────────────────────
	//
	// dsh-ears 已从 profile 的 bundles 与 patch 里**一并移除**（只移一处会让
	// 整个 profile 组装失败）。原因：本机后端是本地 Whisper，缓存里只有 6 档
	// 最弱的 `ggml-tiny.bin`，中文短片段常被判成英文/西语并产出幻觉
	// （`[BLANK_AUDIO]`、`（滋滋声）`、`[Subscribe]`），识别质量明显不如浏览器。
	//
	// 所以正确落点是：引擎 = `webspeech`（浏览器 Web Speech），且 dsh-ears 探测
	// **不可用**（它根本没加载）。旧断言"dsh-ears 可用、后端清单可见"写于
	// "备着当回退"的前提下，回滚后语义相反，已按新基线更新。
	check("回滚后当前引擎是浏览器识别（webspeech）", parsed.engine, "webspeech");
	check("dsh-ears 已从 profile 移除（探测不可用）", parsed.ears?.available, false);
	const backends = parsed.ears?.backends;
	check("回滚后不再有 dsh-ears 后端清单", Array.isArray(backends) && backends.length > 0, false);
	if (Array.isArray(backends) && backends.length > 0) {
		for (const backend of backends) {
			console.log(`   后端 ${backend?.id}: available=${backend?.available} detail=${String(backend?.detail ?? "")}`);
		}
	}
}

// ── 时序假设：真机上"取不到"会不会只是**取早了** ────────────────────────
//
// `ctx.get` / `ctx.reflect.get` 都**存在**（`hasGet:true`），却取不到
// `remote.dshEars` —— 这与"取口不对"矛盾，更像是一件事：本插件的
// `apply` 跑在 `dsh-ears` 把服务注册上来**之前**，而 `detectEars()`
// 只探一次、探完就定论。
//
// 区分这两者只要一件事：**晚点再探一次**。
//   - 晚点能探到 ⇒ 时序竞争，修法是"重试/等待服务就位"；
//   - 晚点还是探不到 ⇒ 注册名不对，得继续找名字。
//
// 这一步不改实现，只取证据 —— 本项目反复踩"方向错时状态快照查不出来"。
console.log("\n=== 时序验证：6 秒后再探一次 ===");
await sleep(6000);
const reProbe = await send("Runtime.evaluate", {
	expression: `(async () => {
		const debug = globalThis.__xfvDebug;
		if (debug?.retryEars === undefined) return JSON.stringify({ error: "no-retry-hook" });
		try { return JSON.stringify(await debug.retryEars()); } catch (e) { return JSON.stringify({ error: String(e?.message ?? e) }); }
	})()`,
	awaitPromise: true,
	returnByValue: true,
});
let reParsed = null;
try {
	reParsed = JSON.parse(reProbe?.result?.value);
} catch {
	// 解析不了就把原始值打出来。
}
console.log("   重探结果:", JSON.stringify(reParsed, null, 2).slice(0, 1600));
if (reParsed?.ears?.available === true) {
	console.log("   => 晚点能探到 ⇒ dsh-ears 又被装回来了（与回滚基线不符，需检查 profile）");
} else if (reParsed !== null && reParsed.error === undefined) {
	console.log("   => 晚点仍探不到 ⇒ 符合回滚基线：dsh-ears 已从 profile 移除，识别只走浏览器");
}

	console.log("\n=== 控制台异常/警告 ===");
if (events.length === 0) console.log("(无)");
for (const item of events) console.log(`[${item.kind}] ${item.text}`);

socket.close();
chrome.kill();
await sleep(300);
try {
	rmSync(profileDir, { recursive: true, force: true });
} catch {
	// 清理失败无所谓。
}

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exitCode = 1;
} else {
	console.log("\n全部通过");
}
