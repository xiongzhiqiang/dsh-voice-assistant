/**
 * Worker 专家 agent（宿主半）—— 两层架构的第二层。
 *
 * ## 架构总览
 *
 * ```
 * 用户语音 → 润色 → 路由（/api/route，LLM 意图分类）
 *                        ↓ {worker, task}
 *            POST /delegate → worker.followup(task)（后台执行）
 *                        ↓ agent/assistant-stream
 *            要点汇总 → /reports → 路由器按完成先后播报
 * ```
 *
 * ## V1.3 的关键变化
 *
 * 客户端**不再** `switchTo(worker.sessionId)` 去旁听 worker。worker 独立跑，
 * 只把最后一句结果交给委托中枢（`lib/delegation.js`）汇总；本文件负责把
 * agent 实例交给那个中枢，并保留 session/persona 隔离。
 *
 * Router 是「小凤」本体的职责（见 lib/router.js）；本文件管的是 worker 层：
 * 把一组**预定义的专家 agent**在 DSH 启动时建成常驻，各自持有独立 session
 * 与 persona —— 专家的对话历史互相隔离，编程上下文不会污染调研上下文。
 *
 * ## 为什么 worker 是常驻 agent 而不是临时会话
 *
 * 1. `registry.create()` 建的 agent 有完整的 DSH 官方循环（工具、审批、提问），
 *    我们不重写任何执行逻辑；
 * 2. session 持久化 ⇒ 专家有跨轮记忆（"刚才那个文件再改一下"能接上）；
 * 3. 建一次、复用到进程退出，派单只是 `followup()` 投消息，零创建开销。
 *
 * ## 与根 agent 的关系
 *
 * `general` worker **就是**根 agent（`config.agent.sessionId`，不另建）——
 * 保证向后兼容：路由关闭或失败时，行为与旧版本完全一致。其余 worker 用
 * `session-voice-worker-<id>` 命名空间，与根会话永不撞车。
 */
import { ensurePersistentAgent } from "./agent.js";
import { labelAgentSession, ensureSessionNotArchived } from "./identity.js";

/**
 * 默认 worker 清单（4 个）。
 *
 * 分工原则：按「用户对电脑说话的真实意图类别」划，而不是按工具划 ——
 * 路由模型只需判"这话想让谁干"，不需要懂工具细节。
 */
export const DEFAULT_WORKERS = [
	{
		id: "general",
		label: "小凤 · 通用",
		// 通用兜底：闲聊、问答、没明显特征的话都归它。sessionId 留空 = 根 agent。
		sessionId: "",
		persona: "",
		description: "日常对话、问答、闲聊，以及不适合交给其他专家的杂项。",
	},
	{
		id: "coder",
		label: "阿码 · 编程",
		// 带 schema 版本后缀：V1.3 起派单消息必须是 identified message。
		// 旧 id 下已有不带 id 的历史消息，resume 会永久失败；换新 id 让
		// 升级后的 worker 从干净会话起步，不继承已损坏的历史。
		sessionId: "session-voice-worker-coder-v2",
		persona: [
			"你是「阿码」，一个专注编程的语音助手专家。用户通过语音向你下达编程任务，你的回复会被逐句朗读。",
			"职责：写代码、改 bug、重构、解释代码、跑测试、审查方案。涉及文件操作时直接调用工具执行。",
			"输出形态约束：口语化、句子简短、先给结论再给细节；代码本身走工具写入文件，不要在回复里大段朗读代码——只念关键改动点和结果。",
			"收到与编程无关的请求时，不要拒绝执行，但回复里提醒一句「这个问题交给通用助手可能更合适」。",
		].join("\n"),
		description: "编程任务：写代码、调试、重构、跑测试、解释代码、技术方案。",
	},
	{
		id: "researcher",
		label: "阿研 · 调研",
		sessionId: "session-voice-worker-researcher-v2",
		persona: [
			"你是「阿研」，一个专注调研与写作的语音助手专家。用户通过语音向你下达调研任务，你的回复会被逐句朗读。",
			"职责：查资料、读文档、对比方案、总结要点、起草报告与说明。需要检索或读文件时直接调用工具。",
			"输出形态约束：口语化、句子简短、先给结论再给依据；结论用两三句话说清，长内容写入文件、只在语音里念摘要。",
			"收到与调研/写作无关的请求时，不要拒绝执行，但回复里提醒一句「这个问题交给通用助手可能更合适」。",
		].join("\n"),
		description: "调研写作：查资料、读文档、对比方案、总结、写报告。",
	},
	{
		id: "operator",
		label: "阿卓 · 操作",
		sessionId: "session-voice-worker-operator",
		persona: [
			"你是「阿卓」，一个专注本机操作的语音助手专家。用户通过语音让你操作这台电脑，你的回复会被逐句朗读。",
			"职责：文件与目录管理（建、移、改名、清理）、打开程序或文件夹、查系统状态、执行一条命令。一律调用工具完成，完成后用一句话报告结果。",
			"输出形态约束：口语化、句子简短；操作前确认目标路径，操作后念出做了什么、结果如何。",
			"收到与本机操作无关的请求时，不要拒绝执行，但回复里提醒一句「这个问题交给通用助手可能更合适」。",
		].join("\n"),
		description: "本机操作：文件/目录管理、打开程序、系统状态、执行命令。",
	},
];

