/**
 * 汇报队列（宿主半）—— 两层 agent 架构的「结果回传通道」。
 *
 * ## 这一层解决什么
 *
 * V1.3 起 router 不再切换到 worker 会话去旁听，而是：提交任务 → worker 后台
 * 执行 → worker 的**要点汇总**回到这里排队 → 客户端按**完成时间先后**依次播报。
 *
 * 本模块只放**纯逻辑**（队列、截断、播报文案），便于脱离 DSH 直接单测；
 * 与 agent 事件/LLM 的接线在 `lib/delegation.js`。
 */

/** 队列默认保留最近多少条汇报（防止长期运行内存无界增长）。 */
export const REPORT_LIMIT = 100;

/**
 * 播报文案里摘要部分的长度上限。
 *
 * 比队列里存的 `summary`（120 字）略宽，是为了让"结论 + 文件概括"两句
 * 都装得下；TTS 念到 160 字已是耐心上限，再长用户就开始划手机了。
 */
const SPEECH_SUMMARY_MAX = 160;

/**
 * 截断文本并加省略号。
 * @param text - 原文。
 * @param max - 最大长度。
 * @returns 截断后的文本。
 */
export function truncateText(text, max = 120) {
	const value = String(text ?? "").trim();
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 路径形态的正则（**必须**能不吞掉正常中文句子）。
 *
 * 覆盖三类用户讨厌被逐字念出来的东西：
 *   1. Windows 盘符路径 `D:\a\b.py`、`C:/x/y`；
 *   2. UNC 路径 `\\server\share\...`；
 *   3. POSIX 绝对/相对多级路径 `/home/user/a.txt`、`src/client/core/x.js`。
 *
 * ## 为什么第 3 条要求"至少一个斜杠 + 一段文件名"
 *
 * 只写 `/` 会把中文里的顿号式用法、单位（`10/20`）、日期（`3/5`）一起吞掉，
 * 而把中文句子啃出空洞比念路径更糟。所以要求形如 `a/b` 且整体像路径
 * （含扩展名、或含两级以上目录、或以常见根目录名开头）。
 *
 * @type {RegExp}
 */
const PATH_PATTERN =
	/(?:[A-Za-z]:[\\/][^\s，。；、"'（）()【】\[\]<>]*|\\\\[^\s，。；、"'（）()]+|\/(?:home|Users|tmp|var|opt|etc|mnt|media|root|usr|workspace|work|workspaces|Drive|d|e|f|c)\/[^\s，。；、"'（）()【】\[\]<>]*|[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-/]*\.[A-Za-z0-9]{1,8})/g;

/**
 * 子句分隔符（保留在结果里，便于还原句子结构）。
 *
 * 冒号也算分隔符：worker 最典型的句式是「任务完成：把 X 与 Y 都改了」，
 * 冒号前那半句正是**结论**，不该跟着含路径的后半句一起被剥掉。
 * 真机上少了这一条，播报会退化成光秃秃的一句"产生了 2 个文件"。
 *
 * ⚠️ 半角冒号必须带 `(?![\\/])`：Windows 的盘符写法就是 `D:\`，不带这条
 * 会把 `D:\a.py、D:\b.py` 从盘符处切成碎片，播报里冒出孤零零的 `D`。
 * 全角冒号 `：` 不用加这条守卫 —— 路径里不会出现它，而 worker 的中文
 * 句式几乎全用全角（「任务完成：」），漏了它这条子句就会整段被剥掉。
 */
const CLAUSE_SPLIT = /([，,。；;\n：]|:(?![\\/]))/;

/**
 * 常见附件后缀（用于数"产生了几个文件"）。
 *
 * 边界**必须**允许前置空白/标点，不能只写 `^|/|\`：worker 常写
 * 「已生成 report.csv」这种没有目录的裸文件名，只认行首或斜杠的话它就
 * 完全匹配不到 —— 表现成"文件数永远数不出来"，而那个文件名又会被原样念出去。
 */
const FILE_EXT =
	/(?:^|[\s\/\\，、；;（(【"'「『])[^\\/\s，。；、"'（）()【】「」『』]+\.(?:png|jpe?g|gif|webp|svg|bmp|pdf|docx?|xlsx?|pptx?|csv|tsv|txt|md|markdown|json|ya?ml|toml|ini|html?|xml|zip|tar|gz|7z|rar|py|js|mjs|cjs|ts|tsx|jsx|java|go|rs|c|h|cpp|hpp|cs|rb|php|sh|ps1|bat|cmd|sql|r|rmd|ipynb|fastq|fq|bam|sam|vcf|bed|gtf|gff3?|fa|fasta|fna|bai|log|cfg|conf|env)(?=$|[\s，。；、"'（）()【】「」『』])/gi;

/** 文本里已经自己说了"几个文件/结果"（中文数字与阿拉伯数字都算）。 */
const STATED_COUNT = /(?:\d+|[一二三四五六七八九十两几多]+)\s*个(?:文件|结果|报告|产物|图|表)/;

/**
 * 文本里有没有"产物痕迹"（路径，或带常见后缀的裸文件名）。
 *
 * 必须把**裸文件名**也算进来：worker 常写「已生成 report.csv」而没有目录。
 * 只认路径的话，这个文件名会被原样念出来 —— 正是需求①要消除的东西。
 *
 * @param text - 文本。
 * @returns 是否含路径或文件名。
 */
export function hasPaths(text) {
	const value = String(text ?? "");
	if (value === "") return false;
	if (new RegExp(PATH_PATTERN.source).test(value)) return true;
	return countArtifacts(value) > 0;
}

/**
 * 把一段文字里的路径与文件名替换成中性说法「工作目录」（需求①）。
 *
 * ## 为什么在**宿主侧**做，而不是只改提示词
 *
 * 提示词只约束 LLM 那一条路径；汇总 LLM 失败/超时会走
 * `deterministicSummary()` 的规则摘要，那条拿到的是 worker 原文 ——
 * 里面满是盘符与文件名。只改提示词等于"模型好的时候不念、模型差的时候
 * 又念"，表现为随机复发。所以这里做一道**后置清洗**，两条路径都过它。
 *
 * 替换而不是删除：句子里的介词（"保存到 X"）需要一个宾语，删空会念出
 * 「已保存到 。」这种残句 —— 比念路径更糟。
 *
 * @param text - 原文。
 * @returns 清洗后的文本。
 */
export function redactPaths(text) {
	const value = String(text ?? "");
	if (value === "") return "";
	return value
		// 括号里**只有**路径时把整对括号一起删掉：`（D:\a.py）` → 无，
		// 否则会留下「结果（）已就绪」这种念不出口的空括号。
		.replace(/[（(]\s*(?:[A-Za-z]:[\\/][^）)]*|\\\\[^）)]*|\/[^\s）)]*|[^\s）)]*\.[A-Za-z0-9]{1,8})\s*[）)]/g, "")
		.replace(PATH_PATTERN, "工作目录")
		.replace(FILE_EXT, "工作目录")
		.replace(/(?:工作目录\s*[\\/]\s*)+工作目录/g, "工作目录")
		.replace(/[（(]\s*[）)]/g, "")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/**
 * 数出一段文字里提到了几个文件（按后缀识别，已去重）。
 * @param text - 原文。
 * @returns 去重后的文件数。
 */
