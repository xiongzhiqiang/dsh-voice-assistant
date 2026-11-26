#!/usr/bin/env node
/**
 * V1.3/V1.4/V1.5 真机 HTTP 冒烟：真实派单 → worker 后台执行 → 要点按完成时间回传。
 *
 * 与单测的区别：这里连的是**正在跑的 DSH**，worker 是真的常驻 agent，带
 * preset（文件/命令工具），结果汇总走真实 LLM（失败会按规则降级）。
 *
 * 断言：
 *   1. `/health.delegation` 已启用，且 coder/researcher 已登记；
 *   2. `/health.routing` 报出 5 位专家、基因分析专家带 `somatic-mutation-report`；
 *   3. `/health.skills` 报出内置技能目录，且该技能确实被扫到；
 *   4. `/health.interactions` 已启用且旁听了预期数量的会话；
 *   5. `/route` 能把编程指令分给 coder；
 *   6. `/delegate` 当场返回，不阻塞到 worker 跑完；
 *   7. `/reports?after=<cursor>` 按完成时间升序回传两条不同 worker 的要点；
 *   8. `/interactions?after=<cursor>` 把**同一批汇报**也放进统一互动流，
 *      且三类条目的 `kind` 都在白名单内；
 *   9. 每条都带可朗读的 `speech`，且**不含**具体文件名/目录名（需求①）；
 *  10. 收尾后没有在途任务，首帧 `latest` 不重放历史。
 *
 * 用法：`node tools/smoke-delegation-http.mjs`
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.DSH_BASE ?? "http://127.0.0.1:3080";
const API = "/plugins/dsh-voice-assistant/api";
/** 版本号断言与收尾文案都用它，避免升版时漏改本文件。 */
const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

