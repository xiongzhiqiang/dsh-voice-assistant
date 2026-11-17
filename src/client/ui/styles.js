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
.xfv-panel {
	pointer-events: auto;
	width: 288px;
	border-radius: 14px;
	background: var(--xfv-surface);
	border: 1px solid var(--xfv-border);
	box-shadow: var(--xfv-shadow);
	padding: 14px;
	font-size: 13px;
	line-height: 1.55;
}
.xfv-panel-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-bottom: 10px;
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

/* 减少动效偏好：关掉所有动画，避免前庭不适 */
@media (prefers-reduced-motion: reduce) {
	.xfv-halo, .xfv-bubble { animation: none; }
	.xfv-orb { transition: none; }
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
