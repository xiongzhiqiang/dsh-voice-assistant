/**
 * 调研：DSH 自己的客户端代码怎么读 `ctx.sessions.list`。
 *
 * 为什么必须从**打包产物**里取证，而不是从类型声明：
 * `SnapshotStore` 来自 `@deepseek-ai/dsh-client-store`，而该包在本机
 * profile 里**只有 types 引用、没有实体目录**（34 个包依赖它，但顶层
 * node_modules 里没有它 —— 它被打进了前端 bundle）。
 * 所以"读面方法叫什么"只能从实际调用点反查。
 *
 * 需求 ② 的 `listTargets()` 直接依赖这个调用形状：
 * 方法名猜错 = 永远返回空列表，且**不报错**。
 *
 * 用法：node tools/research/probe-list-usage.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "C:/Users/xqz19/.dsh/profiles/node_modules/@deepseek-ai";

/** 递归收集 js（含 junction 穿透，见 probe-session-list-api.mjs 的注释）。 */
function collect(dir, depth, out, predicate) {
	if (depth > 4) return;
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const full = join(dir, name);
		let stat;
		try {
			stat = statSync(full);
		} catch {
			continue;
		}
		if (stat.isDirectory()) {
			if (name === "node_modules") continue;
			collect(full, depth + 1, out, predicate);
		} else if (predicate(name) && stat.size < 3_000_000) {
			out.push(full);
		}
	}
}

const files = [];
collect(ROOT, 0, files, (name) => name.endsWith(".js") || name.endsWith(".mjs"));
console.log(`扫描 ${files.length} 个 js 文件`);

/** 命中的调用形状 → 出现次数。 */
const patterns = [
	/sessions\.list\.getSnapshot\s*\(/g,
	/sessions\.list\.get\s*\(/g,
	/sessions\.list\.snapshot\s*\(/g,
	/sessions\.list\.state\s*\(/g,
	/\blist\.getSnapshot\s*\(/g,
	/\blist\.subscribe\s*\(/g,
	/sessions\?\.list\?\.getSnapshot/g,
	/\.list\.getSnapshot\(\)/g,
];

const tally = new Map();
const samples = new Map();

for (const file of files) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue;
	}
	if (!text.includes("sessions") && !text.includes("SessionListState")) continue;
	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		const matches = text.match(pattern);
		if (matches === null) continue;
		const key = String(pattern);
		tally.set(key, (tally.get(key) ?? 0) + matches.length);
		if (!samples.has(key)) {
			// 取第一处上下文（前后各 120 字），看真实写法。
			pattern.lastIndex = 0;
			const first = pattern.exec(text);
			if (first !== null) {
				const at = Math.max(0, first.index - 120);
				samples.set(key, `${file.replace(ROOT, "")}\n      …${text.slice(at, first.index + 160).replace(/\s+/g, " ")}…`);
			}
		}
	}
}

console.log("\n===== 调用形状统计 =====");
for (const [key, count] of [...tally].sort((a, b) => b[1] - a[1])) {
	console.log(`${String(count).padStart(5)}  ${key}`);
}

console.log("\n===== 首个出现处上下文 =====");
for (const [key, sample] of samples) {
	console.log(`\n[${key}]\n  ${sample}`);
}
