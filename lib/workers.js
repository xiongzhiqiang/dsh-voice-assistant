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
 * 把一组**由目录 JSON 定义的专家 agent**在 DSH 启动时建成常驻，各自持有独立
 * session 与 persona —— 专家的对话历史互相隔离，编程上下文不会污染调研上下文。
 *
 * V2.2：专家定义不再内置（旧的 DEFAULT_WORKERS 四位已删），唯一真相源是
 * `~/.dsh/voice-assistant/experts/*.json`；本文件只保留 general 系统兜底锚点。
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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ensurePersistentAgent } from "./agent.js";
import { labelAgentSession, ensureSessionNotArchived } from "./identity.js";
import { describeExpertSkills, registerExpertSkills } from "./skills.js";

/**
 * 系统级兜底锚点（V2.2：唯一保留在代码里的 worker 定义，**不是专家**）。
 *
 * ## V2.2 起：专家定义的唯一真相源是目录 JSON
 *
 * 旧的 `DEFAULT_WORKERS`（general + bioinfo + pathologist + protein-designer）
 * 已整体删除。四位领域专家的人格/技能/描述全部迁移到
 * `~/.dsh/voice-assistant/experts/*.json`，由用户目录统一管理；新增/删除专家
 * 都落盘到该目录，宿主重扫目录即同步运行时（见 expert-manager.js）。
 *
 * 只剩 `general` 还留在代码里，但它**不是一位可增删的专家**，而是路由架构的
 * 兜底锚点：router 的 system prompt 写明"判断不了选 general"、路由解析失败
 * 落 general、`RESERVED_IDS` 禁止删它、它的 sessionId 恒指向根 agent（就是
 * 小凤本体）。把它写进用户目录会引入"用户删了兜底导致路由无落点"的故障，
 * 所以固定在代码里，不接受目录 JSON 覆盖。
 *
 * `description` 仍喂给路由模型（见 router.js 的 roster）：必须明确"临床/生医/
 * 科研有实质内容的派给专家"，否则模型会把这类指令当闲聊落给 general。
 */
export const GENERAL_ANCHOR = {
	id: "general",
	label: "小凤 · 通用",
	sessionId: "", // 指向根 agent（normalizeWorkers 会强制覆盖为 agentSessionId）。
	persona: "",
	description: "日常杂项与通用执行（编程、调研、本机操作）的兜底，以及没有明确领域归属的指令。临床、生物医学、科研类有实质分析需求的请归给对应专家。",
	skills: [],
};

/**
 * @deprecated V2.2 兼容别名：旧代码/测试引用 DEFAULT_WORKERS。
 * 只有 general 锚点会从这里返回；领域专家一律来自目录 JSON，不再内置。
 */
export const DEFAULT_WORKERS = [GENERAL_ANCHOR];

/** worker persona 的长度上限（防用户在 YAML 里贴整篇文档）。 */
const PERSONA_LIMIT = 4000;
/**
 * worker 数量上限。
 *
 * 每个 worker 都是一条常驻 agent（启动时依次建立、各占一份会话与上下文），
 * 所以要有上限；但上限必须**够宽**，否则"用户自行添加专家"这个入口会变成
 * 陷阱：加到第 N 个就静默不生效。12 = general 锚点 + 11 位目录专家，够用且
 * 仍在启动开销可控的范围内。超出部分由 config.js 记成可见的 problem。
 */
export const WORKER_LIMIT = 12;
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
 * 归一化 worker 配置（V2.2：花名册 = 系统锚点 general + 目录 JSON 专家）。
 *
 * 规则：
 *   - `general` 恒在首位（路由兜底锚点，见 GENERAL_ANCHOR），不接受覆盖；
 *   - 其余每条来自目录 JSON（`raw`），按 id 去重、逐字段夹取；
 *   - 目录为空 → 只有 general 一位专家层（不再铺任何内置领域专家）；
 *   - general 的 `sessionId` 恒指向根 agent。
 *
 * @param raw - 目录扫描得到的专家定义数组（`mergeWorkerSources().items`）。
 * @param agentSessionId - 根 agent 的 sessionId（general 指向它）。
 * @returns 归一化后的 worker 数组（general 恒在首位）。
 */