/** worker persona 的长度上限（防用户在 YAML 里贴整篇文档）。 */
const PERSONA_LIMIT = 4000;
/** worker 数量上限（每个都是常驻 agent，太多会拖慢启动）。 */
const WORKER_LIMIT = 8;
/** 单个 worker 建立超时（毫秒）：失败要可见，不能拖住整层。 */
const WORKER_CREATE_TIMEOUT_MS = 30000;
/** 可选的归档自愈检查超时（毫秒）：超时只记结论，不阻断注册。 */
const ARCHIVE_FIX_TIMEOUT_MS = 3000;

/**
 * 给 promise 加超时；超时后 reject，让外层 catch 落成可见的 worker 错误。
 * @param promise - 原 promise。
 * @param ms - 超时毫秒。
 * @param label - 错误信息。
 */
function withTimeout(promise, ms, label) {
	let timer = null;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(label)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}
/**
 * 归一化 worker 配置。
 *
 * 规则：
 *   - 未配置（`routing.workers` 缺失/空数组）→ 用 `DEFAULT_WORKERS`；
 *   - 配了 → 每条与默认清单**按 id 合并**（默认字段打底，用户字段覆盖），
 *     这样用户只写 `label` 或 `persona` 也能得到完整 worker；
 *   - `general` 恒在（路由的兜底落点），删不掉；它的 `sessionId` 恒空
 *     （指向根 agent，见模块注释）。
 *
 * @param raw - `routing.workers` 原始值。
 * @param agentSessionId - 根 agent 的 sessionId（general 指向它）。
 * @returns 归一化后的 worker 数组（general 恒在首位）。
 */
export function normalizeWorkers(raw, agentSessionId) {
	const source = Array.isArray(raw) ? raw : null;
	const base = new Map(DEFAULT_WORKERS.map((worker) => [worker.id, worker]));
	const out = [];
	const seen = new Set();

	if (source !== null) {
		for (const item of source) {
			if (item === null || typeof item !== "object") continue;
			const id = typeof item.id === "string" ? item.id.trim() : "";
			if (id === "" || seen.has(id)) continue;
			const template = base.get(id) ?? {};
			const worker = {
				id,
				label: trimTo(item.label ?? template.label, 40, `${id} · 专家`),
				sessionId: id === "general" ? "" : trimTo(item.sessionId ?? template.sessionId, 120, `session-voice-worker-${id}`),
				persona: trimTo(item.persona ?? template.persona, PERSONA_LIMIT, ""),
				description: trimTo(item.description ?? template.description, 400, ""),
			};
			seen.add(id);
			out.push(worker);
		}
	}
	// 未配置时 out 为空 → 全默认；配置过但漏了 general → 补上（兜底落点必须有）。
	if (out.length === 0) {
		for (const worker of DEFAULT_WORKERS) {
			out.push({ ...worker });
			seen.add(worker.id);
		}
	} else if (!seen.has("general")) {
		const fallback = DEFAULT_WORKERS[0];
		out.unshift({ ...fallback });
	}
	// general 的 sessionId 恒指向根 agent（兼容性锚点，不接受覆盖）。
	for (const worker of out) {
		if (worker.id === "general") worker.sessionId = agentSessionId;
	}
	return out.slice(0, WORKER_LIMIT);
}

/**
 * 取字符串并截断；空/非字符串时用兜底。
 * @param value - 原始值。
 * @param max - 最大长度。
 * @param fallback - 兜底值。
 */
