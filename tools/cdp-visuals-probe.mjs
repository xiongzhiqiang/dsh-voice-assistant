/**
 * 真浏览器验证 V1.6：卡通专家桌宠 + 拟人化可拖拽音球。
 *
 * ## 为什么必须在真浏览器里验
 *
 * 这一层的价值全在"图真的显示出来了、拖完刷新还在"——单测只能证明
 * 纯函数正确，证明不了：素材路由在 DSH 里真能取到、React 组件真挂上了
 * overlay 槽、pointer 事件真被捕获、localStorage 真被写入并读回。
 *
 * 验证项：
 *   1. 语音球 img 加载成功（naturalWidth>0，不是坏图）；
 *   2. 专家桌宠层存在，5 位专家各有 img 且加载成功；
 *   3. 用 CDP 派发真实 pointer 事件拖动音球，位置写入 localStorage；
 *   4. Page.reload 后音球位置从存储读回（样式 left/top 恢复）；
 *   5. 无插件相关的 JS 异常。
 *
 * 用法：`node tools/cdp-visuals-probe.mjs <url>`
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9336;

const first = process.argv[2];
const url =
	typeof first === "string" && /^https?:\/\//i.test(first)
		? first
		: typeof process.env.DSH_TOKEN === "string" && process.env.DSH_TOKEN !== ""
			? `http://127.0.0.1:3080/?token=${process.env.DSH_TOKEN}`
			: undefined;
if (url === undefined) {
	console.error("用法: node tools/cdp-visuals-probe.mjs <url>");
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail) => {
	const pass = Boolean(ok);
	if (!pass) failures.push({ name, detail });
	console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || detail === undefined ? "" : ` → ${detail}`}`);
};

const profileDir = mkdtempSync(join(tmpdir(), "dsh-visuals-"));
const chrome = spawn(CHROME, [
	"--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
	"--disable-extensions", `--user-data-dir=${profileDir}`, `--remote-debugging-port=${PORT}`, "about:blank",
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

const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;
const errors = [];
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

async function evaluate(expression) {
	const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (r?.exceptionDetails !== undefined) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate 抛错");
	const v = r?.result?.value;
	if (typeof v !== "string") return v ?? null;
	try { return JSON.parse(v); } catch { return v; }
}

console.log(`导航到 ${url.replace(/token=[^&]+/, "token=***")}`);
await send("Page.navigate", { url });

// 等浮层出现（插件异步激活 + overlay 槽注入）。
let ready = false;
for (let i = 0; i < 60; i += 1) {
	ready = (await evaluate(`document.querySelector('.xfv-orb') !== null`)) === true;
	if (ready) break;
	await sleep(1000);
}
check("语音球浮层已挂载", ready);

// 1. 音球图片加载
await sleep(800);
const orbImg = await evaluate(`(() => {
  const img = document.querySelector('.xfv-orb .xfv-orb-face');
  return img ? JSON.stringify({ src: img.getAttribute('src'), w: img.naturalWidth, h: img.naturalHeight }) : null;
})()`);
check("音球用了拟人形象 img", orbImg !== null && typeof orbImg.src === "string" && orbImg.src.includes("/avatars/orb.png"), JSON.stringify(orbImg));
check("音球图片真的加载成功", orbImg !== null && orbImg.w > 0, JSON.stringify(orbImg));

// 2. 专家桌宠层
const experts = await evaluate(`(() => {
  const layer = document.querySelector('[data-xfv="experts"]');
  if (!layer) return null;
  const cards = [...document.querySelectorAll('.xfv-expert')];
  return JSON.stringify({
    count: cards.length,
    ids: cards.map(c => c.getAttribute('data-xfv')),
    imgs: cards.map(c => { const i = c.querySelector('.xfv-expert-img'); return i ? { src: i.getAttribute('src'), w: i.naturalWidth } : null; }),
    busy: cards.map(c => c.getAttribute('data-busy')),
  });
})()`);
// V1.7：专家清单可变（默认 4 位 + 用户自定义 + disabled 墓碑），不再硬编码
// 数量/id。从 /experts 拿当前花名册，断言浮层与之一一对应。
const roster = await fetch("http://127.0.0.1:3080/plugins/dsh-voice-assistant/api/experts", {
	headers: { cookie: `dsh_token=${JSON.parse((await import("node:fs")).readFileSync("tools/_dsh-serve.json", "utf8")).token}` },
	signal: AbortSignal.timeout(3000),
}).then((r) => r.json()).catch(() => null);
const expectedIds = Array.isArray(roster?.workers) ? roster.workers.map((w) => `expert-${w.id}`) : null;
check("专家桌宠层已挂载", experts !== null, JSON.stringify(experts));
if (experts) {
	check("专家数量与实际花名册一致", expectedIds === null || experts.count === expectedIds.length, `浮层 ${experts.count} / 花名册 ${expectedIds?.length}`);
	check("专家 id 与实际花名册一致", expectedIds === null || experts.ids.slice().sort().join(",") === expectedIds.slice().sort().join(","), `浮层 ${experts.ids.join(",")} / 花名册 ${expectedIds?.join(",")}`);
	const loaded = experts.imgs.filter((i) => i !== null && i.w > 0);
	check("所有专家图都加载成功", loaded.length === experts.count, `${loaded.length}/${experts.count}: ${JSON.stringify(experts.imgs)}`);
	// 不假设"全空闲"：上一次探针派的任务可能还在后台跑（跨探针状态污染）。
	// 只断言工作态是合法值，真正的联动在下面主动派单后验证。
	check("专家工作态字段合法", experts.busy.every((b) => b === "true" || b === "false"), experts.busy.join(","));
}

// 3. 真实拖拽音球（CDP 派发指针事件）
// 先装一个探针统计 pointer 事件，判断是"事件没到"还是"到了但逻辑没生效"。
await evaluate(`(() => {
  globalThis.__ptrLog = [];
  globalThis.__docPtrLog = [];
  const el = document.querySelector('.xfv-orb');
  for (const t of ['pointerdown','pointermove','pointerup','gotpointercapture','lostpointercapture']) {
    el.addEventListener(t, e => globalThis.__ptrLog.push(t + ':' + e.pointerId + ':' + e.clientX + ',' + e.clientY), true);
  }
  for (const t of ['pointermove','pointerup']) {
    document.addEventListener(t, e => globalThis.__docPtrLog.push(t + ':' + e.pointerId + ':' + e.clientX + ',' + e.clientY), true);
  }
  return JSON.stringify(true);
})()`);
const before = await evaluate(`(() => { const r = document.querySelector('.xfv-orb').getBoundingClientRect(); return JSON.stringify({x:r.left,y:r.top}); })()`);
async function pointer(type, x, y, buttons) {
	// mouseMoved 也要带 button:'left' —— Chrome 只在 button 为 left 时才合成
	// 带 buttons=1 的 pointermove；用 'none' 会被当作普通悬浮而丢弃。
	await send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });
}
await pointer("mouseMoved", before.x + 30, before.y + 30, 0);
await pointer("mousePressed", before.x + 30, before.y + 30, 1);
await pointer("mouseMoved", before.x + 55, before.y + 70, 1);
await pointer("mouseMoved", before.x + 85, before.y + 110, 1);
await pointer("mouseMoved", before.x + 110, before.y + 150, 1);
await pointer("mouseReleased", before.x + 110, before.y + 150, 0);
await sleep(400);
const ptrLog = await evaluate(`JSON.stringify(globalThis.__ptrLog ?? [])`);
check("pointer 事件到达了音球", Array.isArray(ptrLog) && ptrLog.some((x) => x.startsWith("pointerdown")), JSON.stringify(ptrLog));
const docPtrLog = await evaluate(`JSON.stringify(globalThis.__docPtrLog ?? [])`);
console.log("   pointer 日志(元素):", JSON.stringify(ptrLog));
console.log("   pointer 日志(文档):", JSON.stringify(docPtrLog));

const after = await evaluate(`(() => {
  const el = document.querySelector('.xfv-orb');
  const r = el.getBoundingClientRect();
  const saved = localStorage.getItem('xfv:v1:pos:orb');
  return JSON.stringify({ x: r.left, y: r.top, inlineLeft: el.style.left, saved });
})()`);
check("音球被拖动了位置", Math.abs(after.x - before.x) > 20 || Math.abs(after.y - before.y) > 20,
	`${JSON.stringify(before)} → ${JSON.stringify(after)}`);
check("位置写进了 localStorage", typeof after.saved === "string" && after.saved.includes('"x"'), String(after.saved));
// 回归（"拖一下球就没了"）：拖拽后球必须真的落在视口内。positionStyle 曾用
// relative + 视口绝对坐标，球会叠加到原位之外飞出屏幕 —— 单测只测纯函数
// 抓不到，必须在真浏览器里查 getBoundingClientRect。
check("拖拽后球仍在视口内", after.x > 0 && after.y > 0 && after.x < 1000 && after.y < 700, JSON.stringify(after));

// 4. 刷新后位置读回
await send("Page.reload", { ignoreCache: true });
await sleep(4000);
let afterReload = null;
for (let i = 0; i < 20; i += 1) {
	afterReload = await evaluate(`(() => {
	  const el = document.querySelector('.xfv-orb');
	  if (!el) return null;
	  const r = el.getBoundingClientRect();
	  return JSON.stringify({ x: r.left, y: r.top, inlineLeft: el.style.left });
	})()`);
	if (afterReload !== null && afterReload.inlineLeft) break;
	await sleep(500);
}
check("刷新后音球位置从存储恢复", afterReload !== null && afterReload.inlineLeft !== "", JSON.stringify(afterReload));
if (afterReload !== null && afterReload.inlineLeft !== "") {
	check("恢复的位置与拖后一致", Math.abs(afterReload.x - after.x) < 6 && Math.abs(afterReload.y - after.y) < 6,
		`拖后 ${JSON.stringify(after)} / 刷新后 ${JSON.stringify(afterReload)}`);
	check("刷新恢复后球仍在视口内", afterReload.x > 0 && afterReload.y > 0 && afterReload.x < 1000 && afterReload.y < 700, JSON.stringify(afterReload));
}

// 5. 工作态联动：派一个任务给某位在册专家（排除 general），浮层应切到 busy
const s = JSON.parse((await import("node:fs")).readFileSync("tools/_dsh-serve.json", "utf8"));
const apiBase = "http://127.0.0.1:3080/plugins/dsh-voice-assistant/api";
const targetWorker = (Array.isArray(roster?.workers) ? roster.workers.map((w) => w.id) : [])
	.find((id) => id && id !== "general") ?? "bioinfo";
const delegated = await fetch(`${apiBase}/delegate`, {
	method: "POST",
	headers: { "content-type": "application/json", cookie: `dsh_token=${s.token}` },
	body: JSON.stringify({ worker: targetWorker, task: "请简要说明你的职责，一句话即可。" }),
}).then((r) => r.json()).catch(() => null);
check("派单成功（工作态联动前置）", delegated?.ok === true, JSON.stringify(delegated));
if (delegated?.ok === true) {
	const sel = `[data-xfv="expert-${targetWorker}"]`;
	// 桌宠 1.5s 轮询一次。任务可能在几秒内完成，所以要**持续轮询**抓 busy
	// 的那一瞬，而不是死等固定时长（否则任务跑完了反而看不到）。
	let busyState = null;
	for (let i = 0; i < 16; i += 1) {
		await sleep(500);
		busyState = await evaluate(`(() => {
		  const c = document.querySelector('${sel}');
		  return c ? JSON.stringify({ busy: c.getAttribute('data-busy'), task: c.querySelector('.xfv-expert-task')?.textContent ?? '' }) : null;
		})()`);
		if (busyState?.busy === "true") break;
	}
	check(`${targetWorker} 桌宠切到工作中`, busyState?.busy === "true", JSON.stringify(busyState));
	if (busyState?.busy === "true") {
		// 任务气泡是 hover 才出现的（避免常驻挡界面）。用 CDP 真移动鼠标到卡片，
		// React 的 onMouseEnter 依赖原生 mouseover，dispatchEvent 合成的不触发。
		const cardRect = await evaluate(`(() => {
		  const c = document.querySelector('${sel}');
		  if (!c) return null;
		  const r = c.getBoundingClientRect();
		  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
		})()`);
		if (cardRect !== null) {
			await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cardRect.x, y: cardRect.y, button: "none", buttons: 0 });
		}
		await sleep(400);
		const hovered = await evaluate(`(() => {
		  const c = document.querySelector('${sel}');
		  return JSON.stringify({ task: c?.querySelector('.xfv-expert-task')?.textContent ?? '' });
		})()`);
		check("hover 后桌宠显示当前任务", typeof hovered.task === "string" && hovered.task.length > 0, JSON.stringify(hovered));
	}
}

// 6. 无 JS 异常
const relevant = errors.filter((e) => /xfv|voice|小凤|orb|expert/i.test(e));
check("无插件相关 JS 异常", relevant.length === 0, relevant.slice(0, 3).join(" | "));

chrome.kill();
if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	for (const f of failures) console.error(`  - ${f.name}: ${f.detail ?? ""}`);
	process.exit(1);
}
console.log("\nV1.6 卡通形象真浏览器验证通过");