export function countArtifacts(text) {
	const value = String(text ?? "");
	if (value === "") return 0;
	const seen = new Set();
	for (const match of value.matchAll(FILE_EXT)) seen.add(match[0].toLowerCase());
	return seen.size;
}

/**
 * 只保留**不含产物痕迹**的子句（连同分隔符），其余整条丢弃。
 *
 * ## 为什么是"整条丢"而不是"把路径抠掉"
 *
 * 抠掉路径会留下断尾：「程序写好并保存到 D:\a.py」→「程序写好并保存到」，
 * 念出来像话没说完（真机试过，比念路径更别扭）。而路径所在的那条子句，
 * 内容通常就是"东西放哪了"这一件事 —— 而这件事由后面的概括句
 * （「产生了 N 个文件，都放在工作目录下」）**完整覆盖**。所以整条丢掉，
 * 信息不丢，句子还通顺。
 *
 * 代价是挂在同一条子句里的动词会被一起丢掉（「写好了 D:\a.py」→ 只剩
 * 文件数）。这是刻意接受的取舍：需求①的优先级是"别念路径"，而
 * 动词丢失不会让用户误解结果。
 *
 * @param text - 原文。
 * @returns 去掉产物子句后的文本。
 */
function stripPathClauses(text) {
	const parts = String(text ?? "").split(CLAUSE_SPLIT);
	const out = [];
	// split 含捕获组：偶数下标是内容、奇数下标是分隔符。
	for (let index = 0; index < parts.length; index += 2) {
		const body = parts[index] ?? "";
		const separator = parts[index + 1] ?? "";
		if (body.trim() === "") continue;
		if (hasPaths(body)) continue; // 整条丢掉（概括句会接上"在哪"）。
		// 路径被丢、引导词留下的碎片也一并丢（见 PATH_RESIDUE 的注释）。
		// 必须**逐条判**：多子句场景下拼起来的 body 不是单个碎片，
		// 整串正则匹配不上，会漏过去变成「工作目录。产生了 1 个文件…」。
		if (PATH_RESIDUE.test(body.trim())) continue;
		out.push(`${body}${separator}`);
	}
	return out
		.join("")
		// 收拾"。。"、"，，"这类重复标点与首尾残留。结尾的裸分隔符要去掉 ——
		// 丢掉"冒号后的产物子句"会留下「任务完成：」，念出来像半句话。
		.replace(/([。；;])\s*\1+/g, "$1")
		.replace(/^[，,。；;、：:\s]+/, "")
		.replace(/[，,、；;：:\s]+$/, "")
		.trim();
}

