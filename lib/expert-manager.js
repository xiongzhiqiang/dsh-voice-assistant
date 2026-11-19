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

/**
 * 从归一化配置里取专家目录（纯函数，可单测）。
 *
 * 优先用用户配的 `routing.expertDirs[0]`（与目录扫描同源），没配则回退到
 * `~/.dsh/voice-assistant/experts`（DSH_HOME 可覆盖）—— 保证管理接口永远
 * 有一个可写落点，不必要求用户先改 YAML。
 *
 * @param config - 归一化配置。
 * @returns 目录绝对路径。
 */
export function expertDirFromConfig(config) {
	const dirs = config?.routing?.expertDirs;
	if (Array.isArray(dirs) && dirs.length > 0 && typeof dirs[0] === "string" && dirs[0].trim() !== "") {
		return dirs[0].trim();
	}
	const root = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(root, "voice-assistant", "experts");
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
 * @param options.logger - 可选日志器。
 * @returns `{ dir, registry, list, add, remove }`。
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
			return { ok: false, added: [], removed: [], error: `renormalize-failed: ${String(error?.message ?? error)}` };
		}

		const oldIds = new Set((normalized.routing.workers ?? []).map((w) => w.id));
		const nextWorkers = next.routing.workers ?? [];
		const newIds = new Set(nextWorkers.map((w) => w.id));
		const added = nextWorkers.filter((w) => !oldIds.has(w.id));
		const removed = [...oldIds].filter((id) => !newIds.has(id));

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

		// 删除：从可派单表注销 + 回传 health。
		for (const id of removed) {
			delegation?.removeWorker?.(id);
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
					const results = await ensureWorkerAgents(ctx, scope, next, added, null, skillCatalog);
					for (const row of results) {
						built.push(row);
						if (row.agent !== undefined && row.agent !== null) {
							delegation?.addWorker?.({ id: row.id, label: labelOf(row.id, nextWorkers), agent: row.agent });
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

		log("info",
			`voice-assistant: 专家清单已更新（+${added.length} / -${removed.length}，现 ${nextWorkers.length} 位）`,
		);
		return {
			ok: true,
			added: added.map((w) => w.id),
			removed,
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

	/** 删除一位专家（写墓碑/删文件 + 热生效）。 */
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

	return { dir: registry.dir, registry, list, add, remove, applyChanges };
}

/** 取展示名（内部小工具）。 */
function labelOf(id, workers) {
	return workers.find((w) => w.id === id)?.label ?? id;
}
