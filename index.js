/**
 * 「小凤」语音助手 —— DSH bundle 插件（宿主半）。
 *
 * ## 这个插件解决什么
 *
 * 让 DeepSeek Harness 从「打字对话」变成「对着电脑说话」：
 * 常驻待机 → 喊「小凤」唤醒 → 说话 → 自动润色 → 进入会话 → 念出回答；
 * 静默 1 分钟自动休眠，休眠后由提示音或 agent 消息唤醒。
 *
 * ## 宿主半 / 客户端半怎么分工
 *
 * | 职责 | 半边 | 原因 |
 * |---|---|---|
 * | 麦克风、唤醒词、播报 | 客户端 | 音频设备在浏览器里 |
 * | 状态机、休眠计时、字幕 | 客户端 | 全部是本地交互状态 |
 * | 会话写入、事件订阅 | 客户端 | 走 DSH 官方 `ctx.sessions` |
 * | 转录润色 | **宿主** | 复用 DSH 已配模型，不必再配 key |
 * | ASR/TTS 上游代理 | **宿主** | 密钥不外泄、绕开 CORS |
 *
 * ## 为什么配置要走 `index-inject`
 *
 * 客户端 bundle 的 `apply(ctx, config)` 拿到的是**客户端侧**配置，
 * 而 `cordis.patch.yml` 写的是插件级配置；两者不通。宿主半用
 * `webserver/index-inject` 把归一化后的安全配置编成
 * `<script>globalThis["…"] = {…}</script>` 塞进首帧，
 * 客户端 bundle 求值时即可读到 —— 比等一次 HTTP 往返早一帧，
 * 界面不会出现"先渲染默认值再跳变"的闪烁。
 *
 * ## 失败策略
 *
 * 没有 `webServer`（纯 CLI 场景）时**整段宿主职责跳过、插件照常加载**：
 * 客户端半此时会自检发现拿不到配置，退化为手动热键模式而不是崩溃。
 */
import { clientConfig, normalizeConfig } from "./lib/config.js";
import { API_PREFIX, installApiRoutes } from "./lib/routes.js";
import { agentInfo, ensurePersistentAgent } from "./lib/agent.js";
import { ensureWorkerAgents } from "./lib/workers.js";
import { labelAgentSession, registerGlobalMemory, ensureSessionNotArchived } from "./lib/identity.js";

/** 插件名（fiber 诊断与日志前缀）。 */
export const name = "dsh-voice-assistant";

/**
 * 软依赖：`webServer` 存在才装宿主职责。
 * 不写成硬 `inject`，是为了在无 Web 载体的 profile 里也能安全加载。
 */
export const inject = [];

/** 下发给客户端半的全局变量名。 */
const CLIENT_CONFIG_GLOBAL = "__VOICE_ASSISTANT_CONFIG__";

/**
 * 插件主体。
 * @param ctx - 宿主 Cordis 上下文。
 * @param config - `cordis.patch.yml` 中 `voice-assistant` 条目的 `config`。
 */
