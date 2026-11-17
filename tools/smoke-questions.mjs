/**
 * 真机验证：提问旁听 + 语音作答。
 *
 * ## 为什么必须真机
 *
 * 本项目的核心教训：**类单测全绿 ≠ 接线正确**。这一层的形状全部来自
 * 实探（见 `tools/research/probe-user-questions.mjs`），而单测用的是
 * **我按实探结果造的假投影** —— 假投影的形状如果和真实投影差一层，
 * 单测照样全绿（`faceOf` 的返回类型在声明里就是 `unknown`）。
 *
 * 所以这里在真浏览器里跑，断言五件事：
 *   1. 插件与调试面在该在的地方（`__xfvDebug` 有 `feedEvent`）；
 *   2. 会话真的绑上了（`sessionTarget().mode === "persistent"`）；
 *   3. **事件流主路径真的被接线**：喂一条真实形状的 `tool/call` 进
 *      `VoiceSession.handleEvent`，问答桥的 `known` / `announced` 涨了；
 *   4. 无问题时如实报「没有可答的问题」（不会凭空作答）；
 *   5. 接线没有把控制台打脏（没有新的 error / warning）。
 *
 * ## ⚠️ 本轮架构修正：不要断言投影
 *
 * 上一版脚本断言 `questionsAttached() === true` 并声称"桥接到投影上"。
 * 那是**错的**，而且它掩盖了一个设计错误：
 *
 *   - `dsh-user-questions` 的投影对 `tool/call` **先判 `fold.timed`**
 *     （`lib/types/projection.js:209`），`timed` 取决于 tool schema 是否
 *     声明 `timeout`；
 *   - `dsh-tool-ask-user` 的 `Config.mode` **默认 `legacy`**，legacy schema
 *     不声明 `timeout` → **投影恒空**；
 *   - 本机所有 preset 都不带 config（`--dump-config` 三处实测）→ 全 legacy。
 *
 * 也就是说：**投影那条路在本机默认配置下结构上收不到任何问题**。
 * 而"桥保存了 sessionId"这种断言在投影恒空时**照样为真** —— 它测的是
 * 我自己的簿记，不是功能。这就是典型的假绿。
 *
 * 正解是读**原始会话事件流**的 `tool/call`（不受 `timed` 闸门限制），
 * 而 `VoiceSession` 本来就订阅了这条流。所以现在断言"喂一条真实事件，
 * 桥有没有认出来并播报"，这才是端到端的那一段接线。
 *
 * ## 关于"没有真的问题可以答"
 *
 * 触发一个真实的 `ask_user_question` 需要模型配合（它得决定问用户），
 * 在无头环境里不可控。**所以本脚本不假装有** —— 它用**真实形状的历史
 * 事件**（`arguments` 是 JSON 字符串、`multi_select` 下划线、真实 callId，
 * 取自 `probe-tool-call-shape.mjs` 的实探原文）驱动真实入口。
 *
 * 这比"等模型开口"更可靠：模型是否愿意调工具是概率事件，而事件形状是
 * 确定的。真实存在性另有 `probe-ask-user-logs.mjs` 坐实（盘上 26 个会话
 * 日志里真有 15 次调用）。
 *
 * 用法：`node tools/run-live.mjs smoke-questions.mjs`
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9337;
const HERE = dirname(fileURLToPath(import.meta.url));
/** 给假麦克风喂的静音文件（见 `--use-file-for-fake-audio-capture` 注释）。 */
const SILENT_WAV = join(HERE, "_silence-60s.wav");
/**
 * token 的来源，按可靠性排序：显式传入 → 常驻启动器的结构化文件 → 日志扫描。
 *
 * ## 为什么不能只读 `DSH_TOKEN`
 *
 * 本脚本最早只认环境变量，而环境变量只有 `run-live.mjs`（同进程起 DSH）
 * 会注入。用常驻启动器（`serve-dsh.mjs`）跑起来时，`DSH_TOKEN` 是空的 →
 * 脚本拼出**不带 token** 的 URL → 落到登录页 → **语音球压根没渲染**。
 *
 * 症状极具误导性：29 条断言一起挂在"语音球已渲染 / 调试面可用"上，
 * 看起来像插件整个坏了。实际是**没登上**。本项目已经因为同一类问题
 * （拿不到正确 token）在 `verify-live` 与 `smoke-turn-gate` 上各栽过一次 ——
 * 所以这里补齐同样的发现逻辑，别再让第三个脚本踩。
 */
