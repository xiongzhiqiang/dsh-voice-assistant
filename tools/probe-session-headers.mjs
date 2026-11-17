/**
 * 扫描本机全部 DSH 会话头，统计 header 字段分布。
 *
 * 为什么需要：需求 ① 想"隐藏常驻会话"。DSH 没有 `hidden` 字段，候选做法
 * 有两条（归档 / `origin:'subagent'`），两条都有副作用嫌疑。要看副作用，
 * 先得知道**真实存在**的会话长什么样 —— 尤其有没有现成的 subagent 会话
 * 可以用来对照（它的 header 就是"被隐藏的会话"的标准形态）。
 *
 * 只解压**第一帧**即可：header 是会话创建时写下的第一行。
 *
 * 用法：`node tools/probe-session-headers.mjs [DSH_HOME]`
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const HOME = process.argv[2] ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
const ROOT = join(HOME, "sessions");

const rows = [];
const keyCount = new Map();

for (const group of safeList(ROOT)) {
	const groupPath = join(ROOT, group);
	for (const session of safeList(groupPath)) {
		const file = join(groupPath, session, "session.v4.jsonl.zstd");
		const header = readHeader(file);
		if (header === null) {
			rows.push({ group, session, header: null, note: "读不到 header" });
			continue;
		}
		for (const key of Object.keys(header)) keyCount.set(key, (keyCount.get(key) ?? 0) + 1);
		rows.push({ group, session, header });
	}
}

console.log(`=== 共 ${rows.length} 个会话 ===\n`);
console.log(`--- header 出现过的字段（出现次数）---`);
for (const [key, count] of [...keyCount].sort((a, b) => b[1] - a[1])) {
	console.log(`  ${key}: ${count}`);
}

const subagents = rows.filter((row) => row.header?.origin === "subagent");
console.log(`\n--- origin=subagent 的会话：${subagents.length} 个 ---`);
for (const row of subagents.slice(0, 10)) {
	console.log(`  ${row.session}  parentSession=${row.header.parentSession}  cwd=${row.header.cwd}`);
}

const voice = rows.filter((row) => /voice-assistant/.test(row.session));
console.log(`\n--- 语音助手相关会话：${voice.length} 个 ---`);
for (const row of voice) {
	console.log(`  ${row.session}\n    ${JSON.stringify(row.header)}`);
}

// 对照：普通会话的 header 形态（抽一个）
const plain = rows.find((row) => row.header !== null && row.header.origin === undefined && !/voice-assistant/.test(row.session));
console.log(`\n--- 普通会话 header 样例 ---`);
console.log(`  ${plain?.session}: ${JSON.stringify(plain?.header)}`);

/**
 * 列目录（失败返回空数组）。
 * @param path - 目录。
 */
function safeList(path) {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

/**
 * 读会话第一帧，解析出 header 行。
 * @param file - `session.v4.jsonl.zstd` 路径。
 * @returns header 对象，或 `null`。
 */
function readHeader(file) {
	let raw;
	try {
		if (!statSync(file).isFile()) return null;
		raw = readFileSync(file);
	} catch {
		return null;
	}
	try {
		const text = zstdDecompressSync(raw).toString("utf8");
		const line = text.split("\n").find((item) => item.trim() !== "");
		if (line === undefined) return null;
		return JSON.parse(line);
	} catch {
		return null;
	}
}
