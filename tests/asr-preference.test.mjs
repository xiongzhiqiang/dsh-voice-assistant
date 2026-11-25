/** ASR 偏好 + speech 引擎纯逻辑自检（V2.0，不需要浏览器）。 */
import {
	ASR_PREFERENCE_KEY,
	ENGINE_CHOICES,
	LANGUAGE_CHOICES,
	normalizePreference,
	defaultPreference,
	readPreference,
	writePreference,
	engineOptions,
} from "../src/client/core/asr-preference.js";
import { SPEECH_LANGUAGES, speechCandidates, speechNamespace, probeSpeech } from "../src/client/core/engines/speech.js";

const failures = [];
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures.push({ name, actual, expected });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` → ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`}`);
};

// 内存存储替身（与 localStorage 同形状，便于断言读写）。
function memoryStore(initial = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => map.set(k, String(v)),
		removeItem: (k) => map.delete(k),
		_dump: () => Object.fromEntries(map),
	};
}

console.log("\n── ASR 偏好归一化 ──");
check("默认偏好", defaultPreference(), { engine: "auto", language: "auto", manual: false });
check("归一化合法偏好", normalizePreference({ engine: "sensevoice", language: "zh", manual: true }), {
	engine: "sensevoice",
	language: "zh",
	manual: true,
});
check("非法引擎回落 auto", normalizePreference({ engine: "bogus" }).engine, "auto");
check("非法语言回落 auto", normalizePreference({ language: "xx" }).language, "auto");
check("manual 只认布尔 true", normalizePreference({ manual: "true" }).manual, false);
check("空对象回落默认", normalizePreference(null), defaultPreference());

console.log("\n── 读写与持久化 ──");
check("偏好 key 稳定", ASR_PREFERENCE_KEY, "xfv:v1:asr-preference");
const store = memoryStore();
check("空存储读默认", readPreference(store), defaultPreference());
writePreference({ engine: "sensevoice", language: "yue", manual: true }, store);
check("写入后读回", readPreference(store), { engine: "sensevoice", language: "yue", manual: true });
check("写入内容含 manual", JSON.parse(store.getItem(ASR_PREFERENCE_KEY)).manual, true);
// 坏 JSON 不应抛，回落默认。
check("坏 JSON 回落默认", readPreference(memoryStore({ [ASR_PREFERENCE_KEY]: "{broken" })), defaultPreference());
// 存储不可用（null）时仍返回默认。
check("无存储回落默认", readPreference(null), defaultPreference());
check("无存储写入不抛", writePreference({ engine: "ears", manual: true }, null).engine, "ears");

console.log("\n── 选项清单 ──");
check("引擎选项齐全且顺序稳定", engineOptions({}).map((o) => o.value), ["auto", "webspeech", "ears", "sensevoice", "http"]);
check("auto 恒可用", engineOptions().find((o) => o.value === "auto").available, true);
check("sensevoice 未探测到时标记不可用", engineOptions({ sensevoice: false }).find((o) => o.value === "sensevoice").available, false);
check("sensevoice 探测到时可用", engineOptions({ sensevoice: true }).find((o) => o.value === "sensevoice").available, true);
check("语言常量与偏好一致", LANGUAGE_CHOICES, SPEECH_LANGUAGES);
check("引擎白名单含 sensevoice", ENGINE_CHOICES.includes("sensevoice"), true);

console.log("\n── speech 命名空间取值（多候选容错）──");
check("空 ctx 取不到命名空间", speechNamespace({}), null);
const fakeNs = { transcribe: () => {}, catalog: () => {} };
check("ctx.get(remote.speech) 命中", speechNamespace({ get: (n) => (n === "remote.speech" ? fakeNs : undefined) }), fakeNs);
check("ctx.remote.speech 兜底命中", speechNamespace({ remote: { speech: fakeNs } }), fakeNs);
check("候选取法数量稳定（多候选容错）", speechCandidates({}).length, 7);
const probeThrow = await probeSpeech({ get: () => { throw new Error("no inject"); } });
check("取值异常在 probe.paths 里可见", probeThrow.paths.some((p) => typeof p.error === "string"), true);
const probeEmpty = await probeSpeech({});
check("空 ctx 探测不可用", probeEmpty.available, false);
check("空 ctx 的 paths 全部未命中", probeEmpty.paths.every((p) => p.hit === false), true);

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	for (const failure of failures) console.error(`  - ${failure.name}: ${JSON.stringify(failure.actual)} / 期望 ${JSON.stringify(failure.expected)}`);
	process.exitCode = 1;
} else {
	console.log("\n全部通过");
}
