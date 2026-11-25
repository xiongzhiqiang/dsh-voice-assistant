/**
 * 复用 `dsh-ears` 的转写能力（可选，检测到才启用）。
 *
 * ## 为什么要接它
 *
 * `dsh-ears` 是 DSH 生态里已有的语音输入插件，已经实现了 8 个识别后端：
 * 浏览器 Web Speech、本地 Whisper（whisper.cpp 原生）、Groq、Deepgram、
 * 阿里云百炼、腾讯云、小米 MiMo、硅基流动、火山引擎，以及自定义
 * OpenAI 兼容端点。它把这些封装成一个 typert 远程方法：
 *
 *     dshEars.transcribe(audioBase64, mimeType) → { text }
 *
 * 本插件要的是**唤醒、会话、播报、休眠**这四件编排能力，
 * 识别后端不该重写一遍。所以只要 `dshEars` 命名空间在场，就优先用它 ——
 * 用户在 dsh-ears 设置页里选的后端、下的 Whisper 模型、填的 key 全都直接生效。
 *
 * ## 契约的不确定性怎么处理
 *
 * typert 的远程返回值在版本间有三种常见形态（裸值 / `{ text }` /
 * `{ ok, value }`）。这里统一 `unwrap()` 一次，避免上游小改就让本插件崩。
 * 同理，命名空间既可能挂在 `ctx.remote` 也可能要 `ctx.get('remote')` 取，
 * 两条都试。
 *
 * ## 探测必须"便宜且可失败"
 *
 * 探测走 `listAsrBackends()`（纯本地读设置，不打网络）。失败一律视为
 * "没装 dsh-ears"，静默降级到浏览器识别 —— 一个可选依赖不该让主链路报错。
 *
 * ## ⚠️ 音频格式：本地 Whisper 只吃 WAV
 *
 * 这是接 dsh-ears 时**最容易翻车、且报错完全指不到点**的一处。
 *
 * `dsh-ears` 宿主侧对本地 Whisper 有一道硬校验（`assertPcm16Wav`）：
 * 只接受 **16 kHz 单声道 PCM16 WAV**，其它一律 `asrAudioInvalid`。
 * 而浏览器 `MediaRecorder` 产出的是 **webm/opus**（压缩容器）。
 *
 * `dsh-ears` **自己的**录音按钮会在发送前归一化
 * （`prepareRecordedAudioForBackend` → `normalizeRecordedAudioForLocalWhisper`），
 * 但远程方法 `transcribe()` 收到什么就送什么 —— **归一化的责任在调用方**。
 * 本插件正是调用方，所以必须自己补上，否则用户会看到：
 *
 * > 模型下好了、运行时也正常、设置里选了「本地 Whisper」，
 * > 一说话却报"音频无效"。
 *
 * 需要 WAV 的后端不止本地 Whisper。这里**照抄 `dsh-ears` 自己的判定**，
 * 保证"它自己的录音按钮能用"⇔"我们发出去的也能用"。
 */
import { blobToPcm16Wav } from "../audio/wav.js";
import { asrStatus, asrTranscribe, warn } from "../runtime.js";

/**
 * 取 dsh-ears 的远程命名空间。
 *
 * ## ⚠️ 必须用**带点号的完整注册名**去问，不能嵌套取
 *
 * 这是本项目踩过两次的同一个坑（第一次在 `remote.userQuestions`）：
 *
 *   - `ctx.remote.dshEars` 这种**嵌套属性**访问会被 cordis 的代理拦下，
 *     未在插件 `inject` 里声明过就抛
 *     `cannot get property "remote.dshEars" without inject`；
 *   - **不能**把它加进 `inject` —— `inject` 是"必须就绪才启动"，
 *     精简 profile 没装 dsh-ears 时整只语音球会**永不激活**
 *     （连降级都做不到）。而它本来就是可选依赖。
 *
 * 正解是 cordis 给的免 inject 读取口：**传服务全名**（`remote.dshEars`
 * 是注册名，不是"取 remote 再取 dshEars"）。
 *
 * `dsh-ears` 自己的客户端也是这么接的：`ctx.inject(["remote.dshEars"], …)`。
 *
 * ## 为什么保留多条候选
 *
 * 不同版本/不同装配路径下，命名空间可能挂在 `remote.dshEars`、
 * 也可能就是一个 `dshEars` 顶层服务；而 `ctx.remote.dshEars` 在
 * **已声明 inject 的宿主**里仍然可用（本项目的单测就是这么造的）。
 * 逐条试、取第一个能用的，比赌唯一形态稳。
 *
 * @param ctx - 客户端 Cordis 上下文。
 * @returns 命名空间对象，或 `null`。
 */
