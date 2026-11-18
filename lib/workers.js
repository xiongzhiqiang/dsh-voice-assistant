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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ensurePersistentAgent } from "./agent.js";
import { labelAgentSession, ensureSessionNotArchived } from "./identity.js";
import { describeExpertSkills, registerExpertSkills } from "./skills.js";

/**
 * 默认 worker 清单（5 个）。
 *
 * 分工原则：按「用户对电脑说话的真实意图类别」划，而不是按工具划 ——
 * 路由模型只需判"这话想让谁干"，不需要懂工具细节。
 *
 * `skills` 字段是该专家**掌握的技能名**（见 lib/skills.js）：人格约束语气，
 * 技能给出流程。基因分析这类工作有多步纪律（先确认参考基因组、按 gnomAD
 * 过滤、按 AMP/ASCO/CAP 分级、每个结论都要有来源），写成技能按需加载，
 * 比塞进 persona 省 token 也更稳。
 */
export const DEFAULT_WORKERS = [
	{
		id: "general",
		label: "小凤 · 通用",
		// 通用兜底：闲聊、问答、没明显特征的话都归它。sessionId 留空 = 根 agent。
		sessionId: "",
		persona: "",
		description: "日常对话、问答、闲聊，以及不适合交给其他专家的杂项。",
		skills: [],
	},
	{
		id: "bioinfo",
		label: "小因 · 基因分析",
		sessionId: "session-voice-worker-bioinfo-v2",
		persona: [
			"你是「小因」，一个专注基因与变异分析的语音助手专家。用户通过语音向你下达分析任务，你的回复会被逐句朗读。",
			"职责：体细胞突变（SNV/Indel）分析、变异注释、临床意义分级（AMP/ASCO/CAP）、可靶向性与用药匹配、生成变异报告。",
			"你有专门的技能可用：涉及体细胞突变分析或出报告时，**先加载技能再动手**，按技能里的流程与纪律执行，不要凭记忆跳过步骤。",
			"输出形态约束：口语化、句子简短、先给结论再给依据；表格与长报告写入文件（HTML），只在语音里念结论与文件路径。",
			"关键纪律：参考基因组（hg19/hg38）与样本配对方式**必须先确认再分析**，猜错会让所有坐标错位；分级结论必须能追到来源，写不出来源就降到意义未明。",
			"收到与基因分析无关的请求时，不要拒绝执行，但回复里提醒一句「这个问题交给通用助手可能更合适」。",
		].join("\n"),
		description: "基因分析：体细胞突变检测与注释、变异临床分级、可靶向性分析、生成变异报告。",
		skills: ["somatic-mutation-report"],
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
		skills: [],
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
		skills: [],
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
		skills: [],
	},
];

/** worker persona 的长度上限（防用户在 YAML 里贴整篇文档）。 */
const PERSONA_LIMIT = 4000;
/**
 * worker 数量上限。
 *
 * 每个 worker 都是一条常驻 agent（启动时依次建立、各占一份会话与上下文），
 * 所以要有上限；但上限必须**够宽**，否则"用户自行添加专家"这个入口会变成
 * 陷阱：加到第 N 个就静默不生效。12 = 5 位默认专家 + 7 位自定义，够用且
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
				skills: normalizeSkillNames(item.skills ?? template.skills),
			};
			seen.add(id);
			out.push(worker);
		}
	}
	// 未配置时 out 为空 → 全默认；配置过但漏了 general → 补上（兜底落点必须有）。
	if (out.length === 0) {
		for (const worker of DEFAULT_WORKERS) {
			out.push({ ...worker, skills: (worker.skills ?? []).slice() });
			seen.add(worker.id);
		}
	} else if (!seen.has("general")) {
		const fallback = DEFAULT_WORKERS[0];
		out.unshift({ ...fallback, skills: (fallback.skills ?? []).slice() });
	}
	// general 的 sessionId 恒指向根 agent（兼容性锚点，不接受覆盖）。
	for (const worker of out) {
		if (worker.id === "general") worker.sessionId = agentSessionId;
	}
	return out.slice(0, WORKER_LIMIT);
}

/**
 * 合并多来源的专家定义（需求①的「用户自行添加专家」入口）。
 *
 * 三个来源，优先级从高到低：
 *   1. `routing.workers` —— YAML 内联数组（最直接，优先级最高）；
 *   2. `routing.experts` —— 同格式的内联数组（语义化的别名）；
 *   3. `routing.expertDirs` / `routing.expertDir` —— 目录，每目录下每个
 *      `*.json` 是一位专家（丢文件即生效，不必改 YAML）。
 *
 * 合并规则：**按 id 去重，先到先得**。所以优先级高的来源写了同 id 就覆盖
 * 低优先级来源 —— 用户想临时覆盖某个默认专家，只需在 `routing.workers` 里
 * 写一条同 id 的记录即可，不必改动磁盘文件。
 *
 * ## 目录是「追加」而不是「替换」（重要）
 *
 * `routing.workers` / `routing.experts` 一旦写了就是**完整花名册**：只列出的
 * 专家会存在（其余默认专家按 V1.2 的口径被替换掉）。但目录来源的语义是
 * 「丢个 JSON 就多一位专家」，如果它也只有替换语义，用户丢一个 `chem.json`
 * 就会**丢掉**阿码/阿研/阿卓/小因 —— 界面上一看"专家全没了"，而这跟"加了
 * 一位专家"的预期完全相反。
 *
 * 所以：**只配了目录（两个内联来源都为空）时，先铺默认清单再用目录覆盖**。
 * 同一个 id 的目录文件仍然能盖掉默认那位（覆盖是有用的），其余默认专家
 * 一个不少。
 *
 * 目录读取失败（路径不存在/JSON 坏掉/不是对象）一律**跳过并记入 problems**，
 * 绝不让一条坏文件把整个专家层带塌 —— 与配置归一化的容错纪律一致。
 *
 * @param inlineWorkers - `routing.workers` 原始值。
 * @param inlineExperts - `routing.experts` 原始值。
 * @param dirs - `routing.expertDirs`（数组）。
 * @param singleDir - `routing.expertDir`（单值，兼容旧写法）。
 * @returns `{ items, problems }` —— `items` 供 `normalizeWorkers` 消费。
 */
