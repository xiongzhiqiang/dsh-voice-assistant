/**
 * 专家浮动桌宠层（V1.6 引入，V1.9 重做为「空闲隐藏 + 单独控制」）。
 *
 * 参考 whale-girl 的形态：卡通小人浮在页面最外层，跟着各自的工作会话切换
 * idle / working 姿态。但**与 whale-girl 完全独立** —— 不用它的 bundle、
 * 不改它的 manifest、不争它的槽。
 *
 * ## V1.9 的三点变化
 *   1. **透明底**：素材 PNG 本身已是 RGBA 透明，去掉 CSS 里的白色卡片背景；
 *   2. **空闲隐藏**：`busy=false` 的专家桌宠完全不渲染，只在它真正干活时
 *      从左侧滑入 + 轻微弹跳（`data-enter` 触发一次性入场动画）；
 *   3. **单个控制**：删掉整组收起按钮，改为每张桌宠自带一个最小化按钮，
 *      每位专家各自独立；位置也各自独立拖拽（按 `worker-<id>` 持久化）。
 *
 * 最小化的生命周期刻意是**本任务内**：点了之后这只桌宠在本次工作期间收起，
 * 任务一结束就自动复位，下次它再干活照常冒出来。这样做是为了避开一个交互
 * 死结 —— 桌宠空闲时完全隐藏，若最小化持久生效，用户就再也找不到"恢复"
 * 按钮了。按任务复位既满足"单个控制"，又不需要额外的恢复入口。
 *
 * ## 数据来源
 *
 * 轮询宿主半的轻量端点 `/activities`（几十字节），拿到每位专家的
 * `busy` / `task` / `elapsedMs`。刻意不读 /health（那是几 KB 的大对象）。
 * 端点不可用时整层静默隐藏 —— 桌宠是装饰，绝不能因为轮询失败刷屏报错。
 */
import * as React from "react";
import { getController } from "../core/instance.js";
import { activities } from "../core/runtime.js";
import { h } from "./dom.js";
import { clampPosition, positionStyle } from "./drag.js";
import { useDrag } from "./useDrag.js";
import {
	EXPERT_SIZE,
	DEFAULT_LAYOUT,
	defaultExpertPosition,
	visibleExperts,
	toggleMinimized,
} from "./expert-visual.js";

/** 工作态轮询间隔。 */
const POLL_MS = 1500;

/** 头像尺寸（用于边界收敛和默认位置）。 */
const AVATAR_SIZE = EXPERT_SIZE;

/**
 * 取配置里的头像 URL（兼容 V1.5 及更早的配置：没有 avatars 字段时用空串，
 * 组件据此走字母兜底）。
 */
function avatarUrl(config, workerId) {
	const avatars = config?.ui?.avatars;
	if (avatars === null || typeof avatars !== "object") return "";
	const byWorker = avatars.byWorker;
	if (byWorker !== null && typeof byWorker === "object" && typeof byWorker[workerId] === "string") {
		return byWorker[workerId];
	}
	return "";
}

/** 从 label 取一个字做字母头像（如「小因 · 基因分析」→「因」）。 */
function initialOf(label) {
	const text = typeof label === "string" ? label : "?";
	const parts = text.split(/\s*[·・]\s*/);
	const name = parts[0] ?? text;
	return name.slice(0, 1) || "?";
}

/**
 * 单个专家桌宠（仅在它 busy 且未被最小化时由父组件挂载）。
 *
 * @param worker - 工作态行。
 * @param url - 头像 URL。
 * @param order - 在可见名单里的序号（决定默认停靠位置）。
 * @param onToggleMin - 点击最小化按钮的回调。
 */
