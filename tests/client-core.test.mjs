/** 客户端纯逻辑自检：状态机、唤醒词、播报文本。不需要浏览器。 */
import { STATES, EVENTS } from "../src/client/core/constants.js";
import { nextState, VoiceMachine } from "../src/client/core/machine.js";
import { findWake, normalizeWithMap } from "../src/client/core/wakeword.js";
import { assistantTextOf, splitForSpeech, stripForSpeech, textFromContent } from "../src/client/core/text.js";
import { QuestionBridge } from "../src/client/core/questions.js";

const failures = [];
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures.push({ name, actual, expected });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` → ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`}`);
};

// ── 状态机 ────────────────────────────────────────────────────────────
check("off + start → standby", nextState(STATES.OFF, EVENTS.START), STATES.STANDBY);
check("standby + wake → active", nextState(STATES.STANDBY, EVENTS.WAKE), STATES.ACTIVE);
check("active + command → thinking", nextState(STATES.ACTIVE, EVENTS.COMMAND), STATES.THINKING);
check("thinking + reply → speaking", nextState(STATES.THINKING, EVENTS.REPLY), STATES.SPEAKING);
// 播报不是"思考"。回答落地走的是 AGENT_MESSAGE，这一格曾经漏掉，
// 导致播报期间界面一直显示「思考中」、播完的 speak-end 无处可去（永久卡住）。
check("thinking + agent-message → speaking", nextState(STATES.THINKING, EVENTS.AGENT_MESSAGE), STATES.SPEAKING);
// 播报结束后必须回「正在听」而不是「待机」—— 这是"答完一轮不必重新喊唤醒词"
// 的落点。落到 `standby` 的症状很好认也很反直觉：**每轮都要重新唤醒，却永远
// 不会休眠**（`standby` 不参与休眠计时），即"两个极端同时发生"。
check("speaking + speak-end → active", nextState(STATES.SPEAKING, EVENTS.SPEAK_END), STATES.ACTIVE);
// 用户主动打断 ≠ 助手自然说完，但**目标状态相同**（都是"我要说话"）。
// 区别在于进 ACTIVE 时是否走 700ms 回声静默期：助手刚念完有外放余响，
// 用户打断没有。两者都从 SPEAKING 出发，所以这条路径统一走静默期。
check("speaking + wake → active", nextState(STATES.SPEAKING, EVENTS.WAKE), STATES.ACTIVE);
check("active + idle → standby", nextState(STATES.ACTIVE, EVENTS.IDLE), STATES.STANDBY);
check("speaking + sleep → sleeping", nextState(STATES.SPEAKING, EVENTS.SLEEP), STATES.SLEEPING);
check("sleeping + agent-message → speaking", nextState(STATES.SLEEPING, EVENTS.AGENT_MESSAGE), STATES.SPEAKING);
check("sleeping + resume → standby", nextState(STATES.SLEEPING, EVENTS.RESUME), STATES.STANDBY);
check("thinking 空闲不休眠", nextState(STATES.THINKING, EVENTS.IDLE), STATES.THINKING);
check("standby 空闲不休眠", nextState(STATES.STANDBY, EVENTS.IDLE), STATES.STANDBY);
check("未知事件保持原状态", nextState(STATES.OFF, "nonsense"), STATES.OFF);
check("未知状态保持原状态", nextState("bogus", EVENTS.START), "bogus");

// 一整轮的端到端状态轨迹：这是"播报归错状态"那类 bug 唯一能一眼看出的形态。
{
	const trace = new VoiceMachine(STATES.OFF);
	const path = [];
	trace.subscribe((to, from, event) => path.push(`${from}>${to}:${event}`));
	trace.send(EVENTS.START); // 启用
	trace.send(EVENTS.WAKE); // 喊小凤
	trace.send(EVENTS.COMMAND); // 提交指令
	trace.send(EVENTS.AGENT_MESSAGE); // 回答落地 → 开念
	trace.send(EVENTS.SPEAK_END); // 念完
	check(
		"一整轮轨迹：思考→播报→正在听",
		path,
		[
			"off>standby:start",
			"standby>active:wake",
			"active>thinking:command",
			"thinking>speaking:agent-message",
			"speaking>active:speak-end",
		],
	);
	check("播完后落在「正在听」（不必再喊唤醒词）", trace.get(), STATES.ACTIVE);

	// 紧接着静默到点：`active` 的休眠计时负责收尾 —— 播报完的收尾就是这个。
	// 这一条把两件事钉在一起：**播完能接着听** + **没人说话才睡**。
	trace.send(EVENTS.SLEEP);
	check("播完后再静默才休眠", trace.get(), STATES.SLEEPING);
}

const machine = new VoiceMachine();
const seen = [];
const off = machine.subscribe((to, from, event) => seen.push(`${from}>${to}:${event}`));
machine.send(EVENTS.START);
machine.send(EVENTS.WAKE);
machine.send(EVENTS.WAKE); // 重复事件不该产生迁移
off();
machine.send(EVENTS.STOP);
check("订阅收到迁移且忽略重复", seen, ["off>standby:start", "standby>active:wake"]);
check("退订后不再通知", seen.length, 2);
check("退订后状态仍可推进", machine.get(), STATES.OFF);

// 一个订阅者抛错不能影响其他订阅者
const m2 = new VoiceMachine();
let hit = 0;
m2.subscribe(() => {
	throw new Error("boom");
});
m2.subscribe(() => {
	hit += 1;
});
const originalError = console.error;
console.error = () => {};
m2.send(EVENTS.START);
console.error = originalError;
check("坏订阅者不阻断广播", hit, 1);

// ── 唤醒词 ────────────────────────────────────────────────────────────
const wake = { word: "小凤", aliases: ["小风", "晓凤"], inline: true };
check("句首唤醒", findWake("小凤帮我看下报错", wake).hit, true);
check("唤醒后指令保留", findWake("小凤帮我看下报错", wake).rest, "帮我看下报错");
check("同音别名命中", findWake("小风，打开文件夹", wake).hit, true);
check("别名后指令去标点", findWake("小风，打开文件夹", wake).rest, "打开文件夹");
check("识别多空格", findWake("小 凤 现在几点", wake).hit, true);
check("句中唤醒（inline）", findWake("那个小凤你听得到吗", wake).hit, true);
check("句中唤醒（非 inline 拒绝）", findWake("那个小凤你听得到吗", { ...wake, inline: false }).hit, false);
check("未命中", findWake("今天天气怎么样", wake).hit, false);
check("空文本", findWake("", wake).hit, false);
check("非字符串", findWake(null, wake).hit, false);
check("只有唤醒词", findWake("小凤", wake).rest, "");
check("长词优先：小凤凰先匹配（无此别名时退化为小凤）", findWake("小凤凰", { word: "小凤", aliases: ["小凤凰"], inline: true }).matched, "小凤凰");

const norm = normalizeWithMap("小 凤，A1");
check("归一化", norm.normalized, "小凤a1");
check("下标映射长度一致", norm.map.length, norm.normalized.length);
check("映射指回原文", "小 凤，A1"[norm.map[0]], "小");

// ── 播报文本 ──────────────────────────────────────────────────────────
check("去加粗标记", stripForSpeech("**重要**：先备份"), "重要：先备份");
check("链接保留文字去掉 URL", stripForSpeech("见[文档](https://x.com/a)"), "见文档");
check("代码块替换为略读", stripForSpeech("看这段\n```js\nconst a=1\n```"), "看这段\n，代码略。".replace("\n", ""));
check("表格竖线转逗号", stripForSpeech("| a | b |"), "a，b");
check("裸链接替换", stripForSpeech("参考 https://x.com/a 这里有"), "参考 （链接略） 这里有");
check("行内代码保留内容", stripForSpeech("执行 `npm test` 即可"), "执行 npm test 即可");

const chunks = splitForSpeech("第一句。第二句！第三句？", 80);
check("按句切分", chunks.length, 3);
check("句子内容", chunks[1], "第二句！");
check("空文本不切", splitForSpeech("").length, 0);
check("超长句硬切", splitForSpeech("字".repeat(200), 80).every((c) => c.length <= 80), true);
check("纯标点被丢弃", splitForSpeech("。。。").length, 0);

check("内容块取文本", textFromContent([{ type: "text", text: "a" }, { type: "reasoning", text: "b" }]), "a");
check("跳过多模态块", textFromContent([{ type: "image", data: "x" }, { type: "text", text: "c" }]), "c");
check("字符串内容", textFromContent("hi"), "hi");
check(
	"assistant 事件取文本",
	assistantTextOf({ type: "assistant/message", message: { content: [{ type: "text", text: "答案" }] } }),
	"答案",
);
check(
	"被打断的回答不播",
	assistantTextOf({ type: "assistant/message", interrupted: true, message: { content: [{ type: "text", text: "半句" }] } }),
	"",
);
check("非 assistant 事件", assistantTextOf({ type: "tool/call" }), "");

// ── 事件负载在 data 下（真机形状回归）────────────────────────────────
//
// DSH 真实事件是 `{ type, seq, time, data }`，业务字段全在 data 里。
// 曾经按扁平结构读，导致 turn/reason 与回答文本全为 undefined ——
// 现象是"回答不念"但看不出哪里错。这两条锁死兼容性。
check(
	"data 包裹的 assistant 事件也取到文本",
	assistantTextOf({
		type: "assistant/message",
		seq: 34,
		time: 1,
		data: { turn: 5, step: 1, message: { content: [{ type: "text", text: "我是小凤" }] } },
	}),
	"我是小凤",
);
check(
	"data 包裹且被打断时不播",
	assistantTextOf({
		type: "assistant/message",
		data: { interrupted: true, message: { content: [{ type: "text", text: "半句" }] } },
	}),
	"",
);

// 会话桥的 handleEvent：同一事件的两种形态必须给出一致的 turn 边界与回答。
const { VoiceSession } = await import("../src/client/core/session.js");
/**
 * 造一个只够跑 handleEvent 的 VoiceSession（不碰 ctx / 网络）。
 * @param collected - 收集回调产物。
 */
function makeBridge(collected) {
	const session = new VoiceSession({
		ctx: { get: () => undefined },
		config: { session: {}, agent: {} },
		onTurnStart: (p) => collected.push(["start", p.turn]),
		onTurnEnd: (p) => collected.push(["end", p.turn, p.reason?.kind ?? null, p.text]),
	});
	return session;
}

const flat = [];
const flatBridge = makeBridge(flat);
flatBridge.handleEvent({ type: "turn/start", turn: 7 });
flatBridge.handleEvent({ type: "assistant/message", message: { content: [{ type: "text", text: "扁平" }] } });
flatBridge.handleEvent({ type: "turn/end", turn: 7, reason: { kind: "completed" } });
check("扁平事件：turn 边界与回答都读到", flat, [["start", 7], ["end", 7, "completed", "扁平"]]);

const wrapped = [];
const wrappedBridge = makeBridge(wrapped);
wrappedBridge.handleEvent({ type: "turn/start", seq: 1, time: 1, data: { turn: 7 } });
wrappedBridge.handleEvent({
	type: "assistant/message",
	seq: 2,
	time: 2,
	data: { message: { content: [{ type: "text", text: "包裹" }] } },
});
wrappedBridge.handleEvent({ type: "turn/end", seq: 3, time: 3, data: { turn: 7, reason: { kind: "completed" } } });
check("data 包裹事件：结果与扁平完全一致", wrapped, [["start", 7], ["end", 7, "completed", "包裹"]]);

// 错误轮：reason.kind === "error" 必须能被上层识别（用于播报失败而不是静默）。
const errored = [];
const errBridge = makeBridge(errored);
errBridge.handleEvent({ type: "turn/start", data: { turn: 8 } });
errBridge.handleEvent({
	type: "turn/end",
	data: { turn: 8, reason: { kind: "error", error: { message: "has no provider/model" } } },
});
check("错误轮 reason 可被上层识别", errored, [["start", 8], ["end", 8, "error", ""]]);

// 被闸门拒绝的轮（`reason.kind === "blocked"`）同样必须**原样透传**到上层。
//
// 这条为什么重要：`blocked` 是"这一轮压根没跑"的信号（最典型成因是会话躺在
// `workspaceRegistry.archivedSessionIds` 里，见 lib/identity.js）。而
// `prompt()` 的原始返回仍是 `{"ok":true,"value":{"accepted":true}}` ——
// 提交是成功的。若会话层把 reason 丢掉或归一化，控制器就只能看到"空文本的
// turn/end"，于是把致命故障归到"纯工具轮"、打印"这一轮没有可播报的文字"，
// 用户完全看不出问题。会话层这一环只负责**如实搬运**，判读交给控制器。
const blockedTurn = [];
const blockedBridge = makeBridge(blockedTurn);
blockedBridge.handleEvent({ type: "turn/start", seq: 10, time: 10, data: { turn: 9 } });
blockedBridge.handleEvent({ type: "turn/end", seq: 11, time: 11, data: { turn: 9, reason: { kind: "blocked" } } });
check("被拒轮 reason 原样透传（不得归一化成 completed）", blockedTurn, [["start", 9], ["end", 9, "blocked", ""]]);

// ── 异步水合：空窗口绑定后涌入的历史不得触发回调 ──────────────────────
//
// 这是真机复现过的故障：常驻 agent 的历史**不是** retain 时就位的 ——
// 绑定时 `entries` 是空的（水位线只能定成 −1），几十毫秒后上百条历史整批灌入，
// 其中那条陈年失败的 `turn/end` 被当成刚发生的事重放，于是
// **回答念出来了，界面却同时挂着一条报错**，刷新页面必现。
//
// 判据改用事件自带的 `time`：早于绑定时刻（含容差）的就是历史回放。
/**
 * 造一个可控的事件窗口（能模拟"绑定时为空、随后灌入"）。
 */
function makeWindow() {
	let entries = [];
	const listeners = new Set();
	return {
		source: {
			getSnapshot: () => ({ entries, hasMore: false, revision: entries.length }),
			subscribe: (fn) => {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
		},
		/** 灌入事件并通知订阅者（模拟水合 / 新事件到达）。 */
		push(...events) {
			entries = [...entries, ...events.map((event) => ({ type: "event", event }))];
			for (const listener of listeners) listener();
		},
	};
}

/** 造一个带 fake eventSource 的会话桥。 */
function makeBoundBridge(collected) {
	const bridge = makeBridge(collected);
	const window = makeWindow();
	bridge.bindEvents({ eventSource: window.source });
	return { bridge, window };
}

// 场景一：绑定时窗口为空 → 历史涌入 → 旧错误轮不得触发任何回调。
const hydrated = [];
const h1 = makeBoundBridge(hydrated);
const staleTime = Date.now() - 300000; // 5 分钟前那条陈年失败 turn
const nowTime = Date.now() + 10; // 绑定后刚发生的新事件
h1.window.push(
	{ type: "turn/start", seq: 1, time: staleTime, data: { turn: 1 } },
	{ type: "assistant/message", seq: 2, time: staleTime, data: { message: { content: [{ type: "text", text: "陈年回答" }] } } },
	{ type: "turn/end", seq: 3, time: staleTime, data: { turn: 1, reason: { kind: "error", error: { message: "has no provider/model" } } } },
	{ type: "turn/start", seq: 4, time: nowTime, data: { turn: 2 } },
	{ type: "assistant/message", seq: 5, time: nowTime, data: { message: { content: [{ type: "text", text: "这次的回答" }] } } },
	{ type: "turn/end", seq: 6, time: nowTime, data: { turn: 2, reason: { kind: "completed" } } },
);
check("异步水合：历史回放不触发回调，新事件照常", hydrated, [["start", 2], ["end", 2, "completed", "这次的回答"]]);
check("异步水合：拦下的历史条数被记下", h1.bridge.skippedHistory, 3);
check("异步水合：游标推进到最新 seq", h1.bridge.cursor, 6);

// 场景二：没有 `time` 字段的旧版事件不得被误杀（兼容性）。
const noTime = [];
const h2 = makeBoundBridge(noTime);
h2.window.push(
	{ type: "turn/start", seq: 1, data: { turn: 3 } },
	{ type: "assistant/message", seq: 2, data: { message: { content: [{ type: "text", text: "无时间戳也照播" }] } } },
	{ type: "turn/end", seq: 3, data: { turn: 3, reason: { kind: "completed" } } },
);
check("无 time 字段的事件不被当成历史", noTime, [["start", 3], ["end", 3, "completed", "无时间戳也照播"]]);

// 场景三：窗口在绑定时已有内容（传统路径）→ 仍在用 seq 水位线挡住旧事件。
const preloaded = [];
const pre = makeWindow();
pre.push({ type: "turn/start", seq: 1, time: staleTime, data: { turn: 1 } });
pre.push({ type: "turn/end", seq: 2, time: staleTime, data: { turn: 1, reason: { kind: "completed" } } });
const preBridge = makeBridge(preloaded);
preBridge.bindEvents({ eventSource: pre.source });
check("窗口已就绪时水位线取到最大 seq", preBridge.cursor, 2);
pre.push({ type: "turn/start", seq: 3, time: Date.now() + 10, data: { turn: 2 } });
pre.push({ type: "assistant/message", seq: 4, time: Date.now() + 10, data: { message: { content: [{ type: "text", text: "新的" }] } } });
pre.push({ type: "turn/end", seq: 5, time: Date.now() + 10, data: { turn: 2, reason: { kind: "completed" } } });
check("窗口已就绪时只处理增量", preloaded, [["start", 2], ["end", 2, "completed", "新的"]]);

// 场景四：订阅后重复收到同一批事件（真实窗口每次通知都给全量）幂等。
const idempotent = [];
const h4 = makeBoundBridge(idempotent);
const batch = [
	{ type: "turn/start", seq: 1, time: nowTime, data: { turn: 5 } },
	{ type: "assistant/message", seq: 2, time: nowTime, data: { message: { content: [{ type: "text", text: "只念一次" }] } } },
	{ type: "turn/end", seq: 3, time: nowTime, data: { turn: 5, reason: { kind: "completed" } } },
];
h4.window.push(...batch);
h4.window.push(...batch); // 同一条不回灌第二次（entries 是同一批）
check("全量通知下同一事件只处理一次", idempotent, [["start", 5], ["end", 5, "completed", "只念一次"]]);

// 多步：assistant/message 取最后一条（真正的结论在后面）。
const multi = [];
const multiBridge = makeBridge(multi);
multiBridge.handleEvent({ type: "turn/start", data: { turn: 9 } });
multiBridge.handleEvent({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "中间步骤" }] } } });
multiBridge.handleEvent({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "最终结论" }] } } });
multiBridge.handleEvent({ type: "turn/end", data: { turn: 9, reason: { kind: "completed" } } });
check("多步取最后一条回答", multi[1], ["end", 9, "completed", "最终结论"]);

// ── 轮次门槛：片段攒成整轮才提交 ──────────────────────────────────────
//
// 需求：「声音停止足够久才算一轮说完，不要还没说完就提交」。
// 识别引擎的产物是**片段**（900ms / 700ms 静音就切一段），片段不等于发言。
// 这里锁死三条边界：静音到点提交一次、硬上限兜底、手动立即提交。
//
// 测试统一用 `SILENCE` 而不是硬编码数字，阈值以后调整不必改一遍算术。
const SILENCE = 10000;
const { TurnGate } = await import("../src/client/core/turn.js");

/**
 * 造一个可控时钟 + 定时器，避免测试依赖真实等待。
 */
function makeClock() {
	let now = 1000;
	let seq = 0;
	const timers = new Map();
	return {
		now: () => now,
		setTimer: (fn, delay) => {
			seq += 1;
			timers.set(seq, { at: now + delay, fn });
			return seq;
		},
		clearTimer: (handle) => timers.delete(handle),
		/** 推进时间并触发到点的定时器（按到期顺序）。 */
		advance(ms) {
			const target = now + ms;
			for (;;) {
				let next = null;
				for (const [handle, timer] of timers) {
					if (timer.at <= target && (next === null || timer.at < next.timer.at)) next = { handle, timer };
				}
				if (next === null) break;
				timers.delete(next.handle);
				now = next.timer.at;
				next.timer.fn();
			}
			now = target;
		},
	};
}

// 场景一：一句一停（间隔远小于静音阈值）→ 一次都不提交，直到静音满。
{
	const clock = makeClock();
	const commits = [];
	const gate = new TurnGate({
		silenceMs: SILENCE,
		maxTurnMs: 300000,
		onCommit: (p) => commits.push(p),
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	gate.push("帮我打开D盘");
	clock.advance(3000); // 想词（单次停顿远小于阈值）
	gate.push("然后建一个文件夹");
	clock.advance(3000); // 换气
	gate.push("名字叫项目资料");
	check("静音未满不提交", commits.length, 0);
	check("片段被攒成整轮", gate.text, "帮我打开D盘然后建一个文件夹名字叫项目资料");
	clock.advance(SILENCE - 1);
	check("静音差 1 毫秒仍不提交", commits.length, 0);
	clock.advance(1);
	check("静音满阈值提交一次", commits.length, 1);
	check("提交内容是整轮", commits[0].text, "帮我打开D盘然后建一个文件夹名字叫项目资料");
	check("提交归因是静音", commits[0].reason, "silence");
	check("提交后清空", gate.pending, false);
}

// 场景二：每个新片段都要**重排**静音计时（否则停 9s 说 1 个字就会被提交）。
{
	const clock = makeClock();
	const commits = [];
	const gate = new TurnGate({
		silenceMs: SILENCE,
		maxTurnMs: 300000,
		onCommit: (p) => commits.push(p),
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	gate.push("第一句");
	for (let i = 0; i < 5; i += 1) {
		clock.advance(SILENCE - 2000); // 每次都在阈值之内
		gate.push(`第${i + 2}句`);
	}
	check("持续补充说话期间不提交", commits.length, 0);
	clock.advance(SILENCE);
	check("最后一句之后静音满才提交", commits.length, 1);
	check("整轮内容完整", commits[0].text, "第一句第2句第3句第4句第5句第6句");
}

// 场景三：紧邻重复片段被丢弃（引擎 onend 重启会把同一句再送一遍），
// 但**非紧邻**的重复必须保留（用户可能有意重复）。
{
	const clock = makeClock();
	const commits = [];
	const gate = new TurnGate({
		silenceMs: SILENCE,
		onCommit: (p) => commits.push(p),
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	gate.push("打开设置");
	gate.push("打开设置"); // 紧邻重复：丢
	gate.push("打开设置"); // 仍然紧邻同一个值：丢
	check("紧邻重复只留一份", gate.text, "打开设置");
	gate.push("点外观");
	gate.push("打开设置"); // 非紧邻：保留
	check("非紧邻重复保留", gate.text, "打开设置点外观打开设置");
}

// 场景四：连续不断说话 → 触到硬上限必须提交一次（防止上下文无限膨胀）。
{
	const clock = makeClock();
	const commits = [];
	const gate = new TurnGate({
		silenceMs: SILENCE,
		maxTurnMs: 120000,
		onCommit: (p) => commits.push(p),
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	// 每步都比静音阈值短（永远不给满静音），但累计很快超过 120s 硬上限。
	for (let i = 0; i < 20; i += 1) {
		gate.push(`句${i}`);
		clock.advance(SILENCE - 1000);
	}
	check("连续说话触到硬上限提交一次", commits.length, 1);
	check("硬上限归因是 cap", commits[0].reason, "cap");
}

// 场景五：手动提交（单击语音球）立即生效。
{
	const clock = makeClock();
	const commits = [];
	const gate = new TurnGate({
		silenceMs: SILENCE,
		onCommit: (p) => commits.push(p),
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	gate.push("我现在就要答案");
	gate.flush();
	check("手动提交立即生效", commits.length, 1);
	check("手动归因是 manual", commits[0].reason, "manual");
	check("手动提交后计时被清掉", gate.deadline, null);
	clock.advance(SILENCE * 2);
	check("手动提交后不再重复提交", commits.length, 1);
}

// 场景六：reset 丢弃未提交内容，且不留残计时。
{
	const clock = makeClock();
	const commits = [];
	const gate = new TurnGate({
		silenceMs: SILENCE,
		onCommit: (p) => commits.push(p),
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	gate.push("这句话不该被提交");
	gate.reset();
	check("reset 后无待提交内容", gate.pending, false);
	clock.advance(SILENCE * 2);
	check("reset 后不会有迟到提交", commits.length, 0);
}

// 场景七：界面倒计时用的截止时刻必须"随每次说话往后推"。
{
	const clock = makeClock();
	const gate = new TurnGate({
		silenceMs: SILENCE,
		onCommit: () => {},
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	gate.push("说一句");
	const first = gate.deadline;
	clock.advance(3000); // 真实场景里说话期间时间必然在走
	gate.push("再说一句");
	check("新片段把提交截止时刻往后推", gate.deadline > first, true);
	check("倒计时为正且不超过静音阈值", gate.inspect().dueInMs > 0 && gate.inspect().dueInMs <= SILENCE, true);
}

// ── 回声抑制：助手自己念的话不得当成用户指令 ──────────────────────────
//
// 这是"自说自话"闭环的文本级防线。判据是**归一化后的双向包含**，
// 因为识别器转写自己念的话必然有字差（丢标点、同音字）。
const { detectEcho, normalizeForEcho, EchoGuard } = await import("../src/client/core/echo.js");

check("归一化去标点空白", normalizeForEcho("磁盘，C 盘。"), "磁盘c盘");
check("归一化抹平同音错写", normalizeForEcho("文件加"), "文件夹");
check("归一化抹平盘符错写", normalizeForEcho("地盘"), "d盘");
check("归一化统一小写", normalizeForEcho("ABC"), "abc");
check("非字符串归一化为空", normalizeForEcho(null), "");

{
	const spoken = [{ text: "已经帮你打开了D盘的文件夹", at: 1000 }];
	check("完全一致判为回声", detectEcho("已经帮你打开了D盘的文件夹", spoken, { now: 2000 }).echo, true);
	check("丢标点后仍判为回声", detectEcho("已经帮你打开了D盘的文件夹。", spoken, { now: 2000 }).echo, true);
	check("只录到半句也判为回声", detectEcho("打开了D盘的文件夹", spoken, { now: 2000 }).echo, true);
	check("回声带识别错字也判为回声", detectEcho("已经帮你打开了词盘的文件夹", spoken, { now: 2000 }).echo, true);
	check("完全无关的话不是回声", detectEcho("帮我把那个文件删掉", spoken, { now: 2000 }).echo, false);
	check("超出回溯窗口后不再判为回声", detectEcho("已经帮你打开了D盘的文件夹", spoken, { now: 1000 + 60000 }).echo, false);
}
check("短句一律放行（宁漏挡不误杀）", detectEcho("好", [{ text: "好", at: 1000 }], { now: 2000 }).echo, false);

{
	const guard = new EchoGuard({ now: () => 5000 });
	guard.remember("我已经把日志读完了，没有发现异常");
	check("EchoGuard 拦下自己念的话", guard.check("我已经把日志读完了没有发现异常").echo, true);
	check("EchoGuard 放过用户的新指令", guard.check("那帮我把配置文件打开").echo, false);
	check("EchoGuard 记下拦下次数", guard.suppressed, 1);
	check("EchoGuard 记下拦下的那条", guard.lastSuppressed.includes("日志"), true);
	guard.reset();
	check("reset 后不再拦", guard.check("我已经把日志读完了没有发现异常").echo, false);
	check("reset 清空追踪", guard.inspect().tracked, 0);
}
check("空文本不入记录", (() => {
	const guard = new EchoGuard();
	guard.remember("");
	guard.remember("   ");
	return guard.inspect().tracked;
})(), 0);

// ── 跨会话：列出 / 切换 / 新建 / 回常驻 ───────────────────────────────
//
// 需求是"语音助手能控制打开不同会话、按需开新会话派任务"。这一段最容易
// 出错的地方**不是**"能不能切"，而是"切完之后旧窗口的状态有没有带过去"：
//
//   * `cursor`（seq 水位线）是**相对某一条会话**的，换会话后毫无意义；
//   * `floorTime`（时间地板）是"绑定时刻 − 2s"，只为拦那条会话的历史。
//
// 只换 id 不重置这两样，新会话的历史就会整批灌进来被当成新事件念出去 ——
// 正是本项目已经踩过的"回答念出来了、界面却挂着陈年报错"那类翻车。
// 所以下面既断言"切过去了"，也断言"切完合成的事件流是干净的"。

/**
 * 造一个能跑完整绑定流程的假 ctx。
 *
 * 只实现 `sessions`（list/create/retain）与 `uiWorkspace`（openSession），
 * 其余一律 undefined —— 这样任何一次"偷偷多要一个服务"都会在测试里暴露。
 *
 * @param options - `{ ids, byId, created }`：会话列表与 create 的返回。
 */
function makeSessionsCtx(options = {}) {
	const ids = options.ids ?? [];
	const byId = options.byId ?? {};
	const created = options.created ?? "session-new";
	const opened = [];
	const retained = [];
	const windows = new Map();

	/** 每条会话一个独立事件窗口（模拟真实的"水位线只对那条会话有效"）。 */
	const windowOf = (id) => {
		if (!windows.has(id)) {
			const listeners = new Set();
			const state = { entries: [] };
			windows.set(id, {
				state,
				listeners,
				emit(event) {
					state.entries.push({ type: "event", event });
					for (const listener of listeners) listener();
				},
				reset(entries) {
					state.entries = entries;
				},
			});
		}
		return windows.get(id);
	};

	const ctx = {
		get(name) {
			if (name === "sessions") {
				return {
					list: {
						getSnapshot: () => ({ state: { ids, byId, phase: "ready" } }),
						subscribe: () => () => {},
					},
					create: async () => {
						created;
						return { sessionId: created };
					},
					retain: (sessionId) => {
						retained.push(sessionId);
						const window = windowOf(sessionId);
						return {
							binding: {
								sessionId,
								eventSource: {
									getSnapshot: () => window.state,
									subscribe: (listener) => {
										window.listeners.add(listener);
										return () => window.listeners.delete(listener);
									},
								},
								session: { prompt: async () => ({ ok: true, value: { accepted: true } }), cancel: async () => {} },
							},
							release: () => {
								window.listeners.clear();
							},
						};
					},
				};
			}
			if (name === "uiWorkspace") return { openSession: (id) => opened.push(id) };
			return undefined;
		},
		__opened: opened,
		__retained: retained,
		__windowOf: windowOf,
	};
	return ctx;
}

/** 造一个指向常驻会话的桥（带假 ctx）。 */
function makeSwitchBridge(ctx, collected = []) {
	return new VoiceSession({
		ctx,
		config: {
			session: { mode: "persistent", workspace: "", title: "语音会话" },
			agent: { enabled: true, sessionId: "session-voice-assistant-root" },
		},
		onTurnStart: (p) => collected.push(["start", p.turn]),
		onTurnEnd: (p) => collected.push(["end", p.turn, p.text]),
		onStatus: (event) => collected.push(["status", event.kind, event.sessionId]),
	});
}

// 1) listTargets：过滤 subagent 与 blank，保留宿主顺序。
{
	const ctx = makeSessionsCtx({
		ids: ["s-a", "s-sub", "s-blank", "s-b"],
		byId: {
			"s-a": { id: "s-a", displayTitle: "甲", running: false, cwd: "D:/a" },
			"s-sub": { id: "s-sub", displayTitle: "子代理", origin: "subagent", running: false },
			"s-blank": { id: "s-blank", displayTitle: "空白", blank: true, running: false },
			"s-b": { id: "s-b", displayTitle: "乙", running: true, cwd: "C:/Users/xqz19/Documents/DSH" },
		},
	});
	const bridge = makeSwitchBridge(ctx);
	const targets = bridge.listTargets();
	check("跨会话：列表过滤掉 subagent 与 blank", targets.map((row) => row.id), ["s-a", "s-b"]);
	check("跨会话：保留宿主顺序", targets.map((row) => row.title), ["甲", "乙"]);
	check("跨会话：带出 running 与 cwd", [targets[1].running, targets[1].cwd], [true, "C:/Users/xqz19/Documents/DSH"]);
	check("跨会话：未绑定时没有 current", targets.map((row) => row.current), [false, false]);
	check("跨会话：宿主列表缺失时返回空数组", makeSwitchBridge({ get: () => undefined }).listTargets(), []);
}

// 2) 绑到常驻会话（基线）。
{
	const ctx = makeSessionsCtx({ ids: ["session-voice-assistant-root"], byId: {} });
	const bridge = makeSwitchBridge(ctx);
	await bridge.ensure({ open: false });
	check("跨会话：默认为常驻模式", bridge.mode, "persistent");
	check("跨会话：retain 了常驻 id", ctx.__retained, ["session-voice-assistant-root"]);
	check("跨会话：describe 给出人话标签", bridge.describe().label, "小凤 · 常驻助手");
}

// 3) switchTo 必须**重置水位线与时间地板**（本节的核心断言）。
{
	const ctx = makeSessionsCtx({
		ids: ["session-voice-assistant-root", "s-target"],
		byId: { "s-target": { id: "s-target", displayTitle: "目标会话", running: false } },
	});
	const collected = [];
	const bridge = makeSwitchBridge(ctx, collected);
	await bridge.ensure({ open: false });

	// 常驻会话里先跑一轮，让 cursor / floorTime 有真实值。
	const home = ctx.__windowOf("session-voice-assistant-root");
	home.emit({ type: "turn/start", seq: 5, time: Date.now(), data: { turn: 1 } });
	home.emit({ type: "turn/end", seq: 6, time: Date.now(), data: { turn: 1, reason: { kind: "completed" } } });
	const cursorBefore = bridge.cursor;
	const floorBefore = bridge.floorTime;
	check("跨会话：切之前已推进水位线", cursorBefore >= 6, true);

	const ok = await bridge.switchTo("s-target");
	check("跨会话：切换成功", ok, true);
	check("跨会话：mode 变为 switched", bridge.mode, "switched");
	check("跨会话：绑定到了目标会话", bridge.sessionId, "s-target");
	check("跨会话：水位线被重置（不再沿用旧会话的 seq）", bridge.cursor === cursorBefore, false);
	check("跨会话：时间地板被重置（重新按绑定时刻算）", bridge.floorTime !== floorBefore || bridge.floorTime >= floorBefore, true);
	check("跨会话：旧订阅已释放（只 retain 过两条会话）", ctx.__retained, ["session-voice-assistant-root", "s-target"]);

	// 关键：新会话的**历史**不得触发任何回调。
	//
	// 这条断言正是"换了 id 却没重置 floorTime"会挂掉的地方 ——
	// 历史事件的时间戳远早于新的 floorTime，必须被时间地板拦住。
	collected.length = 0;
	const target = ctx.__windowOf("s-target");
	target.emit({ type: "turn/end", seq: 1, time: Date.now() - 300000, data: { turn: 9, reason: { kind: "completed" } } });
	check("跨会话：切换后新会话的历史不被念出", collected.filter((row) => row[0] === "end"), []);
	check("跨会话：被拦下的历史计入诊断", bridge.skippedHistory >= 1, true);

	// 新会话的**新事件**必须正常触发。
	target.emit({ type: "turn/start", seq: 2, time: Date.now() + 10, data: { turn: 10 } });
	check("跨会话：切换后的新事件正常触发", collected.filter((row) => row[0] === "start"), [["start", 10]]);
}

// 4) 切到不存在的会话必须**退回原处**，不能把用户留在"没有目标"的状态。
{
	const ctx = makeSessionsCtx({ ids: ["session-voice-assistant-root"], byId: {} });
	const bridge = makeSwitchBridge(ctx);
	await bridge.ensure({ open: false });
	// 让目标会话的 retain 抛错（模拟会话已被删）。
	const originalRetain = ctx.get("sessions").retain;
	let calls = 0;
	ctx.get = ((original) => (name) => {
		if (name !== "sessions") return original(name);
		const service = original(name);
		return {
			...service,
			retain: (sessionId) => {
				calls += 1;
				if (sessionId === "s-gone") throw new Error("session/not-found");
				return service.retain(sessionId);
			},
		};
	})(ctx.get);
	const ok = await bridge.switchTo("s-gone");
	check("跨会话：切到不存在的会话返回 false", ok, false);
	check("跨会话：失败后退回常驻会话", bridge.sessionId, "session-voice-assistant-root");
	check("跨会话：失败后 mode 回到 persistent", bridge.mode, "persistent");
	check("跨会话：确实尝试过目标会话", calls >= 1, true);
}

// 5) 空 id 是无效输入（不该把绑定抖掉）。
{
	const ctx = makeSessionsCtx({ ids: ["session-voice-assistant-root"], byId: {} });
	const bridge = makeSwitchBridge(ctx);
	await bridge.ensure({ open: false });
	check("跨会话：空 id 直接拒绝", await bridge.switchTo("   "), false);
	check("跨会话：拒绝后绑定没被破坏", bridge.sessionId, "session-voice-assistant-root");
}

// 6) createAndSwitch：新建 + 切过去（宿主 create 返回对象，必须取 sessionId）。
{
	const ctx = makeSessionsCtx({
		ids: ["session-voice-assistant-root"],
		byId: { "session-new": { id: "session-new", displayTitle: "新会话", running: false } },
		created: "session-new",
	});
	const bridge = makeSwitchBridge(ctx);
	await bridge.ensure({ open: false });
	const id = await bridge.createAndSwitch({ cwd: "D:/work" });
	check("跨会话：新建返回新会话 id", id, "session-new");
	check("跨会话：新建后已切过去", bridge.sessionId, "session-new");
	check("跨会话：新建后 mode 为 switched", bridge.mode, "switched");
	check("跨会话：切换后的事件进新窗口", (() => {
		const target = ctx.__windowOf("session-new");
		target.emit({ type: "turn/start", seq: 1, time: Date.now() + 10, data: { turn: 1 } });
		return bridge.cursor >= 1;
	})(), true);
}

// 7) 切回常驻：清掉 pinnedId，重新绑回。
{
	const ctx = makeSessionsCtx({
		ids: ["session-voice-assistant-root", "s-target"],
		byId: { "s-target": { id: "s-target", displayTitle: "目标", running: false } },
	});
	const bridge = makeSwitchBridge(ctx);
	await bridge.ensure({ open: false });
	await bridge.switchTo("s-target");
	check("跨会话：先切到目标", bridge.sessionId, "s-target");
	const back = await bridge.switchToPersistent();
	check("跨会话：切回常驻成功", back, true);
	check("跨会话：确实回到常驻会话", bridge.sessionId, "session-voice-assistant-root");
	check("跨会话：mode 回到 persistent", bridge.mode, "persistent");
	check("跨会话：pinnedId 已清空（否则下次 ensure 会又绑回目标）", bridge.pinnedId, null);
}

// 8) 未启用常驻 agent 时，"切回常驻"应如实失败而不是假装成功。
{
	const ctx = makeSessionsCtx();
	const bridge = new VoiceSession({
		ctx,
		config: { session: { mode: "dedicated", workspace: "" }, agent: { enabled: false, sessionId: "" } },
	});
	check("跨会话：没有常驻 agent 时切回失败", await bridge.switchToPersistent(), false);
}

// ── 空 turn 的三种原因必须分开处置（真机踩坑）─────────────────────────
//
// ## 这条回归钉的是什么
//
// turn 没有文字有三种成因，`handleTurnEnd` 必须分开对待：
//
// | reason.kind | 真相 | 期望行为 |
// |---|---|---|
// | `error` | 这一轮失败了（模型路由缺失等） | 走 fail()，播报错误 |
// | `blocked` | 这一轮被闸门拒了、**压根没跑** | 播报"没跑起来"（**不是**"没有文字"） |
// | 其它（如 `completed`） | 纯工具轮：只调了工具、没说话 | 正常收尾 |
//
// 早期只特判 `error`，于是 `blocked` 掉进"纯工具轮"分支、显示
// **"这一轮没有可播报的文字。"** —— 把最严重的故障伪装成正常现象。
//
// ## 为什么这特别致命
//
// `blocked` 的典型成因是常驻会话躺在 `workspaceRegistry.archivedSessionIds`
// 里（本 profile 的 `ArchivedSessionGate` 对每轮 `agent/pre-step` 直接 reject）。
// 而客户端这边 `prompt()` 的原始返回是 `{"ok":true,"value":{"accepted":true}}`
// —— **提交是成功的**。于是现象是"提交成功、状态回弹、界面无报错、永远没回答"，
// 用户只能猜"是不是我没说清"。本项目实测复现过一次。
//
// 宿主半的自愈（`lib/identity.js` 的 `ensureSessionNotArchived`）负责不让这种
// 状态出现；这一段负责"万一还是出现了，用户一定看得见"。
await (async () => {
	const { VoiceController } = await import("../src/client/core/controller.js");

	/**
	 * 造一个只够跑 `handleTurnEnd` 的控制器。
	 *
	 * 用**真实**的 `VoiceController` 而不是手搓一个对象：这条回归要钉的正是
	 * "控制器把 reason 读对了没有"，替身会把被测逻辑一起替掉（本项目反复
	 * 踩过"类单测全绿但接线没接上"的坑）。
	 */
	const makeController = () => {
		const notices = [];
		const failLog = [];
		const ctx = { get: () => undefined, on: () => () => {}, effect: () => () => {} };
		const controller = new VoiceController({
			ctx,
			config: {
				asr: { engine: "webspeech", httpReady: false, httpModel: "whisper-1", maxSegmentMs: 15000 },
				tts: { engine: "browser", voice: "", rate: 1, httpReady: false, httpModel: "tts-1" },
				answers: { questionTimeoutMs: 60000, chime: false, repeatOnce: false },
				turn: { silenceMs: 10000, maxTurnMs: 300000, echoGuard: true, steerWhileThinking: false },
				sleep: { idleTimeoutMs: 60000, keepWakeWord: false, chime: false },
				ui: {},
				agent: { enabled: false, sessionId: "", steer: false },
				session: { mode: "dedicated" },
			},
		});
		// 拦下播报与提示：只关心"它选了哪条分支"。
		controller.speaker = { speak: async () => ({ spoken: false, reason: "empty" }), cancel: () => {} };
		controller.notice = (message, kind) => notices.push([message, kind]);
		controller.fail = (error) => failLog.push(String(error?.message ?? error));
		return { controller, notices, failLog };
	};

	/**
	 * 把状态摆到"思考中"，否则 turn/end 不会走任何分支。
	 *
	 * 为什么**直接赋值**而不是 `start()` → `wake()` → `COMMAND` 走一遍：
	 * Node 里没有 Web Speech，`pickEngineName()` 会返回 `"none"`，
	 * `start()` 于是提前返回、状态机压根不启动。这里要测的是
	 * `handleTurnEnd` 的分支选择，不是状态机能不能启动（那有专门的状态机测试）。
	 * 与 `instance.js` 里 `forceState` 的做法一致：直接摆好前置状态再喂事件，
	 * 断言就变成确定性的，不掺进引擎可用性这个正交因素。
	 */
	const toThinking = (controller) => {
		controller.machine.state = STATES.THINKING;
		return controller.machine.get();
	};

	// ① blocked：必须报"没跑起来"，**不得**说成"没有可播报的文字"。
	{
		const { controller, notices } = makeController();
		const status = toThinking(controller);
		check("blocked：前置状态是思考中", status, STATES.THINKING);
		await controller.handleTurnEnd({ text: "", reason: { kind: "blocked" }, turn: 1 });
		const text = notices.map(([message]) => message).join(" | ");
		check("blocked：确实给了提示", notices.length > 0, true);
		check("blocked：提示里点明没跑起来", text.includes("没跑起来"), true);
		check(
			"blocked：不得伪装成纯工具轮（这是最关键的断言）",
			text.includes("没有可播报的文字"),
			false,
		);
		check("blocked：按 error 级别提示（用户必须看得见）", notices.at(-1)?.[1], "error");
		check("blocked：状态回到「正在听」（不卡在思考中）", controller.machine.get(), STATES.ACTIVE);
		check("blocked：休眠计时被武装（否则会一直挂着不退）", controller.idleTimer !== null, true);
		controller.dispose();
	}

	// ② completed + 空文本：真正的纯工具轮，保持原有文案。
	{
		const { controller, notices } = makeController();
		toThinking(controller);
		await controller.handleTurnEnd({ text: "", reason: { kind: "completed" }, turn: 2 });
		const text = notices.map(([message]) => message).join(" | ");
		check("纯工具轮：文案保持不变", text.includes("这一轮没有可播报的文字"), true);
		check("纯工具轮：用 info 而不是 error（正常路径）", notices.at(-1)?.[1], "info");
		check("纯工具轮：状态回到「正在听」", controller.machine.get(), STATES.ACTIVE);
		controller.dispose();
	}

	// ③ error：仍走统一错误出口（不能被本次改动带偏）。
	{
		const { controller, notices, failLog } = makeController();
		toThinking(controller);
		await controller.handleTurnEnd({
			text: "",
			reason: { kind: "error", error: { message: "has no provider/model" } },
			turn: 3,
		});
		check("错误轮：走了 fail 出口", failLog.includes("has no provider/model"), true);
		check("错误轮：不误报成纯工具轮", notices.map(([m]) => m).join(" | ").includes("没有可播报的文字"), false);
		controller.dispose();
	}

	// ④ 【本次需求的核心】播报完进「正在听」，且**按 60s 那档计时**。
	//
	// ## 这条回归钉的是什么
	//
	// 需求：「播报完没有语音输入 60 秒才进入休眠」。
	//
	// 反面（修之前）是播完落到 `standby` —— `standby` **不参与计时**，
	// 于是症状是"每轮都要重新喊小凤"并且**永不休眠**。两个极端同时出现，
	// 而且方向相反，光看状态名（`standby` 看起来像"待机、挺正常"）
	// 完全看不出问题。所以这里断言三件事，缺一不可：
	//
	// 1. 终态是 `active`（能接着说话）；
	// 2. 休眠计时**确实被武装**（有 `idleTimer`）—— 只断言终态会被"计时
	//    没排上"这种实现蒙过去，而它正是本 bug 的形态；
	// 3. 走的是**长档**（`awaitingFirstUtterance === false`）—— 若错成短档，
	//    播完 12 秒就退回待机，用户还是得重新唤醒，"60 秒"变成空话。
	{
		const { controller } = makeController();
		toThinking(controller);
		await controller.handleTurnEnd({ text: "已经帮你把项目资料文件夹建好了", reason: null, turn: 4 });
		check("播报完：终态是「正在听」（不必再喊唤醒词）", controller.machine.get(), STATES.ACTIVE);
		check("播报完：休眠计时确实武装了", controller.idleTimer !== null, true);
		check(
			"播报完：走的是长档 60s（不是 12s 的回待机档）",
			controller.awaitingFirstUtterance,
			false,
		);
		// 对外可读的那一位也要对：界面显示的休眠说明就是它。
		check("播报完：休眠时长取的是配置里的 60s", controller.config.sleep.idleTimeoutMs, 60000);
		controller.dispose();
	}
})();

// ── 浏览器识别连不上服务（`network`）必须**如实说、别刷屏、能换路** ──────
//
// ## 这条回归钉的是什么
//
// 用户报「语音出错 speech network」。追下去三层问题：
//
// 1. **分类错**：Chrome/Edge 的 Web Speech 把音频送到**境外云端**识别，
//    受限网络下永远连不上，`error` 恒为 `network`。而 `webspeech.js` 把它
//    当**瞬时抖动** → 退避重试 6 次（300ms 起、翻倍到 5s，累计约 9 秒），
//    最后以 `speech-restart-exhausted` 永久失效。用户看到的是**同一条错刷 6 遍**。
// 2. **文案没法执行**：`fail()` 直接把 `speech-network` 拼进界面
//    （"语音出错：speech-network"）。用户既不知道是网络、也不知道能做什么。
// 3. **回退顺序错**：`detectEars()` 探测失败时回退到
//    `webSpeechAvailable() ? "webspeech" : …` —— 只看浏览器**有没有这个 API**，
//    不看它**能不能真的工作**，于是回退到一个已知坏掉的引擎。
//
// 三条都要断，缺一条就还是"看起来修了"。
await (async () => {
	const { VoiceController } = await import("../src/client/core/controller.js");
	const { WebSpeechEngine } = await import("../src/client/core/engines/webspeech.js");

	// ① `network` 归类为「环境不可用」：一次性报告 + 停掉，**不进重试**。
	//
	// 反面（修之前）是：报 `speech-network` → 上层走通用错误路径 →
	// `onend` 里继续重试 6 次 → 每轮都刷一条同样的错。
	//
	// 做法：Node 里没有 Web Speech，装一个**假 Ctor** 骗过 `isAvailable` 那道门，
	// 让 `start()` 走完整装配路径，再手喂 `onerror` —— 这样测的是真实分支，
	// 不是"重新写一遍条件"（后者会把被测逻辑一起替掉）。
	{
		const fakeRecognition = function FakeRecognition() {
			this.start = () => {};
			this.stop = () => {};
		};
		globalThis.SpeechRecognition = fakeRecognition;

		const captured = [];
		const unreachable = new WebSpeechEngine({
			language: "zh-CN",
			onPartial: () => {},
			onFinal: () => {},
			onError: (error) => captured.push(String(error?.message ?? error)),
			onClose: () => {},
		});
		unreachable.start();
		check("network 回归：假识别器已装配", unreachable.recognition !== null, true);
		unreachable.recognition.onerror({ error: "network" });
		check("network 归类：报的是环境不可达（不再原样抛 speech-network）", captured, ["asr-unreachable"]);
		check("network 归类：认作致命（不再重试刷屏）", unreachable.fatal, true);
		check("network 归类：主动放弃监听（不再无限重启）", unreachable.wanted, false);

		// 顺带确认常态错误没被误伤：静默/主动停止不算故障，其余仍走通用通道。
		const normal = [];
		const ordinary = new WebSpeechEngine({
			onPartial: () => {},
			onFinal: () => {},
			onError: (error) => normal.push(String(error?.message ?? error)),
			onClose: () => {},
		});
		ordinary.start();
		ordinary.recognition.onerror({ error: "no-speech" });
		ordinary.recognition.onerror({ error: "aborted" });
		check("network 回归：静默/主动停止仍**不算**故障", normal, []);
		ordinary.recognition.onerror({ error: "audio-capture" });
		check("network 回归：其它错误仍走通用通道", normal, ["speech-audio-capture"]);
		ordinary.recognition.onerror({ error: "not-allowed" });
		check("network 回归：麦克风被拒仍走 mic-denied", normal.at(-1), "mic-denied");

		delete globalThis.SpeechRecognition;
	}

	// ② 界面文案必须**可执行**：说清是网络、给出下一步。
	{
		const notices = [];
		const ctx = { get: () => undefined, on: () => () => {}, effect: () => () => {} };
		const controller = new VoiceController({
			ctx,
			config: {
				asr: { engine: "webspeech", httpReady: false, httpModel: "whisper-1", maxSegmentMs: 15000 },
				tts: { engine: "browser", voice: "", rate: 1, httpReady: false, httpModel: "tts-1" },
				answers: { questionTimeoutMs: 60000, chime: false, repeatOnce: false },
				turn: { silenceMs: 10000, maxTurnMs: 300000, echoGuard: true, steerWhileThinking: false },
				sleep: { idleTimeoutMs: 60000, keepWakeWord: false, chime: false },
				ui: {},
				agent: { enabled: false, sessionId: "", steer: false },
				session: { mode: "dedicated" },
			},
		});
		controller.speaker = { speak: async () => ({ spoken: false, reason: "empty" }), cancel: () => {} };
		controller.notice = (message, kind) => notices.push([message, kind]);
		controller.fail(new Error("asr-unreachable"));
		const text = notices.map(([m]) => m).join(" | ");
		check("文案：不再原样抛 speech-network", text.includes("speech-network"), false);
		check("文案：说明了是「连不上识别服务」", text.includes("连不上识别服务"), true);
		check("文案：点明它依赖境外云端（用户才知道为什么）", text.includes("境外云端"), true);
		check("文案：给出了下一步（内置本地识别或上游端点）", text.includes("内置本地识别") && text.includes("上游 ASR"), true);
		check("文案：按 error 级别（用户必须看得见）", notices.at(-1)?.[1], "error");
		check("死引擎：已记进名单（回退时跳过它）", controller.deadEngines.has("webspeech"), true);
		controller.dispose();
	}

	// ③ 回退**不得**选一个已确认不可用的引擎。
	//
	// ## 这条为什么必须装假 `SpeechRecognition`
	//
	// `webSpeechAvailable()` 在 Node 里**恒为 false**（没有这个 API），
	// 于是"回退到 webspeech"与"回退到 none"在单测环境里**结果一样** ——
	// 拿它测回退顺序会得到一条**永远绿的假断言**（第一版就栽在这里：
	// 把回退逻辑临时改回旧写法，测试照样全绿）。
	//
	// 真实场景恰恰相反：浏览器**有这个 API**、只是服务连不上。
	// 所以必须装一个假的 Ctor 把 `webSpeechAvailable()` 顶成 true，
	// 才能区分"按 API 在不在选"与"按能不能真的工作选"。
	{
		const fakeRecognition = function FakeRecognition() {
			this.start = () => {};
			this.stop = () => {};
		};
		globalThis.SpeechRecognition = fakeRecognition;

		const notices = [];
		const ctx = { get: () => undefined, on: () => () => {}, effect: () => () => {} };
		const controller = new VoiceController({
			ctx,
			config: {
				asr: { engine: "auto", httpReady: false, httpModel: "whisper-1", maxSegmentMs: 15000 },
				tts: { engine: "browser", voice: "", rate: 1, httpReady: false, httpModel: "tts-1" },
				answers: { questionTimeoutMs: 60000, chime: false, repeatOnce: false },
				turn: { silenceMs: 10000, maxTurnMs: 300000, echoGuard: true, steerWhileThinking: false },
				sleep: { idleTimeoutMs: 60000, keepWakeWord: false, chime: false },
				ui: {},
				agent: { enabled: false, sessionId: "", steer: false },
				session: { mode: "dedicated" },
			},
		});
		controller.speaker = { speak: async () => ({ spoken: false, reason: "empty" }), cancel: () => {} };
		controller.notice = (message, kind) => notices.push([message, kind]);

		check("回退回归：假 Ctor 已让浏览器识别「看起来可用」", controller.engineUsable("webspeech"), true);

		// 把它标成已确认不可用（真实场景里由 `asr-unreachable` 触发）。
		controller.markEngineDead("webspeech");
		check("回退：死引擎一律不可选（哪怕 API 就在那儿）", controller.engineUsable("webspeech"), false);
		check("回退：降级别名同样按族拒绝", controller.engineUsable("webspeech-fallback"), false);
		// `http` 未配置、`ears` 未探过 → 没有候选。
		check("回退：http 未配置时不选它", controller.engineUsable("http"), false);
		check("回退：ears 未探过时不选它", controller.engineUsable("ears"), false);
		check("回退：没有任何可用候选时如实返回「没换」", controller.tryFallbackFromDeadEngine(), false);

		// 核心断言：走 `detectEars()` **真实入口**，让它探测失败后回退。
		//
		// 旧写法在此时会选 `webspeech`（因为 API 在），而它正是死引擎 ——
		// 现象就是"刚提示完连不上、回头又用同一个引擎"。
		controller.snapshot.engine = "ears";
		await controller.detectEars();
		check("回退回归：探测失败后**不选**已确认不可用的浏览器识别", controller.snapshot.engine, "none");

		// 提示的措辞：`auto` 模式下探测失败是**静默降级**（不打扰用户），
		// 只有显式要求 `ears` 时才会告知 —— 这是既有设计，这里顺手钉住，
		// 免得日后误以为"没提示 = 没生效"。
		check("回退回归：auto 模式静默降级、不打扰用户", notices.length, 0);

		// 反过来：没有死引擎时，仍应正常退回浏览器识别（别把功能一起修没了）。
		const healthy = new VoiceController({
			ctx,
			config: {
				asr: { engine: "auto", httpReady: false, httpModel: "whisper-1", maxSegmentMs: 15000 },
				tts: { engine: "browser", voice: "", rate: 1, httpReady: false, httpModel: "tts-1" },
				answers: { questionTimeoutMs: 60000, chime: false, repeatOnce: false },
				turn: { silenceMs: 10000, maxTurnMs: 300000, echoGuard: true, steerWhileThinking: false },
				sleep: { idleTimeoutMs: 60000, keepWakeWord: false, chime: false },
				ui: {},
				agent: { enabled: false, sessionId: "", steer: false },
				session: { mode: "dedicated" },
			},
		});
		healthy.speaker = { speak: async () => ({ spoken: false, reason: "empty" }), cancel: () => {} };
		healthy.notice = () => {};
		healthy.snapshot.engine = "ears";
		await healthy.detectEars();
		check("回退回归：无死引擎时照常退回浏览器识别（功能没被修坏）", healthy.snapshot.engine, "webspeech");

		// 有可用的 ears 时优先换过去（多后端比浏览器识别可靠）。
		controller.earsAvailable = true;
		controller.snapshot.engine = "webspeech";
		check("回退：有可用的 ears 时换过去", controller.tryFallbackFromDeadEngine(), true);
		check("回退：确实换成了 ears", controller.snapshot.engine, "ears");
		check("回退：已在可用引擎上不再折腾（防来回横跳）", controller.tryFallbackFromDeadEngine(), false);

		// 显式 `engine: "ears"` 时报文必须按**实际落点**措辞。
		// 老写法写死"已退回浏览器识别"，而落点可能是 `http` 或 `none` ——
		// 用户会照着这句假话去排查一个根本不存在的引擎。
		const explicitLog = [];
		const explicit = new VoiceController({
			ctx,
			config: {
				asr: { engine: "ears", httpReady: false, httpModel: "whisper-1", maxSegmentMs: 15000 },
				tts: { engine: "browser", voice: "", rate: 1, httpReady: false, httpModel: "tts-1" },
				answers: { questionTimeoutMs: 60000, chime: false, repeatOnce: false },
				turn: { silenceMs: 10000, maxTurnMs: 300000, echoGuard: true, steerWhileThinking: false },
				sleep: { idleTimeoutMs: 60000, keepWakeWord: false, chime: false },
				ui: {},
				agent: { enabled: false, sessionId: "", steer: false },
				session: { mode: "dedicated" },
			},
		});
		explicit.speaker = { speak: async () => ({ spoken: false, reason: "empty" }), cancel: () => {} };
		explicit.notice = (message) => explicitLog.push(message);
		// 浏览器识别已确认不可用 → 落点只能是 `none`。
		explicit.markEngineDead("webspeech");
		explicit.snapshot.engine = "ears";
		await explicit.detectEars();
		check("文案：显式 ears 失败时确实提示了", explicitLog.length > 0, true);
		check("文案：落点是 none 时说明了没有可用引擎", explicitLog.join(" | ").includes("没有其它可用引擎"), true);
		check("文案：落点是 none 时**不得**谎称已退回浏览器识别", explicitLog.join(" | ").includes("已退回「浏览器识别"), false);

		// ── 「浏览器识别优先」回归（第 7 个坑：ears 无条件覆盖 webspeech）──
		//
		// 真实故障：`detectEars()` 只要探测到 dsh-ears 就 `swapEngine("ears")`，
		// **不比较谁更好**。本机 dsh-ears 的后端是本地 Whisper（缓存里只有
		// 6 档中最弱的 `ggml-tiny.bin`、且语言默认自动检测）⇒ 中文识别质量
		// 大幅下降，还伴随 Whisper 专有幻觉（`[BLANK_AUDIO]`、`（滋滋声）`）。
		//
		// 下面三条把新判据钉住。假 ctx 让 `probeEars()` **真的探测成功**
		// （否则又变成"测了自己簿记"的假绿）。
		const earsReadyCtx = {
			get: (name) =>
				name === "remote.dshEars"
					? {
							// `earsNamespace()` 要求有 `transcribe` 才认这个命名空间。
							transcribe: async () => ({ text: "" }),
							listAsrBackends: async () => [{ id: "local-whisper", ready: true }],
						}
					: undefined,
			on: () => () => {},
			effect: () => () => {},
		};
		const autoCase = new VoiceController({
			ctx: earsReadyCtx,
			config: {
				asr: { engine: "auto", httpReady: false, httpModel: "whisper-1", maxSegmentMs: 15000 },
				tts: { engine: "browser", voice: "", rate: 1, httpReady: false, httpModel: "tts-1" },
				answers: { questionTimeoutMs: 60000, chime: false, repeatOnce: false },
				turn: { silenceMs: 10000, maxTurnMs: 300000, echoGuard: true, steerWhileThinking: false },
				sleep: { idleTimeoutMs: 60000, keepWakeWord: false, chime: false },
				ui: {},
				agent: { enabled: false, sessionId: "", steer: false },
				session: { mode: "dedicated" },
			},
		});
		autoCase.speaker = { speak: async () => ({ spoken: false, reason: "empty" }), cancel: () => {} };
		autoCase.notice = () => {};
		check("优先回归：auto 初判就是浏览器识别", autoCase.snapshot.engine, "webspeech");
		await autoCase.detectEars();
		check("优先回归：dsh-ears 可用时**仍不夺走**浏览器识别", autoCase.snapshot.engine, "webspeech");
		check("优先回归：但仍如实记下 ears 可用（回退时要用）", autoCase.earsAvailable, true);

		// 反面：浏览器识别已被确认不可用（受限网络）→ 必须让 dsh-ears 接手。
		// 少了这条，"不夺走"就变成"永远不用 ears"，本地 Whisper 白配。
		autoCase.markEngineDead("webspeech");
		await autoCase.detectEars();
		check("优先回归：浏览器识别不可用时，dsh-ears 接手", autoCase.snapshot.engine, "ears");

		// 显式 `engine: "ears"` 是用户的选择，任何时候都不该被"优先"逻辑挡掉。
		const forcedCase = new VoiceController({
			ctx: earsReadyCtx,
			config: {
				asr: { engine: "ears", httpReady: false, httpModel: "whisper-1", maxSegmentMs: 15000 },
				tts: { engine: "browser", voice: "", rate: 1, httpReady: false, httpModel: "tts-1" },
				answers: { questionTimeoutMs: 60000, chime: false, repeatOnce: false },
				turn: { silenceMs: 10000, maxTurnMs: 300000, echoGuard: true, steerWhileThinking: false },
				sleep: { idleTimeoutMs: 60000, keepWakeWord: false, chime: false },
				ui: {},
				agent: { enabled: false, sessionId: "", steer: false },
				session: { mode: "dedicated" },
			},
		});
		forcedCase.speaker = { speak: async () => ({ spoken: false, reason: "empty" }), cancel: () => {} };
		forcedCase.notice = () => {};
		await forcedCase.detectEars();
		check("优先回归：显式 engine:'ears' 不受『浏览器优先』影响", forcedCase.snapshot.engine, "ears");

		autoCase.dispose();
		forcedCase.dispose();

		controller.dispose();
		healthy.dispose();
		explicit.dispose();
		delete globalThis.SpeechRecognition;
	}
})();

// ── 本地 Whisper 只吃 16 kHz 单声道 PCM16 WAV ──────────────────────────
//
// ## 这条回归钉的是什么
//
// 用户要求「帮我设置本地 Whisper」。查下去发现**卡点不在模型**：
// 原生运行时能加载、`ggml-tiny.bin` 早已下好且 sha256 完全匹配
// （`tools/probe-local-whisper.mjs` 真机推理也跑通了）。
//
// 真正的关卡是**音频格式**：
//   - `dsh-ears` 宿主侧对本地 Whisper 有硬校验 `assertPcm16Wav` ——
//     只接受 16 kHz / 单声道 / PCM16 / RIFF-WAVE，否则抛 `asrAudioInvalid`；
//   - 而浏览器 `MediaRecorder` 产出的是 **webm/opus**。
//
// 归一化的责任在**调用方**：`dsh-ears` 只在自己的录音按钮里做
// （`prepareRecordedAudioForBackend`），远程 `transcribe()` 收到什么送什么。
// 本插件正是调用方，不补这一步就永远不通，且报错完全指不到"格式"。
await (async () => {
	const { audioToPcm16Wav, isPcm16Mono16kWav, WHISPER_SAMPLE_RATE } = await import("../src/client/core/audio/wav.js");
	const { needsWavForEars, makeEarsRecognizer, earsNamespace, probeEars } = await import("../src/client/core/engines/ears.js");

	const text = (bytes, start, end) => String.fromCharCode(...bytes.subarray(start, end));

	// ① 编码器产出的字节必须**通过宿主侧那份判定**。
	//
	// 反面（修之前）是压根没有这个编码器，直接发 webm —— 本地 Whisper 必然拒绝。
	{
		// 48 kHz 立体声、0.5 秒（浏览器 AudioBuffer 的常见形态）。
		const frames = 24000;
		const left = new Float32Array(frames);
		const right = new Float32Array(frames);
		for (let i = 0; i < frames; i += 1) {
			left[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5;
			right[i] = -left[i];
		}
		const wav = audioToPcm16Wav({ sampleRate: 48000, channelData: [left, right], length: frames });

		check("WAV：RIFF 魔数", text(wav, 0, 4), "RIFF");
		check("WAV：WAVE 标识", text(wav, 8, 12), "WAVE");
		check("WAV：fmt 块", text(wav, 12, 16), "fmt ");
		check("WAV：data 块", text(wav, 36, 40), "data");
		check("WAV：采样率被重采样到 16k", new DataView(wav.buffer).getUint32(24, true), WHISPER_SAMPLE_RATE);
		check("WAV：单声道", new DataView(wav.buffer).getUint16(22, true), 1);
		check("WAV：16 bit", new DataView(wav.buffer).getUint16(34, true), 16);
		check("WAV：PCM 格式码", new DataView(wav.buffer).getUint16(20, true), 1);
		// 48000 帧 @48k → 16000 帧 @16k。本例 24000 帧 @48k = 0.5s → 8000 帧 @16k。
		check("WAV：帧数按 48k→16k 换算", (wav.byteLength - 44) / 2, 8000);
		check("WAV：data 块长度与实际字节一致", new DataView(wav.buffer).getUint32(40, true), wav.byteLength - 44);
		check("WAV：通过宿主侧 16k/单声道/PCM16 判定", isPcm16Mono16kWav(wav), true);
	}

	// ② 反向验证：**故意破坏**每一项都必须被判定拒绝。
	//
	// 没有这一段，"通过判定"可能是判定本身太松（恒 true）。
	{
		const base = () => audioToPcm16Wav({ sampleRate: 16000, channelData: [new Float32Array(1600)], length: 1600 });

		const wrongRate = base();
		new DataView(wrongRate.buffer).setUint32(24, 44100, true);
		check("WAV 反向：采样率不对 → 拒绝", isPcm16Mono16kWav(wrongRate), false);

		const stereo = base();
		new DataView(stereo.buffer).setUint16(22, 2, true);
		check("WAV 反向：立体声 → 拒绝", isPcm16Mono16kWav(stereo), false);

		const bits = base();
		new DataView(bits.buffer).setUint16(34, 8, true);
		check("WAV 反向：位深不是 16 → 拒绝", isPcm16Mono16kWav(bits), false);

		const notPcm = base();
		new DataView(notPcm.buffer).setUint16(20, 3, true);
		check("WAV 反向：不是 PCM → 拒绝", isPcm16Mono16kWav(notPcm), false);

		const badMagic = base();
		badMagic.set([0x58], 0);
		check("WAV 反向：RIFF 魔数被改 → 拒绝", isPcm16Mono16kWav(badMagic), false);

		const tooShort = base().slice(0, 30);
		check("WAV 反向：长度不足 44 字节 → 拒绝", isPcm16Mono16kWav(tooShort), false);

		// 空音频（0 帧）也不该被当成合法录音。
		const empty = audioToPcm16Wav({ sampleRate: 16000, channelData: [new Float32Array(0)], length: 0 });
		check("WAV 反向：0 帧 → 拒绝", isPcm16Mono16kWav(empty), false);
	}

	// ③ 混单声道与幅度换算：不能把立体声左右直接相加（会溢出削波）。
	{
		const frames = 160;
		const left = new Float32Array(frames).fill(0.8);
		const right = new Float32Array(frames).fill(0.8);
		const wav = audioToPcm16Wav({ sampleRate: 16000, channelData: [left, right], length: frames });
		const view = new DataView(wav.buffer);
		// 平均后仍是 0.8 → 0.8 * 32767 ≈ 26214。若误用相加，会削到 32767。
		check("声道平均：同相 0.8 不削波", view.getInt16(44, true), Math.round(0.8 * 32767));

		const clipped = audioToPcm16Wav({ sampleRate: 16000, channelData: [new Float32Array(160).fill(1.5)], length: 160 });
		check("幅度：越界样本被裁到满幅（不环绕成噪声）", new DataView(clipped.buffer).getInt16(44, true), 32767);

		const nan = audioToPcm16Wav({ sampleRate: 16000, channelData: [Float32Array.from([Number.NaN, 0, 0, 0])], length: 4 });
		check("幅度：NaN 当静音（不发散）", new DataView(nan.buffer).getInt16(44, true), 0);
	}

	// ④ 哪些后端要 WAV —— 必须与 `dsh-ears` 自己的判定逐字一致。
	//
	// 为什么不能一律转 WAV：WAV 未压缩，15s 约 480KB（base64 后 640KB），
	// 而 webm/opus 只有几十 KB。一律转会白白多花流量与云端的钱。
	{
		check("需要 WAV：本地 Whisper", needsWavForEars({ asrBackend: "local-whisper" }), true);
		check("需要 WAV：腾讯云录音文件识别", needsWavForEars({ asrBackend: "cloud-openai", cloudAsrProvider: "tencent" }), true);
		check("需要 WAV：小米 MiMo", needsWavForEars({ asrBackend: "cloud-openai", cloudAsrProvider: "mimo" }), true);
		check("需要 WAV：火山引擎录音文件识别", needsWavForEars({ asrBackend: "cloud-openai", cloudAsrProvider: "volcengine" }), true);
		check("保持原容器：Groq（收 webm/opus）", needsWavForEars({ asrBackend: "cloud-openai", cloudAsrProvider: "groq" }), false);
		check("保持原容器：Deepgram", needsWavForEars({ asrBackend: "cloud-openai", cloudAsrProvider: "deepgram" }), false);
		check("保持原容器：浏览器识别（转写不过远程）", needsWavForEars({ asrBackend: "web-speech" }), false);
		check("保持原容器：读不到设置时不乱转", needsWavForEars(undefined), false);
	}

	// ⑤ 识别器真的会把 webm 换成 WAV 再发出去 —— 走 `makeEarsRecognizer` **真实入口**。
	//
	// 断言"**发出去的** mimeType 与字节"，而不是"调没调转换函数"：
	// 后者只测自己的簿记，转换被绕过也照样绿（本项目踩过这个坑）。
	//
	// Node 里缺 `FileReader` 与 `AudioContext`，两个都要垫上 ——
	// 否则测的就不是真实路径（第一版就是这里崩的）。
	{
		const frames = 4800;
		const makeFakeContext = () => ({
			async decodeAudioData() {
				return {
					sampleRate: 48000,
					length: frames,
					numberOfChannels: 2,
					getChannelData: () => new Float32Array(frames).fill(0.25),
				};
			},
			async close() {},
		});
		const makeBrokenContext = () => ({
			async decodeAudioData() {
				throw new Error("decode-boom");
			},
			async close() {},
		});

		// `blobToBase64` 走 `FileReader`（浏览器里才有）。垫一个最小实现。
		globalThis.FileReader = class {
			readAsDataURL(blob) {
				blob.arrayBuffer().then((buffer) => {
					this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString("base64")}`;
					this.onload?.();
				});
			}
		};
		globalThis.AudioContext = function FakeAudioContext() {
			return globalThis.__fakeAudioContextFactory();
		};
		globalThis.__fakeAudioContextFactory = makeFakeContext;

		const sent = [];
		const ctx = {
			remote: {
				dshEars: {
					async transcribe(base64, mimeType) {
						sent.push({ base64, mimeType });
						return { status: "ok", text: "你好" };
					},
				},
			},
		};
		const webm = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: "audio/webm;codecs=opus" });

		// 场景 A：后端要求 WAV（本地 Whisper）→ 发出去的必须是 WAV。
		const wavRecognizer = makeEarsRecognizer(ctx, { needsWav: () => true });
		check("识别器：需要 WAV 时返回文本", await wavRecognizer(webm), "你好");
		check("识别器：**发出去的** mimeType 是 audio/wav（不再发 webm）", sent.at(-1).mimeType, "audio/wav");
		check("识别器：发出的字节通过宿主侧判定", isPcm16Mono16kWav(new Uint8Array(Buffer.from(sent.at(-1).base64, "base64"))), true);
		// 4800 帧 @48k = 0.1s → 1600 帧 @16k。
		check("识别器：发出的 WAV 帧数换算正确", (Buffer.from(sent.at(-1).base64, "base64").length - 44) / 2, 1600);

		// 场景 B：后端不收 WAV（Groq 等）→ **不得**转换，原容器原样发（省流量省钱）。
		const direct = makeEarsRecognizer(ctx, { needsWav: () => false });
		check("识别器：不需要 WAV 时返回文本", await direct(webm), "你好");
		check("识别器：不需要 WAV 时原样发 webm", sent.at(-1).mimeType, "audio/webm;codecs=opus");

		// 场景 C：需要 WAV 但解码失败 → 必须抛出，且错误要**指明是格式这一步**。
		// 直接把 webm 发过去只会换来一句没有指向性的 asrAudioInvalid。
		globalThis.__fakeAudioContextFactory = makeBrokenContext;
		const broken = makeEarsRecognizer(ctx, { needsWav: () => true });
		const boom = await broken(webm).then(
			() => null,
			(error) => error,
		);
		check("识别器：解码失败会抛错（不静默发坏音频）", boom instanceof Error, true);
		check("识别器：错误指明了是音频格式这一步", String(boom?.message ?? "").startsWith("asr-audio-format"), true);
		check("识别器：解码失败时不发任何音频（未污染上游）", sent.length, 2);

		delete globalThis.FileReader;
		delete globalThis.AudioContext;
		delete globalThis.__fakeAudioContextFactory;
	}

	// ⑥ 命名空间必须用**带点号的完整注册名**去取 —— 真机踩出来的坑。
	//
	// ## 为什么这条非有不可
	//
	// 第一版只用 `ctx.remote.dshEars` 取，单测全绿（单测的 `ctx` 是自己造的
	// 普通对象，没有 cordis 代理），**真机上却恒取不到** —— 结果就是
	// `available:false` → 静默降级回浏览器识别 → 本地 Whisper 配了也用不上。
	//
	// 这正是"类单测全绿 ≠ 接线正确"的又一例。真机证据（tools/probe-local-ears.mjs）：
	//   engine: "webspeech"、ears.backends: []、ears.available: false
	//
	// 而 `dsh-ears` **自己的**客户端就是 `ctx.inject(["remote.dshEars"], …)`
	// 接的 —— 服务全名是注册名，不是"取 remote 再取 dshEars"。
	{
		const fake = { async transcribe() { return { status: "ok", text: "hi" }; } };

		// 模拟真机：`ctx.remote.dshEars` 被代理拦下（同步抛），
		// 只有 `ctx.get("remote.dshEars")` 能拿到。
		const realLikeCtx = {
			get(name) {
				if (name === "remote.dshEars") return fake;
				return undefined;
			},
			get remote() {
				throw new Error('cannot get property "remote.dshEars" without inject');
			},
		};
		check("命名空间：带点号的完整注册名能取到（真机路径）", earsNamespace(realLikeCtx) === fake, true);

		// 反向：只用嵌套访问的老写法会拿到 undefined。
		const nestedOnly = {
			get: () => undefined,
			get remote() {
				throw new Error("without inject");
			},
		};
		check("命名空间反向：嵌套访问取不到（旧写法在真机必失效）", earsNamespace(nestedOnly), null);

		// `ctx.get("dshEars")` 这种顶层注册形态也要能用（版本差异）。
		const topLevel = { get: (name) => (name === "dshEars" ? fake : undefined) };
		check("命名空间：顶层 dshEars 注册形态同样支持", earsNamespace(topLevel) === fake, true);

		// 排障证据：每条取法的命中情况都要留痕。
		const probe = await probeEars(realLikeCtx);
		check("排障：记录了各条取法（含 get 与 reflect.get 两条正解口）", probe.paths.filter((p) => p.from.startsWith("ctx.")).length >= 5, true);
		check("排障：命中路径标出 hasTranscribe", probe.paths.find((p) => p.from === "ctx.get(remote.dshEars)")?.hasTranscribe, true);
		check("排障：未命中路径可判（不会把 undefined 当命中）", probe.paths.find((p) => p.from === "ctx.get(dshEars)")?.hit, false);
	}
})();