export function normalizeWorkers(raw, agentSessionId) {
	const source = Array.isArray(raw) ? raw : null;
	const out = [];
	const seen = new Set(["general"]);

	if (source !== null) {
		for (const item of source) {
			if (item === null || typeof item !== "object") continue;
			const id = typeof item.id === "string" ? item.id.trim() : "";
			if (id === "" || seen.has(id)) continue; // general 不接受目录覆盖。
			seen.add(id);
			out.push({
				id,
				label: trimTo(item.label, 40, `${id} · 专家`),
				sessionId: trimTo(item.sessionId, 120, `session-voice-worker-${id}`),
				persona: trimTo(item.persona, PERSONA_LIMIT, ""),
				description: trimTo(item.description, 400, ""),
				skills: normalizeSkillNames(item.skills),
			});
		}
	}
	// general 锚点恒在首位（V2.2：即便目录空/坏，路由也有兜底落点）。
	out.unshift({ ...GENERAL_ANCHOR, skills: [], sessionId: agentSessionId });
	return out.slice(0, WORKER_LIMIT);
}

/**
 * 读取专家定义（V2.2：目录 JSON 是**唯一真相源**）。
 *
 * ## 单一数据源
 *
 * 花名册只有一个来源：`routing.expertDirs` 下列出的目录，每个顶层 `*.json`
 * 是一位专家。旧的 YAML 内联来源（`routing.workers` / `routing.experts`）已
 * 废弃：它们曾经能盖掉目录定义，导致"目录里删了、YAML 里还活着"的双源漂移。
 * 为了向后兼容旧配置，内联来源仍会被读取，但**仅作为目录缺失时的兜底**
 * （一个专家目录都没配、或目录读取失败时才用）—— 只要目录可用，就只认目录。
 *
 * 系统锚点 general 不来自这里，由 `normalizeWorkers` 固定在首位（见模块注释）。
 *
 * ## 容错
 *
 * 目录读取失败（路径不存在）、文件 JSON 坏掉、缺 id、`disabled:true` 墓碑，
 * 一律跳过并记入 `problems`，绝不让一条坏文件带塌整个专家层。
 *
 * @param inlineWorkers - `routing.workers` 原始值（兼容兜底）。
 * @param inlineExperts - `routing.experts` 原始值（兼容兜底）。
 * @param dirs - `routing.expertDirs`（数组）。
 * @param singleDir - `routing.expertDir`（单值，兼容旧写法）。
 * @returns `{ items, problems, disabled }` —— `items` 供 `normalizeWorkers` 消费。
 */
export function mergeWorkerSources(inlineWorkers, inlineExperts, dirs, singleDir) {
	const problems = [];
	const disabled = new Set();
	const fromDirs = new Map();
	let dirReadOk = false;

	/** 用到的专家目录（数组 + 兼容旧写法的单值）。 */
	const list = [];
	if (Array.isArray(dirs)) {
		for (const dir of dirs) if (typeof dir === "string" && dir.trim() !== "") list.push(dir.trim());
	}
	if (typeof singleDir === "string" && singleDir.trim() !== "") list.push(singleDir.trim());

	for (const dir of list) {
		let names = [];
		try {
			names = readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json") && !entry.name.includes(".tmp-"))
				.map((entry) => entry.name)
				.sort();
			dirReadOk = true;
		} catch (error) {
			// ENOENT：用户还没建过专家目录（V2.2 默认目录在首次启动时就是这种
			// 状态），属正常初始态，不记 problem —— 否则 health 里会长期挂一条
			// 假红。其它错误（权限、路径非法）照记，便于排查配错的 expertDirs。
			if (error?.code !== "ENOENT") {
				problems.push(`${dir}: 读取失败（${String(error?.message ?? error)}）`);
			}
			continue;
		}
		for (const name of names) {
			const file = join(dir, name);
			let parsed;
			try {
				parsed = JSON.parse(readFileSync(file, "utf8"));
			} catch (error) {
				problems.push(`${name}: JSON 解析失败（${String(error?.message ?? error)}）`);
				continue;
			}
			const id =
				parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.id === "string"
					? parsed.id.trim()
					: "";
			if (id === "") {
				problems.push(`${name}: 缺少 id，已跳过`);
				continue;
			}
			// 墓碑 disabled:true：删专家的历史落点（V2.2 起改为直接删文件，
			// 但仍兼容旧墓碑）。不进花名册，只登记要剔除的 id。
			if (parsed.disabled === true) {
				disabled.add(id);
				continue;
			}
			// general 是系统锚点，目录里即便有人写了 general.json 也忽略。
			if (id === "general") continue;
			// 多个目录配了同 id → 先到的目录胜出。
			if (fromDirs.has(id)) continue;
			fromDirs.set(id, parsed);
		}
	}

	const items = [];
	const seen = new Set();
	if (dirReadOk) {
		// 目录可用 → 目录 JSON 是唯一真相源，内联来源不再参与。
		for (const [id, parsed] of fromDirs) {
			if (disabled.has(id)) continue;
			seen.add(id);
			items.push(parsed);
		}
	} else {
		// 目录不可用（没配/全读失败）→ 兼容旧内联配置，作为兜底花名册。
		for (const source of [inlineWorkers, inlineExperts]) {
			if (!Array.isArray(source)) continue;
			for (const item of source) {
				if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
				const id = typeof item.id === "string" ? item.id.trim() : "";
				if (id === "" || id === "general" || seen.has(id) || disabled.has(id)) continue;
				seen.add(id);
				items.push(item);
			}
		}
	}
	return { items, problems, disabled: [...disabled] };
}

