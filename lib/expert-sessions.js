/**
 * 专家会话注册表 + 共享记忆摘要（V1.8；V2.4 起带会话状态机）。
 *
 * ## V2.4：会话状态机（需求④）
 *
 * 每个会话有一个 `status`：
 *   - `active`    当前接受语音任务的会话 —— **每位专家最多一个**；
 *   - `suspended` 挂起：保留上下文与会话，但不接收任务（可再激活）；
 *   - `finished`  完结：任务已交差，保留在列表里备查（同样可复活）。
 *
 * 两条硬约束：
 *   1. **状态变更只能来自用户**（面板里点、或语音命令）—— 本模块不提供任何
 *      "任务来了顺手改状态"的接口，自动路径只允许**新建**一个 active 会话；
 *   2. **允许 0 个活跃会话**（全挂起/全完结是合法状态）。此时来了任务由
 *      session-manager 新建一个会话承接，而不是把某个旧会话偷偷改回 active。
 *
 * `activeSessionId` 仍是权威指针（`""` = 无活跃会话），`active` 是它的
 * 派生布尔 —— 派生字段保留是为了兼容 V1.8 的客户端与既有脚本。
 *
 * ## 这一层解决什么（专家与会话解耦）
 *
 * V1.3–V1.7：worker.id ↔ sessionId 是**硬编码一对一** —— sessionId 写在专家
 * 定义里，贯穿 `DEFAULT_WORKERS → normalizeWorkers → ensureWorkerAgents →
 * delegation.workers Map → followup`。一个专家只有一个会话、一份记忆。
 *
 * V1.8 把三者拆开：
 *   - **专家定义**（id/label/persona/description/skills）相对固定，是"能力身份"；
 *   - **会话**是运行时资源：每个专家有 N 个会话（至少一个默认会话），可由
 *     router 或用户显式新建、切换、关闭；
 *   - **记忆**分两层：会话自身的对话历史（DSH session 持久化）+ 专家级的
 *     **共享记忆摘要**（跨该专家所有会话，新会话也能接上上下文）。
 *
 * router（general / 根 agent）拥有全局记忆（`registerGlobalMemory`），
 * 每位专家拥有属于它的多个会话 + 一份跨会话摘要 —— 这正是需求①的记忆分层。
 *
 * ## 为什么注册表放在 expertDir 的 `_state/` 子目录
 *
 * `mergeWorkerSources`（workers.js）会把 `expertDirs` 下**一层**的每个 `*.json`
 * 当成一位专家定义。若把 sessions.json 直接丢在 expertDir 根，它会被误读成
 * 一个"缺少 id 的专家"并污染 health problems。放进 `_state/` 子目录即可 ——
 * 那层扫描只取顶层文件（`entry.isFile()`），不递归。
 *
 * ## 存储模型（原子写，崩溃不留半文件）
 *
 * ```
 * <expertDir>/_state/sessions.json
 * {
 *   version: 1,
 *   workers: {
 *     "bioinfo": {
 *       sessions: [ {sessionId, label, createdAt, status, active}, ... ],
 *       activeSessionId: "session-voice-worker-bioinfo-v2",  // "" = 无活跃会话
 *       digest: [ {at, workerId, sessionId, text}, ... ]  // 跨会话要点，最旧在前
 *     }
 *   }
 * }
 * ```
 *
 * 坏文件不致命：读取失败返回空注册表 + problems，下次写入自愈。
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** 注册表格式版本。 */
export const SESSION_STORE_VERSION = 1;
/** 每位专家最多保留的记忆摘要条数（超出丢最旧，防止无限膨胀）。 */
export const DIGEST_LIMIT = 30;
/** 单条摘要文本长度上限。 */
const DIGEST_TEXT_LIMIT = 200;
/** 单个专家最多会话数（防止误调用把磁盘写满）。 */
export const SESSIONS_PER_WORKER_LIMIT = 16;

/**
 * V2.4：没人给它起名时的占位标签。
 *
 * V1.8–V2.3 用的是「默认会话」，但那个名字把「还没派过任务」误导成
 * "这是默认的那一个" —— 用户看到一列「默认会话」根本分不清谁是谁。
 * 改成「待命」：它说的是**状态**（还没接到活），而不是身份。
 */
