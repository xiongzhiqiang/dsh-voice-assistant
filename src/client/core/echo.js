/**
 * 回声抑制：识别到的话若"就是助手自己刚说的"，一律丢弃。
 *
 * ## 它防的是什么
 *
 * 这是"助手自说自话"的**声学入口**，闭环长这样：
 *
 * ```
 * 模型回答 ─▶ TTS 播报 ─▶ 扬声器出声
 *                  ▲              │
 *                  │              ▼
 *             提交给模型 ◀── 麦克风录到（自己念的话）
 * ```
 *
 * 一旦成环，助手就会一轮一轮地"回应自己"，看起来像自言自语、停不下来。
 * 三个环节都可能漏：Web Speech 的 `continuous` 模式会一直听；
 * `speechSynthesis.onend` 在音频真正放完前就可能触发；外放设备有余响。
 *
 * 光靠"播报时关麦"是不够的 —— 关麦只覆盖**播报期间**，
 * 而回声常出现在 `onend` 之后的那几百毫秒里。所以再加一道**文本级**防线：
 * 把助手最近说过的话记下来，识别结果要是跟它高度重合，就当回声丢掉。
 *
 * ## 判据为什么用"归一化包含"而不是精确相等
 *
 * 识别器转写自己念的话时，必然有字差：标点丢失、同音字替换
 * （"磁盘" → "词盘"）、断句合并。精确相等一条都挡不住。
 * 所以先把两边的标点、空白、常见同音字全部归一化，再做**双向包含**判断：
 * 转写里含（被归一化后的）原句、或原句含转写（只录到半句），都算回声。
 *
 * ## 为什么还要长度门槛
 *
 * 短文本会被大量误判："好"、"对"、"继续" 既是助手常说的，也是用户常说的。
 * 所以设一个最小长度（默认 4 个字符）：短句一律放行，宁可漏挡也不误杀
 * —— 误杀的代价是"用户说话没反应"，比偶尔的自说自话更让人困惑。
 */
import { ECHO_WINDOW_MS } from "./constants.js";

/** 判定为回声所需的最小归一化长度（字符）。低于此长度不参与比对。 */
const MIN_ECHO_LENGTH = 4;

/**
 * 常见同音/近音混淆对（识别器转写时的典型错法）。
 *
 * 只收"高频且字形不同"的：形近字本身已被下面的字符归一化覆盖，
 * 这里补的是**读音相同但写法无关**的情况。
 */
const HOMOPHONE_PAIRS = [
	["文件夹", "文件加"],
	["重启", "从启"],
	["登录", "登陆"],
	["部署", "布署"],
	["报错", "报措"],
	["代码", "待码"],
	["内存", "内层"],
	// 盘符：中文识别几乎必然把字母盘符写成汉字，且写法不统一。
	// 这组在排障"自己念完又自己答"时命中率很高 —— 助手念"D 盘"，
	// 麦克风录回来成了"词盘/地盘/第盘"，不归一化就判成两句话，
	// 回声照样被提交上去。
	//
	// 注意「词盘」这类变体是**有歧义**的（也可能是"磁盘"的误写）。
	// 一个变体只能指向一个规范形，否则后写的会覆盖先写的；
	// 这里按"盘符误写更常见"取舍，牺牲一点"磁盘"的召回。
	["d盘", "词盘"],
	["d盘", "地盘"],
	["d盘", "第盘"],
	["c盘", "西盘"],
	["e盘", "一盘"],
];

/**
 * 归一化：去标点空白符号、统一小写、抹平常见同音错写。
 *
 * @param text - 原始文本。
 * @returns 归一化后的字符串（可能为空串）。
 */
export function normalizeForEcho(text) {
	if (typeof text !== "string") return "";
	let out = text.toLowerCase();
	for (const [canonical, variant] of HOMOPHONE_PAIRS) {
		out = out.split(variant).join(canonical);
	}
	// 去掉所有非字母数字与汉字（标点、空白、符号都不承载语义，
	// 而识别器恰恰最爱丢标点、加空白）。
	out = out.replace(/[^\p{Script=Han}a-z0-9]/gu, "");
	return out;
}

