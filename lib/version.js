/**
 * 插件版本号的**唯一**来源（health 与日志引用这里）。
 *
 * ## 为什么不直接读 `package.json`
 *
 * 插件以 junction 装进 DSH 时，`import.meta.url` 解析到源码目录，读
 * `../package.json` 是可行的；但打包安装（拷贝进 `node_modules`）后，
 * 读文件多一条 I/O 与一种失败模式（读不到就少一个字段），收益不抵成本。
 *
 * ## 为什么不让它悄悄漂移
 *
 * 硬编码的版本号最容易犯的错是"发了新版但 health 还报旧号"，排查时
 * 会把人带偏（本项目 `health.version` 曾长期停在 `0.1.0`）。所以
 * `tests/experts.test.mjs` 里有一条断言，把这里的值与 `package.json`
 * 的 `version` 钉在一起 —— 忘了同步会立刻红。
 */

/** 与 `package.json` 的 `version` 必须一致（有单测守着）。 */
export const PLUGIN_VERSION = "1.6.0";
