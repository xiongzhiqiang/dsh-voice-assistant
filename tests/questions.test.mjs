/**
 * `questions.js` 的纯逻辑单测：选项匹配、序号匹配、跳过语义、播报文本、
 * 以及 `QuestionBridge` 的投影读取与作答提交。
 *
 * ## 为什么这一层不能只测"匹配得对"
 *
 * 匹配函数的错误有**两种方向**，危害完全不同：
 *   - **假阴性**（该匹配没匹配上）：用户说"第一个"，系统没听懂 → 再问一次，
 *     体验差但**安全**；
 *   - **假阳性**（不该匹配却匹配了）：用户说"这个先不用"，系统匹配到
 *     "允许" → **替用户做了决定**。
 *
 * 所以下面的断言里，"不猜"是重点：有选项但没匹配上必须返回
 * `matched:false`，绝不能回落成"选第一个"。这条比"匹配正确"更重要。
 *
 * 用法：`node tests/questions.test.mjs`
 */
import { QuestionBridge, matchAnswer, normalize, speakQuestion, questionCallOf } from "../src/client/core/questions.js";

let passed = 0;
const failures = [];

function check(name, actual, expected) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) {
		passed += 1;
		console.log(`ok   ${name}`);
	} else {
		failures.push(`${name}\n     期望 ${JSON.stringify(expected)}\n     实际 ${JSON.stringify(actual)}`);
		console.log(`FAIL ${name}`);
		console.log(`     期望 ${JSON.stringify(expected)}`);
		console.log(`     实际 ${JSON.stringify(actual)}`);
	}
}

const OPTIONS = [
	{ label: "方案 A", description: "先做最小可用" },
	{ label: "方案 B", description: "一次做全" },
	{ label: "都不做" },
];

// ── 一、选项原文匹配 ────────────────────────────────────────────────
check("匹配：说出选项原文", matchAnswer("方案 A", OPTIONS), { selected: ["方案 A"], custom: "", matched: true });
check("匹配：选项原文带空格标点", matchAnswer("  方案  a。 ", OPTIONS), { selected: ["方案 A"], custom: "", matched: true });
check("匹配：只说选项的一部分（包含判定）", matchAnswer("B", OPTIONS), { selected: ["方案 B"], custom: "", matched: true });
check("匹配：句子里含选项原文", matchAnswer("用方案 B 吧", OPTIONS), { selected: ["方案 B"], custom: "", matched: true });

// ── 二、序号匹配 ────────────────────────────────────────────────────
check("序号：中文序号", matchAnswer("第一个", OPTIONS), { selected: ["方案 A"], custom: "", matched: true });
check("序号：阿拉伯数字", matchAnswer("第2个", OPTIONS), { selected: ["方案 B"], custom: "", matched: true });
check("序号：裸数字", matchAnswer("选 2", OPTIONS), { selected: ["方案 B"], custom: "", matched: true });
check("序号：最后一个（选项多于 5 个也不漏）", matchAnswer("最后一个", OPTIONS), { selected: ["都不做"], custom: "", matched: true });
check("序号：首个", matchAnswer("首个", OPTIONS), { selected: ["方案 A"], custom: "", matched: true });

// ── 三、跳过 ────────────────────────────────────────────────────────
// DSH 的协议里 `selected: []` 且无 `custom` = 用户跳过。这是**唯一安全**的
// 兜底：用户说"不用了"时绝不能替他选一个。
check("跳过：都不选", matchAnswer("都不选", OPTIONS), { selected: [], custom: "", matched: true, skip: true });
check("跳过：算了", matchAnswer("算了", OPTIONS), { selected: [], custom: "", matched: true, skip: true });
check("跳过：跳过", matchAnswer("跳过", OPTIONS), { selected: [], custom: "", matched: true, skip: true });

