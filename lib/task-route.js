/**
 * 任务归属判定（V2.3，需求④）。
 *
 * ## 判定什么
 *
 * 一条新指令进来，先回答一个问题：**它属于台账里的某条老任务，还是一条新任务？**
 *
 * ```
 * 答案 = 老任务 → 投进那条任务的会话（需求④前半）
 * 答案 = 新任务 → 开新会话，用任务名命名（需求④后半 + 需求③）
 * ```
 *
 * ## 为什么规则在前、LLM 在后
 *
 * 纯 LLM 判定有两个现实问题：一是每条指令多一次往返（语音场景里就是多等
 * 一两秒）；二是模型偶尔会把两条无关任务"合并"，而这种错误用户看到的只是
 * "任务怎么跑到别的会话去了"，既难复现也难归因。
 *
 * 纯规则判定也不行：中文口语里"把结果画成火山图"和"分析 AG28 差异表达"
 * 字面几乎不重叠，但语义上就是同一条任务的下一步 —— 规则永远接不住。
 *
 * 所以做成两段：
 *   1. 规则先算字符二元组相似度，**足够高就直接复用**（几乎同一句话的复述，
 *      零延迟、零不确定性）；
 *   2. 拿不准才问 LLM 一句 yes/no（附完整任务清单，让它看语义与时间）。
 *
 * 拿不准的档位故意开得宽（STRONG 之下全问），因为**误开新会话**（同一条任务
 * 被拆散到多个会话里，专家每段都要重新问背景）比**多问一次模型**难受得多。
 *
 * ## 降级链
 *
 * LLM 失败/超时/输出不可解析 → 退到弱阈值 `TASK_MATCH_WEAK` 的规则判定。
 * 绝不在"判不出来"时抛错：归属判定是**增强**，不是主链路的关卡 —— 最坏情况
 * 也应该退化成"新开一条任务"，而不是让用户的指令发不出去。
 */
import { TASK_MATCH_STRONG, TASK_TITLE_LIMIT, matchTask, titleFromTask } from "./expert-tasks.js";
import { resolveRoute } from "./polish.js";

/**
 * 降级路径的弱阈值（LLM 不可用时才用）。
 *
 * 比 STRONG 低一档：字面上有一半左右重叠就认为是同一任务。取这个值的理由是
 * 两种错误的代价不对称 —— 退化成"复用老任务"最坏只是上下文多带一点，
 * 而退化成"新开任务"会让用户看到侧边栏里凭空多出一个会话、老会话停在那儿。
 */
export const TASK_MATCH_WEAK = 0.34;

/** 归属判定 LLM 的超时夹取（毫秒）。 */
const ATTRIBUTE_TIMEOUT_MIN = 2000;
const ATTRIBUTE_TIMEOUT_MAX = 12000;
/** 归属判定输出长度上限。 */
const ATTRIBUTE_MAX_TOKENS = 120;

/**
 * 归属判定系统提示词。
 *
 * 沿用 polish / router 同一条纪律：用 `<<< >>>` 把材料包成**引用**，防止模型
 * 把用户指令或任务标题当成对它说的话。输出限定成一个 JSON 对象，`taskId`
 * 填 `""` 表示"这是新任务"。
 */
const ATTRIBUTE_PROMPT = [
	"你在为一位后台专家维护它的任务台账。你会收到两段材料（都在 <<< >>> 之间）：",
	"A 段是这位专家最近接过的任务清单；B 段是用户刚说的一句新指令。",
	"任务：判断 B 段这句指令是 A 段里某一条任务的**延续**（补充、追问、下一步），还是一条**全新的**任务。",
	"规则：",
	'1. 只输出一个 JSON 对象，形如 {"taskId":"<清单里的 id>"}；若是全新任务则输出 {"taskId":""}。',
	"2. 判断依据是**任务目标是否相同**，不要只看用词。",
	'   例：「把结果画成火山图」延续「分析 AG28 差异表达」—— 目标是同一份分析，属老任务。',
	'   例：「给这个仓库写个 README」与「分析 AG28 差异表达」目标无关，属新任务。',
	"3. 清单可能为空 —— 那就一定是新任务，输出空 taskId。",
	"4. 拿不准时选新任务（空 taskId），不要硬凑。",
	"5. 不要输出任何其它文字、解释、代码块标记或标点。",
].join("\n");

/**
 * 从 `llm.stream` 分片里取文本增量（只认 `text-delta`，与 polish/router 同一条铁律）。
 * @param chunk - 流式分片。
 * @returns 文本增量。
 */
function deltaText(chunk) {
	if (typeof chunk === "string") return chunk;
	if (chunk === null || typeof chunk !== "object") return "";
	if (chunk.type !== "text-delta") return "";
	return typeof chunk.text === "string" ? chunk.text : "";
}

/**
 * 解析归属判定的 LLM 输出（纯函数，可单测）。
 *
 * 三种常见跑偏都接住：包了代码块、前后带解释、taskId 不在清单里。
 * 不在清单里的 id 一律视作"新任务"—— 模型编不出一个会误伤老任务的 id。
 *
 * @param output - LLM 原始输出。
 * @param taskIds - 合法 taskId 白名单。
 * @returns 命中的 taskId；判为新任务或解析失败返回 `""`。
 */
