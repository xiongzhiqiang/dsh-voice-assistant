/**
 * 专家会话注册表 + 共享记忆摘要（V1.8）。
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
 *       sessions: [ {sessionId, label, createdAt, active}, ... ],
 *       activeSessionId: "session-voice-worker-bioinfo-v2",
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
			sessions.push({
				sessionId: sid,
				label: typeof item.label === "string" && item.label.trim() !== "" ? item.label.trim().slice(0, 60) : "会话",
				createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0,
				active: item.active === true,
			});
		}
		if (sessions.length === 0) continue;
		let activeSessionId = typeof entry.activeSessionId === "string" ? entry.activeSessionId.trim() : "";
		if (!seen.has(activeSessionId)) {
			activeSessionId = (sessions.find((s) => s.active) ?? sessions[0]).sessionId;
		}
		for (const s of sessions) s.active = s.sessionId === activeSessionId;
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
	 * 给一个 worker 确保有默认会话（用其定义里的 sessionId，向后兼容既有记忆）。
	 *
	 * 若注册表里还没有该 worker，或它的会话全丢了 → 建一条默认会话并写盘。
	 * 已存在则原样保留（绝不覆盖用户新建/切换过的状态）。
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
		const session = { sessionId: sid, label: "默认会话", createdAt: Date.now(), active: true };
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
	 * 新建会话。
	 * @returns `{ok, session?, error?}`。
	 */
	function createSession(workerId, label = "") {
		const id = typeof workerId === "string" ? workerId.trim() : "";
		if (id === "" || id === "general") return { ok: false, error: "invalid-worker" };
		const entry = current.workers[id] ?? { sessions: [], activeSessionId: "", digest: [] };
		if (entry.sessions.length >= SESSIONS_PER_WORKER_LIMIT) return { ok: false, error: "session-limit-reached" };
		const session = {
			sessionId: makeSessionId(id),
			label: typeof label === "string" && label.trim() !== "" ? label.trim().slice(0, 60) : `会话 ${entry.sessions.length + 1}`,
			createdAt: Date.now(),
			active: true,
		};
		for (const s of entry.sessions) s.active = false;
		entry.sessions.push(session);
		entry.activeSessionId = session.sessionId;
		current.workers[id] = entry;
		save(current);
		return { ok: true, session: { ...session } };
	}

	/** 切换活跃会话。 */
	function setActive(workerId, sessionId) {
		const id = typeof workerId === "string" ? workerId.trim() : "";
		const sid = typeof sessionId === "string" ? sessionId.trim() : "";
		const entry = current.workers[id];
		if (!entry || sid === "") return { ok: false, error: "not-found" };
		const target = entry.sessions.find((s) => s.sessionId === sid);
		if (!target) return { ok: false, error: "session-not-found" };
		for (const s of entry.sessions) s.active = s.sessionId === sid;
		entry.activeSessionId = sid;
		save(current);
		return { ok: true, session: { ...target } };
	}

	/**
	 * 关闭会话（至少保留一个；关活跃会话会自动切到另一个）。
	 * 注意：这里只改注册表，agent 实例的释放由调用方负责。
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
			const next = entry.sessions[Math.min(index, entry.sessions.length - 1)];
			entry.activeSessionId = next.sessionId;
			for (const s of entry.sessions) s.active = s.sessionId === next.sessionId;
		}
		current.workers[id] = entry;
		save(current);
		return { ok: true, session: removed };
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
		closeSession,
		appendDigest,
		digestText,
		removeWorker,
	};
}
