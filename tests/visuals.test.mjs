/** V1.6 卡通形象：素材白名单、工作态投影、拖拽几何的纯函数自检。 */
import { avatarName, avatarFileFromPath, avatarUrl } from "../lib/avatars.js";
import { projectActivities } from "../lib/activities.js";
import { API_PREFIX as HOST_PREFIX } from "../lib/api-prefix.js";
import { API_PREFIX as CLIENT_PREFIX } from "../src/client/core/constants.js";
import { clampPosition, positionFromPointer, isDragGesture, positionStyle } from "../src/client/ui/drag.js";
import {
	EXPERT_SIZE,
	DEFAULT_LAYOUT,
	defaultExpertPosition,
	isExpertVisible,
	visibleExperts,
	toggleMinimized,
} from "../src/client/ui/expert-visual.js";
import { clientConfig, normalizeConfig } from "../lib/config.js";
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const failures = [];
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures.push({ name, actual, expected });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` → ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`}`);
};

// ── 素材白名单与路径净化 ──────────────────────────────────────────────
check("已知专家 id 原样返回", avatarName("bioinfo"), "bioinfo");
check("未知 id 回落到 general", avatarName("chem"), "general");
check("空 id 回落到 general", avatarName(""), "general");
check("非字符串 id 回落到 general", avatarName(null), "general");
check("构造原型属性不穿透", avatarName("__proto__"), "general");
check("合法素材路径解析", avatarFileFromPath("/avatars/orb.png"), "orb.png");
check("带 query 的路径被拒（调用方应先剥 query）", avatarFileFromPath("/avatars/orb.png?v=2"), null);
check("目录穿越被拒", avatarFileFromPath("/avatars/../secret.png"), null);
check("非白名单文件被拒", avatarFileFromPath("/avatars/README.png"), null);
check("非 png 被拒", avatarFileFromPath("/avatars/orb.svg"), null);
check("多段路径被拒", avatarFileFromPath("/avatars/x/orb.png"), null);
check("素材 URL 拼法", avatarUrl("/api", "coder"), "/api/avatars/coder.png");
check("未知 id 的 URL 也安全", avatarUrl("/api", "../secret"), "/api/avatars/general.png");

// 打包清单必须含 assets/ —— 漏了它 junction 安装看不出问题、
// 打包安装后所有图像全消失（V1.4 的 skills/ 就是这个坑）。
check("files 清单含 assets/", pkg.files.includes("assets/"), true);
check("版本号与 lib/version.js 一致", pkg.version, "2.4.0");

// 六张素材必须都真实存在且带 alpha（抠过图），否则运行期会出白底方块。
const ASSET_DIR = join(process.cwd(), "assets", "characters");
for (const name of ["general", "bioinfo", "coder", "researcher", "operator", "orb"]) {
	const file = join(ASSET_DIR, `${name}.png`);
	const exists = existsSync(file);
	check(`${name}.png 素材存在`, exists, true);
	if (exists) {
		const buf = readFileSync(file);
		// PNG IHDR colorType：6 = RGBA（有透明通道），2 = RGB（白底，未抠图）
		check(`${name}.png 有透明通道`, buf[25] === 6, true);
	}
}

// ── 工作态投影 ────────────────────────────────────────────────────────
const workers = [
	{ id: "general", label: "小凤 · 通用" },
	{ id: "bioinfo", label: "小因 · 基因分析" },
];
check("全员空闲", projectActivities(workers, [], 1000).workers.map((w) => w.busy), [false, false]);
check("空闲计数为 0", projectActivities(workers, [], 1000).activeCount, 0);
const busy = projectActivities(
	workers,
	[{ jobId: "j1", workerId: "bioinfo", task: "分析突变", startedAt: 400 }],
	1000,
);
check("bioinfo 在忙", busy.workers[1].busy, true);
check("general 仍空闲", busy.workers[0].busy, false);
check("活跃数为 1", busy.activeCount, 1);
check("任务文本带上", busy.workers[1].task, "分析突变");
check("已运行时长", busy.workers[1].elapsedMs, 600);
check("时间向下取整不为负", projectActivities(workers, [{ workerId: "bioinfo", startedAt: 5000 }], 1000).workers[1].elapsedMs, 0);
check("超长任务截断到 60 字", projectActivities(workers, [{ workerId: "bioinfo", task: "x".repeat(100) }]).workers[1].task.length, 60);
check("同一 worker 取最新任务",
	projectActivities(workers, [
		{ workerId: "bioinfo", task: "旧", startedAt: 100 },
		{ workerId: "bioinfo", task: "新", startedAt: 200 },
	]).workers[1].task,
	"新",
);
check("未知 worker 的任务不进清单", projectActivities(workers, [{ workerId: "chem", task: "x" }]).activeCount, 0);
check("脏数据不抛错", projectActivities(workers, [null, "x", {}]).activeCount, 0);
check("label 缺省回落 id", projectActivities([{ id: "general" }], []).workers[0].label, "general");

// ── 配置下发 ──────────────────────────────────────────────────────────
const cfg = clientConfig(normalizeConfig(undefined), {});
check("配置里有素材 base", cfg.ui.avatars.base, `${HOST_PREFIX}/avatars`);
check("配置里有音球图", cfg.ui.avatars.orb, `${HOST_PREFIX}/avatars/orb.png`);
check("配置里按 worker id 映射头像", typeof cfg.ui.avatars.byWorker.general, "string");
check("宿主与客户端 API 前缀一致", CLIENT_PREFIX, HOST_PREFIX);

// V2.2：byWorker 按当前花名册**动态**生成 —— 目录里新增的专家自动拿到头像，
// 不需要改代码里的静态白名单（需求①「同步各个部分的专家列表」）。
{
	const dir = mkdtempSync(join(tmpdir(), "xfv-avatar-"));
	writeFileSync(join(dir, "chem.json"), JSON.stringify({ id: "chem", label: "小化 · 化学", description: "化学分析" }), "utf8");
	const dyn = clientConfig(normalizeConfig({ routing: { expertDirs: [dir] } }), {});
	check("目录专家自动进 byWorker", typeof dyn.ui.avatars.byWorker.chem, "string");
	check("未知 id 的头像回落 general 图", dyn.ui.avatars.byWorker.chem.endsWith("/general.png"), true);
	check("general 始终在映射里", typeof dyn.ui.avatars.byWorker.general, "string");
}

// ── 拖拽几何 ──────────────────────────────────────────────────────────
const vp = { w: 1000, h: 800 };
const sz = { w: 100, h: 100 };
check("左上角收敛到 margin", clampPosition({ x: -50, y: -50 }, sz, vp), { x: 8, y: 8 });
check("右下角收敛到视口内", clampPosition({ x: 990, y: 790 }, sz, vp), { x: 892, y: 692 });
check("中心位置原样返回", clampPosition({ x: 400, y: 300 }, sz, vp), { x: 400, y: 300 });
// 元素比视口大时取 max(m-w, vw-w-m)：保留右下角露出 margin，而不是死钉左上角。
check("元素大于视口时保留一角", clampPosition({ x: 0, y: 0 }, { w: 1200, h: 900 }, vp), { x: -208, y: -108 });
check("指针位移换算", positionFromPointer({ x: 10, y: 20 }, { x: 100, y: 100 }, { x: 130, y: 90 }), { x: 40, y: 10 });
check("小幅移动不算拖拽", isDragGesture({ x: 100, y: 100 }, { x: 103, y: 102 }), false);
check("横向超阈值算拖拽", isDragGesture({ x: 100, y: 100 }, { x: 106, y: 100 }), true);
check("纵向超阈值算拖拽", isDragGesture({ x: 100, y: 100 }, { x: 100, y: 106 }), true);
// 回归：positionStyle 必须显式 fixed。CSS 里 .xfv-orb 默认 position: relative，
// 若只给 left/top，绝对坐标会被当成相对偏移叠加 → 拖一次球就飞出视口。
check(
	"拖拽定位用 fixed（视口绝对坐标，不是 relative 偏移）",
	positionStyle({ x: 280, y: 300 }),
	{ position: "fixed", left: "280px", top: "300px", right: "auto", bottom: "auto", transform: "none" },
);

// ── V1.9 桌宠显隐/单个控制（纯函数）─────────────────────────────────
const wBusy = { id: "bioinfo", busy: true };
const wIdle = { id: "general", busy: false };
check("空闲专家不显示", isExpertVisible(wIdle, []), false);
check("在岗专家显示", isExpertVisible(wBusy, []), true);
check("被单独最小化的在岗专家不显示", isExpertVisible(wBusy, ["bioinfo"]), false);
check("其它专家最小化不影响本专家", isExpertVisible(wBusy, ["pathologist"]), true);
check("空数据不显示", isExpertVisible(null, []), false);
check("最小化集合用 Set 也支持", isExpertVisible(wBusy, new Set(["bioinfo"])), false);
check("可见名单只含在岗且未最小化者",
	visibleExperts([wIdle, wBusy, { id: "pathologist", busy: true }], ["pathologist"]).map((x) => x.worker.id),
	["bioinfo"],
);
check("可见序号从 0 连续分配",
	visibleExperts([wBusy, { id: "pathologist", busy: true }], []).map((x) => x.order),
	[0, 1],
);
check("默认位置按序号向下错开",
	[defaultExpertPosition(0), defaultExpertPosition(1), defaultExpertPosition(2)],
	[{ x: 18, y: 96 }, { x: 18, y: 260 }, { x: 18, y: 424 }],
);
check("默认布局常量与位置一致", DEFAULT_LAYOUT.gap, 164);
// 需求②：形象增大一倍（64×82 → 128×152），间距必须 ≥ 高度，否则桌宠会叠住。
check("桌宠尺寸常量稳定（需求②：翻倍）", EXPERT_SIZE, { w: 128, h: 152 });
check("默认间距不小于桌宠高度", DEFAULT_LAYOUT.gap >= EXPERT_SIZE.h, true);
check("最小化切换：加入", toggleMinimized([], "bioinfo"), ["bioinfo"]);
check("最小化切换：再点移除", toggleMinimized(["bioinfo"], "bioinfo"), []);
check("最小化切换：逐 id 独立", toggleMinimized(["bioinfo"], "pathologist"), ["bioinfo", "pathologist"]);
check("最小化切换：不改原数组", (() => {
	const original = ["bioinfo"];
	toggleMinimized(original, "pathologist");
	return original;
})(), ["bioinfo"]);

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败：`);
	for (const f of failures) console.error(`  - ${f.name}: ${JSON.stringify(f.actual)} ≠ ${JSON.stringify(f.expected)}`);
	process.exit(1);
}
console.log("\nV1.6 卡通形象纯函数全部通过");
