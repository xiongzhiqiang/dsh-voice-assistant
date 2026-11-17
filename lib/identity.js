/**
 * 常驻助手在 DSH 里的两件"身份"工作（宿主半）：
 *   ① 给常驻会话一个**可辨识的标题**（"隐藏"在 DSH 里不可行，见下）；
 *   ② 把「记忆」注册成**全局** prompt 段。
 *
 * ## 为什么常驻会话是"标注"而不是"隐藏"
 *
 * 需求原文是"把常驻会话隐藏，让它一直存在"。DSH 里能"让会话不出现在侧边栏"
 * 的机制有三条，**全部会把助手弄坏**（读源码 + 本机实测确认）：
 *
 * | 做法 | 后果 | 证据 |
 * |---|---|---|
 * | `workspace.archiveSession(id)` | 助手**彻底哑掉**：本 profile 注册了归档闸门，对 `agent/pre-step` 直接 `reject` | `dsh-api-session-controller/lib/index.js:3824` 注册；`lib/types/archived-session-gate.js:21` 判定 |
 * | `meta.origin:'subagent'` | 会话**连不上**：宿主按普通 id 访问时抛 `session/agent-busy` | `lib/index.js:1156`；客户端 `lib/types/client/sessions.d.ts` 的 `subagentAddress` 在无 `parentSession` 时退成 `kind:'session'`，正好撞上这道校验 |
 * | 让 `blank` 保持为真 | 只撑到**第一次 `turn/start`** | `lib/types/list.js:30`：`blank = state.blank && event.type !== 'turn/start'` |
 *
 * 三条的共同点是"藏起来了，但助手也废了"。所以这里换一条**不损坏功能**的路：
 * 会话照常存在、照常可点开，只是标题明确写出它是谁 —— 用户不会把它误认成
 * 自己的对话。这是"可见性与可用性"之间唯一不亏的选择。
 *
 * ## 为什么用 `sessionTitle.rename` 而不是写 header
 *
 * `rename(session, title)` 会追加一条 `session/title` 事件，来源记为 `user`，
 * 而 `user` 来源**会把标题钉住**（后续自动生成不再覆盖它）。这正好是我们
 * 要的语义：标注是稳定的，不会被 agent 的自动起名改掉。
 *
 * ## 全局记忆为什么必须注册在根作用域
 *
 * `systemPrompt.section()` 用 `this.layers.effect(this.ctx, …)` 决定作用域 ——
 * 即**调用时服务自身所在的那个 ctx**。插件 `apply(ctx)` 拿到的是根 ctx，
 * 在那里注册就是全局（对所有会话生效）；而 `composeAgentScope` 里用的是
 * agent ctx，注册出来的段只对常驻这一只 agent 生效。两者差别就在这一层。
 */

/**
 * 给常驻会话打上可辨识的标注标题。
 *
 * 幂等且**不覆盖用户的手工改名**：先读当前标题快照，若来源已是 `user`
 * 且文本与我们想写的不一致，说明用户自己改过 —— 那就别动它。
 *
 * ## 为什么是 async 且带重试
 *
 * `sessionTitle` 与本插件的加载顺序不保证：agent 建好时该服务可能还没上线
 * （和 `agentDefaultModel` 是同一类时序坑，本项目已踩过）。写不上标题只是
 * "侧边栏显示自动起的名字"，不该让 agent 创建失败 —— 所以这里**有界重试**，
 * 等不到就安静放弃。
 *
 * @param ctx - 宿主 Cordis 上下文。
 * @param agent - 常驻 agent（提供 `session`）。
 * @param label - 想写上的标注（空串表示不改）。
 * @param options - `{ attempts, intervalMs }`，用于测试时缩短等待。
 * @returns 是否真的写入了标题。
 */
