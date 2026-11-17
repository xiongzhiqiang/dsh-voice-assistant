/**
 * 扫盘上的语音会话日志，把**用户实际说出口、被识别成的文本**按时间列出来。
 *
 * ## 为什么需要它
 *
 * 判断"识别准确性是否下降"不能靠体感，也不能靠配置推断 ——
 * 唯一可靠的证据是**识别结果本身**。语音指令会经 `prompt()` 进入常驻
 * 会话，因此每条用户消息都带着识别后的文本与时间戳。
 *
 * 把「早期」与「近期」的识别结果并排看，就能回答两个问题：
 *   ① 现在的识别是不是真的变差了（而不是记忆偏差）；
 *   ② 从哪个时间点开始变差（据此定位是哪次改动引入的）。
 *
 * ## 什么算"语音发的"
 *
 * 语音链路与手打消息在日志里都是 `user/message`。区分办法：
 * 语音提交走 `rpcId`，且**文本经过润色**（口语、无换行、常带句号），
 * 而手打通常更长、带换行或书面语。这里不做自动判定 ——
 * 脚本只如实列出文本与时间，由人来判（**少一点猜测，多一点证据**）。
 *
 * 用法：
 *     node tools/research/scan-voice-sessions.mjs             # 列全部语音会话
 *     node tools/research/scan-voice-sessions.mjs <关键词>     # 只看文本含关键词的
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSessionLog } from "./session-log-reader.mjs";

const SESSIONS = "C:/Users/xqz19/.dsh/sessions";
const filter = process.argv[2] ?? "";

/** 递归收集所有 `session.v4.jsonl.zstd`。 */
function collect(dir, depth, out) {
	if (depth > 4) return out;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) collect(path, depth + 1, out);
		else if (entry.name.endsWith(".jsonl.zstd")) out.push(path);
	}
	return out;
}

const files = collect(SESSIONS, 0, []).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);

/**
 * 从一条事件里取用户消息文本。
 *
 * 事件是**扁平**形状：`{ type, seq, time, data }`，业务字段全在 `data` 下
 * （本项目在"坑二"里栽过这一层 —— 按扁平读会全拿到 `undefined`）。
 * 这里只认 `type === "user/message"`。
 */
function userTextOf(event) {
	if (event?.type !== "user/message") return null;
	const content = event?.data?.content;
	if (!Array.isArray(content)) return null;
	const parts = content
		.filter((item) => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text.trim())
		.filter((text) => text !== "");
	return parts.length === 0 ? null : parts.join(" ");
}

let total = 0;
for (const file of files) {
	let text;
	try {
		text = readSessionLog(file);
	} catch {
		continue;
	}
	const rows = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		const utterance = userTextOf(event);
		if (utterance === null) continue;
		if (filter !== "" && !utterance.includes(filter)) continue;
		// 语音链路的用户消息带 rpcId（由客户端提交）；手打也带，
		// 所以这里只如实记录，不做"是不是语音"的断言。
		rows.push({ at: event.time ?? event.data?.time ?? null, utterance });
	}
	if (rows.length === 0) continue;
	total += rows.length;
	console.log(`\n═══ ${file.replace(SESSIONS, ".")} ═══`);
	for (const row of rows) {
		const stamp = typeof row.at === "number" ? new Date(row.at).toISOString() : String(row.at);
		console.log(`  [${stamp}] ${row.utterance}`);
	}
}

console.log(`\n共 ${total} 条用户消息（跨 ${files.length} 个日志文件）${filter === "" ? "" : `，过滤词「${filter}」`}`);