const failures = [];
const check = (name, ok, detail) => {
	const pass = Boolean(ok);
	if (!pass) failures.push({ name, detail });
	console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || detail === undefined ? "" : ` → ${detail}`}`);
};

/** 取常驻实例的 token（只用于请求，绝不打印）。 */
function readToken() {
	if (typeof process.env.DSH_TOKEN === "string" && process.env.DSH_TOKEN !== "") return process.env.DSH_TOKEN;
	const statePath = join(HERE, "_dsh-serve.json");
	if (!existsSync(statePath)) return "";
	try {
		const state = JSON.parse(readFileSync(statePath, "utf8"));
		return typeof state?.token === "string" ? state.token : "";
	} catch {
		return "";
	}
}

const token = readToken();
check("拿到访问 token", token !== "", token === "" ? "请先运行 tools/serve-dsh.mjs" : "已取得（不回显）");
if (token === "") process.exit(1);

/**
 * 调本机 API。
 * @param path - 形如 `/health` 或 `/reports?after=latest`。
 * @param options - `{ method, body }`。
 */
async function api(path, options = {}) {
	const separator = path.includes("?") ? "&" : "?";
	const url = `${BASE}${API}${path}${separator}token=${encodeURIComponent(token)}`;
	const response = await fetch(url, {
		method: options.method ?? "GET",
		headers: options.body === undefined ? {} : { "content-type": "application/json" },
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
		signal: AbortSignal.timeout(30000),
	});
	const text = await response.text();
	let payload = null;
	try {
		payload = JSON.parse(text);
	} catch {
		// 非 JSON 错误也要能定位。
	}
	if (!response.ok) throw new Error(`${path} → HTTP ${response.status}: ${text.slice(0, 200)}`);
	return payload;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
	// ── 1. 宿主自省 ─────────────────────────────────────────────────────
	const health = await api("/health");
	const delegation = health?.delegation ?? {};
	check("委托中枢已启用", delegation.enabled === true, JSON.stringify(delegation.enabled));
	const registered = Array.isArray(delegation.workers) ? delegation.workers.map((row) => row.id) : [];
	check("coder 已登记进中枢", registered.includes("coder"), registered.join(","));
	check("researcher 已登记进中枢", registered.includes("researcher"), registered.join(","));

	// ── 1b. 需求①：专家清单与技能（真机确认技能挂上了，而不只是配置写了）──
	// 单测只能证明"扫描与注册的纯逻辑对"，证明不了 agent 的 setup 里真的调了
	// 注册 —— 那要真机才看得见。这里读 health 的逐 worker 技能可用性。
	const workers = Array.isArray(health?.routing?.workers) ? health.routing.workers : [];
	check("宿主报出 5 位专家", workers.length === 5, `count=${workers.length}`);
	const bioinfo = workers.find((row) => row.id === "bioinfo");
	check("基因分析专家已建立", bioinfo !== undefined && bioinfo.ok === true, JSON.stringify(bioinfo?.error ?? bioinfo?.ok));
	check(
		"基因分析专家确实挂上了技能（真机验证 setup 注册生效）",
		Array.isArray(bioinfo?.skills?.registered) && bioinfo.skills.registered.includes("somatic-mutation-report"),
		JSON.stringify(bioinfo?.skills),
	);
	check("没有声明了却挂不上的技能", (bioinfo?.skills?.missing ?? []).length === 0, JSON.stringify(bioinfo?.skills?.missing));
	const skills = health?.skills ?? {};
	check("内置技能目录被扫到", (skills.total ?? 0) >= 1, JSON.stringify(skills.names));
	check("内置技能里有 somatic-mutation-report", (skills.names ?? []).includes("somatic-mutation-report"), JSON.stringify(skills.names));
	check("内置技能目录路径可见", typeof skills.builtinDir === "string" && skills.builtinDir !== "", String(skills.builtinDir));
	check("用户技能目录路径可见（用户自加入口）", typeof skills.userDir === "string" && skills.userDir !== "", String(skills.userDir));
	check("专家来源无问题（没有写坏的专家 JSON）", (health?.routing?.problems ?? []).length === 0, JSON.stringify(health?.routing?.problems));

	// ── 1c. 需求④：统一互动流已启用 ─────────────────────────────────────
	const inter = health?.interactions ?? {};
	check("互动流已启用", inter.enabled === true, JSON.stringify(inter.enabled));
	check("审批播报开着", inter.announceApprovals === true, JSON.stringify(inter.announceApprovals));
	check("提问播报开着", inter.announceQuestions === true, JSON.stringify(inter.announceQuestions));
	check("旁听的会话是 5 条（根 agent + 4 位独立 worker）", inter.watching === 5, String(inter.watching));

	// ── 2. 路由 ─────────────────────────────────────────────────────────
	const routeText = "帮我写一段 Python 代码，打印 hello，然后把代码保存到文件里。";
	const routed = await api("/route", { method: "POST", body: { text: routeText } });
	check("编程指令路由到 coder", routed?.worker === "coder", JSON.stringify(routed));
	check("路由给出了改写后的任务", typeof routed?.task === "string" && routed.task !== "", String(routed?.task).slice(0, 80));
	// 需求①的基因分析专家必须能接活（否则"专家列表"只是个摆设）。
	const bioRoute = await api("/route", { method: "POST", body: { text: "帮我分析这个样本的体细胞突变，然后出一份变异报告。" } });
	check("基因分析指令路由到 bioinfo", bioRoute?.worker === "bioinfo", JSON.stringify(bioRoute));

	// ── 3. 对齐游标（首帧 latest 不重放历史）───────────────────────────
	const initial = await api("/reports?after=latest");
	check("首帧不重放历史汇报", Array.isArray(initial.reports) && initial.reports.length === 0, String(initial.reports?.length));
	let cursor = initial.cursor;
	const initialInter = await api("/interactions?after=latest");
	check(
		"互动流首帧也不重放历史",
		Array.isArray(initialInter.interactions) && initialInter.interactions.length === 0,
		String(initialInter.interactions?.length),
	);
	let interCursor = initialInter.cursor;

	// ── 4. 真实派单 ─────────────────────────────────────────────────────
	// 用只读任务：本插件按设计不代答工具审批，写工作区外的路径会一直挂起。
	//
	// `coderTask` 特意让专家**报告自己的目录** —— 这正是需求① 要洗掉的
	// 东西。于是这条派单同时验证两件事：派单链路通，且路径在播报前被
	// `condenseArtifacts` 概括掉（下面第 9 条断言）。
	//
	// ⚠️ V2.4 起必须**显式指定 sessionId**：省略时宿主会走 需求④ 的落点判定
	// —— 若该专家没有活跃会话就新开一个，并用**本次任务名**给它命名。冒烟
	// 的任务名（"请用一句话说明你的当前工作目录是哪个路径…"）会污染用户真实
	// 的会话列表。显式指定活跃会话就只挂任务、不新建、不改名。
	const activeSessions = health?.delegation?.activeSessions ?? {};
	const pinSession = async (workerId) => {
		let sid = typeof activeSessions[workerId] === "string" ? activeSessions[workerId] : "";
		if (sid !== "") return sid;
		// 极少见：该专家当前没有活跃会话。这时退回省略（让宿主新开一个）——
		// 冒烟本身要能跑通比"绝不新建"更重要，且这正验证了需求④。
		const view = (await api(`/sessions/${workerId}`))?.sessions?.[workerId];
		return view?.activeSessionId ?? "";
	};
	const coderTask = "请用一句话说明你的当前工作目录是哪个路径；只回答，不要运行写文件或提权的命令。";
	const researcherTask = "请用一句话说明语音助手里 router 与 worker 的分工，不要修改任何文件。";

	const started = Date.now();
	const r1 = await api("/delegate", { method: "POST", body: { worker: "researcher", task: researcherTask, sessionId: await pinSession("researcher") } });
	const r2 = await api("/delegate", { method: "POST", body: { worker: "coder", task: coderTask, sessionId: await pinSession("coder") } });
	check("researcher 派单当场成功", r1?.ok === true, JSON.stringify(r1));
	check("coder 派单当场成功", r2?.ok === true, JSON.stringify(r2));
	check("两次派单都有 jobId", typeof r1?.jobId === "string" && typeof r2?.jobId === "string", `${r1?.jobId} / ${r2?.jobId}`);
	// 需求④：显式指定会话时不该新开（冒烟不污染用户会话列表）。
	check("显式指定会话时不新开会话", r1?.openedSession !== true && r2?.openedSession !== true, `${r1?.openedSession} / ${r2?.openedSession}`);
	check("派单回报了目标会话", typeof r1?.sessionId === "string" && r1.sessionId !== "", String(r1?.sessionId));

	// ── 5. 轮询汇报（按游标增量）──────────────────────────────────────
	const collected = [];
	// 需求④：同一条汇报也该出现在统一互动流里（三类合流）。这里一并收。
	const interCollected = [];
	const deadline = Date.now() + 240000;
	while (Date.now() < deadline) {
		await sleep(2500);
		const payload = await api(`/reports?after=${encodeURIComponent(String(cursor))}`);
		if (typeof payload?.cursor === "number") cursor = payload.cursor;
		for (const report of payload?.reports ?? []) collected.push(report);
		const interPayload = await api(`/interactions?after=${encodeURIComponent(String(interCursor))}`);
		if (typeof interPayload?.cursor === "number") interCursor = interPayload.cursor;
		for (const entry of interPayload?.interactions ?? []) interCollected.push(entry);
		if (collected.length >= 2) break;
	}
	check("两条汇报都在超时前回传", collected.length >= 2, `count=${collected.length}, elapsed=${Date.now() - started}ms`);

	const byWorker = new Map(collected.map((row) => [row.workerId, row]));
	check("researcher 有汇报", byWorker.has("researcher"), [...byWorker.keys()].join(","));
	check("coder 有汇报", byWorker.has("coder"), [...byWorker.keys()].join(","));
	const codes = collected.map((row) => row.at);
	check("汇报按完成时间严格升序", codes.every((at, index) => index === 0 || at > codes[index - 1]), JSON.stringify(codes));
	check("每条都有可朗读文案", collected.every((row) => typeof row.speech === "string" && row.speech.trim() !== ""), JSON.stringify(collected.map((row) => row.speech?.slice(0, 40))));
	check("汇报文案带专家名", collected.every((row) => String(row.speech).startsWith(String(row.label))), JSON.stringify(collected.map((row) => row.speech?.slice(0, 20))));
	const coderReport = byWorker.get("coder");
	// 需求①：播报文案里**不允许**出现文件名 / 目录名 / 盘符。
	//
	// 这条原来是反过来的 ——「编程汇报保留了路径信息」，让专家报告自己的
	// 目录来验证路径能传出来。需求① 改了口径：产物一律概括成「产生了
	// N 个文件，都放在工作目录下」，逐字念路径正是要制止的行为。
	//
	// 注意断言分两层：**「工作目录」这个概括词本身是允许的**（它就是新
	// 口径的一部分），被禁的是具体的盘符与文件名。
	const coderSpeech = String(coderReport?.speech ?? "");
	check(
		"编程汇报不再念具体路径（需求①）",
		coderSpeech !== "" && !/[A-Za-z]:[\\/]/.test(coderSpeech) && !/(?:^|[\s，、；;])[\w.\-]+\.(?:py|js|ts|json|md|csv|txt|html|yaml|yml)\b/.test(coderSpeech),
		coderSpeech.slice(0, 160),
	);
	check(
		"编程汇报也未泄漏常见用户目录名",
		!/Users[\\/]|home[\\/]|Documents|Desktop|Downloads/.test(coderSpeech),
		coderSpeech.slice(0, 160),
	);
	// 正例：概括口径（若正文里确实提到产物，应落到「工作目录」这个说法上）。
	check(
		"若提到产物则用「工作目录」概括口径",
		!/(文件|结果)/.test(coderSpeech) || coderSpeech.includes("工作目录"),
		coderSpeech.slice(0, 160),
	);

	// ── 5b. 需求④：统一互动流收下了同一条汇报 ──────────────────────────
	const reportEntries = interCollected.filter((entry) => entry.kind === "report");
	check("互动流里也收到了汇报", reportEntries.length >= 2, `count=${reportEntries.length}`);
	check(
		"互动条目都带白名单内的 kind",
		interCollected.every((entry) => ["approval", "question", "report"].includes(entry.kind)),
		JSON.stringify([...new Set(interCollected.map((entry) => entry.kind))]),
	);
	check(
		"互动条目都带可朗读文案",
		interCollected.every((entry) => typeof entry.speech === "string" && entry.speech.trim() !== ""),
		JSON.stringify(interCollected.map((entry) => entry.speech?.slice(0, 30))),
	);
	const interCodes = interCollected.map((entry) => entry.at);
	check("互动流严格按时间升序（需求④的地基）", interCodes.every((at, index) => index === 0 || at > interCodes[index - 1]), JSON.stringify(interCodes));
	check(
		"互动流条目带人读序号（不是毫秒戳）",
		interCollected.every((entry) => Number.isInteger(entry.seq) && entry.seq >= 1 && entry.seq < 1000),
		JSON.stringify(interCollected.map((entry) => entry.seq)),
	);

	// ── 6. 收尾 ─────────────────────────────────────────────────────────
	const finalHealth = await api("/health");
	check("没有残留的在途任务", (finalHealth?.delegation?.activeJobs ?? []).length === 0, JSON.stringify(finalHealth?.delegation?.activeJobs));
	const replay = await api("/reports?after=latest");
	check("刷新后的首帧仍不重放历史", Array.isArray(replay.reports) && replay.reports.length === 0, String(replay.reports?.length));
	const replayInter = await api("/interactions?after=latest");
	check(
		"互动流刷新后首帧也不重放",
		Array.isArray(replayInter.interactions) && replayInter.interactions.length === 0,
		String(replayInter.interactions?.length),
	);
	// 版本号从 package.json 读，**不硬编码** —— 否则每次升版都要改这里，
	// 忘了改就是"代码全对但冒烟红"，而那条红没有任何诊断价值。
	check("health 版本号与 package.json 一致", finalHealth?.version === pkg.version, `health=${finalHealth?.version} package=${pkg.version}`);
} catch (error) {
	failures.push({ name: "真机 HTTP 冒烟异常", detail: String(error?.stack ?? error) });
	console.error(error);
}

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	for (const failure of failures) console.error(`  - ${failure.name}: ${failure.detail ?? ""}`);
	process.exitCode = 1;
} else {
	console.log(`\nV${pkg.version} 真机派单/汇报/互动流冒烟通过`);
}
