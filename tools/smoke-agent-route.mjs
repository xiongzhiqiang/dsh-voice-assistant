#!/usr/bin/env node
/**
 * 常驻 agent 模型路由回归测试（Node，无 DSH 运行时）。
 *
 * ## 为什么专门有这个测试
 *
 * 曾经的故障现象极其误导：语音指令提交后 `turn/start` 正常、inbox 里的消息
 * 被 claim 走、`turn/end` 立刻落地 —— 看起来像"driver 没消费消息"，
 * 真实原因是 **agent 没有模型路由**，`preStep` 直接抛
 *
 *   agent "…" has no provider/model: set AgentOptions.provider and
 *   AgentOptions.model or record a model selection
 *
 * 这类 bug 用"能不能加载插件"是测不出来的：静态四层验收全绿、真界面也不报错，
 * 只有真的说一句话才暴露。所以这里把路由契约钉死：
 *
 *   1. 配置写死 provider/model → create 的 agentOptions 必须带上；
 *   2. 配置留空 → 必须从 agentDefaultModel.currentSelection() 取；
 *   3. agentDefaultModel 迟到 → 必须有界等待后仍能补到；
 *   4. setup 必须真的调 agent.model.select(...)（写持久 model/selection）；
 *   5. resume / 热重载两条路径也必须补路由；
 *   6. 两处都拿不到 → 如实报 `modelApplied:false`，不许假装成功。
 *
 * 用法：`node tools/smoke-agent-route.mjs`
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]tools$/, "");
const require = createRequire(import.meta.url);
const { ensurePersistentAgent, resolveAgentSelection, applyAgentRoute, composeAgentScope, agentInfo } =
	require(join(ROOT, "lib", "agent.js"));
const { normalizeConfig } = require(join(ROOT, "lib", "config.js"));

const failures = [];
const check = (name, condition, detail) => {
	const ok = Boolean(condition);
	if (!ok) failures.push({ name, detail });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` → ${detail}`}`);
};

const silentLogger = { info: () => {}, warn: () => {} };

/**
 * 构造只含本测试关心的服务的 fake ctx。
 * @param options - `{ selection, defaultModelDelayMs, agent }`。
 */
function makeCtx(options = {}) {
	const created = [];
	const ctx = {
		logger: silentLogger,
		get(name) {
			if (name === "agents") return options.registry ?? null;
			if (name === "sessionPersistence" && options.persistence !== false) return { open: async () => ({}) };
			if (name === "agentDefaultModel") {
				if (options.defaultModelDelayMs !== undefined) {
					if (Date.now() < options.modelReadyAt) return undefined;
				}
				return options.selection === undefined
					? undefined
					: { currentSelection: () => options.selection };
			}
			return undefined;
		},
	};
	return { ctx, created };
}

/** 造一个尽量贴近真机的 fake agent（带 model 投影，记录 select 调用）。 */
function makeAgent(id = "session-voice-assistant-root") {
	const selected = [];
	const agent = {
		id,
		status: "idle",
		model: {
			current: () => (selected.length > 0 ? selected[selected.length - 1] : undefined),
			select: (selection) => selected.push(selection),
		},
	};
	agent.__selected = selected;
	return agent;
}

/** 造 registry：create/resume/get 都记录收到的 options。 */
function makeRegistry(log) {
	const store = new Map();
	return {
		get: (id) => store.get(id),
		async create(options) {
			log.push({ call: "create", options });
			const agent = makeAgent(options.sessionId);
			options.setup?.({ get: () => undefined, on: () => () => {}, effect: () => () => {} }, agent);
			if (options.meta !== undefined) agent.__meta = options.meta;
			store.set(options.sessionId, agent);
			return { agent, dispose: () => {} };
		},
		async resume(options) {
			log.push({ call: "resume", options });
			if (options.failResume === true) throw new Error("no persisted session");
			const agent = makeAgent(options.resumeSessionId);
			options.setup?.({ get: () => undefined, on: () => () => {}, effect: () => () => {} }, agent);
			store.set(options.resumeSessionId, agent);
			return { agent, dispose: () => {} };
		},
		__store: store,
	};
}

/** 只关心 `agent` 段的配置。 */
const cfg = (agentPatch = {}) => normalizeConfig({ agent: { sessionId: "session-voice-assistant-root", ...agentPatch } });

