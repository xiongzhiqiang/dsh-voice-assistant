/**
 * 语音球浮层：注册到官方 `shell.overlay` 槽。
 *
 * ## 为什么是 `shell.overlay`
 *
 * 这个槽是官方明确留给"悬浮在整个应用之上"的席位（list 槽、可叠加、
 * 默认 click-through）。相比之下 `root` 是单槽 —— 注册进去会把整个
 * 应用框架顶掉。语音球必须与任何界面共存，只有 overlay 是正确选择。
 *
 * ## 交互约定
 *
 * - **单击**：启用 / 唤醒 / 打断播报（按当前状态决定，见 `controller.wake`）。
 * - **长按 600ms**：打开设置面板。避免单击语义过载，同时不引入新按钮。
 * - **右键**：同长按（桌面端习惯）。
 *
 * ## 为什么状态从 store 读而不是 React state
 *
 * 状态由非 React 的音频回调写（识别器 onend、播报 onend），
 * 放进 React state 会立刻遇到闭包陈旧。这里用 `useSyncExternalStore`
 * 直接订阅控制器快照，任何来源的变更都能立刻反映到界面。
 */
import * as React from "react";

import { STATES } from "../core/constants.js";
import { getController } from "../core/instance.js";
import { h, useStore } from "./dom.js";

/** 长按判定时长（毫秒）。 */
const LONG_PRESS_MS = 600;

/** 球形图标路径（声波）。 */
const GLYPH = "M12 3v18M8 7v10M16 7v10M4 10v4M20 10v4";

/** 状态的简短操作提示。 */
const HINTS = {
	[STATES.OFF]: "单击启用语音",
	[STATES.STANDBY]: "说「小凤」唤醒，或单击",
	// 播报结束也落在「正在听」，所以这句要能覆盖两种来路：刚唤醒、刚听完回答。
	[STATES.ACTIVE]: "正在听，接着说就行；说完单击提交",
	[STATES.THINKING]: "思考中，单击可打断",
	[STATES.SPEAKING]: "播报中，单击可打断",
	[STATES.SLEEPING]: "休眠中，单击唤醒",
};

/**
 * 语音球组件。
 */
