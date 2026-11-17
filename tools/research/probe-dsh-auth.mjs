/** 探测 dsh webserver 的鉴权方式与插件静态路由路径。 */
import { readFileSync } from "node:fs";

const log = readFileSync("C:/Users/xqz19/WorkBuddy/DSH_dev/tools/_dsh-run.log", "utf8");
const token = /token=([A-Za-z0-9_-]+)/.exec(log)?.[1] ?? "";
console.log("token len", token.length);

const BASE = "http://127.0.0.1:3080";
const paths = [
	"/",
	`/?token=${token}`,
	`/plugins/dsh-voice-assistant/client.js?token=${token}`,
	"/plugins/dsh-voice-assistant/client.js",
	"/plugins/dsh-ears/client.js",
	`/plugins/dsh-ears/client.js?token=${token}`,
];

for (const path of paths) {
	try {
		const res = await fetch(BASE + path, { redirect: "manual" });
		const type = res.headers.get("content-type") ?? "";
		const loc = res.headers.get("location") ?? "";
		let head = "";
		if (type.includes("html")) head = (await res.text()).slice(0, 200).replace(/\s+/g, " ");
		console.log(`${res.status}\t${path}\t${type}\t${loc}\t${head}`);
	} catch (error) {
		console.log(`ERR\t${path}\t${error.message}`);
	}
}