function trimTo(value, max, fallback) {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (trimmed === "") return fallback;
	return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * 把 worker 的会话 id 落到会话列表的「可投喂目标」形态（客户端路由用）。
 * @param workers - 归一化 worker 数组。
 * @returns `[{id, label, sessionId}]`（纯 JSON 安全）。
 */
export function workerTargets(workers) {
	return workers.map((worker) => ({ id: worker.id, label: worker.label, sessionId: worker.sessionId }));
}

/**
 * 批量建立 worker 常驻 agent。
 *
 * `general` 跳过 —— 根 agent 由 index.js 原逻辑建立，这里不重复。
 * 其余每个 worker：
 *   1. 构造一份浅拷贝配置（改 `agent.sessionId` / `agent.persona` / `session.label`）；
 *   2. 走同一条 `ensurePersistentAgent` 三级路径（get → resume → create）；
 *   3. 标注会话标题（侧边栏一眼可辨）+ 归档自愈（同根 agent 的两道防线）。
 *
 * 单个 worker 失败不连坐：记入结果，其他 worker 照常建立 —— 路由层看到
 * 不可用的 worker 会自动跳过（router 只在可选 id 里分类）。
 *
 * @param rootCtx - 宿主根上下文（用于 `workspaceRegistry` 的独立 inject ——
 *   在 agentLoop scope 上取该服务会**同步抛** `without inject`，根 agent 的
 *   归档自愈走的就是这条路，worker 必须一致）。
 * @param scope - 已注入 `agentLoop` 的作用域（建 agent 用，与根 agent 相同）。
 * @param config - 归一化配置。
 * @param workers - 归一化 worker 数组。
 * @returns `[{ id, ok, source, model, error, archivedFix }]` —— health 与路由层共用。
 */
export async function ensureWorkerAgents(rootCtx, scope, config, workers, onProgress = null) {
	const results = [];
	const emit = (row) => {
		const index = results.findIndex((item) => item.id === row.id);
		if (index >= 0) results[index] = row;
		else results.push(row);
		if (typeof onProgress === "function") {
			try {
				onProgress(row);
			} catch {
				// 探针失败不能影响真正的建立流程。
			}
		}
	};
	for (const worker of workers) {
		// general = 根 agent，由 index.js 的原逻辑负责，这里只登记占位。
		if (worker.id === "general" || worker.sessionId === "") {
			emit({ id: worker.id, ok: null, source: "root-agent", model: "", error: "", archivedFix: null });
			continue;
		}
		const workerConfig = {
			...config,
			agent: {
				...config.agent,
				sessionId: worker.sessionId,
				// persona 为空的 worker 没有专家人格 —— 建了等于通用分身，跳过更诚实。
				persona: worker.persona,
			},
			session: { ...config.session, label: worker.label },
		};
		emit({ id: worker.id, ok: false, source: "creating", model: "", error: "", archivedFix: null });
		try {
			// 单个 worker 的建立必须有界：DSH 的 resume/create 在个别时序下
			// 可能既不返回也不抛错（实测 coder 会永久挂住）。没有超时就会
			// 让整层 worker 永远停在"建立中"，health 只剩 general 一个占位。
			const result = await withTimeout(
				ensurePersistentAgent(scope, workerConfig),
				WORKER_CREATE_TIMEOUT_MS,
				`worker ${worker.id} 建立超时`,
			);
			if (result === null) {
				emit({ id: worker.id, ok: false, source: "", model: "", error: "agents-registry-unavailable", archivedFix: null });
				continue;
			}
			emit({ id: worker.id, ok: result.modelApplied === true, source: result.source, model: "", error: "agent-ready-awaiting-archive-fix", archivedFix: null });
			scope.effect?.(() => () => result.dispose(), `voice-assistant: worker ${worker.id} 生命周期`);
			// 两道防线与根 agent 完全一致（坑：归档哑火 + 侧边栏不可辨）。
			// 标注用 scope（与根 agent 相同的调用面）；归档自愈必须走
			// rootCtx 的独立 inject —— 在 agentLoop scope 上取
			// workspaceRegistry 会同步抛（真机踩过，见根 agent 的同类代码）。
			labelAgentSession(scope, result.agent, worker.label)
				.then(() => {})
				.catch(() => {});
			let archivedFix = null;
			try {
				// 归档自愈是**可选防线**，绝不能挡住 worker 注册：真机踩过
				// `rootCtx.inject(["workspaceRegistry"], cb)` 回调永不触发，
				// 导致 agent 明明已就绪、整层却永远停在 coder 一个占位上。
				archivedFix = await withTimeout(
					new Promise((resolve) => {
						try {
							rootCtx.inject(["workspaceRegistry"], (archiveScope) => {
								ensureSessionNotArchived(archiveScope, result.agent.id).then(resolve, resolve);
							});
						} catch (error) {
							resolve({ checked: false, archived: false, lifted: false, reason: `inject-threw: ${String(error?.message ?? error)}` });
						}
					}),
					ARCHIVE_FIX_TIMEOUT_MS,
					"archive-fix-timeout",
				);
			} catch (error) {
				archivedFix = { checked: false, archived: false, lifted: false, reason: `threw: ${String(error?.message ?? error)}` };
			}
			const model = result.selection === null ? "" : `${result.selection.provider}/${result.selection.model}`;
			emit({
				id: worker.id,
				ok: result.modelApplied === true,
				source: result.source,
				model,
				error: result.modelApplied === true ? "" : result.selection === null ? "agent-model-unresolved" : "agent-model-not-applied",
				archivedFix,
				/** preset 挂载结果（坑十三：没挂上的 worker 缺文件/命令工具）。 */
				preset: result.preset,
				/** 委托中枢要用的 agent 实例（V1.3；**不进 health JSON**）。 */
				agent: result.agent,
			});
			scope.logger?.info?.(
				`voice-assistant: worker「${worker.label}」已就绪（${result.source}，session ${result.agent.id}，模型 ${model || "未解析"}）`,
			);
		} catch (error) {
			emit({ id: worker.id, ok: false, source: "", model: "", error: String(error?.message ?? error), archivedFix: null });
			scope.logger?.warn?.(`voice-assistant: worker「${worker.label}」创建失败 —— ${String(error?.message ?? error)}`);
		}
	}
	return results;
}
