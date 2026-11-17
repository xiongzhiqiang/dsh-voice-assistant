/**
 * 常驻语音 agent（宿主半）。
 *
 * ## 这个模块解决什么
 *
 * 让「小凤」成为一个 **DSH 层的常驻 agent**，而不是某个 UI 会话的附属品：
 *
 * - 用户不需要打开任何会话；语音指令直接进这个 agent 的收件箱；
 * - 它的 session 只是**持久记忆载体**（agent loop 的地基），界面上可看可不看；
 * - DSH 重启后 `resume` 同一个 session，记忆不断（依赖 sessionPersistence）；
 * - 工具调用、权限审批、askuser 全部走 DSH 官方循环，我们不重写任何执行逻辑。
 *
 * ## 为什么全部经 `ctx` 服务而不 import 运行时包
 *
 * 本插件以 junction 装进 `profiles/web/node_modules`，Node 会把模块解析到
 * **真实路径**（`WorkBuddy/DSH_dev/…`），那条链上没有 `@deepseek-ai/*`。
 * 所以对 `ctx.agents` / `ctx.systemPrompt` / `ctx.approval` 一律软取
 * （`ctx.get(...)`），类型只在注释里引用 —— 缺服务时降级而不是崩溃。
 *
 * ## 身份与生命周期
 *
 * `sessionId` 是稳定标识：create 用它，重启后 resume 也用它。agent 由本插件
 * 的作用域持有（`ctx.inject(["agents"], …)` 的子 scope），插件卸载时连同
 * `AgentHandle.dispose()` 一起收掉 —— 不会留下孤儿 agent。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 常驻 agent 的默认 session 标识（稳定，跨重启）。 */
export const DEFAULT_AGENT_SESSION_ID = "session-voice-assistant-root";

/**
 * 默认人格段（会被朗读，所以约束输出形态）。
 *
 * 写成"硬约束 + 正面指令"而不是一堆"不要"：模型对"句子要短、先给结论"
 * 这类正面指令的服从率远高于"不要长篇大论"。
 */
export const DEFAULT_PERSONA = [
	"你是「小凤」，一个常驻的语音助手。用户通过语音与你对话，你的回复会被逐句朗读。",
	"输出形态约束：口语化、句子简短、先给结论再给细节；避免 Markdown 表格、代码块和长列表——它们无法被朗读。",
	"需要执行操作时直接调用工具；需要用户确认时使用提问工具，把问题说清楚。",
	"用户在休眠或离开时你收到的消息会在下次唤醒时处理，不要假设用户一直在线。",
].join("\n");

/**
 * 解析常驻 agent 的 cwd（工具的落地目录）。
 *
 * 优先级：配置显式指定 → 第一个工作区的路径（与 UI 会话的默认口径一致）→
 * 用户主目录。工作区清单在 `~/.dsh/storages/workspace.json`（DSH_HOME 可覆盖），
 * 读不到就静默退回主目录 —— 一个常驻助手宁可站错目录也不能起不来。
 *
 * @param config - 归一化配置。
 * @returns 绝对路径。
 */
export function resolveAgentCwd(config) {
	if (config.agent.cwd !== "") return config.agent.cwd;
	const root = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	try {
		const store = JSON.parse(readFileSync(join(root, "storages", "workspace.json"), "utf8"));
		const first = store?.global?.workspaceIds?.[0];
		const path = store?.tables?.workspaces?.[first]?.path;
		if (typeof path === "string" && path.trim() !== "") return path;
	} catch {
		// 没有工作区清单（全新安装）就用主目录。
	}
	return homedir();
}

/**
 * 从 agent 提取可下发的状态。
 * @param agent - 常驻 agent（可能为 null）。
 * @returns JSON 安全的状态对象。
 */
export function agentInfo(agent) {
	if (agent === null || agent === undefined) return { available: false, sessionId: "", status: "", model: "" };
	let model = "";
	try {
		const current = agent.model?.current?.();
		if (current !== undefined && current !== null) model = `${current.provider}/${current.model}`;
	} catch {
		// 模型投影未就绪不影响"agent 是否可用"这个事实。
	}
	return {
		available: true,
		sessionId: agent.id,
		status: agent.status ?? "idle",
		model,
	};
}

