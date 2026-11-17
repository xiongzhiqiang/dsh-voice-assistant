/**
 * 在 profile 的 node_modules 里搜一段文本（穿透 junction）。
 *
 * 为什么不用 Grep 工具：`~/.dsh/profiles/node_modules/@deepseek-ai/*` 全是
 * junction，ripgrep 追不进去（报一串 `os error 2`，且**不报"搜了 0 个"**
 * 之外的任何有用信息 —— 空结果很容易被当成"确实没有"）。
 *
 * 用法：`node tools/_search-profile.mjs "without inject"`
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const needle = process.argv[2];
if (needle === undefined) {
	console.error("用法: node tools/_search-profile.mjs <要搜的文本>");
	process.exit(2);
}
const ROOT = "C:/Users/xqz19/.dsh/profiles/node_modules";

/** 递归收集 .js/.mjs/.cjs 文件（`statSync` 穿透 junction）。 */
function collect(dir, out, depth) {
	if (depth > 8) return;
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (name === "node_modules" && dir !== ROOT) continue;
		const full = join(dir, name);
		let stat;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		if (stat.isDirectory()) collect(full, out, depth + 1);
		else if (/\.(js|mjs|cjs)$/.test(name)) out.push(full);
	}
}

const files = [];
collect(ROOT, files, 0);
console.log(`扫描 ${files.length} 个文件…`);
let hits = 0;
for (const file of files) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue;
	}
	if (!text.includes(needle)) continue;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		if (!lines[i].includes(needle)) continue;
		hits += 1;
		if (hits <= 25) console.log(`${file.replace(ROOT, "")}:${i + 1}\n    ${lines[i].trim().slice(0, 260)}`);
	}
}
console.log(`\n共 ${hits} 处命中`);