function resolveToken() {
	const explicit = process.env.DSH_TOKEN ?? process.argv[2] ?? "";
	if (explicit !== "") return explicit;
	const serveInfo = join(HERE, "_dsh-serve.json");
	if (existsSync(serveInfo)) {
		try {
			const info = JSON.parse(readFileSync(serveInfo, "utf8"));
			if (typeof info?.token === "string" && info.token !== "") return info.token;
		} catch {
			// 半写状态，退回日志扫描。
		}
	}
	let newest = null;
	for (const dir of [HERE, "C:/Users/xqz19/WorkBuddy/DSH_dev/tools"]) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir).filter((n) => /^_dsh-(run|serve)\d*\.log$/.test(n))) {
			const path = join(dir, name);
			const stat = statSync(path);
			if (newest === null || stat.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: stat.mtimeMs };
		}
	}
	if (newest === null) return "";
	const buffer = readFileSync(newest.path);
	const text = buffer.includes(0) ? buffer.toString("utf16le") : buffer.toString("utf8");
	const match = /token=([A-Za-z0-9_-]+)/.exec(text);
	return match ? match[1] : "";
}

const token = resolveToken();
const url = token === "" ? "http://127.0.0.1:3080/" : `http://127.0.0.1:3080/?token=${token}`;

const profileDir = mkdtempSync(join(tmpdir(), "dsh-q-smoke-"));
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
const consoleEvents = [];
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
	if (payload.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(payload.params?.type)) {
		const text = (payload.params?.args ?? []).map((arg) => arg.value ?? arg.description ?? "").join(" ");
		consoleEvents.push(`[${payload.params.type}] ${text}`);
	}
	if (payload.method === "Runtime.exceptionThrown") {
		consoleEvents.push(`[exception] ${payload.params?.exceptionDetails?.text ?? ""}`);
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

async function evaluate(expression) {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result?.result?.exceptionDetails !== undefined) {
		return { __error: String(result.result.exceptionDetails.text ?? "eval-error") };
	}
	return result?.result?.result?.value ?? null;
}

/**
 * 求值并把结果 JSON 化（避免 CDP 对复杂对象 `returnByValue` 丢掉嵌套字段）。
 *
 * ⚠️ 必须**先 await 再 stringify**：写成 `JSON.stringify(promise)` 会得到
 * `"{}"`（Promise 没有可枚举自有属性）—— 这里的表达式常带 `.then(...)`
 * 或本身就是 async，踩过一次（症状是断言读到 `undefined` 而非假值）。
 * @param expression - 表达式（返回可 JSON 化的值，或它的 Promise）。
 * @returns 解析后的值，或 `{ __error }`。
 */