/**
 * 剥掉产物子句后可能残留的"路径叙述碎片"。
 *
 * ## 为什么要单独判这一种残留
 *
 * `stripPathClauses` 是**按子句**丢的，而冒号句式会把引导词切到**前一条**
 * 子句里，于是路径被丢掉了、引导词留下了：
 *
 * ```
 * 工作目录：D:\work\out，已生成 report.csv。
 *          ↓ 丢两条含路径的子句
 * 工作目录                                 ← 孤零零一个名词，没有信息量
 * ```
 *
 * 念出来是「小因回报：工作目录。」—— 用户听不出任何东西，比不播还差。
 *
 * 判据是「**整条子句只由路径类词汇构成、没有任何动作或结论**」。刻意写得
 * 保守（要求整条完全匹配、且限定在常见的几个引导词上）：宁可偶尔多留一句
 * 无用话，也不能把「已生成报告」这种真·结论误判成碎片丢掉。
 */
const PATH_RESIDUE =
	/^(?:(?:我的|你的|它的|当前|这个|那个|该|本次)\s*)*(?:工作目录|工作路径|工作区目录|目录|路径|文件夹|保存位置|保存路径|输出目录|输出路径|结果目录|结果路径|目标位置|目标目录|位置)(?:\s*(?:是|在|为))?$/;

/**
 * 把"逐字的路径叙述"压缩成一句概括（需求①的正式口径）。
 *
 * 用户的原话：不要逐字逐句读取文件名和目录名，省略为「产生了几个文件，
 * 放在工作目录下」。策略：
 *
 *   1. 按后缀数出提及了几个文件（去重）；
 *   2. 剥掉含路径/文件名的子句，留下结论；
 *   3. 补一句概括：有数量就说「产生了 N 个文件，都放在工作目录下」；
 *      worker 只写了目录名数不出数量时退化为「结果都放在工作目录下」；
 *      结论里已经自己说了数量（「共三个文件」）时只说「都放在工作目录下」，
 *      不重复播报两遍文件数。
 *
 * 完全没有产物痕迹时**原样返回**：别给"没产生文件"的任务硬塞一句文件数。
 *
 * @param text - 原文（worker 结果或摘要）。
 * @param options - `{ max }` 长度上限。
 * @returns 概括后的文本。
 */