export const IDLE_SESSION_LABEL = "待命";

/** 旧版的占位名：读盘时若撞上就迁成「待命」，好让新任务能覆盖它。 */
export const LEGACY_IDLE_LABELS = new Set(["默认会话", "会话", "默认"]);

/** 会话状态取值（需求④）。 */
export const SESSION_STATUS = Object.freeze({
	ACTIVE: "active",
	SUSPENDED: "suspended",
	FINISHED: "finished",
});

/** 全部合法状态（归一化白名单）。 */
const STATUS_VALUES = new Set(Object.values(SESSION_STATUS));

/** 状态 → 中文（播报/界面统一口径）。 */
export const SESSION_STATUS_LABEL = Object.freeze({
	active: "活跃",
	suspended: "挂起",
	finished: "完结",
});

/**
 * 判断一个会话标签是不是"还没起过名"的占位。
 *
 * 占位名可以被任务名直接覆盖；用户自己起的名（哪怕是「默认会话」这四个字
 * 被手工写进去）只要不在白名单里就不动它。
 *
 * @param label - 会话标签。
 * @returns 是否占位。
 */
export function isIdleLabel(label) {
	const text = String(label ?? "").trim();
	if (text === "") return true;
	if (text === IDLE_SESSION_LABEL) return true;
	if (LEGACY_IDLE_LABELS.has(text)) return true;
	// V1.8 的 `会话 3` 也是占位（新建时按序号起的）。
	return /^会话\s*\d+$/.test(text);
}

/**
 * 从一段任务文本里抽一个会话名（纯函数，可单测）。
 *
 * 目标是"一眼看出这个会话在干什么"，所以做四件事：
 *   1. 剥掉转交时的礼貌前缀（"帮我""请""麻烦你"…），最多剥 4 轮；
 *   2. 取第一个分句（`，。；！？` 或换行切）；
 *   3. 兜底：首分句短于 4 个字就用整句（否则会得到"分析"这种没信息量的名字）；
 *   4. 去掉首尾语气词，截断到 24 字（多了加「…」）。
 *
 * @param task - 助手转交过来的任务原文。
 * @param fallback - 抽不出内容时的兜底名。
 * @returns 会话名。
 */
export function titleFromTask(task, fallback = IDLE_SESSION_LABEL) {
	const raw = String(task ?? "").replace(/\s+/g, " ").trim();
	if (raw === "") return fallback;
	let text = raw;
	const prefixes = /^(?:请你?|帮我|麻烦你?|帮忙|能不能|可以|能否|现在|然后|就是|那个|这个|你好[,，]?)\s*/;
	for (let i = 0; i < 4; i++) {
		const next = text.replace(prefixes, "");
		if (next === text) break;
		text = next;
	}
	// 首分句；太短就退回整句（"分析" 不如 "分析这批 RNA-seq 数据"）。
	const first = text.split(/[，,。；;！!？?\n]/)[0]?.trim() ?? "";
	let picked = first.length >= 4 ? first : text;
	// 去首尾语气词。
	picked = picked
		.replace(/^[的了]*(?:吧|呢|啊|呀)\s*/, "")
		.replace(/[的了\s]*(?:吧|呢|啊|呀|好吗|可以吗|谢谢)[\s。！!？?]*$/g, "")
		.trim();
	if (picked === "") return fallback;
	return picked.length > 24 ? `${picked.slice(0, 24)}…` : picked;
}

/**
 * 生成会话 id（纯函数，可单测）。
 *
 * 形如 `session-voice-worker-<id>-s<base36时间戳>-<4位随机>`：
 *   - 保留 `session-voice-worker-` 前缀，与既有会话命名一致、health 一眼可辨；
 *   - 时间戳 + 随机后缀保证同专家连续新建也不撞车；
 *   - 不触碰 sessions/ 目录本身 —— DSH 的 `registry.create({sessionId})` 会用
 *     这个 id 建目录并写 header，目录名与 header.id 天然一致（避开 assertStoredIdentity 坑）。
 *
 * @param workerId - 专家 id。
 * @param now - 时间戳（毫秒，可注入测试）。
 * @param rand - 随机串（可注入测试）。
 * @returns 会话 id。
 */
