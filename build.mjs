#!/usr/bin/env node
/**
 * 零依赖构建脚本：把 `src/client/` 下的 ESM 源码打成 DSH 客户端 bundle。
 *
 * DSH 客户端 bundle 是 **classic script**，格式固定：
 *
 *   window.__ModuleLoader__.load({ id, factory })
 *
 * factory 内可用 `require()` 取两类模块：
 *   1. platform seed 白名单（react / react-dom / cordis / store / slots / primitives）
 *   2. 本包 `dsh.client.inject` 声明的包
 * 因此不能直接交付 ESM，需要一层模块表。
 *
 * 本脚本做的事：
 *   - 把每个 `src/client/**\/*.js` 编译成 `__def(id, (exports, __req) => {...})`
 *   - 把 `import` 重写成 `__req(...)`，`export` 重写成 `exports.X = X`
 *   - 相对路径在构建期解析成规范 id，运行时无需路径运算
 *   - 最后 require 入口，把 `apply` / `inject` / `name` 挂到 bundle 的 exports 上
 *
 * 支持的源码子集（严格校验，遇到不支持语法**立即报错**，绝不静默产出坏包）：
 *   import { a, b as c } from "spec";
 *   import * as ns from "spec";
 *   import def from "spec";
 *   import "spec";
 *   export const X = ...;   export function f() {}   export class K {}
 *   export { a, b };
 *
 * 刻意不支持 `export default` 与动态 `import()`：前者会让"这个模块导出什么"
 * 变得隐式（读代码时要回到底部找），后者在模块表这套同步解析里无法表达。
 *
 * 用法：
 *   node build.mjs           构建
 *   node build.mjs --check   只校验语法，不写文件
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, relative, posix } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, "src", "client");
const OUT = join(ROOT, "lib", "client.js");

/** bundle id 必须与 package.json 的 name 一致（模块表的行 id）。 */
const BUNDLE_ID = "dsh-voice-assistant";

const argv = new Set(process.argv.slice(2));

/** 递归列出 `dir` 下全部 `.js`，返回相对 `SRC` 的 posix 路径。 */
function collectSources(dir = SRC, acc = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			collectSources(full, acc);
			continue;
		}
		if (!entry.name.endsWith(".js")) continue;
		acc.push(posix.join(...relative(SRC, full).split("\\")));
	}
	return acc.sort();
}

/** 把相对 specifier 解析成规范 id（相对 SRC 的 posix 路径）。 */
function resolveId(spec, fromId) {
	if (!spec.startsWith(".")) return { external: true, id: spec };
	const baseDir = posix.dirname(fromId);
	const joined = posix.join(baseDir === "." ? "" : baseDir, spec);
	return { external: false, id: joined.startsWith("./") ? joined.slice(2) : joined };
}

const IMPORT_BLOCK = /^[ \t]*import\s+([\s\S]*?)\s+from\s*["']([^"']+)["']\s*;?[ \t]*$/gm;
const IMPORT_BARE = /^[ \t]*import\s*["']([^"']+)["']\s*;?[ \t]*$/gm;

/** 解析 `{ a, b as c }` 子句为 `{ a, b: c }` 解构形式。 */
function rewriteNamedClause(clause) {
	const inner = clause.trim().replace(/^\{\s*|\s*\}$/g, "");
	if (inner === "") return "";
	return inner
		.split(",")
		.map((piece) => piece.trim())
		.filter(Boolean)
		.map((piece) => {
			const m = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(piece);
			return m ? `${m[1]}: ${m[2]}` : piece;
		})
		.join(", ");
}

/** 收集并剥离 `export` 关键字，返回导出名清单。 */
function hoistExports(src) {
	const names = [];

	// export { a, b as c };
	src = src.replace(/^[ \t]*export\s*\{([^}]*)\}\s*;?[ \t]*$/gm, (_m, clause) => {
		for (const piece of clause.split(",")) {
			const t = piece.trim();
			if (!t) continue;
			const as = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(t);
			names.push(as ? as[2] : t);
		}
		return "";
	});

	// export const / let / function / class / async function
	src = src.replace(/^([ \t]*)export\s+(const|let|function\*?|class|async\s+function\*?)\s+([\w$]+)/gm, (_m, indent, keyword, name) => {
		names.push(name);
		return `${indent}${keyword} ${name}`;
	});

	return { src, names };
}

