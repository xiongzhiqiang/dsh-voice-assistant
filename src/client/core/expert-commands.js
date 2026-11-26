/**
 * 专家管理语音命令解析（V1.7，纯函数，可单测）。
 *
 * ## 为什么在润色前、用规则而不是 LLM
 *
 * 命令是**结构化操作**（增删改查 + 参数），LLM 润色会把"删除专家 coder"
 * 改写成"帮我删掉 coder 这位专家"这类自然语言，反而丢失结构。所以在
 * `runCommand` 里对**原始转录**先跑这个解析器：命中就直接执行、不进路由；
 * 不命中才交给润色 + LLM 路由。规则解析对命令这种封闭语法既快又稳。
 *
 * ## 支持的口径（也写在 persona / README 里）
 *   - 列表：「列出专家」「有哪些专家」「专家列表」「看看有哪些专家」
 *   - 删除：「删除专家 coder」「移除专家 阿码」「删掉专家 X」
 *   - 新增：「新增专家 化学，负责化学分析」「添加专家 X，专门做 Y」
 *   - 会话（V1.8）：「列出会话」「给小因开个会话」「切换小因会话」「关闭小因会话」
 *
 * 新增时 id 由 label 派生（中文无法转拼音，用稳定哈希），播报里告诉用户
 * 生成的 id；用户也可以说"id 叫 chem"显式指定。
 *
 * 会话命令用独立的 `parseSessionCommand` 解析，由 controller 在专家命令之后
 * 调用（两者语法不重叠，先判专家增删改、再判会话）。
 */

/** 列表命令 trigger（整句或包含）。 */
const LIST_RE = /(列出|查看|看看|显示|报一下|说下).{0,4}(专家|团队|有哪些专家)|(有哪些|有些什么|多少个?)专家|专家列表|专家团队/;
/** 删除命令：抽取 id/label。必须带"专家/worker"二字，避免把普通"删除 X"误判。 */
const REMOVE_RE = /(?:删除|移除|删掉|去掉|撤销|踢掉)\s*(?:专家|worker)\s*[:：]?\s*(.+)$/i;
/** 新增命令：抽取"叫什么 + 负责什么"。 */
const ADD_RE = /(?:新增|添加|增加|新建|加一个|加个|创建)\s*(?:一个)?\s*(?:专家|worker)\s*[:：]?\s*(.+)$/i;

/**
 * 从 label 派生一个稳定的 ascii id（纯函数）。
 *
 * 中文没有拼音表，用 FNV-1a 32 位哈希取 6 位十六进制，前缀 `x-`。
 * 用户在英文 label 上得到的 id 更可读（直接 slug），中文则得到 `x-xxxxxx`。
 *
 * @param label - 展示名。
 * @returns 合法 id（匹配 `^[a-z0-9][a-z0-9_-]*$`）。
 */