export async function labelAgentSession(ctx, agent, label, options = {}) {
	if (typeof label !== "string" || label.trim() === "") return false;
	const wanted = label.trim();
	const session = agent?.session;
	if (session === undefined || session === null) return false;

	const attempts = Number.isSafeInteger(options.attempts) ? options.attempts : 10;
	const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 400;

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const title = ctx.get?.("sessionTitle") ?? ctx.sessionTitle;
		if (title !== undefined && title !== null && typeof title.rename === "function") {
			try {
				// 用户改过名就尊重用户的（`user` 来源 + 文本不同 = 手工改名）。
				if (typeof title.get === "function") {
					const current = title.get(session);
					if (current !== undefined && current !== null) {
						if (current.title === wanted) return false;
						if (current.source?.kind === "user") return false;
					}
				}
				title.rename(session, wanted);
				return true;
			} catch {
				// 会话未就绪 / 服务正在销毁 —— 都是可重试的瞬时态。
			}
		}
		if (attempt < attempts - 1) await delay(intervalMs);
	}
	return false;
}

/**
 * 等一小段（内部用，避免在模块顶层引依赖）。
 * @param ms - 毫秒。
 */
function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 确保常驻会话**不在归档集合里** —— 这是本插件最容易"哑掉"的单点故障的自愈。
 *
 * ## 为什么必须有这道自愈（真机踩过，代价极大）
 *
 * `workspaceRegistry.archivedSessionIds` 是**持久化**状态（存在
 * `~/.dsh/storages/workspace.json`）。而本 profile 注册了 `ArchivedSessionGate`
 * （`dsh-api-session-controller`），它对每一轮 `agent/pre-step` 直接返回
 * `{kind:"reject"}`；`dsh-agent-loop` 收到 reject 后把这一轮记成
 * `turn/end reason={"kind":"blocked"}` 并**不发起任何模型请求**。
 *
 * 于是故障链条是：
 *
 * ```
 * 会话 id 进了归档集合（一次误操作/一次实验/一个旧版本遗留）
 *   → 每轮 agent/pre-step 被 reject
 *   → turn 一开就结束、没有任何 step
 *   → 语音球：提交成功、状态回弹、界面无报错、永远没有回答
 * ```
 *
 * **最坏的失败模式**：`prompt()` 的原始返回是
 * `{"ok":true,"value":{"accepted":true}}`（提交确实成功了），所以从客户端看
 * "一切正常"，只有翻会话事件流才能看到 `blocked`。用户只会觉得"它不理我"。
 *
 * 本项目实测复现过一次：清掉 `workspace.json` 里这条 id 后，同一句指令
 * 立刻从 `turn/end {"kind":"blocked"}` 变成
 * `step/start → assistant/message text=等于二。 → turn/end {"kind":"completed"}`。
 *
 * ## 为什么在这里做而不是让用户自己修
 *
 * 归档集合是**跨会话共享的持久状态**，插件没有任何理由让它包含自己的常驻会话
 * —— 那一定是个错误状态，不存在"用户故意归档了常驻助手"的正当情形（归档它
 * 等于关掉这个插件的全部功能）。所以启动时读一次、发现就摘掉，是安全的收敛。
 *
 * 反过来，若只记一条日志让用户去手改 JSON，等于把"助手为什么哑了"这个
 * 极难定位的问题留给用户 —— 这正是本项目要消灭的失败模式。
 *
 * ## 为什么是有界重试
 *
 * `workspaceRegistry` 与本插件的加载顺序不保证（和 `agentDefaultModel` /
 * `sessionTitle` 是同一类时序坑，见本文件其它函数）。读不到就等一会儿再读，
 * 等不到就安静放弃 —— 摘归档失败不该让 agent 创建失败。
 *
 * @param ctx - 宿主 Cordis 上下文。
 * @param sessionId - 常驻会话 id。
 * @param options - `{ attempts, intervalMs }`，测试时缩短等待用。
 * @returns `{ checked, archived, lifted, reason }` —— 供 health 与日志排障。
 */
