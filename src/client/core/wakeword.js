/**
 * 唤醒词匹配。
 *
 * ## 为什么不是"字符串包含"这么简单
 *
 * 语音识别给出的是**音**到**字**的猜测。用户说「小凤」，识别结果可能是
 * 「小风」「晓凤」「小枫」，甚至「小 凤」（中间多一个空格）。如果只比对
 * 字面量，唤醒率大概只有一半 —— 用户会认为"这东西坏了"。
 *
 * 所以做三件事：
 *   1. **归一化**：去空白、去标点、统一大小写，并保留「归一化下标 → 原文下标」
 *      的映射，这样切出"唤醒词之后的指令"时还能拿到原文（数字、英文不受损）。
 *   2. **同音别名**：别名表由配置提供（默认覆盖 `fèng` 的常见写法）。
 *   3. **位置策略**：支持"小凤，帮我看看"这种唤醒+指令一口气说完，
 *      由 `inline` 开关控制是否接受句中唤醒。
 *
 * ## 为什么不用 VAD/能量阈值做二次确认
 *
 * 那是另一个层次的事（判"有没有人在说话"），不该混进"说的是不是那个词"。
 * 混在一起后，调阈值会同时改变唤醒率和误唤醒率，两个指标互相牵制，
 * 永远调不好。
 */

/** 需要从归一化文本中剔除的字符：空白 + 中英文标点。 */
const NOISE = /[\s，。！？、；：,.!?;:"'“”‘’（）()《》【】\[\]{}…—\-_~`|/\\]/;

/**
 * 归一化文本，并返回下标映射。
 *
 * @param text - 原始文本。
 * @returns `{ normalized, map }`，`map[i]` 是 `normalized[i]` 在原文中的下标。
 */
export function normalizeWithMap(text) {
	const source = typeof text === "string" ? text : "";
	let normalized = "";
	const map = [];
	for (let i = 0; i < source.length; i += 1) {
		const ch = source[i];
		if (NOISE.test(ch)) continue;
		normalized += ch.toLowerCase();
		map.push(i);
	}
	return { normalized, map };
}

/**
 * 在文本中查找唤醒词。
 *
 * @param text - 识别到的文本（可能是中间结果）。
 * @param options - `{ word, aliases, inline }`。
 * @returns `{ hit, matched, rest, index }`：
 *   - `hit` 是否命中；
 *   - `matched` 命中的那个字面量（诊断用）；
 *   - `rest` 唤醒词之后的原文（`inline` 为 false 且命中在句首时为整句去掉唤醒词）；
 *   - `index` 命中位置（归一化下标）。
 */
export function findWake(text, options = {}) {
	const word = typeof options.word === "string" && options.word !== "" ? options.word : "小凤";
	const aliases = Array.isArray(options.aliases) ? options.aliases : [];
	const inline = options.inline !== false;

	const { normalized, map } = normalizeWithMap(text);
	if (normalized === "") return { hit: false, matched: "", rest: "", index: -1 };

	// 长词优先：避免"小凤"先匹配掉"小凤凰"这类更长的候选。
	const candidates = [word, ...aliases]
		.filter((candidate) => typeof candidate === "string" && candidate !== "")
		.map((candidate) => ({ raw: candidate, key: normalizeWithMap(candidate).normalized }))
		.filter((candidate) => candidate.key !== "")
		.sort((a, b) => b.key.length - a.key.length);

	for (const candidate of candidates) {
		const index = normalized.indexOf(candidate.key);
		if (index < 0) continue;
		// 非 inline 模式只接受句首唤醒：句中的"小凤"多半是在谈论它，
		// 不是在下指令，否则聊天里提到这个名字就会一直被唤醒。
		if (!inline && index > 1) continue;

		const endNormalized = index + candidate.key.length;
		// 映射到原文：命中位置在原文中的结束下标。
		const lastMapped = map[endNormalized - 1];
		const rest = typeof lastMapped === "number" ? String(text).slice(lastMapped + 1) : "";
		return {
			hit: true,
			matched: candidate.raw,
			rest: rest.replace(/^[\s，。！？、；：,.!?;:]+/, "").trim(),
			index,
		};
	}

	return { hit: false, matched: "", rest: "", index: -1 };
}
