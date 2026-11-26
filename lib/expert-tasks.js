/**
 * 专家「任务列表记忆」（V2.3，需求④）。
 *
 * ## 这一层解决什么
 *
 * V1.8 把会话与专家解耦之后，一位专家可以有 N 个会话，但**没有任何东西
 * 记得"N 个会话分别是在做什么"**。用户接着说一句「把刚才的结果画成火山图」，
 * 系统只能二选一：
 *   - 投进当前活跃会话 —— 如果那条活跃会话不是"刚才"的那个，上下文就串了；
 *   - 或者每条指令都开新会话 —— 同一条任务的后续追问被拆散在多个会话里，
 *     专家每次都要重新问一遍背景。
 *
 * 需求④要的就是补上这块：**给每位专家一本"任务台账"**，记下它接过哪些任务、
 * 每个任务落在哪个会话；新指令进来先判归属 —— 是老任务就回老会话继续，
 * 是新任务就开新会话（并用任务名给它命名，见需求③）。
 *
 * ```
 * 语音「分析 AG28 差异表达」→ 台账无记录 → 新任务 → 新建会话「分析 AG28 差异表达」
 * 语音「把结果画成火山图」  → 台账有记录 → 命中老任务 → 回原会话继续
 * 语音「给这个项目写个 README」→ 台账不命中 → 新任务 → 新建会话
 * ```
 *
 * ## 为什么台账放在 `_state/tasks.json`
 *
 * 与会话注册表同理（见 expert-sessions.js 的头注）：`mergeWorkerSources` 会把
 * `expertDirs` 下**一层**的每个 `*.json` 当成一位专家定义，`tasks.json` 直接
 * 丢在目录根会被误读成"缺 id 的专家"并污染 health problems。放进 `_state/`
 * 子目录即可 —— 那层扫描不递归。
 *
 * ## 存储模型（原子写）
 *
 * ```
 * <expertDir>/_state/tasks.json
 * {
 *   version: 1,
 *   workers: {
 *     "bioinfo": {
 *       tasks: [
 *         { taskId, title, sessionId, task, createdAt, updatedAt, count, status }
 *       ]   // 最旧在前
 *     }
 *   }
 * }
 * ```
 *
 * ## 为什么这一层全是纯函数
 *
 * 归属判定是**可错的**（LLM 判错、规则判错），一旦判错用户看到的是"任务跑到
 * 别的会话里去了"——最难现场复现的一类 bug。所以把"标题怎么取、两条文本像不像、
 * 台账怎么增怎么裁"全部抽成纯函数，用数值单测钉死，LLM 只负责在规则拿不准时
 * 补一句 yes/no。
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/** 台账格式版本。 */
export const TASK_STORE_VERSION = 1;

/** 每位专家最多保留的任务条数（超出丢最旧，防止无限膨胀）。 */
export const TASKS_PER_WORKER_LIMIT = 24;

/** 任务标题长度上限（中文：够表意，又不至于在界面/语音里读不完）。 */
export const TASK_TITLE_LIMIT = 24;

/** 台账里保留的最近一次指令原文长度上限。 */
export const TASK_TEXT_LIMIT = 200;

/**
 * 规则判定的两个阈值（字符二元组 Jaccard 相似度）。
 *
 * 为什么两档而不是一档：中间地带交给 LLM，两头用规则**直接拍板**。
 *   - ≥ STRONG：几乎同一句话（"分析AG28差异表达" vs "分析 AG28 的差异表达"）
 *     —— 直接复用，不必等模型，省一次往返；
 *   - < STRONG：规则不敢定，交给 LLM 看语义（"把结果画成火山图" 与
 *     "分析 AG28 差异表达" 字面几乎不重叠，但语义上是同一任务）。
 *
 * 只设一个强阈值、其余全交 LLM 是刻意的：需求明确要"是老任务就在老会话里
 * 进行"，**误开新会话**（任务被拆散）比**多问一次模型**（多等一秒）更糟。
 */
export const TASK_MATCH_STRONG = 0.62;

/**
 * 会话占位名的**单一来源**在 expert-sessions.js（会话注册表是它的主人）。
 * 这里转出去，是为了让"任务台账"这一侧的使用者不必知道它住在哪 ——
 * 两边各写一份字面量迟早会漂移。
 */
