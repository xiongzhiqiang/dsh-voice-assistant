#!/usr/bin/env node
/**
 * 客户端 bundle 冒烟测试（Node，无浏览器）。
 *
 * ## 这份测试证明什么
 *
 * 它不是"跑起来看看"—— 它证明四件在浏览器里很难快速验证的事：
 *   1. bundle 是**语法合法的 classic script**（`new Function` 能编译它）；
 *   2. 模块表能完整求值（无循环依赖、无未处理的 import）；
 *   3. `apply(ctx)` 在真实形状的 fake ctx 上能跑通，且**不碰麦克风**
 *      （浏览器要求手势，自动申请会静默失败）；
 *   4. 注册确实落在了 `shell.overlay` 槽上，卸载时把监听与单例都清干净了。
 *
 * ## 为什么值得单独写
 *
 * DSH 插件的失败方式大多是"静默"：槽没注册上、bundle 语法不对、
 * `apply` 抛错被 fiber 吞掉。这三类问题在浏览器里表现为"界面上什么都没出现"，
 * 排查成本极高。这里把三道关卡在 Node 里提前跑一遍。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]tools$/, "");
const BUNDLE = join(ROOT, "lib", "client.js");
const source = readFileSync(BUNDLE, "utf8");

const failures = [];
const check = (name, condition, detail) => {
	const ok = Boolean(condition);
	if (!ok) failures.push({ name, detail });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` → ${detail}`}`);
};

// ── 1. 语法合法性 ─────────────────────────────────────────────────────
try {
	// classic script 里没有 import/export 语句，因此能直接交给 Function 编译。
	new Function(source);
	check("bundle 语法合法（可被 classic script 解析）", true);
} catch (error) {
	check("bundle 语法合法（可被 classic script 解析）", false, String(error.message));
}

check("bundle 不含 ESM 的 import 语句", !/^\s*import\s/m.test(source));
check("bundle 不含 ESM 的 export 语句", !/^\s*export\s/m.test(source));
check("bundle 注册的 id 与包名一致", /id:\s*"dsh-voice-assistant"/.test(source));

// ── 2. 在受控环境里求值 ───────────────────────────────────────────────
/** 极简 React 替身：apply() 阶段不会渲染，只需要这些名字存在。 */
const React = {
	createElement: (tag, props, ...children) => ({ tag, props, children }),
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useEffect: () => {},
	useCallback: (fn) => fn,
	useRef: (initial) => ({ current: initial }),
	useSyncExternalStore: () => ({}),
	Fragment: "Fragment",
};

const listeners = new Set();
const domNodes = new Map();

/** 极简 document 替身：installStyles 只需要这几个方法。 */
const documentStub = {
	getElementById: (id) => domNodes.get(id) ?? null,
	// V1.6 起卸载时要清掉兜底挂载的宿主节点（`[id^="xfv-fallback-host"]`）。
	// 少了这个会报 `document.querySelectorAll is not a function` —— 那是**替身缺口**，
	// 不是产品 bug；补上才能测到真正的卸载清理。
	querySelectorAll: () => [],
	createElement: () => {
		const node = {
			id: "",
			textContent: "",
			style: {},
			remove() {
				domNodes.delete(node.id);
			},
		};
		return node;
	},
	head: {
		appendChild(node) {
			if (node.id !== "") domNodes.set(node.id, node);
			return node;
		},
	},
};

const windowStub = {
	__ModuleLoader__: { load: (definition) => (registered = definition) },
	addEventListener: (type, handler) => listeners.add({ type, handler }),
	removeEventListener: (type, handler) => {
		for (const entry of listeners) {
			if (entry.type === type && entry.handler === handler) listeners.delete(entry);
		}
	},
	// 故意不提供 AudioContext / SpeechRecognition / speechSynthesis：
	// apply() 必须能在"什么都没有"的环境里安全返回（此时引擎为 none）。
};

/** 模块定义与 factory 返回值（由 __ModuleLoader__.load 捕获）。 */
let registered = null;
let api = null;

/**
 * `apply` 现在会就地吞掉装配异常（不让单个插件带崩整个 web boot），
 * 所以「装配是否成功」只能从 console.error 里判断 —— 先把错误收集起来。
 */
const consoleErrors = [];
const realConsoleError = console.error;
console.error = (...args) => {
	consoleErrors.push(args.map((arg) => String(arg)).join(" "));
};


const loader = {
	load: (definition) => {
		registered = definition;
	},
};

const requireStub = (id) => {
	if (id === "react") return React;
	throw new Error(`未预期的外部模块：${id}`);
};

