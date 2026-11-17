/**
 * 实探：`ask_user_question` 在 legacy / timed 两种模式下，谁进 `userQuestions` 投影。
 *
 * ## 为什么要做这个
 *
 * 本插件的提问作答（`src/client/core/questions.js`）是**订阅 `userQuestions`
 * 投影旁听**的。真机 spike 里 `question()` 恒为 null，怀疑的根因是：
 * `projection.js` 的 `applyUserQuestionEvent` 对 `tool/call` 先判
 * `if (!fold.timed ...) return fold` —— 而 `timed` 由 `request/header` 里
 * 记的 **tool schema 是否声明 `timeout` 参数**决定。本机 `tool-ask-user`
 * 行无 config → `mode` 默认 `legacy` → schema 无 `timeout` → **投影恒空**。
 *
 * 这是**读源码得出的推断**，必须用真实折叠函数跑合成事件坐实 —— 本项目
 * 的教训是"读源码猜形状"已经错过多回（见 MEMORY 第十一节）。
 *
 * ## 做法
 *
 * 直接 import profile 里真实发布的 `projection.js`（不是复制品），
 * 喂三种合成事件序列，看 `foldUserQuestions` 的产出：
 *
 *   A. legacy header（无 `timeout` 属性）   → 期望 active 为空
 *   B. timed header（有 `timeout` 属性）    → 期望 active 有一条 open
 *   C. timed header + pending result        → 期望该条转 continued
 *
 * 用法：`node tools/research/probe-question-projection.mjs`
 */
const PROFILE = "C:/Users/xqz19/.dsh/profiles/node_modules";
// `projection.js` **不在包的 `exports` 映射里**（只有 `.` / `./types` / `./typert` /
// `./remote` / `./src/*` / `./locale/*.json`）→ 不能用包名子路径 import，
// 必须走**绝对路径**。它内部的 `import ... from '@deepseek-ai/dsh-session'`
// 会从它自己所在目录向上解析 node_modules，那里正是 profile 的根，能解到。
const PROJECTION_URL = new URL(`file:///${PROFILE}/@deepseek-ai/dsh-user-questions/lib/types/projection.js`);

let projection;
try {
	projection = await import(PROJECTION_URL.href);
} catch (error) {
	console.error("导入真实 projection.js 失败:", error.message);
	console.error("（路径:", PROJECTION_URL.href, "）");
	process.exit(1);
}

const { foldUserQuestions } = projection;
if (typeof foldUserQuestions !== "function") {
	console.error("导入成功但没有 foldUserQuestions 导出，实际导出:", Object.keys(projection));
	process.exit(1);
}

/** 造一份 ask_user_question 的 tool schema；`timed` 决定是否声明 timeout。 */
function askUserToolSchema(timed) {
	const properties = {
		questions: { type: "array", description: "Questions to ask the user." },
	};
	if (timed) properties.timeout = { type: "integer", description: "Wait seconds for the entire batch." };
	return { name: "ask_user_question", parameters: { type: "object", properties } };
}

/** ask_user_question 的调用参数。 */
const ARGUMENTS = JSON.stringify({
	questions: [
		{
			id: "open-d",
			question: "要不要现在打开 D 盘？",
			header: "确认",
			options: [{ label: "要" }, { label: "不要" }],
		},
	],
});

/** 一条 `request/header` 事件（形状按 projection.js 的读法：`data.header.tools`）。 */
function headerEvent(timed, seq) {
	return { seq, time: 1, type: "request/header", data: { header: { tools: [askUserToolSchema(timed)] } } };
}

/** 一条 `tool/call` 事件。 */
function callEvent(seq, callId) {
	return { seq, time: 2, type: "tool/call", data: { name: "ask_user_question", callId, arguments: ARGUMENTS } };
}

/** 一条 `tool/result` 事件；`pending=true` 时正文是 pending 载荷。 */
function resultEvent(seq, callId, pending) {
	const text = pending
		? JSON.stringify({ pending: true, callId, message: "no answer arrived" })
		: JSON.stringify({ answers: [{ id: "open-d", selected: ["要"] }] });
	return {
		seq,
		time: 3,
		type: "tool/result",
		data: { message: { toolCallId: callId, content: [{ type: "text", text }] } },
	};
}

function run(label, events, expectation) {
	let view;
	try {
		view = foldUserQuestions(events);
	} catch (error) {
		console.log(`${label}\n  抛错: ${error.message}\n`);
		return false;
	}
	const active = view?.active ?? [];
	const settled = view?.settled ?? [];
	const line = `active=${JSON.stringify(active.map((row) => ({ callId: row.callId, state: row.state })))} settled=${settled.length}`;
	const ok = expectation(active, settled);
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	console.log(`      ${line}`);
	return ok;
}

console.log("=== 实探：legacy vs timed 谁进 userQuestions 投影 ===\n");

const results = [];

results.push(
	run("A. legacy header（无 timeout 属性）→ 期望投影恒空", [headerEvent(false, 1), callEvent(2, "call-a")], (active) => active.length === 0),
);

results.push(
	run(
		"B. timed header（有 timeout 属性）→ 期望 1 条 open",
		[headerEvent(true, 1), callEvent(2, "call-b")],
		(active) => active.length === 1 && active[0].state === "open",
	),
);

results.push(
	run(
		"C. timed header + pending result → 期望转 continued",
		[headerEvent(true, 1), callEvent(2, "call-c"), resultEvent(3, "call-c", true)],
		(active) => active.length === 1 && active[0].state === "continued",
	),
);

results.push(
	run(
		"D. timed header + 真答案 result → 期望落 settled、active 清空",
		[headerEvent(true, 1), callEvent(2, "call-d"), resultEvent(3, "call-d", false)],
		(active, settled) => active.length === 0 && settled.length === 1,
	),
);

const passed = results.filter(Boolean).length;
console.log(`\n=== ${passed}/${results.length} 通过 ===`);
console.log(
	passed === 4
		? "结论坐实：**legacy 模式的提问不进投影**（A 恒空），只有 timed 模式才进（B/C/D）。\n本插件订阅投影旁听，因此在本机默认配置下收不到任何问题 —— 这是设计前提错误，不是接线 bug。"
		: "结论与预期不符，需要重新核对 projection.js 的读法。",
);
process.exit(passed === 4 ? 0 : 1);