export { IDLE_SESSION_LABEL } from "./expert-sessions.js";

/**
 * 生成任务 id（纯函数，可单测）。
 *
 * 形如 `task-<worker>-<base36时间戳>-<4位随机>`：与 sessionId 同风格，
 * 日志与台账里一眼能看出属于谁、什么时候建的。
 *
 * @param workerId - 专家 id。
 * @param now - 时间戳（毫秒，可注入测试）。
 * @param rand - 随机串（可注入测试）。
 * @returns 任务 id。
 */
export function makeTaskId(workerId, now = Date.now(), rand = randomUUID().slice(0, 4)) {
	const id = String(workerId ?? "worker").replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || "worker";
	const stamp = Number.isFinite(now) ? Math.max(0, Math.floor(now)).toString(36) : "0";
	const suffix = String(rand ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 4) || "0";
	return `task-${id}-${stamp}-${suffix}`;
}

/**
 * 口语里的礼貌/引导前缀（"麻烦帮我看看…" 这类，标题里要剥掉）。
 *
 * 反复剥（循环 4 次）而不是一次：中文口语常叠两层 —— "麻烦帮我"、"那个我想"，
 * 单次 `replace` 只会剥掉最外一层。
 */
const POLITE_PREFIX = /^(?:麻烦|请|帮我|帮忙|帮助|给我|替我|我想|我要|我需要|现在|接下来|然后|那个|这个|小凤|你好|嗨|喂)+/;

/**
 * 从一句任务原文里取一个可读的标题（纯函数）。
 *
 * 这是需求③的落点：新会话用**任务名**命名，所以标题质量直接决定侧边栏与
 * 面板里那一行能不能看懂。三条处理：
 *   1. 剥掉礼貌前缀（"帮我"不是任务内容）；
 *   2. 取第一个停顿前的分句（整句塞进标题会溢出）—— 但首个分句太短
 *      （< 4 字，如"然后呢"）就退回整句，避免把标题截成一个无意义的词；
 *   3. 去尾部语气词、截断到 TASK_TITLE_LIMIT。
 *
 * @param text - 任务原文。
 * @returns 标题；原文为空时给「未命名任务」。
 */
export function titleFromTask(text) {
	let work = String(text ?? "").replace(/\s+/g, " ").trim();
	if (work === "") return "未命名任务";
	for (let i = 0; i < 4; i += 1) {
		const next = work.replace(POLITE_PREFIX, "").trim();
		if (next === work || next === "") break;
		work = next;
	}
	const firstClause = (work.split(/[。！？!?；;\n]/)[0] ?? "").trim();
	const picked = firstClause.length >= 4 ? firstClause : work;
	let out = picked
		.replace(/[，,、：:\s]+$/, "")
		.replace(/(?:吧|好吗|好不好|可以吗|谢谢|多谢)$/, "")
		.trim();
	if (out === "") out = picked.trim();
	if (out === "") return "未命名任务";
	return out.length > TASK_TITLE_LIMIT ? `${out.slice(0, TASK_TITLE_LIMIT - 1)}…` : out;
}

/**
 * 归一化一段文本用于相似度比较（纯函数）。
 * 去掉标点与空白、转小写 —— "AG28_D3_1" 与 "ag28 d3 1" 应当视为一致。
 * @param text - 原文。
 * @returns 归一化文本。
 */
export function normalizeForMatch(text) {
	return String(text ?? "")
		.toLowerCase()
		.replace(/[^0-9a-z\u4e00-\u9fa5]+/g, "");
}

/**
 * 字符二元组集合（中文没有空格分词，二元组是最省事又有区分度的做法）。
 * @param text - 归一化后的文本。
 * @returns 二元组数组。
 */
function bigrams(text) {
	const out = [];
	if (text.length === 1) return [text];
	for (let i = 0; i + 1 < text.length; i += 1) out.push(text.slice(i, i + 2));
	return out;
}

/**
 * 两条任务文本的相似度（字符二元组 Jaccard，纯函数）。
 * @param a - 文本 A。
 * @param b - 文本 B。
 * @returns 0..1。
 */
