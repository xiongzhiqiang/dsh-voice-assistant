/**
 * 真浏览器验证 V2.4：会话状态机 / 任务命名 / 面板防溢出 / 桌宠放大。
 *
 * ## 为什么宿主侧冒烟过了还要再跑一遍
 *
 * `tools/smoke-sessions-http.mjs` 证的是**接口层**（状态写入口、落点判定、
 * 唯一活跃）。它碰不到三类只有浏览器里才存在的东西：
 *
 *   1. **面板的三颗状态按钮真的可点、点完真的改状态** —— React 的事件绑定、
 *      `controller.setExpertSessionStatus` 的接线，只有真 DOM 才能验；
 *      这类"模块对但没接上"的故障本项目栽过（见 expert-commands 的注释）；
 *   2. **面板防溢出（需求①）** —— `max-height` + `sticky` 是**布局事实**，
 *      只能用 `getBoundingClientRect` 判：面板顶边必须在视口内、关闭按钮
 *      必须被点在命中区内；
 *   3. **桌宠放大（需求②）** —— `.xfv-expert-figure` 的实际渲染尺寸。
 *
 * ## 为什么用「语音命令」而不是直接调 runtime API 改状态
 *
 * 直接调 `setSessionStatus()` 只证明 HTTP 层；用户真实入口是**说话**。
 * 所以状态切换走 `__xfvDebug.ask()`（真实 runCommand → 润色**前**命令拦截
 * → 执行 → 播报），并断言 `snapshot.heard` 是润色前原文（证明拦截生效）
 * 与宿主侧状态真的变了。这正是"语音助手语音控制"（需求④原话）那条路。
 *
 * ## 收尾必须还原
 *
 * 跑在用户的**真实 DSH** 上。所有改动（改状态、开会话、改名）都在
 * `finally` 里按"记下来的原值"还原；新建的会话关掉。
 *
 * 用法：`node tools/cdp-session-status-probe.mjs <url>`
 * `url` 形如 `http://127.0.0.1:3080/?token=<token>`。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9345;
const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = "http://127.0.0.1:3080";
const API = "/plugins/dsh-voice-assistant/api";

/** 取常驻实例 token（只用于请求，绝不打印）。 */
function readToken() {
	if (typeof process.env.DSH_TOKEN === "string" && process.env.DSH_TOKEN !== "") return process.env.DSH_TOKEN;
	const statePath = join(HERE, "_dsh-serve.json");
	if (!existsSync(statePath)) return "";
	try {
		return JSON.parse(readFileSync(statePath, "utf8"))?.token ?? "";
	} catch {
		return "";
	}
}

/**
 * 拼浏览器地址。
 *
 * 有显式 URL 就用它（保持与其它 CDP 探针一致的调用方式）；否则用 token
 * 拼一个 —— 缺 token 时**必须早退**，因为 `GET /?token=` 是 303 + Set-Cookie，
 * 不带 token 打开只是个 401 页，探针会一路"元素找不到"而看不出根因。
 */
const first = process.argv[2];
const token = readToken();
const url = typeof first === "string" && /^https?:\/\//i.test(first)
	? first
	: token !== ""
		? `${BASE}/?token=${encodeURIComponent(token)}`
		: undefined;
