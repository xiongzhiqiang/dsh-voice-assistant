/** 探查 dsh-ears 的 remote/typert 端点与 HTTP 路由。 */
import { readFileSync } from "node:fs";

const base = "C:/Users/xqz19/.dsh/profiles/web/node_modules/dsh-ears/lib/";
const files = ["index.js", "remote-definitions-Ll0Duew_.js", "typert.js", "remote.js"];
for (const file of files) {
	let source;
	try {
		source = readFileSync(base + file, "utf8");
	} catch {
		continue;
	}
	console.log(`\n=== ${file} (${source.length}) ===`);
	const routes = [...source.matchAll(/["'`](\/[a-z0-9\-_/.]{3,60})["'`]/gi)].map((m) => m[1]);
	console.log("paths:", [...new Set(routes)].slice(0, 25));
	const ns = [...source.matchAll(/namespace\s*:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
	console.log("namespaces:", [...new Set(ns)]);
	const actions = [...source.matchAll(/action\s*:\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
	console.log("actions:", [...new Set(actions)].slice(0, 30));
	const endpoints = [...source.matchAll(/["'`](ears\.[a-zA-Z0-9_.]+)["'`]/g)].map((m) => m[1]);
	console.log("ears.* endpoints:", [...new Set(endpoints)].slice(0, 30));
}
