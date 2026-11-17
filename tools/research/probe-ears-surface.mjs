/** 探查 dsh-ears 暴露的服务面与客户端注册点。 */
import { readFileSync } from "node:fs";

const base = "C:/Users/xqz19/.dsh/profiles/web/node_modules/dsh-ears/lib/";
for (const file of ["index.js", "client.js"]) {
	const source = readFileSync(base + file, "utf8");
	console.log(`\n=== ${file} (${source.length} bytes) ===`);
	const provides = [...source.matchAll(/provide\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
	console.log("provide:", [...new Set(provides)]);
	const injects = [...source.matchAll(/reflect\.inject\(\s*\[([^\]]*)\]/g)].map((m) => m[1].replace(/\s+/g, " "));
	console.log("reflect.inject:", [...new Set(injects)].slice(0, 10));
	const slots = [...source.matchAll(/slots\.(?:register|inject)\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
	console.log("slot keys:", [...new Set(slots)].slice(0, 20));
	const exports_ = [...source.matchAll(/exports\.([A-Za-z0-9_$]+)\s*=/g)].map((m) => m[1]);
	console.log("exports:", [...new Set(exports_)].slice(0, 30));
	// 名字里带 service / api 的字符串
	const api = [...source.matchAll(/["'`]([a-zA-Z][a-zA-Z0-9_]{3,40}\.(?:start|stop|begin|end|transcribe|record|listen)[a-zA-Z]*)["'`]/g)].map((m) => m[1]);
	console.log("verb-ish names:", [...new Set(api)].slice(0, 20));
}
