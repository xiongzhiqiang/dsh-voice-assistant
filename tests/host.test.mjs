/** 宿主半纯函数的快速自检（不依赖 DSH 运行时）。 */
import { normalizeConfig, clientConfig } from "../lib/config.js";
import { quickClean, looksLikeRewrite, STYLE_PROMPTS } from "../lib/polish.js";
import { ensureSessionNotArchived } from "../lib/identity.js";
import { normalizeWorkers, workerTargets, DEFAULT_WORKERS } from "../lib/workers.js";
import { parseRouteOutput } from "../lib/router.js";
import { mountAgentPreset, composeAgentScope } from "../lib/agent.js";
import { createReportQueue, deterministicSummary, formatReportSpeech, parseReportAfter } from "../lib/report.js";
import { createDelegationHub } from "../lib/delegation.js";

const failures = [];
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures.push({ name, actual, expected });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` → ${JSON.stringify(actual)}`}`);
};

// ── 配置归一化 ────────────────────────────────────────────────────────
const empty = normalizeConfig(undefined);
check("默认唤醒词", empty.wake.word, "小凤");
check("默认休眠", empty.sleep.idleTimeoutMs, 60000);
check("默认 ASR 引擎", empty.asr.engine, "auto");
check("别名剔除唤醒词本身", normalizeConfig({ wake: { word: "小凤", aliases: ["小凤", "小风"] } }).wake.aliases, ["小风"]);

const messy = normalizeConfig({
	wake: { word: "  小凤  ", aliases: "小风" },
	language: "",
	sleep: { idleTimeoutMs: "500", keepWakeWord: "true" },
	asr: { engine: "HTTP", http: { baseURL: "http://x/v1/", apiKey: "k" } },
	tts: { engine: "BROWSER", rate: 9 },
	polish: { style: "nope", timeoutMs: 999999 },
	session: { mode: "weird" },
	ui: { accent: "red", position: "top" },
});
check("唤醒词去空白", messy.wake.word, "小凤");
check("空语言兜底", messy.language, "zh-CN");
check("休眠下界夹取", messy.sleep.idleTimeoutMs, 5000);
check("字符串 true 不算真", messy.sleep.keepWakeWord, false);
check("引擎大小写归一", messy.asr.engine, "http");
check("语速上界夹取", messy.tts.rate, 2);
check("风格非法兜底", messy.polish.style, "clean");
check("润色超时上界", messy.polish.timeoutMs, 30000);
check("会话模式兜底（默认常驻）", messy.session.mode, "persistent");
check("强调色非法兜底", messy.ui.accent, "#2f6bff");
check("位置非法兜底", messy.ui.position, "bottom-right");

// ── 密钥不外泄 ────────────────────────────────────────────────────────
const withKeys = normalizeConfig({
	asr: { engine: "http", http: { baseURL: "http://a/v1", apiKey: "SECRET-ASR" } },
	tts: { engine: "http", http: { baseURL: "http://b/v1", apiKey: "SECRET-TTS" } },
});
const serialized = JSON.stringify(clientConfig(withKeys, { polishAvailable: true }));
check("下发配置不含 ASR 密钥", serialized.includes("SECRET-ASR"), false);
check("下发配置不含 TTS 密钥", serialized.includes("SECRET-TTS"), false);
check("下发配置标出 ASR 可用", clientConfig(withKeys).asr.httpReady, true);
check("非 persistent 模式统一下发为 persistent", clientConfig(withKeys).session.mode, "persistent");
check("requestedMode 回显用户原始请求", clientConfig(withKeys).session.requestedMode, "persistent");
check("默认人格非空", normalizeConfig({}).agent.persona.length > 0, true);
check("agent 默认 session 标识稳定", normalizeConfig({}).agent.sessionId, "session-voice-assistant-root");

// ── 语音应答的归一化（**只做提问，不做工具审批**）────────────────────
//
// 范围是用户定的：工具审批（`approval/request`）放行的是有副作用的操作，
// 语音误听会造成真实损害，一律交回界面；提问只是"要一个信息"，可以语音答。
//
// 所以这里**断言 `approvalTimeoutMs` 不存在**：留着它等于告诉用户"开了就有
// 审批播报"，而实际上没有任何代码路径读它（它曾是死配置，已删）。
const answersDefault = normalizeConfig({}).answers;
check("提问窗口默认 60 秒", answersDefault.questionTimeoutMs, 60000);
check("提问窗口下界夹取（低于 5s 听不完问题）", normalizeConfig({ answers: { questionTimeoutMs: 100 } }).answers.questionTimeoutMs, 5000);
check("提问窗口上界夹取（高于 5min agent 干等）", normalizeConfig({ answers: { questionTimeoutMs: 9_999_999 } }).answers.questionTimeoutMs, 300000);
check("念问题前响提示音默认开", answersDefault.chime, true);
check("重复念问题默认开", answersDefault.repeatOnce, true);
check("不再下发审批窗口（本插件不做工具审批）", "approvalTimeoutMs" in answersDefault, false);
check(
	"客户端配置里的 answers 也只含提问字段",
	Object.keys(clientConfig(normalizeConfig({})).answers).sort(),
	["chime", "questionTimeoutMs", "repeatOnce"],
);

// ── 轮次判据的归一化 ──────────────────────────────────────────────────
//
// 这两个值决定"什么时候算用户说完了一轮"，是整个需求的核心旋钮。
// 归一化必须守住三条：默认 10 秒、越界夹取、以及**硬上限不得小于静音阈值**
// （否则静音判据永远轮不到，语义就反了 —— 用户会在说话中途被反复提交）。
const turnDefault = normalizeConfig({}).turn;
check("完成判据默认 10 秒", turnDefault.silenceMs, 10000);
check("回声抑制默认开", turnDefault.echoGuard, true);
check("思考中插话默认关", turnDefault.steerWhileThinking, false);
check("单轮硬上限默认 5 分钟", turnDefault.maxTurnMs, 300000);

const turnTight = normalizeConfig({ turn: { silenceMs: "30000", maxTurnMs: 40000 } }).turn;
check("静音阈值可用字符串配置", turnTight.silenceMs, 30000);
check("硬上限大于静音阈值时原样保留", turnTight.maxTurnMs, 40000);

const turnClampLow = normalizeConfig({ turn: { silenceMs: 10 } }).turn;
check("静音阈值下界夹取（太短会打断用户）", turnClampLow.silenceMs, 3000);
const turnClampHigh = normalizeConfig({ turn: { silenceMs: 99999999 } }).turn;
check("静音阈值上界夹取（太长等于永不提交）", turnClampHigh.silenceMs, 600000);

// 关键的语义保护：硬上限小于静音阈值时，必须被抬到 silenceMs + 5s。
const turnInverted = normalizeConfig({ turn: { silenceMs: 60000, maxTurnMs: 1000 } }).turn;
check("硬上限低于静音阈值时被抬高", turnInverted.maxTurnMs, 65000);
check("抬高的硬上限确实大于静音阈值", turnInverted.maxTurnMs > turnInverted.silenceMs, true);

const turnNonBool = normalizeConfig({ turn: { echoGuard: "false", steerWhileThinking: "true" } }).turn;
check("字符串 false 不算假（只认真布尔）", turnNonBool.echoGuard, true);
check("字符串 true 不算真", turnNonBool.steerWhileThinking, false);

const turnOff = normalizeConfig({ turn: { echoGuard: false, steerWhileThinking: true } }).turn;
check("回声抑制可显式关闭", turnOff.echoGuard, false);
check("思考中插话可显式打开", turnOff.steerWhileThinking, true);

// 下发到浏览器的白名单必须带上轮次配置，否则客户端只能用内置默认。
const clientTurn = clientConfig(normalizeConfig({ turn: { silenceMs: 20000 } })).turn;
check("下发配置包含轮次判据", clientTurn.silenceMs, 20000);
check("下发配置包含回声开关", clientTurn.echoGuard, true);
check("下发配置包含硬上限", clientTurn.maxTurnMs, 300000);

// ── 需求①：可见性标注 + 全局记忆 ──────────────────────────────────────
//
// 需求原文是"把常驻会话隐藏"。DSH 里没有安全的隐藏机制（归档会让助手哑掉、
// subagent 标记会让会话连不上，见 lib/identity.js 的对照表），所以落点改成
// 两件不损坏功能的事：给常驻会话一个**可辨识的标注**，把**记忆**做成全局的。
// 下面钉的是这两件事的配置面与作用域行为。

// 标注：默认有值、可关（空串 = 不改名）。
check("常驻会话标注默认非空", normalizeConfig({}).session.label, "小凤 · 常驻助手");
// 「留空即关闭」必须真的能关掉 —— 早期用 text() 兜底会让空串被静默换成默认名，
// 于是配置里写的关闭开关形同虚设（注释承诺与实际行为不符）。
check("标注可显式关成空串（交回自动标题）", normalizeConfig({ session: { label: "" } }).session.label, "");
check("标注留空白也算关闭", normalizeConfig({ session: { label: "   " } }).session.label, "");
check("标注支持自定义", normalizeConfig({ session: { label: " 我的助手 " } }).session.label, "我的助手");
check("标注下发给客户端（面板要显示）", clientConfig(normalizeConfig({ session: { label: "甲" } })).session.label, "甲");

// 全局记忆：默认关闭（往全局提示注入文字有 token 代价，必须显式开）。
{
	const memoryDefault = normalizeConfig({}).memory;
	check("全局记忆默认关", memoryDefault.global, false);
	check("全局记忆正文默认空", memoryDefault.text, "");

	const memoryOff = normalizeConfig({ memory: { global: "true", text: "记得我是谁" } }).memory;
	check("字符串 true 不算真（只认真布尔）", memoryOff.global, false);

	const memoryOn = normalizeConfig({ memory: { global: true, text: "  记得我是谁  " } }).memory;
	check("全局记忆可显式打开", memoryOn.global, true);
	check("正文去空白", memoryOn.text, "记得我是谁");

	// 下发面：只给"有没有生效"的事实，**不给正文** ——
	// 浏览器里的配置全局是明文，记忆正文可能含用户私人上下文。
	const clientMemory = clientConfig(normalizeConfig({ memory: { global: true, text: "私密上下文-A" } }), { memoryActive: true }).memory;
	check("下发配置标记记忆已生效", clientMemory.active, true);
	check("下发配置保留开关状态", clientMemory.global, true);
	check("下发配置不含记忆正文（防泄漏到浏览器）", JSON.stringify(clientMemory).includes("私密上下文-A"), false);
	check("能力位标出 memoryActive", clientConfig(normalizeConfig({}), { memoryActive: true }).capabilities.memoryActive, true);
	check("未生效时能力位为假", clientConfig(normalizeConfig({}), {}).capabilities.memoryActive, false);
}

// ── 归档自愈：常驻会话绝不能躺在归档集合里 ────────────────────────────
//
// ## 为什么这条回归必须存在
//
// `workspaceRegistry.archivedSessionIds` 是**持久化**状态（`workspace.json`）。
// 本 profile 注册了 `ArchivedSessionGate`，它对每一轮 `agent/pre-step` 直接
// 返回 `{kind:"reject"}`；`dsh-agent-loop` 于是把这一轮记成
// `turn/end reason={"kind":"blocked"}` 并**不发起任何模型请求**。
//
// 而 `prompt()` 的原始返回是 `{"ok":true,"value":{"accepted":true}}` ——
// **提交是成功的**。所以现象是"提交成功、状态回弹、界面无报错、永远没回答"，
// 从客户端完全看不出问题。本项目实测复现过一次（清掉那条 id 后同一句指令
// 立刻从 `blocked` 变成 `completed` + `assistant/message`）。
//
// 这里钉的是"读一次、发现就摘掉"这个收敛行为本身，以及它的各种降级路径。

{
	/** 造一个能读能写的 workspaceRegistry 桩。 */
	const makeRegistry = (archived, options = {}) => {
		const state = { ids: archived.slice(), unarchiveCalls: 0 };
		const registry = {
			get archivedSessionIds() {
				return state.ids.slice();
			},
			unarchiveSession(id) {
				state.unarchiveCalls += 1;
				if (options.throwOnUnarchive === true) throw new Error("write-failed-模拟");
				state.ids = state.ids.filter((item) => item !== id);
				return Promise.resolve();
			},
		};
		if (options.noMethod === true) delete registry.unarchiveSession;
		return { registry, state };
	};

	// ① 正常路径：在归档集合里 → 摘掉，且只调一次 unarchiveSession。
	{
		const { registry, state } = makeRegistry(["session-other", "session-voice-assistant-root"]);
		const outcome = await ensureSessionNotArchived({ get: () => registry }, "session-voice-assistant-root", { attempts: 1 });
		check("自愈：识别出已归档", outcome.archived, false);
		check("自愈：报告已解除", outcome.lifted, true);
		check("自愈：原因码正确", outcome.reason, "unarchived");
		check("自愈：确实摘掉了", registry.archivedSessionIds.includes("session-voice-assistant-root"), false);
		check("自愈：不动别人的归档", registry.archivedSessionIds.includes("session-other"), true);
		check("自愈：只写一次", state.unarchiveCalls, 1);
	}

	// ② 幂等：不在集合里 → 不写。
	{
		const { registry, state } = makeRegistry(["session-other"]);
		const outcome = await ensureSessionNotArchived({ get: () => registry }, "session-voice-assistant-root", { attempts: 1 });
		check("自愈：未归档时不报告", outcome.archived, false);
		check("自愈：未归档时不写", state.unarchiveCalls, 0);
		check("自愈：未归档原因码", outcome.reason, "not-archived");
	}

	// ③ 服务缺席：有界重试后安静放弃，不抛异常。
	{
		const outcome = await ensureSessionNotArchived({ get: () => undefined }, "session-x", { attempts: 2, intervalMs: 1 });
		check("自愈：服务缺席时不抛异常", outcome.checked, false);
		check("自愈：服务缺席原因码", outcome.reason, "registry-unavailable");
	}

	// ④ 服务在、但没有 unarchive 方法 → 如实报告"仍被归档、摘不掉"。
	{
		const { registry } = makeRegistry(["session-x"], { noMethod: true });
		const outcome = await ensureSessionNotArchived({ get: () => registry }, "session-x", { attempts: 1 });
		check("自愈：缺方法时如实报告仍在归档", outcome.archived, true);
		check("自愈：缺方法时未解除", outcome.lifted, false);
		check("自愈：缺方法原因码", outcome.reason, "no-unarchive-method");
	}

	// ⑤ 写入抛异常 → 捕获、如实报告，不把启动带崩。
	{
		const { registry } = makeRegistry(["session-x"], { throwOnUnarchive: true });
		const outcome = await ensureSessionNotArchived({ get: () => registry }, "session-x", { attempts: 1 });
		check("自愈：写入失败时不抛异常", outcome.lifted, false);
		check("自愈：写入失败时如实报告仍在归档", outcome.archived, true);
		check("自愈：失败原因码带前缀", outcome.reason.startsWith("unarchive-failed:"), true);
	}

	// ⑥ 空 id：直接放弃（不误伤、不空写）。
	{
		const { registry, state } = makeRegistry(["session-x"]);
		const outcome = await ensureSessionNotArchived({ get: () => registry }, "   ", { attempts: 1 });
		check("自愈：空 id 不动作", outcome.checked, false);
		check("自愈：空 id 原因码", outcome.reason, "no-session-id");
		check("自愈：空 id 不写", state.unarchiveCalls, 0);
	}

	// ⑦ 时序：服务晚一点才上线 → 重试能等到（与 agentDefaultModel 同类坑）。
	{
		const { registry } = makeRegistry(["session-x"]);
		let seen = 0;
		const ctx = { get: () => (seen++ < 2 ? undefined : registry) };
		const outcome = await ensureSessionNotArchived(ctx, "session-x", { attempts: 5, intervalMs: 1 });
		check("自愈：能等晚到的服务", outcome.lifted, true);
	}
}

// ── 规则清理 ──────────────────────────────────────────────────────────
check("去句首口癖", quickClean("嗯，帮我看下这个报错"), "帮我看下这个报错。");
check("去复读", quickClean("打开文件夹，打开文件夹"), "打开文件夹。");
check("补句号", quickClean("你好"), "你好。");
check("已有问号不动", quickClean("这个怎么改？"), "这个怎么改？");
check("不动句中代词", quickClean("这个东西很好用"), "这个东西很好用。");
check("空输入", quickClean("   "), "");
check("非字符串输入", quickClean(null), "");

// ── 润色跑偏检测 ──────────────────────────────────────────────────────
//
// 实测真机故障：口语转写里全是祈使句，模型很容易把"待校对文本"当成"对我
// 说的话"去执行 —— "用一句话介绍你自己"变成模型的自我介绍、
// "介绍一下深度求索"变成公司介绍。用户说完话，agent 收到的是模型
// 自己的回答而不是用户的指令，语义完全错位且极难定位。
// looksLikeRewrite 是兜底闸门：宁可退回规则清理（近似原话），
// 也不能把模型的回答当指令送进 agent。
check("正常校对不算跑偏", looksLikeRewrite("嗯 那个 帮我 看下 这个 报错", "帮我看下这个报错。"), false);
check("补标点不算跑偏", looksLikeRewrite("现在几点", "现在几点？"), false);
check("短句补标点不算跑偏", looksLikeRewrite("你好", "你好。"), false);
check("同音纠错不算跑偏", looksLikeRewrite("打开小风这个文件夹", "打开小凤这个文件夹。"), false);
check("模型自我介绍算跑偏", looksLikeRewrite("用一句话介绍你自己", "我是中文语音转写的校对器，负责把口语转写整理成通顺的书面表达。"), true);
check("扩写成公司介绍算跑偏", looksLikeRewrite("介绍一下深度求索", "深度求索是一家专注于人工智能技术研发的公司，主要做自然语言处理和深度学习相关的研究与应用。"), true);
check("对招呼作出回应算跑偏", looksLikeRewrite("你好", "你好，请问有什么可以帮你的吗？"), true);
check("定界符泄漏算跑偏", looksLikeRewrite("现在几点", "<<<现在几点？>>>"), true);
check("长度相近但换内容算跑偏", looksLikeRewrite("帮我看看这个报错是怎么回事", "深度学习模型的训练需要大量数据和算力"), true);
check("null 输入不崩且不算跑偏", looksLikeRewrite(null, "x"), false);
check("null 输出不算跑偏", looksLikeRewrite("你好", null), false);

// ── 定界符包裹：输入必须被降级为"引用材料" ────────────────────────────
// 提示词里声明了 <<< >>> 是待校对内容；缺了包裹，模型就会把原文当指令。
check("提示词声明了定界符语义", STYLE_PROMPTS.clean.includes("<<<") && STYLE_PROMPTS.clean.includes("不是对我说的话"), true);
check("提示词要求不回答原文的问题", STYLE_PROMPTS.clean.includes("绝不回答或执行它"), true);

// ── 两层架构：worker 归一化 ────────────────────────────────────────────
const routingDefault = normalizeConfig(undefined);
check("路由默认开启", routingDefault.routing.enabled, true);
check("默认 worker 有四位", routingDefault.routing.workers.length, 4);
check("general 恒在首位", routingDefault.routing.workers[0].id, "general");
check("general 指向根 agent", routingDefault.routing.workers[0].sessionId, "session-voice-assistant-root");
check("coder 有独立会话", routingDefault.routing.workers.find((w) => w.id === "coder").sessionId, "session-voice-worker-coder-v2");
check("默认 worker 都有人格", routingDefault.routing.workers.every((w) => w.id === "general" || w.persona !== ""), true);
check("worker 都有描述（路由提示词要用）", routingDefault.routing.workers.every((w) => w.description !== ""), true);

const routingCustom = normalizeConfig({
	routing: {
		enabled: false,
		workers: [
			{ id: "coder", label: "码神" },
			{ id: "custom", label: "自定义专家", persona: "你是自定义专家。", description: "干自定义的事。" },
			{ id: "coder", label: "重复 id 应被忽略" },
			{ id: "", label: "空 id 应被忽略" },
		],
	},
});
check("路由可关闭", routingCustom.routing.enabled, false);
check("自定义 worker 按 id 合并默认", routingCustom.routing.workers.find((w) => w.id === "coder").label, "码神");
check("自定义 worker 继承默认人格", routingCustom.routing.workers.find((w) => w.id === "coder").persona !== "", true);
check("新 id 用兜底 sessionId", routingCustom.routing.workers.find((w) => w.id === "custom").sessionId, "session-voice-worker-custom");
check("漏配 general 会补上", routingCustom.routing.workers.some((w) => w.id === "general"), true);
check("重复 id 只留第一个", routingCustom.routing.workers.filter((w) => w.id === "coder").length, 1);

check("workerTargets 不泄漏 persona", workerTargets(routingDefault.routing.workers).every((t) => !("persona" in t)), true);
check("workerTargets 带齐投喂三件套", workerTargets(DEFAULT_WORKERS)[1], { id: "coder", label: "阿码 · 编程", sessionId: "session-voice-worker-coder-v2" });

// clientConfig 白名单：路由段只下发投喂所需的字段。
const clientRouting = clientConfig(routingDefault, {}).routing;
check("客户端拿到路由开关", clientRouting.enabled, true);
check("客户端拿到 worker 清单", Array.isArray(clientRouting.workers) && clientRouting.workers.length, 4);
check("客户端 worker 无 persona", clientRouting.workers.every((w) => !("persona" in w)), true);
check("委托超时默认 5 分钟", routingDefault.routing.jobTimeoutMs, 300000);
check("委托超时下界夹取", normalizeConfig({ routing: { jobTimeoutMs: 100 } }).routing.jobTimeoutMs, 30000);
check("委托超时的上报间隔可配", normalizeConfig({ routing: { reportPollMs: 200 } }).routing.reportPollMs, 500);

// ── 两层架构：路由输出解析（三层防跑偏）────────────────────────────────
const known = routingDefault.routing.workers;
check("标准 JSON 直接解析", parseRouteOutput('{"worker":"coder","task":"写一个脚本"}', known, "原文"), { worker: "coder", task: "写一个脚本" });
check("剥掉代码块围栏", parseRouteOutput("```json\n{\"worker\":\"researcher\",\"task\":\"调研\"}\n```", known, "原文"), { worker: "researcher", task: "调研" });
check("前后带解释文字也能抠出 JSON", parseRouteOutput('好的，路由如下：{"worker":"operator","task":"建文件夹"} 请查收', known, "原文"), { worker: "operator", task: "建文件夹" });
check("未知 worker 落 general", parseRouteOutput('{"worker":"不存在的专家","task":"x"}', known, "原文"), { worker: "general", task: "x" });
check("task 空串回退原文", parseRouteOutput('{"worker":"coder","task":""}', known, "用户原话"), { worker: "coder", task: "用户原话" });
check("非 JSON 返回 null", parseRouteOutput("我认为应该交给编程专家处理。", known, "原文"), null);
check("空输出返回 null", parseRouteOutput("", known, "原文"), null);
check("null 输出返回 null", parseRouteOutput(null, known, "原文"), null);

