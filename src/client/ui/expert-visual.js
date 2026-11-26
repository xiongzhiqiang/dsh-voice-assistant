/**
 * 桌宠显隐/排布的纯决策层（V1.9，零依赖，可单测）。
 *
 * ## 为什么单独抽一层
 *
 * V1.6–V1.8 的桌宠是"全员常驻竖排 + 整组一个收起按钮"，显隐状态只有一个
 * `collapsed` 布尔值。V1.9 改成三件事后，规则一下子变复杂：
 *   1. 空闲专家的桌宠**完全隐藏**，只在它 busy 时才冒出来；
 *   2. 每一位专家**各自**可最小化，互不影响（不再是整组开关）；
 *   3. 排列位置按 id 各自独立（拖拽/最小化状态分别持久化）。
 *
 * 这些判断如果散在 React 组件里，单测够不着、真机又难复现（要真的派单
 * 才能看到 busy）。所以把"该不该显示、显示成什么形态、默认排在哪"抽成
 * 纯函数，用数值单测钉死，组件只负责把结果渲染出来。
 */

/**
 * 桌宠尺寸（与 styles.js 的 .xfv-expert-figure / .xfv-expert 对齐，含名字行）。
 *
 * 需求②：用户要求形象"增大一倍"，故由 64×82 提到 128×152。
 *   128 = 64 × 2（形象本体）；
 *   152 = 128 + 名字行（font-size 14 × line-height 1.3 ≈ 18.2）+ margin-top 3 ≈ 149，
 *         取 152 留 3px 容差，避免把名字行算到卡片外。
 *
 * ⚠️ 改这里必须同步 styles.js 的 `.xfv-expert` / `.xfv-expert-figure` 宽度与高度，
 * 以及 `.xfv-expert-initial` 字号 —— 三处不一致会让拖拽边界收敛用错尺寸
 * （元素比视口大时的 clampPosition 分支会算歪），单测 `visuals.test.mjs` 钉着这个值。
 */
export const EXPERT_SIZE = Object.freeze({ w: 128, h: 152 });

/**
 * 左侧竖排的默认起点与间距（未拖拽过的桌宠按此错开，避免叠在一起）。
 *
 * gap 必须 ≥ EXPERT_SIZE.h，否则两张桌宠会互相压住。原 90（对应 82 高）
 * 留 8px 余量；尺寸翻倍后取 164（152 + 12），保持同样的观感间距。
 */
export const DEFAULT_LAYOUT = Object.freeze({ left: 18, top: 96, gap: 164 });

/**
 * 某张桌宠此刻是否该显示。
 *
 * 规则：只有在岗（busy）且未被单独最小化的专家才冒出来；空闲专家完全隐藏。
 *
 * @param worker - 工作态行 `{busy, ...}`（来自 /activities）。
 * @param minimizedIds - 被单独最小化的专家 id 集合（Set 或数组）。
 * @returns true = 渲染桌宠。
 */
export function isExpertVisible(worker, minimizedIds) {
	if (worker === null || typeof worker !== "object") return false;
	if (worker.busy !== true) return false;
	const set = minimizedIds instanceof Set
		? minimizedIds
		: new Set(Array.isArray(minimizedIds) ? minimizedIds : []);
	return !set.has(worker.id);
}

/**
 * 依据当前在岗桌宠，算出一张桌宠的默认停靠位置（纯函数）。
 *
 * 只按"在岗名单里的序号"错开，不按全体专家索引 —— 这样同时只有 1 位忙时，
 * 它出现在最上面而不是屏幕中间；多人忙时依次往下排。已被用户拖过（有持久
 * 位置）的桌宠不会用这个值。
 *
 * @param order - 该桌宠在**当前可见名单**里的序号（0 起）。
 * @param layout - 布局常量 `{left, top, gap}`，可注入以便测试。
 * @returns `{x, y}` 视口坐标（未做视口收敛，交给 clampPosition）。
 */
export function defaultExpertPosition(order, layout = DEFAULT_LAYOUT) {
	const i = Math.max(0, Number(order) || 0);
	return {
		x: Number(layout?.left) || 0,
		y: (Number(layout?.top) || 0) + i * (Number(layout?.gap) || 0),
	};
}

/**
 * 计算当前应渲染的桌宠名单（在岗且未最小化），并给每张分配默认序号。
 *
 * @param workers - 工作态行数组。
 * @param minimizedIds - 被单独最小化的 id 集合。
 * @returns `[{worker, order}]`。
 */
export function visibleExperts(workers, minimizedIds) {
	const list = Array.isArray(workers) ? workers : [];
	return list
		.filter((worker) => isExpertVisible(worker, minimizedIds))
		.map((worker, order) => ({ worker, order }));
}

/**
 * 切换单个专家的最小化状态，返回新的 id 数组（不可变更新）。
 *
 * @param minimizedIds - 当前最小化 id 数组。
 * @param id - 要切换的专家 id。
 * @returns 新数组（原数组不变）。
 */
export function toggleMinimized(minimizedIds, id) {
	const list = Array.isArray(minimizedIds) ? minimizedIds : [];
	if (typeof id !== "string" || id === "") return list.slice();
	return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}
