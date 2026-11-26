/**
 * 专家管理中枢（V1.7）：把"增删专家"从写文件一路贯通到运行期生效。
 *
 * ## 为什么要这一层
 *
 * 单纯写文件只能让**重启后**生效（目录扫描发生在启动时）。用户在语音里说
 * "加一个化学专家"，期待的是**当场就能用**。所以管理中枢在写文件之后还要：
 *   1. 用原始配置重新 `normalizeConfig`（会重扫 expertDirs 拿到最新清单）；
 *   2. **原地**替换 `config.routing.workers` 数组的内容（routes.js 持有的是
 *      同一个对象引用，替换引用不会生效，必须 splice）；
 *   3. 对比出新增/删除的 id：新增的建常驻 agent 并注册进委托中枢，删除的
 *      从委托中枢注销；
 *   4. 把新增 agent 的建立结果回传给宿主，合并进 health 的 workersStatus。
 *
 * ## 降级纪律
 *
 * - agentLoop scope 尚未注入（精简 profile / 启动早期）时，只更新清单不建
 *   agent：health 显示未就绪，重启后补齐。不因拿不到 scope 就让接口失败。
 * - 建 agent 失败 singly 记入结果，不连坐其它专家（与启动链路同一口径）。
 */
import { normalizeConfig } from "./config.js";
import { ensureWorkerAgents } from "./workers.js";
import { createExpertRegistry } from "./expert-registry.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { watch } from "node:fs";

/**
 * 默认专家目录（V2.2）：`~/.dsh/voice-assistant/experts`（DSH_HOME 可覆盖）。
 *
 * 这是「专家定义唯一真相源」的标准落点。装配层会在用户没显式配 expertDirs
 * 时把它注入 `originalConfig`（见 index.js），保证**管理接口 add/remove 写入
 * 的 JSON** 与**配置扫描的目录**永远是同一个 —— 否则用户漏配 YAML 时会出现
 * "加了专家、文件也写了、运行时却读不到"的双源漂移。
 *
 * @returns 目录绝对路径。
 */
export function defaultExpertDir() {
	const root = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(root, "voice-assistant", "experts");
}

/**
 * 从归一化配置里取专家目录（纯函数，可单测）。
 *
 * 优先用用户配的 `routing.expertDirs[0]`（与目录扫描同源），没配则回退到
 * `defaultExpertDir()` —— 保证管理接口永远有一个可写落点，不必要求用户先改 YAML。
 *
 * @param config - 归一化配置。
 * @returns 目录绝对路径。
 */
export function expertDirFromConfig(config) {
	const dirs = config?.routing?.expertDirs;
	if (Array.isArray(dirs) && dirs.length > 0 && typeof dirs[0] === "string" && dirs[0].trim() !== "") {
		return dirs[0].trim();
	}
	return defaultExpertDir();
}

/**
 * 创建专家管理中枢。
 *
 * @param options - 依赖注入。
 * @param options.originalConfig - `cordis.patch.yml` 的原始 config（重扫用）。
 * @param options.normalized - 当前归一化配置（原地更新其 routing.workers）。
 * @param options.delegation - 委托中枢（需 `addWorker` / `removeWorker` / `workers`）。
 * @param options.skillCatalog - 技能目录（建新 agent 挂技能用）。
 * @param options.getScope - 取 agentLoop scope 的函数（可能返回 null）。
 * @param options.ctx - 宿主 ctx（建 agent 用）。
 * @param options.dir - 专家目录绝对路径。
 * @param options.onWorkerBuilt - 回调：一个 worker agent 建好/更新（合并进 health）。
 * @param options.onWorkerRemoved - 回调：一个 worker 被删除（同步 health）。
 * @param options.sessionStore - 会话注册表（V2.2：删专家时清会话条目、新增时建默认会话）。
 * @param options.logger - 可选日志器。
 * @returns `{ dir, registry, list, add, remove, applyChanges, startWatching, stopWatching }`。
 */