export function deriveExpertId(label) {
	const raw = String(label ?? "").trim();
	// 纯 ascii 名称直接 slug，可读。
	const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
	if (slug !== "" && /[a-z]/.test(slug)) return slug;
	// 含中文 → 稳定哈希。
	let h = 0x811c9dc5;
	for (let i = 0; i < raw.length; i++) {
		h ^= raw.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return `x-${h.toString(16).padStart(6, "0").slice(0, 6)}`;
}

/** 把中文数字/口语量词归一（目前只需去掉尾部的"这位/这个/专家"等）。 */
function cleanName(text) {
	return String(text ?? "")
		.trim()
		.replace(/[,，。.!！?？、;；\s]+$/, "")
		.replace(/^(叫|名叫|id|ID|名称)\s*[:：]?\s*/i, "")
		.trim();
}

/**
 * 解析一条语音命令。
 *
 * @param raw - 原始转录文本（润色前）。
 * @returns `{ kind:"list" }` / `{ kind:"remove", id }` /
 *   `{ kind:"add", expert:{id,label,description,persona,skills} }` / `null`。
 */
export function parseExpertCommand(raw) {
	if (typeof raw !== "string") return null;
	const text = raw.trim();
	if (text === "") return null;

	// 列表优先（"列出专家"不该被删除/新增的正则误吃）。
	if (LIST_RE.test(text)) return { kind: "list" };

	// 删除。
	const removeMatch = text.match(REMOVE_RE);
	if (removeMatch) {
		let name = cleanName(removeMatch[1]);
		// "删除专家" 后面没内容 = 不是有效命令（可能是半句话）。
		if (name === "" || /^(列表|有哪些|有哪些专家)$/.test(name)) return null;
		// 显式 id："删除专家 id coder" / "删除专家 coder"。
		name = name.replace(/^id\s*[:：]?\s*/i, "").trim();
		if (name === "") return null;
		return { kind: "remove", id: name.toLowerCase().replace(/\s+/g, "-") };
	}

	// 新增。
	const addMatch = text.match(ADD_RE);
	if (addMatch) {
		const body = cleanName(addMatch[1] ?? "");
		if (body === "") return null;
		// 拆 "名称 + 描述"：连接词（负责/专门/…）作分隔，逗号可有可无。
		let name = body;
		let description = "";
		const split = body.match(/^(.+?)\s*[,，]?\s*(?:负责|专门(?:做|于)?|用于|主要|做|能|可以|用来|擅长)\s*(.+)$/);
		if (split) {
			name = cleanName(split[1]);
			description = cleanName(split[2]);
		} else {
			// 只有逗号、没有连接词："新增专家 化学，化学分析"。
			const comma = body.match(/^(.+?)\s*[,，]\s*(.+)$/);
			if (comma) {
				name = cleanName(comma[1]);
				description = cleanName(comma[2]);
			}
		}
		if (name === "") return null;
		// 兜底描述：没说清职责就给一句通用的，让专家能建起来（用户可后续补）。
		if (description === "") description = `${name}相关任务`;
		// 显式 id："id 叫 chem"。
		const idMatch = body.match(/\bid\s*(?:叫|是|[:：])?\s*([a-z0-9][a-z0-9_-]*)/i);
		const id = idMatch ? idMatch[1].toLowerCase() : deriveExpertId(name);
		return {
			kind: "add",
			expert: { id, label: name.slice(0, 40), description: description.slice(0, 200), persona: "", skills: [] },
		};
	}

	return null;
}

/**
 * 把管理接口的执行结果格式化成一句播报。
 *
 * @param result - `{ ok, speech?, error?, applied? }`。
 * @param kind - 命令类型（用于错误兜底文案）。
 * @returns 中文播报串。
 */
export function formatCommandSpeech(result, kind) {
	if (result?.ok === true) return result.speech ?? "好了。";
	const error = String(result?.error ?? "");
	const map = {
		"invalid-id": "专家名字只能用字母、数字和横线。",
		"reserved-id": "小凤是默认助手，不能删。",
		"label-required": "请说清楚新专家叫什么。",
		"description-required": "请说清楚新专家负责什么。",
		"no-expert-dir": "还没配置专家目录，暂时不能增删。",
	};
	return map[error] ?? (
		kind === "remove" ? "没删成，请说出要删的专家名字。" :
		kind === "add" ? "没加成功，请按「新增专家名字，负责什么」再说一遍。" :
		"没查到专家列表。"
	);
}

// ── V1.8 专家会话命令 ─────────────────────────────────────────────────
/** 列出会话：「列出会话」「有哪些会话」「专家会话」「看看会话」。 */
const SESSION_LIST_RE = /(列出|查看|看看|显示|报一下|说下|有哪些|有些什么|多少个?)\s*(专家)?\s*会话|专家会话列表|会话列表/;
/** 开新会话：「给小因开个会话」「新建小因会话」「小因开新会话」。 */
const SESSION_CREATE_RE = /(?:给\s*(.+?)\s*)?(?:新建|新开|开个|开一个|开|创建)\s*(?:一个)?\s*(.+?)\s*(?:的)?\s*新?会话/;
/** 切换会话：「切换到小因会话」「用小因的会话2」「切小因会话」。 */
const SESSION_SWITCH_RE = /(?:切换|切到|切|改用|用)\s*(?:到)?\s*(.+?)\s*(?:的)?\s*会话\s*([0-9一二三四五六七八九十]+)?/;
/** 关闭会话：「关闭小因会话」「删掉小因的会话2」。**注意：关闭 = 删除**。 */
const SESSION_CLOSE_RE = /(?:关闭|关掉|删掉|删除|移除)\s*(?:那个)?\s*(.+?)\s*(?:的)?\s*会话\s*([0-9一二三四五六七八九十]+)?/;
/**
 * V2.4 需求④：改会话状态（活跃 / 挂起 / 完结）。
 *
 * 与「关闭」是两件事：关闭把会话从列表里删掉；状态是**保留**会话只换标记。
 * 用户两种语序都要认，所以有"前置动词"和"后置动词"两条正则：
 *   - 前置：「挂起小因的会话2」「完结基因会话」
 *   - 后置：「把小因的会话2设为挂起」「基因的会话改成活跃」
 */
const SESSION_STATUS_PRE_RE = /(激活|启用|恢复|挂起|暂停|完结|结束|归档)\s*(?:掉|一下|下)?\s*(?:那个)?\s*(.+?)\s*(?:的)?\s*会话\s*([0-9一二三四五六七八九十]+)?/;
const SESSION_STATUS_POST_RE = /(.+?)\s*(?:的)?\s*会话\s*([0-9一二三四五六七八九十]+)?\s*(?:设为|设成|改成|改为|标记为|标记成|变成)\s*(激活|活跃|启用|恢复|挂起|暂停|完结|结束|归档|完成)/;

/** 状态词 → 内部状态值。 */
const STATUS_WORDS = {
	激活: "active", 活跃: "active", 启用: "active", 恢复: "active",
	挂起: "suspended", 暂停: "suspended",
	完结: "finished", 结束: "finished", 归档: "finished", 完成: "finished",
};

/** 中文数字转阿拉伯数字（会话序号用）。 */
function cnNumber(text) {
	const s = String(text ?? "").trim();
	if (/^[0-9]+$/.test(s)) return Number(s);
	const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
	if (s in map) return map[s];
	return 0;
}

/**
 * 解析一条专家会话命令（V1.8；V2.4 加状态控制，纯函数）。
 *
 * 判定顺序很关键，**不能随意调换**：
 *   1. `session-list` —— "列出会话" 里含"会话"，放后面会被别的正则吃掉；
 *   2. `session-status` —— "挂起X会话" 与 "关闭X会话" 都是动词+会话，
 *      但表述完全不同，先判状态（状态词很特征化），避免"完结"被当成"关闭"；
 *   3. `session-close` —— 关闭 = **删除**，语义最重，要在"新建"之前判；
 *   4. `session-switch` —— "切换到X会话"；
 *   5. `session-create` —— 兜底："给X开个会话"。
 *
 * @param raw - 原始转录。
 * @returns `{kind:"session-list"}` / `{kind:"session-create", expertLabel}` /
 *   `{kind:"session-switch"|"session-close", expertLabel, index?}` /
 *   `{kind:"session-status", expertLabel, index?, status}` / `null`。
 */
export function parseSessionCommand(raw) {
	if (typeof raw !== "string") return null;
	const text = raw.trim();
	if (text === "") return null;

	// 列出会话优先。
	if (SESSION_LIST_RE.test(text)) return { kind: "session-list" };

	// 状态控制（需求④）。前置/后置两种语序都认。
	const postMatch = text.match(SESSION_STATUS_POST_RE);
	if (postMatch) {
		const label = cleanName(postMatch[1] ?? "");
		const status = STATUS_WORDS[postMatch[3] ?? ""];
		if (label !== "" && status !== undefined) {
			return { kind: "session-status", expertLabel: label, index: cnNumber(postMatch[2]) || 0, status };
		}
	}
	const preMatch = text.match(SESSION_STATUS_PRE_RE);
	if (preMatch) {
		const status = STATUS_WORDS[preMatch[1] ?? ""];
		// 第 2 组可能是专家名，也可能是"这位专家"之类的残留 —— cleanName 后为空就丢。
		let label = cleanName(preMatch[2] ?? "");
		if (label === "" || /^(个|一个|这位|那个|当前|现在的?)$/.test(label)) return null;
		if (status !== undefined) {
			return { kind: "session-status", expertLabel: label, index: cnNumber(preMatch[3]) || 0, status };
		}
	}

	// 关闭/切换要放在"新建"之前判（"关闭X会话"不该被开会话正则吃）。
	const closeMatch = text.match(SESSION_CLOSE_RE);
	if (closeMatch) {
		const label = cleanName(closeMatch[1] ?? "");
		if (label === "") return null;
		return { kind: "session-close", expertLabel: label, index: cnNumber(closeMatch[2]) || 0 };
	}
	const switchMatch = text.match(SESSION_SWITCH_RE);
	if (switchMatch) {
		const label = cleanName(switchMatch[1] ?? "");
		if (label === "") return null;
		return { kind: "session-switch", expertLabel: label, index: cnNumber(switchMatch[2]) || 0 };
	}
	const createMatch = text.match(SESSION_CREATE_RE);
	if (createMatch) {
		// "给X开个会话" → group1=X, group2 可能是"会话"残留；"新建X会话" → group2=X。
		let label = cleanName(createMatch[1] ?? "");
		if (label === "" || /^(个|一个)$/.test(label)) label = cleanName(createMatch[2] ?? "");
		if (label === "" || /(会话|专家)/.test(label)) return null;
		return { kind: "session-create", expertLabel: label };
	}
	return null;
}

/** 会话命令的结果播报。 */
export function formatSessionSpeech(result, kind) {
	if (result?.ok === true) return result.speech ?? "好了。";
	const error = String(result?.error ?? "");
	const map = {
		"worker-not-found": "没找到这位专家，请说清楚专家名字。",
		"session-not-found": "没找到这个会话。",
		"session-limit-reached": "这位专家的会话太多了，先关掉一个再开。",
		"last-session": "这是最后一个会话，得留一个。",
		"invalid-status": "状态只支持活跃、挂起、完结三种。",
		"session-agent-unavailable": "这个会话的实例还没就绪，稍等一下再派任务，或者先激活另一个会话。",
		"task-empty": "没听清任务内容，请再说一遍。",
	};
	return map[error] ?? (
		kind === "session-create" ? "没开成会话，请按「给专家名开个会话」再说一遍。" :
		kind === "session-switch" ? "没切成，请说清楚专家和会话序号。" :
		kind === "session-close" ? "没关成，请说清楚要关哪个会话。" :
		kind === "session-status" ? "没改成功，请说「把某专家的会话设为挂起」这样。" :
		"没查到会话。"
	);
}