export function makeSessionId(workerId, now = Date.now(), rand = randomUUID().slice(0, 4)) {
	const id = String(workerId ?? "worker").replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || "worker";
	const stamp = Number.isFinite(now) ? Math.max(0, Math.floor(now)).toString(36) : "0";
	const suffix = String(rand ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 4) || "0";
	return `session-voice-worker-${id}-s${stamp}-${suffix}`;
}

/**
 * 归一化一段注册表原始数据（纯函数，可单测）。
 *
 * 容错优先：坏条目一律跳过，不让一条脏数据把整张表带塌。
 *
 * @param raw - 原始 JSON 值。
 * @returns 归一化后的 `{version, workers}`。
 */
export function normalizeSessionStore(raw) {
	const source = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	const workers = {};
	const srcWorkers = source.workers !== null && typeof source.workers === "object" && !Array.isArray(source.workers) ? source.workers : {};
	for (const [workerId, entry] of Object.entries(srcWorkers)) {
		if (typeof workerId !== "string" || workerId === "" || entry === null || typeof entry !== "object") continue;
		const seen = new Set();
		const sessions = [];
		for (const item of Array.isArray(entry.sessions) ? entry.sessions : []) {
			if (item === null || typeof item !== "object") continue;
			const sid = typeof item.sessionId === "string" ? item.sessionId.trim() : "";
			if (sid === "" || seen.has(sid)) continue;
			seen.add(sid);
			const rawLabel = typeof item.label === "string" && item.label.trim() !== "" ? item.label.trim().slice(0, 60) : IDLE_SESSION_LABEL;
			// V2.4 迁移：旧版只有布尔 `active`，且没有 status。老数据一律迁成
			// 三态 —— 免得读一次盘就把用户的"活跃"弄丢。
			const legacyActive = item.active === true;
			const status = STATUS_VALUES.has(item.status)
				? item.status
				: legacyActive
					? SESSION_STATUS.ACTIVE
					: SESSION_STATUS.SUSPENDED;
			sessions.push({
				sessionId: sid,
				// 旧占位名读盘时就地升级，否则下面"只覆盖占位名"的改名逻辑
				// 会认不出 V1.8 写下的「默认会话」。
				label: LEGACY_IDLE_LABELS.has(rawLabel) ? IDLE_SESSION_LABEL : rawLabel,
				createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0,
				status,
				active: status === SESSION_STATUS.ACTIVE,
			});
		}
		if (sessions.length === 0) continue;
		// ── 不变量：每位专家**至多一个** active ──────────────────────────
		//
		// 优先级：**显式 status 说了算**。`activeSessionId` 只在指向一个
		// status=active 的会话时才被认可 —— 否则会把一个用户明确标成「完结」
		// 的会话凭空复活（"完结可复活"是**用户操作**才有的效果，读盘不算）。
		//
		// 兼容旧数据：V1.8 只有布尔 `active`，上面已按它推出 status，所以
		// 老表里的活跃会话天然在候选集里，指针照常被认可。
		let activeSessionId = typeof entry.activeSessionId === "string" ? entry.activeSessionId.trim() : "";
		if (activeSessionId !== "" && !sessions.some((s) => s.sessionId === activeSessionId && s.status === SESSION_STATUS.ACTIVE)) {
			activeSessionId = "";
		}
		if (activeSessionId === "") {
			// 没有（或指针不可信）→ 取第一个 active 的；一个都没有就是
			// "无活跃会话"（合法状态，需求④）。
			const winner = sessions.find((s) => s.status === SESSION_STATUS.ACTIVE);
			activeSessionId = winner?.sessionId ?? "";
		}
		for (const s of sessions) {
			if (s.sessionId === activeSessionId) continue;
			// 多余的活跃（坏数据/并发写的残留）降为挂起，不是删除。
			if (s.status === SESSION_STATUS.ACTIVE) s.status = SESSION_STATUS.SUSPENDED;
		}
		for (const s of sessions) s.active = s.sessionId === activeSessionId && s.status === SESSION_STATUS.ACTIVE;
		const digest = [];
		for (const item of Array.isArray(entry.digest) ? entry.digest : []) {
			if (item === null || typeof item !== "object") continue;
			const text = typeof item.text === "string" ? item.text.trim().slice(0, DIGEST_TEXT_LIMIT) : "";
			if (text === "") continue;
			digest.push({
				at: Number.isFinite(item.at) ? item.at : 0,
				workerId: typeof item.workerId === "string" ? item.workerId : workerId,
				sessionId: typeof item.sessionId === "string" ? item.sessionId : "",
				text,
			});
		}
		workers[workerId] = { sessions, activeSessionId, digest: digest.slice(-DIGEST_LIMIT) };
	}
	return { version: SESSION_STORE_VERSION, workers };
}

