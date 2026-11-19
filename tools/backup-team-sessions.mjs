/**
 * 把"DSH 原生智能体团队"会话整体移出 sessions/ 到备份目录（V1.8 需求②）。
 *
 * ## 为什么是"移出"而不是"删除/改名"
 *
 * DSH 的 session-persistence 扫描 `~/.dsh/sessions/<组>/<目录名>/` 时会做
 * `assertStoredIdentity`：目录名必须等于日志首帧 header.id。历史事故（坑十六）
 * 是**在 sessions/ 内给会话目录改名** → 目录名与 header.id 错配 → workspace
 * 插件激活失败 → 侧栏所有会话消失。所以这里：
 *   - **不删除**任何文件；
 *   - **不改名**会话目录（内部 header.id 保持原样）；
 *   - 只把整个目录 `rename` 到 sessions/ **之外**的备份路径 —— 扫描器再也
 *     看不到它，不会触发身份校验；数据完整保留，随时可移回回滚。
 *
 * ## 本脚本处理哪 4 个目录
 *
 * 常驻助手 root 会话里残留的 DSH 原生智能体团队（team/task + subagent/catalog）：
 *   - `session-voice-assistant-root`（含 team 事件的历史 root）
 *   - 3 个 spawn 子智能体会話（UUID 命名，来自 subagent/catalog.childId）
 *
 * 新 root 用**新 session id**（`session-voice-assistant-root-v2`）在下次 DSH
 * 启动时全新创建，不带任何 team 事件 —— 插件专家系统与 DSH 团队彻底分开。
 *
 * ## 用法
 *
 *   node tools/backup-team-sessions.mjs            # dry-run（默认，只打印计划）
 *   node tools/backup-team-sessions.mjs --apply    # 真正执行移出
 *   node tools/backup-team-sessions.mjs --restore  # 从备份移回（回滚）
 */
import { existsSync, readdirSync, renameSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const SESSIONS = resolve(process.env.DSH_HOME ? join(process.env.DSH_HOME, "sessions") : join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "sessions"));
const BACKUP = resolve("tools/_session_backup/2026-11-19-team-cleanup");
/** 待移出的目录名（root + 3 个 subagent UUID）。 */
const TARGET_NAMES = [
	"session-voice-assistant-root",
	"28eca705-4e0c-490a-828e-c2f83a2392c5", // protein-designer
	"5d997f08-7aee-4978-98c0-1f44323a9a9f", // transcriptome-expert
	"b0c89a1b-fc23-4888-8473-3d6f1769ee0e", // pathologist
];
const APPLY = process.argv.includes("--apply");
const RESTORE = process.argv.includes("--restore");

/** 多帧 zstd 解压（与 research/session-log-reader 同口径，避免整文件只解一帧）。 */
function readLog(file) {
	const buf = readFileSync(file);
	const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
	const starts = [];
	let at = buf.indexOf(magic, 0);
	while (at !== -1) { starts.push(at); at = buf.indexOf(magic, at + 4); }
	if (starts.length === 0) return buf.toString("utf8");
	const parts = starts.map((from, i) => {
		const to = i + 1 < starts.length ? starts[i + 1] : buf.length;
		try { return zstdDecompressSync(buf.subarray(from, to), { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8"); }
		catch { return ""; }
	});
	return parts.join("");
}

/** 找目录所在的会话组（这些 id 属于哪个 cwd 组）。 */
function findGroup(name) {
	let groups = [];
	try { groups = readdirSync(SESSIONS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(SESSIONS, e.name)); }
	catch { return null; }
	for (const g of groups) if (existsSync(join(g, name))) return g;
	return null;
}

/** 校验目录名 === 日志首帧 header.id（纪律：不一致就拒绝操作）。 */
function assertIdentity(dir, name) {
	const log = join(dir, "session.v4.jsonl.zstd");
	if (!existsSync(log)) return { ok: false, reason: "no-log" };
	const first = readLog(log).split(/\r?\n/).find((l) => l.trim());
	if (!first) return { ok: false, reason: "empty-log" };
	let ev;
	try { ev = JSON.parse(first); } catch { return { ok: false, reason: "bad-json" }; }
	const header = ev?.header ?? ev?.data?.header ?? ev;
	if (header?.id !== name) return { ok: false, reason: `header.id=${header?.id} != dir=${name}` };
	return { ok: true };
}

/** 全量前置校验：任何一项不满足就直接退出，不做任何改动。 */
function preflight() {
	const plan = [];
	for (const name of TARGET_NAMES) {
		const group = findGroup(name);
		const src = group ? join(group, name) : null;
		const dst = join(BACKUP, name);
		if (RESTORE) {
			plan.push({ name, src: dst, dst: group ? join(group, name) : null, mode: "restore", group });
			continue;
		}
		if (!src) { plan.push({ name, src: null, dst, mode: "skip-missing" }); continue; }
		const check = assertIdentity(src, name);
		plan.push({ name, src, dst, mode: check.ok ? "move" : "REJECT", identity: check, group });
	}
	return plan;
}

function main() {
	const plan = preflight();
	const bad = plan.filter((p) => p.mode === "REJECT");
	if (bad.length > 0) {
		console.error("!! 身份校验失败，拒绝操作（回滚/继续执行都不安全）：");
		for (const p of bad) console.error(`   ${p.name}: ${JSON.stringify(p.identity)}`);
		process.exit(1);
	}
	console.log(RESTORE ? "[RESTORE] 从备份移回会话" : APPLY ? "[APPLY] 执行移出" : "[DRY-RUN] 仅打印计划（加 --apply 才会执行）");
	console.log(`SESSIONS = ${SESSIONS}`);
	console.log(`BACKUP   = ${BACKUP}`);
	for (const p of plan) {
		console.log(`  ${p.mode.padEnd(12)} ${p.name}`);
		if (p.src && p.dst) console.log(`              ${p.src}\n           → ${p.dst}`);
	}
	if (!APPLY && !RESTORE) {
		console.log("\n（dry-run 结束，未改动任何文件）");
		return;
	}
	if (RESTORE) mkdirSync(SESSIONS, { recursive: true });
	else mkdirSync(BACKUP, { recursive: true });
	let moved = 0;
	for (const p of plan) {
		if (!p.src || !p.dst) continue;
		if (p.mode === "restore") {
			if (!existsSync(p.src)) { console.log(`  SKIP 备份不存在：${p.name}`); continue; }
			if (!p.group) { console.log(`  SKIP 找不到原会话组：${p.name}`); continue; }
		} else {
			if (!existsSync(p.src)) { console.log(`  SKIP 源不存在：${p.name}`); continue; }
		}
		if (existsSync(p.dst)) { console.log(`  SKIP 目标已存在：${p.dst}`); continue; }
		renameSync(p.src, p.dst); // 整体移出/移回，不改名、不删除内部文件。
		moved += 1;
		console.log(`  MOVED ${p.name}`);
	}
	console.log(`\n完成：移动 ${moved} 个目录。${RESTORE ? "" : "新 root 会话将在下次 DSH 启动时以新 id 创建。"}`);
}

main();
