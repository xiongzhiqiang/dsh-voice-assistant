/**
 * 本机 HTTP API（宿主半）。
 *
 * ## 为什么用普通 HTTP 路由而不是 DSH 的 remote/typert 通道
 *
 * typert 是给**会话域**（session / workspace）用的强类型远程面，注册一个新
 * 命名空间要动 schema 与 gateway；而语音流是**无会话状态**的旁路数据：
 * 一段音频进、一段文本出。用 `webServer.register` 开一个前缀路由最简单，
 * 也不占 DSH 的远程协议版本。
 *
 * ## 路径前缀为什么带插件名
 *
 * `/plugins/dsh-voice-assistant/api` 与官方 `/plugins/<pkg>/client.js` 的
 * bundle 路由同源不同段，天然不冲突；带上插件名也让 `netstat` 抓包、
 * 反代规则、日志排查都能一眼定位来源。
 *
 * ## 一致性约束
 *
 * 所有 handler **独占响应生命周期**（自己写状态码、头、end），异常统一由
 * `route()` 兜底成 JSON 错误 —— 漏 `end` 会让浏览器请求永久挂起，
 * 表现为"点了没反应"，极难排查。
 */
import { clientConfig } from "./config.js";
import { API_PREFIX } from "./api-prefix.js";
import { projectActivities } from "./activities.js";
import { polishWithModel, quickClean, resolveRoute } from "./polish.js";
import { routeUtterance } from "./router.js";
import { formatReportSpeech, parseReportAfter } from "./report.js";
import { parseInteractionAfter } from "./interactions.js";
import { synthesize, transcribe } from "./upstream.js";

/** API 前缀（客户端据此拼请求）。单一来源在 `api-prefix.js`，此处转发保持对外 API 不变。 */
export { API_PREFIX } from "./api-prefix.js";

/** 各端点请求体上限。 */
const LIMITS = {
	polish: 64 * 1024,
	asr: 8 * 1024 * 1024,
	tts: 16 * 1024,
	delegate: 64 * 1024,
};

/** 允许的方法（全部是「读一次或做一次动作」，没有 PUT/DELETE 语义）。 */
const POST = new Set(["POST"]);

/**
 * 回一个 JSON 响应。
 * @param res - HTTP 响应。
 * @param status - 状态码。
 * @param payload - 任意可序列化值。
 */
function sendJson(res, status, payload) {
	const body = Buffer.from(JSON.stringify(payload), "utf8");
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": String(body.length),
		"cache-control": "no-store",
	});
	res.end(body);
}

/**
 * 回一个纯文本响应。
 * @param res - HTTP 响应。
 * @param status - 状态码。
 * @param message - 文本。
 * @param headers - 附加头。
 */
function sendText(res, status, message, headers = {}) {
	const body = Buffer.from(message, "utf8");
	res.writeHead(status, {
		"content-type": "text/plain; charset=utf-8",
		"content-length": String(body.length),
		"cache-control": "no-store",
		...headers,
	});
	res.end(body);
}

/**
 * 读请求体，超限即中止。
 *
 * 必须设上限：这个端点暴露在本机 DSH 上，没有上限时一段 500MB 的
 * 请求体足以把宿主进程的内存打满。
 *
 * @param req - HTTP 请求。
 * @param limit - 字节上限。
 * @returns 请求体 Buffer。
 * @throws 超限时抛 `body-too-large`。
 */