function ExpertAvatar({ worker, url, order, onToggleMin }) {
	const [hover, setHover] = React.useState(false);
	const busy = worker.busy === true;
	const storageKey = `worker-${worker.id}`;
	const { position, bind, wasDrag: wasAvatarDrag } = useDrag({
		storageKey,
		getSize: () => AVATAR_SIZE,
	});

	// 没拖过就按可见序号给一个默认位置（左侧竖排错开），并收敛进当前视口。
	const defaultPos = defaultExpertPosition(order, DEFAULT_LAYOUT);
	const resolved = position !== null
		? position
		: clampPosition(defaultPos, AVATAR_SIZE, { w: window.innerWidth, h: window.innerHeight });
	const style = positionStyle(resolved);

	const onPointerUp = (event) => {
		bind.onPointerUp(event);
		// 拖拽之后不切换 hover 卡（避免松手瞬间弹一张卡挡住界面）。
		if (wasAvatarDrag()) return;
		setHover((v) => !v);
	};

	const onMinClick = (event) => {
		// 不要触发桌宠本体的 pointer/drag/hover 逻辑。
		event.stopPropagation();
		onToggleMin(worker.id);
	};

	const title = busy ? `${worker.label} 正在：${worker.task}（点 − 收起本次）` : `${worker.label} · 空闲`;

	return h(
		"div",
		{
			className: "xfv-expert",
			"data-busy": busy ? "true" : "false",
			"data-enter": "true",
			"data-xfv": `expert-${worker.id}`,
			style,
			title,
			onPointerDown: bind.onPointerDown,
			onPointerMove: bind.onPointerMove,
			onPointerUp,
			onPointerCancel: bind.onPointerUp,
			onMouseEnter: () => setHover(true),
			onMouseLeave: () => setHover(false),
		},
		h(
			"button",
			{
				type: "button",
				className: "xfv-expert-min",
				title: "收起本次（任务结束自动恢复）",
				"data-xfv": `expert-min-${worker.id}`,
				onPointerDown: (e) => e.stopPropagation(),
				onPointerUp: (e) => e.stopPropagation(),
				onClick: onMinClick,
			},
			"−",
		),
		h(
			"div",
			{ className: "xfv-expert-figure" },
			url !== ""
				? h("img", { className: "xfv-expert-img", src: url, alt: worker.label, draggable: false })
				: h("span", { className: "xfv-expert-initial" }, initialOf(worker.label)),
			h("span", { className: "xfv-expert-status" }),
		),
		h("div", { className: "xfv-expert-name" }, initialOf(worker.label)),
		hover && busy
			? h(
					"div",
					{ className: "xfv-expert-task" },
					h("b", null, `${worker.label} · 工作中`),
					h("div", null, worker.task || "正在处理任务…"),
				)
			: null,
	);
}

/**
 * 专家桌宠层组件。
 */
export function ExpertTeam() {
	const controller = getController();
	const config = controller?.config ?? null;
	const [workers, setWorkers] = React.useState([]);
	const [available, setAvailable] = React.useState(false);
	// 被单独最小化（本任务内收起）的专家 id。内存态、逐 id 隔离、互不影响。
	const [minimizedIds, setMinimizedIds] = React.useState([]);

	React.useEffect(() => {
		let alive = true;
		let timer = null;

		const poll = async () => {
			if (controller === null) return;
			const data = await activities();
			if (!alive) return;
			if (data !== null) {
				setWorkers(Array.isArray(data.workers) ? data.workers : []);
				setAvailable(true);
			} else {
				setAvailable(false);
			}
		};

		poll();
		timer = setInterval(poll, POLL_MS);
		return () => {
			alive = false;
			if (timer !== null) clearInterval(timer);
		};
	}, [controller]);

	// 任务结束（专家不再 busy）时自动复位它的最小化状态 —— 下次照常冒出来。
	React.useEffect(() => {
		setMinimizedIds((prev) => {
			if (prev.length === 0) return prev;
			const busyIds = new Set(workers.filter((w) => w.busy === true).map((w) => w.id));
			const next = prev.filter((id) => busyIds.has(id));
			return next.length === prev.length ? prev : next;
		});
	}, [workers]);

	// 每位专家各自切换最小化状态，互不影响。
	const toggleMin = React.useCallback((id) => {
		setMinimizedIds((prev) => toggleMinimized(prev, id));
	}, []);

	// V1.9：没有在岗专家时整层不渲染任何桌宠（空闲隐藏）。
	const visible = visibleExperts(workers, minimizedIds);
	if (visible.length === 0) return null;

	return h(
		"div",
		{
			className: "xfv-experts",
			"data-xfv": "experts",
			"data-available": available ? "true" : "false",
			"data-visible": String(visible.length),
		},
		visible.map(({ worker, order }) =>
			h(ExpertAvatar, {
				key: worker.id,
				worker,
				url: avatarUrl(config, worker.id),
				order,
				onToggleMin: toggleMin,
			}),
		),
	);
}
