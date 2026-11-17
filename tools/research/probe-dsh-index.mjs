/** 带 cookie 取首页 HTML，找出客户端 bundle 的真实 URL 形态。 */
import { readFileSync, writeFileSync } from "node:fs";

const log = readFileSync("C:/Users/xqz19/WorkBuddy/DSH_dev/tools/_dsh-run.log", "utf8");
const token = /token=([A-Za-z0-9_-]+)/.exec(log)?.[1] ?? "";
const BASE = "http://127.0.0.1:3080";

const first = await fetch(`${BASE}/?token=${token}`, { redirect: "manual" });
const cookies = (first.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
console.log("set-cookie:", cookies.join(" | ") || "(none)");

const res = await fetch(`${BASE}/`, { headers: { cookie: cookies.join("; ") } });
console.log("status", res.status, res.headers.get("content-type"));
const html = await res.text();
writeFileSync("C:/Users/xqz19/WorkBuddy/DSH_dev/tools/_dsh-index.html", html, "utf8");
console.log("html length", html.length);

const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
console.log("scripts:", scripts.join("\n  "));
const hasGlobal = html.includes("__VOICE_ASSISTANT_CONFIG__");
console.log("has config global:", hasGlobal);
if (hasGlobal) {
	const i = html.indexOf("__VOICE_ASSISTANT_CONFIG__");
	console.log("snippet:", html.slice(i - 60, i + 260).replace(/\s+/g, " "));
}