export function parseAttribution(output, taskIds) {
	const text = String(output ?? "").trim();
	if (text === "") return "";
	const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start === -1 || end <= start) return "";
	let parsed;
	try {
		parsed = JSON.parse(cleaned.slice(start, end + 1));
	} catch {
		return "";
	}
	const id = typeof parsed?.taskId === "string" ? parsed.taskId.trim() : "";
	if (id === "") return "";
	const allowed = Array.isArray(taskIds) ? taskIds : [];
	return allowed.includes(id) ? id : "";
}

/**
 * 用 LLM 判断指令归属（拿不准时的第二段）。
 *
 * @param ctx - 宿主 Cordis 上下文（须能取到 `llm`）。
 * @param config - 归一化配置（读 `routing.timeoutMs`）。
 * @param params - `{ label, task, tasks }`。
 * @returns 命中的 taskId；判为新任务或任何失败返回 `""`。
 */
async function attributeWithModel(ctx, config, params) {
	const list = Array.isArray(params.tasks) ? params.tasks : [];
	if (list.length === 0) return "";
	const ids = list.map((entry) => entry.taskId).filter((id) => typeof id === "string" && id !== "");
	if (ids.length === 0) return "";

	let route = null;
	let llm = null;
	try {
		route = resolveRoute(ctx, config);
		llm = ctx.get("llm");
	} catch (error) {
		ctx.logger?.warn?.(`voice-assistant: 任务归属取模型失败，降级规则判定 —— ${String(error?.message ?? error)}`);
		return "";
	}
	if (!llm || typeof llm.stream !== "function" || route === null) return "";

	// 清单倒序（最近在前）后交给模型：与渲染给专家的顺序一致，也让它先看到
	// 最可能是答案的那几条。
	const roster = list
		.slice()
		.reverse()
		.map((entry) => `- ${entry.taskId}：${entry.title}（最近更新：${new Date(entry.updatedAt || entry.createdAt || 0).toLocaleString("zh-CN")}）`)
		.join("\n");

	const controller = new AbortController();
	const timeout = Math.min(ATTRIBUTE_TIMEOUT_MAX, Math.max(ATTRIBUTE_TIMEOUT_MIN, config.routing?.timeoutMs ?? 6000));
	const timer = setTimeout(() => controller.abort(), timeout);
	let assembled = "";
	try {
		const stream = llm.stream({
			provider: route.provider,
			model: route.model,
			system: ATTRIBUTE_PROMPT,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: `<<<A 段 · ${params.label ?? ""}的任务清单：\n${roster}\n\nB 段 · 新指令：${String(params.task ?? "").slice(0, TASK_TITLE_LIMIT * 6)}>>>`,
						},
					],
				},
			],
			temperature: 0,
			maxTokens: ATTRIBUTE_MAX_TOKENS,
			signal: controller.signal,
			purpose: "voice-task-attribution",
		});
		for await (const chunk of stream) assembled += deltaText(chunk);
	} catch (error) {
		ctx.logger?.warn?.(`voice-assistant: 任务归属 LLM 失败，降级规则判定 —— ${String(error?.message ?? error)}`);
		return "";
	} finally {
		clearTimeout(timer);
	}
	return parseAttribution(assembled, ids);
}

/**
 * 判定一条指令的任务归属（纯决策，不落盘、不建会话）。
 *
 * @param ctx - 宿主 Cordis 上下文。
 * @param config - 归一化配置。
 * @param params - `{ workerId, label, task, tasks, allowModel }`。
 * @returns `{ taskId, title, sessionId, created, via, score }`。
 *   `created` 为真表示这是新任务（调用方需为它开新会话）；
 *   `taskId` 为 `""` 表示完全没有台账可依赖（清单为空时直接新任务）。
 *   `via` = `rule` | `llm` | `new` | `rule-weak`，用于排障（health / 日志）。
 */
export async function attributeTask(ctx, config, params) {
	const tasks = Array.isArray(params?.tasks) ? params.tasks : [];
	const task = String(params?.task ?? "").trim();
	const title = titleFromTask(task);

	if (tasks.length === 0) {
		return { taskId: "", title, sessionId: "", created: true, via: "new", score: 0 };
	}

	const matched = matchTask(tasks, task);

	// 第一段：规则拍板（几乎同一句话的复述）。
	if (matched.task !== null && matched.score >= TASK_MATCH_STRONG) {
		return {
			taskId: matched.task.taskId,
			title: matched.task.title,
			sessionId: matched.task.sessionId,
			created: false,
			via: "rule",
			score: matched.score,
		};
	}

	// 第二段：问 LLM 看语义（可用时）。
	if (params?.allowModel !== false) {
		const hitId = await attributeWithModel(ctx, config, {
			label: params?.label,
			task,
			tasks,
		});
		if (hitId !== "") {
			const hit = tasks.find((entry) => entry.taskId === hitId);
			if (hit !== undefined) {
				return {
					taskId: hit.taskId,
					title: hit.title,
					sessionId: hit.sessionId,
					created: false,
					via: "llm",
					score: matched.score,
				};
			}
		}
		// 模型明确说"新任务"（或调用失败）—— 落到弱阈值兜底。
	}

	// 第三段：弱阈值兜底（LLM 不可用/说新任务时的最后一道规则）。
	if (matched.task !== null && matched.score >= TASK_MATCH_WEAK) {
		return {
			taskId: matched.task.taskId,
			title: matched.task.title,
			sessionId: matched.task.sessionId,
			created: false,
			via: "rule-weak",
			score: matched.score,
		};
	}

	return { taskId: "", title, sessionId: "", created: true, via: "new", score: matched.score };
}
