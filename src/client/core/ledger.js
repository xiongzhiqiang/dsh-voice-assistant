/**
 * 播报水位（客户端持久化）—— 需求②：让助手记住"已经播报到哪个位置"。
 *
 * ## 这一层解决什么
 *
 * 真机症状：助手前面汇报过的内容，**再次打开页面时又播报一遍**。
 *
 * 根因是水位**全在内存里**，刷新即归零：
 *
 * | 水位 | 位置 | 刷新后 |
 * |---|---|---|
 * | `interactionCursor` | controller | 归零 → 首帧种子 |
 * | `reportCursor` | controller | 归零 → 首帧种子 |
 * | `cursor`（会话 seq） | session | 归零 → 靠 `floorTime` 兜 |
 * | `announced`（提问） | QuestionBridge | 归零 → 投影重放就重念 |
 *
 * 而服务端的队列（`reportQueue` / `interactionQueue`）**活在宿主进程里**，
 * 页面刷新不会清空它。两条合起来就是"用户刷新一次，听到一遍旧的"。
 *
 * ## 为什么"首帧 seed 成 latest"不够
 *
 * 现有实现就是靠首帧 `after=latest` 跳过历史的。它挡得住"整批历史涌入"，
 * 但有两个洞：
 *
 *   1. **同一毫秒 / 游标回退**：`latest` 只对齐到"服务端当前游标"，
 *      而服务端游标是 `max(Date.now(), …)` —— 刷新发生在两次播报之间时，
 *      已经把上次播报过的条目重新纳入增量窗口（真机上见过的表现是
 *      "最后一条汇报又念一遍"）；
 *   2. **降级双通道**：`/reports` 与 `/interactions` 是同一条汇报的两个
 *      端点。首帧两端各拉一次，谁先到谁念 —— 于是同一条汇报有可能被念两遍
 *      （代码里那句 `if (this.interactionsAvailable) return` 只在**第二轮**
 *      之后才生效）。
 *
 * 所以这里做两件更硬的事：
 *
 *   - **持久化游标**（毫秒水位，跨刷新、跨 DSH 重启有效，因为是墙钟）；
 *   - **持久化"已播过的 key 集合"** —— 同一条互动（按 `kind + key` 认）
 *     无论从哪条通道、被投递几次，一辈子只播一次。
 *
 * ## 追补窗口
 *
 * 光有游标会带来反问题：用户关页面一整天，回来时水位停在一整天前，
 * 服务端那 200 条队列会被一次性念完 —— 比重复播报更糟。
 * 所以带一个**追补窗口**（默认 10 分钟）：比这个窗口老的条目**记账但不播**
 * （游标照常推进），只有窗口内的才真念出来。
 *
 * ## 存储要有兜底
 *
 * `localStorage` 在隐私模式、配额满、非浏览器环境里都可能抛。任何一次
 * 读写异常都不能让语音链路崩掉，所以 `createSafeStorage` 把全部操作包住，
 * 失败时退化成**内存实现**（功能降级到"本次会话内有效"，绝不影响出声）。
 */

/** 存储键前缀（带版本号，将来换结构时不会读到老格式）。 */
const PREFIX = "xfv:v1:";

/**
 * 追补窗口默认值（毫秒）。
 *
 * 10 分钟是"用户去倒了杯水回来"的量级：这个范围内的内容多半还没听到，
 * 补播有价值；再老的补播就是噪音了（而且服务端队列本来也留不了那么久）。
 */
export const CATCHUP_WINDOW_MS = 10 * 60 * 1000;

/** 已播 key 的记忆条数上限（防止 localStorage 无界增长）。 */
export const LEDGER_LIMIT = 200;

/** 游标合理性上限：超过"现在 + 5 分钟"的游标一律视为损坏。 */
const CURSOR_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * 纯内存的键值存储（`localStorage` 不可用时的兜底）。
 *
 * 有意做成与 `localStorage` 同形状（`getItem` / `setItem` / `removeItem`），
 * 这样"有没有持久化"这件事对上层完全透明 —— 上层不需要写两条分支。
 *
 * @returns 存储对象。
 */