export function similarity(a, b) {
	const na = normalizeForMatch(a);
	const nb = normalizeForMatch(b);
	if (na === "" || nb === "") return 0;
	if (na === nb) return 1;
	const setA = new Set(bigrams(na));
	const setB = new Set(bigrams(nb));
	if (setA.size === 0 || setB.size === 0) return 0;
	let shared = 0;
	for (const gram of setA) if (setB.has(gram)) shared += 1;
	return shared / (setA.size + setB.size - shared);
}

/**
 * 在台账里找出与给定文本最像的一条任务（纯函数）。
 *
 * 比对同时看"标题"和"最近一次指令原文"，取两者较高分 —— 标题是系统压缩过的，
 * 指令原文才是用户真实说法，两者都可能命中。
 *
 * @param tasks - 台账数组。
 * @param text - 新指令文本。
 * @returns `{task, score}`；台账为空返回 `{task:null, score:0}`。
 */
export function matchTask(tasks, text) {
	const list = Array.isArray(tasks) ? tasks : [];
	let best = null;
	let bestScore = 0;
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const score = Math.max(similarity(text, entry.title), similarity(text, entry.task));
		if (score > bestScore) {
			bestScore = score;
			best = entry;
		}
	}
	return { task: best, score: bestScore };
}

/**
 * 归一化一段台账原始数据（纯函数）。
 *
 * 容错优先：坏条目一律跳过，不让一条脏数据把整本台账带塌。
 *
 * @param raw - 原始 JSON 值。
 * @returns 归一化后的 `{version, workers}`。
 */
export function normalizeTaskStore(raw) {
	const source = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const workers = {};
	const srcWorkers = source.workers !== null && typeof source.workers === "object" && !Array.isArray(source.workers) ? source.workers : {};
	for (const [workerId, entry] of Object.entries(srcWorkers)) {
		if (typeof workerId !== "string" || workerId === "" || entry === null || typeof entry !== "object") continue;
		const seen = new Set();
		const tasks = [];
		for (const item of Array.isArray(entry.tasks) ? entry.tasks : []) {
			if (item === null || typeof item !== "object") continue;
			const taskId = typeof item.taskId === "string" ? item.taskId.trim() : "";
			if (taskId === "" || seen.has(taskId)) continue;
			seen.add(taskId);
			const title = typeof item.title === "string" && item.title.trim() !== ""
				? item.title.trim().slice(0, TASK_TITLE_LIMIT)
				: "未命名任务";
			tasks.push({
				taskId,
				title,
				sessionId: typeof item.sessionId === "string" ? item.sessionId.trim() : "",
				task: typeof item.task === "string" ? item.task.trim().slice(0, TASK_TEXT_LIMIT) : "",
				createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0,
				updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
				count: Number.isFinite(item.count) && item.count > 0 ? Math.floor(item.count) : 1,
				status: item.status === "done" ? "done" : "active",
			});
		}
		if (tasks.length === 0) continue;
		workers[workerId] = { tasks: tasks.slice(-TASKS_PER_WORKER_LIMIT) };
	}
	return { version: TASK_STORE_VERSION, workers };
}

/**
 * 新建/更新一条任务（纯函数，返回新数组）。
 *
 * 按 `taskId` 定位：命中就"续上"（更新指令原文、时间、次数、会话），
 * 没命中就追加。上限超出丢最旧 —— 台账是"最近在做什么"的记忆，不是审计日志。
 *
 * @param tasks - 现有台账数组。
 * @param entry - `{taskId, title, sessionId, task, at}`。
 * @returns 新台账数组。
 */