export function VoiceOrb() {
	const controller = getController();
	if (controller === null) return null;

	const subscribe = React.useCallback((callback) => controller.subscribe(callback), [controller]);
	const getSnapshot = React.useCallback(() => controller.getSnapshot(), [controller]);
	const snapshot = useStore(subscribe, getSnapshot);

	const [panelOpen, setPanelOpen] = React.useState(false);
	const longPressTimer = React.useRef(null);
	const longPressed = React.useRef(false);

	const config = controller.config;
	const status = snapshot.status;

	/** 清除长按计时。 */
	const clearLongPress = () => {
		if (longPressTimer.current !== null) {
			clearTimeout(longPressTimer.current);
			longPressTimer.current = null;
		}
	};

	/** 指针按下：起长按计时。 */
	const onPointerDown = () => {
		longPressed.current = false;
		clearLongPress();
		longPressTimer.current = setTimeout(() => {
			longPressed.current = true;
			setPanelOpen(true);
		}, LONG_PRESS_MS);
	};

	/** 指针抬起：未触发长按则视为单击。 */
	const onPointerUp = () => {
		clearLongPress();
		if (longPressed.current) {
			longPressed.current = false;
			return;
		}
		if (status === STATES.OFF) controller.start();
		else if (status === STATES.SLEEPING || status === STATES.STANDBY) controller.wake();
		else if (status === STATES.ACTIVE) {
			// 正在听：单击 = 「我说完了，现在提交」。
			//
			// 这是需求「静音满阈值才算说完」的逃生口 —— 干等是默认行为，
			// 但人总有想立刻要答案的时候。没攒下内容时退化为"重开这一轮"，
			// 给个提示而不是静默无反应。
			if (!controller.submitTurn()) controller.notice("还没听到内容，请直接说。", "info");
		} else controller.interrupt();
	};

	React.useEffect(() => clearLongPress, []);

	// 待提交时每秒刷一次，好让"还有 N 秒提交"真的在走。
	// 状态快照只在 patch 时变化，光靠订阅看不出时间的流逝。
	const [, tickSecond] = React.useState(0);
	const pending = snapshot.pending ?? "";
	React.useEffect(() => {
		if (status !== STATES.ACTIVE || pending === "") return undefined;
		const timer = setInterval(() => tickSecond((n) => n + 1), 1000);
		return () => clearInterval(timer);
	}, [status, pending]);

	const bubble = (() => {
		if (snapshot.notice !== "") return { text: snapshot.notice, kind: snapshot.noticeKind, tag: "" };
		if (snapshot.partial !== "" && status === STATES.SPEAKING) {
			return { text: snapshot.partial, kind: "info", tag: "播报" };
		}
		// 正在听且有内容：显示"已攒下的整轮 + 正在说的这半句"，让用户看到
		// 全部会被提交的内容。倒计时是必需的 —— 需求是"静音满阈值才提交"，
		// 不显示等待进度的话界面看起来就像卡住了。
		if (status === STATES.ACTIVE && (pending !== "" || snapshot.partial !== "")) {
			const live = snapshot.partial === "" ? "" : pending === "" ? snapshot.partial : `${pending}${snapshot.partial}`;
			return { text: `${live}${countdownSuffix(snapshot)}`, kind: "info", tag: pending === "" ? "听到" : "待提交" };
		}
		return null;
	})();

	return h(
		"div",
		{
			className: "xfv-root",
			"data-status": status,
			"data-position": config.ui.position,
			"data-xfv": "root",
		},
		panelOpen ? renderPanel(controller, snapshot, () => setPanelOpen(false)) : null,
		bubble !== null && config.ui.showTranscript
			? h(
					"div",
					{ className: "xfv-bubble", "data-kind": bubble.kind },
					bubble.tag !== "" ? h("span", { className: "xfv-tag" }, `${bubble.tag}｜`) : null,
					bubble.text,
				)
			: null,
		h(
			"button",
			{
				type: "button",
				className: "xfv-orb",
				title: `${HINTS[status] ?? ""}（长按设置）`,
				"aria-label": `语音助手，当前${snapshot.label}。${HINTS[status] ?? ""}`,
				onPointerDown,
				onPointerUp,
				onPointerLeave: clearLongPress,
				onContextMenu: (event) => {
					event.preventDefault();
					setPanelOpen(true);
				},
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						onPointerUp();
					}
				},
			},
			h("span", { className: "xfv-halo" }),
			h(
				"svg",
				{
					className: "xfv-glyph",
					viewBox: "0 0 24 24",
					fill: "none",
					strokeWidth: 1.9,
					strokeLinecap: "round",
					"aria-hidden": "true",
				},
				h("path", { d: GLYPH, stroke: "currentColor" }),
			),
			h("span", { className: "xfv-dot" }),
		),
	);
}

/**
 * 拼出"还有 N 秒自动提交"的后缀（给用户看等待进度）。
 *
 * 用截止时刻现算，而不是让控制器每秒 patch —— 每秒写状态快照会把整棵
 * 订阅树刷 60 次/分钟，纯属浪费。
 *
 * @param snapshot - 当前快照。
 * @returns 形如 `（还有 42 秒自动提交）` 的字符串；算不出来时返回空串。
 */
function countdownSuffix(snapshot) {
	const dueAt = snapshot.pendingDueAt;
	if (typeof dueAt !== "number") return "";
	const left = Math.ceil((dueAt - Date.now()) / 1000);
	if (left <= 0) return "（即将提交）";
	return `（还有 ${left} 秒自动提交）`;
}