export function memoryStorage() {
	const map = new Map();
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => {
			map.set(key, String(value));
		},
		removeItem: (key) => {
			map.delete(key);
		},
	};
}

/**
 * 取一个**不会抛**的存储。
 *
 * `localStorage` 的存在性本身就可能抛（某些环境的 `window` 代理），
 * 所以连"取它"都要包在 try 里。拿不到就用内存实现。
 *
 * @param raw - 候选存储（默认 `globalThis.localStorage`）。
 * @returns `{ storage, persistent, reason }`。
 */
export function resolveStorage(raw) {
	let candidate = raw;
	if (candidate === undefined) {
		try {
			candidate = globalThis.localStorage ?? undefined;
		} catch {
			candidate = undefined;
		}
	}
	if (
		candidate !== undefined &&
		candidate !== null &&
		typeof candidate.getItem === "function" &&
		typeof candidate.setItem === "function"
	) {
		return { storage: candidate, persistent: true, reason: "" };
	}
	return { storage: memoryStorage(), persistent: false, reason: raw === undefined ? "no-local-storage" : "storage-unusable" };
}

/**
 * 创建带容错与 JSON 编解码的存储门面。
 *
 * @param raw - 候选存储。
 * @returns `{ read(key, fallback), write(key, value), drop(key), persistent, reason }`。
 */
export function createSafeStorage(raw) {
	const { storage, persistent, reason } = resolveStorage(raw);
	return {
		/**
		 * 读一个 JSON 对象。
		 * @param key - 键。
		 * @param fallback - 读不到/坏了时的返回值。
		 * @returns 解析结果或 `fallback`。
		 */
		read(key, fallback) {
			try {
				const text = storage.getItem(key);
				if (typeof text !== "string" || text === "") return fallback;
				const parsed = JSON.parse(text);
				return parsed === null || typeof parsed !== "object" ? fallback : parsed;
			} catch {
				// 坏数据（用户手改 / 跨版本残留）当作"没有"，不抛。
				return fallback;
			}
		},
		/**
		 * 写一个 JSON 对象。
		 * @param key - 键。
		 * @param value - 值。
		 * @returns 是否写入成功。
		 */
		write(key, value) {
			try {
				storage.setItem(key, JSON.stringify(value));
				return true;
			} catch {
				// 配额满 / 隐私模式：记账失败不该影响播报本身。
				return false;
			}
		},
		/**
		 * 删除一个键。
		 * @param key - 键。
		 */
		drop(key) {
			try {
				storage.removeItem(key);
			} catch {
				// 删不掉也无所谓（下次读到坏值会走 fallback）。
			}
		},
		persistent,
		reason,
	};
}

/**
 * 生成一条互动的"身份"（用于跨刷新去重）。
 *
 * 优先用服务端给的原生 id（汇报的 `key`/`jobId`、审批的 `id`、
 * 提问的 `callId`）—— 那些是服务端保证唯一的东西。都没有时才退回
 * 文本哈希，这样至少"同一句话不会念两遍"。
 *
 * @param entry - 互动条目。
 * @returns 稳定字符串（空条目返回空串）。
 */
export function entryIdentity(entry) {
	const kind = String(entry?.kind ?? "");
	const key = String(entry?.key ?? entry?.jobId ?? entry?.callId ?? "").trim();
	if (key !== "") return `${kind}:${key}`;
	const speech = String(entry?.speech ?? "").trim();
	if (speech === "") return "";
	return `${kind}:#${hashText(speech)}`;
}

/**
 * 短文本哈希（FNV-1a 变体，32 位十六进制）。
 *
 * 只用来给"没有 id 的条目"一个稳定身份，不做加密用途 —— 所以不引 crypto
 * （客户端 bundle 是同步求值，拿不到异步 API）。
 *
 * @param text - 文本。
 * @returns 8 位十六进制串。
 */
