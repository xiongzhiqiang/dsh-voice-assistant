/**
 * 拖拽 hook（V1.6）：把 pointer 事件翻译成元素左上角坐标。
 *
 * ## 为什么不用 HTML5 draggable
 *
 * `draggable` 在触屏上不一致、拖影难看、且和"单击唤醒/长按设置"冲突。
 * Pointer Events + `setPointerCapture` 是跨鼠标/触屏/笔的统一通道：
 * 一旦按住就捕获指针，手指移出元素也不会丢事件。
 *
 * ## 和原有交互的关系
 *
 * 语音球本来就有「单击唤醒、长按设置」。拖拽不能误触发它们：
 *   - 只有移动超过 `isDragGesture` 阈值才进入拖拽态；
 *   - 一旦判定为拖拽，松开时通过 `onDragEnd` 的 `moved=true` 告诉调用方
 *     抑制这次点击（调用方在 pointerup 处理里检查 `wasDrag()`）。
 */
import * as React from "react";
import { clampPosition, isDragGesture, positionFromPointer, readPosition, writePosition } from "./drag.js";

/** 默认拖动阈值。 */
const DRAG_THRESHOLD = 5;

/**
 * @param options.storageKey - 位置持久化 key；空串表示不持久化。
 * @param options.getSize - 返回元素尺寸 `{w,h}` 的函数（拖拽时取实时值）。
 * @param options.onDragStart - 开始拖拽时回调（可选，用于切 drag 姿态）。
 * @param options.onDragEnd - 结束回调 `(moved, pos)`。
 * @returns `{ position, bind, wasDrag, reset }`。
 */
export function useDrag(options = {}) {
	const storageKey = typeof options.storageKey === "string" ? options.storageKey : "";
	const getSize = typeof options.getSize === "function" ? options.getSize : () => ({ w: 72, h: 72 });

	const [position, setPosition] = React.useState(() => {
		const saved = storageKey === "" ? null : readPosition(storageKey);
		return saved ?? null; // null = 没拖过，交给 CSS 默认定位
	});

	const dragRef = React.useRef(null);
	const movedRef = React.useRef(false);
	const positionRef = React.useRef(position);
	positionRef.current = position;

	/** 本次 pointerup 是否属于拖拽（供单击处理判定，读完即清零）。 */
	const wasDrag = React.useCallback(() => {
		const moved = movedRef.current;
		movedRef.current = false;
		return moved;
	}, []);

	const onPointerDown = React.useCallback((event) => {
		// 只接管主键（鼠标左键 / 触摸 / 笔）；右键留给"设置"菜单。
		if (event.button !== undefined && event.button !== 0) return;
		const el = event.currentTarget;
		const rect = el.getBoundingClientRect();
		const current = positionRef.current ?? { x: rect.left, y: rect.top };
		dragRef.current = {
			pointerId: event.pointerId,
			start: { x: event.clientX, y: event.clientY },
			origin: { x: current.x, y: current.y },
			el,
		};
		movedRef.current = false;
		try {
			el.setPointerCapture?.(event.pointerId);
		} catch {
			// 某些环境不支持捕获，拖拽仍可用（只是移出元素会丢事件）。
		}
	}, []);

	const onPointerMove = React.useCallback((event) => {
		const drag = dragRef.current;
		if (drag === null || drag.pointerId !== event.pointerId) return;
		const point = { x: event.clientX, y: event.clientY };
		if (!movedRef.current && !isDragGesture(drag.start, point, DRAG_THRESHOLD)) return;
		if (!movedRef.current) {
			movedRef.current = true;
			options.onDragStart?.();
		}
		const desired = positionFromPointer(drag.origin, drag.start, point);
		const size = getSize();
		const next = clampPosition(desired, size, { w: window.innerWidth, h: window.innerHeight });
		positionRef.current = next;
		setPosition(next);
	}, [getSize, options]);

	const onPointerUp = React.useCallback((event) => {
		const drag = dragRef.current;
		if (drag === null || drag.pointerId !== event.pointerId) return;
		try {
			drag.el.releasePointerCapture?.(event.pointerId);
		} catch {
			// 已自动释放。
		}
		dragRef.current = null;
		if (movedRef.current) {
			if (storageKey !== "") writePosition(storageKey, positionRef.current);
			options.onDragEnd?.(true, positionRef.current);
		} else {
			options.onDragEnd?.(false, positionRef.current);
		}
	}, [storageKey, options]);

	const bind = React.useMemo(() => ({
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onPointerCancel: onPointerUp,
	}), [onPointerDown, onPointerMove, onPointerUp]);

	/** 清除持久位置并回到 CSS 默认定位（设置面板的"位置重置"用）。 */
	const reset = React.useCallback(() => {
		if (storageKey !== "") {
			try {
				localStorage.removeItem(`xfv:v1:pos:${storageKey}`);
			} catch {
				// 存储不可用，只重置内存。
			}
		}
		positionRef.current = null;
		setPosition(null);
	}, [storageKey]);

	return { position, bind, wasDrag, reset };
}