/**
 * 会话切换区（需求 ②）。
 *
 * ## 为什么必须是独立组件，而不是 renderPanel 里的一个函数（真机踩坑）
 *
 * 这段最早写成 `renderSessions(controller, snapshot)` 由 `renderPanel` 直接
 * 调用。它里面有 `useState` / `useEffect` —— 而 `renderPanel` 只在
 * `panelOpen === true` 时才被调用，于是：
 *
 * ```
 * 面板开着 → 组件这次渲染多出 3 个 hook
 * 面板关着 → 又少 3 个
 * ```
 *
 * React 要求同一组件的 hook **调用顺序与数量在每次渲染间完全一致**，
 * 这就直接抛 `Minified React error #310`（"Rendered more hooks than during
 * the previous render"），整个 `shell.overlay` 槽条目崩掉、语音球消失。
 *
 * 根因是把带 hook 的逻辑写成了**条件调用的普通函数**：hook 是记在"当前
 * 渲染中的组件"账上的，普通函数不会自开一个 hook 账本。提成真正的组件
 * （`h(SessionsSection, …)`）之后，它的 hook 归自己的 fiber 管，
 * 条件渲染它就完全合法 —— 这也是 React 里条件渲染的正确写法：**条件放在
 * 组件外层，hooks 放在组件内部**。
 *
 * 注意：本文件里的 `renderPanel` / `renderSessions` 这类 `renderXxx` 命名
 * 是"返回元素树的普通函数"，**绝不能在里面调 hook**。要用 hook 就提组件。
 *
 * ## 为什么列表要等用户展开才拉
 *
 * `ctx.sessions.refresh()` 是一次宿主往返。面板一打开就拉，会让"看一眼
 * 状态"这种轻量操作也付网络代价；而本地投影（`listSessions()`）不发请求，
 * 但可能落后于宿主的真实状态。折中是：**展开时拉一次**，之后用投影，
 * 列表里给一个显式的"刷新"。
 *
 * @param props - `{ controller, snapshot }`。
 */
function SessionsSection(props) {
	const { controller, snapshot } = props;
	const [open, setOpen] = React.useState(false);
	const [rows, setRows] = React.useState([]);
	const [busy, setBusy] = React.useState(false);

	const reload = React.useCallback(
		async (withRefresh) => {
			setBusy(true);
			try {
				if (withRefresh) await controller.refreshSessions();
				setRows(controller.listSessions());
			} finally {
				setBusy(false);
			}
		},
		[controller],
	);

	// 展开时才拉一次宿主列表（见上面的取舍）。
	React.useEffect(() => {
		if (!open) return undefined;
		reload(true);
		return undefined;
	}, [open, reload]);

	const target = snapshot.sessionTarget ?? { mode: "", label: "尚未建立", id: null };
	const currentId = target.id;

	/** 切换后的统一收尾：重拉列表并折叠选择器。 */
	const act = async (operation) => {
		setBusy(true);
		try {
			await operation();
			setRows(controller.listSessions());
			setOpen(false);
		} finally {
			setBusy(false);
		}
	};

	return h(
		"div",
		{ className: "xfv-sessions" },
		h(
			"div",
			{ className: "xfv-sessions-head" },
			h("span", { className: "k" }, "语音去向"),
			h("span", { className: "v", "data-mode": target.mode }, target.label),
		),
		h(
			"div",
			{ className: "xfv-actions" },
			h(
				"button",
				{ type: "button", className: "xfv-btn", onClick: () => setOpen((value) => !value), disabled: busy },
				open ? "收起会话列表" : "切换会话…",
			),
			h(
				"button",
				{
					type: "button",
					className: "xfv-btn",
					disabled: busy,
					onClick: () => act(() => controller.newSession({})),
				},
				"新建会话",
			),
			target.mode !== "persistent"
				? h(
						"button",
						{
							type: "button",
							className: "xfv-btn",
							disabled: busy,
							onClick: () => act(() => controller.backToAssistant()),
						},
						"回到常驻助手",
					)
				: null,
		),
		open
			? h(
					"div",
					{ className: "xfv-session-list" },
					rows.length === 0
						? h("div", { className: "xfv-hint" }, busy ? "正在读取会话…" : "没有可切换的会话。")
						: rows.map((row) =>
								h(
									"button",
									{
										type: "button",
										className: "xfv-session-item",
										key: row.id,
										"data-current": row.id === currentId ? "true" : "false",
										disabled: busy,
										onClick: () => act(() => controller.switchSession(row.id)),
									},
									h("span", { className: "t" }, row.title),
									h(
										"span",
										{ className: "m" },
										[
											row.running ? "运行中" : "",
											row.id === currentId ? "当前" : "",
											row.cwd === "" ? "" : shortPath(row.cwd),
										]
											.filter((part) => part !== "")
											.join(" · "),
									),
								),
							),
					h(
						"div",
						{ className: "xfv-actions" },
						h(
							"button",
							{ type: "button", className: "xfv-btn", onClick: () => reload(true), disabled: busy },
							"刷新列表",
						),
					),
				)
			: null,
	);
}