// ── preset 挂载（坑十三：不带 preset 的 agent 没有文件/命令工具）──────
check("默认 preset 是 standard", empty.agent.preset, "standard");
check("preset 写 none 显式关闭", normalizeConfig({ agent: { preset: "none" } }).agent.preset, "none");
check("preset 非字符串回落默认", normalizeConfig({ agent: { preset: 42 } }).agent.preset, "standard");
{
	const calls = [];
	const fakePresets = {
		resolve: async (id) => ({ id: id ?? "standard" }),
		mount: async (agentCtx, id) => {
			calls.push({ agentCtx, id });
			return { id };
		},
	};
	const mounted = await mountAgentPreset({ get: () => fakePresets }, "standard");
	check("preset 挂载成功并记录 id", mounted, { mounted: true, id: "standard" });
	check("mount 收到解析后的 preset id", calls[0].id, "standard");
}
check("preset 写 none = 显式关闭", await mountAgentPreset({}, "none"), { mounted: false, reason: "off" });
check("preset 服务缺失可见降级", await mountAgentPreset({ get: () => undefined }, "standard"), {
	mounted: false,
	reason: "service-missing",
});
check("preset get 抛异常可见降级", (await mountAgentPreset({ get: () => { throw new Error("boom"); } }, "standard")).mounted, false);
check(
	"preset 服务缺方法可见降级",
	(await mountAgentPreset({ get: () => ({ resolve: async (id) => ({ id }) }) }, "standard")).reason,
	"service-incomplete",
);
{
	// composeAgentScope 现在是 async 且返回 preset 报告 —— ensurePersistentAgent
	// 的 setup 依赖 agent-loop await 它（回归点）。
	const out = await composeAgentScope(
		{ get: (name) => (name === "agentPresets" ? { resolve: async (id) => ({ id }), mount: async (_c, id) => ({ id }) } : undefined) },
		{ agent: { persona: "", preset: "standard" } },
	);
	check("composeAgentScope 返回 preset 挂载结果", out.preset, { mounted: true, id: "standard" });
}