export function hashText(text) {
	const value = String(text ?? "");
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * 创建"播报账本"：持久化游标 + 已播 key 集合。
 *
 * @param options - `{ scope, storage, limit, now }`。
 *   `scope` 让账本按助手实例隔离（多个 DSH_HOME 共用 origin 时不互相污染）。
 * @returns 账本对象。
 */
export function createPlaybackLedger(options = {}) {
	const store = createSafeStorage(options.storage);
	const scope = String(options.scope ?? "default").trim() || "default";
	const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : LEDGER_LIMIT;
	const storageKey = `${PREFIX}played:${scope}`;

	let cursor = 0;
	/** 已播 key（有序，超限从头部丢，保留最近的）。 */
	let keys = [];
	const seen = new Set();

	// 载入：坏数据一律当"没有记录"（宁可多播一次，也不要因为一条坏 JSON
	// 让助手从此再也不播报 —— 那是静默失效，最难查）。
	const loaded = store.read(storageKey, null);
	if (loaded !== null) {
		const savedCursor = Number(loaded.cursor);
		cursor = Number.isFinite(savedCursor) && savedCursor > 0 ? savedCursor : 0;
		// 游标"跑到未来"只可能是时钟回拨或数据被改坏 —— 重置，
		// 否则服务端永远没有 `at > cursor` 的条目，播报会彻底哑掉。
		const ceiling = (Number.isFinite(options.now) ? options.now : Date.now()) + CURSOR_FUTURE_TOLERANCE_MS;
		if (cursor > ceiling) cursor = 0;
		const savedKeys = Array.isArray(loaded.keys) ? loaded.keys : [];
		for (const item of savedKeys) {
			const value = String(item ?? "");
			if (value === "" || seen.has(value)) continue;
			seen.add(value);
			keys.push(value);
		}
		if (keys.length > limit) keys = keys.slice(-limit);
	}

	/** 落盘（每次变更后调一次；写入失败只是丢持久化，不影响本轮播报）。 */
	const flush = () => {
		store.write(storageKey, { cursor, keys: keys.slice(-limit) });
	};

	return {
		/** 已播到的时间水位（毫秒）。0 = 还没有记录。 */
		get cursor() {
			return cursor;
		},
		/** 记住的 key 条数（自省用）。 */
		get size() {
			return keys.length;
		},
		/**
		 * 对齐水位（**不播报**）。
		 *
		 * 用在"服务端当前游标"上：首次使用（本地无记录）时把水位推到
		 * 服务端当前位置，这样页面一打开不会把历史全念一遍。
		 *
		 * @param value - 服务端游标。
		 * @returns 是否真的写入了。
		 */
		seed(value) {
			const next = Number(value);
			if (!Number.isFinite(next) || next <= cursor) return false;
			cursor = next;
			flush();
			return true;
		},
		/**
		 * 推进水位（播报/记账之后调）。
		 * 只前进不后退 —— 服务端重启后游标归零，倒退会把旧条目重新纳入窗口。
		 * @param value - 服务端游标。
		 * @returns 是否真的写入了。
		 */
		advance(value) {
			const next = Number(value);
			if (!Number.isFinite(next) || next <= cursor) return false;
			cursor = next;
			flush();
			return true;
		},
		/**
		 * 该条是否还没播过（**会记账**）。
		 *
		 * 记账与判定合一，避免"判了没记"导致下一次又问一遍。
		 *
		 * @param entry - 互动条目。
		 * @returns `true` = 该播。
		 */
		claim(entry) {
			const id = entryIdentity(entry);
			if (id === "") return true; // 认不出身份就别拦（宁可多播，不可漏播）。
			if (seen.has(id)) return false;
			seen.add(id);
			keys.push(id);
			if (keys.length > limit) {
				const dropped = keys.splice(0, keys.length - limit);
				for (const value of dropped) seen.delete(value);
			}
			flush();
			return true;
		},
		/** 只读查询（不记账）。 */
		has(entry) {
			const id = entryIdentity(entry);
			return id === "" ? false : seen.has(id);
		},
		/**
		 * 自省快照（真机排障 / `__xfvDebug` 用）。
		 * @returns `{ scope, cursor, size, keys, persistent, reason }`。
		 */
		snapshot() {
			return { scope, cursor, size: keys.length, keys: keys.slice(-12), persistent: store.persistent, reason: store.reason };
		},
		/** 清空（仅测试/用户手动重置用）。 */
		clear() {
			cursor = 0;
			keys = [];
			seen.clear();
			store.drop(storageKey);
		},
	};
}

/**
 * 创建"会话 seq 水位"存储（需求②的另一半）。
 *
 * ## 为什么会话那条也得持久化
 *
 * 会话事件的去重靠 `seq`（`session.js` 的水位线），而 `seq` **只在内存里**。
 * 页面刷新后水位从"当前窗口最大 seq"重算 —— 注释里说过历史不一定在
 * retain 时同步就位，窗口为空时水位是 −1，随后历史整批灌入，只剩
 * `floorTime`（`绑定时刻 − 2s`）这道时间闸兜着。
 *
 * 时间闸有个洞：`event.time` **不是数字**时它整条被跳过 —— 而"跳过"的意思是
 * **放行**（`if (time !== null && time < floorTime)`，`time` 为 null 直接不判）。
 * 于是没有时间戳的历史事件会被当新事件处理，助手把旧回答又念一遍。
 *
 * 而 `seq` 是按会话单调的整数，**天生跨刷新可比** —— 比时间戳硬得多。
 *
 * @param options - `{ storage }`。
 * @returns `{ read(sessionId), write(sessionId, seq), snapshot(), clear() }`。
 */
export function createSeqWatermark(options = {}) {
	const store = createSafeStorage(options.storage);
	const storageKey = `${PREFIX}seq`;
	let marks = {};
	const loaded = store.read(storageKey, null);
	if (loaded !== null && loaded.marks !== null && typeof loaded.marks === "object") {
		for (const [key, value] of Object.entries(loaded.marks)) {
			const seq = Number(value);
			if (typeof key === "string" && key !== "" && Number.isFinite(seq)) marks[key] = seq;
		}
	}
	const flush = () => store.write(storageKey, { marks });

	return {
		/**
		 * 取某个会话"已处理到"的 seq。
		 * @param sessionId - 会话 id。
		 * @returns seq（没记录时 `null`）。
		 */
		read(sessionId) {
			const id = String(sessionId ?? "");
			const value = marks[id];
			return Number.isFinite(value) ? value : null;
		},
		/**
		 * 记下某个会话"已处理到"的 seq（只前进）。
		 * @param sessionId - 会话 id。
		 * @param seq - 序号。
		 * @returns 是否真的写入了。
		 */
		write(sessionId, seq) {
			const id = String(sessionId ?? "");
			const next = Number(seq);
			if (id === "" || !Number.isFinite(next) || next < 0) return false;
			const current = marks[id];
			if (Number.isFinite(current) && current >= next) return false;
			marks[id] = next;
			flush();
			return true;
		},
		/**
		 * 清掉某个会话的记录（换会话/会话被删时用）。
		 * @param sessionId - 会话 id。
		 * @returns 是否删掉了。
		 */
		drop(sessionId) {
			const id = String(sessionId ?? "");
			if (!(id in marks)) return false;
			delete marks[id];
			flush();
			return true;
		},
		/** 自省快照。 */
		snapshot() {
			return { marks: { ...marks }, persistent: store.persistent, reason: store.reason };
		},
		/** 清空（仅测试用）。 */
		clear() {
			marks = {};
			store.drop(storageKey);
		},
	};
}

/**
 * 一条互动是否在**追补窗口**内（窗口内的才真播，更老的只记账）。
 *
 * @param entry - 互动条目（读 `at`）。
 * @param options - `{ now, windowMs }`。
 * @returns 是否该出声。
 */
export function withinCatchup(entry, options = {}) {
	const windowMs = Number.isFinite(options.windowMs) ? Math.max(0, options.windowMs) : CATCHUP_WINDOW_MS;
	if (windowMs === 0) return true; // 显式关掉窗口 = 全都补播。
	const at = Number(entry?.at);
	if (!Number.isFinite(at)) return true; // 没有时间戳就不敢拦（宁可多播）。
	const now = Number.isFinite(options.now) ? options.now : Date.now();
	return now - at <= windowMs;
}