export function createExpertManager(options) {
	const {
		originalConfig,
		normalized,
		delegation,
		skillCatalog,
		getScope,
		ctx,
		dir,
		onWorkerBuilt = null,
		onWorkerRemoved = null,
		sessionStore = null,
		logger = null,
	} = options;
	const registry = createExpertRegistry(dir);
	const log = (level, msg) => {
		if (logger && typeof logger[level] === "function") logger[level](msg);
	};

	/**
	 * 重扫目录 + 原地更新清单 + 增删 agent。
	 *
	 * @returns `{ ok, added:[id], removed:[id], workers:[...] , error? }`。
	 */
	async function applyChanges() {
		let next;
		try {
			next = normalizeConfig(originalConfig);
		} catch (error) {
			return { ok: false, added: [], removed: [], changed: [], error: `renormalize-failed: ${String(error?.message ?? error)}` };
		}

		const oldById = new Map((normalized.routing.workers ?? []).map((w) => [w.id, w]));
		const oldIds = new Set(oldById.keys());
		const nextWorkers = next.routing.workers ?? [];
		const newIds = new Set(nextWorkers.map((w) => w.id));
		const added = nextWorkers.filter((w) => !oldIds.has(w.id));
		const removed = [...oldIds].filter((id) => !newIds.has(id));

		/**
		 * V2.4：同 id 但**定义变了**的专家（改了 persona/skills/description/label）。
		 *
		 * ## 为什么单独检出来（而不是当没变化）
		 *
		 * agent 的 persona 与技能是在它的 `setup()` 里生效的，而已建的常驻
		 * agent 走 `ensurePersistentAgent` 的 `get` 分支直接被复用 —— 所以
		 * **改定义不会重建 agent**，用户改了技能名却发现"没生效"，且日志
		 * 一声不响。真机踩到过：把 genetic 的技能名写错，health 的
		 * `skills.missing` 一直挂着旧值。
		 *
		 * 完整解法是"定义变更 → 重建该 agent"，但重建会丢掉该会话的运行态
		 * （在途轮次、上下文缓存），代价与收益需要单独设计。在那之前，
		 * 按本项目的纪律**绝不静默**：检出变更、明确告警、如实回传给 health。
		 */
		const changed = [];
		for (const worker of nextWorkers) {
			const previous = oldById.get(worker.id);
			if (previous === undefined) continue;
			const fields = ["label", "description", "persona"];
			const fieldDiff = fields.filter((f) => String(previous[f] ?? "") !== String(worker[f] ?? ""));
			const skillsDiff = JSON.stringify(previous.skills ?? []) !== JSON.stringify(worker.skills ?? []);
			if (fieldDiff.length > 0 || skillsDiff) {
				changed.push({ id: worker.id, fields: skillsDiff ? [...fieldDiff, "skills"] : fieldDiff });
			}
		}

		// 原地替换，保住 routes.js / clientConfig 手里的引用。
		const wc = normalized.routing.workers;
		if (Array.isArray(wc)) {
			wc.splice(0, wc.length, ...nextWorkers);
		} else {
			normalized.routing.workers = nextWorkers;
		}
		if (Array.isArray(normalized.routing.problems) && Array.isArray(next.routing.problems)) {
			normalized.routing.problems.splice(0, normalized.routing.problems.length, ...next.routing.problems);
		}

		// 删除：从可派单表注销 + 清会话注册表 + 回传 health。
		for (const id of removed) {
			delegation?.removeWorker?.(id);
			if (sessionStore !== null && typeof sessionStore.removeWorker === "function") {
				try { sessionStore.removeWorker(id); } catch { /* 状态同步失败不影响主流程 */ }
			}
			if (typeof onWorkerRemoved === "function") {
				try { onWorkerRemoved(id); } catch { /* 状态同步失败不影响主流程 */ }
			}
		}

		// 新增：建常驻 agent + 注册委托中枢。
		const built = [];
		if (added.length > 0) {
			const scope = typeof getScope === "function" ? getScope() : null;
			if (scope !== null && scope !== undefined) {
				try {
					// V2.2：先用专家定义里的 sessionId 在注册表里确保默认会话，
					// 再按注册表展开多会话 —— 与启动链路（index.js）同一口径。
					for (const worker of added) {
						if (worker.id === "general") continue;
						if (sessionStore !== null && typeof sessionStore.ensureDefault === "function") {
							sessionStore.ensureDefault(worker);
						}
					}
					const results = await ensureWorkerAgents(ctx, scope, next, added, null, skillCatalog, (worker) => {
						if (worker.id === "general" || sessionStore === null) return [];
						const view = sessionStore.listFor(worker.id);
						return view.sessions.map((s) => ({
							sessionId: s.sessionId,
							label: s.label,
							active: s.sessionId === view.activeSessionId,
						}));
					});
					for (const row of results) {
						built.push(row);
						if (row.agent !== undefined && row.agent !== null) {
							delegation?.addWorker?.({
								id: row.id,
								label: labelOf(row.id, nextWorkers),
								sessionId: row.sessionId ?? "",
								active: row.active !== false,
								agent: row.agent,
							});
						}
						if (typeof onWorkerBuilt === "function") {
							try { onWorkerBuilt(row); } catch { /* 同上 */ }
						}
					}
				} catch (error) {
					log("warn", `voice-assistant: 新增专家 agent 建立失败（清单已更新，重启后重试）—— ${String(error?.message ?? error)}`);
				}
			} else {
				log("warn", "voice-assistant: agentLoop scope 未就绪，新增专家只更新了清单，重启后可派单");
			}
		}

		// 有变化才打日志：watcher 的"自写回声"会再跑一次幂等重扫，
		// 空转不能刷启动日志。
		if (added.length > 0 || removed.length > 0) {
			log("info",
				`voice-assistant: 专家清单已更新（+${added.length} / -${removed.length}，现 ${nextWorkers.length} 位）`,
			);
		}
		// V2.4：定义变更必须留可见结论 —— 改 persona/skills 不会重建已建的
		// agent，静默吞掉会让用户以为"改了没用是 bug"。如实告警并说明怎么办。
		if (changed.length > 0) {
			log("info",
				`voice-assistant: 检测到专家定义变更（${changed.map((c) => `${c.id}:${c.fields.join("+")}`).join(", ")}）`
				+ " —— 已建的 agent 不会重建（其 persona/技能在 setup 时固定），需重启 DSH 才对新会话生效；花名册与 health 已更新",
			);
		}
		return {
			ok: true,
			added: added.map((w) => w.id),
			removed,
			changed,
			workers: nextWorkers.map((w) => ({ id: w.id, label: w.label })),
			pendingAgents: added.length - built.length,
		};
	}

	/** 当前完整状态（HTTP GET 用）。 */
	function list() {
		const disk = registry.list();
		const running = (normalized.routing.workers ?? []).map((w) => ({
			id: w.id,
			label: w.label,
			sessionId: w.sessionId,
			description: w.description,
			skills: Array.isArray(w.skills) ? w.skills : [],
		}));
		return {
			dir: disk.dir,
			workers: running,
			custom: disk.experts,
			tombstones: disk.tombstones,
			problems: disk.problems,
		};
	}

	/** 新增一位专家（写文件 + 热生效）。 */
	async function add(raw) {
		const result = registry.add(raw);
		if (!result.ok) return result;
		const applied = await applyChanges();
		return {
			ok: true,
			expert: result.expert,
			applied,
			speech: `已添加专家${result.expert.label}。` +
				(applied.pendingAgents > 0 ? "它会在下次重启后开始接任务。" : "现在就可以给它派任务了。"),
		};
	}

	/** 删除一位专家（V2.2：直接删 JSON 文件 + 热生效）。 */
	async function remove(id) {
		const result = registry.remove(id);
		if (!result.ok) return result;
		const applied = await applyChanges();
		return {
			ok: true,
			id: result.id,
			mode: result.mode,
			applied,
			speech: `已移除专家${result.id}。`,
		};
	}

	// ── V2.2：目录 watcher —— 手工增删/修改 JSON 也实时同步运行时 ──────────
	// 需求①「以目录 JSON 为准」+ 需求④「每次改动实时更新 agent 状态」。
	// API/语音改动由 add/remove 自己调 applyChanges；手工改文件（丢进来/删掉/
	// 改内容）靠这里的 fs.watch 兜住。两条路径都汇到同一个 applyChanges()。
	//
	// **不做"自写回声"抑制**：add/remove 写盘后 watcher 也会收到事件并再跑一
	// 次 applyChanges，但它是幂等的（花名册无变化时 added/removed 均空、
	// 不会重复触发 delegation/回调），代价只是一次几毫秒的目录重扫。曾用
	// 1.5s 自写时间窗抑制回声，结果把"API 新增后用户立刻手工删文件"的合法
	// 事件也吞掉了 —— 幂等重扫比带盲区的抑制更稳。
	let watcher = null;
	let debounceTimer = null;
	const WATCH_DEBOUNCE_MS = 250;

	/** 启动目录监听（幂等）；返回一个 stop 函数。 */
	function startWatching() {
		if (watcher !== null || dir === "" || dir === undefined) return () => {};
		try {
			watcher = watch(dir, { persistent: false }, (eventType, filename) => {
				// 只关心 .json（忽略 _state/ 下的会话文件与 .tmp- 临时文件）。
				const name = typeof filename === "string" ? filename : "";
				if (name !== "" && (!name.toLowerCase().endsWith(".json") || name.includes(".tmp-") || name.startsWith("_state"))) {
					return;
				}
				if (debounceTimer !== null) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(() => {
					debounceTimer = null;
					log("info", `voice-assistant: 检测到专家目录变更（${eventType} ${name || "?"}），重扫并同步运行时`);
					applyChanges().catch((error) => {
						log("warn", `voice-assistant: 目录变更重扫失败 —— ${String(error?.message ?? error)}`);
					});
				}, WATCH_DEBOUNCE_MS);
			});
			watcher.on?.("error", (error) => {
				log("warn", `voice-assistant: 专家目录监听出错（停止监听，重启后恢复）—— ${String(error?.message ?? error)}`);
				stopWatching();
			});
			log("info", `voice-assistant: 已监听专家目录 ${dir}（手工增删 JSON 实时生效）`);
		} catch (error) {
			log("warn", `voice-assistant: 无法监听专家目录（手工改 JSON 需重启生效）—— ${String(error?.message ?? error)}`);
			watcher = null;
		}
		return () => stopWatching();
	}

	/** 停止目录监听（幂等）。 */
	function stopWatching() {
		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		if (watcher !== null) {
			try { watcher.close(); } catch { /* 关闭失败不影响主流程 */ }
			watcher = null;
		}
	}

	return { dir: registry.dir, registry, list, add, remove, applyChanges, startWatching, stopWatching };
}

/** 取展示名（内部小工具）。 */
function labelOf(id, workers) {
	return workers.find((w) => w.id === id)?.label ?? id;
}