export async function ensureSessionNotArchived(ctx, sessionId, options = {}) {
	const id = typeof sessionId === "string" ? sessionId.trim() : "";
	if (id === "") return { checked: false, archived: false, lifted: false, reason: "no-session-id" };

	const attempts = Number.isSafeInteger(options.attempts) ? options.attempts : 10;
	const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 400;

	for (let attempt = 0; attempt < attempts; attempt += 1) {
		// ⚠️ 取服务**必须**包 try/catch（真机踩过，而且极隐蔽）：
		// Cordis 里对**未声明 inject 的服务**访问会直接抛
		// `cannot get property "workspaceRegistry" without inject`，
		// 而这不是"返回 undefined"，是**同步抛出**。若调用方传进来的是
		// 一个限定作用域（例如 `ctx.inject(["agentLoop"], scope => …)` 里的
		// scope，它只看得见 agentLoop），这里就会每次都抛，被上层的空 catch
		// 吞掉 —— 现象是"自愈逻辑写了却完全没跑"（`archivedFix` 恒为 null）。
		// 所以这里自己兜住，并把真实原因写进返回值，让 health 看得见。
		let registry;
		try {
			registry = ctx.get?.("workspaceRegistry") ?? ctx.workspaceRegistry;
		} catch (error) {
			return { checked: false, archived: false, lifted: false, reason: `get-threw: ${String(error?.message ?? error)}` };
		}
		if (registry !== undefined && registry !== null) {
			const archived = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : null;
			// 服务在、但读不出集合：无法判断，当"查过了、没归档"处理，
			// 免得每次启动都刷一条误导性的告警。
			if (archived === null) return { checked: false, archived: false, lifted: false, reason: "no-archive-set" };
			if (!archived.includes(id)) return { checked: true, archived: false, lifted: false, reason: "not-archived" };
			if (typeof registry.unarchiveSession !== "function") {
				return { checked: true, archived: true, lifted: false, reason: "no-unarchive-method" };
			}
			try {
				await registry.unarchiveSession(id);
				// 复核：`unarchiveSession` 是异步持久化，await 后应当已生效。
				const after = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds : [];
				return { checked: true, archived: false, lifted: !after.includes(id), reason: "unarchived" };
			} catch (error) {
				return { checked: true, archived: true, lifted: false, reason: `unarchive-failed: ${String(error?.message ?? error)}` };
			}
		}
		if (attempt < attempts - 1) await delay(intervalMs);
	}
	return { checked: false, archived: false, lifted: false, reason: "registry-unavailable" };
}

/**
 * 把「记忆」注册成全局 prompt 段。
 *
 * 段名固定为 `voice-assistant:memory`：`section` 在同一层里同名会抛错，
 * 所以同名正好起**幂等**作用 —— 重复调用（插件热重载）时旧段会先随
 * 上一个 fiber 卸载，不会叠加。
 *
 * 注册在**调用方 ctx 的作用域**里，所以必须由根 ctx 调用。返回 disposer，
 * 调用方负责挂到自己的 effect 上（插件卸载时摘掉，不留全局污染）。
 *
 * @param ctx - 宿主上下文（必须是**根**作用域才全局生效）。
 * @param config - 归一化配置。
 * @returns `{ active, order }` —— 是否真的注册了，以及落到的 order。
 */
export function registerGlobalMemory(ctx, config) {
	if (config.memory?.global !== true) return { active: false, order: null };
	const text = typeof config.memory.text === "string" ? config.memory.text.trim() : "";
	// 开了开关但正文为空：视为未启用，而不是注册一个空段。
	if (text === "") return { active: false, order: null };
	const systemPrompt = ctx.get?.("systemPrompt") ?? ctx.systemPrompt;
	if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.section !== "function") {
		return { active: false, order: null };
	}
	// 放在人格段之前（人格段用 persona-prefix + 1）：记忆是"关于用户/环境的事实"，
	// 更适合出现在行为约束之前，让后续的人格与任务指令在它之上收束。
	let order = 900;
	if (typeof systemPrompt.getSectionOrder === "function") {
		const slot = systemPrompt.getSectionOrder("persona-prefix");
		if (typeof slot === "number" && Number.isFinite(slot)) order = slot;
	}
	try {
		systemPrompt.section({
			name: "voice-assistant:memory",
			order,
			text,
			interpolate: false,
		});
		return { active: true, order };
	} catch {
		// 注册失败（同名冲突/作用域已失效）不影响语音链路，只是"记忆没生效"。
		return { active: false, order: null };
	}
}
