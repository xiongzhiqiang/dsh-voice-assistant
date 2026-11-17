/**
 * 实探：逐条读盘上的会话日志，找 `ask_user_question` 的调用记录。
 *
 * ## 为什么要做
 *
 * `cdp-probe.mjs` 的端到端 spike 想让模型真的调一次 `ask_user_question`，
 * 但结果里看不到提问落到快照上。有两种可能：
 *
 *   A. 模型压根没调（提示词不够硬）—— 那么"没触发"是 spike 的问题；
 *   B. 模型调了，但投影没收到 —— 那么是**代码的结构性问题**。
 *
 * 区别很大：A 只需改 spike，B 要改实现。所以直接读**盘上的会话日志**
 * （真值来源，不受浏览器状态影响）来定性。
 *
 * ## 日志格式的坑
 *
 * `session.v4.jsonl.zstd` 是**多帧拼接**的 zstd，不是整文件一个流。
 * 直接 `zstdDecompressSync` 只解出第一帧 —— 症状是 164KB 的文件解出
 * 171 字节、只有一条 `session` 事件，于是"什么都没找到"。见
 * `session-log-reader.mjs` 的说明。
 *
 * 用法：`node tools/research/probe-ask-user-logs.mjs`
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSessionLog } from "./session-log-reader.mjs";

const ROOT = "C:/Users/xqz19/.dsh/sessions";

/** 递归找所有 `*.zstd` 会话日志（**不能用 withFileTypes**：目录可能是 junction）。 */
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
		else if (name.endsWith(".zstd")) out.push({ path: full, mtime: stat.mtimeMs, size: stat.size });
	}
	return out;
}

const logs = findLogs(ROOT).sort((a, b) => b.mtime - a.mtime);
console.log(`找到 ${logs.length} 个会话日志\n`);

let totalCalls = 0;
let totalHeaders = 0;
const interesting = [];

for (const log of logs) {
	let text;
	try {
		text = readSessionLog(log.path);
	} catch (error) {
		console.log(`跳过（读取失败）: ${log.path} — ${error.message}`);
		continue;
	}
	const lines = text.split("\n").filter((line) => line.trim() !== "");
	let asked = 0;
	let timedHeader = false;
	let legacyHeader = false;
	for (const line of lines) {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		const data = event?.data;
		// 工具调用：legacy 与 timed 都长这样。
		if (event?.type === "tool/call" && data?.name === "ask_user_question") asked += 1;
		// request/header 里记的 tool schema 决定模式：声明了 `timeout` 才是 timed。
		if (event?.type === "request/header") {
			const tools = data?.header?.tools;
			if (Array.isArray(tools)) {
				for (const tool of tools) {
					if (tool?.name !== "ask_user_question") continue;
					totalHeaders += 1;
					if (tool.parameters?.properties?.timeout !== undefined) timedHeader = true;
					else legacyHeader = true;
				}
			}
		}
	}
	totalCalls += asked;
	if (asked > 0 || timedHeader || legacyHeader) {
		interesting.push({
			path: log.path,
			events: lines.length,
			asked,
			timedHeader,
			legacyHeader,
			mtime: new Date(log.mtime).toISOString(),
		});
	}
}

console.log("=== 含 ask_user_question 痕迹的会话 ===");
if (interesting.length === 0) {
	console.log("（一个都没有 —— 盘上没有模型真的调用过这个工具的记录）");
}
for (const row of interesting) {
	console.log(`\n${row.path}`);
	console.log(
		`  事件数=${row.events} 调用次数=${row.asked} timed头=${row.timedHeader} legacy头=${row.legacyHeader} mtime=${row.mtime}`,
	);
}

console.log("\n=== 汇总 ===");
console.log(`ask_user_question 调用总数: ${totalCalls}`);
console.log(`含 ask_user_question schema 的 request/header 条数: ${totalHeaders}`);
console.log(
	totalHeaders > 0 && !interesting.some((row) => row.timedHeader)
		? "\n关键：所有记到的 ask_user_question schema 都是 **legacy**（无 timeout 属性）\n→ 与 projection.js 的 `if (!fold.timed) return fold` 合起来，\n   说明**这些会话里的提问一个都不会进 userQuestions 投影**。"
		: "",
);
