/**
 * 专家卡通形象素材：路径白名单 + HTTP 服务（V1.6）。
 *
 * ## 为什么是白名单而不是静态目录服务
 *
 * 素材只有固定的 6 张 PNG（5 位内置专家 + 音球）。用一个**显式白名单**
 * 而不是通用的静态文件服务，理由有三：
 *   1. 浏览器能请求的只有白名单里的文件，`..` 穿越、隐藏文件、临时文件
 *      一概不存在泄漏面（插件目录里还有 README、配置、日志文件）；
 *   2. 用户自加的专家 id 拿到的是 `general` 兜底图，不会因为 id 里带了
 *      奇怪字符就把请求拼成危险路径；
 *   3. 换素材只要改这里的映射，不用碰路由代码。
 *
 * ## 为什么不出图也照常工作
 *
 * 素材服务是纯装饰：缺图时客户端拿到 404，UI 用 CSS 画的字母头像兜底，
 * 语音功能一点不受影响。所以这里所有失败都是"记一条日志 + 回 404"，
 * 绝不抛到装配层把整个插件带崩。
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** 角色素材白名单：`name -> 文件名`。 */
export const AVATAR_FILES = Object.freeze({
	general: "general.png",
	bioinfo: "bioinfo.png",
	coder: "coder.png",
	researcher: "researcher.png",
	operator: "operator.png",
	// V1.7：两位新专家复用语义最接近的现有素材，直到生成专属形象。
	// 被删的三位（coder/researcher/operator）映射保留，兼容旧配置里的残留 id。
	pathologist: "researcher.png",
	"protein-designer": "bioinfo.png",
	orb: "orb.png",
});

/** 兜底形象（用户自加的专家 id 用这张）。 */
export const FALLBACK_AVATAR = "general";

/** 素材目录（相对插件根）。 */
const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "characters");

/** 路由前缀（挂在 API 前缀之下）。 */
export const AVATARS_PATH = "/avatars";

/**
 * 把 worker id 解析成安全的素材名（纯函数，可单测）。
 *
 * @param id - worker id（可能来自用户写的 JSON，不可信）。
 * @returns 白名单里的名字；未知 id 一律回落 `general`。
 */
export function avatarName(id) {
	if (typeof id !== "string") return FALLBACK_AVATAR;
	return Object.prototype.hasOwnProperty.call(AVATAR_FILES, id) ? id : FALLBACK_AVATAR;
}

/**
 * 从请求子路径解析素材名（纯函数，可单测）。
 *
 * 只接受 `/avatars/<name>.png` 且 `<name>` 在白名单内；多段路径、查询串、
 * `..`、URL 编码的斜杠都拒绝。
 *
 * @param subPath - 路由 hp 解析后的子路径（不含 query）。
 * @returns 文件名；非法返回 null。
 */
export function avatarFileFromPath(subPath) {
	if (typeof subPath !== "string") return null;
	const prefix = `${AVATARS_PATH}/`;
	if (!subPath.startsWith(prefix)) return null;
	const tail = subPath.slice(prefix.length);
	if (!/^[a-z0-9-]+\.png$/.test(tail)) return null;
	const name = tail.slice(0, -4);
	return Object.prototype.hasOwnProperty.call(AVATAR_FILES, name) ? AVATAR_FILES[name] : null;
}

/** PNG 的响应头（长缓存：文件名是内容寻址的语义名，换了素材就换版本）。 */
const PNG_HEADERS = Object.freeze({
	"content-type": "image/png",
	"cache-control": "public, max-age=86400",
});

/**
 * 注册素材路由。
 *
 * @param ctx - Cordis 上下文（要 `webServer`）。
 * @param apiPrefix - 宿主 API 前缀。
 * @returns 卸载函数。
 */
export function installAvatarRoutes(ctx, apiPrefix) {
	const webServer = ctx.get("webServer");
	if (webServer === undefined || webServer === null) throw new Error("webServer 不可用，无法挂载素材路由");

	const prefix = `${apiPrefix}${AVATARS_PATH}`;
	return webServer.register({
		kind: "prefix",
		path: prefix,
		handler: async (request, response) => {
			// 只取 pathname —— 带 query 的 URL（如 ?v=2）不该让白名单判据失败。
			let pathname = String(request.url ?? "");
			const q = pathname.indexOf("?");
			if (q !== -1) pathname = pathname.slice(0, q);

			// prefix 路由收到的 url 形状随 webServer 实现而变：可能是完整
			// `/plugins/.../avatars/orb.png`，也可能只有 `/orb.png`。两种都认。
			const sub = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;
			const file = avatarFileFromPath(`${AVATARS_PATH}/${sub.replace(/^\/+/, "")}`);
			if (file === null) {
				response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				response.end("not found");
				return;
			}
			try {
				const bytes = await readFile(join(ASSET_DIR, file));
				response.writeHead(200, { ...PNG_HEADERS, "content-length": String(bytes.length) });
				response.end(bytes);
			} catch (error) {
				ctx.logger?.warn?.(`voice-assistant: 素材读取失败 ${file} —— ${error?.message ?? error}`);
				response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
				response.end("not found");
			}
		},
	});
}

/**
 * 生成素材 URL（宿主与客户端配置共用同一套拼法）。
 *
 * @param apiPrefix - API 前缀。
 * @param name - 白名单里的名字。
 * @returns 相对 URL。
 */
export function avatarUrl(apiPrefix, name) {
	return `${apiPrefix}${AVATARS_PATH}/${avatarName(name)}.png`;
}