/**
 * 解析常驻 agent 该用的模型路由。
 *
 * **这是本插件最容易静默失败的一环。** `registry.create()` 不传 `agentOptions`
 * 时，`ReactLoopAgent.model.current()` 会因为「既没有持久化的 `model/selection`
 * 事件、也没有 options.provider/model」而返回 `undefined`；随后第一个 turn 在
 * `preStep` 里直接抛
 * `agent "…" has no provider/model: set AgentOptions.provider and AgentOptions.model or record a model selection`。
 * 现象极具迷惑性：turn 开了、inbox 消息被 claim 走了、turn/end 立刻落地，
 * 看起来像"driver 没消费消息"，实际是**没有模型可跑**。
 *
 * 所以路由有两个来源，顺序与 DSH 自身一致：
 *   1. 插件配置显式写死的 `agent.provider` / `agent.model`（留空则跳过）；
 *   2. 宿主 `agentDefaultModel.currentSelection()` —— 即用户在界面上选的那个模型。
 *
 * @param ctx - 宿主上下文（读 `agentDefaultModel` 服务）。
 * @param config - 归一化配置。
 * @returns `{provider, model, reasoningEffort?}`；两处都拿不到时返回 `null`。
 */
export function resolveAgentSelection(ctx, config) {
	const provider = config.agent.provider;
	const model = config.agent.model;
	if (provider !== "" && model !== "") return { provider, model };
	const defaultModel = ctx.get?.("agentDefaultModel") ?? ctx.agentDefaultModel;
	const selection = typeof defaultModel?.currentSelection === "function" ? defaultModel.currentSelection() : undefined;
	if (
		selection !== null &&
		typeof selection === "object" &&
		typeof selection.provider === "string" &&
		selection.provider !== "" &&
		typeof selection.model === "string" &&
		selection.model !== ""
	) {
		return {
			provider: selection.provider,
			model: selection.model,
			...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
		};
	}
	return null;
}

/**
 * 把模型路由落到 agent 上（持久化为 `model/selection` 事件）。
 *
 * 复刻 `dsh-agent-loop` 的 `applyConfiguredRoute`：幂等，已记录同一路由时
 * `AgentModel.select` 自己会短路。放在 setup 里是为了**同时覆盖 create 与
 * resume** —— 旧会话如果是在缺路由的版本下建的，resume 回来同样需要补一次。
 *
 * @param agent - 刚构造出的（尚未发布的）agent。
 * @param selection - `resolveAgentSelection` 的产物（可能为 null）。
 * @returns 是否真的写入了路由。
 */
export function applyAgentRoute(agent, selection) {
	if (selection === null) return false;
	const model = agent?.model;
	if (model === undefined || model === null || typeof model.select !== "function") return false;
	try {
		model.select(selection);
		return true;
	} catch {
		// select 失败不应带崩 agent 创建：health 里的 model 字段会显示为空，
		// 用户据此能看出"路由没落上"。
		return false;
	}
}

/** `agentDefaultModel` 等待上界（ms）。等不够就带着空路由继续，由 health 暴露。 */
const DEFAULT_MODEL_WAIT_MS = 8000;
/** 轮询间隔（ms）。 */
const DEFAULT_MODEL_POLL_MS = 400;

/**
 * 解析模型路由，必要时**有界等待** `agentDefaultModel` 上线。
 *
 * 为什么需要等：本插件软注入 `agentLoop` 时就建 agent，而 `agentDefaultModel`
 * 是同层的另一个服务、挂载顺序不保证。若它此刻还没上线，`currentSelection()`
 * 拿不到、配置里也没写死路由，agent 就会带着空路由发布 —— 之后每个 turn 都
 * 静默失败。等一小段时间的代价远低于"用户说完话什么反应都没有"。
 *
 * @param ctx - 宿主上下文。
 * @param config - 归一化配置。
 * @returns 路由，或 `null`（等满仍没有）。
 */