function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > limit) {
				reject(new Error("body-too-large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/**
 * 解析 JSON 请求体。
 * @param req - HTTP 请求。
 * @param limit - 字节上限。
 * @returns 解析后的对象（空体返回 `{}`）。
 */
async function readJson(req, limit) {
	const buffer = await readBody(req, limit);
	if (buffer.length === 0) return {};
	try {
		return JSON.parse(buffer.toString("utf8"));
	} catch {
		throw new Error("invalid-json");
	}
}

/**
 * 从 `req.url` 里取出口径一致的子路径（去掉前缀与查询串）。
 * @param url - `req.url`。
 * @returns 形如 `/polish` 的子路径；不在前缀内返回 `null`。
 */
function subPath(url) {
	const path = String(url ?? "").split("?")[0];
	if (!path.startsWith(API_PREFIX)) return null;
	const rest = path.slice(API_PREFIX.length);
	return rest === "" ? "/" : rest;
}

/**
 * 安装 API 路由。
 *
 * @param ctx - 宿主 Cordis 上下文。
 * @param config - 归一化配置。
 * @param state - 运行期状态（由 index.js 持有，用于 health 自省）。
 * @param delegation - 委托中枢（V1.3，`{ submit, queue, state }`；可选）。
 * @param interactions - 互动中枢（需求④，`{ queue, state }`；可选）。
 * @returns 卸载函数。
 * @throws `webServer` 缺失或路由重复注册时抛出（由调用方决定降级策略）。
 */
export function installApiRoutes(ctx, config, state, delegation = null, interactions = null) {
	const webServer = ctx.get("webServer");
	if (webServer === undefined || webServer === null) {
		throw new Error("webServer 服务不可用（语音助手需要它暴露本机 API）");
	}

	/**
	 * 路由分派。
	 * @param request - HTTP 请求。
	 * @param response - HTTP 响应。
	 */
	async function route(request, response) {
		const path = subPath(request.url);
		const method = String(request.method ?? "GET").toUpperCase();

		try {
			if (path === "/health") {
				sendJson(response, 200, {
					ok: true,
					plugin: "dsh-voice-assistant",
					api: API_PREFIX,
					...state(),
				});
				return;
			}

			if (path === "/config") {
				sendJson(response, 200, clientConfig(config, state().capabilities ?? {}));
				return;
			}

			/**
			 * V1.6 卡通形象用的轻量工作态。
			 *
			 * 刻意不复用 /health：那是几 KB 的大对象，1.5s 轮询太重；
			 * 这里只回专家的忙闲 + 当前任务，几十字节。
			 */
			if (path === "/activities") {
				const delegationState = typeof delegation?.state === "function" ? delegation.state() : {};
				sendJson(response, 200,
					projectActivities(config.routing.workers, delegationState.activeJobs, Date.now()),
				);
				return;
			}

			if (path === "/polish") {
				if (!POST.has(method)) {
					sendText(response, 405, "polish requires POST", { allow: "POST" });
					return;
				}
				const body = await readJson(request, LIMITS.polish);
				const raw = typeof body?.text === "string" ? body.text.trim() : "";
				if (raw === "") {
					sendJson(response, 400, { error: "empty-text" });
					return;
				}

				const started = Date.now();
				if (!config.polish.enabled) {
					sendJson(response, 200, { text: raw, via: "off", ms: Date.now() - started });
					return;
				}

				const routeInfo = resolveRoute(ctx, config);
				try {
					const polished = await polishWithModel(ctx, config, raw, routeInfo);
					sendJson(response, 200, { text: polished, via: "llm", ms: Date.now() - started });
				} catch (error) {
					// 模型路径失败一律降级，但把原因带回去，界面能显示"这次是规则清理"。
					const reason = String(error?.message ?? error);
					ctx.logger?.warn?.(`voice-assistant: 润色降级为规则清理 —— ${reason}`);
					if (!config.polish.fallback) {
						sendJson(response, 200, { text: raw, via: "raw", reason, ms: Date.now() - started });
						return;
					}
					sendJson(response, 200, { text: quickClean(raw), via: "rules", reason, ms: Date.now() - started });
				}
				return;
			}

			if (path === "/route") {
				if (!POST.has(method)) {
					sendText(response, 405, "route requires POST", { allow: "POST" });
					return;
				}
				const body = await readJson(request, LIMITS.polish);
				const raw = typeof body?.text === "string" ? body.text.trim() : "";
				if (raw === "") {
					sendJson(response, 400, { error: "empty-text" });
					return;
				}
				if (!config.routing.enabled) {
					// 路由关闭不是错误：返回兜底结果，客户端照旧走根 agent。
					sendJson(response, 200, { worker: "general", task: raw, via: "off" });
					return;
				}
				const started = Date.now();
				try {
					const routeInfo = resolveRoute(ctx, config);
					const outcome = await routeUtterance(ctx, config, raw, config.routing.workers, routeInfo);
					sendJson(response, 200, { ...outcome, ms: Date.now() - started });
				} catch (error) {
					// 路由层自己有降级链，到这里的是意外异常 —— 仍回兜底结果，
					// 绝不让"选错了人"升级成"话没发出去"。
					const reason = String(error?.message ?? error);
					ctx.logger?.warn?.(`voice-assistant: 意图路由异常，已降级 general —— ${reason}`);
					sendJson(response, 200, { worker: "general", task: raw, via: "fallback", reason, ms: Date.now() - started });
				}
				return;
			}

			/**
			 * V1.3 委托：router 把任务交给 worker 后台执行，当场返回。
			 *
			 * 与旧版「切会话旁听」的根本区别：这里**不碰客户端会话**，只把
			 * 任务投进 worker 的 inbox；worker 完成后由委托中枢汇总要点入队，
			 * 客户端经 /reports 按完成先后取回播报。
			 */
			if (path === "/delegate") {
				if (!POST.has(method)) {
					sendText(response, 405, "delegate requires POST", { allow: "POST" });
					return;
				}
				if (delegation === null || typeof delegation.submit !== "function" || !config.routing.enabled) {
					sendJson(response, 503, { ok: false, error: "delegation-unavailable" });
					return;
				}
				const body = await readJson(request, LIMITS.delegate);
				const workerId = typeof body?.worker === "string" ? body.worker.trim() : "";
				const task = typeof body?.task === "string" ? body.task.trim() : "";
				if (workerId === "" || task === "") {
					sendJson(response, 400, { ok: false, error: "worker-and-task-required" });
					return;
				}
				try {
					const result = delegation.submit(workerId, task);
					sendJson(response, result.ok === true ? 200 : 422, result);
				} catch (error) {
					ctx.logger?.warn?.(`voice-assistant: 委托提交异常 —— ${String(error?.message ?? error)}`);
					sendJson(response, 500, { ok: false, error: "delegate-threw", detail: String(error?.message ?? error) });
				}
				return;
			}

			/** V1.3 汇报：客户端按 after 游标取完成要点（按完成时间升序）。 */
			if (path === "/reports") {
				if (delegation === null || delegation.queue === undefined) {
					sendJson(response, 503, { error: "delegation-unavailable" });
					return;
				}
				const after = parseReportAfter(request.url);
				const { reports, cursor } = delegation.queue.after(after);
				// 顺手附上播报文案：口径统一在宿主，客户端只管念。
				sendJson(response, 200, {
					reports: reports.map((report) => ({ ...report, speech: formatReportSpeech(report) })),
					cursor,
				});
				return;
			}

			/**
			 * 需求④：统一互动流 —— 按 `at`（发生时间）升序取回
			 * 权限审核 / 模型提问 / 结果汇报三类。
			 *
			 * 与 `/reports` 分开而不是替换它：`/reports` 是"委托结果"这一
			 * 语义的端点（仍被既有客户端与冒烟脚本使用），`/interactions`
			 * 是"需要用户知道的事"这条更宽的流。两者数据有重叠（汇报），
			 * 但**契约不同**，合并会让两边的调用方都变脆。
			 */
			if (path === "/interactions") {
				if (interactions === null || interactions.queue === undefined) {
					sendJson(response, 503, { error: "interactions-unavailable" });
					return;
				}
				const after = parseInteractionAfter(request.url);
				const { interactions: entries, cursor } = interactions.queue.after(after);
				sendJson(response, 200, { interactions: entries, cursor });
				return;
			}

			if (path === "/asr") {
				if (!POST.has(method)) {
					sendText(response, 405, "asr requires POST", { allow: "POST" });
					return;
				}
				if (config.asr.engine !== "http" || config.asr.http.baseURL === "") {
					sendJson(response, 503, { error: "asr-not-configured" });
					return;
				}
				const audio = await readBody(request, LIMITS.asr);
				if (audio.length === 0) {
					sendJson(response, 400, { error: "empty-audio" });
					return;
				}
				const mimeType = String(request.headers["content-type"] ?? "audio/webm");
				const languageHeader = request.headers["x-voice-language"];
				const language = typeof languageHeader === "string" ? languageHeader : config.language;
				try {
					const text = await transcribe(config.asr.http, audio, mimeType, language);
					sendJson(response, 200, { text, via: "http" });
				} catch (error) {
					ctx.logger?.warn?.(`voice-assistant: 上游转写失败 —— ${error?.message ?? error}`);
					sendJson(response, 502, { error: "asr-upstream-failed", detail: String(error?.message ?? error) });
				}
				return;
			}

			if (path === "/tts") {
				if (!POST.has(method)) {
					sendText(response, 405, "tts requires POST", { allow: "POST" });
					return;
				}
				if (config.tts.engine !== "http" || config.tts.http.baseURL === "") {
					sendJson(response, 503, { error: "tts-not-configured" });
					return;
				}
				const body = await readJson(request, LIMITS.tts);
				const text = typeof body?.text === "string" ? body.text : "";
				try {
					const { bytes, contentType } = await synthesize(config.tts.http, text);
					response.writeHead(200, {
						"content-type": contentType,
						"content-length": String(bytes.length),
						"cache-control": "no-store",
					});
					response.end(Buffer.from(bytes));
				} catch (error) {
					ctx.logger?.warn?.(`voice-assistant: 上游合成失败 —— ${error?.message ?? error}`);
					sendJson(response, 502, { error: "tts-upstream-failed", detail: String(error?.message ?? error) });
				}
				return;
			}

			sendJson(response, 404, { error: "unknown-endpoint", path });
		} catch (error) {
			const message = String(error?.message ?? error);
			const status = message === "body-too-large" ? 413 : message === "invalid-json" ? 400 : 500;
			if (!response.headersSent) sendJson(response, status, { error: message });
			else response.end();
		}
	}

	const dispose = webServer.register({ kind: "prefix", path: API_PREFIX, handler: route });
	ctx.logger?.info?.(
		`voice-assistant: API 已注册 ${API_PREFIX} （润色 ${config.polish.enabled ? config.polish.style : "关闭"}，ASR ${config.asr.engine}，TTS ${config.tts.engine}）`,
	);
	return dispose;
}
