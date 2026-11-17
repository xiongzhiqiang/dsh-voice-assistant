#!/usr/bin/env node
/**
 * V1.3 真机 HTTP 冒烟：真实派单 → worker 后台执行 → 要点按完成时间回传。
 *
 * 与单测的区别：这里连的是**正在跑的 DSH**，worker 是真的常驻 agent，带
 * preset（文件/命令工具），结果汇总走真实 LLM（失败会按规则降级）。
 *
 * 断言：
 *   1. `/health.delegation` 已启用，且 coder/researcher 已登记；
 *   2. `/route` 能把编程指令分给 coder；
 *   3. `/delegate` 当场返回，不阻塞到 worker 跑完；
 *   4. `/reports?after=<cursor>` 按完成时间升序回传两条不同 worker 的要点；
 *   5. 每条都带可朗读的 `speech`，编程那条保留路径信息；
 *   6. 收尾后没有在途任务，首帧 `latest` 不重放历史。
 *
 * 用法：`node tools/smoke-delegation-http.mjs`
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.DSH_BASE ?? "http://127.0.0.1:3080";
const API = "/plugins/dsh-voice-assistant/api";

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

	// ── 2. 路由 ─────────────────────────────────────────────────────────
	const routeText = "帮我写一段 Python 代码，打印 hello，然后把代码保存到文件里。";
	const routed = await api("/route", { method: "POST", body: { text: routeText } });
	check("编程指令路由到 coder", routed?.worker === "coder", JSON.stringify(routed));
	check("路由给出了改写后的任务", typeof routed?.task === "string" && routed.task !== "", String(routed?.task).slice(0, 80));

	// ── 3. 对齐游标（首帧 latest 不重放历史）───────────────────────────
	const initial = await api("/reports?after=latest");
	check("首帧不重放历史汇报", Array.isArray(initial.reports) && initial.reports.length === 0, String(initial.reports?.length));
	let cursor = initial.cursor;

	// ── 4. 真实派单 ─────────────────────────────────────────────────────
	// 用只读任务：本插件按设计不代答工具审批，写工作区外的路径会一直挂起。
	// 要验证"保留路径"，让专家**报告**自己的目录即可，不产生任何文件。
	const coderTask = "请用一句话说明你的当前工作目录是哪个路径；只回答，不要运行写文件或提权的命令。";
	const researcherTask = "请用一句话说明语音助手里 router 与 worker 的分工，不要修改任何文件。";

	const started = Date.now();
	const r1 = await api("/delegate", { method: "POST", body: { worker: "researcher", task: researcherTask } });
	const r2 = await api("/delegate", { method: "POST", body: { worker: "coder", task: coderTask } });
	check("researcher 派单当场成功", r1?.ok === true, JSON.stringify(r1));
	check("coder 派单当场成功", r2?.ok === true, JSON.stringify(r2));
	check("两次派单都有 jobId", typeof r1?.jobId === "string" && typeof r2?.jobId === "string", `${r1?.jobId} / ${r2?.jobId}`);

	// ── 5. 轮询汇报（按游标增量）──────────────────────────────────────
	const collected = [];
	const deadline = Date.now() + 240000;
	while (Date.now() < deadline) {
		await sleep(2500);
		const payload = await api(`/reports?after=${encodeURIComponent(String(cursor))}`);
		if (typeof payload?.cursor === "number") cursor = payload.cursor;
		for (const report of payload?.reports ?? []) collected.push(report);
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
	check(
		"编程汇报保留了路径信息",
		typeof coderReport?.speech === "string" && (coderReport.speech.includes("工作目录") || coderReport.speech.includes("Documents")),
		String(coderReport?.speech).slice(0, 160),
	);

	// ── 6. 收尾 ─────────────────────────────────────────────────────────
	const finalHealth = await api("/health");
	check("没有残留的在途任务", (finalHealth?.delegation?.activeJobs ?? []).length === 0, JSON.stringify(finalHealth?.delegation?.activeJobs));
	const replay = await api("/reports?after=latest");
	check("刷新后的首帧仍不重放历史", Array.isArray(replay.reports) && replay.reports.length === 0, String(replay.reports?.length));
} catch (error) {
	failures.push({ name: "真机 HTTP 冒烟异常", detail: String(error?.stack ?? error) });
	console.error(error);
}

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	for (const failure of failures) console.error(`  - ${failure.name}: ${failure.detail ?? ""}`);
	process.exitCode = 1;
} else {
	console.log("\nV1.3 真机派单/汇报冒烟通过");
}