async function resolveAgentSelectionWaiting(ctx, config) {
	const immediate = resolveAgentSelection(ctx, config);
	if (immediate !== null) return immediate;
	// 配置里写死了就轮不到等 —— resolveAgentSelection 已经返回了。
	const deadline = Date.now() + DEFAULT_MODEL_WAIT_MS;
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, DEFAULT_MODEL_POLL_MS));
		const late = resolveAgentSelection(ctx, config);
		if (late !== null) {
			ctx.logger?.info?.(`voice-assistant: agentDefaultModel 延迟就绪，模型路由补获成功（${late.provider}/${late.model}）`);
			return late;
		}
		if (Date.now() >= deadline) return null;
	}
}

/**
 * 给 agent 作用域挂一个 **Agent preset**（能力集）。
 *
 * ## 为什么必须有这一步（坑十三，实测）
 *
 * `registry.create()` 建的 agent **不带任何 preset**：工具目录里只有
 * 各插件全局贡献的工具（working_directory、团队任务板、memory 等），
 * **没有文件读写与命令执行**。web 界面会话之所以有 bash/fs 工具，是
 * session-controller 在 create/resume 的 setup 里调了
 * `agentPresets.resolve()` + `mount(agentCtx, id)` —— preset 才是工具集
 * 的来源。本插件此前没走这一步，于是编程专家「阿码」只有目录切换工具，
 * 写不了文件、跑不了命令。
 *
 * `mount` 与 session-controller 的用法完全一致（它是官方同款路径）；
 * setup 回调会被 agent-loop `await`（`raceAbort(setup?.(...))`），
 * 所以这里允许 async。
 *
 * 失败一律**可见降级**（返回 reason），绝不带崩 agent 创建 —— 与模型
 * 路由同一纪律：能力缺失时 health 里要能看出来。
 *
 * @param agentCtx - agent 的作用域上下文（setup 第一个参数）。
 * @param presetId - preset 标识；空串表示显式关闭（不挂）。
 * @returns `{mounted, id?, broken?, reason?}`。
 */
export async function mountAgentPreset(agentCtx, presetId) {
	if (presetId === "" || presetId === "none") return { mounted: false, reason: "off" };
	let presets;
	try {
		presets = agentCtx?.get?.("agentPresets") ?? agentCtx?.agentPresets;
	} catch (error) {
		return { mounted: false, reason: `get-threw: ${String(error?.message ?? error)}` };
	}
	if (presets === undefined || presets === null) return { mounted: false, reason: "service-missing" };
	if (typeof presets.resolve !== "function" || typeof presets.mount !== "function") {
		return { mounted: false, reason: "service-incomplete" };
	}
	try {
		const resolved = await presets.resolve(presetId);
		const mounted = await presets.mount(agentCtx, resolved.id);
		return {
			mounted: true,
			id: (mounted && typeof mounted.id === "string" ? mounted.id : resolved.id),
			...(resolved?.broken === undefined ? {} : { broken: String(resolved.broken) }),
		};
	} catch (error) {
		return { mounted: false, reason: String(error?.message ?? error) };
	}
}

/**
 * 在 agent 作用域里挂人格段、模型路由、能力集 preset 与应答器（setup 回调）。
 *
 * 人格段用**独立 section 名**而不是覆盖 `deployment:persona-prefix`：
 * 覆盖会连带抹掉部署方人格，独立 section 只是追加，风险面小得多。
 *
 * 模型路由**必须在这里落**：它是 create 与 resume 的唯一公共入口。
 *
 * preset 挂载同理（create/resume 的公共入口）；setup 回调被 agent-loop
 * `await`，所以本函数是 async。
 *
 * @param agentCtx - 未发布的 agent 作用域上下文。
 * @param config - 归一化配置。
 * @param bridges - 可选的应答桥（`{ attachAnswerers }`，见 answers.js）。
 * @param agent - 刚构造出的 agent（用于写模型路由）。
 * @param routeHint - 调用方预先解析好的路由（setup 里解析不到时的兜底）。
 * @returns `{ modelApplied, selection, preset }` —— 排障用，宿主日志会带上。
 */
