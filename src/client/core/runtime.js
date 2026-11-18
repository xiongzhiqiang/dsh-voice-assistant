/**
 * 运行期：配置读取、本机 API 调用、日志。
 *
 * ## 配置从哪来
 *
 * 宿主半通过 `webserver/index-inject` 把归一化配置编成
 * `globalThis.__VOICE_ASSISTANT_CONFIG__` 塞进首帧，早于本 bundle 求值。
 * 因此这里**同步读取**即可，不需要 await —— 首屏就能显示正确的唤醒词与位置。
 *
 * 拿不到时（纯前端调试、宿主半未装）用 `FALLBACK` 兜底：功能降级为
 * "浏览器语音 + 规则清理"，但界面能正常渲染并明确提示未连上宿主。
 */
import { API_PREFIX } from "./constants.js";

/** 宿主缺失时的兜底配置（字段与 `lib/config.js` 的 clientConfig 对齐）。 */
const FALLBACK = {
	wake: { word: "小凤", aliases: ["小风", "晓凤", "小枫"], inlineCommand: true },
	language: "zh-CN",
	sleep: { idleTimeoutMs: 60000, keepWakeWord: false, chime: true },
	asr: { engine: "webspeech", httpReady: false, httpModel: "whisper-1", maxSegmentMs: 15000 },
	tts: { engine: "browser", voice: "", rate: 1, httpReady: false, httpModel: "tts-1" },
	polish: { enabled: true, style: "clean", timeoutMs: 8000, available: false, model: "" },
	session: { mode: "dedicated", requestedMode: "dedicated", title: "小凤语音会话", workspace: "", label: "小凤 · 常驻助手" },
	agent: { enabled: false, sessionId: "", personaActive: false, steer: true },
	// 两层架构：宿主缺失时路由视为关闭（没有 worker 可切）。
	routing: { enabled: false, workers: [], reportPollMs: 1500 },
	answers: { questionTimeoutMs: 60000, chime: true, repeatOnce: true },
	// 需求④统一互动流：宿主缺失时视为关闭（没有宿主就没有审批/汇报可播）。
	interactions: { enabled: false, announceApprovals: true, announceQuestions: true, pollMs: 1500 },
	// 全局记忆。宿主缺失时一律视为未生效 —— 它本来就只能在宿主侧注册，
	// 这里给 `global:false` 是为了让面板有一句确定的"未开启"而不是 `undefined`。
	memory: { global: false, active: false },
	// 轮次门槛：宿主缺失时也必须有一份可用默认值，否则客户端会以
	// `undefined` 建 `TurnGate`（退化成内置默认，但界面显示会缺字段）。
	turn: { silenceMs: 10000, maxTurnMs: 300000, echoGuard: true, steerWhileThinking: false },
	ui: { position: "bottom-right", accent: "#2f6bff", showTranscript: true },
	capabilities: { polishAvailable: false, asrHttpReady: false, ttsHttpReady: false, agentAvailable: false },
};

/** 宿主配置的全局变量名（与 `index.js` 的 `CLIENT_CONFIG_GLOBAL` 一致）。 */
const GLOBAL = "__VOICE_ASSISTANT_CONFIG__";

/**
 * 读取并补全配置。
 *
 * 逐层合并而不是整体替换：宿主半未来新增字段时，旧客户端仍能拿到
 * 完整的默认值，不会因为某个子对象缺失整块 `undefined` 崩掉。
 *
 * @returns 合并后的配置。
 */
export function readConfig() {
	const injected =
		typeof globalThis !== "undefined" && globalThis[GLOBAL] !== null && typeof globalThis[GLOBAL] === "object"
			? globalThis[GLOBAL]
			: null;
	const base = FALLBACK;
	if (injected === null) return { config: base, fromHost: false };
	return {
		fromHost: true,
		config: {
			wake: { ...base.wake, ...(injected.wake ?? {}) },
			language: injected.language ?? base.language,
			sleep: { ...base.sleep, ...(injected.sleep ?? {}) },
			asr: { ...base.asr, ...(injected.asr ?? {}) },
			tts: { ...base.tts, ...(injected.tts ?? {}) },
			polish: { ...base.polish, ...(injected.polish ?? {}) },
			session: { ...base.session, ...(injected.session ?? {}) },
			agent: { ...base.agent, ...(injected.agent ?? {}) },
			routing: { ...base.routing, ...(injected.routing ?? {}) },
			answers: { ...base.answers, ...(injected.answers ?? {}) },
			interactions: { ...base.interactions, ...(injected.interactions ?? {}) },
			memory: { ...base.memory, ...(injected.memory ?? {}) },
			turn: { ...base.turn, ...(injected.turn ?? {}) },
			ui: { ...base.ui, ...(injected.ui ?? {}) },
			capabilities: { ...base.capabilities, ...(injected.capabilities ?? {}) },
		},
	};
}