export function condenseArtifacts(text, options = {}) {
	const max = Number.isFinite(options.max) ? options.max : 120;
	const raw = String(text ?? "").trim();
	if (raw === "") return "";
	const files = countArtifacts(raw);
	if (!hasPaths(raw)) return truncateText(raw, max);
	let body = stripPathClauses(raw);
	// 剥完只剩"工作目录"这类引导词碎片 → 当没有结论，直接给概括句。
	if (PATH_RESIDUE.test(body)) body = "";
	const alreadyCounted = STATED_COUNT.test(body);
	const clause =
		files > 0
			? alreadyCounted
				? "都放在工作目录下。"
				: `产生了 ${files} 个文件，都放在工作目录下。`
			: "结果都放在工作目录下。";
	if (body === "") return truncateText(clause, max);
	const separator = /[。！？.!?；;]$/.test(body) ? "" : "。";
	return truncateText(`${body}${separator}${clause}`, max);
}

/**
 * 不依赖 LLM 的兜底汇报要点。
 *
 * 用于：① 用户显式关闭汇总；② 汇总 LLM 失败/超时；③ 结果为空。
 *
 * **结论部分照抄，路径部分必须概括掉**（需求①）：worker 原文里常有
 * 「已保存到 D:\a.py、D:\b.py」，直接念出来就是逐字读路径。这里先按
 * 子句剥掉含路径的从句，再补一句「产生了 N 个文件，都放在工作目录下」。
 *
 * @param options - `{ result, ok, reason, label, max }`。
 * @returns 一句可直接朗读的要点。
 */
export function deterministicSummary(options = {}) {
	const max = Number.isFinite(options.max) ? options.max : 120;
	const label = String(options.label ?? "专家").trim() || "专家";
	const ok = options.ok !== false;
	if (!ok) {
		// 失败原因**不做子句剥离**：那条信息本身就是用户唯一要的东西，
		// 把它概括成"产生了 N 个文件"等于把故障原因换成一句无关的话
		// （真机踩过：`写 D:\out\a.py 被拒` → `产生了 1 个文件…`）。
		// 只做路径替换 —— 既不念盘符，也保住"为什么失败"。
		const reason = truncateText(redactPaths(options.reason ?? "未知原因"), max);
		return `任务失败，原因是${reason}。`;
	}
	const result = condenseArtifacts(options.result ?? "", { max });
	if (result === "") return `${label}已完成任务，没有产生文字结果。`;
	// 结果里若 already 是完整句（含句号/分号），不要再套一层，
	// 否则真机上会出现「已完成：程序已编好，文件在…。」这种重复结论。
	if (/[。！？.!?；;]$/.test(result)) return result;
	return `${result}。`;
}

/**
 * 给一条汇报生成播报文案（客户端用；放在宿主侧便于单测口径统一）。
 *
 * ## 为什么要再洗一遍路径
 *
 * `summary` 可能来自两条路：LLM 汇总（已按提示词约束）或规则兜底
 * （`deterministicSummary`，已概括）。但 LLM 汇总**不保证**听话 ——
 * 它偶尔会把 worker 原文里的盘符照抄出来。这里是最后一道闸，两条路都过，
 * 保证"念出来的东西里永远没有具体文件名与目录名"。
 *
 * @param report - `{label, summary, ok, reason}`。
 * @returns 可直接交给 TTS 的句子。
 */
export function formatReportSpeech(report) {
	const label = String(report?.label ?? "专家").trim() || "专家";
	const summary = condenseArtifacts(String(report?.summary ?? "").trim(), { max: SPEECH_SUMMARY_MAX });
	const ok = report?.ok !== false;
	const body = summary !== "" ? summary : deterministicSummary(report);
	if (!ok) return `${label}：${body}`;
	return `${label}回报：${body}`;
}

