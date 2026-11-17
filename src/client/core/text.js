/**
 * 文本处理：播报前清洗、分句、从会话事件里取回答文本。
 *
 * ## 为什么播报前一定要洗
 *
 * agent 的回答是 **Markdown**，而 TTS 会把符号当字念出来：
 * `**加粗**` 念成"星号星号加粗星号星号"，`[链接](url)` 把整条 URL 念一遍，
 * 代码块会把缩进和括号全念出来。这不是"不够优雅"，是根本没法听。
 *
 * 所以播报走一条独立的清洗管线，与界面显示彻底分开：
 * 界面保留完整 Markdown，播报只留"能听懂的那部分"。
 */

/** 代码块围栏。 */
const FENCE = /```[\s\S]*?```/g;
/** 行内代码。 */
const INLINE_CODE = /`([^`]*)`/g;
/** 图片：整条丢掉（无法朗读）。 */
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
/** 链接：保留文字，丢掉 URL。 */
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
/** 裸 URL。 */
const BARE_URL = /https?:\/\/\S+/g;
/** HTML 标签。 */
const TAG = /<[^>]+>/g;
/** 强调与标题标记。 */
const EMPHASIS = /(^|\s)([#>*_~]{1,6}|-{3,})(\s|$)/g;
/** 列表前缀。 */
const LIST_PREFIX = /^\s*(?:[-*+•]|\d+[.)])\s+/gm;
/** 表格分隔线。 */
const TABLE_RULE = /^\s*\|?[\s:|-]{3,}\|?\s*$/gm;
/** 表格竖线。 */
const TABLE_PIPE = /\|/g;
/** Emoji（粗略范围，够用即可）。 */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

/**
 * 把 Markdown 清洗成"适合朗读的纯文本"。
 *
 * @param text - 原始文本。
 * @param options - `{ keepUrl }`：是否保留裸链接（默认 false，念 URL 体验极差）。
 * @returns 纯文本。
 */
export function stripForSpeech(text, options = {}) {
	if (typeof text !== "string") return "";
	let out = text;
	out = out.replace(FENCE, "，代码略。");
	out = out.replace(IMAGE, "");
	out = out.replace(LINK, "$1");
	if (options.keepUrl !== true) out = out.replace(BARE_URL, "（链接略）");
	out = out.replace(INLINE_CODE, "$1");
	out = out.replace(TAG, "");
	out = out.replace(TABLE_RULE, "");
	out = out.replace(TABLE_PIPE, "，");
	out = out.replace(LIST_PREFIX, "");
	out = out.replace(EMPHASIS, " ");
	out = out.replace(EMOJI, "");
	out = out.replace(/[*_`#>~|]+/g, "");
	out = out.replace(/[ \t]+/g, " ");
	out = out.replace(/\n{2,}/g, "\n");
	out = out.replace(/\n/g, "，");
	// 竖线/换行转换后常留下"空格 + 逗号"的组合，读出来会多一次停顿感；
	// 统一收成紧贴的逗号。
	out = out.replace(/\s*，\s*/g, "，");
	out = out.replace(/，{2,}/g, "，");
	out = out.replace(/^，+/, "").replace(/，+$/, "").trim();
	return out;
}

/**
 * 按句子切分播报片段。
 *
 * 为什么要切：一条几百字的回答一次性塞进 `speechSynthesis.speak()`，
 * 用户在念到一半时想打断/追问，取消的粒度太粗；而且某些浏览器对
 * 超长 utterance 会静默截断。按句切分后可以逐句播、逐句取消。
 *
 * @param text - 已清洗的文本。
 * @param maxLen - 单段字符上限。
 * @returns 片段数组（无空段）。
 */
export function splitForSpeech(text, maxLen = 80) {
	const source = typeof text === "string" ? text.trim() : "";
	if (source === "") return [];
	const sentences = source.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) ?? [source];
	const chunks = [];
	for (const sentence of sentences) {
		const piece = sentence.trim();
		if (piece === "") continue;
		if (piece.length <= maxLen) {
			chunks.push(piece);
			continue;
		}
		// 超长句按逗号再切；仍超长就硬切（宁可断，也不能被浏览器截断）。
		for (const clause of piece.split(/(?<=[，,、])/)) {
			if (clause.length <= maxLen) {
				chunks.push(clause);
				continue;
			}
			for (let i = 0; i < clause.length; i += maxLen) chunks.push(clause.slice(i, i + maxLen));
		}
	}
	return chunks.filter((chunk) => chunk.replace(/[\s，,。.！!？?；;]/g, "") !== "");
}

/**
 * 从一段消息内容里拼出纯文本。
 *
 * 兼容三种形态（不同版本的 DSH 与不同 provider 会给出不同结构）：
 *   - 字符串；
 *   - `{ type:'text', text }` 内容块数组；
 *   - `{ text }` 单块。
 *
 * 只取 `text` 类块，**跳过推理块** —— 思维链不该被念出来。
 *
 * @param content - 消息内容。
 * @returns 纯文本（可能为空串）。
 */
export function textFromContent(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts = [];
		for (const block of content) {
			if (block === null || typeof block !== "object") continue;
			if (block.type !== undefined && block.type !== "text") continue;
			if (typeof block.text === "string") parts.push(block.text);
		}
		return parts.join("\n");
	}
	if (content !== null && typeof content === "object" && typeof content.text === "string") return content.text;
	return "";
}

/**
 * 从 `assistant/message` 事件里取回答文本。
 *
 * 会话事件的业务字段在 `data` 下（`{ type, seq, time, data }`）。这里同时
 * 兼容两种形态，让调用方不必关心包了几层：
 *   - 完整事件：`{ type:'assistant/message', data:{ message } }`
 *   - 已解包：`{ type:'assistant/message', message }`
 * 早期只认后者，导致读到的永远是空串 —— 界面显示正常、语音却一句不念。
 *
 * @param event - 会话事件（完整或已解包）。
 * @returns 纯文本（非 assistant/message 事件返回空串）。
 */
export function assistantTextOf(event) {
	if (event === null || typeof event !== "object") return "";
	if (event.type !== "assistant/message") return "";
	const payload = event.data !== null && typeof event.data === "object" ? event.data : event;
	if (payload.interrupted === true) return "";
	const message = payload.message;
	if (message === null || typeof message !== "object") return "";
	return textFromContent(message.content);
}
