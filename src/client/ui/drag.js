/**
 * 浮层拖拽：几何收敛 + 位置持久化（V1.6，纯函数 + 薄 DOM 壳）。
 *
 * ## 为什么要拆出纯函数
 *
 * 拖拽里最容易错的是边界收敛的符号（右边界减宽度、下边界减高度），
 * 在浏览器里靠肉眼查极难定位。几何计算抽成 `clampPosition`，用数值单测
 * 钉住四个角与窗口缩放后回收的场景。DOM 部分只负责把指针事件翻译成坐标。
 *
 * ## 为什么位置要持久化
 *
 * 用户把音球/专家拖到顺手的地方后刷新页面，位置必须还在 —— 否则每次
 * 开机都要重拖一遍。存 localStorage，key 按角色区分；存储不可用时
 * （隐私模式、配额满）静默退化成"本次会话有效"，不抛错、不影响拖拽。
 */

/** localStorage 的 key 前缀（与播报账本 `xfv:v1:` 同族，便于统一管理）。 */
const STORAGE_PREFIX = "xfv:v1:pos:";

/**
 * 把期望位置收敛进视口（纯函数，可单测）。
 *
 * @param desired - 期望的 `{x, y}`（相对视口左上，元素左上角坐标）。
 * @param size - 元素尺寸 `{w, h}`。
 * @param viewport - 视口尺寸 `{w, h}`。
 * @param margin - 四周留白，默认 8px。
 * @returns 收敛后的 `{x, y}`（整数）。
 */
export function clampPosition(desired, size, viewport, margin = 8) {
	const w = Math.max(0, Number(size?.w) || 0);
	const h = Math.max(0, Number(size?.h) || 0);
	const vw = Math.max(1, Number(viewport?.w) || 1);
	const vh = Math.max(1, Number(viewport?.h) || 1);
	const m = Math.max(0, Number(margin) || 0);

	// 元素比视口还大时，允许负坐标（否则左上角会被死钉在 margin），
	// 但至少保证露出 margin 那么宽的一角，不至于整个拖没。
	const maxX = Math.max(m - w, vw - w - m);
	const maxY = Math.max(m - h, vh - h - m);
	const x = Math.min(Math.max(Number(desired?.x) || 0, m), maxX);
	const y = Math.min(Math.max(Number(desired?.y) || 0, m), maxY);
	return { x: Math.round(x), y: Math.round(y) };
}

/**
 * 从指针事件里算新的左上角坐标（纯函数，可单测）。
 *
 * @param origin - 按下时的元素左上角 `{x, y}`。
 * @param start - 按下时的指针位置 `{x, y}`。
 * @param current - 当前指针位置 `{x, y}`。
 * @returns 期望的新左上角坐标。
 */
export function positionFromPointer(origin, start, current) {
	return {
		x: (Number(origin?.x) || 0) + (Number(current?.x) || 0) - (Number(start?.x) || 0),
		y: (Number(origin?.y) || 0) + (Number(current?.y) || 0) - (Number(start?.y) || 0),
	};
}

/**
 * 是否构成"拖拽"（而不是点击）：移动超过阈值才算。
 *
 * @param start - 按下位置。
 * @param current - 当前位置。
 * @param threshold - 阈值像素，默认 5。
 * @returns 超过阈值返回 true。
 */
export function isDragGesture(start, current, threshold = 5) {
	const dx = Math.abs((Number(current?.x) || 0) - (Number(start?.x) || 0));
	const dy = Math.abs((Number(current?.y) || 0) - (Number(start?.y) || 0));
	return dx > threshold || dy > threshold;
}

/** 取存储对象；不可用时返回 null（调用方据此退化为内存模式）。 */
function storageOrNull() {
	try {
		if (typeof localStorage === "undefined" || localStorage === null) return null;
		return localStorage;
	} catch {
		return null;
	}
}

/**
 * 读持久位置。
 * @param key - 角色 key（如 `orb` / `worker-bioinfo`）。
 * @returns `{x,y}`；无记录或格式坏时返回 null。
 */
export function readPosition(key) {
	const storage = storageOrNull();
	if (storage === null || typeof key !== "string" || key === "") return null;
	try {
		const raw = storage.getItem(`${STORAGE_PREFIX}${key}`);
		if (raw === null) return null;
		const parsed = JSON.parse(raw);
		const x = Number(parsed?.x);
		const y = Number(parsed?.y);
		if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
		return { x, y };
	} catch {
		return null;
	}
}

/**
 * 写持久位置（失败静默，绝不因存储问题打断拖拽）。
 * @param key - 角色 key。
 * @param pos - `{x,y}`。
 */
export function writePosition(key, pos) {
	const storage = storageOrNull();
	if (storage === null || typeof key !== "string" || key === "") return false;
	try {
		storage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify({ x: pos.x, y: pos.y }));
		return true;
	} catch {
		return false;
	}
}

/**
 * 把位置写成可直接塞进 `style` 的对象（React 的 style prop 形状）。
 * @param pos - `{x,y}`。
 */
export function positionStyle(pos) {
	return { left: `${pos.x}px`, top: `${pos.y}px`, right: "auto", bottom: "auto", transform: "none" };
}
