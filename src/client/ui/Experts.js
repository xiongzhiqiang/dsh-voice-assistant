/**
 * 专家浮动桌宠层（V1.6）。
 *
 * 参考 whale-girl 的形态：一张张卡通小人浮在页面最外层，跟着各自的
 * 工作会话切换 idle / working 姿态。但**与 whale-girl 完全独立** ——
 * 不用它的 bundle、不改它的 manifest、不争它的槽，只是借了"桌宠浮在
 * 界面之上"这个交互形态。
 *
 * ## 数据来源
 *
 * 轮询宿主半的轻量端点 `/activities`（几十字节），拿到每位专家的
 * `busy` / `task` / `elapsedMs`。刻意不读 /health（那是几 KB 的大对象）。
 * 端点不可用时整层静默隐藏 —— 桌宠是装饰，绝不能因为轮询失败刷屏报错。
 *
 * ## 为什么单独一个 overlay 注册
 *
 * 挂在 `shell.overlay` 的另一个 id（`voice-assistant-experts`）上，
 * 与语音球并列但不耦合：用户关掉桌宠不影响语音，拖桌宠也不会带球跑。
 */
import * as React from "react";
import { getController } from "../core/instance.js";
import { activities } from "../core/runtime.js";
import { h } from "./dom.js";
import { positionStyle } from "./drag.js";
import { useDrag } from "./useDrag.js";

/** 工作态轮询间隔。 */
const POLL_MS = 1500;

/** 头像尺寸（用于边界收敛）。 */
const AVATAR_SIZE = { w: 64, h: 78 };

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
 * 单个专家桌宠。
 */
function ExpertAvatar({ worker, url, collapsed }) {
	const [hover, setHover] = React.useState(false);
	const busy = worker.busy === true;
	const storageKey = `worker-${worker.id}`;
	const { position, bind, wasDrag: wasAvatarDrag } = useDrag({
		storageKey,
		getSize: () => AVATAR_SIZE,
	});

	const onPointerUp = (event) => {
		bind.onPointerUp(event);
		// 拖拽之后不切换 hover 卡（避免松手瞬间弹一张卡挡住界面）。
		if (wasAvatarDrag()) return;
		setHover((v) => !v);
	};

	const style = position !== null ? positionStyle(position) : undefined;
	const title = busy ? `${worker.label} 正在：${worker.task}` : `${worker.label} · 空闲`;

	return h(
		"div",
		{
			className: "xfv-expert",
			"data-busy": busy ? "true" : "false",
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
			"div",
			{ className: "xfv-expert-figure" },
			url !== ""
				? h("img", { className: "xfv-expert-img", src: url, alt: worker.label, draggable: false })
				: h("span", { className: "xfv-expert-initial" }, initialOf(worker.label)),
			h("span", { className: "xfv-expert-status" }),
		),
		h("div", { className: "xfv-expert-name" }, initialOf(worker.label)),
		hover && !collapsed && busy
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
	const [collapsed, setCollapsed] = React.useState(false);

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

	// 没有路由专家清单时不显示整层（纯个人助手模式没有 worker）。
	const list = workers.length > 0 ? workers : (config?.routing?.workers ?? []).map((w) => ({
		id: w.id,
		label: w.label,
		busy: false,
		task: "",
	}));
	if (list.length === 0) return null;

	return h(
		"div",
		{
			className: "xfv-experts",
			"data-xfv": "experts",
			"data-available": available ? "true" : "false",
		},
		h(
			"button",
			{
				type: "button",
				className: "xfv-experts-toggle",
				title: collapsed ? "展开专家桌宠" : "收起专家桌宠",
				onClick: () => setCollapsed((v) => !v),
			},
			collapsed ? "👥" : "−",
		),
		!collapsed
			? h(
					"div",
					{ className: "xfv-experts-row" },
					list.map((worker) =>
						h(ExpertAvatar, {
							key: worker.id,
							worker,
							url: avatarUrl(config, worker.id),
							collapsed,
						}),
					),
				)
			: null,
	);
}