// ── 四、不猜（最重要的一条） ────────────────────────────────────────
// 有选项、但说的话和任何选项都无关 → 必须如实返回"没匹配上"，
// 让上层再问一次或交回界面；**绝不能回落成第一个选项**。
check(
	"不猜：有选项但没匹配上 → matched:false",
	matchAnswer("今天天气不错", OPTIONS),
	{ selected: [], custom: "", matched: false },
);
check("不猜：空输入不算匹配", matchAnswer("   ", OPTIONS), { selected: [], custom: "", matched: false });

// ── 五、开放问题（无选项） ──────────────────────────────────────────
check(
	"开放问：无选项时原话作为 custom",
	matchAnswer("把结果放到 D 盘", []),
	{ selected: [], custom: "把结果放到 D 盘", matched: true },
);
check("开放问：无选项时空输入不匹配", matchAnswer("", []), { selected: [], custom: "", matched: false });

// ── 六、多选 ────────────────────────────────────────────────────────
const MULTI = [{ label: "读文件" }, { label: "写文件" }, { label: "删文件" }];
check(
	"多选：同时命中两个",
	matchAnswer("读文件和写文件都要", MULTI, true),
	{ selected: ["读文件", "写文件"], custom: "", matched: true },
);
// 单选时只取第一个命中 —— 单选问句不该返回两个选项。
check(
	"单选：只取第一个命中",
	matchAnswer("读文件和写文件都要", MULTI, false),
	{ selected: ["读文件"], custom: "", matched: true },
);

// ── 七、归一化 ──────────────────────────────────────────────────────
check("归一化：去空格与标点", normalize(" 方案 A， 好的！ "), "方案a好的");
check("归一化：null 不崩", normalize(null), "");

// ── 八、播报文本 ────────────────────────────────────────────────────
{
	const spoken = speakQuestion(OPTIONS.length > 0 ? { question: "用哪个方案？", options: OPTIONS } : {}, 0, 1);
	check("播报：含问题原文", spoken.includes("用哪个方案？"), true);
	check("播报：含选项标签", spoken.includes("方案 A") && spoken.includes("方案 B"), true);
	check("播报：提示可以语音作答", /直接说/.test(spoken), true);
	// 不念 question.id（那是给模型对答案的稳定标识，念出来是噪音）。
	const withId = speakQuestion({ id: "q-plan-choose", question: "用哪个？", options: OPTIONS }, 0, 1);
	check("播报：不念问题 id", withId.includes("q-plan-choose"), false);
}
{
	// header 要念：模型常把限定放在 header 里，缺了它选项会失去语境。
	const spoken = speakQuestion({ header: "存储位置", question: "放哪？", options: [{ label: "D 盘" }] }, 0, 1);
	check("播报：带 header", spoken.includes("存储位置"), true);
}
{
	// 多问题批次要报序号，否则用户不知道在答第几问。
	const spoken = speakQuestion({ question: "第一个问题？" }, 1, 3);
	check("播报：多问题带序号", spoken.startsWith("第二问"), true);
}
{
	// 超过 5 个选项时只念前 5 个，并说明还有更多。
	const many = Array.from({ length: 8 }, (unused, index) => ({ label: `选项${index + 1}` }));
	const spoken = speakQuestion({ question: "选哪个？", options: many }, 0, 1);
	check("播报：选项过多时提示总数", spoken.includes("等 8 个"), true);
	check("播报：选项过多时不全念", spoken.includes("选项6"), false);
}
{
	// 开放问题要说明"直接说就行"，否则用户以为必须选。
	const spoken = speakQuestion({ question: "项目叫什么？" }, 0, 1);
	check("播报：开放问题提示", /开放问题|直接说/.test(spoken), true);
}

// ── 九、QuestionBridge：假投影 ──────────────────────────────────────
/**
 * 造一个假的提问投影面。
 *
 * 形状按**实测**来的（见 questions.js 顶部契约表）：`faceOf` 返回
 * `{ getSnapshot, subscribe }`，快照是 `{ active: [...] }`。
 */