async function evaluateJson(expression) {
	const raw = await evaluate(`(async () => JSON.stringify(await (${expression})))()`);
	if (raw !== null && typeof raw === "object" && "__error" in raw) return raw;
	if (typeof raw !== "string") return null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

const results = [];
const failures = [];
function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	results.push(`${ok ? "ok  " : "FAIL"} ${name}`);
	if (!ok) failures.push(`${name} → 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
/** 数值型断言（`>=`）；用于"计数涨了"这类不看精确值的地方。 */
function checkAtLeast(name, actual, floor) {
	const ok = typeof actual === "number" && actual >= floor;
	results.push(`${ok ? "ok  " : "FAIL"} ${name}（${actual} >= ${floor}）`);
	if (!ok) failures.push(`${name} → 期望 >= ${floor}，实际 ${JSON.stringify(actual)}`);
}

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url });
await sleep(9000);

// ── 一、插件与调试面在不在 ──────────────────────────────────────────
check("语音球已渲染", await evaluate(`document.querySelector('.xfv-orb') !== null`), true);
check("调试面可用", await evaluate(`typeof globalThis.__xfvDebug === 'object'`), true);
for (const name of ["question", "questionsAttached", "questionBridge", "feedEvent", "answerQuestion", "answerWith", "lastAnswerAttempt", "clearQuestion"]) {
	check(`调试面暴露 ${name}()`, await evaluate(`typeof globalThis.__xfvDebug?.${name} === 'function'`), true);
}

// ── 二、绑上会话（`ensure()` 是懒的：不先跑一轮，会话根本没绑） ──────
// `ask()` 会把会话真正绑上（`ensure()` 在 `runCommand` 路径里）。
await evaluate(`globalThis.__xfvDebug.ask('你好')`);
await sleep(6000);

const target = await evaluateJson(`globalThis.__xfvDebug.sessionTarget()`);
check("默认目标为常驻助手", target?.mode, "persistent");
check("问答桥已记下 sessionId（会话绑过了）", await evaluate(`globalThis.__xfvDebug.questionsAttached()`), true);

// ── 三、事件流主路径真的被接线（**本轮修复的核心**） ─────────────────
//
// 这是全脚本最关键的一节。它喂的是 `probe-tool-call-shape.mjs` 实探到的
// **真实形状**（不是"我以为的形状"）：
//
//   - 负载全在 `data` 下，顶层只有 type/seq/time；
//   - `arguments` 是 **JSON 字符串**（不是对象 —— 按对象读会全 null）；
//   - 模型参数写 **`multi_select`**（下划线），投影/服务层才是驼峰。
//
// 走的是真实入口 `VoiceSession.handleEvent` → `onQuestionCall` →
// `QuestionBridge.observeEvent`。**不许绕过接线层直接调 `observeEvent`** ——
// 那样测的是模块，不是接线（`TurnGate` 栽过一次）。
const before = await evaluateJson(`globalThis.__xfvDebug.questionBridge()`);

const realEvent = {
	type: "tool/call",
	seq: 999001,
	time: Date.now(),
	data: {
		turn: 1,
		step: 15,
		callId: "call_00_SMOKE_Q_0001",
		name: "ask_user_question",
		arguments: JSON.stringify({
			questions: [
				{
					id: "platform",
					header: "目标平台",
					question: "要部署到哪个平台？",
					options: [
						{ label: "Linux 服务器", description: "自备 VPS" },
						{ label: "Windows 本机", description: "本机跑" },
						{ label: "两边都要", description: "各来一份" },
					],
					multi_select: false,
				},
			],
		}),
	},
};
const fed = await evaluateJson(`globalThis.__xfvDebug.feedEvent(${JSON.stringify(realEvent)})`);
checkAtLeast("喂入真实 tool/call 后 known 增加", fed?.known, (before?.known ?? 0) + 1);
checkAtLeast("喂入真实 tool/call 后 announced 增加", fed?.announced, (before?.announced ?? 0) + 1);

// 问题内容必须真的解析出来了（`arguments` 是 JSON 字符串 + 下划线字段
// 这两点任一弄错，`question()` 都会是 null 或选项为空）。
const current = await evaluateJson(`globalThis.__xfvDebug.question()`);
check("问题的 callId 被解析出来", current?.callId, "call_00_SMOKE_Q_0001");
check("问题文本被解析出来", current?.questions?.[0]?.question, "要部署到哪个平台？");
check("下划线 multi_select 被转成驼峰", current?.questions?.[0]?.multiSelect, false);
check("三个选项都解析出来", current?.questions?.[0]?.options?.length, 3);

// 同一条事件再喂一次：**不许重复念**（重复播报是真机上最烦人的一类 bug）。
const again = await evaluateJson(`globalThis.__xfvDebug.feedEvent(${JSON.stringify(realEvent)})`);
check("同一条事件重喂不重复播报", again?.announced, fed?.announced);

// 非提问的 `tool/call` 不许被当成问题（否则任何工具调用都会念一遍）。
const otherCall = {
	type: "tool/call",
	seq: 999002,
	time: Date.now(),
	data: { turn: 1, step: 16, callId: "call_00_SMOKE_BASH", name: "bash", arguments: "{\"command\":\"ls\"}" },
};
const otherFed = await evaluateJson(`globalThis.__xfvDebug.feedEvent(${JSON.stringify(otherCall)})`);
check("别的工具调用不被当成提问", otherFed?.known, again?.known);

// ── 四、语音作答的匹配与提交链路 ────────────────────────────────────
// 现在有一个"待答问题"在手上（上一步喂出来的），可以真的走一遍匹配。
// 注意：本机是 legacy 模式，`submit` 会返回 `not-answerable`
// （DSH 的护栏：界面能答时语音插不进去）—— 那是**预期结果**，
// 脚本要验证的是"匹配命中 + 提交被尝试 + 失败如实回报"，不是"答成功"。
{
	const matched = await evaluate(`globalThis.__xfvDebug.answerQuestion('第一个')`);
	// 返回值的语义是"这句话**是不是在回答问题**"（不是"答上了没有"）：
	// 匹配上了就返回 true → 上层不再把它当新指令投给模型。若返回 false，
	// 「第一个」会变成一条新指令，模型和用户就各说各话了。
	check("说「第一个」被当成回答（不再走指令路径）", matched, true);
	// 但"返回 true"不说明提交成功 —— 用只读判定看真实结果。
	// 本机是 legacy 模式，预期 `not-answerable`（DSH 的护栏：界面能答时插不进去）。
	// 若变成 `failed`，说明 submit 那条路真的坏了（而不是被护栏挡住）。
	const attempt = await evaluateJson(`globalThis.__xfvDebug.lastAnswerAttempt()`);
	check("作答判定如实落在 not-answerable（legacy 的预期护栏）", attempt?.outcome, "not-answerable");
	check("匹配结果是「Linux 服务器」", attempt?.selected?.[0], "Linux 服务器");
}
{
	const bridge = await evaluateJson(`globalThis.__xfvDebug.questionBridge()`);
	// 提交被拒（legacy 无通道）时**不该**记进 `answered` —— 记了就等于
	// 谎报"答过了"。这是最坏情形（用户以为答了、实际没答）。
	check("提交被拒时不谎报已作答", bridge?.answered, 0);
}
{
	// 没匹配上的文本不许被当成回答（不猜）——`no-match` 与 `not-answerable`
	// 必须能区分开，否则真机上分不清"听错了"和"被护栏挡了"。
	await evaluate(`globalThis.__xfvDebug.answerQuestion('今天天气不错')`);
	const miss = await evaluateJson(`globalThis.__xfvDebug.lastAnswerAttempt()`);
	check("没匹配上的文本判定为 no-match", miss?.outcome, "no-match");
}
{
	// 没有问题时 `answerWith` 要如实报 `no-question`（不能凭空造一个答案）。
	// 这里**先把当前问题清掉**：`answerWith` 读的是快照里的 `question`，
	// 上一步喂出来的那个还在 —— 不清就测不到"无问题"这条分支。
	await evaluate(`globalThis.__xfvDebug.clearQuestion?.()`);
	const cleared = await evaluateJson(`globalThis.__xfvDebug.question()`);
	check("清掉之后确实没有待答问题", cleared, null);
	const shaped = await evaluateJson(`globalThis.__xfvDebug.answerWith(['Linux 服务器']).then((r) => r)`);
	check("无问题时作答如实报 no-question", shaped?.reason, "no-question");
	check("无问题时作答不声称成功", shaped?.ok, false);
}

// ── 五、面板显示语音应答行 ──────────────────────────────────────────
await evaluate(`(() => {
	const orb = document.querySelector('.xfv-orb');
	orb.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
	setTimeout(() => orb.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })), 700);
	return true;
})()`);
await sleep(1500);
{
	const panelText = String(await evaluate(`document.querySelector('.xfv-panel')?.innerText ?? ''`));
	check("面板已打开", panelText.length > 0, true);
	check("面板有「语音应答」行", panelText.includes("语音应答"), true);
	// 必须写明工具审批不在范围里 —— 用户会以为喊"允许"能放行工具。
	check("面板写明工具审批不归语音管", /工具审批/.test(panelText), true);
}

// ── 六、控制台净度 ──────────────────────────────────────────────────
// 接线引入的异常会在这里现形（宿主侧全绿也拦不住浏览器里的装配错）。
//
// 白名单里每一项都必须能说清"为什么它不可能由本插件引起"：
//   * `speech|microphone|NotFoundError|aborted` —— 无头浏览器没有真麦克风，
//     这些是夹具的固有噪声（见坑九）。
//   * `deepseek-account|account read failed` —— **账号服务的**错误，
//     在无登录态的本地实例上会偶发。判据：它同时出现在
//     `probe-local-ears.mjs`（只读探针，根本不碰语音接线）里 ⇒ 与本插件无关。
//     不加这条的话，它会随机把这一项断言染红，看起来像"提问接线引入了异常"。
const noisy = consoleEvents.filter((line) => !/speech|microphone|NotFoundError|aborted|deepseek-account|account read failed/i.test(line));
// 参数顺序是 `(name, actual, expected)` —— 别把两个都塞成布尔/字符串
// （写成 `check(name, noisy.length === 0, noisy.join())` 的话，一旦有噪音，
//   实际值 `false` 和期望值那串文本永远不等，报错信息还看不出是哪条噪音）。
check("提问接线没有引入控制台异常", noisy, []);

console.log("\n=== 断言 ===");
for (const line of results) console.log(line);
if (consoleEvents.length > 0) {
	console.log("\n=== 控制台（error/warning）===");
	for (const line of consoleEvents.slice(0, 10)) console.log(`  ${line}`);
}
console.log(`\n${failures.length === 0 ? "全部通过" : `${failures.length} 项失败`}`);
if (failures.length > 0) {
	console.log("\n失败明细：");
	for (const line of failures) console.log(`  - ${line}`);
}

const shot = await send("Page.captureScreenshot", { format: "png" });
if (typeof shot?.result?.data === "string") {
	const shotPath = fileURLToPath(new URL("./_question-shot.png", import.meta.url));
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
