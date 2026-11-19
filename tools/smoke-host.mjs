#!/usr/bin/env node
/**
 * 宿主半冒烟测试（Node，无 DSH 运行时）。
 *
 * 用一个形状正确的 fake ctx 加载 `index.js`，然后把四条 API 端点各打一遍。
 * 这样能在装机前验证：配置下发、路由注册、/polish 降级、上游未配置时的 503，
 * 以及"没有 webServer 时不崩"。
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]tools$/, "");
const require = createRequire(import.meta.url);

const failures = [];
const check = (name, condition, detail) => {
	const ok = Boolean(condition);
	if (!ok) failures.push({ name, detail });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` → ${detail}`}`);
};

const plugin = require(join(ROOT, "index.js"));
check("index.js 可被加载", plugin !== null && typeof plugin === "object");
check("导出 name", plugin.name === "dsh-voice-assistant", plugin.name);
check("导出 apply", typeof plugin.apply === "function");

/** 构造 fake ctx。 */
function makeCtx(options = {}) {
	const routes = [];
	const injections = [];
	const injected = [];
	const logs = [];
	const ctx = {
		logger: { info: (...args) => logs.push(args.join(" ")), warn: (...args) => logs.push(args.join(" ")) },
		get(name) {
			if (name === "webServer" && options.webServer !== false) {
				return { register: (spec) => (routes.push(spec), () => {}) };
			}
			if (name === "llm" && options.llm) return options.llm;
			if (name === "agentDefaultModel" && options.defaultModel) return options.defaultModel;
			return undefined;
		},
		// 委托中枢在根 ctx 上挂事件与生命周期，fake 必须提供这两条。
		effect(factory) {
			return factory();
		},
		on() {
			return () => {};
		},
		inject(deps, callback) {
			injected.push(deps);
			const scope = {
				logger: ctx.logger,
				get: ctx.get,
				effect(factory) {
					return factory();
				},
				on(event, handler) {
					if (event === "webserver/index-inject") injections.push(handler);
					return () => {};
				},
			};
			callback(scope);
		},
	};
	return { ctx, routes, injections, injected, logs };
}

/** 构造 fake req/res 并跑一次请求。 */
async function call(handler, { method = "GET", url, headers = {}, body = null }) {
	const listeners = {};
	const req = {
		method,
		url,
		headers,
		on(event, handler2) {
			listeners[event] = handler2;
		},
		destroy() {},
	};
	const result = { status: 0, headers: {}, body: null };
	const res = {
		headersSent: false,
		writeHead(status, headers2) {
			result.status = status;
			result.headers = headers2 ?? {};
			res.headersSent = true;
		},
		end(payload) {
			result.body = payload === undefined ? null : payload;
		},
	};
	const promise = handler(req, res);
	// 触发请求体
	if (body !== null) {
		const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
		listeners.data?.(buffer);
	}
	listeners.end?.();
	await promise;
	return result;
}

const parse = (result) => {
	if (result.body === null) return null;
	try {
		return JSON.parse(Buffer.isBuffer(result.body) ? result.body.toString("utf8") : String(result.body));
	} catch {
		return null;
	}
};

// ── 1. 正常装配 ───────────────────────────────────────────────────────
const { ctx, routes, injections, injected } = makeCtx({
	llm: { stream: async function* () {} },
	defaultModel: { currentSelection: () => ({ provider: "deepseek", model: "deepseek-chat" }) },
});
let applyError = null;
try {
	plugin.apply(ctx, { wake: { word: "小凤" }, asr: { engine: "http", http: { baseURL: "", apiKey: "SECRET" } } });
} catch (error) {
	applyError = error;
}
check("apply 不抛错", applyError === null, applyError && applyError.message);
check("软注入 webServer", injected.some((deps) => deps.includes("webServer")), JSON.stringify(injected));
// V1.6：API 路由 + 卡通素材路由两条（素材失败不影响 API，单独 try 注册）。
check("注册了两条前缀路由", routes.length === 2, `routes=${routes.length}`);
check("API 路由路径正确", routes[0]?.path === "/plugins/dsh-voice-assistant/api", routes[0]?.path);
check("素材路由路径正确", routes[1]?.path === "/plugins/dsh-voice-assistant/api/avatars", routes[1]?.path);