// ── 1. resolveAgentSelection 的优先级 ─────────────────────────────────
{
	const { ctx } = makeCtx({ selection: { provider: "deepseek", model: "deepseek-flash" } });
	const fromDefault = resolveAgentSelection(ctx, cfg());
	check("配置留空时取 agentDefaultModel", fromDefault?.provider === "deepseek" && fromDefault?.model === "deepseek-flash", JSON.stringify(fromDefault));

	const explicit = resolveAgentSelection(ctx, cfg({ provider: "custom", model: "my-model" }));
	check("配置写死时以配置为准", explicit?.provider === "custom" && explicit?.model === "my-model", JSON.stringify(explicit));

	const noSource = resolveAgentSelection(makeCtx({}).ctx, cfg());
	check("两处都拿不到时返回 null", noSource === null, JSON.stringify(noSource));

	// 半填（只写 provider）视为无效，回落默认 —— 半填几乎必然写错。
	const half = resolveAgentSelection(ctx, cfg({ provider: "custom" }));
	check("provider/model 只填一项视为无效", half?.provider === "deepseek", JSON.stringify(half));
}

// ── 2. create 路径：agentOptions 与 setup 双写 ────────────────────────
{
	const log = [];
	const { ctx } = makeCtx({ selection: { provider: "deepseek", model: "deepseek-flash" } });
	const registry = makeRegistry(log);
	// 关掉持久化，强制走 create（有 persistence 时会优先 resume）。
	const result = await ensurePersistentAgent(
		{ logger: silentLogger, get: (name) => (name === "agents" ? registry : name === "sessionPersistence" ? undefined : ctx.get(name)) },
		cfg({ persist: false }),
	);
	check("create 被调用", log.length === 1 && log[0].call === "create", JSON.stringify(log.map((l) => l.call)));
	check("agentOptions 带上 provider", log[0]?.options?.agentOptions?.provider === "deepseek", JSON.stringify(log[0]?.options?.agentOptions));
	check("agentOptions 带上 model", log[0]?.options?.agentOptions?.model === "deepseek-flash", JSON.stringify(log[0]?.options?.agentOptions));
	check("setup 写入持久 model/selection", result.agent.__selected.length === 1 && result.agent.__selected[0].model === "deepseek-flash", JSON.stringify(result.agent.__selected));
	check("回报 modelApplied=true", result.modelApplied === true, String(result.modelApplied));
	check("回报 selection", result.selection?.provider === "deepseek", JSON.stringify(result.selection));
	check("agentInfo 暴露模型", agentInfo(result.agent).model === "deepseek/deepseek-flash", agentInfo(result.agent).model);
}

// ── 3. agentDefaultModel 迟到：必须有界等待后补到 ─────────────────────
{
	const log = [];
	const { ctx } = makeCtx({ selection: { provider: "deepseek", model: "deepseek-pro" }, defaultModelDelayMs: 900 });
	let readyAt = Date.now() + 900;
	const lateCtx = {
		logger: silentLogger,
		get(name) {
			if (name === "agents") return registry;
			if (name === "sessionPersistence") return { open: async () => ({}) };
			if (name === "agentDefaultModel") {
				if (Date.now() < readyAt) return undefined;
				return { currentSelection: () => ({ provider: "deepseek", model: "deepseek-pro" }) };
			}
			return undefined;
		},
	};
	const registry = makeRegistry(log);
	const result = await ensurePersistentAgent(lateCtx, cfg({ sessionId: "session-late-model" }));
	check("延迟就绪后仍写入路由", result.modelApplied === true, String(result.modelApplied));
	check("延迟补获的是后到的模型", result.selection?.model === "deepseek-pro", JSON.stringify(result.selection));
	check("延迟场景 agentOptions 也带上路由", log[0]?.options?.agentOptions?.model === "deepseek-pro", JSON.stringify(log[0]?.options?.agentOptions));
}