let factoryError = null;
try {
	globalThis.window = windowStub;
	globalThis.document = documentStub;
	// eslint-disable-next-line no-new-func
	new Function("window", "document", source)(windowStub, documentStub);
	if (registered !== null) api = registered.factory(requireStub);
} catch (error) {
	factoryError = error;
}
check("模块表求值无异常", factoryError === null, factoryError && String(factoryError.message));
check("通过 __ModuleLoader__ 注册成功", registered !== null);
if (registered === null) {
	report();
	process.exit(1);
}
check("bundle id 正确", registered.id === "dsh-voice-assistant", registered.id);

// ── 3. 用 fake ctx 调 apply ───────────────────────────────────────────

/** 槽类型表：与真机 SlotCore 的声明保持一致。 */
const SLOT_KINDS = { "shell.overlay": "list" };

const disposers = [];
const registrations = [];
const injectCalls = [];
const logs = [];

const ctx = {
	inject: ["slots"],
	effect: (factory) => {
		const dispose = factory();
		if (typeof dispose === "function") disposers.push(dispose);
		return () => {};
	},
	slots: {
		inject: (key, callback) => {
			injectCalls.push(key);
			// 立刻交付，模拟"槽已声明"的常见情形。
			const dispose = callback();
			if (typeof dispose === "function") disposers.push(dispose);
			return () => {};
		},
		register: (options, component) => {
			// 复刻真实 SlotCore 的槽类型校验：`shell.overlay` 是 list 槽，
			// 注册必须带唯一 `id`。少写它真机直接抛错、带崩整个 web boot，
			// 桩里不校验就会把这类问题漏到浏览器里。
			const kind = SLOT_KINDS[options.name] ?? "single";
			if (kind === "list" && options.id === undefined) {
				throw new Error(`list slot "${options.name}" requires options.id`);
			}
			registrations.push({ options, component });
			return () => {};
		},
	},
	get: (name) => {
		if (name === "sessions") {
			return {
				create: async () => "session-fake",
				retain: () => ({ sessionId: "session-fake", binding: null, ready: Promise.reject(new Error("n/a")), release() {} }),
			};
		}
		return undefined;
	},
	logger: { info: (...args) => logs.push(args.join(" ")), warn: (...args) => logs.push(args.join(" ")) },
};

let applyError = null;
try {
	api.apply(ctx);
} catch (error) {
	applyError = error;
}
check("apply(ctx) 不抛错", applyError === null, applyError && String(applyError.stack ?? applyError.message));
check(
	"装配过程中没有内部异常",
	consoleErrors.every((line) => !line.includes("装配失败")),
	consoleErrors.join(" | "),
);
check("向 shell.overlay 注入了槽位", injectCalls.includes("shell.overlay"), JSON.stringify(injectCalls));
check("实际注册了 shell.overlay", registrations.some((entry) => entry.options.name === "shell.overlay"));
check(
	"list 槽注册项带 id",
	registrations
		.filter((entry) => entry.options.name === "shell.overlay")
		.every((entry) => typeof entry.options.id === "string"),
	JSON.stringify(registrations.map((entry) => entry.options)),
);
check("注册项带组件", registrations.some((entry) => typeof entry.component === "function"));
check("样式已注入 head", domNodes.has("xfv-style"), [...domNodes.keys()].join(","));
check("绑定了全局快捷键", listeners.size === 1, `listeners=${listeners.size}`);

// 快捷键必须只认 Alt+Shift+V
const hotkey = [...listeners].find((entry) => entry.type === "keydown");
check("快捷键监听已就位", hotkey !== undefined);
if (hotkey === undefined) { report(); process.exit(1); }
let prevented = false;
hotkey.handler({ repeat: false, altKey: true, shiftKey: true, code: "KeyV", preventDefault: () => (prevented = true) });
check("Alt+Shift+V 命中快捷键", prevented);
let ignored = false;
hotkey.handler({ repeat: false, altKey: false, shiftKey: true, code: "KeyV", preventDefault: () => (ignored = true) });
check("缺少 Alt 时不触发", !ignored);

// ── 4. 卸载清理 ───────────────────────────────────────────────────────
for (const dispose of disposers) {
	try {
		dispose();
	} catch (error) {
		check("卸载 disposer 不抛错", false, String(error.message));
	}
}
check("卸载后移除快捷键监听", listeners.size === 0, `listeners=${listeners.size}`);
check("卸载后移除样式", !domNodes.has("xfv-style"));

report();

function report() {
	console.error = realConsoleError;
	if (failures.length > 0) {
		console.error(`\n${failures.length} 项失败`);
		for (const failure of failures) console.error(`  - ${failure.name}: ${failure.detail ?? ""}`);
		process.exitCode = 1;
		return;
	}
	console.log("\n全部通过");
}
