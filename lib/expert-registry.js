/**
 * 专家注册表（V1.7；V2.2 起是唯一真相源）：增删专家的持久化落点。
 *
 * ## 存储模型
 *
 * 目录 `~/.dsh/voice-assistant/experts/*.json` 是专家定义的**唯一真相源**，
 * 与配置扫描（`mergeWorkerSources`，见 workers.js）读的是同一份文件：
 *   - 新增专家 → 原子写 `<dir>/<id>.json`（标准专家定义）；
 *   - 删除专家 → 直接删掉那个文件（干净、无残留）；
 *   - 删一个目录里不存在的 id（或已是墓碑）→ 写 `{"id":..,"disabled":true}`
 *     墓碑，保证「删除」动作幂等且一定落盘。
 *
 * V2.2 起代码里不再内置任何领域专家（只有 general 系统锚点），所以墓碑分支
 * 只用于幂等删除；`mergeWorkerSources` 仍认识它并从最终清单剔除。管理接口
 * 只是替用户做原子写入与校验，没有引入第二套真相来源 —— 手工丢 JSON 与
 * API 增删最终落的是同一份文件。
 *
 * ## 安全约束
 *
 * - id 只允许 `[a-z0-9][a-z0-9_-]*`，杜绝 `..` / 路径分隔符 / 盘符；
 * - 文件名固定 `<id>.json`，不接受调用方传路径；
 * - 写入走"临时文件 + rename"原子替换，中途崩溃不会留下半个文件；
 * - general 不可删（路由兜底锚点）。
 */
import { readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";

/** id 合法判据（纯函数，可单测）。 */
export const EXPERT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 保留 id：general 是路由兜底，不能增删覆盖。 */
export const RESERVED_IDS = Object.freeze(["general"]);

/**
 * 校验并归一化一段专家定义（纯函数，可单测）。
 *
 * @param raw - 调用方给的原始对象。
 * @returns `{ ok:true, expert }` 或 `{ ok:false, error }`。
 */
export function normalizeExpertInput(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, error: "expert-must-be-object" };
	}
	const id = typeof raw.id === "string" ? raw.id.trim().toLowerCase() : "";
	if (!EXPERT_ID_RE.test(id)) return { ok: false, error: "invalid-id" };
	if (RESERVED_IDS.includes(id)) return { ok: false, error: "reserved-id" };
	const label = typeof raw.label === "string" ? raw.label.trim().slice(0, 40) : "";
	if (label === "") return { ok: false, error: "label-required" };
	const description = typeof raw.description === "string" ? raw.description.trim().slice(0, 400) : "";
	if (description === "") return { ok: false, error: "description-required" };
	const persona = typeof raw.persona === "string" ? raw.persona.trim().slice(0, 4000) : "";
	const skills = Array.isArray(raw.skills) ? raw.skills.filter((s) => typeof s === "string" && s.trim() !== "").map((s) => s.trim()) : [];
	return {
		ok: true,
		expert: { id, label, description, persona, skills },
	};
}

/**
 * 创建注册表管理器（绑定一个目录）。
 *
 * @param dir - 专家目录绝对路径（通常取 `config.routing.expertDirs[0]`）。
 * @returns `{ dir, list, add, remove, pathFor }`。
 */
