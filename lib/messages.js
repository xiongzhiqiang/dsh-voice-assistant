/**
 * 构造 DSH 可持久化的「带身份消息」（identified message）。
 *
 * ## 为什么不能自己拼一个裸对象（V1.3 真机坑）
 *
 * `agent.followup()` 会把消息写进 `agent/inbox/spliced` 事件并持久化。DSH 新版
 * `dsh-session` 在 resume 时会对历史事件做校验：
 *
 * ```text
 * session event at seq N lacks an identified message
 * ```
 *
 * 校验条件（`assertMessageEventShape`）：`id` 非空字符串、`role` 与事件类型匹配、
 * `source.kind` 非空、`content` 是数组。裸对象没有 `id` —— 当时能跑，重启后
 * 整个常驻会话再也 resume 不回来（表现为 worker 全部未注册）。
 *
 * ## 为什么优先取官方 helper 而不是自己生成 id
 *
 * 官方 `createUserMessage()` 还会做 `brandString` 标记与 `deepFreeze`，不同版本
 * 的 DSH 可能在 flush/replay 时检查这些细节。本模块以官方实现为准，只在拿不到
 * DSH 包时退化为**满足全部校验不变量**的本地构造（单测/fake 环境用）。
 *
 * 解析路径不能用插件自身的 `import.meta.url`：插件以 junction 装进 DSH 后，
 * Node 会按真实路径解析到 `WorkBuddy/DSH_dev/…`，那条链上没有 `@deepseek-ai/*`。
 * 所以显式从 `DSH_HOME/profiles/<profile>/package.json` 建 `createRequire`。
 */
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let cachedFactory;

/** 列出可能的 profile package.json（当前 profile 优先，再按目录名兜底）。 */
function profileManifests() {
	const root = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const profiles = join(root, "profiles");
	const names = [];
	const preferred = process.env.DSH_PROFILE ?? "web";
	if (preferred !== "") names.push(preferred);
	try {
		for (const entry of readdirSync(profiles, { withFileTypes: true })) {
			if (entry.isDirectory() && !names.includes(entry.name)) names.push(entry.name);
		}
	} catch {
		// 没有 profiles 目录（纯单测环境）就只试首选名。
	}
	return names.map((name) => join(profiles, name, "package.json"));
}

/** 尝试加载官方 `createUserMessage`。 */
function loadFactory() {
	const bases = [import.meta.url, ...profileManifests().map((file) => pathToFileURL(file).href)];
	for (const base of bases) {
		try {
			const required = createRequire(base)("@deepseek-ai/dsh-llm");
			if (typeof required?.createUserMessage === "function") return required.createUserMessage;
		} catch {
			// 换下一个基址。
		}
	}
	return null;
}

/**
 * 本地兜底：满足 DSH 会话校验的全部不变量，且不可变。
 * @param input - `{ content, source }`。
 * @returns identified user message。
 */
function localUserMessage(input) {
	return Object.freeze({
		...input,
		role: "user",
		id: randomUUID(),
	});
}

/**
 * 造一条带唯一 id 的 user message。
 * @param input - `{ content: [{type:"text",text}], source: {kind, ...} }`。
 * @returns 可直接传给 `agent.followup()` 的消息。
 */
export function createVoiceUserMessage(input) {
	if (cachedFactory === undefined) cachedFactory = loadFactory();
	if (cachedFactory !== null) {
		try {
			return cachedFactory(input);
		} catch {
			// 官方 helper 版本差异导致失败时，仍用本地兜底，不让委托整体断裂。
		}
	}
	return localUserMessage(input);
}
