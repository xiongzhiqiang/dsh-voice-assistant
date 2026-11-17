/** 带 cookie 再探客户端 bundle 路径。 */
import { readFileSync } from "node:fs";

const log = readFileSync("C:/Users/xqz19/WorkBuddy/DSH_dev/tools/_dsh-run.log", "utf8");
const token = /token=([A-Za-z0-9_-]+)/.exec(log)?.[1] ?? "";
const BASE = "http://127.0.0.1:3080";

const first = await fetch(`${BASE}/?token=${token}`, { redirect: "manual" });
const cookies = (first.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

const paths = [
	"/plugins/dsh-voice-assistant/client.js",
	"/plugins/dsh-ears/client.js",
	"/plugins/??dsh-voice-assistant/client.js",
	"/plugins/dsh-voice-assistant/client.js?rev=1",
];
for (const path of paths) {
	const res = await fetch(BASE + path, { headers: { cookie: cookies } });
	const body = res.status === 200 ? await res.text() : "";
	console.log(`${res.status}\t${path}\t${res.headers.get("content-type")}\t${body.length}b`);
	if (body.length > 0) console.log("   head:", body.slice(0, 90).replace(/\s+/g, " "));
}