/**
 * 把工作目录压短（面板窄，完整路径会撑破布局）。
 * @param cwd - 完整路径。
 * @returns 缩略路径。
 */
function shortPath(cwd) {
	const normalized = String(cwd).replace(/[\\/]+$/, "");
	const parts = normalized.split(/[\\/]/).filter((part) => part !== "");
	if (parts.length <= 2) return normalized;
	return `…/${parts.slice(-2).join("/")}`;
}

/**
 * 渲染设置/状态面板。
 * @param controller - 语音控制器。
 * @param snapshot - 当前快照。
 * @param onClose - 关闭回调。
 */
function renderPanel(controller, snapshot, onClose) {
	const engineLabel = {
		webspeech: "浏览器识别",
		"webspeech-fallback": "浏览器识别（已降级）",
		http: "上游转写",
		"http-fallback": "上游转写（已降级）",
		ears: "dsh-ears 转写",
		none: "无可用引擎",
	}[snapshot.engine] ?? snapshot.engine;

	const polishLabel =
		snapshot.polishVia === "llm"
			? "模型润色"
			: snapshot.polishVia === "rules"
				? "规则清理"
				: snapshot.polishVia === "raw"
					? "原样发送"
					: controller.config.polish.enabled
						? "就绪"
						: "已关闭";

	return h(
		"div",
		{ className: "xfv-panel", role: "dialog", "aria-label": "语音助手设置" },
		h(
			"div",
			{ className: "xfv-panel-head" },
			h("span", { className: "xfv-title" }, "小凤 · 语音助手"),
			h("button", { type: "button", className: "xfv-close", onClick: onClose, "aria-label": "关闭" }, "×"),
		),
		row("状态", snapshot.label),
		row("唤醒词", `${controller.config.wake.word}${controller.config.wake.aliases.length > 0 ? `（含 ${controller.config.wake.aliases.length} 个同音）` : ""}`),
		row("识别", engineLabel),
		row("润色", polishLabel),
		row("休眠", `${Math.round(controller.config.sleep.idleTimeoutMs / 1000)} 秒无语音（播报完也按这个计时）`),
		row("完成判据", `静音 ${Math.round((controller.config.turn?.silenceMs ?? 10000) / 1000)} 秒提交（单击语音球可立即提交）`),
		row("回声抑制", controller.config.turn?.echoGuard === false ? "已关闭" : "已开启"),
		// 常驻会话在侧边栏的标注名。为什么不是"隐藏"：DSH 没有安全的隐藏
		// 机制（归档会让助手哑掉、subagent 标记会让会话连不上），所以需求 ①
		// 的落点是"可见但一眼可辨"。把标注名显示在这里，用户对得上侧边栏里
		// 那一条到底是哪来的。
		row(
			"常驻会话标注",
			controller.config.session?.label === ""
				? "未设置（用自动标题）"
				: `${controller.config.session?.label ?? "小凤 · 常驻助手"}（侧边栏可见）`,
		),
		// 全局记忆：注册在根作用域的 prompt 段，对 DSH 全部会话生效。
		row(
			"全局记忆",
			controller.config.memory?.active === true
				? "已生效（对全部会话）"
				: controller.config.memory?.global === true
					? "已开启但未生效（正文为空或服务不可用）"
					: "未开启",
		),
		// 提问应答：**只做「模型提问」，不碰「工具审批」**。
		//   * 关闭 → 连旁听都不做（不念问题）
		//   * 已接入 → 显示当前是否正等作答
		//
		// 为什么把"工具审批不做"写进界面：用户会以为"语音助手能审批"，
		// 结果发现喊"允许"没用。提前说清楚比事后解释便宜。
		//
		// **范围说明必须任何时候都在**：早先只在"空闲"分支带这句，于是
		// 一进入待答态就消失了 —— 而那正是用户最可能对着屏幕喊"允许"的
		// 时刻（真机冒烟就是这么抓出来的）。所以拆成"状态 + 恒定范围"。
		row(
			"语音应答",
			`${questionSummary(controller)}（只答模型提问，工具审批请在界面操作）`,
		),
		// 会话切换区。**以组件形式渲染**（`h(SessionsSection, …)`）而不是
		// 调用 `renderSessions(...)` —— 后者会在 renderPanel 的调用栈里
		// 执行它的 useState，React 会直接抛 error #310 把浮层槽打崩。
		// 详见 SessionsSection 的注释。
		h(SessionsSection, { controller, snapshot }),
		row("语音会话", snapshot.sessionId === null ? "尚未创建" : String(snapshot.sessionId).slice(0, 8)),
		snapshot.error !== "" ? row("最近错误", snapshot.error) : null,
		h(
			"div",
			{ className: "xfv-actions" },
			h(
				"button",
				{
					type: "button",
					className: "xfv-btn",
					"data-primary": "true",
					onClick: () => (snapshot.status === STATES.OFF ? controller.start() : controller.wake()),
				},
				snapshot.status === STATES.OFF ? "启用语音" : "唤醒",
			),
			h(
				"button",
				{
					type: "button",
					className: "xfv-btn",
					onClick: () => controller.say("你好，我是小凤。语音链路正常。"),
				},
				"试听",
			),
			h(
				"button",
				{
					type: "button",
					className: "xfv-btn",
					onClick: () => controller.sleep(),
					disabled: snapshot.status === STATES.SLEEPING || snapshot.status === STATES.OFF,
				},
				"休眠",
			),
			h(
				"button",
				{
					type: "button",
					className: "xfv-btn",
					onClick: () => controller.stop(),
					disabled: snapshot.status === STATES.OFF,
				},
				"停用",
			),
		),
		snapshot.history.length > 0
			? h(
					"div",
					{ className: "xfv-history" },
					snapshot.history.map((item, index) =>
						h(
							"div",
							{ className: "xfv-history-item", key: `${item.time}-${index}` },
							h("b", null, item.role === "user" ? "你说：" : "小凤："),
							item.text.length > 60 ? `${item.text.slice(0, 60)}…` : item.text,
						),
					),
				)
			: null,
		h(
			"div",
			{ className: "xfv-hint" },
			"快捷键 ",
			h("span", { className: "xfv-kbd" }, "Alt"),
			" + ",
			h("span", { className: "xfv-kbd" }, "Shift"),
			" + ",
			h("span", { className: "xfv-kbd" }, "V"),
			" 唤醒 / 休眠。长按语音球打开此面板。",
		),
	);
}

