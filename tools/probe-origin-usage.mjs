/**
 * 扫描 DSH 运行时：哪些地方**判定** `origin === 'subagent'`。
 *
 * 为什么要扫：需求 ① 想让常驻语音会话"不出现在侧边栏"。候选做法是给
 * session header 打上 `origin: 'subagent'`。但这个名字带着很强的语义
 * 暗示（"这是一个子代理的会话"），必须确认除了"隐藏"之外，还有没有别的
 * 行为被这同一个标记带出来 —— 否则会把常驻助手变成一个"子代理会话"，
 * 在别处被当成子会话处理。
 *
 * 用法：`node tools/probe-origin-usage.mjs [包根目录]`
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] ?? "C:/Users/xqz19/.dsh/profiles/node_modules/@deepseek-ai";

/** 判定 "某个东西是 subagent" 的写法（宽松匹配，宁多勿漏）。 */
const PATTERNS = [
	/origin\s*[!=]==?\s*["']subagent["']/,
	/["']subagent["']\s*[!=]==?\s*[\w$.?]*\.?origin/,
	/origin\s*:\s*["']subagent["']/,
	/isSubagent\s*\(/,
	/parentSession\b/,
];

const hits = [];
const seenPackages = new Map();

/**
 * 递归扫包。
 * @param dir - 目录。
 * @param depth - 当前深度。
 */
function walk(dir, depth) {
	if (depth > 5) return;
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const path = join(dir, name);
		let info;
		try {
			info = statSync(path);
		} catch {
			continue;
		}
		if (info.isDirectory()) {
			if (name === "node_modules") continue;
			walk(path, depth + 1);
			continue;
		}
		if (!/\.js$/.test(name)) continue;
		let text;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		const lines = text.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (PATTERNS.some((re) => re.test(line))) {
				hits.push({ path, line: index + 1, text: line.trim().slice(0, 150) });
			}
		}
	}
}

walk(ROOT, 0);

for (const hit of hits) {
	const pkg = /@deepseek-ai[\\/]([^\\/]+)/.exec(hit.path);
	const key = pkg === null ? hit.path : pkg[1];
	if (!seenPackages.has(key)) seenPackages.set(key, []);
	seenPackages.get(key).push(hit);
}

console.log(`=== 命中 ${hits.length} 处，分布在 ${seenPackages.size} 个包 ===\n`);
for (const [pkg, list] of [...seenPackages].sort((a, b) => b[1].length - a[1].length)) {
	console.log(`── ${pkg}（${list.length} 处）`);
	for (const item of list.slice(0, 12)) {
		console.log(`   ${item.line}: ${item.text}`);
	}
	if (list.length > 12) console.log(`   …另有 ${list.length - 12} 处`);
	console.log("");
}
