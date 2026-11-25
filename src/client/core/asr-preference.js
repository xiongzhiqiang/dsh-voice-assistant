/**
 * ASR 引擎/语言的用户偏好（UI 选择 → 持久化 → 启动恢复）。
 *
 * ## 为什么要独立成模块
 *
 * 偏好逻辑要被真机探针直接断言（"选了 sensevoice 后刷新还在不在"），
 * 塞进 controller 的构造器里就没法脱离 DOM 单测。抽成纯函数 + 一个薄薄的
 * storage 适配层，既方便单测，也让 localStorage 不可用时能优雅降级。
 *
 * ## 存储不可用时怎么办
 *
 * `localStorage` 在隐私模式 / 配额满 / window 代理下都可能抛。和
 * `ledger.js` / `drag.js` 一样：读写全程 try/catch，失败就用内存兜底 ——
 * 选择仍能在本会话内生效，只是刷新后不保留。绝不让存储故障打断语音。
 */

/** localStorage key（与 `xfv:v1:` 同族，便于统一管理）。 */
export const ASR_PREFERENCE_KEY = "xfv:v1:asr-preference";

/** 用户可选引擎。与 `config.asr.engine` 白名单一致 + `auto`。 */
export const ENGINE_CHOICES = ["auto", "webspeech", "ears", "sensevoice", "http"];

/** SenseVoice 可选语言（`engines/speech.js` 的同名常量，这里再列一份避免环）。 */
export const LANGUAGE_CHOICES = ["auto", "zh", "en", "yue", "ja", "ko"];

/**
 * 取存储对象；不可用返回 null。
 * @returns localStorage 或 null。
 */
function storage() {
	try {
		if (typeof localStorage === "undefined" || localStorage === null) return null;
		return localStorage;
	} catch {
		return null;
	}
}

/**
 * 归一化一条偏好记录（容错：非法值一律回落到默认）。
 *
 * @param raw - 原始对象。
 * @returns `{ engine, language, manual }`：`manual` 表示用户是否做过明确选择。
 */
export function normalizePreference(raw) {
	const source = raw !== null && typeof raw === "object" ? raw : {};
	const engine = ENGINE_CHOICES.includes(source.engine) ? source.engine : "auto";
	const language = LANGUAGE_CHOICES.includes(source.language) ? source.language : "auto";
	return { engine, language, manual: source.manual === true };
}

/** 默认偏好（未做过选择）。 */
export function defaultPreference() {
	return { engine: "auto", language: "auto", manual: false };
}

/**
 * 读偏好。读不到 / 坏数据一律返回默认。
 * @param store - 可选存储适配（便于单测注入）；省略则用 localStorage。
 * @returns 偏好对象。
 */
export function readPreference(store) {
	const target = store === undefined ? storage() : store;
	if (target === null) return defaultPreference();
	try {
		const text = target.getItem(ASR_PREFERENCE_KEY);
		if (typeof text !== "string" || text === "") return defaultPreference();
		return normalizePreference(JSON.parse(text));
	} catch {
		return defaultPreference();
	}
}

/**
 * 写偏好。写入失败不影响返回（本会话内调用方仍持有该值）。
 * @param preference - 偏好对象。
 * @param store - 可选存储适配。
 * @returns 实际写出的偏好。
 */
export function writePreference(preference, store) {
	const value = normalizePreference(preference);
	const target = store === undefined ? storage() : store;
	if (target !== null) {
		try {
			target.setItem(ASR_PREFERENCE_KEY, JSON.stringify(value));
		} catch {
			// 存储失败：本会话仍生效，忽略。
		}
	}
	return value;
}

/**
 * 生成 UI 展示用的引擎选项列表（带 label / 可用性）。
 *
 * `available` 由调用方按探测结论填；这里只负责固定元数据，便于单测断言
 * "选项齐全、顺序稳定"。
 *
 * @param availability - `{ ears?, sensevoice?, http? }` 各引擎探测结论。
 * @returns 选项数组 `[{ value, label, available }]`。
 */
export function engineOptions(availability = {}) {
	const yes = (key) => availability[key] !== false;
	return [
		{ value: "auto", label: "自动（推荐）", available: true },
		{ value: "webspeech", label: "浏览器识别", available: true },
		{ value: "ears", label: "本地 Whisper（dsh-ears）", available: yes("ears") },
		{ value: "sensevoice", label: "本地 SenseVoice（官方）", available: yes("sensevoice") },
		{ value: "http", label: "上游转写", available: yes("http") },
	];
}
