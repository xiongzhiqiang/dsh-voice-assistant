/**
 * 调研：客户端 `ctx.sessions.list` 的读面到底叫什么名字。
 *
 * 需求 ②（跨会话切换）的 `listTargets()` 直接读这个快照，
 * 方法名猜错就是"列出来永远是空列表"—— 一个不会报错、只会静默失效的 bug。
 * 所以必须从 DSH 自己的类型声明里取证，而不是按常见约定猜 `getSnapshot`。
 *
 * 用法：node tools/research/probe-session-list-api.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PKGS = "C:/Users/xqz19/.dsh/profiles/node_modules/@deepseek-ai";

/**
 * 递归收集 .d.ts。
 *
 * ## 为什么不用 `entry.isDirectory()`（踩过）
 *
 * `@deepseek-ai/*` 这些包目录在本机是 **junction**，`readdirSync` 带
 * `withFileTypes` 时 `isDirectory()` 对它们返回 `false`（它们是重解析点，
 * 不是真目录）。只按 `isDirectory()` 走，第一层就一个都进不去 ——
 * 表现为"扫描 0 个文件"，而且**不报错**，极易误判成"类型定义不存在"。
 * 所以这里对每个条目 `statSync` 一次拿真实类型（junction 会被 stat 穿透），
 * 断链的用 try/catch 跳过。
 */
function collectDts(dir, depth, out) {
	if (depth > 5) return;
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const full = join(dir, name);
		let stat;
		try {
			stat = statSync(full);
		} catch {
			// 断链的 junction（本项目已见过 cordis-plugin-hmr 等），跳过。
			continue;
		}
		if (stat.isDirectory()) {
			if (name === "node_modules") continue;
			collectDts(full, depth + 1, out);
		} else if (name.endsWith(".d.ts") && stat.size < 400_000) {
			out.push(full);
		}
	}
}

const files = [];
collectDts(PKGS, 0, files);
console.log(`扫描 ${files.length} 个 .d.ts`);

// 1) ObservableSnapshot / SnapshotStore 的定义 —— 决定读面方法名。
console.log("\n===== ObservableSnapshot / SnapshotStore 定义 =====");
for (const file of files) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue;
	}
	if (!/class SnapshotStore|interface SnapshotStore|type SnapshotStore/.test(text)) continue;
	console.log(`--- ${file.replace(PKGS, "")}`);
	const lines = text.split("\n");
	let printing = false;
	let brace = 0;
	for (const line of lines) {
		if (/SnapshotStore/.test(line) && /class|interface|type/.test(line)) {
			printing = true;
			brace = 0;
		}
		if (!printing) continue;
		console.log(`  ${line}`);
		brace += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
		if (brace > 0 && /\}/.test(line) && brace === 0) {
			printing = false;
		}
	}
}

// 2) SessionListState 的完整定义 —— listTargets 的字段来源。
console.log("\n===== SessionListState / SessionSummary 定义 =====");
for (const file of files) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue;
	}
	if (!/interface SessionListState|interface SessionSummary/.test(text)) continue;
	console.log(`--- ${file.replace(PKGS, "")}`);
	const lines = text.split("\n");
	let printing = false;
	let brace = 0;
	for (const line of lines) {
		if (/interface Session(ListState|Summary)/.test(line)) {
			printing = true;
			brace = 0;
		}
		if (!printing) continue;
		console.log(`  ${line}`);
		brace += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
		if (brace > 0 && /\}/.test(line) && brace === 0) printing = false;
	}
}