/**
 * 判断一段转写是否是"回声"。
 *
 * @param transcript - 识别结果。
 * @param spoken - 最近说过的话：`Array<{ text, at }>`（`at` 为时间戳）。
 * @param options - `{ now, windowMs, minLength }`。
 * @returns `{ echo, matched }`；`matched` 是命中的那条原话（便于排障）。
 */
export function detectEcho(transcript, spoken, options = {}) {
	const now = typeof options.now === "number" ? options.now : Date.now();
	const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : ECHO_WINDOW_MS;
	const minLength = Number.isFinite(options.minLength) ? options.minLength : MIN_ECHO_LENGTH;

	const probe = normalizeForEcho(transcript);
	if (probe.length < minLength) return { echo: false, matched: "" };

	for (const entry of spoken) {
		if (entry === null || typeof entry !== "object") continue;
		if (typeof entry.at === "number" && now - entry.at > windowMs) continue;
		const candidate = normalizeForEcho(entry.text);
		if (candidate.length < minLength) continue;
		// 双向包含：只录到半句（原句含转写）也算回声。
		if (candidate.includes(probe) || probe.includes(candidate)) {
			return { echo: true, matched: String(entry.text).slice(0, 80) };
		}
	}
	return { echo: false, matched: "" };
}

/**
 * 回声抑制器：维护"助手最近说过什么"的滑动窗口。
 *
 * 做成类而不是裸函数，是因为需要**跨调用累积**状态；同时把时间源与
 * 窗口长度做成参数，方便测试里直接构造而非依赖真实时钟。
 */
export class EchoGuard {
	/**
	 * @param options - `{ windowMs, minLength, now }`。
	 */
	constructor(options = {}) {
		this.windowMs = Number.isFinite(options.windowMs) ? options.windowMs : ECHO_WINDOW_MS;
		this.minLength = Number.isFinite(options.minLength) ? options.minLength : MIN_ECHO_LENGTH;
		this.now = typeof options.now === "function" ? options.now : () => Date.now();
		/** 最近说过的话（按时间升序，只保留窗口内的）。 */
		this.spoken = [];
		/** 诊断：被拦下的回声次数与最近一条。 */
		this.suppressed = 0;
		this.lastSuppressed = "";
	}

	/**
	 * 记下助手刚说（或即将说）的一段话。
	 * @param text - 播报的文本（建议传**清洗后**的实际朗读文本）。
	 */
	remember(text) {
		const value = typeof text === "string" ? text.trim() : "";
		if (value === "") return;
		this.spoken.push({ text: value, at: this.now() });
		this.prune();
	}

	/**
	 * 判断并消费一段转写。
	 *
	 * @param transcript - 识别结果。
	 * @returns `{ echo, matched }`；`echo === true` 时调用方必须丢弃该段。
	 */
	check(transcript) {
		const result = detectEcho(transcript, this.spoken, {
			now: this.now(),
			windowMs: this.windowMs,
			minLength: this.minLength,
		});
		if (result.echo) {
			this.suppressed += 1;
			this.lastSuppressed = String(transcript).slice(0, 80);
		}
		return result;
	}

	/** 丢弃超出窗口的记录。 */
	prune() {
		const now = this.now();
		this.spoken = this.spoken.filter((entry) => now - entry.at <= this.windowMs);
	}

	/** 清空（停止语音 / 用户手动休眠时调用）。 */
	reset() {
		this.spoken = [];
	}

	/** 诊断快照。 */
	inspect() {
		return {
			tracked: this.spoken.length,
			suppressed: this.suppressed,
			lastSuppressed: this.lastSuppressed,
			windowMs: this.windowMs,
			minLength: this.minLength,
		};
	}
}