export async function composeAgentScope(agentCtx, config, bridges = {}, agent = undefined, routeHint = null) {
	const systemPrompt = agentCtx.get?.("systemPrompt") ?? agentCtx.systemPrompt;
	if (typeof systemPrompt?.section === "function" && config.agent.persona !== "") {
		// 中心分配的 persona-prefix 槽位拿不到时退回一个中段常量：
		// 实测 getSectionOrder 对未知名返回 undefined，直接喂给 section 会
		// 抛 "order must be a finite number"，agent 创建整体失败。
		let order = 1000;
		if (typeof systemPrompt.getSectionOrder === "function") {
			const slot = systemPrompt.getSectionOrder("persona-prefix");
			if (typeof slot === "number" && Number.isFinite(slot)) order = slot + 1;
		}
		systemPrompt.section({
			name: "voice-assistant:persona",
			order,
			text: config.agent.persona,
			interpolate: false,
		});
	}
	// setup 里的 agentCtx 能看见根服务时以它为准（最新真相），否则用调用方的预先解析值。
	const selection = resolveAgentSelection(agentCtx, config) ?? routeHint ?? null;
	const modelApplied = applyAgentRoute(agent, selection);
	if (typeof bridges.attachAnswerers === "function") bridges.attachAnswerers(agentCtx, config);
	// 能力集：与官方 session-controller 同款路径（见 mountAgentPreset 注释）。
	const preset = await mountAgentPreset(agentCtx, config.agent.preset);
	return { modelApplied, selection, preset };
}

/**
 * 确保「小凤」常驻 agent 存在（get → resume → create 三级）。
 *
 * 顺序有讲究：get 优先（同进程内插件热重载时不重复建）；其次 resume
 * （跨进程保留记忆，要求 persist 开且 sessionPersistence 服务在）；最后
 * 才 create。resume 失败（比如从未持久化过）不是错误，落到 create。
 *
 * **时序坑（实测）**：`agents` 注册表在 `dsh-agent` 里就绪，但创建工厂
 * 由 `dsh-agent-loop` 稍后注册 —— 插件加载期立刻 create 会撞
 * "no agent factory registered"。所以调用方应软注入 **`agentLoop`** 服务
 * （它出现即工厂已挂），本函数再留一层短重试兜底。
 *
 * **模型路由坑（实测，比时序坑更隐蔽）**：create/resume 都必须能拿到
 * 模型路由，否则第一个 turn 会在 `preStep` 抛 "has no provider/model"，
 * 表现为"turn 开了又立刻结束、消息像没被消费"。这里同时做两件事：
 *   1. 把解析出的路由塞进 `agentOptions.{provider,model}`（活路由兜底）；
 *   2. 在 setup 里 `agent.model.select(...)`（写持久 `model/selection` 事件）。
 * 两层都做是因为 DSH 的 `AgentModel.current()` 先看投影、再看 options —— 只
 * 有当两层都缺失时才会 undefined。
 *
 * @param ctx - 宿主 Cordis 上下文（须已注入 `agents`）。
 * @param config - 归一化配置。
 * @param bridges - 可选的应答桥。
 * @returns `{ agent, handle, dispose, source, modelApplied, selection }`；拿不到 registry 时返回 `null`。
 */
