/**
 * 浮层样式（注入 `<style>`，不依赖任何外部 CSS）。
 *
 * ## 为什么要自己写一套而不是套 DSH 的令牌
 *
 * 语音球挂在 `shell.overlay` 上，需要**悬浮在整个应用之上**：层级、阴影、
 * 毛玻璃、动画都得自己控。官方 `--dsw-alias-*` 令牌是给文档型界面用的，
 * 拿来做浮层会出现"浅色主题下球体透明到看不见"这类问题。
 *
 * 只借用一个东西：`--xfv-accent` 由配置传入，其余全部自带，
 * 并跟随 `prefers-color-scheme` 切换深浅 —— 浮层不跟随页面主题，
 * 是因为浮层是"画外"的，跟着系统走更稳定。
 */

/** 样式表 id（重复注入时先删旧的，避免 HMR 叠出多份）。 */
const STYLE_ID = "xfv-style";

/**
 * 生成样式文本。
 * @param accent - 强调色（六位十六进制）。
 * @returns CSS 文本。
 */
function css(accent) {
	return `
.xfv-root {
	--xfv-accent: ${accent};
	--xfv-ink: #171a21;
	--xfv-sub: #5b6472;
	--xfv-surface: rgba(255, 255, 255, 0.94);
	--xfv-border: rgba(16, 24, 40, 0.10);
	--xfv-shadow: 0 10px 30px rgba(16, 24, 40, 0.16), 0 2px 6px rgba(16, 24, 40, 0.08);
	position: fixed;
	/* 贴底放，但横向让出右下角：那一带被「🧠 Memory」胶囊（约 135px 宽）和
	   输入卡的发送按钮占着 —— 22px 时球被胶囊盖住，84px 时球压住发送键。
	   右移 170px 后正好落在卡片下方的空白条里，三者互不遮挡。 */
	bottom: 18px;
	right: 170px;
	z-index: 2147483000;
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	gap: 10px;
	font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif;
	color: var(--xfv-ink);
	pointer-events: none;
}
.xfv-root[data-position="bottom-left"] { left: 22px; right: auto; align-items: flex-start; }
.xfv-root[data-position="bottom-center"] { left: 50%; right: auto; transform: translateX(-50%); align-items: center; }

@media (prefers-color-scheme: dark) {
	.xfv-root {
		--xfv-ink: #eef1f6;
		--xfv-sub: #a4adbb;
		--xfv-surface: rgba(28, 32, 40, 0.94);
		--xfv-border: rgba(255, 255, 255, 0.12);
		--xfv-shadow: 0 12px 34px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.4);
	}
}

/* ── 语音球 ─────────────────────────────────────────────────────── */
.xfv-orb {
	pointer-events: auto;
	position: relative;
	width: 58px;
	height: 58px;
	border-radius: 50%;
	border: 1px solid var(--xfv-border);
	background: var(--xfv-surface);
	box-shadow: var(--xfv-shadow);
	display: grid;
	place-items: center;
	cursor: pointer;
	transition: transform 160ms ease, box-shadow 160ms ease;
	-webkit-user-select: none;
	user-select: none;
	padding: 0;
	color: inherit;
}
.xfv-orb:hover { transform: translateY(-1px) scale(1.03); }
.xfv-orb:active { transform: scale(0.97); }
.xfv-orb:focus-visible { outline: 2px solid var(--xfv-accent); outline-offset: 3px; }

.xfv-glyph { width: 24px; height: 24px; display: block; }
.xfv-glyph path, .xkv-glyph line { stroke: var(--xfv-accent); }

/* V1.6：拟人化音球形象。铺满球体，随状态轻微起伏。 */
.xfv-orb-face {
	width: 100%;
	height: 100%;
	object-fit: contain;
	display: block;
	pointer-events: none;
	user-select: none;
	-webkit-user-drag: none;
	filter: drop-shadow(0 2px 5px rgba(47, 107, 255, 0.28));
	transition: transform 220ms ease;
}
.xfv-orb:hover .xfv-orb-face { transform: translateY(-1px) scale(1.04); }
.xfv-root[data-status="speaking"] .xfv-orb-face { animation: xfv-bob 1.1s ease-in-out infinite; }
.xfv-root[data-status="thinking"] .xfv-orb-face { animation: xfv-bob 1.8s ease-in-out infinite; }
@keyframes xfv-bob {
	0%, 100% { transform: translateY(0) scale(1); }
	50%      { transform: translateY(-3px) scale(1.03); }
}

/* 状态指示灯：球体右下角的小点 */
.xfv-dot {
	position: absolute;
	right: 3px;
	bottom: 3px;
	width: 12px;
	height: 12px;
	border-radius: 50%;
	border: 2px solid var(--xfv-surface);
	background: #98a2b3;
	transition: background 200ms ease;
}
.xfv-root[data-status="standby"] .xfv-dot { background: #12b76a; }
.xfv-root[data-status="active"] .xfv-dot { background: var(--xfv-accent); }
.xfv-root[data-status="thinking"] .xfv-dot { background: #f79009; }
.xfv-root[data-status="speaking"] .xfv-dot { background: #7a5af8; }
.xfv-root[data-status="sleeping"] .xfv-dot { background: #667085; }

/* 呼吸环：仅在"正在听"和"播报中"出现，给一个不刺眼的活动感 */
.xfv-halo {
	position: absolute;
	inset: -6px;
	border-radius: 50%;
	border: 2px solid var(--xfv-accent);
	opacity: 0;
	pointer-events: none;
}
.xfv-root[data-status="active"] .xfv-halo { animation: xfv-breathe 1.8s ease-out infinite; }
.xfv-root[data-status="speaking"] .xfv-halo { animation: xfv-breathe 1.4s ease-out infinite; border-color: #7a5af8; }

@keyframes xfv-breathe {
	0%   { opacity: 0.55; transform: scale(0.92); }
	70%  { opacity: 0;    transform: scale(1.18); }
	100% { opacity: 0;    transform: scale(1.18); }
}

/* ── 字幕气泡 ────────────────────────────────────────────────────── */
.xfv-bubble {
	pointer-events: none;
	max-width: 340px;
	padding: 8px 12px;
	border-radius: 12px;
	background: var(--xfv-surface);
	border: 1px solid var(--xfv-border);
	box-shadow: 0 6px 18px rgba(16, 24, 40, 0.12);
	font-size: 13px;
	line-height: 1.5;
	color: var(--xfv-ink);
	white-space: pre-wrap;
	word-break: break-word;
	animation: xfv-fade 140ms ease-out;
}
.xfv-bubble[data-kind="warn"] { border-color: #f79009; }
.xfv-bubble[data-kind="error"] { border-color: #f04438; }
.xfv-bubble .xfv-tag {
	display: inline-block;
	font-size: 11px;
	color: var(--xfv-sub);
	margin-right: 6px;
}

@keyframes xfv-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

/* ── 设置面板 ────────────────────────────────────────────────────── */
/*
 * 需求①：面板内容会随版本增长（识别方式、会话列表、互动流…），而
 * `.xfv-root` 是"贴底 flex 列、面板排在音球上方"。面板一高，它的**顶部**
 * 就顶出视口，标题栏与关闭按钮被切掉 —— 用户点不到 × 。
 *
 * 三道闸一起上，缺一不可：
 *   1. `max-height` 用 dvh 且留出音球 + 边距的余量 —— 视觉上永不超屏；
 *   2. `overflow-y: auto` —— 超高时**面板内部**滚动，而不是往外溢；
 *   3. 标题栏 `sticky` 吸顶 —— 滚动时关闭按钮恒定可见（治本的那道）。
 *
 * 用 `dvh` 而不是 `vh`：移动端/带地址栏时 `vh` 会算得比可视区高，
 * 那样"贴着底边"的面板仍会被顶掉一截。
 */
.xfv-panel {
	pointer-events: auto;
	width: 288px;
	max-height: calc(100dvh - 120px);
	overflow-y: auto;
	overscroll-behavior: contain;
	border-radius: 14px;
	background: var(--xfv-surface);
	border: 1px solid var(--xfv-border);
	box-shadow: var(--xfv-shadow);
	padding: 14px;
	font-size: 13px;
	line-height: 1.55;
}
.xfv-panel-head {
	position: sticky;
	top: -14px;
	z-index: 3;
	display: flex;
	align-items: center;
	justify-content: space-between;
	/* 负外边距把吸顶条拉满卡片宽度（抵消 .xfv-panel 的 padding），
	   再用等量 padding 把内容推回来 —— 否则滚动时下面的行会从两侧"漏"出来。 */
	margin: -14px -14px 10px;
	padding: 12px 14px 8px;
	background: var(--xfv-surface);
	border-bottom: 1px solid var(--xfv-border);
	border-radius: 14px 14px 0 0;
}
.xfv-title { font-weight: 600; font-size: 14px; }
.xfv-close {
	border: 0;
	background: transparent;
	color: var(--xfv-sub);
	cursor: pointer;
	font-size: 16px;
	line-height: 1;
	padding: 4px;
	border-radius: 6px;
}
.xfv-close:hover { background: rgba(127, 127, 127, 0.12); }

.xfv-row { display: flex; justify-content: space-between; gap: 10px; padding: 2px 0; }
.xfv-row .k { color: var(--xfv-sub); }
.xfv-row .v { text-align: right; word-break: break-all; }

/* 识别方式 / 语言选择（V2.0）：紧凑一行，标签左、下拉右。 */
.xfv-asr-section {
\tpointer-events: auto;
\tdisplay: flex;
\tflex-direction: column;
\tgap: 4px;
\tpadding: 4px 0 6px;
}
.xfv-asr-row {
\tdisplay: flex;
\talign-items: center;
\tjustify-content: space-between;
\tgap: 10px;
}
.xfv-asr-label { color: var(--xfv-sub); white-space: nowrap; }
.xfv-select {
\tpointer-events: auto;
\tflex: 1;
\tmin-width: 0;
\tmax-width: 170px;
\tborder: 1px solid var(--xfv-border);
\tbackground: var(--xfv-surface);
\tcolor: var(--xfv-ink);
\tborder-radius: 8px;
\tpadding: 4px 6px;
\tfont-size: 12px;
\tcursor: pointer;
\tfont-family: inherit;
}
.xfv-select:hover { border-color: var(--xfv-accent); }

.xfv-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.xfv-btn {
	pointer-events: auto;
	border: 1px solid var(--xfv-border);
	background: transparent;
	color: var(--xfv-ink);
	border-radius: 8px;
	padding: 5px 10px;
	font-size: 12px;
	cursor: pointer;
	font-family: inherit;
}
.xfv-btn:hover { border-color: var(--xfv-accent); color: var(--xfv-accent); }
.xfv-btn[data-primary="true"] {
	background: var(--xfv-accent);
	border-color: var(--xfv-accent);
	color: #fff;
}
.xfv-btn[data-primary="true"]:hover { filter: brightness(1.06); color: #fff; }

.xfv-hint { margin-top: 10px; color: var(--xfv-sub); font-size: 11.5px; line-height: 1.5; }
.xfv-kbd {
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	font-size: 11px;
	border: 1px solid var(--xfv-border);
	border-radius: 4px;
	padding: 0 4px;
	background: rgba(127, 127, 127, 0.10);
}

.xfv-history { margin-top: 10px; border-top: 1px dashed var(--xfv-border); padding-top: 8px; }
.xfv-history-item { color: var(--xfv-sub); font-size: 12px; margin-bottom: 4px; }
.xfv-history-item b { color: var(--xfv-ink); font-weight: 600; }

/* ── 会话切换（跨会话）─────────────────────────────────────────────── */
.xfv-sessions {
	margin-top: 10px;
	border-top: 1px dashed var(--xfv-border);
	padding-top: 8px;
}
.xfv-sessions-head { display: flex; justify-content: space-between; gap: 10px; padding: 2px 0; }
.xfv-sessions-head .k { color: var(--xfv-sub); }
.xfv-sessions-head .v { text-align: right; word-break: break-all; font-weight: 600; }
/* 非常驻模式下把"当前去向"标成强调色：这是最容易搞错的目标信息 */
.xfv-sessions-head .v:not([data-mode="persistent"]) { color: var(--xfv-accent); }

.xfv-session-list {
	max-height: 180px;
	overflow-y: auto;
	margin-top: 6px;
	display: flex;
	flex-direction: column;
	gap: 4px;
}
.xfv-session-item {
	pointer-events: auto;
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 2px;
	text-align: left;
	width: 100%;
	border: 1px solid var(--xfv-border);
	background: transparent;
	color: var(--xfv-ink);
	border-radius: 8px;
	padding: 5px 8px;
	font-size: 12px;
	font-family: inherit;
	cursor: pointer;
}
.xfv-session-item:hover { border-color: var(--xfv-accent); }
.xfv-session-item[data-current="true"] { border-color: var(--xfv-accent); background: rgba(47, 107, 255, 0.08); }
.xfv-session-item .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.xfv-session-item .m { color: var(--xfv-sub); font-size: 11px; }

/* ── 专家桌宠层（V1.9：透明底 + 空闲隐藏 + 单个控制）──────────── */
/*
 * V1.9 关键变化：
 *   - 整层不再有容器定位 / 竖排 row / 整组收起按钮。每张桌宠都是独立 fixed
 *     浮层，位置由 React 内联样式给出（拖拽过用持久位置，否则按可见序号错开）。
 *   - layer 只是个空壳（无样式/无尺寸），保留 data-xfv="experts" 供探针查询。
 *   - 桌宠本体透明底：素材 PNG 自带 alpha，figure 不再刷白卡片背景/边框/阴影，
 *     改用 drop-shadow 勾边，深浅背景下都能看清形象。
 */
.xfv-experts {
	pointer-events: none;
	font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif;
	color: var(--xfv-ink, #171a21);
}

.xfv-expert {
	pointer-events: auto;
	/* position/left/top 由内联样式给出（fixed + 视口绝对坐标），见 drag.js。 */
	width: 128px;
	cursor: grab;
	touch-action: none; /* 触屏拖拽时不要滚页面 */
	user-select: none;
	-webkit-user-select: none;
	/* 入场：从左侧滑入 + 轻微弹跳，只播一次（元素每次忙时重新挂载）。 */
	animation: xfv-expert-enter 520ms cubic-bezier(0.22, 1.2, 0.36, 1) both;
}
.xfv-expert:active { cursor: grabbing; }
@keyframes xfv-expert-enter {
	0%   { opacity: 0; transform: translateX(-26px) scale(0.7); }
	60%  { opacity: 1; transform: translateX(4px) scale(1.06); }
	100% { opacity: 1; transform: translateX(0) scale(1); }
}

/* 透明底：figure 本身无背景/边框，靠 drop-shadow 让形象与背景分离。
   尺寸与 expert-visual.js 的 EXPERT_SIZE 必须同步（拖拽边界收敛读那个值）。 */
.xfv-expert-figure {
	position: relative;
	width: 128px;
	height: 128px;
	overflow: visible;
	filter: drop-shadow(0 3px 6px rgba(16, 24, 40, 0.34));
	transition: filter 180ms ease;
}
.xfv-expert:hover .xfv-expert-figure { filter: drop-shadow(0 5px 10px rgba(16, 24, 40, 0.46)); }
.xfv-expert[data-busy="true"] .xfv-expert-figure {
	animation: xfv-expert-work 1.6s ease-in-out infinite;
	filter: drop-shadow(0 3px 8px rgba(247, 144, 9, 0.5));
}
@keyframes xfv-expert-work {
	0%, 100% { transform: translateY(0) rotate(-1deg); }
	50%      { transform: translateY(-3px) rotate(1deg); }
}
.xfv-expert-img {
	width: 100%;
	height: 100%;
	object-fit: contain;
	display: block;
	pointer-events: none;
	user-select: none;
	-webkit-user-drag: none;
}
.xfv-expert-initial {
	display: grid;
	place-items: center;
	width: 100%;
	height: 100%;
	font-size: 52px;
	font-weight: 700;
	color: var(--xfv-accent, #2f6bff);
}
.xfv-expert-status {
	position: absolute;
	right: 4px;
	bottom: 4px;
	width: 20px;
	height: 20px;
	border-radius: 50%;
	border: 3px solid rgba(255, 255, 255, 0.9);
	background: #12b76a;
	box-shadow: 0 1px 3px rgba(16, 24, 40, 0.3);
}
.xfv-expert[data-busy="true"] .xfv-expert-status { background: #f79009; }
.xfv-expert-name {
	text-align: center;
	font-size: 14px;
	line-height: 1.3;
	margin-top: 3px;
	color: var(--xfv-sub, #5b6472);
	text-shadow: 0 1px 3px rgba(255, 255, 255, 0.95), 0 1px 2px rgba(255, 255, 255, 0.9);
}

/* 单个桌宠的最小化按钮：浮在形象右上角，逐 id 独立控制。 */
.xfv-expert-min {
	position: absolute;
	z-index: 2;
	top: -6px;
	right: -6px;
	width: 28px;
	height: 28px;
	padding: 0;
	border-radius: 50%;
	border: 1px solid var(--xfv-border, rgba(16, 24, 40, 0.12));
	background: var(--xfv-surface, rgba(255, 255, 255, 0.94));
	box-shadow: 0 2px 6px rgba(16, 24, 40, 0.18);
	color: var(--xfv-sub, #5b6472);
	font-size: 15px;
	line-height: 1;
	cursor: pointer;
}
.xfv-expert-min:hover { border-color: var(--xfv-accent, #2f6bff); color: var(--xfv-accent, #2f6bff); }

.xfv-expert-task {
	position: absolute;
	left: calc(100% + 10px);
	top: 0;
	width: 210px;
	padding: 8px 10px;
	border-radius: 10px;
	background: var(--xfv-surface, rgba(255, 255, 255, 0.96));
	border: 1px solid var(--xfv-border, rgba(16, 24, 40, 0.10));
	box-shadow: var(--xfv-shadow, 0 10px 30px rgba(16, 24, 40, 0.16));
	font-size: 12px;
	line-height: 1.5;
	color: var(--xfv-ink, #171a21);
	word-break: break-word;
	animation: xfv-fade 140ms ease-out;
}
.xfv-expert-task b { display: block; margin-bottom: 3px; color: #f79009; }

@media (prefers-color-scheme: dark) {
	.xfv-expert-task { background: rgba(28, 32, 40, 0.94); }
	.xfv-expert-name { color: #a4adbb; text-shadow: 0 1px 3px rgba(0, 0, 0, 0.95), 0 1px 2px rgba(0, 0, 0, 0.8); }
}

/* 减少动效偏好：关掉所有动画，避免前庭不适 */
@media (prefers-reduced-motion: reduce) {
	.xfv-halo, .xfv-bubble, .xfv-orb-face, .xfv-expert, .xfv-expert-figure { animation: none; }
	.xfv-orb, .xfv-orb-face, .xfv-expert-figure { transition: none; }
}
`;
}

/**
 * 注入样式。
 * @param accent - 强调色。
 * @returns 卸载函数。
 */
export function installStyles(accent) {
	if (typeof document === "undefined") return () => {};
	const existing = document.getElementById(STYLE_ID);
	if (existing !== null) existing.remove();
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = css(accent);
	document.head.appendChild(style);
	return () => {
		style.remove();
	};
}