/**
 * 把「catalog 里有没有」与「setup 里真挂上了没有」两层技能状态合成一份。
 *
 * 为什么要合：`describeExpertSkills` 只回答**能不能**挂（技能文件扫到了），
 * 而 `registerExpertSkills` 的返回值回答**挂没挂**（`registry.register()` 是
 * 否成功）。只报前者会在注册静默失败时谎报可用 —— 而那正是最需要看见的情况：
 * 专家建起来了、人格也在，就是不会那个流程，光看 `available` 完全看不出来。
 *
 * `registered` 取**两者的交集**（既能挂、又确实挂上了），`missing` 取并集
 * （要么找不到、要么挂不上，都算缺失），并保留 `reason` 供排障。
 *
 * @param described - `describeExpertSkills()` 的结果。
 * @param outcome - `registerExpertSkills()` 的结果（未接线时为空）。
 * @returns `{ declared, available, registered, missing, reason }`。
 */
export function mergeSkillState(described, outcome) {
	const declared = described?.declared ?? [];
	const available = described?.available ?? [];
	if (outcome === null || outcome === undefined) {
		// 没接技能桥（该专家没声明技能，或 catalog 缺失）：注册结果等于可用集。
		return { declared, available, registered: available.slice(), missing: described?.missing ?? [], reason: "" };
	}
	const registered = Array.isArray(outcome.registered) ? outcome.registered.slice() : [];
	const missing = [...new Set([...(described?.missing ?? []), ...(Array.isArray(outcome.missing) ? outcome.missing : [])])];
	return {
		declared,
		available,
		registered,
		missing,
		reason: String(outcome.reason ?? ""),
	};
}

/**
 * 归一化技能名清单（去空、去重、去内部空白，保序）。
 *
 * ## 为什么不在这里按文法过滤非法名
 *
 * 曾想在这里就滤掉 `Bad_Name` 这类非法名（`skills.register()` 会抛）。
 * 但那样用户**看不见自己拼错了**：清单静默少一项，health 里只显示
 * "声明了 0 个技能"，比报错更难查。
 *
 * 所以保留原样、让它进 `describeExpertSkills` 的 `missing`：
 * 名字对不上 catalog 就取不到技能，注册环节自然不会碰它（见
 * `registerExpertSkills` 的 `catalog.skills.get(name) === undefined` 分支）。
 * 防线放在"取不到就不挂 + 如实上报"，而不是"悄悄丢掉"。
 *
 * @param value - 原始值（字符串数组；单个字符串按一位技能解释）。
 * @returns 技能名数组。
 */
function normalizeSkillNames(value) {
	if (typeof value === "string") {
		const one = value.trim();
		return one === "" ? [] : [one];
	}
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const name = item.trim();
		if (name === "" || out.includes(name)) continue;
		out.push(name);
	}
	return out;
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
 * @returns `[{id, label, sessionId, description}]`（纯 JSON 安全）。
 */