export function earsNamespace(ctx) {
	for (const candidate of earsCandidates(ctx)) {
		const namespace = candidate?.value;
		if (namespace && typeof namespace.transcribe === "function") return namespace;
	}
	return null;
}

/**
 * 按优先级列出所有可能的 dsh-ears 命名空间（**不筛** `transcribe`）。
 *
 * 单独抽出来是为了让排障能看清"到底哪条路通、取到的是什么形状" ——
 * 只返回 `transcribe` 有没有，遇到形态不符时完全看不出差在哪。
 *
 * @param ctx - 客户端 Cordis 上下文。
 * @returns `{ from, value }` 列表（`value` 可能是 `undefined`）。
 */
export function earsCandidates(ctx) {
	const probe = (name, read) => {
		try {
			return { from: name, value: read() };
		} catch (error) {
			// 代理属性取值可能同步抛（inject 未声明），这本身就是证据。
			return { from: name, value: undefined, error: String(error?.message ?? error) };
		}
	};
	return [
		// ① 正解：带点号的完整注册名（免 inject）。
		probe("ctx.get(remote.dshEars)", () => ctx?.get?.("remote.dshEars")),
		probe("ctx.reflect.get(remote.dshEars)", () => ctx?.reflect?.get?.("remote.dshEars")),
		// ② 有些装配把它直接注册成 `dshEars`。
		probe("ctx.get(dshEars)", () => ctx?.get?.("dshEars")),
		// ③ 取到 remote 目录再取属性（宿主已声明 inject 时可用）。
		probe("ctx.remote.dshEars", () => ctx?.remote?.dshEars),
		probe("ctx.get(remote).dshEars", () => ctx?.get?.("remote")?.dshEars),
		// ④ 兜底：换一个取口再试（不同 cordis 版本上 `get` 可能挂在不同位置）。
		probe("ctx.registry.get(remote.dshEars)", () => ctx?.registry?.get?.("remote.dshEars")),
		probe("ctx.root.get(remote.dshEars)", () => ctx?.root?.get?.("remote.dshEars")),
	];
}

/**
 * 这个 ctx 到底长什么样（纯排障）。
 *
 * 为什么需要：`ctx.get("remote.dshEars")` 返回 `undefined` 有两种完全不同的
 * 原因 —— ①压根没有 `get` 这个方法；②有 `get`，但服务还没注册上来
 * （**时序竞争**）。两者都是 `undefined`，光看结果分不出来。
 * 把"有没有这几个口"摊开，才能一眼区分。
 *
 * @param ctx - 客户端 Cordis 上下文。
 * @returns 能力清单。
 */
export function earsContextShape(ctx) {
	const shape = {};
	const flag = (name, read) => {
		try {
			shape[name] = read();
		} catch (error) {
			shape[name] = `error: ${String(error?.message ?? error)}`;
		}
	};
	flag("hasGet", () => typeof ctx?.get === "function");
	flag("hasReflectGet", () => typeof ctx?.reflect?.get === "function");
	flag("hasInject", () => typeof ctx?.inject === "function");
	flag("hasEffect", () => typeof ctx?.effect === "function");
	// 这个 ctx 上已经注册了哪些服务 —— 只看**有没有 ears 相关的名字**，
	// 不要把整张表打出来（真机上表里塞的是 loader 源码，巨大且无用）。
	flag("serviceNames", () => {
		const names = [];
		const bag = ctx?.registry?.store ?? ctx?.registry;
		try {
			if (bag && typeof bag.keys === "function") for (const key of bag.keys()) names.push(String(key));
			else if (bag && typeof bag === "object") for (const key of Object.keys(bag)) names.push(key);
		} catch {
			return "(取不到注册表)";
		}
		if (names.length === 0) return "(取不到注册表)";
		// 只留短名（服务名），长的是被打包器压进来的函数源码。
		const short = names.filter((name) => name.length <= 40);
		return { total: names.length, short: short.slice(0, 60), earsLike: short.filter((name) => /ears|remote/i.test(name)) };
	});
	return shape;
}

/**
 * 列出这个 ctx 上**实际存在**的服务名（纯排障用）。
 *
 * 为什么需要它：命名空间取不到时，"注册名到底是什么"是唯一能定死方向的
 * 事实，而这个事实在真机上**只能实探**（不能靠类型声明猜）。
 * 本项目反复栽在"状态快照查不出方向"上 —— 于是把注册表摊开。
 *
 * @param ctx - 客户端 Cordis 上下文。
 * @returns `{ holders, keys }`：能列出名字的容器，及其中的服务名。
 */