export function upsertTask(tasks, entry) {
	const list = Array.isArray(tasks) ? tasks.slice() : [];
	const taskId = typeof entry?.taskId === "string" ? entry.taskId.trim() : "";
	if (taskId === "") return list;
	const at = Number.isFinite(entry?.at) ? entry.at : Date.now();
	const title = typeof entry?.title === "string" && entry.title.trim() !== ""
		? entry.title.trim().slice(0, TASK_TITLE_LIMIT)
		: "未命名任务";
	const text = typeof entry?.task === "string" ? entry.task.trim().slice(0, TASK_TEXT_LIMIT) : "";
	const index = list.findIndex((item) => item?.taskId === taskId);
	if (index === -1) {
		list.push({
			taskId,
			title,
			sessionId: typeof entry?.sessionId === "string" ? entry.sessionId.trim() : "",
			task: text,
			createdAt: at,
			updatedAt: at,
			count: 1,
			status: "active",
		});
	} else {
		const prev = list[index];
		list[index] = {
			...prev,
			// 标题以"第一次定的"为准：同一任务后续的追问文本通常更短更模糊，
			// 拿它覆盖标题会让侧边栏越来越看不懂。
			title: prev.title || title,
			sessionId: typeof entry?.sessionId === "string" && entry.sessionId.trim() !== "" ? entry.sessionId.trim() : prev.sessionId,
			task: text === "" ? prev.task : text,
			updatedAt: at,
			count: (Number.isFinite(prev.count) ? prev.count : 1) + 1,
			status: "active",
		};
	}
	return list.slice(-TASKS_PER_WORKER_LIMIT);
}

/**
 * 把台账渲染成可注入专家的文本（纯函数）。
 *
 * 两个用途共一份渲染：
 *   1. 拼在任务前作为"你的历史任务"背景（与 V1.8 的跨会话摘要同一手法）；
 *   2. 交给归属判定 LLM，让它看着清单选任务。
 *
 * 最新在最前（`-1` 起倒序）：模型与人都更关心"刚在做什么"，而末尾的长清单
 * 容易被截断丢掉。
 *
 * @param tasks - 台账数组。
 * @param limit - 最多渲染几条。
 * @returns 文本；空台账返回空串。
 */
export function renderTaskList(tasks, limit = 8) {
	const list = Array.isArray(tasks) ? tasks.slice(-Math.max(1, limit)) : [];
	if (list.length === 0) return "";
	const lines = list.reverse().map((entry) => {
		const state = entry.status === "done" ? "已完成" : "进行中";
		return `- ${entry.taskId}：${entry.title}（${state}）`;
	});
	return lines.join("\n");
}

/**
 * 台账渲染成注入专家的背景记忆（带标题）。
 * @param tasks - 台账数组。
 * @returns 注入文本；空台账返回空串。
 */
export function taskContextText(tasks) {
	const body = renderTaskList(tasks);
	if (body === "") return "";
	return `【你的历史任务（最近在前；本次指令可能是其中某一条的延续）】\n${body}`;
}

/**
 * 创建任务台账管理器（绑定一个 expertDir）。
 *
 * 生命周期与写法完全对齐 `createExpertSessionStore`（读盘容错 + 原子写），
 * 因为两者是同一种东西：专家目录下的一份运行时状态。
 *
 * @param dir - 专家目录绝对路径。
 * @returns 管理器实例。
 */