// ── V1.3：派单 → 要点汇总 → 按完成先后汇报 ────────────────────────────
{
	const queue = createReportQueue({ limit: 5 });
	check("首帧 latest 只同步游标、不重放历史", queue.after("latest").reports.length, 0);
	const first = queue.push({ label: "阿码", summary: "写好了", ok: true, finishedAt: 1000 });
	const second = queue.push({ label: "阿研", summary: "调研完了", ok: true, finishedAt: 1001 });
	check("汇报按完成时间升序", queue.after(0).reports.map((row) => row.label), ["阿码", "阿研"]);
	check("游标落在最后一条完成时刻", queue.after(0).cursor, second.at);
	check("单调时刻保证第二条严格晚于第一条", second.at > first.at, true);
	check("无 after 参数解析为 null", parseReportAfter("/plugins/dsh-voice-assistant/api/reports"), null);
	check("latest 参数原样解析", parseReportAfter("/plugins/dsh-voice-assistant/api/reports?after=latest"), "latest");
	check("数字参数原样解析", parseReportAfter("/api/reports?after=1234"), "1234");

	check("规则摘要保留路径", deterministicSummary({ result: "文件在 D:\\a.py", ok: true }), "文件在 D:\\a.py。");
	check("规则摘要说清失败原因", deterministicSummary({ ok: false, reason: "模型没配置" }), "任务失败，原因是模型没配置。");
	check("播报文案带专家名", formatReportSpeech({ label: "阿码", summary: "文件在 D:\\a.py。", ok: true }), "阿码回报：文件在 D:\\a.py。");
	check("失败文案不重复任务失败四字", formatReportSpeech({ label: "阿码", ok: false, reason: "工具不可用" }), "阿码：任务失败，原因是工具不可用。");

	/** 造一个最小事件总线（只要 on/emit/get/logger）。 */
	const makeCtx = () => {
		const handlers = new Map();
		return {
			on(name, callback) {
				const set = handlers.get(name) ?? new Set();
				set.add(callback);
				handlers.set(name, set);
				return () => set.delete(callback);
			},
			emit(name, payload) {
				for (const callback of handlers.get(name) ?? []) callback(payload);
			},
			get: () => undefined,
			logger: { info() {}, warn() {} },
		};
	};

	/** 造一个可控的 worker agent：followup 记录任务，finish() 模拟一轮完成。 */
	const makeAgent = (ctx, id) => {
		const state = { calls: [], idles: [], idleResolvers: [] };
		const agent = {
			id: `fake-agent-${id}`,
			followup(payload) {
				state.calls.push(payload);
				// 完成信号在 followup 时就建好：真实 agent 也是"任务一投进去就开始计时"。
				// 若等到 whenIdle() 才建，测试里先 finish 后 whenIdle 会丢信号。
				state.idles.push(
					new Promise((resolve) => {
						state.idleResolvers.push(resolve);
					}),
				);
			},
			whenIdle() {
				const index = state.calls.length - 1;
				return state.idles[index] ?? Promise.resolve();
			},
			finish(index, text) {
				ctx.emit("agent/assistant-stream", { agent, frame: { type: "start" } });
				ctx.emit("agent/assistant-stream", { agent, frame: { type: "chunk", chunk: { type: "text-delta", text } } });
				ctx.emit("agent/assistant-stream", { agent, frame: { type: "end", outcome: { kind: "committed" } } });
				state.idleResolvers[index]?.();
			},
		};
		return { agent, state };
	};

	const waitFor = async (predicate, timeout = 3000) => {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			if (predicate()) return true;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		return false;
	};

	// 同一 worker 连续两次派单：必须串行，否则后一任务会覆盖 liveText，
	// 前一任务播报成后一任务的结论（界面上完全看不出串台）。
	{
		const ctx = makeCtx();
		const { agent, state } = makeAgent(ctx, "coder");
		const hub = createDelegationHub(ctx, normalizeConfig({}), {
			workers: [{ id: "coder", label: "阿码", agent }],
		});
		const r1 = hub.submit("coder", "写第一个脚本");
		check("委托当场返回成功", r1.ok, true);
		check("任务立刻投进 worker", await waitFor(() => state.calls.length === 1), true);
		const message = state.calls[0];
		check("投给 worker 的是带 id 的消息", typeof message?.id === "string" && message.id !== "", true);
		check("消息角色为 user", message?.role, "user");
		check("消息来源可追溯", message?.source?.kind, "voice-router");
		hub.submit("coder", "写第二个脚本");
		await new Promise((resolve) => setTimeout(resolve, 60));
		check("同一 worker 的第二条不会插队", state.calls.length, 1);
		agent.finish(0, "第一件完成，文件在 D:\\one.py");
		check("第一条完成后才投第二条", await waitFor(() => state.calls.length === 2), true);
		agent.finish(1, "第二件完成，文件在 D:\\two.py");
		check("两条汇报都入队", await waitFor(() => hub.queue.size === 2), true);
		check(
			"同一 worker 连续任务结果不串台",
			hub.queue.after(0).reports.map((row) => row.result),
			["第一件完成，文件在 D:\\one.py", "第二件完成，文件在 D:\\two.py"],
		);
		hub.dispose();
	}

	// 不同 worker 并行，但汇报按完成时间先后排队（用户明确要求 2）。
	{
		const ctx = makeCtx();
		const coder = makeAgent(ctx, "coder-2");
		const researcher = makeAgent(ctx, "researcher");
		const hub = createDelegationHub(ctx, normalizeConfig({}), {
			workers: [
				{ id: "coder", label: "阿码", agent: coder.agent },
				{ id: "researcher", label: "阿研", agent: researcher.agent },
			],
		});
		hub.submit("researcher", "调研一份资料");
		hub.submit("coder", "改一个 bug");
		check("不同 worker 并行投递", await waitFor(() => coder.state.calls.length === 1 && researcher.state.calls.length === 1), true);
		coder.agent.finish(0, "编程先完成，bug 已修好");
		await new Promise((resolve) => setTimeout(resolve, 15));
		researcher.agent.finish(0, "调研后完成，报告已写好");
		check("两条汇报都入队", await waitFor(() => hub.queue.size === 2), true);
		check(
			"汇报顺序 = 完成时间先后，不是派单先后",
			hub.queue.after(0).reports.map((row) => row.label),
			["阿码", "阿研"],
		);
		hub.dispose();
	}

	// 卡住的任务必须有界收尾：worker 请求人工确认时 whenIdle() 永不 resolve，
	// 没有超时就永远占住队列，用户听不到任何"失败"。
	{
		const ctx = makeCtx();
		const agent = {
			id: "fake-agent-stuck",
			followup() {
				// 起了轮，但永远不结束（等价于 approval/asked 挂着等人工点）。
				ctx.emit("agent/assistant-stream", { agent, frame: { type: "start" } });
			},
			whenIdle: () => new Promise(() => {}),
		};
		const hub = createDelegationHub(ctx, { routing: { jobTimeoutMs: 60 } }, {
			workers: [{ id: "stuck", label: "阿卡", agent }],
		});
		hub.submit("stuck", "请求提权写文件");
		check("超时后仍给出汇报", await waitFor(() => hub.queue.size === 1, 3000), true);
		const report = hub.queue.after(0).reports[0];
		check("超时汇报标为失败", report?.ok, false);
		check("超时原因如实说出", String(report?.reason).includes("未完成"), true);
		check("超时后不再占用在途任务", hub.state().activeJobs.length, 0);
		hub.dispose();
	}
}

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	for (const failure of failures) console.error(`  - ${failure.name}: ${JSON.stringify(failure.actual)} / 期望 ${JSON.stringify(failure.expected)}`);
	process.exitCode = 1;
} else {
	console.log("\n全部通过");
}
