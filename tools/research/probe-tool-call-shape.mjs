/**
 * 实探：会话事件流里 `ask_user_question` 的 `tool/call` 事件长什么样。
 *
 * ## 为什么要做
 *
 * 已坐实：订阅 `userQuestions` 投影的方案在 **legacy 模式（本机默认）下
 * 收不到任何问题**（`projection.js` 的 `if (!fold.timed) return fold`），
 * 而盘上 15 次真实提问**全是 legacy**。
 *
 * 替代路是**读原始会话事件流的 `tool/call`** —— 那一条不受 `timed`
 * 过滤，两种模式都有。而且本插件的 `VoiceSession` 已经订阅了事件流
 * （就是现在处理 `turn/start` / `turn/end` 的那条），**不需要新增任何注册**。
 *
 * 但本项目踩过"按类型声明猜形状"的坑（MEMORY 第十一节），所以先看真值。
 * 要看的是：
 *   - `tool/call` 的 `data` 里有哪些字段（`callId` / `name` / `arguments`）
 *   - `arguments` 是**字符串**还是对象（projection.js 里 `JSON.parse` 它）
 *   - 后续 `tool/result` 的形状（判"是否 still answerable"）
 *
 * 用法：`node tools/research/probe-tool-call-shape.mjs`
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSessionLog } from "./session-log-reader.mjs";

const ROOT = "C:/Users/xqz19/.dsh/sessions";

function findLogs(dir, out = [], depth = 0) {
	if (depth > 4) return out;
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of names) {
		const full = join(dir, name);
		let stat;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		if (stat.isDirectory()) findLogs(full, out, depth + 1);
		else if (name.endsWith(".zstd")) out.push({ path: full, mtime: stat.mtimeMs });
	}
	return out;
}

/** 按事件类型分组，找含 ask_user_question 的会话。 */
function scan(path) {
	const text = readSessionLog(path);
	const events = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			// 跳过坏行。
		}
	}
	return events;
}

const logs = findLogs(ROOT).sort((a, b) => a.mtime - b.mtime);
let shown = 0;

for (const log of logs) {
	if (shown >= 2) break;
	let events;
	try {
		events = scan(log.path);
	} catch {
		continue;
	}
	const callIndex = events.findIndex((event) => event.type === "tool/call" && event.data?.name === "ask_user_question");
	if (callIndex === -1) continue;
	shown += 1;
	console.log(`\n=== ${log.path} ===`);
	const call = events[callIndex];
	console.log("\n--- tool/call 顶层键 ---");
	console.log(JSON.stringify(Object.keys(call)));
	console.log("--- tool/call.data 键 ---");
	console.log(JSON.stringify(Object.keys(call.data ?? {})));
	console.log("--- tool/call（截断 1200 字）---");
	console.log(JSON.stringify(call).slice(0, 1200));
	console.log(`--- arguments 的 typeof: ${typeof call.data?.arguments} ---`);
	if (typeof call.data?.arguments === "string") {
		try {
			const parsed = JSON.parse(call.data.arguments);
			console.log("--- arguments 解出来的键 ---");
			console.log(JSON.stringify(Object.keys(parsed)));
			console.log("--- questions[0] 的形状 ---");
			console.log(JSON.stringify(parsed.questions?.[0] ?? null));
		} catch (error) {
			console.log("arguments 不是合法 JSON:", error.message);
		}
	}
	// 找该 callId 的 tool/result。
	const callId = call.data?.callId;
	const result = events.find((event) => event.type === "tool/result" && event.data?.message?.toolCallId === callId);
	console.log("\n--- 配对的 tool/result ---");
	if (result === undefined) {
		console.log("（没找到 —— 可能这一轮没跑完）");
	} else {
		console.log("顶层键:", JSON.stringify(Object.keys(result)));
		console.log("data 键:", JSON.stringify(Object.keys(result.data ?? {})));
		console.log(JSON.stringify(result).slice(0, 1000));
	}
	// 顺便列出这个会话里出现过的所有事件类型，确认事件流确实带着这些。
	const types = new Set(events.map((event) => event.type));
	console.log("\n--- 本会话出现的事件类型 ---");
	console.log([...types].join(", "));
}

if (shown === 0) console.log("没找到任何 ask_user_question 的 tool/call。");
