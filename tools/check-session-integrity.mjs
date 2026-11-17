/**
 * 会话存储完整性自检：找出会让 DSH 启动失败的「错配会话目录」。
 *
 * ## 为什么需要它（真实事故）
 *
 * DSH 的 `session-persistence-jsonl` 在扫描 `<DSH_HOME>/sessions/<cwd组>/<目录名>/`
 * 时会做 `assertStoredIdentity`：**目录名必须与日志第一帧 header 里的 `id` 字段一致**
 * （cwd 也必须与该组的路径一致）。一旦不一致，抛：
 *
 *   corrupt session log "...\session.v4.jsonl.zstd":
 *     header id "X" and cwd identify "...\Y\session.v4.jsonl.zstd"
 *
 * 后果不是「跳过这一个会话」，而是 **workspace 插件激活失败** →
 * `workspaceRegistry` 服务不存在 → 侧栏**所有会话消失、新建会话也建不出来**。
 * 界面看起来像「数据被删了」，其实数据都在，只是扫描器被一颗坏文件噎住。
 *
 * 事故来源：排障时把损坏会话**就地改名**（`xxx` → `xxx.broken-20261117`），
 * 但 zstd 里的 header.id 仍是旧名 —— 目录名变了、header 没变，于是错配。
 * **正确做法**是把坏会话整体**移出 `sessions/` 目录**（比如挪到项目 tools 下备份），
 * 而不是在 `sessions/` 里改名。
 *
 * ## 用法
 *
 *   node tools/check-session-integrity.mjs            # 扫描全部会话组
 *   node tools/check-session-integrity.mjs --fix-hint # 额外打印修复建议
 *
 * 退出码：0 = 全一致；1 = 发现错配（需要处理）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const ROOT = join(HOME, "sessions");
const showHint = process.argv.includes("--fix-hint");

/**
 * 列目录（失败返回空数组）。
 * @param path - 目录路径。
 */
function safeList(path) {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

/**
 * 解压日志第一帧并解析 header。
 * @param file - `session.v4.jsonl.zstd` 路径。
 * @returns header 对象，或 `null`。
 */
function readHeader(file) {
	let raw;
	try {
		if (!statSync(file).isFile()) return null;
		raw = readFileSync(file);
	} catch {
		return null;
	}
	try {
		const text = zstdDecompressSync(raw).toString("utf8");
		const line = text.split("\n").find((item) => item.trim() !== "");
		if (line === undefined) return null;
		return JSON.parse(line);
	} catch {
		return null;
	}
}

const problems = [];
let total = 0;
const groups = safeList(ROOT);

for (const group of groups) {
	const groupPath = join(ROOT, group);
	let isDir = false;
	try {
		isDir = statSync(groupPath).isDirectory();
	} catch {
		isDir = false;
	}
	if (!isDir) continue;

	for (const session of safeList(groupPath)) {
		const dir = join(groupPath, session);
		let dirOk = false;
		try {
			dirOk = statSync(dir).isDirectory();
		} catch {
			dirOk = false;
		}
		if (!dirOk) continue;

		const file = join(dir, "session.v4.jsonl.zstd");
		const header = readHeader(file);
		total += 1;

		if (header === null) {
			problems.push({ group, session, kind: "读不到 header（日志缺失或损坏）", detail: file });
			continue;
		}
		if (header.id !== session) {
			problems.push({
				group,
				session,
				kind: "目录名与 header.id 不一致",
				detail: `header id "${header.id}"`,
			});
		}
		// 注：cwd 一致性**不在这里查**。会话组目录名是路径的「有损编码」
		//（盘符/分隔符都塌成 `-`），从组名反推 cwd 必然误报，实测会把 41 个
		// 正常会话全标红、把真问题淹掉。DSH 自己的报错也以 id 为主判据，
		// 这里只保留能确证的那一条。
	}
}

console.log(`扫描 ${HOME}\\sessions，共 ${groups.length} 个会话组、${total} 个会话目录。`);
if (problems.length === 0) {
	console.log("完整性自检通过：所有会话目录名与 header.id 一致。");
	process.exit(0);
}

console.log(`\n发现 ${problems.length} 处问题（这些会让 DSH 的 workspace 插件启动失败）：`);
for (const row of problems) {
	console.log(`  [${row.kind}] ${row.group}\\${row.session}`);
	console.log(`      ${row.detail}`);
}

if (showHint) {
	console.log("\n修复建议：");
	console.log("  1) 停掉 DSH 实例；");
	console.log("  2) 把上面列出的整个会话目录**移出** `sessions/`（挪到项目 tools 下备份），");
	console.log("     **不要**在原位改名 —— 改名会让目录名与 header.id 错配，正是本事故成因；");
	console.log("  3) 顺手清 `storages/session_projcache/sessions/` 里同名投影缓存；");
	console.log("  4) 重启 DSH，确认侧栏会话列表与新建会话都恢复。");
}

process.exit(1);