export function mergeWorkerSources(inlineWorkers, inlineExperts, dirs, singleDir) {
	const items = [];
	const problems = [];
	const seen = new Set();

	const take = (source, origin) => {
		if (!Array.isArray(source)) return;
		for (const item of source) {
			if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
			const id = typeof item.id === "string" ? item.id.trim() : "";
			if (id === "") {
				problems.push(`${origin}: 缺少 id，已跳过`);
				continue;
			}
			if (seen.has(id)) continue; // 先到先得 = 高优先级来源胜出。
			seen.add(id);
			items.push(item);
		}
	};

	// 说明：`inlineWorkers` 为空时**不要**在这里补默认清单 —— 补默认是
	// `normalizeWorkers` 的职责，这里只做"用户显式写了什么"的合并。
	take(inlineWorkers, "routing.workers");
	take(inlineExperts, "routing.experts");

	/** 用到的专家目录（数组 + 兼容旧写法的单值）。 */
	const list = [];
	if (Array.isArray(dirs)) {
		for (const dir of dirs) if (typeof dir === "string" && dir.trim() !== "") list.push(dir.trim());
	}
	if (typeof singleDir === "string" && singleDir.trim() !== "") list.push(singleDir.trim());

	/** 先把目录里的专家收进**另一张表**，才能实现"覆盖默认"而不是"被默认挡住"。 */
	const fromDirs = new Map();
	for (const dir of list) {
		let names = [];
		try {
			names = readdirSync(dir, { withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
				.map((entry) => entry.name)
				.sort();
		} catch (error) {
			// 目录不存在是常见情况（用户还没建过），只记一条不报错。
			problems.push(`${dir}: 读取失败（${String(error?.message ?? error)}）`);
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
			// 前面的目录已定义过同 id → 后者跳过（先到先得，与内联来源同一条纪律）。
			if (fromDirs.has(id)) continue;
			fromDirs.set(id, parsed);
		}
	}

	// 内联来源写了完整花名册 → 目录只补它没提到的新 id（不能盖掉用户显式写的）。
	// 内联来源为空 → 目录是**追加**：先铺默认清单，目录里同 id 的盖掉默认那位。
	if (items.length > 0) {
		for (const [id, parsed] of fromDirs) {
			if (seen.has(id)) continue;
			seen.add(id);
			items.push(parsed);
		}
	} else if (list.length > 0) {
		for (const worker of DEFAULT_WORKERS) {
			const override = fromDirs.get(worker.id);
			if (override !== undefined) {
				items.push({ ...worker, ...override });
				continue;
			}
			items.push(worker);
		}
		// 目录里全新 id 的专家（不在默认清单里的）接在后面。
		for (const [id, parsed] of fromDirs) {
			if (DEFAULT_WORKERS.some((worker) => worker.id === id)) continue;
			items.push(parsed);
		}
	}
	return { items, problems };
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
 * @returns `[{ id, ok, source, model, error, archivedFix, skills }]` —— health 与路由层共用。
 */
export async function ensureWorkerAgents(rootCtx, scope, config, workers, onProgress = null, skillCatalog = null) {
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
		emit({ id: worker.id, ok: false, source: "creating", model: "", error: "", archivedFix: null });
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
					`voice-assistant: worker「${worker.label}」声明的技能未找到：${skillState.missing.join("、")} —— 请确认这些技能在插件 skills/ 目录或用户技能目录里`,
				);
			}
			// 注册失败（catalog 里有、却没挂上）单独告警：这是**真故障**，
			// 与"技能名写错了"（missing）不是一回事。
			if (skillState.registered.length < skillState.available.length) {
				scope.logger?.warn?.(
					`voice-assistant: worker「${worker.label}」有技能未能注册（可用 ${skillState.available.length}，已挂 ${skillState.registered.length}）—— ${skillState.reason || "原因未记录"}`,
				);
			}
			emit({
				id: worker.id,
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
				`voice-assistant: worker「${worker.label}」已就绪（${result.source}，session ${result.agent.id}，模型 ${model || "未解析"}${skillNote}）`,
			);
		} catch (error) {
			emit({ id: worker.id, ok: false, source: "", model: "", error: String(error?.message ?? error), archivedFix: null });
			scope.logger?.warn?.(`voice-assistant: worker「${worker.label}」创建失败 —— ${String(error?.message ?? error)}`);
		}
	}
	return results;
}