export function workerTargets(workers) {
	// `description` 要下发：客户端面板要显示"这位专家管什么"，用户才知道
	// 可以怎么点名叫它。persona 正文仍然留在宿主（可能含用户定制上下文）。
	//
	// `skills` 也下发**名字**（不下发正文）：面板上"这位专家掌握：体细胞突变
	// 报告"比一句抽象描述更可信。技能正文（几 KB 的流程纪律）留在宿主侧，
	// 只在 agent 的 `setup` 里注册 —— 下发它既没用又白占带宽。
	return workers.map((worker) => ({
		id: worker.id,
		label: worker.label,
		sessionId: worker.sessionId,
		description: worker.description,
		skills: Array.isArray(worker.skills) ? [...worker.skills] : [],
	}));
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
 * @param onProgress - 可选的逐项进度回调（health 实时暴露）。
 * @param skillCatalog - 可选的技能目录（`loadSkillCatalog()` 产物）；给了就按
 *   每个 worker 的 `skills` 声明挂技能（见 lib/skills.js）。
 * @param sessionsOf - V1.8 可选：`(worker) => [{sessionId,label,active}]`，返回该专家
 *   要建立的会话列表。不传则退化成单会话（用 worker.sessionId，兼容 V1.3–V1.7）。
 *   注册表驱动的调用方用它展开"一专家多会话"。
 * @returns `[{ id, sessionId, active, ok, source, model, error, archivedFix, skills, agent }]`
 *   —— health 与路由层共用；同一专家的每个会话各占一行。
 */
export async function ensureWorkerAgents(rootCtx, scope, config, workers, onProgress = null, skillCatalog = null, sessionsOf = null) {
	const results = [];
	/** emit 去重键：V1.8 起同专家多会话，必须用 id + sessionId 复合键。 */
	const rowKey = (row) => `${row.id}::${row.sessionId ?? ""}`;
	const emit = (row) => {
		const key = rowKey(row);
		const index = results.findIndex((item) => rowKey(item) === key);
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
			emit({ id: worker.id, sessionId: "", active: true, ok: null, source: "root-agent", model: "", error: "", archivedFix: null });
			continue;
		}
		// V1.8：把一位专家展开成它的多个会话。默认单会话保持旧行为。
		let sessionList = null;
		if (typeof sessionsOf === "function") {
			try {
				sessionList = sessionsOf(worker);
			} catch {
				sessionList = null;
			}
		}
		if (!Array.isArray(sessionList) || sessionList.length === 0) {
			sessionList = [{ sessionId: worker.sessionId, label: worker.label, active: true }];
		}
		for (const session of sessionList) {
			const effectiveSessionId = typeof session.sessionId === "string" && session.sessionId !== "" ? session.sessionId : worker.sessionId;
			const effectiveLabel = typeof session.label === "string" && session.label !== "" ? session.label : worker.label;
			const isActive = session.active !== false;
		const workerConfig = {
			...config,
			agent: {
				...config.agent,
				sessionId: effectiveSessionId,
				// persona 为空的 worker 没有专家人格 —— 建了等于通用分身，跳过更诚实。
				persona: worker.persona,
			},
			session: { ...config.session, label: effectiveLabel },
		};
		/**
		 * 技能注册桥：**只在 setup（agent 作用域）里注册**才对这只 agent 生效
		 * （`SkillRegistry.register` 按 `scopeOf(ctx)` 归档，见 lib/skills.js）。
		 * 因此不能在这里直接调 `scope.skills.register()` —— 那会落进全局层，
		 * 让所有会话都看到这位专家的技能。
		 */
		const attachSkills =
			skillCatalog === null || (worker.skills ?? []).length === 0
				? undefined
				: (agentCtx) => registerExpertSkills(agentCtx, worker.skills, skillCatalog);
		emit({ id: worker.id, sessionId: effectiveSessionId, active: isActive, ok: false, source: "creating", model: "", error: "", archivedFix: null });
		try {
			// 单个 worker 的建立必须有界：DSH 的 resume/create 在个别时序下
			// 可能既不返回也不抛错（实测 coder 会永久挂住）。没有超时就会
			// 让整层 worker 永远停在"建立中"，health 只剩 general 一个占位。
			const result = await withTimeout(
				ensurePersistentAgent(scope, workerConfig, attachSkills === undefined ? {} : { attachSkills }),
				WORKER_CREATE_TIMEOUT_MS,
				`worker ${worker.id} 建立超时`,
			);
			if (result === null) {
				emit({ id: worker.id, sessionId: effectiveSessionId, active: isActive, ok: false, source: "", model: "", error: "agents-registry-unavailable", archivedFix: null });
				continue;
			}
			emit({ id: worker.id, sessionId: effectiveSessionId, active: isActive, ok: result.modelApplied === true, source: result.source, model: "", error: "agent-ready-awaiting-archive-fix", archivedFix: null });
			scope.effect?.(() => () => result.dispose(), `voice-assistant: worker ${worker.id}/${effectiveSessionId} 生命周期`);
			// 两道防线与根 agent 完全一致（坑：归档哑火 + 侧边栏不可辨）。
			// 标注用 scope（与根 agent 相同的调用面）；归档自愈必须走
			// rootCtx 的独立 inject —— 在 agentLoop scope 上取
			// workspaceRegistry 会同步抛（真机踩过，见根 agent 的同类代码）。
			labelAgentSession(scope, result.agent, effectiveLabel)
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
			// 技能状态两层合一：`describeExpertSkills` 说的是"catalog 里有没有"
			// （**能不能**挂），`result.skills` 说的是"setup 里真挂上了没有"
			// （**挂没挂**）。只看前者会在注册静默失败时谎报可用 —— 而那种
			// 情况正是最需要看见的（专家建起来了、却不会那个流程）。
			const skillState = mergeSkillState(describeExpertSkills(worker.skills, skillCatalog), result.skills);
			// 技能缺失必须出现在启动日志里：否则用户只会觉得"这专家好像不懂行"，
			// 而 health 里的 missing 又要主动去查才看得到。
			const skillNote =
				skillState.declared.length === 0
					? ""
					: skillState.missing.length === 0
						? `，技能 ${skillState.registered.length}/${skillState.declared.length}`
						: `，!! 技能缺失 ${skillState.missing.join("/")}（已挂 ${skillState.registered.length} 个）`;
			if (skillState.missing.length > 0) {
				scope.logger?.warn?.(
					`voice-assistant: worker「${effectiveLabel}」声明的技能未找到：${skillState.missing.join("、")} —— 请确认这些技能在插件 skills/ 目录或用户技能目录里`,
				);
			}
			// 注册失败（catalog 里有、却没挂上）单独告警：这是**真故障**，
			// 与"技能名写错了"（missing）不是一回事。
			if (skillState.registered.length < skillState.available.length) {
				scope.logger?.warn?.(
					`voice-assistant: worker「${effectiveLabel}」有技能未能注册（可用 ${skillState.available.length}，已挂 ${skillState.registered.length}）—— ${skillState.reason || "原因未记录"}`,
				);
			}
			emit({
				id: worker.id,
				sessionId: effectiveSessionId,
				active: isActive,
				ok: result.modelApplied === true,
				source: result.source,
				model,
				error: result.modelApplied === true ? "" : result.selection === null ? "agent-model-unresolved" : "agent-model-not-applied",
				archivedFix,
				/** preset 挂载结果（坑十三：没挂上的 worker 缺文件/命令工具）。 */
				preset: result.preset,
				/** 技能注册结果与可用性（需求①：专家掌握自己的能力流程）。 */
				skills: skillState,
				/** 委托中枢要用的 agent 实例（V1.3；**不进 health JSON**）。 */
				agent: result.agent,
			});
			scope.logger?.info?.(
				`voice-assistant: worker「${effectiveLabel}」已就绪（${result.source}，session ${result.agent.id}，模型 ${model || "未解析"}${skillNote}）`,
			);
		} catch (error) {
			emit({ id: worker.id, sessionId: effectiveSessionId, active: isActive, ok: false, source: "", model: "", error: String(error?.message ?? error), archivedFix: null });
			scope.logger?.warn?.(`voice-assistant: worker「${effectiveLabel}」创建失败 —— ${String(error?.message ?? error)}`);
		}
		} // end for (session of sessionList)
	}
	return results;
}