// 配置下发
const table = [];
for (const handler of injections) handler(table);
check("下发了客户端配置", table.length === 1, `entries=${table.length}`);
check("下发用 global 形态", table[0]?.kind === "global", table[0]?.kind);
check("全局变量名正确", table[0]?.name === "__VOICE_ASSISTANT_CONFIG__", table[0]?.name);
const published = JSON.stringify(table[0]?.value ?? {});
check("下发内容不含密钥", !published.includes("SECRET"));
check("下发内容含唤醒词", table[0]?.value?.wake?.word === "小凤", table[0]?.value?.wake?.word);

const handler = routes[0].handler;

// /health
const health = await call(handler, { url: "/plugins/dsh-voice-assistant/api/health" });
const healthBody = parse(health);
check("/health 返回 200", health.status === 200, health.status);
check("/health 自省润色可用", healthBody?.capabilities?.polishAvailable === true, JSON.stringify(healthBody?.capabilities));
check("/health 报出润色模型", healthBody?.capabilities?.polishModel === "deepseek/deepseek-chat", healthBody?.capabilities?.polishModel);

// /config
const configRes = await call(handler, { url: "/plugins/dsh-voice-assistant/api/config" });
check("/config 返回 200", configRes.status === 200, configRes.status);

// /polish —— llm 流为空时应降级为规则清理
const polishRes = await call(handler, {
	method: "POST",
	url: "/plugins/dsh-voice-assistant/api/polish",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ text: "嗯，帮我看下这个报错" }),
});
const polishBody = parse(polishRes);
check("/polish 返回 200", polishRes.status === 200, polishRes.status);
check("/polish 空输出降级为规则清理", polishBody?.via === "rules", polishBody?.via);
check("/polish 结果去掉了口癖", polishBody?.text === "帮我看下这个报错。", polishBody?.text);

// /polish 空文本
const emptyPolish = await call(handler, {
	method: "POST",
	url: "/plugins/dsh-voice-assistant/api/polish",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ text: "   " }),
});
check("/polish 空文本返回 400", emptyPolish.status === 400, emptyPolish.status);

// /asr —— 未配置 baseURL 时应 503
const asrRes = await call(handler, {
	method: "POST",
	url: "/plugins/dsh-voice-assistant/api/asr",
	headers: { "content-type": "audio/webm" },
	body: Buffer.alloc(64, 1),
});
const asrBody = parse(asrRes);
check("/asr 未配置返回 503", asrRes.status === 503, asrRes.status);
check("/asr 错误码明确", asrBody?.error === "asr-not-configured", asrBody?.error);

// /tts —— 同上
const ttsRes = await call(handler, {
	method: "POST",
	url: "/plugins/dsh-voice-assistant/api/tts",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ text: "你好" }),
});
check("/tts 未配置返回 503", ttsRes.status === 503, ttsRes.status);

// 未知端点
const notFound = await call(handler, { url: "/plugins/dsh-voice-assistant/api/nope" });
check("未知端点返回 404", notFound.status === 404, notFound.status);

// GET 打 POST 端点
const wrongMethod = await call(handler, { method: "GET", url: "/plugins/dsh-voice-assistant/api/polish" });
check("方法不对返回 405", wrongMethod.status === 405, wrongMethod.status);

// ── 2. 没有 webServer 时不应崩 ────────────────────────────────────────
const bare = makeCtx({ webServer: false });
let bareError = null;
try {
	plugin.apply(bare.ctx, {});
} catch (error) {
	bareError = error;
}
check("无 webServer 时 apply 不抛错", bareError === null, bareError && bareError.message);
check("无 webServer 时不注册路由", bare.routes.length === 0, `routes=${bare.routes.length}`);

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	for (const failure of failures) console.error(`  - ${failure.name}: ${failure.detail ?? ""}`);
	process.exitCode = 1;
} else {
	console.log("\n全部通过");
}
