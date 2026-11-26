/**
 * V2.2 专家系统单一数据源：增删落盘 + 运行时实时同步 + 目录 watcher。
 *
 * 对应需求：
 *   ③ 添加/删除专家最终都要更新 ~/.dsh/voice-assistant/experts/ 下的 JSON；
 *   ④ 每次改动专家列表，实时更新 agent 运行时状态（花名册 / 委托中枢 /
 *      会话注册表 / health 回调），无需重启。
 *
 * 这里只测宿主半纯逻辑（不依赖 DSH 运行时）：getScope 返回 null 走降级
 * 分支（只更清单不建 agent），正好能独立验证"状态同步"这一层。
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeConfig } from "../lib/config.js";
import { createExpertManager, defaultExpertDir, expertDirFromConfig } from "../lib/expert-manager.js";

const failures = [];
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures.push({ name, actual, expected });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` → ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`}`);
};
const tempDir = (prefix) => mkdtempSync(join(tmpdir(), prefix));
const EXPERT = (id, label) => ({ id, label, description: `${label}的分析任务`, persona: `你是${label}。` });

// ── 默认目录与管理接口同源（漏配 YAML 也不会出现"写了却读不到"）───────────
check("defaultExpertDir 与 expertDirFromConfig 回退一致", defaultExpertDir(), expertDirFromConfig({}));
check("默认目录以 voice-assistant/experts 结尾", defaultExpertDir().endsWith(join("voice-assistant", "experts")), true);

// ── 增删落盘 + applyChanges 实时同步运行时 ─────────────────────────────
{
	const dir = tempDir("xfv-sync-");
	const originalConfig = { routing: { expertDirs: [dir] } };
	const normalized = normalizeConfig(originalConfig);
	const workersRef = normalized.routing.workers;
	const calls = { addWorker: [], removeWorker: [], sessionRemoved: [], sessionDefault: [], built: [], removed: [] };
	const delegation = {
		addWorker: (w) => calls.addWorker.push(w.id),
		removeWorker: (id) => calls.removeWorker.push(id),
	};
	const sessionStore = {
		removeWorker: (id) => calls.sessionRemoved.push(id),
		ensureDefault: (w) => calls.sessionDefault.push(w.id),
		listFor: () => ({ sessions: [], activeSessionId: "" }),
	};
	const manager = createExpertManager({
		originalConfig,
		normalized,
		delegation,
		skillCatalog: null,
		getScope: () => null, // 降级：不建常驻 agent，只验证状态同步
		ctx: {},
		dir,
		onWorkerBuilt: (row) => calls.built.push(row.id),
		onWorkerRemoved: (id) => calls.removed.push(id),
		sessionStore,
		logger: null,
	});

	check("初始只有 general 锚点", normalized.routing.workers.map((w) => w.id), ["general"]);
	check("registry 目录就是传入目录", manager.dir, dir);

	// ③ 添加专家 → 必须落盘到目录 JSON。
	const added = await manager.add(EXPERT("chem", "小化 · 化学"));
	check("添加成功", added.ok, true);
	check("添加落盘 chem.json", existsSync(join(dir, "chem.json")), true);
	check("落盘内容即专家定义", JSON.parse(readFileSync(join(dir, "chem.json"), "utf8")).label, "小化 · 化学");
	// ④ 花名册实时更新，且原地 splice（routes.js / clientConfig 持同一引用）。
	check("运行时花名册实时含新专家", normalized.routing.workers.map((w) => w.id), ["general", "chem"]);
	check("原地更新（引用不换，客户端自动可见）", normalized.routing.workers === workersRef, true);
	check("applyChanges 报 added", added.applied.added, ["chem"]);

	// ④ 手工往目录丢 JSON（watcher 回调走的就是 applyChanges）→ 同样实时同步。
	writeFileSync(join(dir, "phys.json"), JSON.stringify(EXPERT("phys", "小物 · 物理")), "utf8");
	const manual = await manager.applyChanges();
	check("手工新增 JSON 同步进花名册", normalized.routing.workers.map((w) => w.id), ["general", "chem", "phys"]);
	check("手工新增报 added=phys", manual.added, ["phys"]);
	check("手工新增不误报 removed", manual.removed, []);
	check("纯新增不报 changed", manual.changed, []);

	// ── V2.4：同 id 改定义必须被检出（不能静默不生效）─────────────────────
	//
	// 真机踩到的场景：把 genetic 的技能名写错，health 的 skills.missing 一直
	// 挂着旧值、日志一声不响，用户以为"改了没用是 bug"。
	// 已建 agent 的 persona/技能在 setup 时就固定了，改定义**不会**重建它 ——
	// 所以至少要把变更**检出来 + 告警**，而不是当没变化。
	{
		const changedExpert = { ...EXPERT("phys", "小物 · 物理"), skills: ["physics-lab"], description: "改了描述" };
		writeFileSync(join(dir, "phys.json"), JSON.stringify(changedExpert), "utf8");
		const diff = await manager.applyChanges();
		check("定义变更被检出", diff.changed.map((c) => c.id), ["phys"]);
		check("变更字段含 skills", diff.changed[0].fields.includes("skills"), true);
		check("变更字段含 description", diff.changed[0].fields.includes("description"), true);
		check("改定义不算增删", [diff.added.length, diff.removed.length], [0, 0]);
		// 花名册要跟着更新（routes 的 prompt roster 用的是这份），否则路由
		// 描述与实际定义漂移。
		check(
			"花名册里的技能声明已更新",
			(normalized.routing.workers.find((w) => w.id === "phys")?.skills ?? []),
			["physics-lab"],
		);
		// 原样再存一次 → 无变更、不误报（幂等重扫不能刷日志）。
		const idle = await manager.applyChanges();
		check("同内容重扫不报 changed（幂等）", idle.changed, []);
	}

	// ③ 删除专家 → 必须删掉目录 JSON。
	const removed = await manager.remove("chem");
	check("删除成功", removed.ok, true);
	check("删除落盘为删文件", removed.mode, "file");
	check("chem.json 已删", existsSync(join(dir, "chem.json")), false);
	// ④ 运行时四处状态同步：花名册 / 委托中枢 / 会话注册表 / health 回调。
	check("运行时花名册移除 chem", normalized.routing.workers.map((w) => w.id), ["general", "phys"]);
	check("委托中枢注销该专家", calls.removeWorker, ["chem"]);
	check("会话注册表清掉该专家", calls.sessionRemoved, ["chem"]);
	check("health 回调收到移除通知", calls.removed, ["chem"]);
	check("applyChanges 报 removed", removed.applied.removed, ["chem"]);

	// 幂等：删一个不存在的 id 不会破坏当前花名册。
	const again = await manager.remove("chem");
	check("重复删除不抛错", again.ok, true);
	check("重复删除不改花名册", normalized.routing.workers.map((w) => w.id), ["general", "phys"]);

	// watcher 生命周期：启动/停止幂等、不抛异常。
	const stop = manager.startWatching();
	check("startWatching 返回 stop 函数", typeof stop, "function");
	manager.startWatching();
	manager.stopWatching();
	manager.stopWatching();
	check("watcher 启停幂等", true, true);
}

// ── 目录 watcher：手工改 JSON 也会自动同步（防抖 250ms）──────────────────
{
	const dir = tempDir("xfv-watch-");
	const originalConfig = { routing: { expertDirs: [dir] } };
	const normalized = normalizeConfig(originalConfig);
	const manager = createExpertManager({
		originalConfig,
		normalized,
		delegation: { addWorker() {}, removeWorker() {} },
		skillCatalog: null,
		getScope: () => null,
		ctx: {},
		dir,
		sessionStore: null,
		logger: null,
	});
	const stop = manager.startWatching();
	writeFileSync(join(dir, "bio.json"), JSON.stringify(EXPERT("bio", "小生 · 生物")), "utf8");
	let synced = false;
	for (let i = 0; i < 25; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (normalized.routing.workers.some((w) => w.id === "bio")) {
			synced = true;
			break;
		}
	}
	check("watcher 自动检测到手工新增 JSON", synced, true);
	check("watcher 同步后花名册正确", normalized.routing.workers.map((w) => w.id), ["general", "bio"]);
	// 手工删文件也要同步。
	writeFileSync(join(dir, "bio.json"), JSON.stringify(EXPERT("bio", "小生 · 生物")), "utf8");
	const { unlinkSync } = await import("node:fs");
	unlinkSync(join(dir, "bio.json"));
	let removedByWatch = false;
	for (let i = 0; i < 25; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (!normalized.routing.workers.some((w) => w.id === "bio")) {
			removedByWatch = true;
			break;
		}
	}
	check("watcher 自动检测到手工删 JSON", removedByWatch, true);
	stop();
}

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	for (const f of failures) console.error(`  - ${f.name}: ${JSON.stringify(f.actual)} != ${JSON.stringify(f.expected)}`);
	process.exit(1);
}
console.log("\nV2.2 专家单一数据源 / 实时同步全部通过");