export function earsServiceNames(ctx) {
	const holders = [];
	const collect = (label, value) => {
		if (value === null || value === undefined || typeof value !== "object") return;
		for (const prop of ["registry", "services", "store", "root", "scope"]) {
			try {
				const bag = value[prop];
				if (bag === null || bag === undefined) continue;
				// Map 形态。
				if (typeof bag.keys === "function" && typeof bag.get === "function") {
					const keys = [...bag.keys()].map(String);
					if (keys.length > 0) holders.push({ label: `${label}.${prop}`, keys });
					continue;
				}
				// 朴素对象形态（只取自有键，避免把原型链上的东西当服务）。
				const keys = Object.keys(bag);
				if (keys.length > 0) holders.push({ label: `${label}.${prop}`, keys });
			} catch (error) {
				holders.push({ label: `${label}.${prop}`, error: String(error?.message ?? error) });
			}
		}
	};
	collect("ctx", ctx);
	// cordis 的 ctx 常常是代理，真实内容在符号/内部字段上，尽力而为。
	try {
		for (const symbol of Object.getOwnPropertySymbols(ctx ?? {})) {
			collect(`ctx[${String(symbol)}]`, ctx[symbol]);
		}
	} catch {
		// 取不到就算了。
	}
	return holders;
}

/**
 * 剥掉 typert 的远程信封。
 *
 * @param value - 远程返回值。
 * @returns 业务值。
 * @throws 远程返回 `ok:false` 时抛错（带上游 message）。
 */
function unwrap(value) {
	if (value !== null && typeof value === "object" && "ok" in value) {
		if (value.ok === false) {
			const failure = value.error ?? {};
			throw new Error(String(failure.message ?? failure.code ?? "remote-failed"));
		}
		return value.value;
	}
	return value;
}

/**
 * 把 Blob 编成 base64（不走 btoa，避免大数组爆栈）。
 * @param blob - 音频。
 * @returns 纯 base64（不含 data URI 前缀）。
 */
function blobToBase64(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error("audio-read-failed"));
		reader.onload = () => {
			const result = String(reader.result ?? "");
			const comma = result.indexOf(",");
			resolve(comma >= 0 ? result.slice(comma + 1) : result);
		};
		reader.readAsDataURL(blob);
	});
}

/**
 * 判定某个后端是否需要**浏览器归一化后的 PCM16 WAV**。
 *
 * 逐字对应 `dsh-ears` 客户端的 `prepareRecordedAudioForBackend`：
 *   - `local-whisper` → 一定要 WAV；
 *   - `cloud-openai` 且 provider 是 tencent / mimo / volcengine → 要 WAV
 *     （这三家走"录音文件识别"接口，收 WAV）；
 *   - 其它（groq、deepgram、bailian、siliconflow、custom 等）→ 保持原容器。
 *
 * 为什么**不能一律转 WAV**：WAV 未压缩，15s 片段约 480KB（base64 后 640KB），
 * 而 webm/opus 只有几十 KB。按需转换既省流量也省云端的钱。
 *
 * @param settings - `dshEars.getSettings()` 返回的 `settings` 对象。
 * @returns 是否需要 WAV。
 */
export function needsWavForEars(settings) {
	const backend = String(settings?.asrBackend ?? "");
	if (backend === "local-whisper") return true;
	if (backend !== "cloud-openai") return false;
	const provider = String(settings?.cloudAsrProvider ?? "");
	return provider === "tencent" || provider === "mimo" || provider === "volcengine";
}

/**
 * 读 dsh-ears 当前设置，推出"要不要转 WAV"。
 *
 * 读不到设置时返回 `false`（保持原容器）—— 这是**保守**选择：
 * 现有能用的云端配置不受影响；真要是本地 Whisper 读不到设置，
 * 那 `transcribe` 本身也会失败，不差这一层。
 *
 * @param namespace - dsh-ears 命名空间。
 * @returns 是否需要 WAV。
 */
async function resolveNeedsWav(namespace) {
	if (typeof namespace.getSettings !== "function") return false;
	try {
		const view = unwrap(await namespace.getSettings());
		return needsWavForEars(view?.settings);
	} catch (error) {
		warn("读取 dsh-ears 设置失败，按原容器发送音频", error?.message ?? error);
		return false;
	}
}

/**
 * 探测 dsh-ears 是否可用。
 *
 * @param ctx - 客户端 Cordis 上下文。
 * @returns `{ available, backends, needsWav, paths }`；不可用时 `backends` 为空数组。
 */