export function apply(ctx, config = {}) {
	const normalized = normalizeConfig(config);

	/** 常驻 agent 的运行态（get/create 之间为 pending）。 */
	let agentRef = null;
	/** 常驻 agent 的最近一次失败原因（排障用，health 可见）。 */
	let agentError = "";
	/** 全局记忆是否已注册（health 可见）。 */
	let memoryActive = false;
	/** 常驻会话的标注是否已写入（health 可见）。 */
	let labeled = false;
	/**
	 * 归档自愈的结果（health 可见）。
	 *
	 * 常驻会话一旦躺在 `workspaceRegistry.archivedSessionIds` 里，本 profile 的
	 * `ArchivedSessionGate` 会让**每一轮** `agent/pre-step` 被 reject，于是
	 * `turn/end` 恒为 `{"kind":"blocked"}`、永远不发起模型请求。而提交本身是
	 * 成功的（`prompt()` 返回 `{ok:true}`），所以界面上**看不出任何异常**。
	 * 详见 lib/identity.js 的 `ensureSessionNotArchived`。
	 */
	let archivedFix = null;
	/**
	 * Worker 专家 agent 的建立结果（health 与路由层共用；`routing.enabled`
	 * 为假时恒为空数组 = 两层架构关闭）。
	 */
	let workersStatus = [];
	/**
	 * 根 agent 的 preset 挂载结果（坑十三：不挂 preset 的 agent 没有文件/命令
	 * 工具；health 可见，`{mounted,id?|reason?}`）。
	 */
	let presetStatus = null;

	/**
	 * 宿主自省：客户端据此判断"这条能力到底可用不可用"，而不是先请求再失败。
	 * 每次调用都重新读一遍，因为 agent 的状态是活的（idle/running）。
	 */
	const state = () => {
		const llm = ctx.get("llm");
		const defaultModel = ctx.get("agentDefaultModel");
		const selection = typeof defaultModel?.currentSelection === "function" ? defaultModel.currentSelection() : undefined;
		const polishModel =
			normalized.polish.provider !== "" && normalized.polish.model !== ""
				? `${normalized.polish.provider}/${normalized.polish.model}`
				: selection
					? `${selection.provider}/${selection.model}`
					: "";
		return {
			version: "0.1.0",
			agent: agentInfo(agentRef?.agent ?? null),
			agentError,
			/** preset 挂载结果（`{mounted,id}` 或 `{mounted:false,reason}`）。 */
			preset: presetStatus,
			memoryActive,
			labeled,
			/** 归档自愈：`{checked,archived,lifted,reason}` 或 null（未跑）。 */
			archivedFix,
			/** 两层架构：路由开关 + worker 专家清单及各自就绪状态。 */
			routing: {
				enabled: normalized.routing.enabled,
				workers: workersStatus,
			},
			capabilities: {
				polishAvailable: typeof llm?.stream === "function" && polishModel !== "",
				polishModel,
				asrHttpReady: normalized.asr.http.baseURL !== "",
				ttsHttpReady: normalized.tts.http.baseURL !== "",
				agentAvailable: agentRef !== null,
				memoryActive,
			},
			sleep: { idleTimeoutMs: normalized.sleep.idleTimeoutMs, keepWakeWord: normalized.sleep.keepWakeWord },
			wake: { word: normalized.wake.word, aliases: normalized.wake.aliases },
		};
	};

	ctx.logger?.info?.(
		`voice-assistant: 宿主半已就绪（唤醒词「${normalized.wake.word}」，休眠 ${Math.round(normalized.sleep.idleTimeoutMs / 1000)}s，API ${API_PREFIX}）`,
	);

	// 0) 全局记忆：注册在**根作用域**的 prompt 段，对 DSH 全部会话生效。
	//
	//    「隐藏常驻会话」在 DSH 里没有安全实现（归档会让助手哑掉、subagent 标记
	//    会让会话连不上，详见 lib/identity.js 的对照表），所以需求 ① 的落点是
	//    两件不损坏功能的事：**给常驻会话一个可辨识的标题**（下面）+ **把记忆
	//    做成全局的**（这里）。后者正交于会话可见性，是真正"一直存在、记得住"的部分。
	//
	//    这里必须用 `ctx`（根上下文）而不是某个子 scope：`systemPrompt.section()`
	//    按**调用时服务所在的 ctx**决定作用域，根 ctx 注册才是全局。
	{
		const memory = registerGlobalMemory(ctx, normalized);
		memoryActive = memory.active;
		if (memory.active) {
			ctx.logger?.info?.(
				`voice-assistant: 全局记忆已注册（order ${memory.order}，${normalized.memory.text.length} 字），对全部会话生效`,
			);
		} else if (normalized.memory.global) {
			ctx.logger?.warn?.(
				"voice-assistant: memory.global 已开启但未生效 —— 要么 memory.text 为空，要么 systemPrompt 服务不可用",
			);
		}
	}

	// 0) 常驻 agent：DSH 启动即存在，不依赖任何 UI 会话。
	//    软注入 `agentLoop`（而不是更早出现的 `agents` 注册表）：dsh-agent-loop
	//    挂起该服务时创建工厂必然已注册，避开 "no agent factory registered" 的
	//    启动时序窗。服务缺席（精简 profile）时插件照常加载，客户端发现
	//    agentAvailable=false 并退回「专用会话」模式。
	if (normalized.agent.enabled) {
		ctx.inject(["agentLoop"], (scope) => {
			let settled = false;

			// 0.5) Worker 专家 agent（两层架构的第二层）。与根 agent 并行建立：
			//      互不依赖（各自独立 session），且单个 worker 失败不连坐。
			//      路由关闭时清单纯占位（general 指向根 agent，无需建）。
			if (normalized.routing.enabled) {
				ensureWorkerAgents(ctx, scope, normalized, normalized.routing.workers)
					.then((results) => {
						workersStatus = results;
						const ready = results.filter((row) => row.ok === true).length;
						const total = results.length - 1; // general 不单建。
						scope.logger?.info?.(
							`voice-assistant: worker 专家层就绪（${ready}/${total} 可用${total === ready ? "" : "，未就绪的路由会跳过"}）`,
						);
					})
					.catch((error) => {
						workersStatus = [];
						scope.logger?.warn?.(
							`voice-assistant: worker 专家层建立失败（路由将全部落 general）—— ${String(error?.message ?? error)}`,
						);
					});
			}

			ensurePersistentAgent(scope, normalized)
				.then((result) => {
					settled = true;
					if (result === null) {
						agentError = "agents-registry-unavailable";
						scope.logger?.warn?.("voice-assistant: agents 注册表不可用，常驻 agent 未建立");
						return;
					}
				agentRef = result;
				presetStatus = result.preset;
				if (result.preset?.mounted === true) {
					scope.logger?.info?.(`voice-assistant: 常驻 agent 已挂 preset「${result.preset.id}」（文件/命令工具可用）`);
				} else if (normalized.agent.preset !== "none") {
					// 可见降级（与模型路由同一纪律）：能力缺失必须能从 health 看出来。
					scope.logger?.warn?.(
						`voice-assistant: preset「${normalized.agent.preset}」未挂上（${result.preset?.reason ?? "unknown"}）—— agent 将没有文件/命令工具`,
					);
				}
				scope.effect(() => () => result.dispose(), "voice-assistant: 常驻 agent 生命周期");
					// 给常驻会话打上可辨识的标题。DSH 没有安全的"隐藏会话"机制
					// （见 lib/identity.js 的对照表：归档会让助手哑掉、subagent 标记
					// 会让会话连不上），所以改为让它在侧边栏**一眼可辨**。
					// 放在这里而不是 create 时：resume 路径（重启后恢复）同样要标注，
					// 而且旧会话可能是在没有本功能时建的。
					// 异步且**不 await**：等标题服务上线可能要几百毫秒，没必要
					// 卡住后面的装配；写不上也不影响语音链路。
					labelAgentSession(scope, result.agent, normalized.session.label)
						.then((done) => {
							labeled = done;
							if (done) {
								scope.logger?.info?.(`voice-assistant: 常驻会话已标注为「${normalized.session.label}」`);
							}
						})
						.catch(() => {});

					// 归档自愈：常驻会话绝不能躺在归档集合里 —— 那样每一轮
					// `agent/pre-step` 都会被 `ArchivedSessionGate` reject，turn
					// 一开就结束（`reason:{"kind":"blocked"}`），而提交本身是成功的
					// （`prompt()` 返回 `{ok:true}`），界面上完全看不出问题。
					// 详见 lib/identity.js 的 `ensureSessionNotArchived`。
					//
					// ⚠️ 取 `workspaceRegistry` 必须走**独立的 `ctx.inject(…)`**，
					// 不能在只 inject 了 `agentLoop` 的 scope 上取，也不能在根 ctx
					// 上 `ctx.get(…)` —— Cordis 对**未声明 inject 的服务**访问是
					// 同步抛 `cannot get property "workspaceRegistry" without inject`，
					// 不是返回 undefined。被空 catch 吞掉后的现象是"自愈写了却
					// 完全没跑"（health 的 `archivedFix` 恒为 null）。真机踩过。
					//
					// 用独立 inject 还带来一个正确性好处：`dsh-workspace` 缺席的
					// 精简 profile 里，这段回调压根不会执行，不会误报"服务不可用"。
					ctx.inject(["workspaceRegistry"], (archiveScope) => {
						ensureSessionNotArchived(archiveScope, result.agent.id)
							.then((outcome) => {
								archivedFix = outcome;
								if (outcome.lifted) {
									scope.logger?.warn?.(
										`voice-assistant: 检测到常驻会话在归档集合里（这会让助手彻底哑掉：每轮 turn 都是 blocked）—— 已自动解除归档（session ${result.agent.id}）`,
									);
								} else if (outcome.checked && outcome.archived) {
									// 查出归档、但摘不掉（服务缺方法或写入失败）：
									// 这是会让助手"提交成功却永不出声"的状态，必须显式告警。
									scope.logger?.warn?.(
										`voice-assistant: 常驻会话被归档且未能解除（${outcome.reason}）—— 语音指令会提交成功但永远没有回答`,
									);
								}
							})
							.catch((error) => {
								// 绝不静默：这一次踩过 —— 异常被空 catch 吞掉后，
								// health 的 `archivedFix` 恒为 null，从外部完全看不出
								// 自愈压根没跑。把它落成一条可见的结论。
								archivedFix = { checked: false, archived: false, lifted: false, reason: `threw: ${String(error?.message ?? error)}` };
								scope.logger?.warn?.(`voice-assistant: 归档自愈执行异常 —— ${String(error?.message ?? error)}`);
							});
					});
					
					// 模型路由没落上是"turn 一开就报 no provider/model"的根因，
					// 必须在启动日志里显式暴露（否则只能靠 health 的 model 字段反查）。
					const route = result.selection === null ? "未解析到" : `${result.selection.provider}/${result.selection.model}`;
					scope.logger?.info?.(
						`voice-assistant: 常驻 agent 已就绪（${result.source}，session ${result.agent.id}，模型 ${route}${result.modelApplied ? "（已写入）" : "（!! 未写入，首个 turn 会失败）"}）`,
					);
					if (result.modelApplied !== true) {
						// 不阻断装配（用户可能稍后在界面上选模型），但把原因写进 health，
						// 免得排障时只看到一轮空 turn。
						agentError = result.selection === null ? "agent-model-unresolved" : "agent-model-not-applied";
						scope.logger?.warn?.(
							`voice-assistant: 常驻 agent 未拿到模型路由（${agentError}）—— 语音指令会立即失败退出。请确认 agentDefaultModel 已就绪，或在 voice-assistant.agent 里显式写 provider/model。`,
						);
					}
				})
				.catch((error) => {
					settled = true;
					agentError = String(error?.message ?? error);
					// stderr 直写：DSH 的插件 logger 不进 stdout，排障时 health 只能看到
					// 一行 message，这里把堆栈也落下来。
					process.stderr.write(
						`[voice-assistant] 常驻 agent 创建失败: ${error?.stack ?? String(error)}\n`,
					);
					scope.logger?.warn?.(
						`voice-assistant: 常驻 agent 创建失败 —— ${String(error?.message ?? error)}`,
					);
				});
			// 作用域卸载时若 ensure 仍在途，标记作废（结果丢弃即可，
			// registry.create 的 owner fiber 就是本作用域，会随卸载回滚）。
			scope.effect(
				() => () => {
					if (!settled) agentRef = null;
				},
				"voice-assistant: 常驻 agent 在途保护",
			);
		});
	}

	// 软解析 webServer：无 Web 载体时整段宿主职责不装。
	ctx.inject(["webServer"], (scope) => {
		// 1) 首帧配置下发。
		scope.effect(
			() =>
				scope.on("webserver/index-inject", (table) => {
					table.push({
						kind: "global",
						name: CLIENT_CONFIG_GLOBAL,
						value: clientConfig(normalized, state().capabilities),
					});
				}),
			"voice-assistant: 客户端配置下发",
		);

		// 2) 本机 API。注册失败（前缀冲突）只告警：语音球仍能工作，
		//    只是润色退化为规则清理、上游 ASR/TTS 不可用。
		try {
			const dispose = installApiRoutes(scope, normalized, state);
			scope.effect(() => dispose, "voice-assistant: 本机 API");
		} catch (error) {
			scope.logger?.warn?.(`voice-assistant: API 路由注册失败，将退化为纯浏览器语音链路 —— ${error?.message ?? error}`);
		}
	});
}

export { normalizeConfig, clientConfig, API_PREFIX };