export async function ensurePersistentAgent(ctx, config, bridges = {}) {
	const registry = ctx.get?.("agents") ?? ctx.agents;
	if (registry === undefined || registry === null) return null;

	const sessionId = config.agent.sessionId;
	/** 每次 setup 都把路由落一次，并记录结果供 health 排障。 */
	let modelApplied = false;
	let selectionSeen = null;
	/** preset 挂载结果（create/resume 公共入口里记录，health 暴露）。 */
	let presetSeen = null;
	const setup = async (agentCtx, agent) => {
		const outcome = await composeAgentScope(agentCtx, config, bridges, agent, route);
		if (outcome.selection !== null) selectionSeen = outcome.selection;
		if (outcome.modelApplied) modelApplied = true;
		presetSeen = outcome.preset;
	};
	// options 里的路由是"活兜底"：投影为空时 current() 回落到这里。
	// 这里先填 —— 但 setup 里会再解析一次（那时 agentDefaultModel 一定已就绪），
	// 所以即便此刻为空，setup 仍能补上。
	const route = await resolveAgentSelectionWaiting(ctx, config);
	const agentOptions = route === null ? {} : { provider: route.provider, model: route.model, ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) };

	const live = typeof registry.get === "function" ? registry.get(sessionId) : undefined;
	if (live !== undefined && live !== null) {
		// 热重载路径：agent 已在，setup 不会重跑 —— 补一次路由，避免旧实例无模型。
		const applied = applyAgentRoute(live, route);
		return {
			agent: live,
			handle: null,
			dispose: () => {},
			source: "live",
			modelApplied: applied,
			selection: selectionSeen ?? route,
			preset: presetSeen,
		};
	}

	const canPersist =
		config.agent.persist === true &&
		(ctx.get?.("sessionPersistence") ?? ctx.sessionPersistence) !== undefined;

	let resumeError = null;
	if (canPersist && typeof registry.resume === "function") {
		try {
			const handle = await registry.resume({ resumeSessionId: sessionId, agentOptions, setup });
			return {
				agent: handle.agent,
				handle,
				dispose: () => handle.dispose(),
				source: "resumed",
				modelApplied,
				selection: selectionSeen ?? route,
				preset: presetSeen,
			};
		} catch (error) {
			// 没有可恢复的历史（首次安装）是正常路径；其他原因记一条再走 create。
			resumeError = error;
			ctx.logger?.warn?.(
				`voice-assistant: 常驻 agent resume 未命中（${String(error?.message ?? error)}），改为新建`,
			);
		}
	}

	if (typeof registry.create !== "function") return null;

	// 工厂未就绪的短重试：注入 agentLoop 已消掉 99% 的时序问题，
	// 这里只兜"loop 服务先出、工厂注册略晚"的极端窗口。
	const FACTORY_MISSING = /no agent factory registered/i;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		try {
			const handle = await registry.create({
				sessionId,
				meta: { cwd: resolveAgentCwd(config) },
				agentOptions,
				setup,
			});
			return {
				agent: handle.agent,
				handle,
				dispose: () => handle.dispose(),
				source: "created",
				modelApplied,
				selection: selectionSeen ?? route,
				preset: presetSeen,
			};
		} catch (error) {
			const message = String(error?.message ?? error);
			// 真机时序坑：resume 发生时 sessionPersistence 还没完全就绪 → resume 失败；
			// 紧接着 create 却发现会话**已经在磁盘上**，报 "session already exists"。
			// 结果是没有 agent 被注册（health 里前几位 worker 全红、后几位好的）。
			// 正解是"已存在"时回头再 resume，而不是直接判失败。
			if (/already exists/i.test(message) && canPersist && typeof registry.resume === "function") {
				for (let retry = 0; retry < 6; retry += 1) {
					await new Promise((resolve) => setTimeout(resolve, 300 * (retry + 1)));
					try {
						const handle = await registry.resume({ resumeSessionId: sessionId, agentOptions, setup });
						return {
							agent: handle.agent,
							handle,
							dispose: () => handle.dispose(),
							source: "resumed-after-exists",
							modelApplied,
							selection: selectionSeen ?? route,
							preset: presetSeen,
						};
					} catch (next) {
						resumeError = next;
					}
				}
				throw new Error(`${message}; resume 仍失败：${String(resumeError?.message ?? resumeError)}`);
			}
			if (!FACTORY_MISSING.test(message) || attempt === 7) {
				// resume 的真实原因必须带出来 —— 只报 create 的 "already exists"
				// 会把时序问题伪装成"会话重复"，排障时会查错方向。
				if (resumeError !== null) {
					throw new Error(`${message}; resume 失败：${String(resumeError?.message ?? resumeError)}`);
				}
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 600));
		}
	}
	throw new Error("unreachable");
}