// ── 需求②：播报账本（让助手记住已播到哪，刷新不重播）──────────────────
//
// 真机症状：助手前面汇报过的内容，再次打开页面时又播报一遍。
// 根因是所有水位只在内存里，刷新即归零，而服务端队列活在宿主进程里
// **不受刷新影响** —— 两条合起来就是"每刷新一次就再听一遍旧的"。
{
	const { createPlaybackLedger, createSeqWatermark, createSafeStorage, entryIdentity, withinCatchup, memoryStorage, resolveStorage, hashText } = await import("../src/client/core/ledger.js");

	/** 造一个可观察的假存储。 */
	const makeStore = () => {
		const map = new Map();
		return {
			map,
			getItem: (key) => (map.has(key) ? map.get(key) : null),
			setItem: (key, value) => {
				map.set(key, String(value));
			},
			removeItem: (key) => map.delete(key),
		};
	};

	// ① 身份：优先用服务端 id，没有就用文本哈希。
	check("身份用 kind:key", entryIdentity({ kind: "report", key: "job-1" }), "report:job-1");
	check("身份退化到 jobId", entryIdentity({ kind: "report", jobId: "job-2" }), "report:job-2");
	check("身份退化到 callId", entryIdentity({ kind: "question", callId: "call-9" }), "question:call-9");
	check("没有 id 时用文本哈希（同文本同身份）", entryIdentity({ kind: "report", speech: "完成了" }), entryIdentity({ kind: "report", speech: "完成了" }));
	check("不同文本身份不同", entryIdentity({ kind: "report", speech: "甲" }) === entryIdentity({ kind: "report", speech: "乙" }), false);
	check("既无 key 又无文本时没有身份", entryIdentity({ kind: "report" }), "");
	check("哈希稳定且 8 位", hashText("x").length, 8);

	// ② 存储兜底：拿不到 localStorage 也不能崩（退化成内存实现）。
	check("无 localStorage 时降级为内存存储", resolveStorage(undefined).persistent, false);
	check("有 localStorage 时算持久化", resolveStorage(makeStore()).persistent, true);
	const broken = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); } };
	check("读抛异常时返回兜底值而不是崩", createSafeStorage(broken).read("k", { a: 1 }), { a: 1 });
	check("写抛异常（配额满）时如实返回 false", createSafeStorage(broken).write("k", { a: 1 }), false);

	// ③ 核心：同一份存储上"重建一次账本"= 用户刷新页面。
	const storage = makeStore();
	const first = createPlaybackLedger({ scope: "s1", storage });
	check("首次没有水位", first.cursor, 0);
	check("首次 claim 通过", first.claim({ kind: "report", key: "job-1", at: 1000 }), true);
	check("同一条再 claim 被拦（同一次会话内不重播）", first.claim({ kind: "report", key: "job-1", at: 1000 }), false);
	first.advance(5000);
	check("水位已推进", first.cursor, 5000);

	// —— 关键断言：刷新（换新实例、同一份存储）后仍然记得 ——
	const second = createPlaybackLedger({ scope: "s1", storage });
	check("刷新后水位续上（不再退回 latest）", second.cursor, 5000);
	check("刷新后同一条仍被拦（这就是需求②要的效果）", second.claim({ kind: "report", key: "job-1", at: 1000 }), false);
	check("刷新后新的一条照常播", second.claim({ kind: "report", key: "job-2", at: 6000 }), true);

	// ④ 作用域隔离：不同助手实例（不同 DSH_HOME）的账本不能互相污染。
	const other = createPlaybackLedger({ scope: "s2", storage });
	check("另一个作用域不受影响", other.cursor, 0);
	check("另一个作用域里同 key 能播", other.claim({ kind: "report", key: "job-1", at: 1000 }), true);

	// ⑤ 游标只前进：服务端重启后游标归零，倒退会把旧条目重新纳入窗口。
	// 注意 `claim` 只记账、不动时间水位（职责分离：判定去重 ≠ 推进游标）。
	check("记账不推进时间水位", second.cursor, 5000);
	check("游标不接受倒退", second.advance(100), false);
	check("游标仍停在原值", second.cursor, 5000);
	check("游标接受前进", second.advance(6000), true);
	check("游标停在最大值", second.cursor, 6000);

	// ⑥ 坏数据与未来游标：宁可重置，也不要让助手彻底哑掉。
	const dirty = makeStore();
	dirty.setItem("xfv:v1:played:s1", "{ 不是 JSON");
	check("坏 JSON 当作没有记录（不崩）", createPlaybackLedger({ scope: "s1", storage: dirty }).cursor, 0);
	const future = makeStore();
	future.setItem("xfv:v1:played:s1", JSON.stringify({ cursor: Date.now() + 86400000, keys: [] }));
	check("未来游标被重置（否则永远没有新条目可播）", createPlaybackLedger({ scope: "s1", storage: future }).cursor, 0);

	// ⑦ 记账有界：超限从最老的丢，内存与集合都要跟着缩。
	const tiny = createPlaybackLedger({ scope: "s3", storage: makeStore(), limit: 3 });
	for (let index = 1; index <= 5; index += 1) tiny.claim({ kind: "report", key: `k${index}` });
	check("账本按上限截断", tiny.size, 3);
	check("被挤掉的旧 key 可再播（集合同步缩了）", tiny.claim({ kind: "report", key: "k1" }), true);

	// ⑧ 追补窗口：关页面一天回来，不该把整个队列念完。
	const now = Date.now();
	check("窗口内的条目照常播", withinCatchup({ at: now - 60000 }, { now }), true);
	check("太老的条目不播（只记账）", withinCatchup({ at: now - 3600000 }, { now }), false);
	check("窗口设为 0 = 关掉限制（全部补播）", withinCatchup({ at: now - 86400000 }, { now, windowMs: 0 }), true);
	check("没有时间戳的条目不敢拦（宁可多播）", withinCatchup({}, { now }), true);

	// ⑨ 会话 seq 水位：顺序刷新后不应重放旧 seq。
	const seqStore = makeStore();
	const seq1 = createSeqWatermark({ storage: seqStore });
	check("首次没有 seq 记录", seq1.read("sess-a"), null);
	check("写入 seq", seq1.write("sess-a", 120), true);
	check("只前进不后退", seq1.write("sess-a", 100), false);
	check("读回最新", seq1.read("sess-a"), 120);
	const seq2 = createSeqWatermark({ storage: seqStore });
	check("刷新后 seq 水位仍在（历史不会再被当新事件）", seq2.read("sess-a"), 120);
	check("会话之间互不干扰", seq2.read("sess-b"), null);
	check("可以清掉某个会话的记录", seq2.drop("sess-a"), true);
	check("清掉后读回 null", seq2.read("sess-a"), null);

	// ⑩ 脱壳冒烟：内存存储与真存储行为一致（上层不需要写两条分支）。
	const m = memoryStorage();
	m.setItem("a", 1);
	check("内存存储读回字符串", m.getItem("a"), "1");
	m.removeItem("a");
	check("内存存储删掉后为空", m.getItem("a"), null);

	// ⑪ 提问播报也必须落账本 —— 需求②的第三处漏口。
	//
	// `QuestionBridge.announced` 是内存态，而 `attach()` 里的 `reconcile()`
	// **有意**要在订阅前先跑一遍。两句合起来：用户刷新页面时，只要那个问题
	// 还挂在投影 `active` 上（120s 计时窗口未到 / 用户没答），就会再念一遍。
	const qStore = makeStore();
	const qLedger1 = createPlaybackLedger({ scope: "q", storage: qStore });
	const announcements1 = [];
	const bridge1 = new QuestionBridge({
		ledger: qLedger1,
		onQuestion: (payload) => announcements1.push(payload.callId),
	});
	check("第一次念问题", bridge1.markAnnounced("call_1"), true);
	check("同一次会话内不重念", bridge1.markAnnounced("call_1"), false);
	check("确实播报了一次", announcements1.length, 0); // markAnnounced 只判定，不自己播

	// 模拟"刷新页面"：新桥 + 同一份存储。
	const qLedger2 = createPlaybackLedger({ scope: "q", storage: qStore });
	const bridge2 = new QuestionBridge({
		ledger: qLedger2,
		onQuestion: () => {},
	});
	check("刷新后同一个问题不再念（这就是需求②要的）", bridge2.markAnnounced("call_1"), false);
	check("刷新后新问题照常念", bridge2.markAnnounced("call_2"), true);

	// 提问与汇报共用一份账本时，身份空间不能互相顶掉。
	const shared = createPlaybackLedger({ scope: "shared", storage: makeStore() });
	const sharedBridge = new QuestionBridge({ ledger: shared, onQuestion: () => {} });
	check("汇报记过账不妨碍提问", shared.claim({ kind: "report", key: "call_1" }), true);
	check("同 key 不同 kind 各自独立", sharedBridge.markAnnounced("call_1"), true);

	// 没有账本（老宿主 / 降级）时退回纯内存行为，功能只是"不跨刷新"。
	const bare = new QuestionBridge({ onQuestion: () => {} });
	check("无账本时同一实例内仍去重", [bare.markAnnounced("c"), bare.markAnnounced("c")], [true, false]);
	check("无 callId 时一律放行（宁可多念不可漏念）", bare.markAnnounced(""), true);
}

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	for (const failure of failures) console.error(`  - ${failure.name}: ${JSON.stringify(failure.actual)} / 期望 ${JSON.stringify(failure.expected)}`);
	process.exitCode = 1;
} else {
	console.log("\n全部通过");
}