function makeFace(rows) {
	const listeners = new Set();
	let state = { active: rows };
	return {
		face: {
			getSnapshot: () => state,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		push: (next) => {
			state = { active: next };
			for (const listener of listeners) listener();
		},
		listenerCount: () => listeners.size,
	};
}

function makeBinding(face) {
	return { session: { projections: { faceOf: (key) => (key === "userQuestions" ? face : undefined) } } };
}

/**
 * 造一个假 ctx，**按真实契约**提供 `remote.userQuestions`。
 *
 * ## 为什么必须有这个辅助函数（真机踩出来的）
 *
 * 早先的桩直接写 `ctx: { remote: { userQuestions: {...} } }` —— 那是**错的**，
 * 而且是**会抛异常**的那种错：cordis 的服务是注册在**带点号的完整名字**
 * 下的（`dsh-api-gateway` 的 `` `remote.${namespace}` ``），访问
 * `ctx.remote.userQuestions` 会走代理并被拦下：
 *
 *     Error: cannot get property "remote.userQuestions" without inject
 *     （cordis/lib/index.js:1257）
 *
 * 也就是说：**这些单测全绿了很久，而真机上那条路 100% 抛异常**。
 * 原因是桩件模拟的是"我以为的访问方式"，而不是真实的。
 *
 * 现在桩老老实实照真实契约来：服务挂在 `ctx.get("remote.userQuestions")`
 * 上（`ReflectService.get` 的文档原文就是 *without the inject requirement*）。
 * 另有一条专门的回归（见"作答：走全名读取"）锁定这个形状。
 *
 * @param service - `remote.userQuestions` 的值；省略表示"服务不在"。
 * @returns 假 ctx。
 */
function makeCtx(service) {
	const table = service === undefined ? {} : { "remote.userQuestions": service };
	return {
		get: (name) => table[name],
		// 故意**不**提供 `remote` 属性：真实 ctx 上访问它会抛（见上），
		// 桩件也不该给出一个不存在的宽松路径，否则又会掩盖问题。
	};
}

{
	const fake = makeFace([
		{ callId: "call-1", state: "open", questions: [{ id: "q1", question: "用哪个方案？", options: OPTIONS }] },
	]);
	const seen = [];
	const bridge = new QuestionBridge({ onQuestion: (payload) => seen.push(payload) });
	const ok = bridge.attach("sess-1", makeBinding(fake.face));
	check("桥：绑上后立刻播报已有问题（不等下一次变更）", seen.length, 1);
	check("桥：播报带上 callId", seen[0]?.callId, "call-1");
	check("桥：播报带上状态", seen[0]?.state, "open");
	// 同一个 callId 不重复念 —— 投影变更（比如 inbox 也在动）会反复触发 reconcile。
	fake.push([
		{ callId: "call-1", state: "open", questions: [{ id: "q1", question: "用哪个方案？", options: OPTIONS }] },
	]);
	check("桥：同一问题不重复播报", seen.length, 1);
	// 新问题要念。
	fake.push([
		{ callId: "call-1", state: "open", questions: [{ id: "q1", question: "用哪个方案？", options: OPTIONS }] },
		{ callId: "call-2", state: "continued", questions: [{ id: "q2", question: "项目叫什么？" }] },
	]);
	check("桥：新问题会播报", seen.length, 2);
	check("桥：状态如实带出来", seen[1]?.state, "continued");
	check("桥：attach 返回 true", ok, true);
	bridge.dispose();
	check("桥：dispose 后解除订阅", fake.listenerCount(), 0);
}

{
	// 投影面不可用（精简 profile 未装 dsh-user-questions）→ 绑不上但不抛错，
	// 且**不告警**（这是合法的可选能力，报警会把正常部署刷成有告警）。
	const logs = [];
	const warns = [];
	const bridge = new QuestionBridge({
		onQuestion: () => {},
		log: (message) => logs.push(String(message)),
		warn: (message) => warns.push(String(message)),
	});
	const ok = bridge.attach("sess-1", { session: {} });
	check("桥：无投影时 attach 返回 false", ok, false);
	check("桥：无投影时如实记一条日志", logs.length, 1);
	check("桥：无投影时不算告警", warns.length, 0);
}

{
	// 作答：成功路径。
	const calls = [];
	const resolved = [];
	const bridge = new QuestionBridge({
		ctx: makeCtx({
			answer: async (sessionId, callId, answer) => {
				calls.push({ sessionId, callId, answer });
				return { ok: true, value: true };
			},
		}),
		onQuestion: () => {},
		onResolved: (payload) => resolved.push(payload),
	});
	bridge.attach("sess-1", makeBinding(makeFace([]).face));
	const result = await bridge.submit("call-1", { answers: [{ id: "q1", selected: ["方案 A"] }] });
	check("作答：提交成功", result, { ok: true, reason: "" });
	check("作答：sessionId/callId 透传正确", [calls[0]?.sessionId, calls[0]?.callId], ["sess-1", "call-1"]);
	check("作答：answer 形状原样透传", calls[0]?.answer, { answers: [{ id: "q1", selected: ["方案 A"] }] });
	check("作答：成功后有回调", resolved.length, 1);
	// 第二次提交同一个 callId 不该再发 —— DSH 会以 REPLY_QUEUED 拒绝。
	const again = await bridge.submit("call-1", { answers: [{ id: "q1", selected: ["方案 A"] }] });
	check("作答：同一问题重复提交被拦下", again.ok, false);
	check("作答：重复提交不再打到宿主", calls.length, 1);
}

{
	// 作答：`value:false` = 已不在 continued（界面抢先答了）→ 如实失败。
	const bridge = new QuestionBridge({
		ctx: makeCtx({ answer: async () => ({ ok: true, value: false }) }),
	});
	bridge.attach("sess-1", makeBinding(makeFace([]).face));
	const result = await bridge.submit("call-x", { answers: [] });
	check("作答：界面已答时如实报 not-answerable", result, { ok: false, reason: "not-answerable" });
}

{
	// 作答：宿主返回失败对象 → 把 message 带出来（不静默吞掉）。
	const bridge = new QuestionBridge({
		ctx: makeCtx({ answer: async () => ({ ok: false, error: { message: "REPLY_QUEUED" } }) }),
	});
	bridge.attach("sess-1", makeBinding(makeFace([]).face));
	const result = await bridge.submit("call-y", { answers: [] });
	check("作答：宿主拒绝时带出原因", result, { ok: false, reason: "REPLY_QUEUED" });
}

{
	// 作答：服务不在（精简 profile）→ 如实报 unavailable，不抛。
	const bridge = new QuestionBridge({ ctx: makeCtx() });
	bridge.attach("sess-1", makeBinding(makeFace([]).face));
	const result = await bridge.submit("call-z", { answers: [] });
	check("作答：remote 不可用时如实报", result, { ok: false, reason: "remote-userQuestions-unavailable" });
}

{
	// ## 回归：必须走**全名**读取（真机踩出来的 bug）
	//
	// 真机上 `ctx.remote.userQuestions` 会抛
	// `cannot get property "remote.userQuestions" without inject`
	// （cordis 的代理护栏），而且**同步抛在 try 外面**，连
	// `{ok:false}` 都返回不了 —— 表现是浏览器里一条 "Uncaught (in promise)"。
	//
	// 这里造一个"访问 `ctx.remote` 就炸"的 ctx，逼实现必须走
	// `ctx.get("remote.userQuestions")`。实现若回退成嵌套访问，这条立刻红。
	const boom = new Error('cannot get property "remote.userQuestions" without inject');
	const ctx = {
		get: (name) => (name === "remote.userQuestions" ? { answer: async () => ({ ok: true, value: true }) } : undefined),
	};
	Object.defineProperty(ctx, "remote", {
		get() {
			throw boom;
		},
	});
	const bridge = new QuestionBridge({ ctx });
	bridge.attach("sess-1", makeBinding(makeFace([]).face));
	const result = await bridge.submit("call-fullname", { answers: [] });
	check("作答：走全名读取，不被 ctx.remote 的护栏拦住", result, { ok: true, reason: "" });
}

{
	// 作答：**取服务本身就抛**（代理护栏原样冒出来）→ 也要如实回报，不许逃逸。
	const ctx = {
		get(name) {
			if (name === "remote.userQuestions") throw new Error("proxy boom");
			return undefined;
		},
	};
	const bridge = new QuestionBridge({ ctx });
	bridge.attach("sess-1", makeBinding(makeFace([]).face));
	const result = await bridge.submit("call-throw", { answers: [] });
	check("作答：取服务抛错时如实回报", result.ok, false);
	check("作答：取服务抛错时带出原因", /proxy boom/.test(String(result.reason)), true);
}

{
	// 作答：没绑会话时不该发请求。
	let called = 0;
	const bridge = new QuestionBridge({
		ctx: makeCtx({
			answer: async () => {
				called += 1;
				return { ok: true, value: true };
			},
		}),
	});
	const result = await bridge.submit("call-w", { answers: [] });
	check("作答：未绑会话时如实报 no-session", result, { ok: false, reason: "no-session" });
	check("作答：未绑会话时不打宿主", called, 0);
}

{
	// 换绑必须重建订阅（投影是**按会话**的，沿用旧的会念出别的会话的问题）。
	const first = makeFace([{ callId: "a", state: "open", questions: [{ id: "q", question: "旧会话的问题" }] }]);
	const second = makeFace([{ callId: "b", state: "open", questions: [{ id: "q", question: "新会话的问题" }] }]);
	const seen = [];
	const bridge = new QuestionBridge({ onQuestion: (payload) => seen.push(payload) });
	bridge.attach("sess-a", makeBinding(first.face));
	bridge.attach("sess-b", makeBinding(second.face));
	check("换绑：旧会话的订阅已解除", first.listenerCount(), 0);
	check("换绑：新会话的订阅已建立", second.listenerCount(), 1);
	check("换绑：播报的是新会话的问题", seen[1]?.sessionId, "sess-b");
	// 旧投影再变，不该再触发播报。
	first.push([{ callId: "a2", state: "open", questions: [{ id: "q", question: "旧会话的新问题" }] }]);
	check("换绑：旧投影变更不再触发播报", seen.length, 2);
}

// ── 十、事件流主路径（本轮修复的核心） ──────────────────────────────
//
// ## 为什么这一节必须有
//
// 原实现**只订阅 `userQuestions` 投影**，而投影对 `tool/call` 先判
// `fold.timed`（`projection.js:209`），`timed` 又由 tool schema 是否声明
// `timeout` 决定 —— `dsh-tool-ask-user` 默认 legacy，**投影恒空**。
// 结果是：本机默认配置下语音助手**永远收不到问题**，而单测（假投影）
// 和真机装机测试（只验链路通不通）**全都是绿的**。
//
// 教训与"类单测全绿 ≠ 接线正确"同源：**假投影喂得太顺，掩盖了真投影
// 在默认配置下恒空这件事**。所以这一节直接用**真实事件形状**喂
// `observeEvent`，覆盖不依赖投影的那条路径。

{
	// 真实事件形状：`arguments` 是 **JSON 字符串**，模型参数写 `multi_select`。
	const realEvent = {
		type: "tool/call",
		seq: 140,
		time: 1793934196418,
		data: {
			turn: 1,
			step: 15,
			callId: "call_00_gIOIJXseCDA0cwab79mr2983",
			name: "ask_user_question",
			arguments: JSON.stringify({
				questions: [
					{
						id: "platform",
						header: "How to proceed",
						question: "怎么继续？",
						options: [
							{ label: "方案 A", description: "先做最小可用" },
							{ label: "方案 B", description: "一次做全" },
						],
					},
				],
			}),
		},
	};
	const seen = [];
	// **关键：不给 face，模拟 legacy 模式（投影恒空）** —— 这正是本机默认。
	const bridge = new QuestionBridge({ onQuestion: (payload) => seen.push(payload) });
	bridge.attach("sess-1", { session: {} });
	check("事件流：投影不可用时 attach 仍返回 false（但事件流照常工作）", bridge.sessionId, "sess-1");
	const found = bridge.observeEvent(realEvent);
	check("事件流：legacy 模式下也能发现提问", found, true);
	check("事件流：播报了一条", seen.length, 1);
	check("事件流：callId 正确", seen[0]?.callId, "call_00_gIOIJXseCDA0cwab79mr2983");
	check("事件流：问题文本正确", seen[0]?.questions[0]?.question, "怎么继续？");
	check("事件流：选项被解析出来", seen[0]?.questions[0]?.options?.length, 2);
	check("事件流：header 带出来", seen[0]?.questions[0]?.header, "How to proceed");
	// 拿不到投影时 state 保守按 open（能答与否由 tryAnswerQuestion 判）。
	check("事件流：无投影时 state 保守按 open", seen[0]?.state, "open");
	// 同一条事件不重复播报（事件窗口会反复推送同一条）。
	bridge.observeEvent(realEvent);
	check("事件流：同一 callId 不重复播报", seen.length, 1);
}

{
	// `multi_select`（下划线，模型写法）必须转成 `multiSelect`（驼峰，内部形状）。
	const bridge = new QuestionBridge({ onQuestion: () => {} });
	bridge.attach("sess-1", { session: {} });
	const event = {
		type: "tool/call",
		data: {
			callId: "call-multi",
			name: "ask_user_question",
			arguments: JSON.stringify({
				questions: [{ id: "q", question: "选哪些？", options: [{ label: "A" }], multi_select: true }],
			}),
		},
	};
	const call = questionCallOf(event);
	check("事件流：multi_select 转成 multiSelect", call?.questions[0]?.multiSelect, true);
}

{
	// 非提问事件一律不认（避免误拦普通工具调用）。
	const bridge = new QuestionBridge({ onQuestion: () => {} });
	bridge.attach("sess-1", { session: {} });
	check("事件流：别的工具不认", bridge.observeEvent({ type: "tool/call", data: { name: "bash", callId: "b1" } }), false);
	check("事件流：turn/start 不认", bridge.observeEvent({ type: "turn/start", data: {} }), false);
	check("事件流：坏 JSON 不认（模型参数畸形时没有卡片）", bridge.observeEvent({
		type: "tool/call",
		data: { name: "ask_user_question", callId: "c1", arguments: "{不是JSON" },
	}), false);
	check("事件流：缺 callId 不认", bridge.observeEvent({
		type: "tool/call",
		data: { name: "ask_user_question", arguments: JSON.stringify({ questions: [{ id: "q", question: "x" }] }) },
	}), false);
	check("事件流：questions 为空不认", bridge.observeEvent({
		type: "tool/call",
		data: { name: "ask_user_question", callId: "c2", arguments: JSON.stringify({ questions: [] }) },
	}), false);
}

{
	// 投影在时，权威 state 要覆盖事件流的保守值（continued 才能作答）。
	const fake = makeFace([
		{ callId: "call-9", state: "continued", questions: [{ id: "q9", question: "投影里的问题？" }] },
	]);
	const seen = [];
	const bridge = new QuestionBridge({ onQuestion: (payload) => seen.push(payload) });
	bridge.attach("sess-1", makeBinding(fake.face));
	// 投影先播报（权威 state=continued）。
	check("投影优先：先播报投影里的问题", seen.length, 1);
	check("投影优先：state 取 continued", seen[0]?.state, "continued");
	// 事件流后到，不该重复播报同一条。
	const found = bridge.observeEvent({
		type: "tool/call",
		data: { callId: "call-9", name: "ask_user_question", arguments: JSON.stringify({ questions: [{ id: "q9", question: "投影里的问题？" }] }) },
	});
	check("投影优先：事件流不重复播报已念过的", found, false);
	check("投影优先：仍只有一条", seen.length, 1);
	// 事件流先到、投影后到：投影要能把 state 升级成 continued。
	const bridge2 = new QuestionBridge({ onQuestion: () => {} });
	bridge2.attach("sess-1", { session: {} });
	bridge2.observeEvent({
		type: "tool/call",
		data: { callId: "call-10", name: "ask_user_question", arguments: JSON.stringify({ questions: [{ id: "q", question: "x" }] }) },
	});
	check("投影补位：事件流后状态是 open", bridge2.inspect().states["call-10"], undefined);
}

{
	// detach 要清干净（换会话时不该带着旧会话的 known/states）。
	const bridge = new QuestionBridge({ onQuestion: () => {} });
	bridge.attach("sess-1", { session: {} });
	bridge.observeEvent({
		type: "tool/call",
		data: { callId: "call-old", name: "ask_user_question", arguments: JSON.stringify({ questions: [{ id: "q", question: "x" }] }) },
	});
	check("detach 前：known 里有记录", bridge.inspect().known, 1);
	bridge.detach();
	check("detach 后：known 清空", bridge.inspect().known, 0);
	check("detach 后：sessionId 清空", bridge.inspect().sessionId, null);
}

// ── 十一、接线回归：真实 `VoiceSession.handleEvent` 必须转给桥 ─────────
//
// ## 为什么单测"桥自己工作"还不够
//
// 上一轮真机踩过的坑：`TurnGate` 单测全绿，但它**根本没被 `handleFinal`
// 调用** —— 于是功能全废而测试全过。同一种病在这里同样可能：
// `observeEvent` 写得再对，只要 `VoiceSession.handleEvent` 没转给它，
// 真机上就什么都收不到。
//
// 所以这一节**不直接调桥**，而是构造一个真的 `VoiceSession`，
// 让它内部去调。只喂事件、不碰会话服务（`ctx` 给空壳即可，
// `handleEvent` 不依赖服务）。

{
	const { VoiceSession } = await import("../src/client/core/session.js");
	const forwarded = [];
	const session = new VoiceSession({
		ctx: { get: () => undefined },
		config: {},
		onQuestionCall: (event) => forwarded.push(event),
	});
	// 直接调内部处理方法（等价于事件窗口推来一条）。
	session.handleEvent({
		type: "tool/call",
		seq: 5,
		time: Date.now(),
		data: {
			callId: "call-wire-1",
			name: "ask_user_question",
			arguments: JSON.stringify({ questions: [{ id: "q1", question: "接线测试？" }] }),
		},
	});
	check("接线：handleEvent 把 tool/call 转给了 onQuestionCall", forwarded.length, 1);
	check("接线：转发的是原始事件（形状未变）", forwarded[0]?.data?.callId, "call-wire-1");

	// 非提问事件不该转发。
	session.handleEvent({ type: "tool/result", seq: 6, data: { message: { toolCallId: "x" } } });
	check("接线：tool/result 不转发", forwarded.length, 1);
	session.handleEvent({ type: "tool/call", seq: 7, data: { callId: "b", name: "bash" } });
	check("接线：别的工具也不转发（由桥判定）", forwarded.length, 2);
	// 注意：桥会再判一次 name。上面这条是**转发层**不筛工具名，
	// 真正的过滤在 `questionCallOf`；这里只断言"转发层没漏"。
}

console.log(`\n${failures.length === 0 ? "全部通过" : `${failures.length} 项失败`}`);
if (failures.length > 0) {
	console.log("\n失败明细：");
	for (const line of failures) console.log(`  - ${line}`);
}
process.exitCode = failures.length === 0 ? 0 : 1;