export function createExpertRegistry(dir) {
	const root = typeof dir === "string" && dir.trim() !== "" ? resolve(dir.trim()) : "";

	/** 某 id 对应的文件名（固定规则，不接受外部路径）。 */
	function pathFor(id) {
		if (root === "" || !EXPERT_ID_RE.test(String(id))) return null;
		return join(root, `${id}.json`);
	}

	/** 确保目录存在（首次增删时按需创建）。 */
	function ensureDir() {
		if (root === "") throw new Error("no-expert-dir");
		if (!existsSync(root)) mkdirSync(root, { recursive: true });
	}

	/** 原子写 JSON：临时文件 + rename，中途失败不留残片。 */
	function writeAtomic(file, value) {
		const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
		try {
			renameSync(tmp, file);
		} catch (error) {
			try { unlinkSync(tmp); } catch { /* 清理失败不影响主错误 */ }
			throw error;
		}
	}

	/** 读取目录里所有 *.json 的原始定义（坏文件记入 problems，不抛）。 */
	function readAll() {
		const entries = [];
		const problems = [];
		if (root === "" || !existsSync(root)) return { entries, problems };
		let names = [];
		try {
			names = readdirSync(root, { withFileTypes: true })
				.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json") && !e.name.includes(".tmp-"))
				.map((e) => e.name)
				.sort();
		} catch (error) {
			problems.push(`${root}: 读取失败（${String(error?.message ?? error)}）`);
			return { entries, problems };
		}
		for (const name of names) {
			try {
				const parsed = JSON.parse(readFileSync(join(root, name), "utf8"));
				entries.push({ file: name, ...(parsed ?? {}) });
			} catch (error) {
				problems.push(`${name}: JSON 解析失败（${String(error?.message ?? error)}）`);
			}
		}
		return { entries, problems };
	}

	/**
	 * 列出注册表里的专家（含墓碑）。
	 * @returns `{ dir, experts:[...], tombstones:[...], problems:[...] }`。
	 */
	function list() {
		const { entries, problems } = readAll();
		const experts = [];
		const tombstones = [];
		for (const entry of entries) {
			if (entry.disabled === true) {
				tombstones.push(entry.id ?? basename(entry.file, ".json"));
			} else {
				experts.push({
					id: entry.id ?? basename(entry.file, ".json"),
					label: entry.label ?? "",
					description: entry.description ?? "",
					persona: entry.persona ?? "",
					skills: Array.isArray(entry.skills) ? entry.skills : [],
					file: entry.file,
				});
			}
		}
		return { dir: root, experts, tombstones, problems };
	}

	/**
	 * 新增/覆盖一位专家。
	 * @param raw - 专家定义。
	 * @returns `{ ok, expert?, error? }`。
	 */
	function add(raw) {
		const validated = normalizeExpertInput(raw);
		if (!validated.ok) return validated;
		const file = pathFor(validated.expert.id);
		if (file === null) return { ok: false, error: "invalid-id" };
		try {
			ensureDir();
			writeAtomic(file, validated.expert);
			return { ok: true, expert: validated.expert, file };
		} catch (error) {
			return { ok: false, error: `write-failed: ${String(error?.message ?? error)}` };
		}
	}

	/**
	 * 删除一位专家（V2.2：直接删文件）。
	 *
	 * - 目录里有该 id 的定义文件（非墓碑）→ 直接删文件；
	 * - 否则（id 不存在 / 已是墓碑）→ 写 `disabled:true` 墓碑，保证删除幂等落盘。
	 *
	 * @param id - 专家 id。
	 * @returns `{ ok, id, mode:"file"|"tombstone", error? }`。
	 */
	function remove(id) {
		const clean = typeof id === "string" ? id.trim().toLowerCase() : "";
		if (!EXPERT_ID_RE.test(clean)) return { ok: false, error: "invalid-id" };
		if (RESERVED_IDS.includes(clean)) return { ok: false, error: "reserved-id" };
		const file = pathFor(clean);
		if (file === null) return { ok: false, error: "invalid-id" };
		try {
			ensureDir();
			// 若目录里有真的定义文件（非墓碑），删掉它即可 —— 干净、无残留。
			if (existsSync(file)) {
				let parsed = null;
				try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { /* 坏文件当普通文件删 */ }
				if (parsed?.disabled !== true) {
					unlinkSync(file);
					return { ok: true, id: clean, mode: "file" };
				}
			}
			// 内置专家 / 只有墓碑 → 写墓碑，压过默认清单。
			writeAtomic(file, { id: clean, disabled: true });
			return { ok: true, id: clean, mode: "tombstone" };
		} catch (error) {
			return { ok: false, id: clean, error: `remove-failed: ${String(error?.message ?? error)}` };
		}
	}

	return { dir: root, list, add, remove, pathFor };
}