/**
 * 一行键值。
 * @param key - 左侧说明。
 * @param value - 右侧值。
 */
function row(key, value) {
	return h("div", { className: "xfv-row" }, h("span", { className: "k" }, key), h("span", { className: "v" }, value));
}

/**
 * 面板里"语音应答"那一行的状态短语（不含范围说明）。
 *
 * 三种状态必须分得清，而且措辞要**如实**：
 *   - 有 `continued` 问题 → 能语音答，说"可以直接说答案"；
 *   - 有 `open` 问题 → 界面还能答，语音插不进去（DSH 的 `answer()`
 *     只收 `continued`），说"我念给您听"；
 *   - 没问题 → 报"已接入"或"未接入"。
 *
 * ⚠️ 措辞不要说"未接入（该会话无提问投影）"这种**把实现细节当结论**的话：
 * 投影为空在本机默认配置（legacy）下是**正常**的，而播报走的是事件流，
 * 与投影无关。说成"没接入"会让用户以为功能坏了。
 *
 * @param controller - 语音控制器。
 * @returns 状态短语。
 */
function questionSummary(controller) {
	const current = controller.getSnapshot().question;
	if (current !== null && current !== undefined) {
		return current.state === "continued" ? "正等您作答，可以直接说答案" : "问题在界面上，我念给您听";
	}
	// 桥是否绑过会话（播报不依赖它，但能反映"会话就绪了没有"）。
	const bound = controller.questions?.sessionId !== null && controller.questions?.sessionId !== undefined;
	return bound ? "已接入，暂无待答问题" : "等会话就绪后开始旁听";
}
