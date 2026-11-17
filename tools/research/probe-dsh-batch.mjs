/** 用首页里真实的批量脚本 URL 取回客户端 bundle，确认我们的模块在被服务。 */
import { readFileSync } from "node:fs";

const log = readFileSync("C:/Users/xqz19/WorkBuddy/DSH_dev/tools/_dsh-run.log", "utf8");
const token = /token=([A-Za-z0-9_-]+)/.exec(log)?.[1] ?? "";
const BASE = "http://127.0.0.1:3080";
const html = readFileSync("C:/Users/xqz19/WorkBuddy/DSH_dev/tools/_dsh-index.html", "utf8");

const first = await fetch(`${BASE}/?token=${token}`, { redirect: "manual" });
const cookie = (first.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

const hrefs = [...html.matchAll(/href="(plugins\/\?\?[^"]+)"/g)]
	.map((m) => m[1])
	.filter((href) => href.includes("dsh-voice-assistant"));
console.log("batch urls containing our module:", hrefs.length);

for (const href of hrefs.slice(0, 1)) {
	const url = `${BASE}/${href.replace(/&amp;/g, "&")}`;
	console.log("fetch:", url.slice(0, 160), "…");
	const res = await fetch(url, { headers: { cookie } });
	const body = res.status === 200 ? await res.text() : "";
	console.log("status", res.status, "bytes", body.length);
	const idx = body.indexOf("dsh-voice-assistant");
	console.log("module appears at", idx);
	if (idx >= 0) console.log("snippet:", body.slice(Math.max(0, idx - 120), idx + 200).replace(/\s+/g, " "));
	console.log("has shell.overlay:", body.includes("shell.overlay"));
}