/** 把一份 ESM 源码编译成模块表片段。 */
function compile(id, source) {
	if (/^[ \t]*export\s+default\b/m.test(source)) {
		throw new Error(`build: ${id} 使用了不支持的 \`export default\`（请用具名导出）`);
	}
	if (/[^.\w]import\s*\(/.test(source)) {
		throw new Error(`build: ${id} 使用了动态 import()（模块表是同步解析，不支持）`);
	}

	const { src: withoutExports, names } = hoistExports(source);
	let src = withoutExports;

	src = src.replace(IMPORT_BLOCK, (_m, clause, spec) => {
		const c = clause.trim();
		const { id: targetId, external } = resolveId(spec, id);
		const ref = external ? `require(${JSON.stringify(targetId)})` : `__req(${JSON.stringify(targetId)})`;

		if (c.startsWith("{")) return `const { ${rewriteNamedClause(c)} } = ${ref};`;
		if (c.startsWith("*")) {
			const asM = /^\*\s+as\s+([\w$]+)$/.exec(c);
			if (!asM) throw new Error(`build: ${id} 无法解析 \`import ${c} from "${spec}"\``);
			return `const ${asM[1]} = ${ref};`;
		}
		if (/^[\w$]+$/.test(c)) return `const ${c} = (${ref}.default ?? ${ref});`;
		throw new Error(`build: ${id} 遇到不支持的 import 子句 \`${c}\``);
	});

	src = src.replace(IMPORT_BARE, (_m, spec) => {
		const { id: targetId, external } = resolveId(spec, id);
		return external ? `require(${JSON.stringify(targetId)});` : `__req(${JSON.stringify(targetId)});`;
	});

	if (/^[ \t]*import\b/m.test(src)) {
		const bad = src.split("\n").find((l) => /^[ \t]*import\b/.test(l));
		throw new Error(`build: ${id} 存在未处理的 import：${bad.trim()}`);
	}
	if (/^[ \t]*export\b/m.test(src)) {
		const bad = src.split("\n").find((l) => /^[ \t]*export\b/.test(l));
		throw new Error(`build: ${id} 存在未处理的 export：${bad.trim()}`);
	}

	// 顶层 await 无法在同步 factory 里求值，直接报错而不是产出一个会崩的包。
	// 只匹配**顶格**声明（列 0），函数体里缩进的 `= await` 是正常的。
	if (/^(?:const|let|var)\s+[^\n=]+=\s*await\b/m.test(src)) {
		throw new Error(`build: ${id} 存在顶层 await（客户端 bundle 的 factory 是同步求值）`);
	}

	const exportStmt = names.length === 0 ? "" : `\n\t__exports({ ${names.join(", ")} });`;

	return { id, chunk: `__def(${JSON.stringify(id)}, (__exports, __req) => {\n${indent(src, 1)}${exportStmt}\n});` };
}

function indent(src, level) {
	const pad = "\t".repeat(level);
	return src
		.split("\n")
		.map((l) => (l.trim() === "" ? l : pad + l))
		.join("\n");
}

/** 运行时垫片：模块表 + 惰性 require + seed 透传。 */
const RUNTIME = `const __factories = new Map();
const __instances = new Map();
const __loading = new Set();

/** 登记一个模块工厂（构建期生成，全部登记完再启动）。 */
function __def(id, factory) {
	__factories.set(id, factory);
}

/**
 * 取一个模块实例。内部 id 走本表，其余（react 等 seed）透传给 bundle 的
 * require —— 由 DSH 的模块表负责解析。
 */
function __req(id) {
	if (!__factories.has(id)) return require(id);
	const hit = __instances.get(id);
	if (hit !== undefined) return hit.exports;
	if (__loading.has(id)) throw new Error("voice-assistant: 模块循环依赖 " + id);
	__loading.add(id);
	const mod = { exports: {} };
	__instances.set(id, mod);
	try {
		__factories.get(id)((patch) => Object.assign(mod.exports, patch), __req);
	} finally {
		__loading.delete(id);
	}
	return mod.exports;
}`;

function build() {
	const modules = collectSources().filter((id) => id !== "index.js");
	const entryId = "index.js";
	if (!existsSync(join(SRC, entryId))) throw new Error(`build: 缺少入口 src/client/${entryId}`);

	const compiled = [];
	for (const id of [...modules, entryId]) {
		compiled.push(compile(id, readFileSync(join(SRC, id), "utf8")));
	}

	const body = compiled.map((c) => c.chunk).join("\n\n");
	const out = `/**
 * ${BUNDLE_ID} —— 「小凤」语音助手（客户端 bundle，自动生成，请勿手工编辑）
 * 源码见 src/client/，由 build.mjs 从 ${compiled.length} 个模块构建。
 */
window.__ModuleLoader__.load({
	id: ${JSON.stringify(BUNDLE_ID)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

${indent(RUNTIME, 2)}

${indent(body, 2)}

		const __entry = __req(${JSON.stringify(entryId)});
		exports.apply = __entry.apply;
		if (__entry.inject !== undefined) exports.inject = __entry.inject;
		if (__entry.name !== undefined) exports.name = __entry.name;
		return module.exports;
	}
});
`;
	return { out, count: compiled.length };
}

function main() {
	const { out, count } = build();

	// ── 产物语法自校验（2026-11-26 补）─────────────────────────────────
	// 起因：styles.js 是**一个模板字符串**，注释里写了反引号 → 提前闭合 →
	// 属性名被当 JS 解析 → `SyntaxError: Unexpected identifier 'max'`。
	// 这类错误只在浏览器里表现为"整站白屏 + Failed to load plugins"，
	// 纯逻辑单测全绿也照样发生（构建产物是唯一被 DSH 加载的东西）。
	//
	// classic script 没有 import/export，因此 `new Function` 能直接编译它：
	// 编译不过就说明产物铁定起不来，宁可构建失败，也不要写出一个白屏的包。
	try {
		new Function(out);
	} catch (error) {
		throw new Error(
			`build: 产物语法不合法，已拒绝写盘 —— ${String(error?.message ?? error)}\n` +
				"  常见原因：src/client/ui/styles.js 的模板字符串（CSS 段）里出现了反引号。",
		);
	}

	if (argv.has("--check")) {
		console.log(`构建校验通过：模块 ${count} 个，产物 ${out.length} 字节（未写盘）`);
		return;
	}
	mkdirSync(dirname(OUT), { recursive: true });
	writeFileSync(OUT, out, "utf8");
	console.log(`构建完成：模块 ${count} 个 → ${relative(ROOT, OUT)}（${out.length} 字节）`);
}

main();