/**
 * 把一条要点追加进摘要（纯函数，返回新数组）。
 *
 * 去重：与最后一条完全相同的文本不重复记（同一任务可能被汇总两次）。
 * 上限：超出 DIGEST_LIMIT 丢最旧。
 *
 * @param digest - 现有摘要数组。
 * @param entry - `{at, workerId, sessionId, text}`。
 * @returns 新摘要数组。
 */
export function appendDigestEntry(digest, entry) {
	const text = typeof entry?.text === "string" ? entry.text.trim().slice(0, DIGEST_TEXT_LIMIT) : "";
	if (text === "") return Array.isArray(digest) ? digest.slice() : [];
	const out = Array.isArray(digest) ? digest.slice() : [];
	if (out.length > 0 && out[out.length - 1].text === text) return out;
	out.push({
		at: Number.isFinite(entry.at) ? entry.at : Date.now(),
		workerId: typeof entry.workerId === "string" ? entry.workerId : "",
		sessionId: typeof entry.sessionId === "string" ? entry.sessionId : "",
		text,
	});
	return out.slice(-DIGEST_LIMIT);
}

/**
 * 把摘要渲染成可注入任务的背景记忆文本（纯函数）。
 *
 * @param digest - 摘要数组。
 * @returns 注入文本；无摘要时返回空串。
 */
export function renderDigest(digest) {
	if (!Array.isArray(digest) || digest.length === 0) return "";
	const lines = digest.slice(-DIGEST_LIMIT).map((entry) => `- ${entry.text}`);
	return `【该专家此前任务的要点（跨会话记忆，供你接上下文；若与本次任务无关请忽略）】\n${lines.join("\n")}`;
}

/**
 * 创建会话注册表管理器（绑定一个 expertDir）。
 *
 * @param dir - 专家目录绝对路径（通常取 `config.routing.expertDirs[0]`）。
 * @returns 管理器实例。
 */