export function createExpertTaskStore(dir) {
	const root = typeof dir === "string" && dir.trim() !== "" ? resolve(dir.trim()) : "";
	const stateDir = root === "" ? "" : join(root, "_state");
	const file = stateDir === "" ? "" : join(stateDir, "tasks.json");

	/** 读盘；坏文件返回空表 + problems（不抛）。 */
	function load() {
		if (file === "" || !existsSync(file)) return { store: { version: TASK_STORE_VERSION, workers: {} }, problems: [] };
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8"));
			return { store: normalizeTaskStore(parsed), problems: [] };
		} catch (error) {
			return {
				store: { version: TASK_STORE_VERSION, workers: {} },
				problems: [`tasks.json: 解析失败（${String(error?.message ?? error)}），已按空表处理`],
			};
		}
	}

	/** 原子写盘。 */
	function save(store) {
		if (file === "") throw new Error("no-expert-dir");
		if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, JSON.stringify(normalizeTaskStore(store), null, 2) + "\n", "utf8");
		try {
			renameSync(tmp, file);
		} catch (error) {
			try { unlinkSync(tmp); } catch { /* 清理失败不影响主错误 */ }
			throw error;
		}
	}

	/** 内存中的当前表。 */
	let current = { version: TASK_STORE_VERSION, workers: {} };

	/** 从盘重载，返回 problems。 */
	function reload() {
		const { store, problems } = load();
		current = store;
		return problems;
	}

	/** 设置内存表（测试用）。 */
	function set(store) {
		current = normalizeTaskStore(store);
		return current;
	}

	/** 取某专家的台账（JSON 安全副本）。 */
	function listFor(workerId) {
		const entry = current.workers[String(workerId ?? "")];
		return (entry?.tasks ?? []).map((task) => ({ ...task }));
	}

	/** 列出全部（health 用）。 */
	function list() {
		const out = {};
		for (const [id, entry] of Object.entries(current.workers)) {
			out[id] = { tasks: entry.tasks.map((task) => ({ ...task })) };
		}
		return out;
	}

	/**
	 * 记一条任务（新建或续上）。
	 * @param workerId - 专家 id。
	 * @param entry - `{taskId, title, sessionId, task, at}`。
	 * @returns `{ok, taskId, created}`。
	 */
	function record(workerId, entry) {
		const id = typeof workerId === "string" ? workerId.trim() : "";
		const taskId = typeof entry?.taskId === "string" ? entry.taskId.trim() : "";
		if (id === "" || id === "general" || taskId === "") return { ok: false, error: "invalid-task-record" };
		const existing = current.workers[id] ?? { tasks: [] };
		const created = !existing.tasks.some((task) => task.taskId === taskId);
		const next = upsertTask(existing.tasks, { ...entry, taskId });
		current.workers[id] = { tasks: next };
		try {
			save(current);
		} catch (error) {
			return { ok: false, error: `save-failed: ${String(error?.message ?? error)}` };
		}
		return { ok: true, taskId, created };
	}

	/**
	 * 按 taskId 更新一条任务的部分字段（如标记完成、改会话）。
	 * @returns `{ok, changed}`。
	 */
	function patch(workerId, taskId, fields) {
		const id = typeof workerId === "string" ? workerId.trim() : "";
		const tid = typeof taskId === "string" ? taskId.trim() : "";
		const entry = current.workers[id];
		if (!entry || tid === "") return { ok: false, changed: false };
		const index = entry.tasks.findIndex((task) => task.taskId === tid);
		if (index === -1) return { ok: false, changed: false };
		const prev = entry.tasks[index];
		const next = { ...prev };
		if (typeof fields?.sessionId === "string" && fields.sessionId.trim() !== "") next.sessionId = fields.sessionId.trim();
		if (typeof fields?.title === "string" && fields.title.trim() !== "") next.title = fields.title.trim().slice(0, TASK_TITLE_LIMIT);
		if (fields?.status === "active" || fields?.status === "done") next.status = fields.status;
		if (Number.isFinite(fields?.at)) next.updatedAt = fields.at;
		entry.tasks[index] = next;
		current.workers[id] = entry;
		try {
			save(current);
		} catch (error) {
			return { ok: false, changed: true, error: `save-failed: ${String(error?.message ?? error)}` };
		}
		return { ok: true, changed: true };
	}

	/**
	 * 按会话 id 反查任务（某个会话刚汇报完 → 找到它属于哪条任务）。
	 * @returns 任务条目或 null。
	 */
	function bySession(workerId, sessionId) {
		const sid = String(sessionId ?? "");
		if (sid === "") return null;
		const found = (current.workers[String(workerId ?? "")]?.tasks ?? []).find((task) => task.sessionId === sid);
		return found === undefined ? null : { ...found };
	}

	/**
	 * 删除某专家的整本台账（V2.2 删专家时调用）。
	 * @returns `{ok, changed}`。
	 */
	function removeWorker(workerId) {
		const id = String(workerId ?? "");
		if (id === "" || !Object.prototype.hasOwnProperty.call(current.workers, id)) return { ok: true, changed: false };
		delete current.workers[id];
		try {
			save(current);
		} catch (error) {
			return { ok: false, changed: true, error: `save-failed: ${String(error?.message ?? error)}` };
		}
		return { ok: true, changed: true };
	}

	return {
		dir: stateDir,
		file,
		reload,
		set,
		state: () => ({
			version: TASK_STORE_VERSION,
			workers: Object.fromEntries(Object.entries(current.workers).map(([k, v]) => [k, { tasks: v.tasks.map((t) => ({ ...t })) }])),
		}),
		list,
		listFor,
		record,
		patch,
		bySession,
		removeWorker,
	};
}
