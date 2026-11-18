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
 * 不依赖 LLM 的兜底汇报要点。
 *
 * 用于：① 用户显式关闭汇总；② 汇总 LLM 失败/超时；③ 结果为空。
 * 保持「先结论、再路径/原因」的口径，与 worker persona 的约束一致。
 *
 * @param options - `{ result, ok, reason, label, max }`。
 * @returns 一句可直接朗读的要点。
 */
export function deterministicSummary(options = {}) {
	const max = Number.isFinite(options.max) ? options.max : 120;
	const label = String(options.label ?? "专家").trim() || "专家";
	const ok = options.ok !== false;
	const reason = truncateText(options.reason ?? "未知原因", max);
	if (!ok) return `任务失败，原因是${reason}。`;
	const result = truncateText(options.result ?? "", max);
	if (result === "") return `${label}已完成任务，没有产生文字结果。`;
	// 结果里若 already 是完整句（含句号/分号），不要再套一层「已完成：」，
	// 否则真机上会出现「已完成：程序已编好，文件在 D:\a.py。」这种重复结论。
	if (/[。！？.!?；;]$/.test(result)) return result;
	return `${result}。`;
}

/**
 * 给一条汇报生成播报文案（客户端用；放在宿主侧便于单测口径统一）。
 *
 * @param report - `{label, summary, ok, reason}`。
 * @returns 可直接交给 TTS 的句子。
 */
export function formatReportSpeech(report) {
	const label = String(report?.label ?? "专家").trim() || "专家";
	const summary = String(report?.summary ?? "").trim();
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