export function createExpertSessionStore(dir) {
	const root = typeof dir === "string" && dir.trim() !== "" ? resolve(dir.trim()) : "";
	const stateDir = root === "" ? "" : join(root, "_state");
	const file = stateDir === "" ? "" : join(stateDir, "sessions.json");

	/** 读盘；坏文件返回空表 + problems（不抛）。 */
	function load() {
		if (file === "" || !existsSync(file)) return { store: { version: SESSION_STORE_VERSION, workers: {} }, problems: [] };
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8"));
			return { store: normalizeSessionStore(parsed), problems: [] };
		} catch (error) {
			return {
				store: { version: SESSION_STORE_VERSION, workers: {} },
				problems: [`sessions.json: 解析失败（${String(error?.message ?? error)}），已按空表处理`],
			};
		}
	}

	/** 原子写盘。 */
	function save(store) {
		if (file === "") throw new Error("no-expert-dir");
		if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, JSON.stringify(normalizeSessionStore(store), null, 2) + "\n", "utf8");
		try {
			renameSync(tmp, file);
		} catch (error) {
			try { unlinkSync(tmp); } catch { /* 清理失败不影响主错误 */ }
			throw error;
		}
	}

	/** 内存中的当前表（每次 load 后由调用方 set）。 */
	let current = { version: SESSION_STORE_VERSION, workers: {} };
	/** 从盘重载，返回 problems。 */
	function reload() {
		const { store, problems } = load();
		current = store;
		return problems;
	}
	/** 设置内存表（测试/首次初始化用）。 */
	function set(store) {
		current = normalizeSessionStore(store);
		return current;
	}

	/**
	 * 给一个 worker 确保有一个会话（用其定义里的 sessionId，向后兼容既有记忆）。
	 *
	 * 若注册表里还没有该 worker，或它的会话全丢了 → 建一条会话并写盘。
	 * 已存在则原样保留（绝不覆盖用户新建/切换/挂起过的状态）。
	 *
	 * 注意这里**只补位、不改状态**：启动时若发现该专家的会话全不活跃，
	 * 不会偷偷激活一个 —— 需求④要求状态变更由用户确认。留空即"没有活跃
	 * 会话"，来了任务由 session-manager 新开一个（这才是用户要的语义）。
	 *
	 * @param worker - `{id, sessionId, label}`。
	 * @returns `{ changed, session }`。
	 */
	function ensureDefault(worker) {
		const id = typeof worker?.id === "string" ? worker.id.trim() : "";
		if (id === "" || id === "general") return { changed: false, session: null };
		const existing = current.workers[id];
		if (existing && existing.sessions.length > 0) {
			return { changed: false, session: existing.sessions.find((s) => s.sessionId === existing.activeSessionId) ?? existing.sessions[0] };
		}
		const sid = typeof worker.sessionId === "string" && worker.sessionId.trim() !== ""
			? worker.sessionId.trim()
			: makeSessionId(id);
		// 首次登记：这个会话天然是活跃的（用户还没做过任何状态选择）。
		const session = { sessionId: sid, label: IDLE_SESSION_LABEL, createdAt: Date.now(), status: SESSION_STATUS.ACTIVE, active: true };
		current.workers[id] = { sessions: [session], activeSessionId: sid, digest: [] };
		save(current);
		return { changed: true, session };
	}

	/** 列出某 worker 的会话（JSON 安全）。 */
	function listFor(workerId) {
		const entry = current.workers[String(workerId ?? "")];
		if (!entry) return { sessions: [], activeSessionId: "", digest: entry?.digest ?? [] };
		return {
			sessions: entry.sessions.map((s) => ({ ...s })),
			activeSessionId: entry.activeSessionId,
			digest: entry.digest.map((d) => ({ ...d })),
		};
	}

	/** 列出全部（health / GET /sessions 用）。 */
	function list() {
		const out = {};
		for (const [id, entry] of Object.entries(current.workers)) out[id] = listFor(id);
		return out;
	}

	/** 取活跃会话 id。 */
	function activeOf(workerId) {
		return current.workers[String(workerId ?? "")]?.activeSessionId ?? "";
	}

	/**
	 * 新建会话（新会话天然是活跃的，原活跃会话降为挂起）。
	 *
	 * @param workerId - 专家 id。
	 * @param label - 会话名；省略则用占位名「待命」（等首个任务来命名）。
	 * @returns `{ok, session?, error?, suspended?}`。
	 */
	function createSession(workerId, label = "") {
		const id = typeof workerId === "string" ? workerId.trim() : "";
		if (id === "" || id === "general") return { ok: false, error: "invalid-worker" };
		const entry = current.workers[id] ?? { sessions: [], activeSessionId: "", digest: [] };
		if (entry.sessions.length >= SESSIONS_PER_WORKER_LIMIT) return { ok: false, error: "session-limit-reached" };
		const session = {
			sessionId: makeSessionId(id),
			label: typeof label === "string" && label.trim() !== "" ? label.trim().slice(0, 60) : IDLE_SESSION_LABEL,
			createdAt: Date.now(),
			status: SESSION_STATUS.ACTIVE,
			active: true,
		};
		// 唯一活跃约束：原活跃会话降为挂起（不删、不改名，用户随时能切回来）。
		const suspended = [];
		for (const s of entry.sessions) {
			if (s.status === SESSION_STATUS.ACTIVE) {
				s.status = SESSION_STATUS.SUSPENDED;
				s.active = false;
				suspended.push(s.sessionId);
			}
		}
		entry.sessions.push(session);
		entry.activeSessionId = session.sessionId;
		current.workers[id] = entry;
		save(current);
		return { ok: true, session: { ...session }, suspended };
	}

	/**
	 * 把一个会话切成活跃（其余活跃会话自动降为挂起 —— 唯一活跃约束）。
	 *
	 * @param workerId - 专家 id。
	 * @param sessionId - 目标会话。
	 * @returns `{ok, session?, error?, suspended?}`。
	 */
	function setActive(workerId, sessionId) {
		const id = typeof workerId === "string" ? workerId.trim() : "";
		const sid = typeof sessionId === "string" ? sessionId.trim() : "";
		const entry = current.workers[id];
		if (!entry || sid === "") return { ok: false, error: "not-found" };
		const target = entry.sessions.find((s) => s.sessionId === sid);
		if (!target) return { ok: false, error: "session-not-found" };
		const suspended = [];
		for (const s of entry.sessions) {
			if (s.sessionId === sid) {
				s.status = SESSION_STATUS.ACTIVE;
				s.active = true;
				continue;
			}
			if (s.status === SESSION_STATUS.ACTIVE) {
				s.status = SESSION_STATUS.SUSPENDED;
				s.active = false;
				suspended.push(s.sessionId);
			} else {
				s.active = false;
			}
		}
		entry.activeSessionId = sid;
		save(current);
		return { ok: true, session: { ...target }, suspended };
	}

	/**
	 * V2.4 需求④：改一个会话的状态（用户主动确认的唯一入口）。
	 *
	 * - `active`：走 setActive（唯一活跃约束由它保证）；
	 * - `suspended` / `finished`：原地改状态，**保留会话本身**（完结≠关闭）。
	 *   若改的正是活跃会话，则 `activeSessionId` 清空 —— 该专家进入"没有活跃
	 *   会话"状态，下次来任务会新开一个（需求④的语义）。
	 *
	 * @param workerId - 专家 id。
	 * @param sessionId - 目标会话。
	 * @param status - `active` / `suspended` / `finished`。
	 * @returns `{ok, session?, error?, activeSessionId?}`。
	 */
	function setStatus(workerId, sessionId, status) {
		const next = String(status ?? "").trim();
		if (!STATUS_VALUES.has(next)) return { ok: false, error: "invalid-status" };
		if (next === SESSION_STATUS.ACTIVE) return setActive(workerId, sessionId);
		const id = typeof workerId === "string" ? workerId.trim() : "";
		const sid = typeof sessionId === "string" ? sessionId.trim() : "";
		const entry = current.workers[id];
		if (!entry || sid === "") return { ok: false, error: "not-found" };
		const target = entry.sessions.find((s) => s.sessionId === sid);
		if (!target) return { ok: false, error: "session-not-found" };
		target.status = next;
		target.active = false;
		if (entry.activeSessionId === sid) entry.activeSessionId = "";
		save(current);
		return { ok: true, session: { ...target }, activeSessionId: entry.activeSessionId };
	}

	/**
	 * V2.4 需求③：给会话改名。
	 *
	 * `onlyIfIdle`（默认 true）= 只在当前是占位名时生效。这是为了不覆盖用户
	 * 自己起的名字：任务转交是自动路径，自动路径不该动用户的手工结果。
	 *
	 * @param workerId - 专家 id。
	 * @param sessionId - 目标会话。
	 * @param label - 新名字。
	 * @param options - `{onlyIfIdle?}`。
	 * @returns `{ok, changed, session?, error?}`。
	 */
	function renameSession(workerId, sessionId, label, options = {}) {
		const id = typeof workerId === "string" ? workerId.trim() : "";
		const sid = typeof sessionId === "string" ? sessionId.trim() : "";
		const next = typeof label === "string" ? label.trim().slice(0, 60) : "";
		if (next === "") return { ok: false, changed: false, error: "label-required" };
		const entry = current.workers[id];
		if (!entry || sid === "") return { ok: false, changed: false, error: "not-found" };
		const target = entry.sessions.find((s) => s.sessionId === sid);
		if (!target) return { ok: false, changed: false, error: "session-not-found" };
		const onlyIfIdle = options.onlyIfIdle !== false;
		if (onlyIfIdle && !isIdleLabel(target.label)) return { ok: true, changed: false, session: { ...target } };
		if (target.label === next) return { ok: true, changed: false, session: { ...target } };
		target.label = next;
		save(current);
		return { ok: true, changed: true, session: { ...target } };
	}

	/**
	 * V2.4 需求③：按任务名给会话命名（自动路径，只动占位名）。
	 *
	 * @param workerId - 专家 id。
	 * @param sessionId - 目标会话。
	 * @param task - 助手转交的任务原文。
	 * @returns `{ok, changed, label?, session?, error?}`。
	 */
	function nameByTask(workerId, sessionId, task) {
		const label = titleFromTask(task);
		if (label === IDLE_SESSION_LABEL) return { ok: false, changed: false, error: "task-empty" };
		const result = renameSession(workerId, sessionId, label, { onlyIfIdle: true });
		return { ...result, label };
	}

	/**
	 * 关闭会话（至少保留一个；关活跃会话会自动切到另一个）。
	 * 注意：这里只改注册表，agent 实例的释放由调用方负责。
	 *
	 * 与「完结」的区别：完结是状态标记（会话留着备查），关闭是把它从列表里
	 * 真的拿掉 —— 两者并存，由用户在界面上分别操作（V2.4 需求④）。
	 */
	function closeSession(workerId, sessionId) {
		const id = typeof workerId === "string" ? workerId.trim() : "";
		const sid = typeof sessionId === "string" ? sessionId.trim() : "";
		const entry = current.workers[id];
		if (!entry) return { ok: false, error: "not-found" };
		if (entry.sessions.length <= 1) return { ok: false, error: "last-session" };
		const index = entry.sessions.findIndex((s) => s.sessionId === sid);
		if (index === -1) return { ok: false, error: "session-not-found" };
		const [removed] = entry.sessions.splice(index, 1);
		if (entry.activeSessionId === sid) {
			// 关掉活跃会话：优先让一个"还活着的"（挂起）会话顶上；若剩下的
			// 全是完结会话，就留一个"没有活跃会话"的状态 —— 不擅自复活完结
			// 会话，需求④的语义是"全不活跃则新开"。
			const fallback = entry.sessions.find((s) => s.status === SESSION_STATUS.SUSPENDED)
				?? entry.sessions.find((s) => s.status === SESSION_STATUS.ACTIVE)
				?? null;
			entry.activeSessionId = fallback?.sessionId ?? "";
			for (const s of entry.sessions) {
				if (fallback !== null && s.sessionId === fallback.sessionId) {
					s.status = SESSION_STATUS.ACTIVE;
					s.active = true;
				} else {
					s.active = false;
					if (s.status === SESSION_STATUS.ACTIVE) s.status = SESSION_STATUS.SUSPENDED;
				}
			}
		}
		current.workers[id] = entry;
		save(current);
		return { ok: true, session: removed, activeSessionId: entry.activeSessionId };
	}

	/** 追加一条跨会话记忆摘要。 */
	function appendDigest(workerId, entry) {
		const id = typeof workerId === "string" ? workerId.trim() : "";
		const existing = current.workers[id] ?? { sessions: [], activeSessionId: "", digest: [] };
		existing.digest = appendDigestEntry(existing.digest, { ...entry, workerId: id });
		current.workers[id] = existing;
		save(current);
		return existing.digest.length;
	}

	/** 取某专家的摘要（渲染成可注入文本）。 */
	function digestText(workerId) {
		return renderDigest(current.workers[String(workerId ?? "")]?.digest ?? []);
	}

	/**
	 * V2.2：删除专家时清掉它的会话注册表条目（会话列表 + 跨会话摘要）。
	 * 只动注册表这一个文件；DSH 侧的历史会话目录保留（避免误删数据）。
	 * @param workerId - 被删专家 id。
	 * @returns `{ ok, changed }`。
	 */
	function removeWorker(workerId) {
		const id = String(workerId ?? "");
		if (id === "" || !Object.prototype.hasOwnProperty.call(current.workers, id)) {
			return { ok: true, changed: false };
		}
		delete current.workers[id];
		try {
			save();
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
		state: () => ({ version: SESSION_STORE_VERSION, workers: Object.fromEntries(Object.entries(current.workers).map(([k, v]) => [k, listFor(k)])) }),
		ensureDefault,
		list,
		listFor,
		activeOf,
		createSession,
		setActive,
		setStatus,
		renameSession,
		nameByTask,
		closeSession,
		appendDigest,
		digestText,
		removeWorker,
	};
}