// ── 4. resume 路径也要补路由 ──────────────────────────────────────────
{
	const log = [];
	const registry = makeRegistry(log);
	const ctx = {
		logger: silentLogger,
		get(name) {
			if (name === "agents") return registry;
			if (name === "sessionPersistence") return { open: async () => ({}) };
			if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "deepseek", model: "deepseek-flash" }) };
			return undefined;
		},
	};
	const result = await ensurePersistentAgent(ctx, cfg({ sessionId: "session-resumed" }));
	check("resume 被调用", log[0]?.call === "resume", JSON.stringify(log.map((l) => l.call)));
	check("resume 也写路由", result.agent.__selected.length === 1, JSON.stringify(result.agent.__selected));
	check("resume 的 agentOptions 带路由", log[0]?.options?.agentOptions?.model === "deepseek-flash", JSON.stringify(log[0]?.options?.agentOptions));
	check("resume 来源标记正确", result.source === "resumed", result.source);
}

// ── 5. 热重载（live）路径也要补路由 ───────────────────────────────────
{
	const registry = makeRegistry([]);
	const existing = makeAgent("session-live");
	registry.__store.set("session-live", existing);
	const ctx = {
		logger: silentLogger,
		get(name) {
			if (name === "agents") return registry;
			if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "deepseek", model: "deepseek-flash" }) };
			return undefined;
		},
	};
	const result = await ensurePersistentAgent(ctx, cfg({ sessionId: "session-live" }));
	check("live 路径不重复建", result.source === "live", result.source);
	check("live 路径补写路由", existing.__selected.length === 1, JSON.stringify(existing.__selected));
	check("live 路径回报已写入", result.modelApplied === true, String(result.modelApplied));
}

// ── 6. 拿不到路由时如实报告，不许假装成功 ──────────────────────────────
{
	const log = [];
	const registry = makeRegistry(log);
	const ctx = {
		logger: silentLogger,
		get(name) {
			if (name === "agents") return registry;
			if (name === "sessionPersistence") return { open: async () => ({}) };
			return undefined; // 没有 agentDefaultModel
		},
	};
	const result = await ensurePersistentAgent(ctx, cfg({ sessionId: "session-nomodel" }));
	check("无路由时 modelApplied=false", result.modelApplied === false, String(result.modelApplied));
	check("无路由时 selection=null", result.selection === null, JSON.stringify(result.selection));
	check("无路由时不塞 agentOptions", Object.keys(log[0]?.options?.agentOptions ?? {}).length === 0, JSON.stringify(log[0]?.options?.agentOptions));
	check("无路由时 agent 没有 model 记录", result.agent.__selected.length === 0, JSON.stringify(result.agent.__selected));
}

// ── 7. applyAgentRoute 的容错 ─────────────────────────────────────────
{
	check("applyAgentRoute 对 null selection 返回 false", applyAgentRoute(makeAgent(), null) === false);
	check("applyAgentRoute 对无 model 的 agent 返回 false", applyAgentRoute({}, { provider: "a", model: "b" }) === false);
	const throwing = { model: { select: () => { throw new Error("boom"); } } };
	check("applyAgentRoute 吞掉 select 异常", applyAgentRoute(throwing, { provider: "a", model: "b" }) === false);
}

// ── 8. composeAgentScope 不因缺服务崩掉 ───────────────────────────────
{
	const outcome = composeAgentScope({ get: () => undefined }, cfg(), {}, makeAgent());
	check("composeAgentScope 无 systemPrompt 也不崩", outcome !== undefined);
	const withPersona = composeAgentScope({ get: () => undefined }, normalizeConfig({}), {}, makeAgent());
	check("无注入 ctx 时 modelApplied 为假（无服务可取）", withPersona.modelApplied === false, String(withPersona.modelApplied));
}

// ── 9. 半填配置不得污染 agentOptions ──────────────────────────────────
{
	const log = [];
	const registry = makeRegistry(log);
	const ctx = {
		logger: silentLogger,
		get(name) {
			if (name === "agents") return registry;
			if (name === "sessionPersistence") return { open: async () => ({}) };
			if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "deepseek", model: "deepseek-flash" }) };
			return undefined;
		},
	};
	const result = await ensurePersistentAgent(ctx, cfg({ sessionId: "session-half", provider: "typo-provider" }));
	check("半填 provider 被忽略，用默认模型", log[0]?.options?.agentOptions?.provider === "deepseek", JSON.stringify(log[0]?.options?.agentOptions));
	check("半填场景仍写入路由", result.modelApplied === true, String(result.modelApplied));
}

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	for (const failure of failures) console.error(`  - ${failure.name}: ${failure.detail ?? ""}`);
	process.exitCode = 1;
} else {
	console.log("\n全部通过");
}