if (url === undefined) {
	console.error("用法: node tools/cdp-session-status-probe.mjs <url>（或先启动 tools/serve-dsh.mjs 提供 token）");
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail) => {
	const pass = Boolean(ok);
	if (!pass) failures.push({ name, detail });
	console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || detail === undefined ? "" : ` → ${detail}`}`);
};

/** 直接打宿主 API（用于独立核对浏览器那边到底改没改成功）。 */
async function api(path, options = {}) {
	const response = await fetch(`${BASE}${API}${path}`, {
		method: options.method ?? "GET",
		headers: {
			cookie: `dsh_token=${token}`,
			...(options.body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		signal: AbortSignal.timeout(15000),
	});
	return response.json();
}

const profileDir = mkdtempSync(join(tmpdir(), "dsh-sessstatus-"));
const chrome = spawn(CHROME, [
	"--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
	"--disable-extensions", "--window-size=1280,720",
	`--user-data-dir=${profileDir}`, `--remote-debugging-port=${PORT}`, "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
	for (let i = 0; i < 60; i += 1) {
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) });
			const list = await r.json();
			const page = list.find((x) => x.type === "page");
			if (page !== undefined) return page;
		} catch { /* 端口未起 */ }
		await sleep(200);
	}
	throw new Error("Chrome 调试端口未就绪");
}

/** 收尾要还原的原值（在浏览器里读，改完按它写回）。 */
let WORKER = "";
let originalActiveSid = "";
let touchedSid = "";
let originalTouchedStatus = "";
let originalLabel = "";
let socket;
const errors = [];

try {
	const page = await target();
	socket = new WebSocket(page.webSocketDebuggerUrl);
	const pending = new Map();
	let nextId = 1;
	function send(method, params = {}) {
		const id = nextId;
		nextId += 1;
		socket.send(JSON.stringify({ id, method, params }));
		return new Promise((resolve) => pending.set(id, resolve));
	}
	socket.addEventListener("message", (e) => {
		const m = JSON.parse(e.data);
		if (m.id !== undefined) { pending.get(m.id)?.(m.result ?? m.error); pending.delete(m.id); return; }
		if (m.method === "Runtime.exceptionThrown") {
			errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
		}
		if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
			errors.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
		}
	});
	await new Promise((r) => socket.addEventListener("open", r, { once: true }));
	await send("Runtime.enable");
	await send("Page.enable");
	console.log(`导航到 ${url.replace(/token=[^&]+/, "token=***")}`);
	await send("Page.navigate", { url });

	const evaluate = async (expression) => {
		const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
		if (r?.exceptionDetails !== undefined) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate 抛错");
		const value = r?.result?.value;
		// 页面里统一 `JSON.stringify(...)` 回传（对象跨 CDP 只能这么带），
		// 所以这里统一 parse 回来 —— 否则拿到的是一串 JSON 文本，
		// `layout.top` 全是 undefined（本探针第一次跑就踩了）。
		if (typeof value !== "string") return value;
		try { return JSON.parse(value); } catch { return value; }
	};

	// 等插件浮层挂上（异步激活 + overlay 槽注入 + bundle 加载）。
	let ready = false;
	for (let i = 0; i < 80; i += 1) {
		ready = (await evaluate(`document.querySelector('.xfv-orb') !== null`)) === true;
		if (ready) break;
		await sleep(500);
	}
	check("语音球浮层已挂载（bundle 加载成功）", ready, ready ? "" : "等待超时 —— 可能是白屏，先跑 npm run check:bundle");
	if (!ready) throw new Error("overlay-not-mounted");

	// ── 0. 挑一位专家（自适应，不硬编码）───────────────────────────────
	const cfg = await api("/config");
	const roster = (cfg?.routing?.workers ?? []).filter((w) => w.id !== "general");
	check("配置里有可用专家", roster.length >= 1, `count=${roster.length}`);
	if (roster.length === 0) throw new Error("no-worker");
	const list0 = await api("/sessions");
	// 挑会话最多的那位：状态测试要有可切换的余地，也更接近"用户真在用"的形态。
	const withSessions = roster
		.map((w) => ({ worker: w, view: list0?.sessions?.[w.id] }))
		.filter((row) => Array.isArray(row.view?.sessions) && row.view.sessions.length > 0);
	check("至少有一位带会话的专家", withSessions.length >= 1, `roster=${roster.map((w) => w.id).join(",")}`);
	if (withSessions.length === 0) throw new Error("no-worker-with-session");
	const picked = withSessions.slice().sort((a, b) => b.view.sessions.length - a.view.sessions.length)[0];
	WORKER = picked.worker.id;
	const workerLabel = String(picked.worker.label ?? WORKER);
	originalActiveSid = picked.view.activeSessionId ?? "";
	console.log(`      （本次测试用专家：${WORKER} / ${workerLabel}，会话 ${picked.view.sessions.length} 个）`);

	// ── 1. 需求①：面板防溢出（布局事实，只能靠 getBoundingClientRect）──
	// 先把面板撑到最长：展开会话列表（内容最多的那一段）。
	await evaluate(`(() => { const orb = document.querySelector('.xfv-orb'); orb.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return true; })()`);
	await sleep(700);
	const panelOpen = await evaluate(`document.querySelector('.xfv-panel') !== null`);
	check("长按/右键能打开设置面板", panelOpen === true, String(panelOpen));
	if (!panelOpen) throw new Error("panel-not-open");

	// 展开「管理专家会话…」——把面板内容加到最多。
	await evaluate(`JSON.stringify((() => {
		const btn = [...document.querySelectorAll('.xfv-panel .xfv-btn')].find((b) => (b.textContent ?? '').includes('管理专家会话'));
		if (!btn) return { clicked: false };
		btn.click();
		return { clicked: true };
	})())`);
	await sleep(2500);

	const layout = await evaluate(`JSON.stringify((() => {
		const panel = document.querySelector('.xfv-panel');
		if (!panel) return { error: 'no-panel' };
		const r = panel.getBoundingClientRect();
		const close = panel.querySelector('.xfv-close');
		const cr = close ? close.getBoundingClientRect() : null;
		const vh = window.innerHeight;
		// 命中测试：关闭按钮中心点上"最顶层"的元素是不是它自己（或其后代）。
		let hit = null;
		if (cr) {
			const el = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
			hit = el === close || close.contains(el);
		}
		return {
			top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height),
			viewportH: vh,
			scrollH: panel.scrollHeight, clientH: panel.clientHeight,
			scrollable: panel.scrollHeight > panel.clientHeight + 1,
			close: cr ? { top: Math.round(cr.top), bottom: Math.round(cr.bottom), w: Math.round(cr.width), h: Math.round(cr.height) } : null,
			closeHit: hit,
			rows: panel.querySelectorAll('[data-xfv="session-row"]').length,
		};
	})())`);
	console.log(`      面板：top=${layout.top} bottom=${layout.bottom} h=${layout.height} / 视口 ${layout.viewportH}，会话行 ${layout.rows}`);

	check("面板顶边在视口内（需求①：不再顶出屏幕）", typeof layout.top === "number" && layout.top >= 0, `top=${layout.top}`);
	check("面板底边在视口内", typeof layout.bottom === "number" && layout.bottom <= layout.viewportH + 1, `bottom=${layout.bottom} vh=${layout.viewportH}`);
	check("面板自身不超出视口高度", layout.height <= layout.viewportH, `h=${layout.height} vh=${layout.viewportH}`);
	check("关闭按钮在视口内（需求①的关键：点得到）", layout.close !== null && layout.close.top >= 0 && layout.close.bottom <= layout.viewportH, JSON.stringify(layout.close));
	check("关闭按钮确实可被命中（不是被别的元素盖住）", layout.closeHit === true, JSON.stringify(layout.closeHit));
	// 金标准：超高时必须是**面板内部**滚动（sticky 标题栏才治本）。
	check(
		"内容超高时面板内部可滚动（而非整体溢出）",
		layout.scrollH <= layout.clientH + 1 || layout.scrollable === true,
		`scrollH=${layout.scrollH} clientH=${layout.clientH}`,
	);

	// 直接点关闭按钮（真 DOM 点击，不是调 React 回调）：证明"点得动"。
	await evaluate(`(() => { const b = document.querySelector('.xfv-panel .xfv-close'); b.click(); return true; })()`);
	await sleep(500);
	const closed = await evaluate(`document.querySelector('.xfv-panel') === null`);
	check("点关闭按钮真的关掉了面板", closed === true, String(closed));
	// 再打开（后面按钮测试要用）。
	await evaluate(`(() => { const orb = document.querySelector('.xfv-orb'); orb.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return true; })()`);
	await sleep(600);

	// ── 2. 需求②：桌宠放大一倍 ──────────────────────────────────────────
	// 桌宠只在专家 busy 时才渲染（V1.9 空闲隐藏），所以先派一单让它冒出来。
	// 任务刻意极短（只回两个字），把真实 token 消耗压到最小。
	const activeSessions = (await api("/health"))?.delegation?.activeSessions ?? {};
	const pinnedSid = typeof activeSessions[WORKER] === "string" ? activeSessions[WORKER] : originalActiveSid;
	const delegated = await api("/delegate", {
		method: "POST",
		body: { worker: WORKER, task: "只回复两个字：收到", ...(pinnedSid === "" ? {} : { sessionId: pinnedSid }) },
	});
	check("派单成功（桌宠联动前置）", delegated?.ok === true, JSON.stringify(delegated));
	let figure = null;
	for (let i = 0; i < 20; i += 1) {
		await sleep(600);
		figure = await evaluate(`JSON.stringify((() => {
			const card = document.querySelector('[data-xfv="expert-${WORKER}"]');
			if (!card) return null;
			const fig = card.querySelector('.xfv-expert-figure');
			if (!fig) return null;
			const img = fig.querySelector('.xfv-expert-img');
			// 用 offsetWidth/Height（**布局尺寸**）而不是 getBoundingClientRect：
			// busy 时 figure 上挂着 xfv-expert-work 动画，含 rotate(±1deg)，
			// 轴对齐包围盒会被转大（128 的正方形转 1° → 约 130px），
			// 拿它断言尺寸等于在测动画相位，不是测需求②。
			return {
				w: fig.offsetWidth, h: fig.offsetHeight,
				cardH: card.offsetHeight, cardW: card.offsetWidth,
				hasImg: img !== null, natW: img?.naturalWidth ?? 0,
				busy: card.getAttribute('data-busy'),
			};
		})())`);
		if (figure && figure.w > 0) break;
	}
	check("专家桌宠渲染出来了（busy 时冒泡）", figure !== null && figure.w > 0, JSON.stringify(figure));
	// 需求②：尺寸翻倍。原值 64×64 → 现 128×128。
	//
	// 分两层断言，别把两者混起来（第一版探针就混了 → 误报）：
	//   * `.xfv-expert-figure` = **形象本体**，正方形 128×128；
	//   * `EXPERT_SIZE.h = 152` = **整卡**高度（128 形象 + 名字行 ≈ 149，取 152
	//     留容差），用于拖拽边界收敛。所以整卡高度要单独查、允许 ±8px 抖动
	//     （字体行高在不同机器上会有小差）。
	check("桌宠形象本体是放大后的 128×128（需求②）", figure?.w === 128 && figure?.h === 128, `${figure?.w}×${figure?.h}`);
	check("桌宠整卡宽度与 EXPERT_SIZE.w 一致", figure?.cardW === 128, `cardW=${figure?.cardW}`);
	check(
		"桌宠整卡高度贴近 EXPERT_SIZE.h（含名字行）",
		typeof figure?.cardH === "number" && Math.abs(figure.cardH - 152) <= 8,
		`cardH=${figure?.cardH} 期望≈152`,
	);
	check("桌宠形象图加载成功", figure?.hasImg === true && figure?.natW > 0, JSON.stringify(figure));

	// ── 3. 需求④：语音命令改会话状态（用户操作入口之一）────────────────
	// 展开会话列表：语音命令按**序号**定位，序号来自这个列表的顺序。
	await evaluate(`JSON.stringify((() => {
		const btn = [...document.querySelectorAll('.xfv-panel .xfv-btn')].find((b) => (b.textContent ?? '').includes('管理专家会话'));
		if (btn && !btn.textContent.includes('收起')) btn.click();
		return { ok: true };
	})())`);
	await sleep(2500);

	const rows = await evaluate(`JSON.stringify([...document.querySelectorAll('[data-xfv="session-group"]')].map((g) => ({
		worker: g.getAttribute('data-worker'),
		rows: [...g.querySelectorAll('[data-xfv="session-row"]')].map((r) => ({
			sid: r.getAttribute('data-session-id'),
			status: r.getAttribute('data-status'),
			label: r.querySelector('.label')?.textContent ?? '',
		})),
	})))`);
	const group = (rows ?? []).find((g) => g.worker === WORKER);
	check("面板渲染出了该专家的会话行", (group?.rows?.length ?? 0) > 0, JSON.stringify(rows?.map((g) => g.worker)));
	check("每行都带 status 标记（需求④：状态可见）", (group?.rows ?? []).every((r) => ["active", "suspended", "finished"].includes(r.status)), JSON.stringify(group?.rows?.map((r) => r.status)));
	// 按**每个会话行**统计按钮数 —— 不能写 `[data-xfv="session-row"]:first-child`：
	// session-row 在组内的第一个子元素是 `.name` 标题行，所以 `:first-child`
	// 一条都匹配不到（第一次跑就是这样误报 0 的）。
	const btnCounts = await evaluate(`JSON.stringify([...document.querySelectorAll('[data-xfv="session-row"]')].map((r) => r.querySelectorAll('[data-xfv="session-pick"]').length))`);
	check("三颗状态按钮渲染出来了", (btnCounts ?? []).length >= 3, JSON.stringify(btnCounts));
	check("每个会话行恰好三颗按钮（活跃/挂起/完结）", (btnCounts ?? []).every((n) => n === 3), JSON.stringify(btnCounts));
	// 高亮唯一性：**每行内部**恰有一颗 data-on。全库统计会得到"行数 × 1"，
	// 与行数比较必然不等（第一次跑就是这样误报 8/3 的）。
	const onPerRow = await evaluate(`JSON.stringify([...document.querySelectorAll('[data-xfv="session-row"]')].map((r) => r.querySelectorAll('[data-xfv="session-pick"][data-on="true"]').length))`);
	check("每行恰有一颗按钮高亮为当前状态", (onPerRow ?? []).length > 0 && (onPerRow ?? []).every((n) => n === 1), JSON.stringify(onPerRow));

	// 3a. **点按钮**改状态：找一行不是"挂起"的，把它挂起。
	const targetRow = group.rows.find((r) => r.status !== "suspended") ?? group.rows[0];
	touchedSid = targetRow.sid;
	originalTouchedStatus = targetRow.status;
	const clicked = await evaluate(`JSON.stringify((() => {
		const row = document.querySelector('[data-xfv="session-row"][data-session-id="${touchedSid}"]');
		if (!row) return { error: 'row-not-found' };
		const btn = row.querySelector('[data-xfv="session-pick"][data-status-pick="suspended"]');
		if (!btn) return { error: 'btn-not-found' };
		btn.click();
		return { clicked: true };
	})())`);
	check("找到并点了「挂起」按钮", clicked?.clicked === true, JSON.stringify(clicked));
	await sleep(2500);
	const afterClick = (await api(`/sessions/${WORKER}`))?.sessions?.[WORKER];
	check(
		"点按钮真的改了宿主状态（挂起）",
		afterClick?.sessions?.find((s) => s.sessionId === touchedSid)?.status === "suspended",
		JSON.stringify(afterClick?.sessions?.find((s) => s.sessionId === touchedSid)?.status),
	);
	const onMoved = await evaluate(`(() => { const row = document.querySelector('[data-xfv="session-row"][data-session-id="${touchedSid}"]'); return row?.querySelector('[data-xfv="session-pick"][data-on="true"]')?.getAttribute('data-status-pick') ?? ''; })()`);
	check("面板高亮跟着搬到了「挂起」", onMoved === "suspended", String(onMoved));

	// 3b. **语音命令**改状态：走真实 ask（润色前命令拦截 → 执行 → 播报）。
	await evaluate(`(async()=>{ const s=globalThis.__xfvDebug.snapshot(); if(s.status==='off') globalThis.__xfvDebug.start?.(); else if(s.status==='standby'||s.status==='sleeping') globalThis.__xfvDebug.wake(); return true; })()`);
	await sleep(600);
	// 序号按列表顺序（1-based）——从面板里读回来，保证与用户看到的一致。
	const idx = group.rows.findIndex((r) => r.sid === touchedSid) + 1;
	check("定位到目标行序号", idx >= 1, `idx=${idx}`);
	const spoken = `${workerLabel.split(/\s*[·・]\s*/)[0]}的会话${idx}设为活跃`;
	const snapRaw = await evaluate(`(async()=>{ await globalThis.__xfvDebug.ask(${JSON.stringify(spoken)}); return JSON.stringify(globalThis.__xfvDebug.snapshot?.() ?? {}); })()`);
	const snap = snapRaw !== null && typeof snapRaw === "object" ? snapRaw : {};
	check("语音命令被拦截为会话命令（heard 是润色前原文）", (snap.heard ?? "") === spoken, snap.heard);
	check("语音命令给出了播报文案", typeof snap.answer === "string" && snap.answer !== "", String(snap.answer));
	await sleep(1500);
	const afterVoice = (await api(`/sessions/${WORKER}`))?.sessions?.[WORKER];
	check(
		"语音命令真的改了宿主状态（活跃）",
		afterVoice?.sessions?.find((s) => s.sessionId === touchedSid)?.status === "active",
		JSON.stringify({ 状态: afterVoice?.sessions?.find((s) => s.sessionId === touchedSid)?.status, 播报: snap.answer }),
	);
	check("播报文案说明了结果", /已(把|改|设)|活跃/.test(String(snap.answer)), String(snap.answer));
	// 唯一活跃不变式：这一刻全库只能有一个 active。
	check(
		"改完仍只有一个活跃会话（需求④）",
		(afterVoice?.sessions ?? []).filter((s) => s.status === "active").length === 1,
		JSON.stringify((afterVoice?.sessions ?? []).map((s) => s.status)),
	);
	check("活跃指针指向它", afterVoice?.activeSessionId === touchedSid, String(afterVoice?.activeSessionId));

	// ── 4. 需求③：手动改名的接口在浏览器侧真的可调 ─────────────────────
	//
	// 改名没有语音入口（用户原话只要求"新开会话按任务名命名"），面板上
	// 也还没做改名控件 —— 所以这里验的是**接口可达 + 落盘**。之所以放在
	// 浏览器探针里而不是纯 HTTP 冒烟：这条路径用的是浏览器那份 token/cookie，
	// 能顺带证明"页面拿到的凭据对这些新接口同样有效"。
	const curLabel = (afterVoice?.sessions ?? []).find((s) => s.sessionId === touchedSid)?.label ?? "";
	originalLabel = curLabel;
	const renameResult = await api(`/sessions/${encodeURIComponent(WORKER)}/rename`, {
		method: "POST",
		body: { sessionId: touchedSid, label: `${curLabel}·探针` },
	}).catch((error) => ({ ok: false, error: String(error) }));
	check("改名接口成功", renameResult?.ok === true, JSON.stringify(renameResult));
	const afterRename = (await api(`/sessions/${WORKER}`))?.sessions?.[WORKER];
	check(
		"改名已落盘",
		String((afterRename?.sessions ?? []).find((s) => s.sessionId === touchedSid)?.label ?? "").endsWith("·探针"),
		String((afterRename?.sessions ?? []).find((s) => s.sessionId === touchedSid)?.label),
	);

	// ── 5. 控制台必须干净 ──────────────────────────────────────────────
	// 排除与插件无关的资源噪声（favicon / 401 首页探测）。
	const relevant = errors.filter((e) => /xfv|voice|小凤|session|专家/i.test(String(e))
		&& !/favicon|401|Unauthorized|Failed to load resource/i.test(String(e)));
	check("无插件相关 JS 异常", relevant.length === 0, relevant.slice(0, 3).join(" | "));
} catch (error) {
	failures.push({ name: "真机客户端探针异常", detail: String(error?.stack ?? error) });
	console.error(error);
} finally {
	// 还原用户的真实状态：把探针改过的标签与状态写回原值。
	// （本探针**不新建会话** —— 需求④ 的自动新开会话由 smoke-sessions-http.mjs
	// 覆盖，那条会新建，所以那边收尾要删；这里只动既有会话。）
	try {
		if (touchedSid !== "" && token !== "") {
			const view = (await api(`/sessions/${WORKER}`))?.sessions?.[WORKER];
			const row = (view?.sessions ?? []).find((s) => s.sessionId === touchedSid);
			if (row && originalLabel !== "" && String(row.label).endsWith("·探针")) {
				await api(`/sessions/${WORKER}/rename`, { method: "POST", body: { sessionId: touchedSid, label: originalLabel } });
			}
			// 状态还原：先看它现在是什么，再决定要不要写回（避免无谓写入）。
			const now = (await api(`/sessions/${WORKER}`))?.sessions?.[WORKER];
			const cur = (now?.sessions ?? []).find((s) => s.sessionId === touchedSid);
			if (cur && originalTouchedStatus !== "" && cur.status !== originalTouchedStatus) {
				await api(`/sessions/${WORKER}/status`, { method: "POST", body: { sessionId: touchedSid, status: originalTouchedStatus } });
			}
			// 状态还原可能把"活跃"给了另一条，确保用户的原始活跃指针回到原位。
			if (originalActiveSid !== "") {
				const final = (await api(`/sessions/${WORKER}`))?.sessions?.[WORKER];
				if (final?.activeSessionId !== originalActiveSid
					&& (final?.sessions ?? []).some((s) => s.sessionId === originalActiveSid && s.status !== "finished")) {
					await api(`/sessions/${WORKER}/status`, { method: "POST", body: { sessionId: originalActiveSid, status: "active" } });
				}
			}
		}
	} catch { /* 还原失败不影响测试结论 */ }
	try { socket?.close(); } catch { /* ignore */ }
	try { chrome.kill(); } catch { /* ignore */ }
}

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	for (const failure of failures) console.error(`  - ${failure.name}: ${failure.detail ?? ""}`);
	process.exit(1);
}
console.log("\nV2.4 真浏览器会话状态机 / 面板防溢出 / 桌宠尺寸验证通过");