/** 统一日志前缀，便于在混杂的控制台里过滤。 */
export function log(...args) {
	console.log("[小凤]", ...args);
}

/** 统一告警前缀。 */
export function warn(...args) {
	console.warn("[小凤]", ...args);
}

/**
 * 调本机 API。
 *
 * @param path - 相对前缀的路径，如 `/polish`。
 * @param options - `{ method, body, headers }`。
 * @returns 解析后的响应；非 2xx 时抛错（`error` 字段作为 message）。
 */
async function request(path, options = {}) {
	const response = await fetch(`${API_PREFIX}${path}`, {
		method: options.method ?? "POST",
		headers: options.headers,
		body: options.body,
	});
	if (!response.ok) {
		let detail = `http-${response.status}`;
		try {
			const payload = await response.json();
			if (typeof payload?.error === "string") detail = payload.error;
			if (typeof payload?.detail === "string") detail += `: ${payload.detail}`;
		} catch {
			// 响应不是 JSON（例如 405 纯文本），保留状态码即可。
		}
		throw new Error(detail);
	}
	return response;
}

/**
 * 请求转录润色。
 * @param text - 原始转录。
 * @returns `{ text, via, reason? }`。
 */
export async function polish(text) {
	const response = await request("/polish", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
	});
	return response.json();
}

/**
 * 请求意图路由（两层架构第一层）。
 * @param text - 已润色的指令文本。
 * @returns `{ worker, task, via, ms? }`；失败时由调用方降级。
 */
export async function route(text) {
	const response = await request("/route", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
	});
	return response.json();
}

/**
 * V1.3：把任务委托给 worker 后台执行（当场返回，不切会话）。
 * @param worker - worker id。
 * @param task - 路由改写后的任务文本。
 * @returns `{ ok, jobId?, workerId, label?, error? }`。
 */
export async function delegate(worker, task) {
	const response = await request("/delegate", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ worker, task }),
	});
	return response.json();
}

/**
 * V1.3：按 after 游标取回 worker 的完成要点（按完成时间升序）。
 * @param after - 毫秒时间戳，或 `"latest"`（首帧只取游标、不重放历史）。
 * @returns `{ reports: [{seq,at,label,summary,ok,speech,...}], cursor }`。
 */
export async function reports(after) {
	const query = after === undefined || after === null ? "" : `?after=${encodeURIComponent(String(after))}`;
	const response = await request(`/reports${query}`, { method: "GET" });
	return response.json();
}

/**
 * 需求④：按 `at` 游标取回**统一互动流**（权限审核 / 模型提问 / 结果汇报）。
 *
 * 与 `reports()` 并存而不是取而代之：`reports` 仍被既有调用与冒烟脚本
 * 使用；这条流是"需要用户知道的事"的更宽口径。两者数据有重叠（汇报），
 * 但客户端只**播报其中一条**（见 controller 的 `interactionCursor` 注释），
 * 否则同一条汇报会被念两遍。
 *
 * @param after - 毫秒时间戳，或 `"latest"`（首帧只取游标、不重放历史）。
 * @returns `{ interactions: [{seq,at,kind,key,label,speech,detail}], cursor }`。
 */
export async function interactions(after) {
	const query = after === undefined || after === null ? "" : `?after=${encodeURIComponent(String(after))}`;
	const response = await request(`/interactions${query}`, { method: "GET" });
	return response.json();
}

/**
 * 请求上游转写（仅 http 引擎使用）。
 * @param blob - 音频。
 * @param language - 语言提示。
 * @returns `{ text }`。
 */
export async function transcribe(blob, language) {
	const response = await request("/asr", {
		method: "POST",
		headers: {
			"content-type": blob.type === "" ? "audio/webm" : blob.type,
			"x-voice-language": language,
		},
		body: blob,
	});
	return response.json();
}

/**
 * 请求上游合成（仅 http 引擎使用）。
 * @param text - 要念的文本。
 * @returns `{ blob }`。
 */
export async function synthesize(text) {
	const response = await request("/tts", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text }),
	});
	return { blob: await response.blob() };
}

/**
 * 探测宿主健康状态（含能力自省）。
 * @returns 健康体；失败返回 `null`。
 */
export async function health() {
	try {
		const response = await request("/health", { method: "GET" });
		return await response.json();
	} catch {
		return null;
	}
}