/**
 * 创建一个**按完成时间先后**排序的汇报队列。
 *
 * ## 为什么用单调 `at` 而不是数组下标做游标
 *
 * 客户端刷新页面 / DSH 重启后，数组下标会重置，旧游标会「卡住」（新汇报的
 * seq 永远小于客户端游标 → 再也不播报）。用 `Date.now()` 并强制单调，则
 * 重启后的新汇报时间必然更大，天然接上。
 *
 * `after === "latest"` 是**首帧初始化**语义：只返回当前游标、不返回历史，
 * 避免页面一打开就把上一次会话的旧汇报全念一遍。
 *
 * 游标必须**严格**单调：同一毫秒完成的两条汇报若拿到相同 `at`，后一条会被
 * `after(prevAt)` 过滤掉（等于没汇报）。所以取 `cursor + 1` 而不只是 `cursor`。
 *
 * @param options - `{ limit }`。
 */
export function createReportQueue(options = {}) {
	const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : REPORT_LIMIT;
	let items = [];
	let cursor = 0;
	/**
	 * 人读序号（1、2、3…），与 `at` 各管一摊。
	 *
	 * `at` 是**毫秒时间戳**，专职排序与增量拉取；序号若写成 `cursor + 1`
	 * 会得到一个 1.7e12 量级的数，日志里没法看（`lib/interactions.js`
	 * 的互动队列是同一个坑，两边已统一）。
	 */
	let sequence = 0;

	return {
		/**
		 * 追加一条汇报（完成时刻由调用方给，队列负责单调化与裁剪）。
		 * @param report - `{workerId,label,task,summary,ok,reason,result,finishedAt}`。
		 * @returns 带 `at`/`seq` 的完整汇报。
		 */
		push(report) {
			const entry = {
				seq: (sequence += 1),
				at: Math.max(Date.now(), Number(report?.finishedAt) || 0, cursor + 1),
				jobId: String(report?.jobId ?? ""),
				workerId: String(report?.workerId ?? ""),
				label: String(report?.label ?? ""),
				task: String(report?.task ?? ""),
				summary: String(report?.summary ?? ""),
				result: String(report?.result ?? ""),
				reason: String(report?.reason ?? ""),
				ok: report?.ok !== false,
			};
			cursor = entry.at;
			items.push(entry);
			if (items.length > limit) items = items.slice(-limit);
			return entry;
		},
		/**
		 * 取游标之后的汇报（按 `at` 升序，即完成先后）。
		 * @param after - 毫秒时间戳，或 `"latest"`（首帧：只要游标）。
		 * @returns `{ reports, cursor }`。
		 */
		after(after) {
			if (after === "latest" || after === undefined || after === null || after === "") {
				return { reports: [], cursor };
			}
			const bound = Number(after);
			const floor = Number.isFinite(bound) ? bound : 0;
			return {
				reports: items.filter((entry) => entry.at > floor).sort((a, b) => a.at - b.at),
				cursor,
			};
		},
		/** 当前游标（health / 调试用）。 */
		get cursor() {
			return cursor;
		},
		/** 队列长度。 */
		get size() {
			return items.length;
		},
		/** 最近若干条（health / 调试用，副本）。 */
		snapshot(count = 8) {
			return items.slice(-Math.max(0, count)).map((entry) => ({ ...entry }));
		},
		/** 清空（仅测试用）。 */
		clear() {
			items = [];
			cursor = 0;
			sequence = 0;
		},
	};
}

/**
 * 从 `request.url` 里取 `after` 查询参数。
 * @param url - 形如 `/plugins/.../api/reports?after=latest`。
 * @returns `"latest"` 或数字字符串（无参数时为 `null`）。
 */
export function parseReportAfter(url) {
	const raw = String(url ?? "").split("?")[1] ?? "";
	for (const pair of raw.split("&")) {
		const eq = pair.indexOf("=");
		const key = eq === -1 ? pair : pair.slice(0, eq);
		if (key !== "after") continue;
		const value = eq === -1 ? "" : decodeURIComponent(pair.slice(eq + 1));
		return value === "" ? null : value;
	}
	return null;
}