export async function probeEars(ctx) {
	// 顺带把"哪条取法通了"记下来：形态不符时只看 `available:false`
	// 完全看不出差在哪（本项目反复踩"状态快照查不出方向"）。
	const paths = earsCandidates(ctx).map(({ from, value, error }) => ({
		from,
		hit: value !== undefined && value !== null,
		hasTranscribe: typeof value?.transcribe === "function",
		...(error === undefined ? {} : { error }),
	}));
	const shape = earsContextShape(ctx);

	// V2.1：先问本插件自己的内置 Whisper（项目自有模型 + vendored native）。
	// 它通就完全不碰 remote.dshEars —— 没装 dsh-ears 也能离线识别。
	try {
		const status = await asrStatus();
		if (status?.whisper?.available === true) {
			return {
				available: true,
				backends: [{ id: "local-whisper", label: `Whisper ${status.whisper.model}`, ready: true }],
				needsWav: true,
				paths: [{ from: "local-asr-api", hit: true, model: status.whisper.model }],
				shape,
				via: "local",
			};
		}
		paths.unshift({ from: "local-asr-api", hit: false, reason: status?.whisper?.reason ?? "unknown" });
	} catch (error) {
		paths.unshift({ from: "local-asr-api", hit: false, reason: String(error?.message ?? error) });
	}

	const namespace = earsNamespace(ctx);
	if (namespace === null) return { available: false, backends: [], needsWav: false, paths, shape, via: "remote" };
	try {
		// 顺带把"要不要转 WAV"问出来：探测本来就只跑一次，
		// 让每次录音都去远程问一遍设置纯属浪费。
		const needsWav = await resolveNeedsWav(namespace);
		if (typeof namespace.listAsrBackends !== "function") {
			// 没有 list 方法但能 transcribe：仍认为可用（版本差异）。
			return { available: true, backends: [], needsWav, paths, shape, via: "remote" };
		}
		const backends = unwrap(await namespace.listAsrBackends());
		const list = Array.isArray(backends) ? backends : [];
		// 只要列表里存在「就绪」的后端就算可用；字段名跨版本可能是 ready / available。
		const ready = list.filter((item) => item?.ready === true || item?.available === true);
		return { available: list.length === 0 ? true : ready.length > 0, backends: list, needsWav, paths, shape, via: "remote" };
	} catch (error) {
		warn("dsh-ears 探测失败，改用浏览器识别", error?.message ?? error);
		return { available: false, backends: [], needsWav: false, paths, shape, via: "remote" };
	}
}

/**
 * 构造一个走 dsh-ears 的 `recognize` 函数。
 *
 * @param ctx - 客户端 Cordis 上下文。
 * @param options - `{ needsWav?, via? }`：`via:'local'` 走本项目内置 Whisper；
 *   `needsWav` 返回"当前后端是否要 WAV"（用户可能中途换后端）。
 * @returns `(blob, language) => Promise<string>`。
 */
export function makeEarsRecognizer(ctx, options = {}) {
	const shouldConvert = options.needsWav ?? (() => false);
	const via = options.via === "local" ? "local" : "remote";
	return async (blob) => {
		// V2.1 内置链：Whisper 只吃 16k 单声道 PCM16 WAV，必须归一化。
		if (via === "local") {
			let payload;
			try {
				payload = (await blobToPcm16Wav(blob)).blob;
			} catch (error) {
				throw new Error(`asr-audio-format: ${error?.message ?? error}`);
			}
			const audioBase64 = await blobToBase64(payload);
			const result = await asrTranscribe("whisper", audioBase64, "zh");
			if (typeof result?.text === "string") return result.text;
			return "";
		}
		const namespace = earsNamespace(ctx);
		if (namespace === null) throw new Error("ears-unavailable");

		// 需要 WAV 时先归一化。失败要**报清楚**是格式这一步出的问题 ——
		// 直接把 webm 发过去只会换来一句没有指向性的 asrAudioInvalid。
		let payload = blob;
		if (shouldConvert()) {
			try {
				payload = (await blobToPcm16Wav(blob)).blob;
			} catch (error) {
				throw new Error(`asr-audio-format: ${error?.message ?? error}`);
			}
		}

		const audioBase64 = await blobToBase64(payload);
		const mimeType = payload.type === "" ? "audio/webm" : payload.type;
		const result = unwrap(await namespace.transcribe(audioBase64, mimeType));
		if (typeof result === "string") return result;
		if (result !== null && typeof result === "object" && typeof result.text === "string") return result.text;
		return "";
	};
}
