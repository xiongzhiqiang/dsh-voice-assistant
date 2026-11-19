/**
 * 宿主侧 API 前缀的单一来源（V1.6）。
 *
 * 抽出这个文件是为了让 `config.js`（下发素材 URL）与 `routes.js`（注册路由）
 * 共用同一个常量，又不产生循环依赖 —— routes.js 已经 import 了 config.js，
 * config.js 不能再反过来 import routes.js。
 * 客户端另有一份同值常量（`src/client/core/constants.js`，构建产物），
 * 由 `tests/host.test.mjs` 的断言钉住两边一致。
 */
export const API_PREFIX = "/plugins/dsh-voice-assistant/api";
