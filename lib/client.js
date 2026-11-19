/**
 * dsh-voice-assistant —— 「小凤」语音助手（客户端 bundle，自动生成，请勿手工编辑）
 * 源码见 src/client/，由 build.mjs 从 27 个模块构建。
 */
window.__ModuleLoader__.load({
	id: "dsh-voice-assistant",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const __factories = new Map();
		const __instances = new Map();
		const __loading = new Set();

		/** 登记一个模块工厂（构建期生成，全部登记完再启动）。 */
		function __def(id, factory) {
			__factories.set(id, factory);
		}

		/**
		 * 取一个模块实例。内部 id 走本表，其余（react 等 seed）透传给 bundle 的
		 * require —— 由 DSH 的模块表负责解析。
		 */
		function __req(id) {
			if (!__factories.has(id)) return require(id);
			const hit = __instances.get(id);
			if (hit !== undefined) return hit.exports;
			if (__loading.has(id)) throw new Error("voice-assistant: 模块循环依赖 " + id);
			__loading.add(id);
			const mod = { exports: {} };
			__instances.set(id, mod);
			try {
				__factories.get(id)((patch) => Object.assign(mod.exports, patch), __req);
			} finally {
				__loading.delete(id);
			}
			return mod.exports;
		}

		__def("core/audio/wav.js", (__exports, __req) => {
			/**
			 * 把浏览器录到的音频转成**本地 Whisper 能吃的** 16 kHz 单声道 PCM16 WAV。
			 *
			 * ## 为什么必须有这个文件
			 *
			 * 本地 Whisper 走 whisper.cpp 原生层，它只认一种输入：**16 kHz 单声道
			 * PCM16 WAV**。`dsh-ears` 宿主侧有一道硬校验（`assertPcm16Wav`），
			 * 格式不对直接抛 `asrAudioInvalid`，连推理都不会进。
			 *
			 * 而浏览器 `MediaRecorder` 产出的是 **webm/opus**（压缩容器）。
			 * 两者对不上 —— 于是出现那个最气人的现象：
			 *
			 * > 模型下好了、运行时也正常、设置里选了「本地 Whisper」，
			 * > 一说话却报"音频无效"，且报错文案完全指不到"格式"这件事。
			 *
			 * ## 谁本来该做这件事
			 *
			 * `dsh-ears` **自己的** UI 在做（`prepareRecordedAudioForBackend` →
			 * `normalizeRecordedAudioForLocalWhisper`）。但它只在自己的录音按钮里调，
			 * 远程方法 `transcribe(audioBase64, mimeType)` 收到什么就送什么 ——
			 * 归一化的责任在**调用方**。本插件正是调用方，所以要自己补上。
			 *
			 * ## 实现取舍
			 *
			 * - 用 `AudioContext.decodeAudioData` 解码：浏览器原生、支持 webm/opus，
			 *   不用自己解容器。
			 * - 重采样用**线性插值**（不是丢帧抽取）。丢帧会有混叠噪声，
			 *   Whisper 对这种噪声很敏感，容易编出无关的句子。
			 * - 混单声道走**声道平均**（不是只取左声道）。
			 * - 公式与 `dsh-ears` 的实现保持一致，两边产出逐字节相同 ——
			 *   这样"它自己的录音按钮能用"就能推出"我们的也能用"。
			 */

			/** 本地 Whisper 期望的采样率。 */
			const WHISPER_SAMPLE_RATE = 16000;

			/** 标准 RIFF/WAVE 头长度。 */
			const WAV_HEADER_BYTES = 44;

			/** `data` 块长度字段是 uint32，PCM16 每帧 2 字节 —— 留出头部后的上限。 */
			const MAX_WAV_SAMPLES = Math.floor(4294967251 / 2);

			/** 把有限数以外的样本（NaN/Infinity）当静音。 */
			function finiteSample(value) {
				return Number.isFinite(value) ? value : 0;
			}

			/** 裁到 [-1, 1]，防止溢出的 int16 环绕成刺耳噪声。 */
			function clippedSample(value) {
				if (value <= -1) return -1;
				if (value >= 1) return 1;
				return value;
			}

			/** Float32 样本 → int16。负半轴乘 32768、正半轴乘 32767，与主流实现一致。 */
			function pcm16Sample(value) {
				const clipped = clippedSample(finiteSample(value));
				return clipped < 0 ? Math.round(clipped * 32768) : Math.round(clipped * 32767);
			}

			/**
			 * 把各种"像 AudioBuffer"的输入归一成 `{ sampleRate, channelData, frameCount }`。
			 *
			 * 兼容两种形态：真的 `AudioBuffer`（有 `getChannelData`），以及测试里
			 * 手搓的 `{ sampleRate, channelData }` 对象。这样纯函数可以脱离浏览器测。
			 *
			 * @param input - `AudioBuffer` 或 `{ sampleRate, channelData }`。
			 * @returns 归一化后的音源。
			 */
			function sourceFromInput(input) {
				if (input === null || typeof input !== "object") throw new TypeError("audio-input-invalid");
				const sampleRate = input.sampleRate;
				if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError("audio-sample-rate-invalid");
				if (Array.isArray(input.channelData)) {
					const channelData = input.channelData.map((channel) => (channel instanceof Float32Array ? channel : Float32Array.from(channel ?? [])));
					const frameCount = channelData[0]?.length ?? 0;
					for (const channel of channelData) {
						if (channel.length !== frameCount) throw new RangeError("audio-channels-mismatched");
					}
					return { sampleRate, channelData, frameCount };
				}
				const channels = input.numberOfChannels;
				if (!Number.isSafeInteger(channels) || channels < 0) throw new RangeError("audio-channels-invalid");
				const channelData = [];
				for (let channel = 0; channel < channels; channel += 1) {
					const samples = input.getChannelData(channel);
					if (!(samples instanceof Float32Array)) throw new TypeError("audio-channel-data-invalid");
					channelData.push(samples);
				}
				const frameCount = channelData[0]?.length ?? 0;
				for (const channel of channelData) {
					if (channel.length !== frameCount) throw new RangeError("audio-channels-mismatched");
				}
				if (frameCount !== input.length) throw new RangeError("audio-length-mismatched");
				return { sampleRate, channelData, frameCount };
			}

			/** 取某一帧的**单声道**样本（多声道平均）。 */
			function monoSampleAt(source, frame) {
				const { channelData } = source;
				if (channelData.length === 0) return 0;
				let average = 0;
				for (const channel of channelData) average += finiteSample(channel[frame] ?? 0) / channelData.length;
				return clippedSample(average);
			}

			/** 重采样后的总帧数（四舍五入，至少 1 帧以保留极短片段）。 */
			function whisperFrameCount(source) {
				if (source.frameCount === 0) return 0;
				return Math.max(1, Math.round((source.frameCount * WHISPER_SAMPLE_RATE) / source.sampleRate));
			}

			/**
			 * 线性插值取重采样后的第 `outputFrame` 帧。
			 *
			 * 为什么不是 `source[floor(frame * ratio)]`：抽取会引入混叠，
			 * 说话里的高频摩擦音（s/sh）会变成宽频噪声，Whisper 容易听错。
			 */
			function resampledSampleAt(source, outputFrame, outputFrameCount) {
				if (source.frameCount === 0) return 0;
				if (outputFrameCount <= 1) return monoSampleAt(source, 0);
				const position = (outputFrame * (source.frameCount - 1)) / (outputFrameCount - 1);
				const lower = Math.floor(position);
				const upper = Math.min(lower + 1, source.frameCount - 1);
				const fraction = position - lower;
				const lowerValue = monoSampleAt(source, lower);
				if (upper === lower) return lowerValue;
				return lowerValue + (monoSampleAt(source, upper) - lowerValue) * fraction;
			}

			/** 往 DataView 里写 ASCII（避免 `String.fromCharCode` 与编码歧义）。 */
			function writeAscii(view, offset, value) {
				for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
			}

			/** 写 44 字节标准 RIFF/WAVE 头（PCM、单声道、16 bit）。 */
			function writeWavHeader(view, sampleRate, sampleCount) {
				const dataBytes = sampleCount * 2;
				writeAscii(view, 0, "RIFF");
				view.setUint32(4, 36 + dataBytes, true);
				writeAscii(view, 8, "WAVE");
				writeAscii(view, 12, "fmt ");
				view.setUint32(16, 16, true); // fmt 块长度
				view.setUint16(20, 1, true); // 1 = PCM
				view.setUint16(22, 1, true); // 单声道
				view.setUint32(24, sampleRate, true);
				view.setUint32(28, sampleRate * 2, true); // 字节率
				view.setUint16(32, 2, true); // 块对齐
				view.setUint16(34, 16, true); // 位深
				writeAscii(view, 36, "data");
				view.setUint32(40, dataBytes, true);
			}

			/**
			 * `AudioBuffer`（或等价的声道数组）→ 16 kHz 单声道 PCM16 WAV。
			 *
			 * @param input - `AudioBuffer` 或 `{ sampleRate, channelData }`。
			 * @returns WAV 字节。
			 */
			function audioToPcm16Wav(input) {
				const source = sourceFromInput(input);
				const outputFrameCount = whisperFrameCount(source);
				if (!Number.isSafeInteger(outputFrameCount) || outputFrameCount < 0 || outputFrameCount > MAX_WAV_SAMPLES) {
					throw new RangeError("audio-too-large");
				}
				const wav = new Uint8Array(WAV_HEADER_BYTES + outputFrameCount * 2);
				const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
				writeWavHeader(view, WHISPER_SAMPLE_RATE, outputFrameCount);
				for (let frame = 0; frame < outputFrameCount; frame += 1) {
					view.setInt16(WAV_HEADER_BYTES + frame * 2, pcm16Sample(resampledSampleAt(source, frame, outputFrameCount)), true);
				}
				return wav;
			}

			/**
			 * 校验字节是不是**宿主侧会接受**的那种 WAV。
			 *
			 * 这份判定是 `dsh-ears` 宿主侧 `isPcm16Mono16kWav` 的忠实复刻。
			 * 本地留一份的目的：编码出错时能**在这里**就报出来，
			 * 而不是等一个远程调用回一句看不懂的 `asrAudioInvalid`。
			 *
			 * @param bytes - WAV 字节。
			 * @returns 是否通过。
			 */
			function isPcm16Mono16kWav(bytes) {
				if (!(bytes instanceof Uint8Array) || bytes.byteLength < WAV_HEADER_BYTES) return false;
				if (String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF") return false;
				if (String.fromCharCode(...bytes.subarray(8, 12)) !== "WAVE") return false;
				const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
				let offset = 12;
				let validFormat = false;
				let hasData = false;
				while (offset + 8 <= bytes.byteLength) {
					const chunk = String.fromCharCode(...bytes.subarray(offset, offset + 4));
					const size = view.getUint32(offset + 4, true);
					const body = offset + 8;
					if (body + size > bytes.byteLength) return false;
					if (chunk === "fmt " && size >= 16) {
						validFormat =
							view.getUint16(body, true) === 1 &&
							view.getUint16(body + 2, true) === 1 &&
							view.getUint32(body + 4, true) === WHISPER_SAMPLE_RATE &&
							view.getUint16(body + 14, true) === 16;
					}
					if (chunk === "data" && size > 0) hasData = true;
					offset = body + size + (size % 2);
				}
				return validFormat && hasData;
			}

			/**
			 * Blob → 16 kHz 单声道 PCM16 WAV Blob。
			 *
			 * @param blob - 浏览器录到的音频（通常是 webm/opus）。
			 * @param options - `{ createAudioContext? }`，测试可注入假上下文。
			 * @returns `{ blob, mimeType }`；`mimeType` 恒为 `audio/wav`。
			 */
			async function blobToPcm16Wav(blob, options = {}) {
				const create = options.createAudioContext ?? createBrowserAudioContext;
				const context = create();
				try {
					const decoded = await context.decodeAudioData(await blob.arrayBuffer());
					const wav = audioToPcm16Wav(decoded);
					return { blob: new Blob([wav], { type: "audio/wav" }), mimeType: "audio/wav", bytes: wav };
				} finally {
					try {
						await context.close?.();
					} catch {
						// 关不掉就算了，不能因此让识别失败。
					}
				}
			}

			/** 造一个浏览器 `AudioContext`（本地解码要用真的）。 */
			function createBrowserAudioContext() {
				const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
				if (Ctor === undefined) throw new Error("audio-decoding-unavailable");
				return new Ctor();
			}

			__exports({ WHISPER_SAMPLE_RATE, audioToPcm16Wav, isPcm16Mono16kWav, blobToPcm16Wav, createBrowserAudioContext });
		});

		__def("core/chime.js", (__exports, __req) => {
			/**
			 * 提示音（WebAudio 合成）。
			 *
			 * ## 为什么不用音频文件
			 *
			 * 三个理由：
			 *   1. 插件包里多两个 wav 就要多两条静态路由，多两层缓存与 404 的可能；
			 *   2. 提示音需要**极短延迟**（唤醒要"喊完就响"），合成比加载快；
			 *   3. 可以按状态微调音高，不必为每种状态备一个文件。
			 *
			 * 合成参数是刻意的：唤醒用**上行**两个音（880→1320Hz，像"叮咚"向上），
			 * 休眠用**下行**（660→440Hz），错误用低音短促。人耳对上行/下行的
			 * 方向感知非常稳定，闭着眼也能分清"被听到了"和"睡过去了"。
			 */

			/** 单例 AudioContext。浏览器限制同时存在的 AudioContext 数量，复用即可。 */
			let context = null;

			/**
			 * 取（或创建）AudioContext。
			 *
			 * 浏览器的自动播放策略要求 AudioContext 在**用户手势**之后才能出声。
			 * 这里只创建不解锁；解锁交给第一次点击（`unlockAudio`）。
			 *
			 * @returns AudioContext 或 `null`（环境不支持时）。
			 */
			function ensureContext() {
				if (context !== null) return context;
				const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
				if (typeof Ctor !== "function") return null;
				try {
					context = new Ctor();
				} catch {
					return null;
				}
				return context;
			}

			/**
			 * 解锁音频（必须在用户手势的同步调用栈里执行）。
			 * @returns 是否成功进入 running 状态。
			 */
			function unlockAudio() {
				const ctx = ensureContext();
				if (ctx === null) return false;
				if (ctx.state === "suspended" && typeof ctx.resume === "function") {
					ctx.resume().catch(() => {
						// 某些浏览器在没有手势时 resume 会 reject，忽略即可。
					});
				}
				return true;
			}

			/**
			 * 播放一个音。
			 *
			 * @param ctx - AudioContext。
			 * @param frequency - 起始频率（Hz）。
			 * @param startAt - 相对当前时间的起始秒数。
			 * @param duration - 持续秒数。
			 * @param peak - 峰值增益（0–1）。
			 * @param endFrequency - 结束频率（用于滑音）。
			 */
			function tone(ctx, frequency, startAt, duration, peak, endFrequency) {
				const oscillator = ctx.createOscillator();
				const gain = ctx.createGain();
				oscillator.type = "sine";
				const t0 = ctx.currentTime + startAt;
				oscillator.frequency.setValueAtTime(frequency, t0);
				if (typeof endFrequency === "number") {
					oscillator.frequency.exponentialRampToValueAtTime(Math.max(40, endFrequency), t0 + duration);
				}
				// 指数包络：起音 15ms、衰减到近似 0，避免爆音（矩形包络会有"咔"声）。
				gain.gain.setValueAtTime(0.0001, t0);
				gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.015);
				gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
				oscillator.connect(gain).connect(ctx.destination);
				oscillator.start(t0);
				oscillator.stop(t0 + duration + 0.02);
			}

			/** 各类提示音的参数表。 */
			const TONES = {
				/** 唤醒：上行两音。 */
				wake: [
					{ frequency: 880, startAt: 0, duration: 0.1, peak: 0.16 },
					{ frequency: 1320, startAt: 0.1, duration: 0.16, peak: 0.14 },
				],
				/** 休眠：下行两音，更轻。 */
				sleep: [
					{ frequency: 660, startAt: 0, duration: 0.12, peak: 0.12 },
					{ frequency: 440, startAt: 0.12, duration: 0.2, peak: 0.1 },
				],
				/** 收到：单音，用于"已进入待机/已提交"。 */
				ack: [{ frequency: 1046, startAt: 0, duration: 0.08, peak: 0.1 }],
				/** 错误：低音短促下滑。 */
				error: [{ frequency: 320, startAt: 0, duration: 0.22, peak: 0.14, endFrequency: 180 }],
			};

			/**
			 * 播放提示音。
			 *
			 * @param kind - `wake` | `sleep` | `ack` | `error`。
			 * @returns 是否真的播了（音频不可用时返回 false，调用方不必处理）。
			 */
			function playChime(kind) {
				const ctx = ensureContext();
				if (ctx === null) return false;
				if (ctx.state === "suspended") {
					ctx.resume().catch(() => {});
				}
				const tones = TONES[kind] ?? TONES.ack;
				try {
					for (const toneSpec of tones) {
						tone(ctx, toneSpec.frequency, toneSpec.startAt, toneSpec.duration, toneSpec.peak, toneSpec.endFrequency);
					}
					return true;
				} catch {
					return false;
				}
			}

			__exports({ unlockAudio, playChime });
		});

		__def("core/constants.js", (__exports, __req) => {
			/**
			 * 常量与状态词表。
			 *
			 * 单独成文件的原因：状态名同时被状态机、UI 文案、日志三处消费。
			 * 散着写字面量，改名时必然漏一处（表现为日志说 `awake`、界面显示 `active`，
			 * 排查时对不上号）。
			 */

			/** 本机 API 前缀，必须与宿主半 `lib/routes.js` 的 `API_PREFIX` 一致。 */
			const API_PREFIX = "/plugins/dsh-voice-assistant/api";

			/** 六态状态机。 */
			const STATES = {
				/** 未启用：没有申请麦克风，没有识别，也不占音频设备。 */
				OFF: "off",
				/** 待机：麦克风常开，只等唤醒词。这是"一直在线"的状态。 */
				STANDBY: "standby",
				/** 已唤醒：正在听这一轮指令。 */
				ACTIVE: "active",
				/** 思考中：指令已进会话，等 agent 回话。 */
				THINKING: "thinking",
				/** 播报中：正在念回答。 */
				SPEAKING: "speaking",
				/** 休眠：麦克风已释放，只能靠点击/提示音/agent 消息唤醒。 */
				SLEEPING: "sleeping",
			};

			/** 界面文案（中文，直接显示）。 */
			const STATE_LABEL = {
				[STATES.OFF]: "未启用",
				[STATES.STANDBY]: "待机中",
				[STATES.ACTIVE]: "正在听",
				[STATES.THINKING]: "思考中",
				[STATES.SPEAKING]: "播报中",
				[STATES.SLEEPING]: "休眠",
			};

			/** 状态 → 语音球主色（与 accent 叠加，不改用户设的强调色）。 */
			const STATE_TONE = {
				[STATES.OFF]: "muted",
				[STATES.STANDBY]: "calm",
				[STATES.ACTIVE]: "live",
				[STATES.THINKING]: "work",
				[STATES.SPEAKING]: "speak",
				[STATES.SLEEPING]: "sleep",
			};

			/**
			 * 事件名。
			 *
			 * 用 `动词` 而不是 `状态` 命名：`wake` 而不是 `awake`、`reply` 而不是 `replied`。
			 * 状态机处理的是"发生了什么"，不是"现在是什么" —— 后者会把推断逻辑
			 * 从状态机里漏到调用方。
			 */
			const EVENTS = {
				START: "start",
				STOP: "stop",
				WAKE: "wake",
				COMMAND: "command",
				THINKING: "thinking",
				REPLY: "reply",
				SPEAK_END: "speak-end",
				AGENT_MESSAGE: "agent-message",
				IDLE: "idle",
				SLEEP: "sleep",
				ERROR: "error",
				RESUME: "resume",
			};

			/**
			 * 识别器把连续语音切成**片段**所需的静音时长（毫秒）。
			 *
			 * 注意这是**引擎内部的切段粒度**，不是"一轮说完了"的判据 ——
			 * 片段会被上层（`controller`）累加成整轮，见 `SILENCE_SUBMIT_MS`。
			 *
			 * 为什么引擎还要切：Web Speech 会因静默自动结束会话、VAD 段太长会拉高
			 * 转写延迟；切成小段可以让字幕实时出现、让转写尽早开始。
			 * 这个值**越小**，"一轮结束"的判定越贴近 `SILENCE_SUBMIT_MS`
			 * （总延迟 ≈ 本值 + `SILENCE_SUBMIT_MS`），所以保持得比较短。
			 */
			const UTTERANCE_SETTLE_MS = 900;

			/**
			 * 判定"这一轮说完了"所需的静音时长（毫秒），默认 **10 秒**。
			 *
			 * ## 为什么不能贴着引擎的切段粒度
			 *
			 * 旧设计把"引擎切段"直接当成了"一轮说完了"：900ms（网页识别）/ 700ms（VAD）
			 * 静音就提交。这对**打字**够用，对**说话**完全不够 —— 人表达一段完整意图时，
			 * 句中的停顿（想词、换气、列举）轻松超过 1 秒。结果助手在用户说到一半时
			 * 就把半句话提交上去，用户看到的是"它只回了我前半句"。
			 *
			 * 现在的语义：**声音停止超过 10 秒才算一轮结束**。
			 * 中途转录照常累积、界面照常显示，只是**不提交**。
			 *
			 * ## 为什么是 10 秒
			 *
			 * 这个值要同时满足两个方向的要求，是个**折中**：
			 *   - 下界由"人说话的自然停顿"决定：想词、换气、列举都能到 2–5 秒，
			 *     所以必须**明显大于**这个量级，否则回到"半句被截"。
			 *   - 上界由"等待是否像卡死"决定：数值越大越不会打断用户，
			 *     但每轮都要多等这么久才得到回应。10 秒是"够忍、不算久"的平衡点。
			 *
			 * 历史：最初按需求设成 60 秒（宁可多等也不截半句），实测体验是
			 * 「说完要干等一分钟」——对交互来说太长，故收到 10 秒。两者都在合法区间内
			 * （下限 3s / 上限 10min），想再调改 `cordis.patch.yml` 的 `turn.silenceMs`。
			 *
			 * ## 逃生口
			 *
			 * 不必干等：单击语音球（`controller.primaryAction`）＝「我说完了，现在提交」。
			 *
			 * 唤醒词判定**不受**它影响：走的是中间结果（`handlePartial`），
			 * 喊「小凤」依旧实时响应，否则用户会以为喊不动。
			 */
			const SILENCE_SUBMIT_MS = 10000;

			/**
			 * 播报结束后，重新打开麦克风前的保护间隔（毫秒）。
			 *
			 * `speechSynthesis` / `HTMLAudio` 的 `onend` 可能在**音频真正放完**之前就触发
			 * （外放设备还有余响）。若此时立刻重开麦克风，助手会把自己刚念的尾音录回去、
			 * 当成用户的新指令提交 —— 这正是"自说自话"闭环的声学入口。
			 * 留一段静默再开麦，从物理上切断这条回路。
			 *
			 * 取值权衡：太短挡不住余响，太长会吃掉用户抢答的第一个词。
			 * 700ms 约等于典型房间混响 + 一句短词的时长。
			 */
			const ECHO_GUARD_MS = 700;

			/**
			 * "回声"比对的回溯窗口（毫秒）。
			 *
			 * 只把手动/播报说过的文本在近一段时间内视为可能的回声来源；
			 * 太久以前说过的话不该再挡住用户的新指令（用户完全可能重复同一个词）。
			 */
			const ECHO_WINDOW_MS = 30000;

			/**
			 * 单轮累积的硬上限（毫秒）。
			 *
			 * 判据是"静音满 `SILENCE_SUBMIT_MS` 才算说完"，那么**连续不断**说话就永远
			 * 不会触发提交：用户唠 10 分钟，累积文本会无限膨胀，最后把模型的上下文撑爆。
			 * 这是纯逻辑上的缺陷，不是用户意图，所以加一道安全阀：到点无论如何提交一次。
			 * 取 5 分钟 —— 长到不会打断任何正常表达，短到能兜住极端情况。
			 */
			const MAX_TURN_MS = 300000;

			/** 唤醒后，如果一句话都没听到，多久回到待机（避免一直"正在听"却不回应）。 */
			const WAKE_GRACE_MS = 12000;

			/** 播报分句长度上限：过长的句子会一次性占满 TTS 队列，打断响应变慢。 */
			const SPEECH_CHUNK_MAX = 80;

			__exports({ API_PREFIX, STATES, STATE_LABEL, STATE_TONE, EVENTS, UTTERANCE_SETTLE_MS, SILENCE_SUBMIT_MS, ECHO_GUARD_MS, ECHO_WINDOW_MS, MAX_TURN_MS, WAKE_GRACE_MS, SPEECH_CHUNK_MAX });
		});

		__def("core/controller.js", (__exports, __req) => {
			/**
			 * 语音控制器：把状态机、识别引擎、播报器、会话桥接成一条闭环。
			 *
			 * ## 一条指令的完整生命周期
			 *
			 * ```
			 * 待机 ──「小凤」──▶ 已唤醒（提示音）
			 *                     │
			 *                     ├─ 听到指令 ─▶ 润色(宿主) ─▶ 写入会话 ─▶ 思考中
			 *                     │                                        │
			 *                     └─ 12s 无话 ─▶ 待机                       ▼
			 *                                                          播报中（麦克风关闭）
			 *                                                              │
			 *                                            播完 ─▶ 正在听（接着能说，不必再唤醒）
			 *                                                              │
			 *                                                    60s 无语音 ─▶ 休眠
			 * ```
			 *
			 * 注意**播报不归"思考"**：`thinking` 是"指令已进会话、等 agent 回话"，
			 * 一旦有回答落地就转 `speaking`。播完落到 `active` —— 助手说完就直接进入
			 * 可续话的听写态，用户接着说话即可（含"不对，我是说…"这类纠正）。
			 * 收尾交给 `active` 里的**休眠计时**（默认 60s 无语音）：这样"播报完没有
			 * 语音输入 60 秒才休眠"这条需求才成立。
			 *
			 * 历史：播完曾经落到 `standby`，而 `standby` **不参与**休眠计时 ——
			 * 于是每答完一轮都得重新喊「小凤」，多轮对话被硬切成一句一唤醒。
			 * 见 `machine.js` 顶部对这一格的长注释。
			 *
			 * 休眠期间唯一的入向信号是**会话事件**：agent 跑完一轮（`turn/end`）就播报，
			 * 实现需求 5 的"被 agent 消息唤醒后播报"。这一点不依赖麦克风，
			 * 所以休眠真的可以关掉音频设备。
			 *
			 * V1.3 起多一条入向信号：**worker 汇报**。小凤路由到专家后留在根会话，只把
			 * 任务交给 `/delegate`；专家完成后由宿主汇总要点入队，客户端经 `/reports`
			 * 按完成先后逐条播报。全过程不切会话、不旁听中间输出。
			 *
			 * ## 三个必须守住的约束
			 *
			 * 1. **播报时关麦**。不关的话，TTS 的声音会被自己识别回去，
			 *    形成"自问自答"的死循环 —— 这是语音助手最经典的翻车方式。
			 * 2. **每次开口都重置休眠计时**。否则用户连续对话到第 59 秒，
			 *    助手会在对方说到一半时睡过去。
			 * 3. **late result 必须丢弃**。识别是流式的，回调可能在状态已切换
			 *    （例如已进入 thinking）之后才到达；用 `epoch` 计数丢弃跨代结果，
			 *    否则会出现"上一句被当成新指令又发一遍"。
			 */
			const { EVENTS, STATES, STATE_LABEL, WAKE_GRACE_MS, ECHO_GUARD_MS, SILENCE_SUBMIT_MS } = __req("core/constants.js");
			const { VoiceMachine } = __req("core/machine.js");
			const { findWake } = __req("core/wakeword.js");
			const { Speaker } = __req("core/tts.js");
			const { VoiceSession } = __req("core/session.js");
			const { TurnGate } = __req("core/turn.js");
			const { EchoGuard } = __req("core/echo.js");
			const { QuestionBridge, matchAnswer, speakQuestion } = __req("core/questions.js");
			const { playChime, unlockAudio } = __req("core/chime.js");
			const { createPlaybackLedger, createSeqWatermark, withinCatchup } = __req("core/ledger.js");
			const { polish, route, delegate, reports: fetchReports, interactions: fetchInteractions, listExperts, addExpert, removeExpert, log, warn } = __req("core/runtime.js");
			const { parseExpertCommand, formatCommandSpeech } = __req("core/expert-commands.js");
			const { WebSpeechEngine, isAvailable: webSpeechAvailable } = __req("core/engines/webspeech.js");
			const { HttpAsrEngine, isAvailable: httpAsrAvailable } = __req("core/engines/http.js");
			const { makeEarsRecognizer, probeEars } = __req("core/engines/ears.js");

			/** 通知在界面上停留的时长（毫秒）。 */
			const NOTICE_TTL_MS = 4200;

			/** 语音历史保留条数（HUD 只显示最近几条）。 */
			const HISTORY_LIMIT = 4;

			/** 语音控制器。 */
			class VoiceController {
				/**
				 * @param options - `{ ctx, config, fromHost }`。
				 */
				constructor(options) {
					this.ctx = options.ctx;
					this.config = options.config;
					this.fromHost = options.fromHost === true;

					this.machine = new VoiceMachine(STATES.OFF);
					this.listeners = new Set();
					this.generation = 0;

					this.snapshot = {
						status: STATES.OFF,
						label: STATE_LABEL[STATES.OFF],
						partial: "",
						heard: "",
						answer: "",
						notice: "",
						noticeKind: "info",
						history: [],
						powered: false,
						engine: this.pickEngineName(),
						sessionId: null,
						polishVia: "",
						/** 两层架构：本条指令路由给了哪位 worker（空 = 未路由/路由失败）。 */
						routedWorker: "",
						routeVia: "",
						/**
						 * V1.3 委托汇报 / 需求④互动：当前已派给 worker、还在后台执行的任务数（界面显示"处理中"）。
						 */
						pendingDelegations: 0,
						/** 最近一条互动播报（HUD 显示用；三类共用这一条摘要）。 */
						lastReport: "",
						/** 最近一条互动的类型（`approval` / `question` / `report`；空 = 还没有）。 */
						lastInteractionKind: "",
						error: "",
						/** 已攒下、尚未提交的整轮发言（界面显示"听到（待提交）"）。 */
						pending: "",
						/** 本次静音计时的截止时刻（毫秒时间戳），`null` = 没有在计。 */
						pendingDueAt: null,
						/**
						 * 语音指令当前会进哪个会话（跨会话功能的唯一关键信息）。
						 *
						 * 为什么入快照而不是让 UI 现算：`describe()` 要读会话投影并做
						 * 标题查找，每次渲染都调一遍纯属浪费；而且切换后必须**主动**
						 * 推一次，UI 才知道要重渲染。跟着 `patch()` 走天然有这两点。
						 */
						sessionTarget: { mode: "", label: "尚未建立", id: null },
						/**
						 * 当前正等着用户语音作答的问题（没有则为 `null`）。
						 *
						 * 形状 `{ callId, state, spoken, questions }`：
						 *   - `state` 为 `open` / `continued`；只有 `continued` 能语音作答
						 *     （`open` 期界面问题卡还在，用户能直接点）；
						 *   - `spoken` 是念出来的那句原文，界面显示用（用户不一定听清）。
						 *
						 * 为什么入快照而不是让 UI 现算：问答桥是**回调驱动**的，
						 * UI 只有拿到一次推送才知道"现在有条问题在等答"。
						 */
						question: null,
					};

					/**
					 * 播报账本（需求②）：持久化"已播到哪个时间点" + "哪些内容播过了"。
					 *
					 * ## 为什么必须有它
					 *
					 * 刷新页面会把内存里的水位全部清零，而服务端队列活在宿主进程里
					 * 不受刷新影响 —— 两条合起来就是"用户每刷新一次，就再听一遍旧汇报"。
					 *
					 * 账本做两件事：
					 *   1. 记住毫秒水位（`cursor`），刷新后从它续上，不再靠 `latest` 猜；
					 *   2. 记住已播内容的身份（`kind:key`），同一条**无论走哪条通道、
					 *      被投递几次，一辈子只播一次**（这是兜底，比水位更硬）。
					 *
					 * 作用域按常驻会话 id 隔离：多个 DSH 实例共用同一个 origin 时，
					 * 各自的账本不会互相污染。
					 *
					 * **必须在 `questions` / `session` 之前建好**：提问旁听桥要拿它做
					 * "这个问题念过没有"的跨刷新判定。晚一步就是 `undefined`。
					 */
					this.ledger = createPlaybackLedger({ scope: this.config.agent?.sessionId ?? "default" });
					/**
					 * 会话 `seq` 水位（需求②的另一半）。
					 *
					 * 会话事件的去重靠 `seq`，而 `seq` 原先只在内存。刷新时代价是
					 * "窗口为空 → 水位 −1 → 历史整批灌入"，只剩时间地板兜着；
					 * 而时间地板对**没有 `time` 字段的事件**是放行的。
					 * `seq` 是单调整数、天生跨刷新可比，比时间戳硬得多。
					 */
					this.seqWatermark = createSeqWatermark();

					// ── 轮次门槛与回声抑制 ──────────────────────────────────────────
					//
					// 必须在 `engine` / `speaker` / `session` **之前**建好：它们注册的
					// 回调（识别结果、播报结束、会话事件）都可能同步触发状态迁移，
					// 而迁移处理里会用到这两个对象。晚建一步就是"偶发未定义"。
					//
					// 识别引擎给的是**片段**（900ms / 700ms 静音就切一段），片段不等于
					// "用户说完了"。要求是「声音停止足够久才算一轮」，所以中间加一道
					// 门槛：片段先攒着，静音到点（或手动 / 硬上限）才提交一次。
					// 中途文本照常显示在界面上，只是不提交。
					const turn = this.config.turn ?? {};
					this.turnGate = new TurnGate({
						silenceMs: Number.isFinite(turn.silenceMs) ? turn.silenceMs : SILENCE_SUBMIT_MS,
						maxTurnMs: turn.maxTurnMs,
						onCommit: (payload) => this.handleTurnCommit(payload),
					});

					// 播报时关麦只覆盖"播报期间"，而回声常出现在 `onend` 之后的那几百
					// 毫秒里。再补一道文本级防线：识别到的话若就是助手刚说的，丢掉。
					this.echoGuard = new EchoGuard();

					this.engine = this.createEngine();
					this.speaker = new Speaker({
						getConfig: () => this.config,
						onChunk: (chunk) => {
							// 播报中的当前句显示在 HUD 上，用户能对上"现在念到哪"。
							this.patch({ partial: chunk });
						},
					});

					// ── 提问旁听（只做「模型提问」，不碰「工具审批」）─────────────────
					//
					// 必须在 `session` **之前**建好：`VoiceSession` 绑定成功后会在
					// `onStatus` 里回调，而那里要把 binding 交给问答桥接投影；同时
					// 会话桥的事件回调（`onQuestionCall`）也直接打到桥上。
					//
					// 为什么不注册应答者：DSH 的 `approval/request` / `user-questions/request`
					// 是 waterfall，官方 README 明说「同级监听器顺序**不是**策略优先级机制」
					// —— 并列注册无法保证排在官方 UI 之后，一旦提前就会把本该显示在界面上的
					// 问题抢走。详见 questions.js 顶部的长注释。
					//
					// 所以这里只**旁听**：主路径是原始事件流的 `tool/call`（不受 `timed`
					// 闸门限制），辅以 `userQuestions` 投影拿权威 state；作答走
					// `remote.userQuestions.answer` 的 `continued` 通道。
					this.questions = new QuestionBridge({
						ctx: this.ctx,
						// 需求②：提问播报也走同一份持久账本，否则「刷新后投影重放同一个
						// active 问题」会再念一遍（`announced` 是内存态）。共用一份账本
						// 还有个好处：身份空间按下述前缀区分（`question:` / `report:` /
						// 审批 id），不会互相顶掉。
						ledger: this.ledger,
						onQuestion: (payload) => this.handleQuestion(payload),
						onResolved: () => this.patch({ question: null }),
						log: (message) => log(message),
						warn: (message, detail) => warn(message, detail),
					});

					this.session = new VoiceSession({
						ctx: this.ctx,
						config: this.config,
						// 需求②：把会话 seq 水位也落持久化（刷新后不再靠时间戳猜历史）。
						seqWatermark: this.seqWatermark,
						onTurnStart: () => this.handleTurnStart(),
						onTurnEnd: (payload) => this.handleTurnEnd(payload),
						// 提问旁听**主路径**：原始事件流的 `tool/call`。
						// 之所以从这里接而不是只订阅投影：投影对 legacy 模式恒空
						// （`projection.js` 的 `if (!fold.timed) return fold`），
						// 而本机默认就是 legacy。详见 questions.js 顶部。
						onQuestionCall: (event) => this.questions.observeEvent(event),
						onStatus: (event) => {
							if (event?.kind === "session-ready") this.patch({ sessionId: event.sessionId });
							// 会话换绑（切换/新建/回常驻）都要刷新"现在说的话进哪儿"。
							// 放在 onStatus 里而不是各调用点：`session.js` 是所有换绑路径的
							// 唯一出口，在这里同步一次就不会漏（漏了的表现是面板显示的还是
							// 上一个会话，用户照着界面判断就会搞错目标）。
							if (
								event?.kind === "session-ready" ||
								event?.kind === "session-switched" ||
								event?.kind === "session-created"
							) {
								this.patch({ sessionTarget: this.session.describe() });
								// 问答桥的投影是**按会话**的：换会话必须换绑定，否则会念出
								// 上一个会话的问题（那个会话的用户根本没在等这条）。
								this.attachQuestions();
							}
						},
						onError: (error) => this.fail(error),
					});

					this.idleTimer = null;
					this.noticeTimer = null;
					this.echoTimer = null;
					this.disposed = false;
					/**
					 * 需求④统一互动流：审批 / 提问 / 汇报按 `at`（发生时间）排队，逐条播报。
					 *
					 * `interactionCursor` 是服务端的 monotonic 时间戳游标：首帧传
					 * `"latest"` 只同步不重放；之后只取 `at > cursor` 的新条目。
					 */
					this.interactionCursor = undefined;
					this.interactionQueue = [];
					this.interactionDraining = false;
					/**
					 * 统一互动流是否可用。
					 *
					 * 初始 `false`：`pollReports` 据此决定要不要走**旧的 `/reports` 口径**
					 * （老宿主没有 `/interactions`）。第一次成功拉到互动流就置真，此后
					 * `/reports` 完全不再播报 —— 否则宿主同时写两条流会造成同一条念两遍。
					 */
					this.interactionsAvailable = false;
					/** 旧的 `/reports` 游标（仅在统一流不可用时使用）。 */
					this.reportCursor = undefined;
					this.reportTimer = null;
					this.lastReportText = "";
					/**
					 * 是否已经跟服务端对齐过水位（首帧 `latest`）。
					 *
					 * 只对齐一次：之后靠**持久化账本**续上（见下），而不是每次启动
					 * 都退回到 `latest` —— 那正是"重开又播一遍"的成因之一。
					 */
					this.cursorSeeded = false;
					/**
					 * 在这台机器上**已确认不可用**的引擎名。
					 *
					 * 为什么需要这个集合：`engineUsable()` 只能测"浏览器有没有这个 API /
					 * 有没有填端点"，测不出"服务端到底通不通"。浏览器识别恰恰是"API 在、
					 * 服务不通"的典型（它依赖境外云端）。踩过一次的坑不该踩第二次 ——
					 * 记录在案，回退时跳过。
					 */
					this.deadEngines = new Set();
					/**
					 * `detectEars()` 的探测结论（`null` = 还没探过）。
					 *
					 * 记下来是因为回退时需要一个**确定的**答案：`ears` 能不能用无法靠
					 * 本地判据得出（要打一次远程），而"未探过"与"探过、不可用"必须分开 ——
					 * 前者可以试，后者不该再试。
					 */
					this.earsAvailable = null;
					/**
					 * dsh-ears 当前后端是否要求**浏览器归一化后的 16 kHz PCM16 WAV**。
					 *
					 * 本地 Whisper 与腾讯/小米/火山三家的"录音文件识别"只吃 WAV，
					 * 而 `MediaRecorder` 产出的是 webm/opus。归一化的责任在**调用方**
					 * （`dsh-ears` 只在自己的录音按钮里做），所以本插件必须自己补。
					 * 具体判定见 `engines/ears.js` 的 `needsWavForEars()`。
					 *
					 * 存成字段而不是每次问远程：探测只跑一次，录音却每段都发生。
					 */
					this.earsNeedsWav = false;
					/** `detectEars()` 探到的后端清单（只读证据，供真机断言"哪家可用"）。 */
					this.earsBackends = [];
					/**
					 * `dsh-ears` 命名空间各条取法的命中情况（只读排障证据）。
					 *
					 * 为什么必须留：命名空间取不到时，`available:false` 这一个布尔
					 * **完全指不出方向** —— 是没装插件？还是装了但注册名不同？
					 * 还是被 cordis 的 inject 代理拦了？本项目反复栽在
					 * "状态快照查不出方向"上，所以把每条路径的命中情况摊开。
					 */
					this.earsPaths = [];
					/** ctx 的能力清单（排障"取不到命名空间"到底是没口、还是服务没上来"）。 */
					this.earsShape = null;
					/**
					 * 是否处于"刚唤醒、还没听到第一句话"。
					 *
					 * 决定 `armIdle()` 用哪个时限：等第一句用 `WAKE_GRACE_MS`（短），
					 * 对话中途用 `sleep.idleTimeoutMs`（长）。不能用"上一轮听到过什么"
					 * 来判断 —— 那个字段在上一轮结束时不清理，会把新唤醒误判成对话中途。
					 */
					this.awaitingFirstUtterance = false;
					/** 最近几次错误的调用来源（排障"念出来了却又报错"这种矛盾态）。 */
					this.failLog = [];
					/**
					 * 最近一次"把识别文本当回答"的判定（排障"为什么没答上"）。
					 *
					 * `tryAnswerQuestion()` 只返回布尔，于是**"没匹配上"与"匹配了但提交被拒"
					 * 在真机上看起来一模一样** —— 本项目反复踩这个坑（状态快照查不出方向）。
					 * 把判定摊成只读字段，真机冒烟就能断言到底断在哪一层。
					 */
					this.lastAnswerAttempt = null;

					this.machine.subscribe((to, from, event) => this.onTransition(to, from, event));

					// 异步探测 dsh-ears：可用就把识别后端交给它（复用本地 Whisper /
					// Groq / 阿里云 / 腾讯云等 8 个后端），不可用就保持浏览器识别。
					// 不 await：首帧必须立刻可渲染。
					this.detectEars().catch((error) => warn("dsh-ears 探测异常", error?.message ?? error));
					// 首探**极可能太早**（本插件 apply 早于 dsh-ears 挂服务，见 `watchEars`），
					// 所以必须挂一条"服务就位就接上"的路，否则本地 Whisper 配了也用不上。
					this.watchEars().catch((error) => warn("dsh-ears 就位等待异常", error?.message ?? error));
				}

				/** ── 对外只读状态 ─────────────────────────────────────────────── */

				/** 取当前快照（供 `useSyncExternalStore` 使用，引用稳定）。 */
				getSnapshot() {
					return this.snapshot;
				}

				/**
				 * 订阅状态变化。
				 * @param listener - 无参回调。
				 * @returns 取消订阅。
				 */
				subscribe(listener) {
					this.listeners.add(listener);
					return () => this.listeners.delete(listener);
				}

				/**
				 * 合并补丁到快照并广播。
				 * @param patch - 局部字段。
				 */
				patch(patch) {
					let changed = false;
					for (const key of Object.keys(patch)) {
						if (this.snapshot[key] !== patch[key]) {
							changed = true;
							break;
						}
					}
					if (!changed) return;
					this.snapshot = { ...this.snapshot, ...patch };
					for (const listener of this.listeners) {
						try {
							listener();
						} catch (error) {
							console.error("[小凤] 订阅者异常", error);
						}
					}
				}

				/** ── 引擎选择 ─────────────────────────────────────────────────── */

				/**
				 * 决定用哪条识别引擎（同步初判）。
				 *
				 * `auto` 的初判先给浏览器识别：它不需要任何异步探测，首帧就能报出
				 * 一个确定的名字。真正的"能不能用 dsh-ears"要等一次远程调用，
				 * 由 `detectEars()` 异步升级 —— 界面先显示"浏览器识别"再变
				 * "dsh-ears 转写"，比先显示"未就绪"再跳变自然得多。
				 */
				pickEngineName() {
					const preferred = this.config.asr.engine;
					if (preferred === "ears") return "ears";
					if (preferred === "http") {
						if (this.config.asr.httpReady && httpAsrAvailable()) return "http";
						if (webSpeechAvailable()) return "webspeech-fallback";
						return "none";
					}
					if (preferred === "webspeech") return webSpeechAvailable() ? "webspeech" : "none";
					// auto
					if (webSpeechAvailable()) return "webspeech";
					if (this.config.asr.httpReady && httpAsrAvailable()) return "http-fallback";
					// 浏览器没有 Web Speech 但 dsh-ears 可能可用：先标 ears，探测失败再降级。
					return "ears";
				}

				/**
				 * 异步探测 dsh-ears，可用则把引擎升级为它。
				 *
				 * 这是本插件与 dsh-ears 的**唯一耦合点**：识别后端交给它，
				 * 唤醒/编排/播报留在本插件。探测失败静默降级，不打扰用户。
				 */
				/**
				 * 异步探测 dsh-ears，可用则把引擎升级为它。
				 *
				 * 这是本插件与 dsh-ears 的**唯一耦合点**：识别后端交给它，
				 * 唤醒/编排/播报留在本插件。探测失败静默降级，不打扰用户。
				 *
				 * @param options - `{ silent? }`：`silent` 为真时连"显式 ears 失败"
				 *   的提示也不发（重试路径用 —— 第一次已经提示过，重试再提示就是刷屏）。
				 */
				async detectEars(options = {}) {
					if (this.disposed) return;
					const preferred = this.config.asr.engine;
					if (preferred !== "auto" && preferred !== "ears") return;

					const probe = await probeEars(this.ctx);
					if (this.disposed) return;
					this.earsAvailable = probe.available === true;
					this.earsNeedsWav = probe.needsWav === true;
					this.earsBackends = Array.isArray(probe.backends) ? probe.backends : [];
					this.earsPaths = Array.isArray(probe.paths) ? probe.paths : [];
					this.earsShape = probe.shape ?? null;
					if (!probe.available) {
						if (this.snapshot.engine === "ears") {
							// 回退要**跳过已确认不可用的引擎**。老写法是
							// `webSpeechAvailable() ? "webspeech" : …` —— 只看浏览器有没有
							// 这个 API，不看它能不能真的工作。受限网络下浏览器识别连不上
							// 云端，于是"从 ears 退回 webspeech"等于退回一个已知坏掉的引擎，
							// 用户再说话又是同一条报错。
							//
							// 判据统一交给 `engineUsable()`（它内部按**族**比对死名单，
							// 顺带覆盖 `webspeech-fallback` 这类别名）。
							const candidates = ["http", "http-fallback", "webspeech", "webspeech-fallback"];
							this.swapEngine(candidates.find((name) => this.engineUsable(name)) ?? "none");
						}
						if (preferred === "ears" && options.silent !== true) {
							// 提示必须**在回退之后**发、并按**实际落点**措辞。
							// 老写法写死"已退回浏览器识别"，而回退目标可能是 `http` 或
							// `none`（浏览器识别不可用时）—— 那就成了一句假话，
							// 而且用户会照着它去排查一个根本不存在的引擎。
							const actual = this.snapshot.engine;
							this.notice(
								actual === "none"
									? "没有检测到可用的 dsh-ears 识别后端，且没有其它可用引擎。请在设置里配置 ASR。"
									: `没有检测到可用的 dsh-ears 识别后端，已退回「${this.engineLabel(actual)}」。`,
								"warn",
							);
						}
						return;
					}

					// ── 什么时候才把识别交给 dsh-ears ───────────────────────────────
					//
					// ⚠️ 这里曾是无条件 `swapEngine("ears")`。后果是**识别质量大幅下降**：
					// 本机 dsh-ears 的后端是本地 Whisper，而缓存里只有 6 档中最弱的
					// `ggml-tiny.bin`，且 `localWhisper.language` 默认空（自动检测对
					// 短片段极不可靠）⇒ 中文常被识别成英文/西语，并伴随 Whisper 专有幻觉
					// （`[BLANK_AUDIO]`、`（滋滋声）`、`（音乐）`、`[Subscribe]` 等）。
					//
					// 加"无条件"三个字是关键：`pickEngineName()` 明明**已经**选了
					// `webspeech`，但这一步只要探测到 dsh-ears 就把它顶掉 —— 于是浏览器
					// 识别**永远拿不到麦克风**，更新、更准的那条路被一条从没被验证过
					// 质量的路盖掉。
					//
					// 判据改为**只有浏览器识别不可用时才升级**：
					//   * `engine: 'ears'` —— 用户显式指定，那是他的选择，照办；
					//   * `engine: 'auto'` —— 浏览器识别优先（零配置，中文识别质量在
					//     网络可用时明显更好）。只有它被确认不可用（`deadEngines`）或
					//     浏览器根本没有这个 API 时，才轮到 dsh-ears。
					//
					// 这样两条都不丢：**网络可用时用更准的浏览器识别；受限网络下仍会
					// 自动退到本地 Whisper**（`asr-unreachable` → 死名单 → 回退）。
					const forced = preferred === "ears";
					if (!forced && this.snapshot.engine !== "ears" && this.engineUsable("webspeech")) {
						log("浏览器识别可用（auto 模式优先），不切到 dsh-ears");
						return;
					}
					this.swapEngine("ears");
				}

				/**
				 * 等服务就位后自动接上 dsh-ears（**事件驱动**，不是轮询）。
				 *
				 * ## 为什么必须有这一步
				 *
				 * 真机证据（tools/probe-local-ears.mjs）：本插件 `apply` 时探测
				 * `remote.dshEars` **取不到**，而 6 秒后重探**能取到** ——
				 * 是**时序竞争**：`dsh-ears` 的客户端 `apply` 是 `async`，
				 * 里面要 `await ctx.remote.$mount(TYPERT_REMOTE)` 才把服务挂上去，
				 * 而本插件的 `apply` 跑在它前面。
				 *
				 * 症状极具误导性：`ctx.get("remote.dshEars")` 返回 `undefined`，
				 * 看起来像"注册名写错了"，于是会去反复试各种名字（**我第一版就这么
				 * 白忙了一场**）。真实原因是"问得太早"。
				 *
				 * ## 为什么用 `ctx.inject` 而不是 `setTimeout` 重试
				 *
				 * `ctx.inject([name], cb)` 是 cordis 给的**就绪回调**：服务一旦注册，
				 * `cb` 立刻被调用；没装就永远不调用（不报错、不卡住）。
				 * 这正是 `dsh-ears` 自己的接法：
				 *
				 *     await ctx.inject(["slots", "locale", "remote.dshEars"], (c) => {
				 *         const earsRemote = c.remote.dshEars;
				 *     });
				 *
				 * 相比之下"定时重试"有三个坏处：慢（要么定得短、要么让用户干等）、
				 * 白跑（服务永远不会来时还一直试）、以及**无法区分**"还没来"与
				 * "根本没有"。就绪回调把这三件事一次说清。
				 *
				 * ## 为什么还要留一次重试
				 *
				 * `inject` 只保证"注册的那一刻"回调。若本插件加载时服务**早已**
				 * 注册好（热重载、或 dsh-ears 恰好先 apply），`inject` 会立即回调 ——
				 * 那是正常路径。真正需要兜底的是：某些 profile 里 `inject` 的
				 * 声明式等待**不触发**（本项目在精简 profile 上见过静默不回调）。
				 * 所以补一次短延迟重探，两条路取先到者。
				 */
				async watchEars() {
					if (this.disposed) return;
					const preferred = this.config.asr.engine;
					if (preferred !== "auto" && preferred !== "ears") return;
					if (this.snapshot.engine === "ears") return;
					const started = Date.now();

					// ① 就绪回调（正路）。
					try {
						await this.ctx?.inject?.(["remote.dshEars"], () => {
							if (this.disposed || this.snapshot.engine === "ears") return;
							log(`dsh-ears 服务已就位（等待 ${Date.now() - started} ms），重新探测`);
							this.detectEars().catch((error) => warn("dsh-ears 重探异常", error?.message ?? error));
						});
					} catch (error) {
						// `inject` 在精简 profile 上可能不支持或抛错，不当致命。
						warn("等待 dsh-ears 服务就位失败（改用重试兜底）", error?.message ?? error);
					}

					// ② 重试兜底：等在途的 `apply` 收敛。
					//
					//    2 次、间隔 1.5s —— 够覆盖"dsh-ears 的 apply 还没 await 完"，
					//    又不会让用户为此干等。`silent` 是因为首次探测已经如实提示过。
					for (let attempt = 0; attempt < 2; attempt += 1) {
						if (this.disposed || this.snapshot.engine === "ears") return;
						await new Promise((resolve) => setTimeout(resolve, 1500));
						if (this.disposed || this.snapshot.engine === "ears") return;
						await this.detectEars({ silent: true });
						if (this.earsAvailable === true) return;
					}
				}

				/**
				 * 换引擎：保留"是否正在听"，换完立刻恢复监听。
				 * @param name - 引擎名。
				 */
				swapEngine(name) {
					if (this.snapshot.engine === name) return;
					const wasListening = this.engine.wanted === true;
					this.engine.stop();
					this.patch({ engine: name });
					this.engine = this.createEngine();
					if (wasListening) this.engine.start();
					log(`识别引擎切换为 ${name}`);
				}

				/** 按 `engine` 字段构造识别引擎。 */
				createEngine() {
					const name = this.snapshot?.engine ?? this.pickEngineName();
					const handlers = () => ({
						language: this.config.language,
						maxSegmentMs: this.config.asr.maxSegmentMs ?? 15000,
						onPartial: (text) => this.handlePartial(text),
						onFinal: (text) => this.handleFinal(text),
						onError: (error) => this.fail(error),
						onClose: () => {},
					});
					if (name === "ears") {
						// 复用 dsh-ears 的远程 transcribe：VAD 采集在本插件，识别在它那边。
						// `needsWav` 传函数而不是布尔值 —— 用户可能在会话中途去
						// dsh-ears 设置页换后端（例如从云端换成本地 Whisper）。
						return new HttpAsrEngine({ ...handlers(), recognize: makeEarsRecognizer(this.ctx, { needsWav: () => this.earsNeedsWav }) });
					}
					if (name === "http" || name === "http-fallback") return new HttpAsrEngine(handlers());
					return new WebSpeechEngine(handlers());
				}

				/** ── 生命周期 ─────────────────────────────────────────────────── */

				/**
				 * 启用语音（必须在用户手势的调用栈里被调用，否则浏览器不给麦克风、也不给出声）。
				 * @returns 是否成功进入待机。
				 */
				start() {
					unlockAudio();
					if (this.snapshot.engine === "none") {
						this.notice("当前浏览器既没有 Web Speech，也没有配置上游 ASR，无法启用语音。", "error");
						return false;
					}
					if (this.machine.get() !== STATES.OFF) return true;
					this.patch({ powered: true, error: "" });
					this.machine.send(EVENTS.START);
					// 若之前已有委托在途（例如休眠/停用期间提交的），恢复后继续取汇报。
					if (this.interactionQueue.length > 0 || this.snapshot.pendingDelegations > 0) {
						this.startReportPolling();
						this.pollReports();
						this.pollInteractions();
					}
					return true;
				}

				/** 停用语音：释放麦克风与音频（已在途的后台委托保留，重新启用后继续取汇报）。 */
				stop() {
					this.stopReportPolling();
					this.machine.send(EVENTS.STOP);
					this.patch({ powered: false, partial: "", heard: "", answer: "" });
				}

				/** 在启用/停用之间切换（给按钮用）。 */
				toggle() {
					if (this.machine.get() === STATES.OFF) this.start();
					else this.stop();
				}

				/**
				 * 手动唤醒（点击语音球 / 快捷键 / 提示音唤醒）。
				 *
				 * 休眠中走 `RESUME`（先回待机，再进听），未启用则先启用。
				 * 唤醒时播一声提示音 —— 这是"我听到了"的即时反馈，没有它用户会怀疑。
				 */
				wake() {
					unlockAudio();
					const status = this.machine.get();
					if (status === STATES.OFF) {
						this.start();
						return;
					}
					if (status === STATES.SLEEPING) {
						this.chime("wake");
						this.machine.send(EVENTS.RESUME);
						// 休眠唤醒后直接进入"听指令"，省掉用户再喊一次唤醒词。
						this.machine.send(EVENTS.WAKE);
						return;
					}
					if (status === STATES.STANDBY) {
						this.chime("wake");
						this.machine.send(EVENTS.WAKE);
						return;
					}
					// 已唤醒/思考/播报：再点一次表示"我要说话"，打断播报。
					this.speaker.cancel();
					this.machine.send(EVENTS.WAKE);
				}

				/** 进入休眠（用户手动 / 计时到点）。 */
				sleep() {
					if (this.machine.get() === STATES.SLEEPING) return;
					this.speaker.cancel();
					this.machine.send(EVENTS.SLEEP);
				}

				/** ── 状态迁移副作用 ───────────────────────────────────────────── */

				/**
				 * 状态迁移时统一处理音频设备与计时器。
				 * @param to - 新状态。
				 * @param from - 旧状态。
				 * @param event - 触发事件。
				 */
				onTransition(to, from, event) {
					this.patch({ status: to, label: STATE_LABEL[to] });
					// 每迁一次就换代：在途的识别/播报回调据此自废，避免跨代串台。
					this.generation += 1;

					if (to === STATES.SLEEPING) {
						clearTimeout(this.idleTimer);
						this.idleTimer = null;
						clearTimeout(this.echoTimer);
						this.echoTimer = null;
						this.engine.stop();
						// 休眠时丢弃未提交的片段：用户已经离开了，攒着的话下次唤醒
						// 会被当成新指令一起提交（"你十分钟前说的话又发了一遍"）。
						this.turnGate.reset();
						this.echoGuard.reset();
						this.patch({ partial: "", pending: "", pendingDueAt: null });
						if (to !== from) this.chime("sleep");
						return;
					}

					if (to === STATES.OFF) {
						clearTimeout(this.idleTimer);
						this.idleTimer = null;
						clearTimeout(this.echoTimer);
						this.echoTimer = null;
						this.turnGate.reset();
						this.echoGuard.reset();
						this.engine.stop();
						this.speaker.cancel();
						this.patch({ pending: "", pendingDueAt: null });
						return;
					}

					if (to === STATES.STANDBY) {
						clearTimeout(this.idleTimer);
						this.idleTimer = null;
						// 回待机的成因之一是"唤醒后 12s 没听到话"（ACTIVE + IDLE）——
						// 这时若还攒着内容必须丢掉，否则会静静地留着，等下一次唤醒
						// 时和新的指令拼成一句莫名其妙的话。
						this.turnGate.reset();
						this.patch({ partial: "", pending: "", pendingDueAt: null });
						// 这里的 `from === SPEAKING` 在当前迁移表下**已不可达**
						// （`SPEAKING` 的 `SPEAK_END` / `WAKE` 都指向 `ACTIVE`，见 `machine.js`）
						// —— 保留它是防御性的：回声静默期本质上属于"从播报里出来"这个
						// 成因，将来若有人加回一条 `speaking → standby` 的迁移，这里必须
						// 跟着走 700ms 静默，否则外放余响会被当成唤醒词或新指令。
						if (from === STATES.SPEAKING) this.armEchoGuard();
						// 休眠时若配置了保留唤醒词，麦克风不关；否则这里重新开。
						else if (!this.engine.wanted) this.engine.start();
						return;
					}

					if (to === STATES.ACTIVE) {
						// 只有"重新开始听"时才清掉上一条回答；从**播报**过来不算 ——
						// 那是"刚念完、接着能听"，用户可能还在看/回味刚念的那句，
						// 清掉会让界面（与 `answer` 诊断线）在说完的瞬间把它抹掉。
						if (from !== STATES.SPEAKING) this.patch({ answer: "" });
						// 从待机/休眠进来 = 刚唤醒，等第一句话（12s 没开口就退回待机）；
						// 从播报/思考进来 = 对话中途，按 `sleep.idleTimeoutMs`（默认 60s）计时。
						//
						// 「播报完不必重新唤醒」正是靠这里：`from === SPEAKING` 落到
						// `false` → 走 60s 那一档，于是"播报完没有语音输入 60 秒才休眠"。
						this.awaitingFirstUtterance = from === STATES.STANDBY || from === STATES.SLEEPING;
						this.armIdle();
						// 从**播报**过来时要留一段静默再开麦：`speechSynthesis` / `HTMLAudio`
						// 的 onend 可能在音频真正放完之前就触发，外放设备还有余响。
						// 立刻开麦就会把自己刚念的尾音录回去、当成新指令提交 ——
						// 这正是"自说自话"的声学入口。留 700ms 从物理上切断这条路。
						if (from === STATES.SPEAKING) this.armEchoGuard();
						else if (!this.engine.wanted) this.engine.start();
						return;
					}

					if (to === STATES.THINKING) {
						clearTimeout(this.idleTimer);
						this.idleTimer = null;
						this.patch({ partial: "", notice: "" });
						// 思考中是否开麦是两难：
						//   关麦 = 环境噪声不会误入（默认）；开麦 = 用户能当场纠偏
						//   （"不对，是 D 盘"），agent 在下一个 step 边界吃进插话。
						// 默认**关麦**：常驻 agent 跑一个长任务时，环境里任何人声/噪声
						// 都会被当成"插话"注入正在跑的 turn，是自说自话的另一入口。
						// 要插话纠偏就把 `turn.steerWhileThinking` 打开。
						if (this.config.turn?.steerWhileThinking === true && this.config.agent?.steer !== false) {
							// 这里不需要回声延迟：刚才是用户在说话，没有 TTS 余响。
							if (!this.engine.wanted) this.engine.start();
						} else {
							this.engine.stop();
						}
						return;
					}

					if (to === STATES.SPEAKING) {
						this.engine.stop();
						// 停止识别后丢掉攒下的片段：那是上一代识别器的残留，
						// 留着会在下一轮被一起提交（表现为"你上次说的话又发了一遍"）。
						this.turnGate.reset();
						this.patch({ pending: "", pendingDueAt: null });
						return;
					}
					// 其他情况不额外处理（event 仅用于诊断时打印）。
					void event;
				}

				/**
				 * 播报结束后延迟重开麦克风（切断声学回环）。
				 *
				 * 用 `generation` 做守卫：延迟期间用户可能又点了播报/休眠，
				 * 那时不该把这个旧定时器兑现成一次"擅自开麦"。
				 */
				armEchoGuard() {
					clearTimeout(this.echoTimer);
					const generation = this.generation;
					this.echoTimer = setTimeout(() => {
						this.echoTimer = null;
						if (this.disposed || generation !== this.generation) return;
						if (!this.engine.wanted) this.engine.start();
					}, ECHO_GUARD_MS);
				}

				/**
				 * 重置并武装"本轮结束"计时器。
				 *
				 * ## 三个截止点，取最早的那个
				 *
				 * | 情形 | 到点做什么 | 时限 |
				 * |---|---|---|
				 * | 唤醒后一直没开口 | 回待机继续等唤醒词 | `WAKE_GRACE_MS`（12s）|
				 * | 已攒下内容、静音了 | **提交这一轮**（`TurnGate` 自己管） | `turn.silenceMs` |
				 * | 彻底没动静了 | 休眠、释放麦克风 | `sleep.idleTimeoutMs` |
				 *
				 * ## 为什么休眠下限要随静音阈值抬高
				 *
				 * 两者都长在"静音"上，很容易撞在一起：默认休眠 60s、静音提交 60s，
				 * 若同时到点，休眠先执行 → 状态离开 `active` → 整轮发言被丢掉，
				 * 用户说了半天什么也没发生。这是最隐蔽的一类"说了没反应"。
				 *
				 * 所以本轮已有内容时，休眠下限抬到 `silenceMs + 5s`，保证提交一定
				 * 发生在休眠之前。（`TurnGate` 是唯一提交入口，它自己保证会提交。）
				 */
				armIdle() {
					clearTimeout(this.idleTimer);

					// 已攒下内容：等门槛提交，休眠要排在它后面。
					if (this.turnGate.pending) {
						const need = (this.turnGate.silenceMs ?? SILENCE_SUBMIT_MS) + 5000;
						this.idleTimer = setTimeout(() => {
							if (this.machine.get() === STATES.ACTIVE) this.sleep();
						}, Math.max(this.config.sleep.idleTimeoutMs, need));
						return;
					}

					// 刚唤醒、一句话还没听到：用短时限回待机 —— 避免界面一直显示
					// "正在听"却什么都不发生，用户会以为功能坏了。
					if (this.awaitingFirstUtterance) {
						const grace = Math.min(WAKE_GRACE_MS, this.config.sleep.idleTimeoutMs);
						this.idleTimer = setTimeout(() => {
							if (this.machine.get() !== STATES.ACTIVE) return;
							// 期间用户开口了：改按"已攒下内容"那档，别把内容丢了。
							if (this.turnGate.pending) {
								this.armIdle();
								return;
							}
							this.machine.send(EVENTS.IDLE);
						}, grace);
						return;
					}

					// 已经聊过：等休眠静默时长。每次开口都会重新调用本方法，计时重排。
					this.idleTimer = setTimeout(() => {
						if (this.machine.get() === STATES.ACTIVE) this.sleep();
					}, this.config.sleep.idleTimeoutMs);
				}

				/** 播放提示音（受配置开关控制）。 */
				chime(kind) {
					if (this.config.sleep.chime === false) return;
					playChime(kind);
				}

				/** ── 识别事件 ─────────────────────────────────────────────────── */

				/**
				 * 中间结果：用于快速唤醒与实时字幕。
				 *
				 * 唤醒必须吃中间结果 —— 等最终结果要 900ms 静默，用户会觉得"喊完半天没反应"。
				 * @param text - 中间文本。
				 */
				handlePartial(text) {
					const status = this.machine.get();
					const text_ = String(text ?? "");
					// 回声过滤必须放在最前：待机时的回声虽然不提交，但它可能**含唤醒词**
					// （助手念"小凤…"时），会把机器从待机唤醒 —— 那就等于自己喊自己。
					if (this.config.turn?.echoGuard !== false && this.echoGuard.check(text_).echo) return;
					if (status === STATES.STANDBY) {
						const hit = findWake(text_, this.wakeOptions());
						if (hit.hit) {
							this.chime("wake");
							this.machine.send(EVENTS.WAKE);
							this.engine.reset?.();
							this.patch({ partial: hit.rest });
						}
						return;
					}
					if (status === STATES.ACTIVE) {
						// 唤醒词在已唤醒状态下也吸收掉（"小凤，小凤帮我…"）。
						const hit = findWake(text_, { ...this.wakeOptions(), inline: true });
						this.patch({ partial: hit.hit ? hit.rest : text_ });
						this.armIdle();
					}
				}

				/**
				 * 最终结果：唤醒判定，或**攒进本轮**。
				 *
				 * ## 为什么这里不再直接提交
				 *
				 * 识别引擎的"最终结果"是**片段**（900ms / 700ms 静音就切一段），
				 * 不是**一轮发言**。直接把片段当指令提交会出两个真实故障：
				 * 用户说到一半（想词、换气）就被提交上半句；一个意图被拆成好几轮对话。
				 *
				 * 所以片段一律先经 `TurnGate` 攒着，只有
				 *   - 静音满 `turn.silenceMs`（默认 10 秒），或
				 *   - 用户单击语音球（手动「我说完了」），或
				 *   - 触到单轮硬上限（连续不断说话的安全阀）
				 * 才真正走 `runCommand` 提交一次。
				 *
				 * @param text - 一段识别文本。
				 */
				async handleFinal(text) {
					const content = String(text ?? "").trim();
					if (content === "") return;
					const status = this.machine.get();

					// ── 回声抑制 ──────────────────────────────────────────────────────
					//
					// 助手自己刚念的话被麦克风录回来，绝不能当成用户指令 —— 那是
					// "自说自话"闭环的声学入口。放在状态分支**之前**：任何状态下
					// 识别到的回声都该丢掉（播报余响可能在状态已切走之后才送达）。
					if (this.config.turn?.echoGuard !== false) {
						const echo = this.echoGuard.check(content);
						if (echo.echo) {
							warn("丢弃识别到的回声", echo.matched);
							this.patch({ partial: "" });
							return;
						}
					}

					if (status === STATES.STANDBY) {
						const hit = findWake(content, this.wakeOptions());
						if (!hit.hit) return; // 待机时的日常说话不理会。
						this.chime("wake");
						this.machine.send(EVENTS.WAKE);
						// 唤醒词后面带的内容同样进轮次门槛：用户可能还要接着说。
						if (hit.rest !== "") this.pushFragment(hit.rest);
						else this.notice(`我在，请说。`, "info");
						return;
					}

					if (status === STATES.ACTIVE) {
						this.armIdle();
						// 已唤醒状态仍需剥掉可能的唤醒词前缀。
						const hit = findWake(content, { ...this.wakeOptions(), inline: true });
						const fragment = (hit.hit ? hit.rest : content).trim();
						if (fragment === "") {
							this.notice("我在，请说。", "info");
							return;
						}
						this.pushFragment(fragment);
						return;
					}

					if (
						status === STATES.THINKING &&
						this.config.turn?.steerWhileThinking === true &&
						this.config.agent?.steer !== false
					) {
						// 插话纠偏：思考中说的话 steer 进当前 turn，agent 在下一个
						// step 边界消费。不开新 turn —— 那会变成"排队等下一轮"。
						// 默认**关闭**（`turn.steerWhileThinking=false`）且思考中不开麦：
						// 开着的话环境里任何人声都会被注入正在跑的 turn。
						const hit = findWake(content, { ...this.wakeOptions(), inline: true });
						const steerText = (hit.hit ? hit.rest : content).trim();
						if (steerText === "") return;
						this.patch({ partial: `插话：${steerText}` });
						const accepted = await this.session.steer(steerText);
						if (accepted) this.notice("已插话纠偏。", "info");
						return;
					}
					// speaking / sleeping 期间到达的最终结果一律丢弃：
					// 那是上一代识别器的残留，处理它会造成重复提交。
				}

				/**
				 * 把一个识别片段攒进本轮发言（不提交）。
				 *
				 * 重复片段会被门槛丢掉（引擎 `onend` 重启时可能把同一句再送一遍）。
				 * @param fragment - 片段文本。
				 */
				pushFragment(fragment) {
					if (!this.turnGate.push(fragment)) return;
					this.awaitingFirstUtterance = false;
					// 先 push 再 armIdle：`armIdle` 要按"本轮在攒"抬高下限，
					// 否则休眠静默会和静音提交撞在同一刻，睡着就把整轮丢了。
					this.armIdle();
					// `partial` 必须清空：引擎的 `onPartial` 给的是"已确认最终文本 +
					// 当前中间结果"的**累计**串，片段入队后那部分已经进了 `pending`，
					// 不清的话界面会把同一句显示两遍（`pending` 一份、`partial` 一份）。
					this.patch({ partial: "", pending: this.turnGate.text, pendingDueAt: this.turnGate.deadline });
				}

				/**
				 * 轮次门槛到点：真正把整轮发言提交进会话。
				 * @param payload - `{ text, reason }`；`reason` 为 `silence` / `cap` / `manual`。
				 */
				async handleTurnCommit(payload) {
					const text = String(payload?.text ?? "").trim();
					this.patch({ pending: "", pendingDueAt: null });
					if (text === "") return;
					// 状态已不是"正在听"（用户打断了、休眠了、或这轮已被提交）就别再发了。
					if (this.machine.get() !== STATES.ACTIVE) return;
					if (payload?.reason !== "silence") {
						log(`本轮提交（${payload?.reason}，${text.length} 字）`);
					}
					// 有未答问题时，这一轮发言**先当成回答**去匹配。
					//
					// 放在这里而不是 `handleFinal`：回答也是一个"整轮发言"，同样要
					// 等用户说完（静音满阈值）再匹配 —— 否则用户刚说"第一个"就会被
					// 立刻当成答案提交，而他其实还要补充"不是，我是说第三个"。
					//
					// 匹配不上时会返回 `false` 并继续走指令路径（见 `tryAnswerQuestion`
					// 的注释：宁可当新指令，也不能猜一个选项替用户答）。
					if (await this.tryAnswerQuestion(text)) return;
					await this.runCommand(text);
				}

				/**
				 * 手动提交当前这一轮（单击语音球）。
				 *
				 * 等满静音阈值是默认行为，但人总有"我说完了，快答"的时候，所以留这个逃生口。
				 * @returns 是否真的提交了（没有攒下内容时为 `false`）。
				 */
				submitTurn() {
					if (!this.turnGate.pending) return false;
					this.turnGate.flush("manual");
					return true;
				}

				/** 唤醒匹配参数。 */
				wakeOptions() {
					return {
						word: this.config.wake.word,
						aliases: this.config.wake.aliases,
						inline: this.config.wake.inlineCommand,
					};
				}

				/**
				 * 执行一条指令：润色 → 写入会话。
				 * @param raw - 原始转录文本。
				 */
				async runCommand(raw) {
					const generation = this.generation;
					this.patch({ heard: raw, partial: raw, error: "" });

					// V1.7：专家管理命令在**润色前**用规则识别（润色会把结构化命令改写成
					// 自然语言，反而丢参数）。命中就执行并口头回报，不再走 LLM 路由。
					const command = parseExpertCommand(raw);
					if (command !== null) {
						await this.runExpertManagement(command, generation);
						return;
					}

					let text = raw;
					let via = "off";
					if (this.config.polish.enabled) {
						try {
							const result = await polish(raw);
							if (generation !== this.generation) return;
							if (typeof result?.text === "string" && result.text.trim() !== "") {
								text = result.text.trim();
								via = typeof result.via === "string" ? result.via : "llm";
							}
						} catch (error) {
							// 润色失败不影响主链路：原话照发，但要让用户知道这次没润色。
							warn("润色不可用", error);
							this.notice("润色服务不可用，已按原话发送。", "warn");
						}
					}
					this.patch({ heard: text, polishVia: via });

					// ── 两层架构第一层：意图路由（润色之后、提交之前）──────────────
					//
					// 为什么在润色之后：路由模型拿到的是干净指令，分类质量更高。
					// 为什么尊重"用户手动切换"：用户用跨会话功能**点名**了目标会话时，
					// 那是比自动路由更强的意图表达 —— 路由让位，直到用户切回常驻。
					//
					// V1.3 起这里**不再切会话**：非 general 的 worker 走 /delegate 后台
					// 执行，客户端留在根会话；worker 完成后由宿主汇总要点入队，再经
					// /reports 按完成先后依次播报（见下面的轮询器）。
					// 降级链：路由失败/关闭 → 进根 agent「小凤」；委托失败 → 也进根 agent。
					let task = text;
					let delegated = false;
					if (
						this.config.routing?.enabled === true &&
						Array.isArray(this.config.routing.workers) &&
						this.config.routing.workers.length > 0 &&
						!(this.session.mode === "switched" && this.session.routerPinned !== true)
					) {
						try {
							const outcome = await route(text);
							if (generation !== this.generation) return;
							if (typeof outcome?.task === "string" && outcome.task.trim() !== "") task = outcome.task.trim();
							const workerId = typeof outcome?.worker === "string" ? outcome.worker : "general";
							const worker =
								this.config.routing.workers.find((row) => row.id === workerId) ??
								this.config.routing.workers.find((row) => row.id === "general");
							const routeVia = typeof outcome.via === "string" ? outcome.via : "llm";

							if (worker !== undefined && worker.id !== "general") {
								// 真正的专家：提交给宿主后台执行，不切会话、不旁听中间过程。
								try {
									const result = await delegate(worker.id, task);
									if (generation !== this.generation) return;
									if (result?.ok === true) {
										delegated = true;
										this.patch({
											routedWorker: worker.label,
											routeVia,
											pendingDelegations: this.snapshot.pendingDelegations + 1,
											sessionTarget: this.session.describe(),
										});
										this.notice(`已交给${worker.label}处理，完成后我会汇报要点。`, "info");
										// 立刻探一次（worker 可能几百毫秒就完成），并启动轮询。
										this.startReportPolling();
										this.pollReports();
										this.pollInteractions();
										return;
									}
									warn("委托被拒，指令改投根会话", worker.id, result?.error);
									this.notice(`${worker.label}暂时不可用，我先来处理。`, "warn");
								} catch (error) {
									warn("委托提交失败，指令改投根会话", error);
									this.notice("专家派单暂不可用，我先来处理。", "warn");
								}
								this.patch({ routedWorker: "", routeVia });
							} else if (worker !== undefined && worker.id === "general") {
								// general = 根 agent「小凤」：**回家**（回常驻绑定），不 pin。
								if (this.session.usingPersistent() && this.session.mode !== "persistent") {
									await this.session.switchToPersistent();
								}
								this.patch({ routedWorker: "", routeVia, sessionTarget: this.session.describe() });
							} else {
								this.patch({ routedWorker: "", routeVia });
							}
						} catch (error) {
							warn("意图路由不可用，按原目标发送", error);
							this.patch({ routedWorker: "", routeVia: "error" });
						}
					} else {
						this.patch({ routedWorker: "", routeVia: "" });
					}

					// 非委托路径：正常把任务写进（根）会话，等它的 turn/end 播报。
					this.machine.send(EVENTS.COMMAND);
					// 迁移会换代，所以要在 send 之后重新取一次代号再比较，
					// 否则 `accepted` 的失败处理会被自己刚触发的迁移判成"过期的回调"而跳过。
					const afterSend = this.generation;
					const accepted = await this.session.ask(task);
					if (afterSend !== this.generation) return;
					if (!accepted) {
						this.fail(new Error("prompt-rejected"));
					}
				}

				/**
				 * V1.7：执行一条专家管理命令（增 / 删 / 列）并口头回报。
				 *
				 * 与正常指令不同：管理命令不写会话、不派单，执行完直接说话。走完整的
				 * COMMAND → AGENT_MESSAGE → SPEAK_END 状态机，避免播完停在"思考中"。
				 *
				 * @param command - `parseExpertCommand()` 的结果。
				 * @param generation - 进入时的代号，用于检测期间被打断。
				 */
				async runExpertManagement(command, generation) {
					this.machine.send(EVENTS.COMMAND);
					let result;
					let speech;
					try {
						if (command.kind === "list") {
							const data = await listExperts();
							const names = (data?.workers ?? []).map((w) => w.label ?? w.id).join("、");
							result = { ok: data?.ok === true, ...data };
							speech = result.ok && names !== "" ? `现在的专家有：${names}。` : "现在没有可用专家。";
							if (Array.isArray(data?.workers)) this.refreshExperts(data.workers);
						} else if (command.kind === "add") {
							result = await addExpert(command.expert);
							speech = formatCommandSpeech(result, "add");
							if (result?.ok === true) {
								// 带上生成的 id，方便用户后续用名字删除。
								speech += `它的编号是 ${result.expert.id}。`;
								await this.syncExpertsAfterChange();
							}
						} else if (command.kind === "remove") {
							result = await removeExpert(command.id);
							speech = formatCommandSpeech(result, "remove");
							if (result?.ok === true) await this.syncExpertsAfterChange();
						}
					} catch (error) {
						warn("专家管理命令失败", error?.message ?? error);
						result = { ok: false, error: String(error?.message ?? error) };
						speech = formatCommandSpeech(result, command.kind);
					}
					if (generation !== this.generation) return;

					this.notice(speech, result?.ok === true ? "info" : "warn");
					this.patch({ lastReport: speech, answer: speech, routedWorker: "", routeVia: "expert-command" });
					this.pushHistory("assistant", speech);
					this.echoGuard.remember(speech);
					try {
						await this.speaker.speak(speech);
					} catch (error) {
						warn("管理命令播报失败", error?.message ?? error);
					}
					if (generation !== this.generation) return;
					this.machine.send(EVENTS.SPEAK_END);
					this.patch({ partial: "" });
				}

				/** 增删后重新拉清单，更新本地配置（卡通桌宠浮层据此增减）。 */
				async syncExpertsAfterChange() {
					try {
						const data = await listExperts();
						if (Array.isArray(data?.workers)) this.refreshExperts(data.workers);
					} catch (error) {
						warn("刷新专家清单失败", error?.message ?? error);
					}
				}

				/** 原地替换本地专家清单（保住配置对象引用）。 */
				refreshExperts(workers) {
					if (!Array.isArray(this.config.routing?.workers)) return;
					this.config.routing.workers.splice(0, this.config.routing.workers.length, ...workers);
				}

				/** ── 需求④ 统一互动流：按发生时间依次播报 ──────────────────────────
				 *
				 * ## 为什么是"一条流"而不是"各播各的"
				 *
				 * 三类需要用户介入的事来自不同通道：
				 *   - 权限审核 —— 宿主旁听会话事件的 `approval/asked`；
				 *   - 模型提问 —— 客户端自己旁听当前会话的 `tool/call`；
				 *   - 结果汇报 —— 委托中枢完成后入队。
				 *
				 * 各播各的话，两件几乎同时发生的事谁先出声取决于哪条通道先跑完，用户
				 * 听到的顺序是乱的。这里全部收进 `interactionQueue`（一个**按 `at` 排序**
				 * 的队列），由单一 drain 循环串行播报 —— 听到的顺序 = 发生的顺序。
				 *
				 * ## 游标为什么要 `"latest"` 起步
				 *
				 * 队列在宿主侧跨刷新存活。首帧从 0 拉会把上次会话（甚至几天前）的事
				 * 一次性全念出来。所以首帧只同步水位、不重放。
				 *
				 * ## 与 `/reports` 的关系（不重复播报）
				 *
				 * 宿主把汇报**同时**放进了 `/reports`（旧口径，冒烟脚本与既有调用仍在用）
				 * 与 `/interactions`（新口径）。本控制器只播报**后者**。开启统一流时
				 * 就不再单独轮询 `/reports`，否则同一条汇报会被念两遍。
				 * 统一流不可用时（老宿主）自动退回 `/reports` —— 降级链不断。
				 */

				/**
				 * 启动互动流轮询（幂等）。首次成功委托后调用（没有后台任务就无需轮询）。
				 *
				 * ## 起点：账本优先，`latest` 只是最后手段
				 *
				 * 早先的实现每次启动都把游标设成 `"latest"`（"只对齐水位、不重放历史"）。
				 * 那条策略挡得住"整批历史涌入"，但有两个洞 —— 也正是真机上"前面汇报过的
				 * 内容再打开又播一遍"的成因：
				 *
				 *   1. `latest` 对齐的是**服务端当前游标**，而它是 `max(Date.now(), …)`。
				 *      刷新发生在两次播报之间时，上次已播的条目会重新落进增量窗口；
				 *   2. 双通道：`/reports` 与 `/interactions` 是同一条汇报的两个端点，
				 *      首帧各拉一次，谁先到谁念（`interactionsAvailable` 要到第二轮才生效）。
				 *
				 * 现在改为：**有账本就从账本续**（水位 + 已播集合双重去重），
				 * 只有账本为空（首次使用、或用户清了存储）才退回 `latest` 对齐。
				 */
				startReportPolling() {
					if (this.disposed || this.reportTimer !== null) return;
					// 账本里有水位 → 从它续上（这就是"记住回答到哪个位置"）。
					if (this.interactionCursor === undefined) {
						const saved = this.ledger.cursor;
						this.interactionCursor = saved > 0 ? saved : "latest";
					}
					if (this.reportCursor === undefined) {
						const saved = this.ledger.cursor;
						this.reportCursor = saved > 0 ? saved : "latest";
					}
					const interval = Number.isFinite(this.config.interactions?.pollMs)
						? Math.max(500, this.config.interactions.pollMs)
						: Number.isFinite(this.config.routing?.reportPollMs)
							? Math.max(500, this.config.routing.reportPollMs)
							: 1500;
					this.reportTimer = setInterval(() => {
						this.pollReports();
						this.pollInteractions();
					}, interval);
					log(`互动流轮询已启动（间隔 ${interval}ms，水位 ${this.ledger.cursor > 0 ? this.ledger.cursor : "首次"}）`);
				}

				/** 停止互动流轮询。 */
				stopReportPolling() {
					if (this.reportTimer !== null) {
						clearInterval(this.reportTimer);
						this.reportTimer = null;
					}
				}

				/**
				 * 拉一次新汇报，入队后依次播报（**仅统一流不可用时走这条**）。
				 *
				 * ## 为什么"首帧 latest"不能省
				 *
				 * 常驻 agent / 汇报队列跨会话、跨刷新存活。若首帧从 0 开始拉，会把上次
				 * 会话（甚至几天前）的汇报一次性全念出来 —— 与会话事件的水位线同一类
				 * 事故。首帧只同步游标，之后才取增量。
				 */
				async pollReports() {
					if (this.disposed) return;
					// 统一互动流可用时由 pollInteractions 独占播报（避免同一条念两遍）。
					if (this.interactionsAvailable) return;
					try {
						const payload = await fetchReports(this.reportCursor);
						if (this.disposed) return;
						if (typeof payload?.cursor === "number") {
							if (this.cursorSeeded) this.ledger.advance(payload.cursor);
							else {
								this.ledger.seed(payload.cursor);
								this.cursorSeeded = true;
							}
							this.reportCursor = payload.cursor;
						}
						const incoming = Array.isArray(payload?.reports) ? payload.reports : [];
						if (incoming.length > 0) {
							// 服务端已按完成时间升序；客户端只做去重。
							//
							// 去重用**同一个账本**（`kind:"report"` + jobId）：这样降级通道
							// 与统一流共享一份"播过了"的记录 —— 即便两条通道同时活着、
							// 同一条汇报两边都拿到，也只会念一次（需求②的硬防线）。
							let queued = 0;
							for (const report of incoming) {
								const entry = {
									kind: "report",
									at: typeof report?.at === "number" ? report.at : undefined,
									key: String(report?.jobId ?? ""),
									label: String(report?.label ?? ""),
									speech: String(report?.speech ?? report?.summary ?? ""),
								};
								if (!this.ledger.claim(entry)) continue;
								if (!withinCatchup(entry, { now: Date.now(), windowMs: this.catchupWindowMs() })) {
									log("跳过过期汇报（太老了不补播）");
									continue;
								}
								this.interactionQueue.push(entry);
								queued += 1;
							}
							if (queued > 0) {
								this.patch({ pendingDelegations: Math.max(0, this.snapshot.pendingDelegations - queued) });
								this.drainInteractions();
							}
						}
					} catch (error) {
						// 轮询失败不打扰用户（间隔短、会重试），但要留一条可见结论。
						warn("汇报轮询失败（稍后重试）", error?.message ?? error);
					}
				}

				/**
				 * 拉一次统一互动流（权限审核 / 模型提问 / 结果汇报），入队后依次播报。
				 *
				 * 失败一次就把 `interactionsAvailable` 置假并退回报废的 `/reports` 轮询：
				 * 老宿主没有这个端点，持续 404 刷屏没有意义。但**每次**都会重试探测
				 * （见下面的恢复逻辑），所以临时故障不会永久降级。
				 */
				async pollInteractions() {
					if (this.disposed) return;
					if (this.config.interactions?.enabled === false) return;
					try {
						const payload = await fetchInteractions(this.interactionCursor);
						if (this.disposed) return;
						if (typeof payload?.cursor === "number") {
							// 首次（游标是 `latest`）只**对齐水位**不记账；之后每轮都推进账本，
							// 这样"重开时从哪儿续"有一个跨刷新可用的答案。
							if (this.cursorSeeded) this.ledger.advance(payload.cursor);
							else {
								this.ledger.seed(payload.cursor);
								this.cursorSeeded = true;
							}
							this.interactionCursor = payload.cursor;
						}
						if (!this.interactionsAvailable) {
							this.interactionsAvailable = true;
							log("统一互动流已接入（审批 / 提问 / 汇报按时间播出）");
						}
						const incoming = Array.isArray(payload?.interactions) ? payload.interactions : [];
						if (incoming.length === 0) return;
						const settings = this.config.interactions ?? {};
						let queued = 0;
						for (const entry of incoming) {
							// 宿主已按类型过滤过一遍，客户端再按配置守一次：两头都判才能
							// 保证"关掉审批播报"这件事在任一端改配置都立刻生效。
							if (entry?.kind === "approval" && settings.announceApprovals === false) continue;
							if (entry?.kind === "question" && settings.announceQuestions === false) continue;
							// 需求②的硬防线：同一条内容（按 `kind:key`）一辈子只播一次。
							// 跨刷新有效 —— 刷新后游标可能把旧条目重新纳入窗口，但账本认得它。
							if (!this.ledger.claim(entry)) continue;
							// 追补窗口：太老的条目记账（在上面 claim 里已记）但不真出声。
							// 用户关页面一天再回来时，不至于被一次性念完整个队列。
							if (!withinCatchup(entry, { now: Date.now(), windowMs: this.catchupWindowMs() })) {
								log(`跳过过期互动（${String(entry?.kind ?? "")}，太老了不补播）`);
								continue;
							}
							this.interactionQueue.push(entry);
							queued += 1;
							if (entry?.kind === "report") {
								this.patch({ pendingDelegations: Math.max(0, this.snapshot.pendingDelegations - 1) });
							}
						}
						if (queued > 0) this.drainInteractions();
					} catch (error) {
						if (this.interactionsAvailable) {
							this.interactionsAvailable = false;
							warn("统一互动流不可用，回退到汇报轮询", error?.message ?? error);
						}
					}
				}

				/**
				 * 追补窗口长度（毫秒）。配置可覆盖；`0` = 关掉窗口限制（全部补播）。
				 * @returns 窗口长度。
				 */
				catchupWindowMs() {
					const raw = this.config.interactions?.catchupWindowMs;
					return Number.isFinite(raw) ? Math.max(0, raw) : undefined;
				}

				/**
				 * 逐条播报互动队列（发生先后 = `at` 升序 = 入队顺序）。
				 *
				 * ## 为什么必须串行 + 等 SPEAK_END
				 *
				 * 多项几乎同时发生时，如果各自直接 `speak()`，后一条会 cancel 前一条
				 * —— 用户只听到最后一句。这里用 `interactionDraining` 做互斥，一条
				 * 播完（含回声静默）再播下一条，保证"按时间先后依次呈现"。
				 */
				async drainInteractions() {
					if (this.disposed || this.interactionDraining) return;
					this.interactionDraining = true;
					try {
						while (this.interactionQueue.length > 0 && !this.disposed) {
							// 用户停用语音：队列留着，等下次 start() 再播，不擅自出声。
							if (this.machine.get() === STATES.OFF) break;
							const entry = this.interactionQueue.shift();
							const text = String(entry?.speech ?? "").trim();
							if (text === "") continue;

							this.patch({ lastReport: text, lastInteractionKind: String(entry?.kind ?? ""), answer: text });
							this.pushHistory("assistant", text);
							const wasSleeping = this.machine.get() === STATES.SLEEPING;
							if (wasSleeping) this.chime("wake");
							this.machine.send(EVENTS.AGENT_MESSAGE);
							this.echoGuard.remember(text);

							const generation = this.generation;
							try {
								await this.speaker.speak(text);
							} catch (error) {
								warn("互动播报失败", error?.message ?? error);
							}
							if (generation !== this.generation) break; // 期间被打断/休眠。
							this.machine.send(EVENTS.SPEAK_END);
							this.patch({ partial: "" });
							// 两条之间留一小段静默，避免连读糊成一句。
							await new Promise((resolve) => setTimeout(resolve, 400));
						}
					} finally {
						this.interactionDraining = false;
					}
				}

				/** ── 跨会话：列出 / 切换 / 新建（需求 ②） ───────────────────────── */

				/**
				 * 列出可以把语音指令投过去的会话（界面用）。
				 *
				 * 只读本地投影（不发请求）；要最新的宿主列表先 `refreshSessions()`。
				 * @returns `{ id, title, cwd, running, current }[]`，宿主顺序。
				 */
				listSessions() {
					return this.session.listTargets();
				}

				/**
				 * 拉一次宿主最新的会话列表（网络往返）。
				 *
				 * 与 `listSessions()` 分开，是因为两者代价差一个数量级：界面每次渲染
				 * 都读投影是免费的，而 refresh 要走一次 RPC。只有用户点"刷新"或
				 * 打开会话选择器时才该付这个代价。
				 * @returns 是否刷新成功。
				 */
				async refreshSessions() {
					const sessions = this.ctx.get("sessions");
					if (sessions === null || sessions === undefined || typeof sessions.refresh !== "function") return false;
					try {
						await sessions.refresh();
						return true;
					} catch (error) {
						warn("刷新会话列表失败", error?.message ?? error);
						return false;
					}
				}

				/**
				 * 把语音指令的目标切到另一个会话。
				 *
				 * ## 为什么必须先把界面切过去（`openInUi`）而不是切完就算了
				 *
				 * 用户是**用眼睛确认**目标换对了没有。切完不打开，界面上还停在
				 * 原来的会话，用户会以为没生效 —— 接着说的话进了新会话，自己却
				 * 在旧会话里找回答。所以这里切成功后**主动打开**那个会话。
				 *
				 * @param sessionId - 目标会话 id。
				 * @returns 是否切换成功。
				 */
				async switchSession(sessionId) {
					const ok = await this.session.switchTo(sessionId);
					if (!ok) {
						this.notice("没能切到那个会话，已退回当前会话。", "error");
						return false;
					}
					this.patch({ sessionId: this.session.sessionId });
					const label = this.listSessions().find((row) => row.id === this.session.sessionId)?.title ?? "";
					this.notice(`已切到「${label === "" ? String(this.session.sessionId).slice(0, 8) : label}」。`, "info");
					await this.session.ensure({ open: true });
					return true;
				}

				/**
				 * 新建一个会话并把语音目标切过去（"开个新会话派任务"）。
				 * @param options - `{ cwd, title }`；只填一项也可以。
				 * @returns 新会话 id，失败为 `null`。
				 */
				async newSession(options = {}) {
					const id = await this.session.createAndSwitch(options);
					if (id === null) {
						this.notice("新建会话失败，请稍后重试。", "error");
						return null;
					}
					this.patch({ sessionId: id });
					this.notice("已开一个新会话，接下来我说的都进这里。", "info");
					await this.session.ensure({ open: true });
					return id;
				}

				/**
				 * 切回常驻助手会话（跨会话聊完之后的"回家"）。
				 * @returns 是否成功。
				 */
				async backToAssistant() {
					const ok = await this.session.switchToPersistent();
					if (!ok) {
						this.notice("没找到常驻助手会话（可能未启用）。", "warn");
						return false;
					}
					this.patch({ sessionId: this.session.sessionId });
					this.notice("已切回小凤常驻助手。", "info");
					return true;
				}

				/** ── 提问应答（只做「模型提问」，不碰「工具审批」）────────────────── */

				/**
				 * 把问答桥接到当前会话的投影上（换会话/首次绑定后都要调）。
				 *
				 * @returns 是否接上（接不上不是错误：精简 profile 没装 `dsh-user-questions`）。
				 */
				attachQuestions() {
					const binding = this.session.binding;
					const sessionId = this.session.sessionId;
					if (binding === null || sessionId === null) return false;
					// 换绑时把"正在等答"清掉：那条问题是上一个会话的。
					this.patch({ question: null });
					return this.questions.attach(sessionId, binding);
				}

				/**
				 * 收到一个新问题：响提示音 → 念出来 → 进"等作答"状态。
				 *
				 * ## 为什么 `open` 状态也要念
				 *
				 * `open` = 工具调用还开着、界面问题卡还在。这时**我不能替用户答**
				 * （`answer()` 只收 `continued`），但用户可能根本没在看屏幕 ——
				 * 念出来仍然有价值（他可以抬手点界面）。念完在界面上标注
				 * "请到界面上确认"，让他知道该看哪儿。
				 *
				 * @param payload - `{ sessionId, callId, state, questions }`。
				 */
				async handleQuestion(payload) {
					if (this.disposed) return;
					// 用户已停用语音时不要突然开口。
					if (this.machine.get() === STATES.OFF) return;
					const questions = Array.isArray(payload?.questions) ? payload.questions : [];
					if (questions.length === 0) return;

					const spoken = questions
						.map((item, index) => speakQuestion(item, index, questions.length))
						.join(" ");
					this.patch({
						question: {
							callId: payload.callId,
							state: payload.state,
							spoken,
							questions: questions.map((item) => ({
								id: String(item?.id ?? ""),
								question: String(item?.question ?? ""),
								header: typeof item?.header === "string" ? item.header : "",
								multiSelect: item?.multiSelect === true,
								options: Array.isArray(item?.options)
									? item.options.map((option) => ({
											label: String(option?.label ?? ""),
											description: typeof option?.description === "string" ? option.description : "",
										}))
									: [],
							})),
						},
					});

					// 响一声再念：用户可能正在做别的事，直接开口会被当成环境噪声。
					if (this.config.answers?.chime !== false) this.chime("wake");
					// 提示文案按有无权威 state 分开说：
					//   - `continued`：前台窗口已结束，语音能答；
					//   - `open`（含 legacy 模式下的保守值）：界面问题卡还在，
					//     DSH 的 `answer()` 会拒绝语音代答 → 让用户去界面点。
					// 不把话说死成"只能去界面"：timed 模式下 `continued` 是能语音答的。
					this.notice(
						payload.state === "continued" ? "有个问题要确认，您可以直接说答案。" : "有个问题要确认，请在界面上选（我念给您听）。",
						"info",
					);

					// 念问题本身不改状态机 —— 提问与"思考中/播报中"是两条正交的线：
					// agent 可能还在跑（`thinking`），而问题只是它中途要的信息。
					// 复用播报器意味着会打断当前播报，这正是想要的（问题更紧急）。
					this.echoGuard.remember(spoken);
					try {
						await this.speaker.speak(spoken);
					} catch (error) {
						warn("念问题失败", error?.message ?? error);
					}
				}

				/**
				 * 尝试把一段识别文本当成"对当前问题的回答"。
				 *
				 * ## 为什么返回 `true` 就不再走指令路径
				 *
				 * 有未答问题时，用户说的话**几乎一定**是在回答问题 —— 这时把它当
				 * 新指令投给模型，会造成"模型和用户各说各话"（用户以为在答问，
				 * 模型以为来了新任务）。所以只要**匹配上了**就拦下来作答。
				 *
				 * 反过来，**没匹配上就交回指令路径**：用户可能就是在说一件别的事
				 * （"先别管那个，帮我看下 D 盘"）。宁可让这句话变成一条新指令，
				 * 也不能猜一个选项替他答 —— 猜错的代价是替用户做了决定。
				 *
				 * @param text - 识别文本。
				 * @returns 是否已当作回答处理（`true` = 不要再当指令提交）。
				 */
				async tryAnswerQuestion(text) {
					const question = this.snapshot.question;
					if (question === null || question === undefined) {
						this.lastAnswerAttempt = { text, outcome: "no-question" };
						return false;
					}
					const first = question.questions[0];
					if (first === undefined) {
						this.lastAnswerAttempt = { text, outcome: "no-question" };
						return false;
					}
					const matched = matchAnswer(text, first.options, first.multiSelect);
					if (matched.matched !== true) {
						// 没匹配上：不猜。交给上层当普通指令处理。
						this.lastAnswerAttempt = { text, outcome: "no-match" };
						this.notice("没听清您选哪个，再说一次，或到界面上点。", "info");
						return false;
					}

					// 多问题批次：一次只答一个会更稳（模型要的是每个问题各一条答案），
					// 但语音场景下用户通常只面对一个问题。多个问题时**只答第一个**，
					// 其余留给界面 —— 这比瞎猜其余几个安全。
					if (question.questions.length > 1) {
						// 必须凑齐每个问题各一条（DSH 的 `answer()` 会校验条数），
						// 凑不齐时如实退回界面，不硬造答案。
						this.lastAnswerAttempt = { text, outcome: "multi-question" };
						this.notice("这组问题有多个，请到界面上一次答完。", "info");
						return false;
					}
					const batch = { answers: [{ id: first.id, selected: matched.selected, ...(matched.custom === "" ? {} : { custom: matched.custom }) }] };

					// ## 为什么不再预先按 `state` 拒绝
					//
					// 原实现是 `if (state !== "continued") 直接拒绝`。那在**默认配置下
					// 等于永远拒绝** —— 因为 legacy 模式根本进不了投影（见 questions.js
					// 顶部），事件流给出的 `state` 恒为保守值 `open`。
					//
					// 改为**先尝试、再按结果如实回报**：DSH 的 `answer()` 只在 `continued`
					// 里找 callId（`dsh-user-questions/lib/index.js:560`），所以界面还能答时
					// 它会返回 `false` → 我们据此告诉用户"去界面点"。这样既不越权，
					// 又不会把"宿主其实能收"的情况一起挡掉。
					const result = await this.questions.submit(question.callId, batch);
					if (result.ok) {
						this.lastAnswerAttempt = { text, outcome: "submitted", selected: matched.selected };
						log(`已按语音作答（${matched.skip === true ? "跳过" : matched.selected.join("/") || matched.custom}）`);
						this.pushHistory("user", matched.skip === true ? "（跳过这个问题）" : text);
						this.notice("已提交您的回答。", "info");
						return true;
					}
					// `not-answerable` = 问题还挂在界面上（DSH 的护栏：界面能答时我插不进去）。
					// 这不是错误，是预期行为，用 info 而不是 error 播报。
					//
					// ## 为什么"没提交成功"也要返回 `true`（**已消费这句话**）
					//
					// 返回值表达的是"这句话**是不是在回答问题**"，不是"答上了没有"。
					// 匹配上了就说明用户在对那个问题说话 —— 这时若返回 `false`，
					// 上层会把「第一个」当成**新指令**投给模型，正是本函数开头要避免的
					// "模型和用户各说各话"。真实结果由 `lastAnswerAttempt()` 如实记录
					// （真机冒烟就是这么把这两种情况分开断言的）。
					if (result.reason === "not-answerable") {
						this.lastAnswerAttempt = { text, outcome: "not-answerable", selected: matched.selected };
						this.notice("这个问题请在界面上点选（界面还能答时语音不代答）。", "info");
						return true;
					}
					// 其余失败要如实说 —— 用户以为答了、实际没答是最坏的情形。
					this.lastAnswerAttempt = { text, outcome: "failed", reason: result.reason, selected: matched.selected };
					this.notice(`回答没能提交（${result.reason}），请到界面上确认。`, "error");
					return true;
				}

				/** ── 会话事件 ─────────────────────────────────────────────────── */

				/** turn 开始：确保处于"思考中"（含用户手打触发的 turn）。 */
				handleTurnStart() {
					const status = this.machine.get();
					if (status === STATES.ACTIVE || status === STATES.STANDBY || status === STATES.SLEEPING) {
						this.patch({ answer: "" });
					}
				}

				/**
				 * turn 结束：把回答念出来，或按原因如实收尾。
				 *
				 * 休眠中被唤醒的情形（需求 5）正是走这里：
				 * `machine.send(AGENT_MESSAGE)` 让状态从 `sleeping` 直接进 `speaking`，
				 * 于是先响提示音、再播报，播完回到 `active`（**正在听**）等用户继续。
				 *
				 * ## 播完的落点是「正在听」，不是「待机」（本轮修复）
				 *
				 * `SPEAK_END` 现在迁到 `ACTIVE`：助手说完就直接进入可续话的听写态，
				 * 用户接着说话即可 —— **不必每轮重新喊唤醒词**。收尾交给 `active` 里的
				 * 休眠计时（`sleep.idleTimeoutMs`，默认 60s）：静默满 60 秒才休眠。
				 *
				 * 曾经的落点是 `standby`，而 `standby` **不参与**计时，于是症状是
				 * "每答完一轮都要重新唤醒、同时永远不休眠" —— 两个极端同时出现，
				 * 而且方向相反，光看状态名（`standby` 看起来挺正常）完全看不出问题。
				 *
				 * ## 三种"空 turn"必须分开对待（真机踩坑）
				 *
				 * turn 没有文字有三种成因，对用户的含义完全不同：
				 *
				 * | reason.kind | 真相 | 该怎么说 |
				 * |---|---|---|
				 * | `error` | 这一轮**失败了**（例如模型路由缺失） | 把错误说出来 |
				 * | `blocked` | 这一轮被**闸门拒了**，压根没跑（例如会话在归档集合里） | 说清是"没跑起来" |
				 * | 其它（如 `completed`） | **纯工具轮**：agent 只调了工具、没说话 | 静默收尾即可 |
				 *
				 * 早期只特判了 `error`，`blocked` 掉进"纯工具轮"分支 —— 等于把最严重的
				 * 故障伪装成正常（见下）。现在按 reason 三分流。
				 *
				 * ## 为什么 `blocked` 必须单独说（本项目最坏的一次失败模式）
				 *
				 * 本 profile 注册了 `ArchivedSessionGate`：会话一旦在
				 * `workspaceRegistry.archivedSessionIds` 里，**每一轮** `agent/pre-step`
				 * 都被 reject，`dsh-agent-loop` 于是记成
				 * `turn/end reason={"kind":"blocked"}` 并**不发起任何模型请求**。
				 *
				 * 关键坑在于：`prompt()` 的原始返回是 `{"ok":true,"value":{"accepted":true}}`
				 * —— **提交是成功的**。于是客户端这边"提交成功、状态回弹、界面无报错"，
				 * 看起来一切正常，只是永远没有回答。用户只能猜"是不是我没说清"。
				 *
				 * `blocked` 的具体成因（归档）由宿主半自愈
				 * （`lib/identity.js` 的 `ensureSessionNotArchived`），客户端这一层保证
				 * "万一还是发生了，用户一定看得见"。
				 *
				 * @param payload - `{ text, reason, turn }`。
				 */
				async handleTurnEnd(payload) {
					const text = typeof payload?.text === "string" ? payload.text.trim() : "";
					// 用户已停用语音时不要突然开口 —— 会话仍在订阅，事件照样会到。
					if (this.machine.get() === STATES.OFF) return;

					const reason = payload?.reason;
					const kind = reason !== null && typeof reason === "object" ? String(reason.kind ?? "") : "";
					const isError = kind === "error";
					if (text === "") {
						if (this.machine.get() === STATES.THINKING) {
							if (isError) {
								const detail = String(reason.error?.message ?? reason.error?.code ?? "未知原因");
								// 错误优先走统一错误出口：语音场景下用户不看屏幕，静默失败等于没发生。
								// 注意 fail() 会按状态发 ERROR 事件，这里就不再补 REPLY/SPEAK_END。
								this.fail(new Error(detail));
								return;
							}
							if (kind === "blocked") {
								// 这一轮被闸门拒了（最典型：常驻会话在归档集合里），根本没跑。
								// 见过 `blocked` 就等于见过"提交成功却永远没回答"，必须说出来。
								this.notice(
									"这一轮没跑起来（会话被系统拦下了，通常是常驻会话被归档）。可在界面点开会话确认，或重启 DSH 让插件自动解除归档。",
									"error",
								);
								this.machine.send(EVENTS.REPLY);
								this.machine.send(EVENTS.SPEAK_END);
								return;
							}
							// 纯工具轮（只调工具、没有文本）是正常路径。
							this.notice("这一轮没有可播报的文字。", "info");
							this.machine.send(EVENTS.REPLY);
							this.machine.send(EVENTS.SPEAK_END);
						}
						return;
					}

					const wasSleeping = this.machine.get() === STATES.SLEEPING;
					if (wasSleeping) this.chime("wake");
					this.machine.send(EVENTS.AGENT_MESSAGE);
					this.patch({ answer: text });

					// 记下"我即将说什么"，供回声抑制比对。
					//
					// 放在**播报之前**而不是之后，是为了覆盖被中途打断的情形：用户
					// 打断时播报器被 cancel，那句回答已经念出去一部分，尾音照样会被
					// 录回来；若等播报返回再记，那条记录就永远补不上。窗口只有 30s，
					// 提前一点点记不会误伤用户的新指令。
					this.echoGuard.remember(text);

					const generation = this.generation;
					const result = await this.speaker.speak(text);
					if (generation !== this.generation) return;
					if (result.spoken === false && result.reason === "empty") {
						this.machine.send(EVENTS.SPEAK_END);
						return;
					}
					this.pushHistory("assistant", text);
					this.patch({ partial: "" });
					this.machine.send(EVENTS.SPEAK_END);
				}

				/** ── 用户可调的操作 ───────────────────────────────────────────── */

				/** 让助手主动说一句（界面上的"试听"按钮）。 */
				async say(text) {
					unlockAudio();
					const content = String(text ?? "").trim();
					if (content === "") return;
					if (this.machine.get() === STATES.OFF) {
						// 试听不改变状态机，直接借用播报器。
						await this.speaker.speak(content);
						return;
					}
					this.machine.send(EVENTS.AGENT_MESSAGE);
					// 试听同样要登记：否则"试听"的内容被录回去会被当成用户指令。
					this.echoGuard.remember(content);
					await this.speaker.speak(content);
					this.machine.send(EVENTS.SPEAK_END);
				}

				/**
				 * 打断当前播报（用户主动）。
				 *
				 * 与"助手自然说完"区分开的是**语义**，不是目标状态：
				 *   - **自然说完**（`handleTurnEnd` 播完）→ 发 `SPEAK_END`，落到**正在听**，
				 *     接着说话即可（不必再喊唤醒词）；
				 *   - **用户点击打断** → 发 `WAKE`，同样落到**正在听**。
				 *
				 * 两者现在都进 `ACTIVE`（用户点那个正在说话的球，意思基本是"我要说"），
				 * 且都从 `SPEAKING` 出发 —— 所以都会走那 700ms 回声静默期：
				 * 无论哪种情况，外放余响都已经存在，不能立刻开麦。
				 */
				interrupt() {
					this.speaker.cancel();
					if (this.machine.get() === STATES.SPEAKING) this.machine.send(EVENTS.WAKE);
				}

				/** 停止当前 turn（在会话里点"停止"）。 */
				async cancelTurn() {
					this.speaker.cancel();
					await this.session.cancel();
					if (this.machine.get() === STATES.THINKING) this.machine.send(EVENTS.ERROR);
				}

				/**
				 * 记一条历史。
				 * @param role - `user` | `assistant`。
				 * @param text - 文本。
				 */
				pushHistory(role, text) {
					const history = [...this.snapshot.history, { role, text, time: Date.now() }].slice(-HISTORY_LIMIT);
					this.patch({ history });
				}

				/**
				 * 在界面上显示一条短提示。
				 * @param message - 文本。
				 * @param kind - `info` | `warn` | `error`。
				 */
				notice(message, kind = "info") {
					clearTimeout(this.noticeTimer);
					this.patch({ notice: message, noticeKind: kind });
					this.noticeTimer = setTimeout(() => this.patch({ notice: "" }), NOTICE_TTL_MS);
				}

				/**
				 * 统一错误出口：界面提示 + 状态回退。
				 * @param error - 任意错误。
				 */
				fail(error) {
					const message = String(error?.message ?? error);
					warn("语音链路错误", message);
					this.patch({ error: message });
					// 记下调用来源。语音场景里"回答念出来了、同时却报错"这种自相矛盾
					// 的状态必须能一眼定位到是哪条路径调进来的（prompt 被拒 / 错误轮 /
					// 引擎异常），否则只能靠猜。
					this.failLog.push({
						at: Date.now(),
						message: message.slice(0, 200),
						status: this.machine.get(),
						from: (new Error().stack ?? "").split("\n").slice(1, 5).map((line) => line.trim()).join(" <- "),
					});
					if (this.failLog.length > 8) this.failLog.shift();

					if (message === "mic-denied") {
						this.notice("麦克风被拒绝。请在浏览器地址栏允许麦克风后重试。", "error");
						this.machine.send(EVENTS.STOP);
						this.patch({ powered: false });
						return;
					}
					if (message === "prompt-rejected") {
						this.notice("指令没能送进会话，请稍后重试。", "error");
						this.machine.send(EVENTS.ERROR);
						return;
					}
					if (message === "asr-unreachable") {
						// 浏览器识别（Chrome/Edge 的 Web Speech）把音频送到**境外云端**
						// 做识别。受限网络下这条永远不通 —— 实测 `www.google.com` 超时。
						// 界面上原样抛 `speech-network` 等于没说：用户既不知道是网络，
						// 也不知道下一步能做什么。这里翻译成能照着做的话，并**主动**
						// 尝试换一条能用的路（若配置里有）。
						// 标的是**浏览器识别这个族**，而不是 `snapshot.engine`。
						//
						// 为什么不按当前引擎标：`asr-unreachable` 这个错误码**只可能**来自
						// `WebSpeechEngine`（`engines/webspeech.js` 独家抛出），来源是确定的；
						// 而 `snapshot.engine` 在启动早期可能是 `none`（还没定下来），
						// 拿它去标会把 "none" 记进死名单、真正该禁的 webspeech 反而漏掉。
						// 又因为 `engineFamily()` 会把 `webspeech-fallback` 归到
						// `webspeech`，标一次就覆盖了降级态。
						this.markEngineDead("webspeech");
						const switched = this.tryFallbackFromDeadEngine();
						this.notice(
							switched
								? `浏览器识别连不上识别服务（它依赖境外云端）。已自动改用「${this.engineLabel(this.snapshot.engine)}」。`
								: "浏览器识别连不上识别服务（它依赖境外云端）。请在设置里改用 dsh-ears 或上游 ASR 端点。",
							"error",
						);
						return;
					}
					this.notice(`语音出错：${message}`, "error");
					const status = this.machine.get();
					if (status === STATES.THINKING) this.machine.send(EVENTS.ERROR);
				}

				/** 引擎名 → 中文标签（与界面面板同一套词）。 */
				engineLabel(name) {
					return (
						{
							webspeech: "浏览器识别",
							"webspeech-fallback": "浏览器识别（已降级）",
							http: "上游转写",
							"http-fallback": "上游转写（已降级）",
							ears: "dsh-ears 转写",
							none: "无可用引擎",
						}[name] ?? name
					);
				}

				/**
				 * 引擎的**族名**：`webspeech-fallback` 与 `webspeech` 是同一个引擎的
				 * 两种标注（有没有降级），底层能力完全一样。
				 *
				 * 为什么必须归一：判断"这条路是不是已经确认不通"时若按字面比，
				 * 只把 `webspeech` 记进死名单、当前引擎却是 `webspeech-fallback` 时
				 * 就认不出，回退时又会把死引擎选回来。
				 * @param name - 引擎名。
				 * @returns 族名。
				 */
				engineFamily(name) {
					return String(name).replace(/-fallback$/, "");
				}

				/** 记下"这个引擎在这台机器上不可用"，供回退时跳过（按族归一）。 */
				markEngineDead(name) {
					this.deadEngines.add(this.engineFamily(name));
				}

				/**
				 * 从"已确认不可用"的引擎换到一条可用的路。
				 *
				 * 为什么需要它：`detectEars()` 在探测失败时会回退到
				 * `webSpeechAvailable() ? "webspeech" : ...` —— 只看**浏览器有没有这个 API**，
				 * 不看它**能不能真的工作**。于是受限网络下会出现"从 ears 退回 webspeech、
				 * 而 webspeech 恰好就是那个连不上服务的" —— 回退到一个已知坏掉的引擎，
				 * 用户再说话又是同一条报错。
				 *
				 * 候选按可靠性排序：dsh-ears（多后端，确认可用才选）→ 上游 HTTP → 其余。
				 * @returns 是否真的换了。
				 */
				tryFallbackFromDeadEngine() {
					if (!this.deadEngines.has(this.engineFamily(this.snapshot.engine))) return false;
					// `ears` 的可否用是异步探测出来的，这里只能信 `earsAvailable` 这个结论；
					// 贸然切过去会与 `detectEars()` 的失败回退形成来回横跳。
					if (this.earsAvailable && !this.deadEngines.has("ears")) {
						this.swapEngine("ears");
						return true;
					}
					for (const name of ["http", "http-fallback", "webspeech", "webspeech-fallback"]) {
						if (this.deadEngines.has(this.engineFamily(name))) continue;
						if (!this.engineUsable(name)) continue;
						this.swapEngine(name);
						return true;
					}
					return false;
				}

				/**
				 * 某个引擎"看起来能用吗"（纯本地判据，不打网络）。
				 * @param name - 引擎名。
				 * @returns 是否可用作回退目标。
				 */
				engineUsable(name) {
					if (this.deadEngines.has(this.engineFamily(name))) return false;
					if (name === "webspeech" || name === "webspeech-fallback") return webSpeechAvailable();
					if (name === "http" || name === "http-fallback") return this.config.asr.httpReady && httpAsrAvailable();
					if (name === "ears") return this.earsAvailable === true;
					return false;
				}

				/** 释放所有资源。 */
				dispose() {
					this.disposed = true;
					this.stopReportPolling();
					clearTimeout(this.idleTimer);
					clearTimeout(this.noticeTimer);
					clearTimeout(this.echoTimer);
					this.turnGate.dispose();
					this.engine.stop();
					this.speaker.cancel();
					// 先释放问答桥再释放会话：桥持有会话投影的订阅，反过来会留下
					// 一个指向已释放 binding 的回调（下次变更时在里面读空值）。
					this.questions.dispose();
					this.session.dispose();
					this.listeners.clear();
				}
			}

			__exports({ VoiceController });
		});

		__def("core/echo.js", (__exports, __req) => {
			/**
			 * 回声抑制：识别到的话若"就是助手自己刚说的"，一律丢弃。
			 *
			 * ## 它防的是什么
			 *
			 * 这是"助手自说自话"的**声学入口**，闭环长这样：
			 *
			 * ```
			 * 模型回答 ─▶ TTS 播报 ─▶ 扬声器出声
			 *                  ▲              │
			 *                  │              ▼
			 *             提交给模型 ◀── 麦克风录到（自己念的话）
			 * ```
			 *
			 * 一旦成环，助手就会一轮一轮地"回应自己"，看起来像自言自语、停不下来。
			 * 三个环节都可能漏：Web Speech 的 `continuous` 模式会一直听；
			 * `speechSynthesis.onend` 在音频真正放完前就可能触发；外放设备有余响。
			 *
			 * 光靠"播报时关麦"是不够的 —— 关麦只覆盖**播报期间**，
			 * 而回声常出现在 `onend` 之后的那几百毫秒里。所以再加一道**文本级**防线：
			 * 把助手最近说过的话记下来，识别结果要是跟它高度重合，就当回声丢掉。
			 *
			 * ## 判据为什么用"归一化包含"而不是精确相等
			 *
			 * 识别器转写自己念的话时，必然有字差：标点丢失、同音字替换
			 * （"磁盘" → "词盘"）、断句合并。精确相等一条都挡不住。
			 * 所以先把两边的标点、空白、常见同音字全部归一化，再做**双向包含**判断：
			 * 转写里含（被归一化后的）原句、或原句含转写（只录到半句），都算回声。
			 *
			 * ## 为什么还要长度门槛
			 *
			 * 短文本会被大量误判："好"、"对"、"继续" 既是助手常说的，也是用户常说的。
			 * 所以设一个最小长度（默认 4 个字符）：短句一律放行，宁可漏挡也不误杀
			 * —— 误杀的代价是"用户说话没反应"，比偶尔的自说自话更让人困惑。
			 */
			const { ECHO_WINDOW_MS } = __req("core/constants.js");

			/** 判定为回声所需的最小归一化长度（字符）。低于此长度不参与比对。 */
			const MIN_ECHO_LENGTH = 4;

			/**
			 * 常见同音/近音混淆对（识别器转写时的典型错法）。
			 *
			 * 只收"高频且字形不同"的：形近字本身已被下面的字符归一化覆盖，
			 * 这里补的是**读音相同但写法无关**的情况。
			 */
			const HOMOPHONE_PAIRS = [
				["文件夹", "文件加"],
				["重启", "从启"],
				["登录", "登陆"],
				["部署", "布署"],
				["报错", "报措"],
				["代码", "待码"],
				["内存", "内层"],
				// 盘符：中文识别几乎必然把字母盘符写成汉字，且写法不统一。
				// 这组在排障"自己念完又自己答"时命中率很高 —— 助手念"D 盘"，
				// 麦克风录回来成了"词盘/地盘/第盘"，不归一化就判成两句话，
				// 回声照样被提交上去。
				//
				// 注意「词盘」这类变体是**有歧义**的（也可能是"磁盘"的误写）。
				// 一个变体只能指向一个规范形，否则后写的会覆盖先写的；
				// 这里按"盘符误写更常见"取舍，牺牲一点"磁盘"的召回。
				["d盘", "词盘"],
				["d盘", "地盘"],
				["d盘", "第盘"],
				["c盘", "西盘"],
				["e盘", "一盘"],
			];

			/**
			 * 归一化：去标点空白符号、统一小写、抹平常见同音错写。
			 *
			 * @param text - 原始文本。
			 * @returns 归一化后的字符串（可能为空串）。
			 */
			function normalizeForEcho(text) {
				if (typeof text !== "string") return "";
				let out = text.toLowerCase();
				for (const [canonical, variant] of HOMOPHONE_PAIRS) {
					out = out.split(variant).join(canonical);
				}
				// 去掉所有非字母数字与汉字（标点、空白、符号都不承载语义，
				// 而识别器恰恰最爱丢标点、加空白）。
				out = out.replace(/[^\p{Script=Han}a-z0-9]/gu, "");
				return out;
			}

			/**
			 * 判断一段转写是否是"回声"。
			 *
			 * @param transcript - 识别结果。
			 * @param spoken - 最近说过的话：`Array<{ text, at }>`（`at` 为时间戳）。
			 * @param options - `{ now, windowMs, minLength }`。
			 * @returns `{ echo, matched }`；`matched` 是命中的那条原话（便于排障）。
			 */
			function detectEcho(transcript, spoken, options = {}) {
				const now = typeof options.now === "number" ? options.now : Date.now();
				const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : ECHO_WINDOW_MS;
				const minLength = Number.isFinite(options.minLength) ? options.minLength : MIN_ECHO_LENGTH;

				const probe = normalizeForEcho(transcript);
				if (probe.length < minLength) return { echo: false, matched: "" };

				for (const entry of spoken) {
					if (entry === null || typeof entry !== "object") continue;
					if (typeof entry.at === "number" && now - entry.at > windowMs) continue;
					const candidate = normalizeForEcho(entry.text);
					if (candidate.length < minLength) continue;
					// 双向包含：只录到半句（原句含转写）也算回声。
					if (candidate.includes(probe) || probe.includes(candidate)) {
						return { echo: true, matched: String(entry.text).slice(0, 80) };
					}
				}
				return { echo: false, matched: "" };
			}

			/**
			 * 回声抑制器：维护"助手最近说过什么"的滑动窗口。
			 *
			 * 做成类而不是裸函数，是因为需要**跨调用累积**状态；同时把时间源与
			 * 窗口长度做成参数，方便测试里直接构造而非依赖真实时钟。
			 */
			class EchoGuard {
				/**
				 * @param options - `{ windowMs, minLength, now }`。
				 */
				constructor(options = {}) {
					this.windowMs = Number.isFinite(options.windowMs) ? options.windowMs : ECHO_WINDOW_MS;
					this.minLength = Number.isFinite(options.minLength) ? options.minLength : MIN_ECHO_LENGTH;
					this.now = typeof options.now === "function" ? options.now : () => Date.now();
					/** 最近说过的话（按时间升序，只保留窗口内的）。 */
					this.spoken = [];
					/** 诊断：被拦下的回声次数与最近一条。 */
					this.suppressed = 0;
					this.lastSuppressed = "";
				}

				/**
				 * 记下助手刚说（或即将说）的一段话。
				 * @param text - 播报的文本（建议传**清洗后**的实际朗读文本）。
				 */
				remember(text) {
					const value = typeof text === "string" ? text.trim() : "";
					if (value === "") return;
					this.spoken.push({ text: value, at: this.now() });
					this.prune();
				}

				/**
				 * 判断并消费一段转写。
				 *
				 * @param transcript - 识别结果。
				 * @returns `{ echo, matched }`；`echo === true` 时调用方必须丢弃该段。
				 */
				check(transcript) {
					const result = detectEcho(transcript, this.spoken, {
						now: this.now(),
						windowMs: this.windowMs,
						minLength: this.minLength,
					});
					if (result.echo) {
						this.suppressed += 1;
						this.lastSuppressed = String(transcript).slice(0, 80);
					}
					return result;
				}

				/** 丢弃超出窗口的记录。 */
				prune() {
					const now = this.now();
					this.spoken = this.spoken.filter((entry) => now - entry.at <= this.windowMs);
				}

				/** 清空（停止语音 / 用户手动休眠时调用）。 */
				reset() {
					this.spoken = [];
				}

				/** 诊断快照。 */
				inspect() {
					return {
						tracked: this.spoken.length,
						suppressed: this.suppressed,
						lastSuppressed: this.lastSuppressed,
						windowMs: this.windowMs,
						minLength: this.minLength,
					};
				}
			}

			__exports({ normalizeForEcho, detectEcho, EchoGuard });
		});

		__def("core/engines/ears.js", (__exports, __req) => {
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
			const { blobToPcm16Wav } = __req("core/audio/wav.js");
			const { warn } = __req("core/runtime.js");

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
			function earsNamespace(ctx) {
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
			function earsCandidates(ctx) {
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
			function earsContextShape(ctx) {
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
			function earsServiceNames(ctx) {
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
			function needsWavForEars(settings) {
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
			async function probeEars(ctx) {
				// 顺带把"哪条取法通了"记下来：形态不符时只看 `available:false`
				// 完全看不出差在哪（本项目反复踩"状态快照查不出方向"）。
				const paths = earsCandidates(ctx).map(({ from, value, error }) => ({
					from,
					hit: value !== undefined && value !== null,
					hasTranscribe: typeof value?.transcribe === "function",
					...(error === undefined ? {} : { error }),
				}));
				const shape = earsContextShape(ctx);
				const namespace = earsNamespace(ctx);
				if (namespace === null) return { available: false, backends: [], needsWav: false, paths, shape };
				try {
					// 顺带把"要不要转 WAV"问出来：探测本来就只跑一次，
					// 让每次录音都去远程问一遍设置纯属浪费。
					const needsWav = await resolveNeedsWav(namespace);
					if (typeof namespace.listAsrBackends !== "function") {
						// 没有 list 方法但能 transcribe：仍认为可用（版本差异）。
						return { available: true, backends: [], needsWav, paths, shape };
					}
					const backends = unwrap(await namespace.listAsrBackends());
					const list = Array.isArray(backends) ? backends : [];
					// 只要列表里存在「就绪」的后端就算可用；字段名跨版本可能是 ready / available。
					const ready = list.filter((item) => item?.ready === true || item?.available === true);
					return { available: list.length === 0 ? true : ready.length > 0, backends: list, needsWav, paths, shape };
				} catch (error) {
					warn("dsh-ears 探测失败，改用浏览器识别", error?.message ?? error);
					return { available: false, backends: [], needsWav: false, paths, shape };
				}
			}

			/**
			 * 构造一个走 dsh-ears 的 `recognize` 函数。
			 *
			 * @param ctx - 客户端 Cordis 上下文。
			 * @param options - `{ needsWav? }`：返回"当前后端是否要 WAV"的函数。
			 *   传函数而不是布尔值，是因为用户可能在会话中途去 dsh-ears 设置页改后端。
			 * @returns `(blob, language) => Promise<string>`。
			 */
			function makeEarsRecognizer(ctx, options = {}) {
				const shouldConvert = options.needsWav ?? (() => false);
				return async (blob) => {
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

			__exports({ earsNamespace, earsCandidates, earsContextShape, earsServiceNames, needsWavForEars, probeEars, makeEarsRecognizer });
		});

		__def("core/engines/http.js", (__exports, __req) => {
			/**
			 * 引擎 B：本机 VAD 分段 + 外部转写。
			 *
			 * 「外部」有两种接法，共用同一套采集与分段逻辑：
			 *   - `recognize` 默认走本插件的 `/api/asr`（自带 OpenAI 兼容代理）；
			 *   - 传入其他 `recognize` 即可接 **dsh-ears 的远程 `transcribe`**
			 *     （见 `engines/ears.js`）—— 这样本插件不必自己实现 8 个 ASR 后端。
			 *
			 * ## 为什么不是"一直录、一直传"
			 *
			 * 那样既费流量又费钱（按秒计费的端点会哭），而且把静音片段传上去还会
			 * 拉高幻觉率 —— Whisper 一类模型在长静音上极爱编出"谢谢观看"。
			 *
			 * 所以先在本地做**语音活动检测（VAD）**，只把真正有人说话的片段切出来上传。
			 *
			 * ## 为什么用 MediaRecorder 而不是自己编码 WAV
			 *
			 * MediaRecorder 直接产出 webm/opus（或浏览器支持的任意容器），
			 * OpenAI 兼容端点普遍接受；自己把 Float32 转 WAV 要多写 40 行、多一次
			 * 内存拷贝，还容易在采样率上翻车。交给浏览器更稳。
			 *
			 * ## VAD 的判据
			 *
			 * 用 RMS 能量 + **自适应噪声地板**：环境噪声在 0.002–0.02 之间浮动，
			 * 写死阈值必然在某些房间失效。做法是维护一个滚动最小值作为地板，
			 * 起音阈值取 `max(绝对下限, 地板 × 2.5)`。
			 * 起音要连续 3 帧（150ms）确认，收音要连续 14 帧（700ms）静音才收尾 ——
			 * 前者防咳嗽/敲键盘误触发，后者防句中换气被切断。
			 */
			const { UTTERANCE_SETTLE_MS } = __req("core/constants.js");
			const { transcribe, warn } = __req("core/runtime.js");

			/** 绝对能量下限（经验值：安静房间底噪约 0.002–0.006）。 */
			const RMS_FLOOR = 0.008;

			/** 起音确认帧数与收音确认帧数。 */
			const ONSET_FRAMES = 3;
			const HANGOVER_FRAMES = 14;

			/** VAD 采样间隔（毫秒）。 */
			const TICK_MS = 50;

			/** 太短的片段直接丢弃（小于这个字节数基本是噪声）。 */
			const MIN_BLOB_BYTES = 2000;

			/** 探测本引擎的前置条件。 */
			function isAvailable() {
				return (
					typeof globalThis.navigator?.mediaDevices?.getUserMedia === "function" &&
					typeof globalThis.MediaRecorder === "function"
				);
			}

			/** 基于 VAD 分段 + 外部转写的引擎。 */
			class HttpAsrEngine {
				/**
				 * @param options - `{ language, maxSegmentMs, recognize?, onPartial, onFinal, onError, onClose }`。
				 *   `recognize(blob, language) => Promise<string>`；缺省走本插件 `/api/asr`。
				 */
				constructor(options) {
					this.options = options;
					this.recognize = options.recognize ?? ((blob, language) => transcribe(blob, language).then((r) => r?.text ?? ""));
					this.wanted = false;
					this.stream = null;
					this.context = null;
					this.analyser = null;
					this.buffer = null;
					this.timer = null;
					this.recorder = null;
					this.chunks = [];
					this.segmentStart = 0;
					this.loudFrames = 0;
					this.quietFrames = 0;
					this.inSpeech = false;
					this.busy = false;
					this.noiseFloor = RMS_FLOOR / 2;
				}

				/** 开始监听。 */
				async start() {
					if (this.wanted) return;
					this.wanted = true;
					try {
						await this.open();
					} catch (error) {
						this.wanted = false;
						this.options.onError?.(error);
					}
				}

				/** 打开麦克风并启动 VAD 循环。 */
				async open() {
					const stream = await globalThis.navigator.mediaDevices.getUserMedia({
						audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
					});
					if (!this.wanted) {
						for (const track of stream.getTracks()) track.stop();
						return;
					}
					this.stream = stream;
					const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
					this.context = new Ctor();
					const source = this.context.createMediaStreamSource(stream);
					this.analyser = this.context.createAnalyser();
					this.analyser.fftSize = 1024;
					this.analyser.smoothingTimeConstant = 0.4;
					source.connect(this.analyser);
					this.buffer = new Float32Array(this.analyser.fftSize);
					this.timer = setInterval(() => this.tick(), TICK_MS);
				}

				/** 停止监听并释放设备。 */
				stop() {
					this.wanted = false;
					clearInterval(this.timer);
					this.timer = null;
					this.abortSegment();
					if (this.stream !== null) {
						for (const track of this.stream.getTracks()) track.stop();
						this.stream = null;
					}
					if (this.context !== null) {
						this.context.close().catch(() => {});
						this.context = null;
					}
					this.analyser = null;
					this.buffer = null;
					this.options.onClose?.();
				}

				/**
				 * 一帧 VAD 判定。
				 */
				tick() {
					if (!this.analyser || !this.buffer) return;
					this.analyser.getFloatTimeDomainData(this.buffer);
					let sum = 0;
					for (let i = 0; i < this.buffer.length; i += 1) sum += this.buffer[i] * this.buffer[i];
					const rms = Math.sqrt(sum / this.buffer.length);

					// 噪声地板：只用"安静帧"更新，且缓慢下降，避免把说话音量当底噪。
					if (rms < this.noiseFloor) this.noiseFloor = this.noiseFloor * 0.98 + rms * 0.02;
					else this.noiseFloor = this.noiseFloor * 0.9995 + Math.min(rms, this.noiseFloor * 3) * 0.0005;

					const threshold = Math.max(RMS_FLOOR, this.noiseFloor * 2.5);

					if (!this.inSpeech) {
						if (rms > threshold) {
							this.loudFrames += 1;
							if (this.loudFrames >= ONSET_FRAMES) this.beginSegment();
						} else {
							this.loudFrames = 0;
						}
						return;
					}

					// 已在说话中：检查收音，或超过单段上限强制切段。
					if (rms < threshold * 0.7) this.quietFrames += 1;
					else this.quietFrames = 0;

					const duration = Date.now() - this.segmentStart;
					const reachedHangover = this.quietFrames >= HANGOVER_FRAMES;
					const reachedLimit = duration >= this.options.maxSegmentMs;
					if (reachedHangover || reachedLimit) this.endSegment();
				}

				/** 开始一段录音。 */
				beginSegment() {
					if (this.busy || this.recorder !== null) return;
					this.inSpeech = true;
					this.quietFrames = 0;
					this.loudFrames = 0;
					this.segmentStart = Date.now();
					this.chunks = [];
					try {
						this.recorder = new globalThis.MediaRecorder(this.stream, { mimeType: this.pickMimeType() });
					} catch (error) {
						warn("无法创建 MediaRecorder", error);
						this.inSpeech = false;
						return;
					}
					this.recorder.ondataavailable = (event) => {
						if (event.data && event.data.size > 0) this.chunks.push(event.data);
					};
					this.recorder.onstop = () => this.onSegmentReady();
					this.recorder.start();
				}

				/** 结束当前段。 */
				endSegment() {
					this.inSpeech = false;
					this.quietFrames = 0;
					const recorder = this.recorder;
					if (recorder === null) return;
					this.recorder = null;
					try {
						recorder.stop();
					} catch {
						// 已经停了。
					}
				}

				/** 丢弃当前段（停止监听时用）。 */
				abortSegment() {
					this.inSpeech = false;
					const recorder = this.recorder;
					this.recorder = null;
					this.chunks = [];
					if (recorder !== null) {
						recorder.onstop = null;
						recorder.ondataavailable = null;
						try {
							recorder.stop();
						} catch {
							// 忽略。
						}
					}
				}

				/** 选一个当前浏览器支持的容器。 */
				pickMimeType() {
					const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
					for (const candidate of candidates) {
						if (globalThis.MediaRecorder.isTypeSupported?.(candidate)) return candidate;
					}
					return "";
				}

				/** 一段录完：上传转写。 */
				async onSegmentReady() {
					const chunks = this.chunks;
					this.chunks = [];
					if (chunks.length === 0) return;
					const blob = new Blob(chunks, { type: chunks[0].type || "audio/webm" });
					if (blob.size < MIN_BLOB_BYTES) return;

					this.busy = true;
					this.options.onPartial?.("（识别中…）");
					try {
						const text = await this.recognize(blob, this.options.language ?? "zh-CN");
						const trimmed = typeof text === "string" ? text.trim() : "";
						if (trimmed !== "") this.options.onFinal?.(trimmed);
					} catch (error) {
						warn("转写失败", error);
						this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
					} finally {
						this.busy = false;
						this.options.onPartial?.("");
					}
				}
			}

			__exports({ isAvailable, HttpAsrEngine });
		});

		__def("core/engines/webspeech.js", (__exports, __req) => {
			/**
			 * 引擎 A：浏览器 Web Speech API（零配置）。
			 *
			 * ## 能力与代价
			 *
			 * 走浏览器内置的流式识别（Chrome/Edge 背后是云端服务）。好处是**零配置、
			 * 零模型下载、连续识别、带中间结果**；代价是依赖浏览器实现，识别质量与
			 * 网络状况挂钩，且部分环境（无语音服务的 Chromium 构建）根本不可用。
			 *
			 * 所以 `isAvailable()` 必须显式探测，不可用时要让上层换引擎或告知用户 ——
			 * 静默失败会表现为"喊了没反应"，用户无从判断是自己声音小还是功能坏了。
			 *
			 * ## 三个必须处理的坑
			 *
			 * 1. **自动停止**：`continuous: true` 在 Chrome 上仍会因静默超时结束会话。
			 *    必须在 `onend` 里重启，否则待机几分钟后唤醒词就失效了。
			 * 2. **重启风暴**：若无条件重启，遇到权限被拒会无限循环刷错误。
			 *    用指数退避 + 次数上限。
			 * 3. **结果拼接**：`event.results` 里既有最终结果也有中间结果，
			 *    必须按 `resultIndex` 增量拼接，否则会出现"那句话被重复念两遍"。
			 */
			const { UTTERANCE_SETTLE_MS } = __req("core/constants.js");
			const { warn } = __req("core/runtime.js");

			/** 重启退避的起始与上限（毫秒）。 */
			const RESTART_MIN_MS = 300;
			const RESTART_MAX_MS = 5000;

			/** 连续重启失败多少次后放弃（交给上层提示用户）。 */
			const RESTART_GIVE_UP = 6;

			/** 探测 Web Speech API 是否可用。 */
			function isAvailable() {
				return typeof globalThis.SpeechRecognition === "function" || typeof globalThis.webkitSpeechRecognition === "function";
			}

			/** 基于 Web Speech API 的识别引擎。 */
			class WebSpeechEngine {
				/**
				 * @param options - `{ language, onPartial, onFinal, onError, onClose }`。
				 */
				constructor(options) {
					this.options = options;
					this.recognition = null;
					/** 用户是否希望它一直听（stop() 后置 false）。 */
					this.wanted = false;
					/** 已确认的最终文本缓冲。 */
					this.finals = "";
					/** 当前中间结果。 */
					this.interim = "";
					/** 一句话结束的判定定时器。 */
					this.settleTimer = null;
					this.restartCount = 0;
					this.restartTimer = null;
					this.fatal = false;
				}

				/** 是否处于"想听"的状态。 */
				isListening() {
					return this.wanted;
				}

				/** 开始（或恢复）连续识别。 */
				start() {
					if (this.recognition !== null) {
						this.wanted = true;
						return;
					}
					const Ctor = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
					if (typeof Ctor !== "function") {
						this.options.onError?.(new Error("webspeech-unavailable"));
						return;
					}

					this.wanted = true;
					this.fatal = false;
					const recognition = new Ctor();
					recognition.lang = this.options.language ?? "zh-CN";
					recognition.continuous = true;
					recognition.interimResults = true;
					// 单次结果里也带上更多备选，便于未来做置信度过滤；当前只用第一个。
					recognition.maxAlternatives = 1;

					recognition.onresult = (event) => {
						this.restartCount = 0;
						let interim = "";
						for (let i = event.resultIndex; i < event.results.length; i += 1) {
							const result = event.results[i];
							const transcript = result[0]?.transcript ?? "";
							if (result.isFinal) this.finals += transcript;
							else interim += transcript;
						}
						this.interim = interim;
						this.options.onPartial?.(`${this.finals}${this.interim}`.trim());
						this.scheduleSettle();
					};

					recognition.onerror = (event) => {
						const code = String(event?.error ?? "unknown");
						// `no-speech` / `aborted` 是常态（静默、主动停止），不是故障。
						if (code === "no-speech" || code === "aborted") return;
						if (code === "not-allowed" || code === "service-not-allowed") {
							this.fatal = true;
							this.wanted = false;
							this.options.onError?.(new Error("mic-denied"));
							return;
						}
						if (code === "network") {
							// `network` = **连不上识别服务**。
							//
							// 这条曾经被当成瞬时抖动，于是走下面的通用重试：退避 300ms 起、
							// 翻倍到 5s，最多 6 次（累计约 9 秒）。问题是这条路要么通、
							// 要么**根本不通**（Chrome/Edge 的识别在境外云端，受限网络下
							// 永远连不上），重试 6 次的结果只是把同一条错误刷 6 遍，然后
							// 以 `speech-restart-exhausted` 永久失效 —— 用户看到的是刷屏，
							// 却读不到"为什么"。
							//
							// 所以归到**环境不可用**（与 `not-allowed` 同类）：一次性如实
							// 报告并停止，把"换一条能用的路"交给上层（它知道有没有别的引擎）。
							// 真遇到瞬时抖动，用户再点一次即可 —— 代价远小于刷屏。
							warn("浏览器识别服务不可达", code);
							this.fatal = true;
							this.wanted = false;
							this.options.onError?.(new Error("asr-unreachable"));
							return;
						}
						warn("识别器报错", code);
						this.options.onError?.(new Error(`speech-${code}`));
					};

					recognition.onend = () => {
						this.recognition = null;
						this.flushSettle();
						if (!this.wanted || this.fatal) {
							this.options.onClose?.();
							return;
						}
						// 自动重启（带退避）。
						this.restartCount += 1;
						if (this.restartCount > RESTART_GIVE_UP) {
							this.fatal = true;
							this.options.onError?.(new Error("speech-restart-exhausted"));
							this.options.onClose?.();
							return;
						}
						const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** (this.restartCount - 1));
						clearTimeout(this.restartTimer);
						this.restartTimer = setTimeout(() => {
							if (this.wanted && this.recognition === null) this.start();
						}, delay);
					};

					this.recognition = recognition;
					try {
						recognition.start();
					} catch (error) {
						// 重复 start() 会抛 InvalidStateError，属正常竞态。
						if (String(error?.name ?? "") !== "InvalidStateError") {
							warn("识别器启动失败", error);
							this.options.onError?.(error);
						}
					}
				}

				/** 停止识别并释放麦克风。 */
				stop() {
					this.wanted = false;
					clearTimeout(this.restartTimer);
					this.restartTimer = null;
					this.flushSettle();
					const recognition = this.recognition;
					this.recognition = null;
					if (recognition !== null) {
						try {
							recognition.onend = null;
							recognition.stop();
						} catch {
							// 已经停了。
						}
					}
				}

				/**
				 * 重置文本缓冲（每次拿到一句最终结果后由上层调用）。
				 */
				reset() {
					this.finals = "";
					this.interim = "";
				}

				/** 排一次"这句话说完了"的判定。 */
				scheduleSettle() {
					clearTimeout(this.settleTimer);
					this.settleTimer = setTimeout(() => this.flushSettle(), UTTERANCE_SETTLE_MS);
				}

				/**
				 * 立即结算当前缓冲，作为一句最终文本抛给上层。
				 *
				 * 判据：非空白。文本本身不做任何清洗 —— 清洗是润色层的职责，
				 * 引擎越"笨"越好，这样换引擎时上层行为不变。
				 */
				flushSettle() {
					clearTimeout(this.settleTimer);
					this.settleTimer = null;
					const text = `${this.finals}${this.interim}`.trim();
					this.finals = "";
					this.interim = "";
					if (text !== "") this.options.onFinal?.(text);
				}
			}

			__exports({ isAvailable, WebSpeechEngine });
		});

		__def("core/expert-commands.js", (__exports, __req) => {
			/**
			 * 专家管理语音命令解析（V1.7，纯函数，可单测）。
			 *
			 * ## 为什么在润色前、用规则而不是 LLM
			 *
			 * 命令是**结构化操作**（增删改查 + 参数），LLM 润色会把"删除专家 coder"
			 * 改写成"帮我删掉 coder 这位专家"这类自然语言，反而丢失结构。所以在
			 * `runCommand` 里对**原始转录**先跑这个解析器：命中就直接执行、不进路由；
			 * 不命中才交给润色 + LLM 路由。规则解析对命令这种封闭语法既快又稳。
			 *
			 * ## 支持的口径（也写在 persona / README 里）
			 *   - 列表：「列出专家」「有哪些专家」「专家列表」「看看有哪些专家」
			 *   - 删除：「删除专家 coder」「移除专家 阿码」「删掉专家 X」
			 *   - 新增：「新增专家 化学，负责化学分析」「添加专家 X，专门做 Y」
			 *
			 * 新增时 id 由 label 派生（中文无法转拼音，用稳定哈希），播报里告诉用户
			 * 生成的 id；用户也可以说"id 叫 chem"显式指定。
			 */

			/** 列表命令 trigger（整句或包含）。 */
			const LIST_RE = /(列出|查看|看看|显示|报一下|说下).{0,4}(专家|团队|有哪些专家)|(有哪些|有些什么|多少个?)专家|专家列表|专家团队/;
			/** 删除命令：抽取 id/label。必须带"专家/worker"二字，避免把普通"删除 X"误判。 */
			const REMOVE_RE = /(?:删除|移除|删掉|去掉|撤销|踢掉)\s*(?:专家|worker)\s*[:：]?\s*(.+)$/i;
			/** 新增命令：抽取"叫什么 + 负责什么"。 */
			const ADD_RE = /(?:新增|添加|增加|新建|加一个|加个|创建)\s*(?:一个)?\s*(?:专家|worker)\s*[:：]?\s*(.+)$/i;

			/**
			 * 从 label 派生一个稳定的 ascii id（纯函数）。
			 *
			 * 中文没有拼音表，用 FNV-1a 32 位哈希取 6 位十六进制，前缀 `x-`。
			 * 用户在英文 label 上得到的 id 更可读（直接 slug），中文则得到 `x-xxxxxx`。
			 *
			 * @param label - 展示名。
			 * @returns 合法 id（匹配 `^[a-z0-9][a-z0-9_-]*$`）。
			 */
			function deriveExpertId(label) {
				const raw = String(label ?? "").trim();
				// 纯 ascii 名称直接 slug，可读。
				const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
				if (slug !== "" && /[a-z]/.test(slug)) return slug;
				// 含中文 → 稳定哈希。
				let h = 0x811c9dc5;
				for (let i = 0; i < raw.length; i++) {
					h ^= raw.charCodeAt(i);
					h = Math.imul(h, 0x01000193) >>> 0;
				}
				return `x-${h.toString(16).padStart(6, "0").slice(0, 6)}`;
			}

			/** 把中文数字/口语量词归一（目前只需去掉尾部的"这位/这个/专家"等）。 */
			function cleanName(text) {
				return String(text ?? "")
					.trim()
					.replace(/[,，。.!！?？、;；\s]+$/, "")
					.replace(/^(叫|名叫|id|ID|名称)\s*[:：]?\s*/i, "")
					.trim();
			}

			/**
			 * 解析一条语音命令。
			 *
			 * @param raw - 原始转录文本（润色前）。
			 * @returns `{ kind:"list" }` / `{ kind:"remove", id }` /
			 *   `{ kind:"add", expert:{id,label,description,persona,skills} }` / `null`。
			 */
			function parseExpertCommand(raw) {
				if (typeof raw !== "string") return null;
				const text = raw.trim();
				if (text === "") return null;

				// 列表优先（"列出专家"不该被删除/新增的正则误吃）。
				if (LIST_RE.test(text)) return { kind: "list" };

				// 删除。
				const removeMatch = text.match(REMOVE_RE);
				if (removeMatch) {
					let name = cleanName(removeMatch[1]);
					// "删除专家" 后面没内容 = 不是有效命令（可能是半句话）。
					if (name === "" || /^(列表|有哪些|有哪些专家)$/.test(name)) return null;
					// 显式 id："删除专家 id coder" / "删除专家 coder"。
					name = name.replace(/^id\s*[:：]?\s*/i, "").trim();
					if (name === "") return null;
					return { kind: "remove", id: name.toLowerCase().replace(/\s+/g, "-") };
				}

				// 新增。
				const addMatch = text.match(ADD_RE);
				if (addMatch) {
					const body = cleanName(addMatch[1] ?? "");
					if (body === "") return null;
					// 拆 "名称 + 描述"：连接词（负责/专门/…）作分隔，逗号可有可无。
					let name = body;
					let description = "";
					const split = body.match(/^(.+?)\s*[,，]?\s*(?:负责|专门(?:做|于)?|用于|主要|做|能|可以|用来|擅长)\s*(.+)$/);
					if (split) {
						name = cleanName(split[1]);
						description = cleanName(split[2]);
					} else {
						// 只有逗号、没有连接词："新增专家 化学，化学分析"。
						const comma = body.match(/^(.+?)\s*[,，]\s*(.+)$/);
						if (comma) {
							name = cleanName(comma[1]);
							description = cleanName(comma[2]);
						}
					}
					if (name === "") return null;
					// 兜底描述：没说清职责就给一句通用的，让专家能建起来（用户可后续补）。
					if (description === "") description = `${name}相关任务`;
					// 显式 id："id 叫 chem"。
					const idMatch = body.match(/\bid\s*(?:叫|是|[:：])?\s*([a-z0-9][a-z0-9_-]*)/i);
					const id = idMatch ? idMatch[1].toLowerCase() : deriveExpertId(name);
					return {
						kind: "add",
						expert: { id, label: name.slice(0, 40), description: description.slice(0, 200), persona: "", skills: [] },
					};
				}

				return null;
			}

			/**
			 * 把管理接口的执行结果格式化成一句播报。
			 *
			 * @param result - `{ ok, speech?, error?, applied? }`。
			 * @param kind - 命令类型（用于错误兜底文案）。
			 * @returns 中文播报串。
			 */
			function formatCommandSpeech(result, kind) {
				if (result?.ok === true) return result.speech ?? "好了。";
				const error = String(result?.error ?? "");
				const map = {
					"invalid-id": "专家名字只能用字母、数字和横线。",
					"reserved-id": "小凤是默认助手，不能删。",
					"label-required": "请说清楚新专家叫什么。",
					"description-required": "请说清楚新专家负责什么。",
					"no-expert-dir": "还没配置专家目录，暂时不能增删。",
				};
				return map[error] ?? (
					kind === "remove" ? "没删成，请说出要删的专家名字。" :
					kind === "add" ? "没加成功，请按「新增专家名字，负责什么」再说一遍。" :
					"没查到专家列表。"
				);
			}

			__exports({ deriveExpertId, parseExpertCommand, formatCommandSpeech });
		});

		__def("core/instance.js", (__exports, __req) => {
			/**
			 * 控制器单例。
			 *
			 * ## 为什么用模块级单例而不是 Cordis 服务
			 *
			 * 语音控制器需要被两处访问：槽里的 React 组件（渲染状态）与
			 * 全局快捷键（监听键盘）。它们分属不同 fiber，用一个模块级引用最直接。
			 * 若走 `ctx.reflect.provide`，就得处理"消费者早于提供者"的时序，
			 * 对一个自包含插件来说是多余复杂度。
			 *
			 * 插件卸载时 `clearController()` 会清掉引用，React 组件那边读到 `null`
			 * 会直接不渲染，不会访问到已释放的引擎。
			 */

			/** 当前控制器。 */
			let current = null;

			/**
			 * 设置控制器。
			 *
			 * 附带一个**开发调试钩子** `globalThis.__xfvDebug`：`ask(text)` 直接把指令
			 * 送进语音会话（跳过 ASR，但走完整的润色→prompt→事件→状态机链路），
			 * `snapshot()` 取当前状态。真浏览器验证（tools/cdp-probe.mjs）靠它做
			 * 端到端断言 —— 生产环境不删也没关系：它只暴露本来就要走公开 API 的
			 * 两个方法，且 `ask` 前必须已有一次用户手势（音频上下文解锁）。
			 *
			 * ## 排障三件套
			 *
			 * 语音链路最难查的是"症状指向错误方向"的故障（例如**回答念出来了、
			 * 界面却同时挂着一条报错**）。所以除了状态快照，另外暴露三条只读诊断线：
			 *
			 * | 钩子 | 回答的问题 |
			 * |---|---|
			 * | `prompts()` | `prompt()` 的原始返回是什么（提交到底被接受没有） |
			 * | `fails()` | 最近几次错误的**调用来源栈**（是谁调的 `fail()`） |
			 * | `hydration()` | 事件窗口的水合状态（历史是不是被当成新事件了） |
			 *
			 * 这三条一起看才能定案：只看状态会以为是"提交被拒"，
			 * 实际可能是"提交成功、但旧历史被重放"。全部只读、异常不外抛。
			 * @param controller - 语音控制器实例。
			 */
			function setController(controller) {
				current = controller;
				// 状态迁移轨迹。只读、有界（50 条）。
				//
				// 为什么需要它：状态迁移是**转瞬即逝**的。靠外部轮询快照去判断
				// "刚才是不是经过 speaking"，会在播报很短时整段漏掉 —— 于是
				// "播报期其实停在 thinking"这种 bug 能侥幸通过测试（真机上已经踩过）。
				// 记录轨迹后，"思考→播报→待机"这条链路可以被**确定性地**断言。
				const trace = [];
				controller.machine.subscribe((to, from, event) => {
					trace.push(`${from}>${to}:${event}`);
					if (trace.length > 50) trace.shift();
				});
				if (typeof globalThis !== "undefined") {
					globalThis.__xfvDebug = {
						// 复刻真实链路的前置状态：standby 先唤醒、off 先启动，
						// 否则状态机停在待机，COMMAND 迁移不生效。
						ask: async (text) => {
							const status = controller.getSnapshot().status;
							if (status === "off") controller.start();
							else if (status === "standby" || status === "sleeping") controller.wake();
							return controller.runCommand(String(text ?? ""));
						},
						steer: (text) => controller.session?.steer(String(text ?? "")),
						wake: () => controller.wake(),
						/**
						 * 模拟识别器产出一个**片段**（走真实的 `handleFinal`，含回声抑制
						 * 与轮次门槛）。`ask` 是"绕过识别直接提交"，`feed` 是"识别到了一段
						 * 话"—— 验证"静音满阈值才提交"必须用后者，因为门槛就在这条路径上。
						 */
						feed: (text) => controller.handleFinal(String(text ?? "")),
						/**
						 * 把一条**真实形状的会话事件**推进真实入口（`VoiceSession.handleEvent`）。
						 *
						 * ## 为什么必须有它
						 *
						 * 提问旁听的**主路径是事件流**，而单测里 `observeEvent` 是我直接调的
						 * —— 绕过了 `VoiceSession`。只测 `observeEvent` 等于"模块是对的，
						 * 但可能压根没被调用"，本项目已经栽过一次（`TurnGate` 没被
						 * `handleFinal` 调用，类单测照样全绿）。
						 *
						 * 这条与 `feed()` 是同源思路：`feed()` 走真实 `handleFinal`，
						 * `feedEvent()` 走真实 `handleEvent`。两者都**不许绕过接线层**。
						 *
						 * 注意：`tool/call` 事件在 `handleEvent` 里只触发提问旁听那一条
						 * （`switch` 里没有它的分支），所以喂进去不会污染 turn 状态。
						 *
						 * @param event - 会话事件（形状 `{ type, seq, time, data }`）。
						 * @returns 喂完之后问答桥的诊断快照（便于一步断言计数）。
						 */
						feedEvent: (event) => {
							controller.session.handleEvent(event);
							return controller.questions.inspect();
						},
						/** 立即提交当前这一轮（等同单击语音球），返回是否真的提交了。 */
						submit: () => controller.submitTurn(),
						/**
						 * 模拟"agent 回完话，回答落地"——直接走 `handleTurnEnd` 的**主路径**
						 * （`AGENT_MESSAGE` → 播报 → `SPEAK_END`）。
						 *
						 * ## 为什么必须单独有这么一个钩子
						 *
						 * 真机上跑回环时，`turn/end` 的 text 常常是**空的**：模型没配好、
						 * 或这一轮只调了工具。空文本走的是另一条分支（`notice` + `REPLY`），
						 * 于是"播报期归错状态"这个 bug **在真机上一条断言都碰不到** ——
						 * 它藏那么久的直接原因就是这个。要确定性地覆盖主路径，只能直接
						 * 把一段有文字的 turn/end 送进去。
						 *
						 * @param text - 回答文本。
						 * @returns 播报完成后 resolve。
						 */
						turnEnd: (text) =>
							controller.handleTurnEnd({ text: String(text ?? ""), reason: null, turn: null }),
						/**
						 * 直接把状态机拨到某个状态（**仅测试用**，不触发订阅者）。
						 *
						 * ## 为什么需要
						 *
						 * 要复现"回答落地时正处在思考中"这个场景，本来得先真的提交一轮、
						 * 等状态进 `thinking`。但真机上那一轮会**同时**产生一个空文本的
						 * `turn/end`（模型没配好、或只调了工具），它会抢先走完
						 * `reply → speak-end`，把状态带离 `thinking` —— 断言于是变成
						 * 一场和真实事件流的赛跑，偶发假失败。
						 *
						 * 把状态直接摆好再喂回答，可以**确定性地**只测控制器这一段接线，
						 * 不掺进会话层。会话层到控制器的那段接线由既有流程覆盖，各测各的。
						 *
						 * @param state - 目标状态名（`STATES` 里的值）。
						 * @returns 拨好之后的状态。
						 */
						forceState: (state) => {
							controller.machine.state = String(state ?? "");
							return controller.machine.get();
						},
						snapshot: () => controller.getSnapshot(),
						/**
						 * 状态迁移轨迹（最近的 `旧>新:事件` 列表）。
						 *
						 * 判"播报期到底停在哪个状态"必须看它 —— 轮询快照会漏掉短促的
						 * 中间状态，"播报归错状态"这类 bug 正是这样躲过测试的。
						 * @param count - 取尾部多少条（默认全部，最多 50）。
						 */
						trace: (count) => (typeof count === "number" && count > 0 ? trace.slice(-count) : trace.slice()),
						/** 最近几次错误的调用来源（排障"念出来了却又报错"）。 */
						fails: () => controller.failLog ?? [],
						/** 最近几次 `prompt()` 的原始返回（排障"提交到底被接受没有"）。 */
						prompts: () => controller.session?.promptLog ?? [],
						/**
						 * 轮次门槛状态（排障"说了半天没反应 / 提交太早"）。
						 *
						 * `pending=false` 且 `fragments=0` 却"感觉说了话"，
						 * 通常是那几句被回声抑制吃掉了 —— 对照 `echo()` 看。
						 */
						turn: () => controller.turnGate?.inspect() ?? null,
						/** 回声抑制状态：`suppressed` 大于 0 说明确实拦下了自说自话。 */
						echo: () => controller.echoGuard?.inspect() ?? null,
						/**
						 * dsh-ears 探测结论（排障"本地 Whisper 配了却不通"）。
						 *
						 * 为什么必须有这一条：`engine` 从 `ears` 掉到别的引擎时，
						 * 界面上球**照旧还在**、只是识别走了另一条路 —— 光看界面
						 * 完全看不出来。而"本地 Whisper 到底有没有接上"还要再分两层：
						 *
						 *   - `available`：`dshEars.transcribe` 通不通；
						 *   - `needsWav`：当前后端是不是**只吃 16 kHz PCM16 WAV** 的那种。
						 *
						 * 第二层是本项目最贵的一课：模型下好了、运行时也正常、
						 * 后端也选了本地 Whisper，但发出去的是 webm/opus，
						 * 宿主侧 `assertPcm16Wav` 直接拒 —— 报错还完全指不到"格式"。
						 * 留着这条，真机上一条断言就能确认"它知道该转 WAV"。
						 *
						 * @returns `{ available, needsWav, backends }`。
						 */
						ears: () => ({
							available: controller.earsAvailable,
							needsWav: controller.earsNeedsWav === true,
							backends: controller.earsBackends ?? [],
							// 各条取法的命中情况：命名空间取不到时靠它定位方向。
							paths: controller.earsPaths ?? [],
							// ctx 有没有那几个口：区分"没这个方法"与"服务还没注册上来"。
							shape: controller.earsShape ?? null,
						}),
						/**
						 * 再探一次 dsh-ears（排障"时序竞争"用）。
						 *
						 * 为什么需要：`detectEars()` 在 `apply` 之后**只跑一次**，
						 * 探不到就永久降级。如果真相是"本插件 apply 早于 dsh-ears
						 * 注册服务"，那"晚点再探一次能探到"就是这个假设的直接证据
						 * —— 而这条证据靠 `snapshot()` 永远看不出来。
						 *
						 * @returns 重探后的引擎名与探测结论。
						 */
						retryEars: async () => {
							await controller.detectEars();
							return { engine: controller.getSnapshot().engine, ears: globalThis.__xfvDebug.ears() };
						},

						/**
						 * V1.7：当前状态快照（只读）。供真浏览器探针验证"命令是否被识别"
						 * —— routeVia / heard / lastReport 这些字段只在快照里，DOM 上不全有。
						 */
						snapshot: () => controller.getSnapshot(),

						// ── 跨会话（需求 ②）─────────────────────────────────────────
						//
						// 这四条都是控制器公开方法的**透传**，不额外暴露内部结构：
						// 验"切过去了"和"切完话真的进新会话"必须分开断言 ——
						// 前者只看 `sessionId`，后者要看 `prompts()` 里那条 prompt 的
						// 落点，而落点只能通过 `ask()` 真跑一轮才能确认。
						/** 列出可投喂的会话（本地投影，不发请求）。 */
						sessions: () => controller.listSessions(),
						/** 拉一次宿主最新列表（RPC）。 */
						refreshSessions: () => controller.refreshSessions(),
						/** 切到指定会话；返回是否成功。 */
						switchSession: (id) => controller.switchSession(String(id ?? "")),
						/** 新建会话并切过去；返回新 id 或 null。 */
						newSession: (options) => controller.newSession(options ?? {}),
						/** 切回常驻助手。 */
						backToAssistant: () => controller.backToAssistant(),
						/** 当前绑定的人类可读描述 + 原始 mode（断言用）。 */
						sessionTarget: () => ({
							...controller.session.describe(),
							mode: controller.session.mode,
							pinnedId: controller.session.pinnedId,
						}),
						// ── 提问应答（只做「模型提问」，不碰「工具审批」）──────────────
						//
						// 这几条让"念问题 → 语音作答 → 提交"能被真机验证。分开暴露
						// 而不是只给一个 `answer()`，是因为**每一步都可能单独坏**：
						// 桥没接上（`question()` 恒为 null）、匹配没命中（`tryAnswer`
						// 返回 false）、提交被拒（`submit` 的 reason）。合成一个方法的话，
						// 失败时只能看到"没生效"，不知道坏在哪一层。
						/** 当前等答的问题（`null` = 没有）。 */
						question: () => controller.getSnapshot().question,
						/**
						 * 问答桥是否已记下当前会话 id。
						 *
						 * 语义要读准：`attach(sessionId, binding)` **无条件**先记 `sessionId`
						 * 再去试投影，所以这条只说明"会话绑过了"，**不等于投影接上了**
						 * （投影在 `questionBridge().projectionAttached`）。
						 *
						 * 而"到底能不能收到问题"也**不看这两条** —— 主路径是事件流
						 * （`observeEvent`），它连 `attach` 都不需要。判"收到没有"要看
						 * `questionBridge()` 的 `known` / `announced`。
						 */
						questionsAttached: () => controller.questions.sessionId !== null,
						/**
						 * 问答桥的内部计数（排障"念不出来"到底是哪一层断的）。
						 *
						 * | 字段 | 含义 |
						 * |---|---|
						 * | `projectionAttached` | 投影是否接上（timed 模式才有意义） |
						 * | `known` | 事件流已发现的提问调用数 |
						 * | `announced` | 已播报的提问数 |
						 * | `answered` | 已提交作答数 |
						 * | `states` | 各 callId 的权威 state（只有 timed 投影会给） |
						 */
						questionBridge: () => controller.questions.inspect(),
						/**
						 * 把一段文本当成"对当前问题的回答"走一遍（**不发声、不改状态**）。
						 *
						 * 与 `ask()` 的区别：`ask()` 直接提交给模型；这条走
						 * `tryAnswerQuestion`（匹配 → 提交作答），用于验证匹配与提交。
						 * @param text - 模拟的识别文本。
						 * @returns 是否被当作回答处理。
						 */
						answerQuestion: (text) => controller.tryAnswerQuestion(String(text ?? "")),
						/**
						 * 最近一次"把文本当回答"的判定结果（排障"为什么没答上"）。
						 *
						 * `answerQuestion()` 只返回布尔，于是"没匹配上"和"匹配了但提交被拒"
						 * 在真机上**看起来一样** —— 本项目反复踩这个坑。这里把内部判定
						 * 摊开：`outcome` ∈ `no-question` / `no-match` / `multi-question` /
						 * `not-answerable` / `failed` / `submitted`。
						 * @returns `{ text, outcome, reason?, selected? }` 或 `null`。
						 */
						lastAnswerAttempt: () => controller.lastAnswerAttempt ?? null,
						/**
						 * 清掉"当前待答问题"（**仅测试用**）。
						 *
						 * 为什么需要：`answerWith` 读的是快照里的 `question`，喂过一条
						 * `tool/call` 之后它就非空了 —— 想测"无问题时如实报 `no-question`"
						 * 这条分支，就必须先能把它清掉。
						 */
						clearQuestion: () => {
							controller.patch({ question: null });
							return true;
						},
						/**
						 * 直接按选项作答（跳过文本匹配），用于验证提交链路本身。
						 * @param selected - 选项标签数组。
						 */
						answerWith: (selected) => {
							const current = controller.getSnapshot().question;
							if (current === null || current === undefined) return Promise.resolve({ ok: false, reason: "no-question" });
							const first = current.questions[0];
							if (first === undefined) return Promise.resolve({ ok: false, reason: "no-question" });
							return controller.questions.submit(current.callId, {
								answers: [{ id: first.id, selected: Array.isArray(selected) ? selected.map(String) : [] }],
							});
						},
						/**
						 * 模拟"助手刚念了一句话"，用于验证回声抑制。
						 * @param text - 刚播报的文本。
						 */
						remember: (text) => controller.echoGuard?.remember(String(text ?? "")),
						/**
						 * 事件窗口的水合状态（排障"历史被当成新事件")。
						 *
						 * 常驻 agent 的历史**不是**在 retain 时同步就位的：绑定时窗口可能
						 * 还是空的（水位线 = −1），随后历史整批灌入，于是旧的 `turn/end`
						 * 会被当成刚发生的事处理。
						 */
						hydration: () => {
							const session = controller.session;
							const binding = session?.binding;
							const snap = binding?.eventSource?.getSnapshot?.();
							const entries = snap?.entries ?? [];
							return {
								bindEntryCount: session?.bindEntryCount ?? null,
								cursorAtBind: session?.cursorAtBind ?? null,
								boundAt: session?.boundAt ?? null,
								floorTime: session?.floorTime ?? null,
								skippedHistory: session?.skippedHistory ?? null,
								cursorNow: session?.cursor ?? null,
								entryCountNow: entries.length,
								snapshotKeys: snap === null || typeof snap !== "object" ? null : Object.keys(snap),
								snapshotMeta: snap === null || typeof snap !== "object" ? null : safeMeta(snap),
							};
						},
						/**
						 * 事件窗口的原始条目（`seq` / `time` / `type`）。
						 *
						 * 用来判定"事件自带的 `time` 是不是可靠的过去/现在分界"：
						 * 若历史事件的 `time` 一律早于 `boundAt`，就可以用 `time` 做水位线，
						 * 不必依赖"绑定时窗口里有没有东西"这个不可靠的前提。
						 * @param count - 取尾部多少条（默认 60）。
						 */
						rawWindow: (count) => {
							const binding = controller.session?.binding;
							const entries = binding?.eventSource?.getSnapshot?.()?.entries ?? [];
							const limit = typeof count === "number" && count > 0 ? count : 60;
							return entries
								.slice(-limit)
								.filter((entry) => entry?.type === "event")
								.map((entry) => ({
									seq: entry.event?.seq ?? null,
									time: entry.event?.time ?? null,
									type: entry.event?.type ?? null,
									timeType: typeof entry.event?.time,
								}));
						},
						/**
						 * 播报账本（需求②）：已播到哪、记住了哪些内容、是不是真落盘了。
						 *
						 * ## 为什么必须暴露这条
						 *
						 * "刷新后不再重复播报"这件事**只有跨会话才观察得到** —— 单测里
						 * 建两次控制器可以覆盖逻辑，但真机上"到底有没有写进 localStorage"
						 * （隐私模式 / 配额满 / 被别的插件清了）只能靠这条看。
						 * `persistent: false` 就是那类静默降级的直接证据。
						 *
						 * @returns `{ ledger, seq }`。
						 */
						playback: () => ({
							ledger: controller.ledger?.snapshot?.() ?? null,
							seq: controller.seqWatermark?.snapshot?.() ?? null,
							interactionCursor: controller.interactionCursor ?? null,
							reportCursor: controller.reportCursor ?? null,
							interactionsAvailable: controller.interactionsAvailable === true,
						}),
						/**
						 * 清掉播报账本（**仅测试用**）：让"首次打开"这条路径可复现。
						 * @returns 清完之后的账本快照。
						 */
						resetPlayback: () => {
							controller.ledger?.clear?.();
							controller.seqWatermark?.clear?.();
							controller.interactionCursor = undefined;
							controller.reportCursor = undefined;
							controller.cursorSeeded = false;
							return globalThis.__xfvDebug.playback();
						},
						// 最近 40 条会话事件（type + 摘要），排障 turn 为何空转用。
						// 注意事件负载在 `data` 下（见 session.js handleEvent 的说明）。
						events: () => {
							const binding = controller.session?.binding;
							const snap = binding?.eventSource?.getSnapshot?.();
							const entries = snap?.entries ?? [];
							return entries
								.slice(-40)
								.filter((entry) => entry?.type === "event")
								.map((entry) => {
									const event = entry.event;
									const payload = event?.data !== null && typeof event?.data === "object" ? event.data : event;
									const brief =
										event?.type === "assistant/message"
											? `text=${(payload?.message?.content ?? [])
													.filter((block) => block?.type === "text")
													.map((block) => block.text)
													.join(" ")
													.slice(0, 120)}`
											: event?.type === "turn/end"
												? `reason=${JSON.stringify(payload?.reason ?? null)}`
												: event?.type?.startsWith("agent/inbox")
													? `data=${JSON.stringify(payload).slice(0, 400)}`
													: "";
									return `${event?.seq} ${event?.type} ${brief}`.trim();
								});
						},
					};
				}
			}

			/** 取控制器（可能为 `null`）。 */
			function getController() {
				return current;
			}

			/**
			 * 取事件窗口快照里与"水合进度"相关的浅层字段（只读、防异常、限长）。
			 * @param snapshot - `getSnapshot()` 的返回。
			 * @returns 精简后的键值（值一律转成字符串或数字）。
			 */
			function safeMeta(snapshot) {
				const meta = {};
				for (const key of Object.keys(snapshot)) {
					if (key === "entries") continue;
					const value = snapshot[key];
					const type = typeof value;
					meta[key] = type === "string" || type === "number" || type === "boolean" ? value : type;
				}
				return meta;
			}

			/** 清除引用（插件卸载时调用）。 */
			function clearController() {
				current = null;
				if (typeof globalThis !== "undefined" && "__xfvDebug" in globalThis) {
					delete globalThis.__xfvDebug;
				}
			}

			__exports({ setController, getController, clearController });
		});

		__def("core/ledger.js", (__exports, __req) => {
			/**
			 * 播报水位（客户端持久化）—— 需求②：让助手记住"已经播报到哪个位置"。
			 *
			 * ## 这一层解决什么
			 *
			 * 真机症状：助手前面汇报过的内容，**再次打开页面时又播报一遍**。
			 *
			 * 根因是水位**全在内存里**，刷新即归零：
			 *
			 * | 水位 | 位置 | 刷新后 |
			 * |---|---|---|
			 * | `interactionCursor` | controller | 归零 → 首帧种子 |
			 * | `reportCursor` | controller | 归零 → 首帧种子 |
			 * | `cursor`（会话 seq） | session | 归零 → 靠 `floorTime` 兜 |
			 * | `announced`（提问） | QuestionBridge | 归零 → 投影重放就重念 |
			 *
			 * 而服务端的队列（`reportQueue` / `interactionQueue`）**活在宿主进程里**，
			 * 页面刷新不会清空它。两条合起来就是"用户刷新一次，听到一遍旧的"。
			 *
			 * ## 为什么"首帧 seed 成 latest"不够
			 *
			 * 现有实现就是靠首帧 `after=latest` 跳过历史的。它挡得住"整批历史涌入"，
			 * 但有两个洞：
			 *
			 *   1. **同一毫秒 / 游标回退**：`latest` 只对齐到"服务端当前游标"，
			 *      而服务端游标是 `max(Date.now(), …)` —— 刷新发生在两次播报之间时，
			 *      已经把上次播报过的条目重新纳入增量窗口（真机上见过的表现是
			 *      "最后一条汇报又念一遍"）；
			 *   2. **降级双通道**：`/reports` 与 `/interactions` 是同一条汇报的两个
			 *      端点。首帧两端各拉一次，谁先到谁念 —— 于是同一条汇报有可能被念两遍
			 *      （代码里那句 `if (this.interactionsAvailable) return` 只在**第二轮**
			 *      之后才生效）。
			 *
			 * 所以这里做两件更硬的事：
			 *
			 *   - **持久化游标**（毫秒水位，跨刷新、跨 DSH 重启有效，因为是墙钟）；
			 *   - **持久化"已播过的 key 集合"** —— 同一条互动（按 `kind + key` 认）
			 *     无论从哪条通道、被投递几次，一辈子只播一次。
			 *
			 * ## 追补窗口
			 *
			 * 光有游标会带来反问题：用户关页面一整天，回来时水位停在一整天前，
			 * 服务端那 200 条队列会被一次性念完 —— 比重复播报更糟。
			 * 所以带一个**追补窗口**（默认 10 分钟）：比这个窗口老的条目**记账但不播**
			 * （游标照常推进），只有窗口内的才真念出来。
			 *
			 * ## 存储要有兜底
			 *
			 * `localStorage` 在隐私模式、配额满、非浏览器环境里都可能抛。任何一次
			 * 读写异常都不能让语音链路崩掉，所以 `createSafeStorage` 把全部操作包住，
			 * 失败时退化成**内存实现**（功能降级到"本次会话内有效"，绝不影响出声）。
			 */

			/** 存储键前缀（带版本号，将来换结构时不会读到老格式）。 */
			const PREFIX = "xfv:v1:";

			/**
			 * 追补窗口默认值（毫秒）。
			 *
			 * 10 分钟是"用户去倒了杯水回来"的量级：这个范围内的内容多半还没听到，
			 * 补播有价值；再老的补播就是噪音了（而且服务端队列本来也留不了那么久）。
			 */
			const CATCHUP_WINDOW_MS = 10 * 60 * 1000;

			/** 已播 key 的记忆条数上限（防止 localStorage 无界增长）。 */
			const LEDGER_LIMIT = 200;

			/** 游标合理性上限：超过"现在 + 5 分钟"的游标一律视为损坏。 */
			const CURSOR_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

			/**
			 * 纯内存的键值存储（`localStorage` 不可用时的兜底）。
			 *
			 * 有意做成与 `localStorage` 同形状（`getItem` / `setItem` / `removeItem`），
			 * 这样"有没有持久化"这件事对上层完全透明 —— 上层不需要写两条分支。
			 *
			 * @returns 存储对象。
			 */
			function memoryStorage() {
				const map = new Map();
				return {
					getItem: (key) => (map.has(key) ? map.get(key) : null),
					setItem: (key, value) => {
						map.set(key, String(value));
					},
					removeItem: (key) => {
						map.delete(key);
					},
				};
			}

			/**
			 * 取一个**不会抛**的存储。
			 *
			 * `localStorage` 的存在性本身就可能抛（某些环境的 `window` 代理），
			 * 所以连"取它"都要包在 try 里。拿不到就用内存实现。
			 *
			 * @param raw - 候选存储（默认 `globalThis.localStorage`）。
			 * @returns `{ storage, persistent, reason }`。
			 */
			function resolveStorage(raw) {
				let candidate = raw;
				if (candidate === undefined) {
					try {
						candidate = globalThis.localStorage ?? undefined;
					} catch {
						candidate = undefined;
					}
				}
				if (
					candidate !== undefined &&
					candidate !== null &&
					typeof candidate.getItem === "function" &&
					typeof candidate.setItem === "function"
				) {
					return { storage: candidate, persistent: true, reason: "" };
				}
				return { storage: memoryStorage(), persistent: false, reason: raw === undefined ? "no-local-storage" : "storage-unusable" };
			}

			/**
			 * 创建带容错与 JSON 编解码的存储门面。
			 *
			 * @param raw - 候选存储。
			 * @returns `{ read(key, fallback), write(key, value), drop(key), persistent, reason }`。
			 */
			function createSafeStorage(raw) {
				const { storage, persistent, reason } = resolveStorage(raw);
				return {
					/**
					 * 读一个 JSON 对象。
					 * @param key - 键。
					 * @param fallback - 读不到/坏了时的返回值。
					 * @returns 解析结果或 `fallback`。
					 */
					read(key, fallback) {
						try {
							const text = storage.getItem(key);
							if (typeof text !== "string" || text === "") return fallback;
							const parsed = JSON.parse(text);
							return parsed === null || typeof parsed !== "object" ? fallback : parsed;
						} catch {
							// 坏数据（用户手改 / 跨版本残留）当作"没有"，不抛。
							return fallback;
						}
					},
					/**
					 * 写一个 JSON 对象。
					 * @param key - 键。
					 * @param value - 值。
					 * @returns 是否写入成功。
					 */
					write(key, value) {
						try {
							storage.setItem(key, JSON.stringify(value));
							return true;
						} catch {
							// 配额满 / 隐私模式：记账失败不该影响播报本身。
							return false;
						}
					},
					/**
					 * 删除一个键。
					 * @param key - 键。
					 */
					drop(key) {
						try {
							storage.removeItem(key);
						} catch {
							// 删不掉也无所谓（下次读到坏值会走 fallback）。
						}
					},
					persistent,
					reason,
				};
			}

			/**
			 * 生成一条互动的"身份"（用于跨刷新去重）。
			 *
			 * 优先用服务端给的原生 id（汇报的 `key`/`jobId`、审批的 `id`、
			 * 提问的 `callId`）—— 那些是服务端保证唯一的东西。都没有时才退回
			 * 文本哈希，这样至少"同一句话不会念两遍"。
			 *
			 * @param entry - 互动条目。
			 * @returns 稳定字符串（空条目返回空串）。
			 */
			function entryIdentity(entry) {
				const kind = String(entry?.kind ?? "");
				const key = String(entry?.key ?? entry?.jobId ?? entry?.callId ?? "").trim();
				if (key !== "") return `${kind}:${key}`;
				const speech = String(entry?.speech ?? "").trim();
				if (speech === "") return "";
				return `${kind}:#${hashText(speech)}`;
			}

			/**
			 * 短文本哈希（FNV-1a 变体，32 位十六进制）。
			 *
			 * 只用来给"没有 id 的条目"一个稳定身份，不做加密用途 —— 所以不引 crypto
			 * （客户端 bundle 是同步求值，拿不到异步 API）。
			 *
			 * @param text - 文本。
			 * @returns 8 位十六进制串。
			 */
			function hashText(text) {
				const value = String(text ?? "");
				let hash = 2166136261;
				for (let index = 0; index < value.length; index += 1) {
					hash ^= value.charCodeAt(index);
					hash = Math.imul(hash, 16777619) >>> 0;
				}
				return hash.toString(16).padStart(8, "0");
			}

			/**
			 * 创建"播报账本"：持久化游标 + 已播 key 集合。
			 *
			 * @param options - `{ scope, storage, limit, now }`。
			 *   `scope` 让账本按助手实例隔离（多个 DSH_HOME 共用 origin 时不互相污染）。
			 * @returns 账本对象。
			 */
			function createPlaybackLedger(options = {}) {
				const store = createSafeStorage(options.storage);
				const scope = String(options.scope ?? "default").trim() || "default";
				const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : LEDGER_LIMIT;
				const storageKey = `${PREFIX}played:${scope}`;

				let cursor = 0;
				/** 已播 key（有序，超限从头部丢，保留最近的）。 */
				let keys = [];
				const seen = new Set();

				// 载入：坏数据一律当"没有记录"（宁可多播一次，也不要因为一条坏 JSON
				// 让助手从此再也不播报 —— 那是静默失效，最难查）。
				const loaded = store.read(storageKey, null);
				if (loaded !== null) {
					const savedCursor = Number(loaded.cursor);
					cursor = Number.isFinite(savedCursor) && savedCursor > 0 ? savedCursor : 0;
					// 游标"跑到未来"只可能是时钟回拨或数据被改坏 —— 重置，
					// 否则服务端永远没有 `at > cursor` 的条目，播报会彻底哑掉。
					const ceiling = (Number.isFinite(options.now) ? options.now : Date.now()) + CURSOR_FUTURE_TOLERANCE_MS;
					if (cursor > ceiling) cursor = 0;
					const savedKeys = Array.isArray(loaded.keys) ? loaded.keys : [];
					for (const item of savedKeys) {
						const value = String(item ?? "");
						if (value === "" || seen.has(value)) continue;
						seen.add(value);
						keys.push(value);
					}
					if (keys.length > limit) keys = keys.slice(-limit);
				}

				/** 落盘（每次变更后调一次；写入失败只是丢持久化，不影响本轮播报）。 */
				const flush = () => {
					store.write(storageKey, { cursor, keys: keys.slice(-limit) });
				};

				return {
					/** 已播到的时间水位（毫秒）。0 = 还没有记录。 */
					get cursor() {
						return cursor;
					},
					/** 记住的 key 条数（自省用）。 */
					get size() {
						return keys.length;
					},
					/**
					 * 对齐水位（**不播报**）。
					 *
					 * 用在"服务端当前游标"上：首次使用（本地无记录）时把水位推到
					 * 服务端当前位置，这样页面一打开不会把历史全念一遍。
					 *
					 * @param value - 服务端游标。
					 * @returns 是否真的写入了。
					 */
					seed(value) {
						const next = Number(value);
						if (!Number.isFinite(next) || next <= cursor) return false;
						cursor = next;
						flush();
						return true;
					},
					/**
					 * 推进水位（播报/记账之后调）。
					 * 只前进不后退 —— 服务端重启后游标归零，倒退会把旧条目重新纳入窗口。
					 * @param value - 服务端游标。
					 * @returns 是否真的写入了。
					 */
					advance(value) {
						const next = Number(value);
						if (!Number.isFinite(next) || next <= cursor) return false;
						cursor = next;
						flush();
						return true;
					},
					/**
					 * 该条是否还没播过（**会记账**）。
					 *
					 * 记账与判定合一，避免"判了没记"导致下一次又问一遍。
					 *
					 * @param entry - 互动条目。
					 * @returns `true` = 该播。
					 */
					claim(entry) {
						const id = entryIdentity(entry);
						if (id === "") return true; // 认不出身份就别拦（宁可多播，不可漏播）。
						if (seen.has(id)) return false;
						seen.add(id);
						keys.push(id);
						if (keys.length > limit) {
							const dropped = keys.splice(0, keys.length - limit);
							for (const value of dropped) seen.delete(value);
						}
						flush();
						return true;
					},
					/** 只读查询（不记账）。 */
					has(entry) {
						const id = entryIdentity(entry);
						return id === "" ? false : seen.has(id);
					},
					/**
					 * 自省快照（真机排障 / `__xfvDebug` 用）。
					 * @returns `{ scope, cursor, size, keys, persistent, reason }`。
					 */
					snapshot() {
						return { scope, cursor, size: keys.length, keys: keys.slice(-12), persistent: store.persistent, reason: store.reason };
					},
					/** 清空（仅测试/用户手动重置用）。 */
					clear() {
						cursor = 0;
						keys = [];
						seen.clear();
						store.drop(storageKey);
					},
				};
			}

			/**
			 * 创建"会话 seq 水位"存储（需求②的另一半）。
			 *
			 * ## 为什么会话那条也得持久化
			 *
			 * 会话事件的去重靠 `seq`（`session.js` 的水位线），而 `seq` **只在内存里**。
			 * 页面刷新后水位从"当前窗口最大 seq"重算 —— 注释里说过历史不一定在
			 * retain 时同步就位，窗口为空时水位是 −1，随后历史整批灌入，只剩
			 * `floorTime`（`绑定时刻 − 2s`）这道时间闸兜着。
			 *
			 * 时间闸有个洞：`event.time` **不是数字**时它整条被跳过 —— 而"跳过"的意思是
			 * **放行**（`if (time !== null && time < floorTime)`，`time` 为 null 直接不判）。
			 * 于是没有时间戳的历史事件会被当新事件处理，助手把旧回答又念一遍。
			 *
			 * 而 `seq` 是按会话单调的整数，**天生跨刷新可比** —— 比时间戳硬得多。
			 *
			 * @param options - `{ storage }`。
			 * @returns `{ read(sessionId), write(sessionId, seq), snapshot(), clear() }`。
			 */
			function createSeqWatermark(options = {}) {
				const store = createSafeStorage(options.storage);
				const storageKey = `${PREFIX}seq`;
				let marks = {};
				const loaded = store.read(storageKey, null);
				if (loaded !== null && loaded.marks !== null && typeof loaded.marks === "object") {
					for (const [key, value] of Object.entries(loaded.marks)) {
						const seq = Number(value);
						if (typeof key === "string" && key !== "" && Number.isFinite(seq)) marks[key] = seq;
					}
				}
				const flush = () => store.write(storageKey, { marks });

				return {
					/**
					 * 取某个会话"已处理到"的 seq。
					 * @param sessionId - 会话 id。
					 * @returns seq（没记录时 `null`）。
					 */
					read(sessionId) {
						const id = String(sessionId ?? "");
						const value = marks[id];
						return Number.isFinite(value) ? value : null;
					},
					/**
					 * 记下某个会话"已处理到"的 seq（只前进）。
					 * @param sessionId - 会话 id。
					 * @param seq - 序号。
					 * @returns 是否真的写入了。
					 */
					write(sessionId, seq) {
						const id = String(sessionId ?? "");
						const next = Number(seq);
						if (id === "" || !Number.isFinite(next) || next < 0) return false;
						const current = marks[id];
						if (Number.isFinite(current) && current >= next) return false;
						marks[id] = next;
						flush();
						return true;
					},
					/**
					 * 清掉某个会话的记录（换会话/会话被删时用）。
					 * @param sessionId - 会话 id。
					 * @returns 是否删掉了。
					 */
					drop(sessionId) {
						const id = String(sessionId ?? "");
						if (!(id in marks)) return false;
						delete marks[id];
						flush();
						return true;
					},
					/** 自省快照。 */
					snapshot() {
						return { marks: { ...marks }, persistent: store.persistent, reason: store.reason };
					},
					/** 清空（仅测试用）。 */
					clear() {
						marks = {};
						store.drop(storageKey);
					},
				};
			}

			/**
			 * 一条互动是否在**追补窗口**内（窗口内的才真播，更老的只记账）。
			 *
			 * @param entry - 互动条目（读 `at`）。
			 * @param options - `{ now, windowMs }`。
			 * @returns 是否该出声。
			 */
			function withinCatchup(entry, options = {}) {
				const windowMs = Number.isFinite(options.windowMs) ? Math.max(0, options.windowMs) : CATCHUP_WINDOW_MS;
				if (windowMs === 0) return true; // 显式关掉窗口 = 全都补播。
				const at = Number(entry?.at);
				if (!Number.isFinite(at)) return true; // 没有时间戳就不敢拦（宁可多播）。
				const now = Number.isFinite(options.now) ? options.now : Date.now();
				return now - at <= windowMs;
			}

			__exports({ CATCHUP_WINDOW_MS, LEDGER_LIMIT, memoryStorage, resolveStorage, createSafeStorage, entryIdentity, hashText, createPlaybackLedger, createSeqWatermark, withinCatchup });
		});

		__def("core/machine.js", (__exports, __req) => {
			/**
			 * 语音会话状态机（纯函数 + 极简订阅容器）。
			 *
			 * ## 为什么单独拆出来
			 *
			 * 语音助手的 bug 几乎都长在"状态跳错"上：休眠时还在听、播报完没回到待机、
			 * 用户在播报中插话结果两句叠在一起。这些都不是 IO 问题，是状态迁移问题。
			 * 把迁移表抽成纯函数后，可以脱离浏览器、脱离麦克风、脱离 DSH 直接跑测试。
			 *
			 * ## 迁移表怎么读
			 *
			 * `TRANSITIONS[当前状态][事件] = 下一个状态`。未列出的组合一律**保持原状态**
			 * （显式忽略），而不是抛错：语音链路上乱序事件是常态（识别器回调晚于
			 * 用户手动点击），一次抛错会打断整个链路。
			 *
			 * ## 几个刻意的决定
			 *
			 * - `standby` **不会**因空闲而休眠。需求是"一直在线待机"：待机是系统的
			 *   **静止态**（刚启用、或唤醒后 12s 没开口退回），不该自己往下走。
			 * - **播报结束后回 `active`（正在听），而不是 `standby`**。这是"不必重新
			 *   喊唤醒词"的落点：助手说完就直接进入可续话的听写态，用户接着说话即可
			 *   （含"不对，我是说…"这类纠正）。它由 `active` 里那 60s 静默计时收尾 ——
			 *   所以"播报完没语音输入 60 秒才休眠"这条需求在这里成立。
			 *
			 *   历史：这一格曾经指向 `standby`，结果是**每回答完一轮就要重新喊"小凤"**，
			 *   多轮对话被硬切成一句一唤醒。回 `standby` 会让计时**根本不武装**
			 *   （`onTransition` 进 `STANDBY` 只清计时、不重排），所以症状不是"早睡"
			 *   而是"永不睡、但必须重新唤醒" —— 两个极端都错，方向还相反。
			 * - `thinking` 收到 `idle` 也不休眠：模型可能正在跑一个长任务，
			 *   这时候睡掉会把回答丢掉（`turn/end` 事件随之被忽略）。
			 * - **`thinking` 必须能收 `agent-message`**：回答落地就是这条路
			 *   （`handleTurnEnd` → `AGENT_MESSAGE`）。漏了这格，播报期会一直卡在
			 *   「思考中」，播完的 `speak-end` 更是无处可去 —— 表现为助手说完后
			 *   状态再也不动、听不进下一句。这是把"播报"归错状态的那类经典 bug。
			 * - `sleeping` / `standby` 收到 `agent-message` 直接进 `speaking`：需求 5 的
			 *   "被 agent 消息唤醒后播报"，所以是**先播报**，播完同样落到 `active`
			 *   （用户可以直接接话）。这一条对所有来源统一 —— 无论播报是用户指令的
			 *   答复、还是 agent 主动推的消息。
			 */
			const { EVENTS, STATES } = __req("core/constants.js");

			/** 迁移表。 */
			const TRANSITIONS = {
				[STATES.OFF]: {
					[EVENTS.START]: STATES.STANDBY,
				},
				[STATES.STANDBY]: {
					[EVENTS.WAKE]: STATES.ACTIVE,
					[EVENTS.STOP]: STATES.OFF,
					[EVENTS.SLEEP]: STATES.SLEEPING,
					// 待机时也可能收到 agent 消息（例如后台任务跑完了），直接播报。
					[EVENTS.AGENT_MESSAGE]: STATES.SPEAKING,
				},
				[STATES.ACTIVE]: {
					[EVENTS.COMMAND]: STATES.THINKING,
					[EVENTS.SLEEP]: STATES.SLEEPING,
					[EVENTS.STOP]: STATES.OFF,
					// 一句话都没听到就超时，回待机继续等唤醒词。
					[EVENTS.IDLE]: STATES.STANDBY,
					[EVENTS.AGENT_MESSAGE]: STATES.SPEAKING,
				},
				[STATES.THINKING]: {
					[EVENTS.REPLY]: STATES.SPEAKING,
					// 回答落地：`handleTurnEnd` 走的就是这条（先 AGENT_MESSAGE 再播报）。
					// 漏了这格，播报期间会一直显示「思考中」，播完的 speak-end 更无处可去。
					[EVENTS.AGENT_MESSAGE]: STATES.SPEAKING,
					[EVENTS.ERROR]: STATES.ACTIVE,
					[EVENTS.WAKE]: STATES.ACTIVE,
					[EVENTS.STOP]: STATES.OFF,
					[EVENTS.SLEEP]: STATES.SLEEPING,
				},
				[STATES.SPEAKING]: {
					// 播完回**正在听**：助手说完就接着能听，不必再喊一次唤醒词。
					// 收尾交给 `active` 的 60s 静默计时（"播报完没语音输入 60 秒才休眠"）。
					// 目标若写成 `standby`，计时**不会**被武装 → 变成"每轮都要重新唤醒"
					// 却又永不休眠，是本需求报的那个 bug。
					[EVENTS.SPEAK_END]: STATES.ACTIVE,
					// 用户主动打断（单击语音球）= "我要说话"：同样进听写。
					// 与上面的自动收尾落到同一状态，但语义不同 —— 那 700ms 回声静默期
					// 两者都要走（见 controller 的 `onTransition`）。
					[EVENTS.WAKE]: STATES.ACTIVE,
					[EVENTS.SLEEP]: STATES.SLEEPING,
					[EVENTS.STOP]: STATES.OFF,
					// 播报被新的 agent 消息打断：立刻改念新的（后到者优先）。
					[EVENTS.AGENT_MESSAGE]: STATES.SPEAKING,
				},
				[STATES.SLEEPING]: {
					[EVENTS.WAKE]: STATES.ACTIVE,
					// 手动点击 / 提示音唤醒：不直接进 active 听，而是先回到待机，
					// 由调用方决定要不要再进 active（避免一唤醒就录进环境噪声）。
					[EVENTS.RESUME]: STATES.STANDBY,
					[EVENTS.AGENT_MESSAGE]: STATES.SPEAKING,
					[EVENTS.START]: STATES.STANDBY,
					[EVENTS.STOP]: STATES.OFF,
				},
			};

			/**
			 * 计算下一个状态。
			 * @param current - 当前状态。
			 * @param event - 事件名。
			 * @returns 下一个状态（未定义迁移时返回当前状态）。
			 */
			function nextState(current, event) {
				const row = TRANSITIONS[current];
				if (row === undefined) return current;
				const next = row[event];
				return next === undefined ? current : next;
			}

			/**
			 * 极简状态容器。
			 *
			 * 不用 React state 持有状态：状态要被非 React 的音频回调读写，
			 * 放进 React 会立刻遇到闭包陈旧（stale closure）问题。
			 * 容器只做「当前值 + 订阅」，渲染层用 `useSyncExternalStore` 或
			 * 自行 `useState` + 订阅同步。
			 */
			class VoiceMachine {
				/**
				 * @param initial - 初始状态。
				 */
				constructor(initial = STATES.OFF) {
					this.state = initial;
					this.listeners = new Set();
				}

				/** 当前状态。 */
				get() {
					return this.state;
				}

				/**
				 * 派发一个事件。
				 * @param event - 事件名。
				 * @returns `{ from, to, changed }`，便于调用方做副作用（播提示音、开关麦克风）。
				 */
				send(event) {
					const from = this.state;
					const to = nextState(from, event);
					const changed = to !== from;
					if (changed) {
						this.state = to;
						for (const listener of this.listeners) {
							try {
								listener(to, from, event);
							} catch (error) {
								// 单个订阅者抛错不能掐断广播，否则一个组件崩掉全链路都停。
								console.error("[voice-assistant] 状态订阅者异常", error);
							}
						}
					}
					return { from, to, changed };
				}

				/**
				 * 订阅状态变化。
				 * @param listener - `(to, from, event) => void`。
				 * @returns 取消订阅函数。
				 */
				subscribe(listener) {
					this.listeners.add(listener);
					return () => {
						this.listeners.delete(listener);
					};
				}
			}

			__exports({ TRANSITIONS, nextState, VoiceMachine });
		});

		__def("core/questions.js", (__exports, __req) => {
			/**
			 * 提问旁听 + 语音作答（**只做 `ask_user_question`，不碰工具权限审批**）。
			 *
			 * ## 为什么不做工具审批
			 *
			 * `approval/request`（工具权限）与 `user-questions/request`（模型提问）是两条
			 * 独立的 seam。工具审批放行的是**有副作用的操作**（跑 bash、写文件），
			 * 语音误听（环境人声、电视、识别错字）会造成真实损害；而模型提问只是
			 * "要一个信息"，答错最多重问一次。用户的决定是：**只做后者**。
			 *
			 * ## 为什么"旁听"而不是注册应答者
			 *
			 * DSH 把两个 waterfall（`approval/request` / `user-questions/request`）
			 * 都**转发到了浏览器**（`@deepseek-ai/dsh-api-remotes` 的
			 * `API_REMOTE_FORWARDED_EVENTS`，`lib/types/remote-events.js:18,46`），
			 * 官方 UI（`dsh-client-ui-approval` / `dsh-client-ui-user-questions`）
			 * 就是在客户端用 `ctx.remote.$on(...)` 注册应答者的。而 `dsh-user-approval`
			 * 的 README 明确写着：
			 *
			 *   > 同级监听器的顺序**不是**策略优先级机制。
			 *
			 * 也就是说：我再注册一个**会返回结果**的应答者，无法保证排在官方 UI 之后 ——
			 * 一旦排在前面，就会把本该显示在界面上的问题抢过来（用户看不到问题卡，
			 * 只能靠听）。那是把功能做坏，不是做出来。
			 *
			 * 所以本模块走**纯增量**路径：只旁听、不参与决策。
			 *
			 * ## ⚠️ 重大修正：投影旁听在**默认配置下完全收不到问题**
			 *
			 * 本模块最初**只订阅 `userQuestions` 投影**旁听。真机端到端 spike 里
			 * `question()` 恒为 `null`，追下去发现是**设计前提错误**，不是接线 bug：
			 *
			 * `dsh-user-questions/lib/types/projection.js:209`（`applyUserQuestionEvent`
			 * 的 `tool/call` 分支）第一行就是：
			 *
			 * ```js
			 * if (!fold.timed || event.data.name !== ASK_USER_QUESTION_TOOL) return fold;
			 * ```
			 *
			 * 而 `fold.timed` 由 `request/header` 里记下的 **tool schema 是否声明
			 * `timeout` 参数**决定（`isTimedAskUserQuestionSchema`）。`dsh-tool-ask-user`
			 * 的 `Config.mode` 默认是 **`legacy`**，legacy schema **不声明 `timeout`**
			 * → **投影恒空**。README 也确认：「Shipped presets use blocking mode」。
			 *
			 * 两条独立证据（都在 `tools/research/`）：
			 *   1. `probe-question-projection.mjs` —— 直接 import 真机发布的
			 *      `projection.js`，喂合成的 legacy / timed 事件序列：
			 *      **legacy 恒空、timed 才进**（4/4 PASS）。
			 *   2. `probe-ask-user-logs.mjs` —— 扫盘上 26 个会话日志：
			 *      **真有 15 次 `ask_user_question` 调用**，但 27 处 schema
			 *      **全部是 legacy**（无 `timeout` 属性）。
			 *
			 * 也就是说：**问题真的在发生，但一个都不会进投影**。
			 *
			 * ## 正解：读**原始会话事件流**的 `tool/call`
			 *
			 * 投影是"加工过的视图"（要过 `timed` 闸门）；**原始事件流不受这个闸门限制**，
			 * 两种模式都记 `tool/call`。而且本插件的 `VoiceSession` **已经订阅了这条流**
			 * （就是处理 `turn/start` / `turn/end` 的那条），不需要任何新增注册。
			 *
			 * 实探到的形状（`probe-tool-call-shape.mjs`，取真机日志原文）：
			 *
			 * ```json
			 * {"type":"tool/call","seq":140,"time":1793934196418,
			 *  "data":{"turn":1,"step":15,"callId":"call_00_gIOIJXseCDA0cwab79mr2983",
			 *          "name":"ask_user_question",
			 *          "arguments":"{\"questions\":[{\"id\":\"platform\",...}]}"}}
			 * ```
			 *
			 * 两个要点：
			 *   - **`arguments` 是 JSON 字符串**，得自己 `JSON.parse`；
			 *   - 模型参数用 **`multi_select`**（下划线），转成内部统一的 `multiSelect`。
			 *
			 * 于是本模块现在有**两条来源**，互为补充：
			 *
			 * | 来源 | 覆盖 | 作用 |
			 * |---|---|---|
			 * | 事件流 `tool/call` | **全部**（legacy + timed） | **主路径**：发现新问题、播报 |
			 * | `userQuestions` 投影 | 仅 timed | **补充**：拿权威的 `state`（`open`/`continued`） |
			 *
			 * 只靠事件流也能播报（`state` 一律按 `open` 保守处理），投影在就用来升级。
			 *
			 * ## 天然的第二层护栏：`answer()` 只收 `continued`
			 *
			 * 实测（`dsh-user-questions/lib/index.js:560` `answer()`）：
			 * 它只在 `continued(agent)` 里找 callId，**`open` 状态一律返回 `false`**。
			 * 而 `open` 正是"工具调用还开着、界面问题卡还在、用户能直接点"的窗口；
			 * 一旦 120s 计时窗口超时（`dsh-tool-ask-user` 默认 120 秒）或界面关掉，
			 * 问题转 `continued` —— **那才是本模块唯一会作答的时刻**。
			 *
			 * 换句话说：**只要界面还能答，我就插不进去**。这是 DSH 给的护栏，
			 * 不是我加的判断（我也有 `state === "continued"` 的显式判断，
			 * 但那是为了不白试一次，不是唯一一道防线）。
			 *
			 * ## 实测出来的契约（全部有真机证据，不是从类型猜的）
			 *
			 * | 事实 | 证据 |
			 * |---|---|
			 * | `faceOf(k)` 返回 `{ subscribe, getSnapshot }` | bundle `publishContinuedQuestions` |
			 * | 投影形状 `{ active: [{ callId, state, questions }] }` | 同上，取 `projected?.active` |
			 * | `state` ∈ `open` \| `continued` | 同上，`row.state === "continued"` |
			 * | 作答 `remote.userQuestions.answer(sessionId, callId, answer)` | 同上，`rpcFor` |
			 * | 返回是**结果对象** `{ ok, value }` / `{ ok:false, error }` | 同上，`unwrap()` 先判 `ok` |
			 * | `answer` 形如 `{ answers: [{ id, selected: [], custom? }] }` | `dsh-user-questions/lib/types/types.d.ts` |
			 * | 官方 UI 也用 `sessions.binding(id)` 取同一条 binding | 同上，`Object.values(snapshot.byId)…sessions.binding` |
			 * | **legacy 模式的提问不进投影** | `projection.js:209` + `probe-question-projection.mjs` |
			 * | **事件流 `tool/call` 两种模式都有** | `probe-tool-call-shape.mjs`（真机日志原文） |
			 * | `arguments` 是 **JSON 字符串**；模型写 `multi_select` | 同上 |
			 *
			 * 这份表是用 `tools/research/probe-user-questions.mjs` 实探出来的
			 * （拉真机批量包 + 定位调用点）。**不要凭类型声明改这里的形状** ——
			 * `faceOf()` 的返回类型在声明里就是 `unknown`，猜错的表现是静默失效。
			 */

			/** 本模块关心的工具名（只有它会被旁听）。 */
			const ASK_USER_QUESTION_TOOL = "ask_user_question";

			/**
			 * 从一条会话事件里读出 `ask_user_question` 的调用。
			 *
			 * 只认 `tool/call`；事件负载在 `data` 下（本项目的通用坑，见 session.js）。
			 * `arguments` 是 **JSON 字符串**，解析失败一律返回 `null`（模型参数畸形时
			 * 那次调用本来也没到工具，没有卡片可显示）。
			 *
			 * @param event - 会话事件（形状 `{ type, seq, time, data }`）。
			 * @returns `{ callId, questions }`，或 `null`（不是提问调用 / 读不出来）。
			 */
			function questionCallOf(event) {
				if (event === null || typeof event !== "object") return null;
				if (event.type !== "tool/call") return null;
				const payload = event.data !== null && typeof event.data === "object" ? event.data : event;
				if (payload?.name !== ASK_USER_QUESTION_TOOL) return null;
				const callId = typeof payload.callId === "string" ? payload.callId : "";
				if (callId === "") return null;
				const raw = payload.arguments;
				const parsed = parseArguments(raw);
				if (parsed === null) return null;
				const list = Array.isArray(parsed.questions) ? parsed.questions : [];
				const questions = list.map(normalizeQuestion).filter((item) => item !== null);
				if (questions.length === 0) return null;
				return { callId, questions };
			}

			/**
			 * 解析工具参数：主形态是 JSON 字符串，同时兼容已经是对象的情况。
			 * @param raw - `arguments` 字段。
			 * @returns 解析后的对象，或 `null`。
			 */
			function parseArguments(raw) {
				if (typeof raw === "string") {
					try {
						const parsed = JSON.parse(raw);
						return parsed !== null && typeof parsed === "object" ? parsed : null;
					} catch {
						// 模型参数畸形：那次调用本来也没到工具。
						return null;
					}
				}
				return raw !== null && typeof raw === "object" ? raw : null;
			}

			/**
			 * 把模型写的 `ask_user_question` 参数转成本模块的内部形状。
			 *
			 * 两处**必须转**的差异（都是实探出来的，不是猜的）：
			 *   - `multi_select` → `multiSelect`：模型 schema 用下划线，
			 *     而投影/服务层用驼峰（`projection.js` 的 `questionsOf` 就这么转）；
			 *   - `options[].description` 缺省时补 `""`，免得下游到处判 undefined。
			 *
			 * @param item - 模型写的一条问题。
			 * @returns 内部形状；`id` 或 `question` 缺失时返回 `null`。
			 */
			function normalizeQuestion(item) {
				if (item === null || typeof item !== "object") return null;
				const id = typeof item.id === "string" ? item.id : "";
				if (id === "") return null;
				const question = typeof item.question === "string" ? item.question : "";
				if (question === "") return null;
				const options = Array.isArray(item.options)
					? item.options
							.map((option) => (option !== null && typeof option === "object" ? option : null))
							.filter((option) => option !== null && typeof option.label === "string")
							.map((option) => ({
								label: option.label,
								description: typeof option.description === "string" ? option.description : "",
							}))
					: [];
				return {
					id,
					question,
					header: typeof item.header === "string" ? item.header : "",
					options,
					multiSelect: item.multi_select === true || item.multiSelect === true,
				};
			}

			/**
			 * 念问题时最多念几个选项。选项多到念不完时，只念前几个并提示"还有更多"。
			 *
			 * 依据：一次 `ask_user_question` 常见 2–5 个选项；超过 5 个时用户也记不住，
			 * 不如提示去看界面。
			 */
			const MAX_SPOKEN_OPTIONS = 5;

			/**
			 * 把一句问题念成人话。
			 *
			 * 不念 `question.id`（那是给模型对答案用的稳定标识，念出来纯噪音），
			 * 但**要念 `header`**：模型常把"要不要继续 / 用哪个方案"这类限定放在
			 * header 里，缺了它选项会失去语境。
			 *
			 * @param item - `{ question, header?, detail?, options? }`。
			 * @param ordinal - 第几个问题（多问题批次时前缀"第一问"）。
			 * @param total - 本批问题总数。
			 * @returns 念给用户的文本。
			 */
			function speakQuestion(item, ordinal, total) {
				const head = typeof item?.header === "string" && item.header.trim() !== "" ? `${item.header.trim()}：` : "";
				const body = typeof item?.question === "string" ? item.question.trim() : "";
				const prefix = total > 1 ? `第${["一", "二", "三", "四", "五"][ordinal] ?? String(ordinal + 1)}问，` : "";
				let text = `${prefix}${head}${body}`;

				const options = Array.isArray(item?.options) ? item.options : [];
				if (options.length > 0) {
					const labels = options.slice(0, MAX_SPOKEN_OPTIONS).map((option) => String(option?.label ?? "").trim()).filter((label) => label !== "");
					if (labels.length > 0) {
						text += `。选项：${labels.map((label, index) => `${["一", "二", "三", "四", "五"][index]}是${label}`).join("，")}`;
						if (labels.length < options.length) text += `等 ${options.length} 个`;
						text += "。";
					}
				} else {
					text += "。这是开放问题，直接说就行。";
				}
				// 念完提示怎么答 —— 用户不知道"可以语音答"就不会答。
				text += "要选哪个直接说。";
				return text;
			}

			/**
			 * 把用户的语音回答匹配到某个选项。
			 *
			 * ## 匹配顺序为什么是"先精确后模糊"
			 *
			 * 先比选项**原文**再比序号，是因为中文识别常把"一"写成"1"、把序号
			 * 听成别的字，但**选项原文**（通常是"允许"、"方案 A"这类实义词）识别
			 * 准确率高得多。反过来先看序号，会把"我要第二个方案"这种话里的
			 * 数字当成序号，实际用户想要的是那个方案本身。
			 *
			 * 支持的表达式（覆盖实测常见的说话方式）：
			 *   - 选项原文：「方案 A」「允许」「用第一个」
			 *   - 文本序号：「一 / 第一 / 第一个 / 1 / 第 1 个」
			 *   - 序数词：「首个 / 最后一个 / 第二个」
			 *   - 明确否定：「都不选 / 跳过 / 不用」（→ 空 selected，即"跳过"）
			 *
			 * @param text - 用户说的话（已归一化）。
			 * @param options - 选项数组。
			 * @param multiSelect - 是否多选。
			 * @returns `{ selected, custom, matched }`；`matched` 为 `false` 表示没匹配上。
			 */
			function matchAnswer(text, options, multiSelect = false) {
				const said = normalize(text);
				const list = Array.isArray(options) ? options : [];
				if (said === "") return { selected: [], custom: "", matched: false };

				// 「跳过」是协议认的形态（`selected: []` 且无 `custom`），也是唯一安全的
				// 默认 —— 用户说"不用了"时绝不能替他随便选一个。
				if (/(^|不)(跳过|都不用|都不选|不用了|算了)|^跳过$/.test(said)) {
					return { selected: [], custom: "", matched: true, skip: true };
				}

				const matched = [];
				for (let index = 0; index < list.length; index += 1) {
					const label = normalize(String(list[index]?.label ?? ""));
					if (label === "") continue;
					// 选项原文匹配：**双向包含**（用户可能只说了选项的一部分，
					// 例如选项是"允许一次"而用户说"允许"；也可能把选项念全）。
					if (label === said || said.includes(label) || label.includes(said)) {
						matched.push(String(list[index].label));
						if (!multiSelect) break;
					}
				}
				if (matched.length > 0) {
					return { selected: matched, custom: "", matched: true };
				}

				// 序号匹配：中文数字与阿拉伯数字都认（识别对数字的写法不稳定）。
				const ordinals = [
					["一", "1", "第一", "第一个", "首个"],
					["二", "2", "第二", "第二个", "次个"],
					["三", "3", "第三", "第三个"],
					["四", "4", "第四", "第四个"],
					["五", "5", "第五", "第五个"],
				];
				// 「最后一个」单独判，避免选项多于 5 个时漏掉。
				if (/最后(一)?个/.test(said) && list.length > 0) {
					return { selected: [String(list[list.length - 1].label)], custom: "", matched: true };
				}
				for (let index = 0; index < ordinals.length && index < list.length; index += 1) {
					if (ordinals[index].some((token) => said.includes(token))) {
						return { selected: [String(list[index].label)], custom: "", matched: true };
					}
				}

				// 有选项但没匹配上：**不猜**。返回未匹配，由调用方再问一次或交回界面。
				if (list.length > 0) return { selected: [], custom: "", matched: false };
				// 开放问题：用户说什么就是什么。
				return { selected: [], custom: String(text ?? "").trim(), matched: true };
			}

			/**
			 * 归一化：去掉空格、把中文数字统一成阿拉伯数字、去掉标点。
			 *
			 * 与 `echo.js` 的 `normalizeForEcho` 分开写：那个面向"同音比对"，
			 * 这个面向"口令匹配"，两者要保留的东西不同（这里必须**保留数字**，
			 * 同音比对则要抹掉）。
			 *
			 * @param text - 原始文本。
			 * @returns 归一化文本。
			 */
			function normalize(text) {
				return String(text ?? "")
					.replace(/\s+/g, "")
					.replace(/[，。！？、,.!?~～]/g, "")
					.toLowerCase();
			}

			/**
			 * 提问旁听桥。
			 *
			 * 生命周期：`attach(binding)` / `detach()`。
			 *
			 * ## 两条来源的分工
			 *
			 *   - **事件流（主）**：`observeEvent(event)` 由会话桥在**每条**会话事件上调用
			 *     （它本来就在处理 `turn/start` / `turn/end`）。`tool/call` 里发现
			 *     `ask_user_question` 就播报。**这条不受 `timed` 限制**，所以是主路径。
			 *   - **投影（补充）**：若 `userQuestions` 投影存在，订阅它拿到权威的
			 *     `state`（`open` / `continued`）—— 只有 `continued` 才能作答。
			 *     投影为空（legacy 模式）也不影响播报，只是 `state` 保守按 `open`。
			 *
			 * 换会话时必须重建：`tool/call` 的 `callId` 是**按会话**的，
			 * 投影更是按会话的。沿用旧的会念出别的会话的问题。
			 */
			class QuestionBridge {
				/**
				 * @param options - `{ ctx, onQuestion, onResolved, log, warn, ledger }`。
				 *   `onQuestion(payload)` 让上层去播报；`payload` 形如
				 *   `{ sessionId, callId, state, questions }`。
				 *   `ctx` 必须有：作答要走 `ctx.remote.userQuestions.answer(...)`。
				 *   `ledger`（可选）是控制器的播报账本 —— 用来把"已经念过哪个问题"
				 *   **持久化**，见下面 `markAnnounced`。
				 */
				constructor(options = {}) {
					this.ctx = options.ctx ?? null;
					this.onQuestion = options.onQuestion ?? (() => {});
					this.onResolved = options.onResolved ?? (() => {});
					this.log = options.log ?? (() => {});
					this.warn = options.warn ?? (() => {});
					/**
					 * 播报账本（可选）。
					 *
					 * ## 为什么提问也要落账本（需求②的第三处漏口）
					 *
					 * `announced` 原来只在内存里，而 `attach()` 里的 `reconcile()`
					 * **有意**要在绑定前先跑一遍（原注释：「页面刚刷新、问题在历史里
					 * 也该被念出来」）。两句合起来的真机表现就是：
					 *
					 *   1. 助手念了一次问题；
					 *   2. 用户刷新页面；
					 *   3. 投影里那个问题仍是 `active`（120 秒计时窗口还没到，
					 *      或者用户压根没答）→ `announced` 已归零 → **又念一遍**。
					 *
					 * 同一个坑的另外两个出口（互动流游标、会话 seq）已经在
					 * `ledger.js` 堵上了，这里是第三处，共用同一份账本。
					 */
					this.ledger = options.ledger ?? null;

					/** 当前绑定的会话 id（`null` = 未绑定）。 */
					this.sessionId = null;
					/** 投影的退订函数。 */
					this.unsubscribe = null;
					/** 已对哪些 callId 播报过（防重复念同一批问题）。 */
					this.announced = new Set();
					/** 已提交作答的 callId（防重复提交，DSH 会以 REPLY_QUEUED 拒绝第二次）。 */
					this.answered = new Set();
					/** 已知的问题内容（投影可能拿不到 questions，靠事件流兜底）。 */
					this.known = new Map();
					/** 投影给出的权威 state（`continued` 才可作答）。 */
					this.states = new Map();
					/**
					 * 是否见过 timed 投影。
					 *
					 * 用来在诊断里一眼区分"投影可用但为空（timed 无问题）"与
					 * "投影结构上收不到（legacy）"—— 后者是**正常的**，
					 * 本机默认就是它，不该报警。
					 */
					this.projectionSeen = false;
				}

				/**
				 * 接入一条会话。
				 *
				 * @param sessionId - 会话 id。
				 * @param binding - `sessions.retain()` / `binding()` 给的绑定。
				 * @returns 是否接入成功（接入不上不是错误，事件流那条仍会工作）。
				 */
				attach(sessionId, binding) {
					this.detach();
					this.sessionId = sessionId;
					const face = binding?.session?.projections?.faceOf?.("userQuestions");
					if (face === undefined || face === null || typeof face.getSnapshot !== "function") {
						// 提问投影不在（精简 profile / 未装 dsh-user-questions）：
						// 静默跳过。**不 warn** —— 这是合法的可选能力，装机不同而已。
						// 事件流那条不依赖投影，照常工作。
						this.log("提问投影不可用（不影响事件流旁听）");
						return false;
					}
					this.face = face;
					this.projectionSeen = true;
					// `reconcile` 必须在订阅前先跑一遍，把"当前还挂着的问题"接上。
					//
					// ⚠️ 需求② 修正了这里的理由。原来的注释是「页面刚刷新、问题在历史里
					// 也该被念出来」—— 那句正是重复播报的来源，且是**有意为之**的：
					// `announced` 刷新即归零，于是每次刷新都把同一个 `active` 问题念一遍。
					//
					// 现在的口径是：**接上，但只念没念过的**。判定交给
					// `markAnnounced`（内存集合 + 持久账本），所以「真·新问题」照念，
					// 「刷新后重放的旧问题」被账本拦下。
					this.reconcile();
					if (typeof face.subscribe === "function") {
						this.unsubscribe = face.subscribe(() => this.reconcile());
					}
					this.log(`提问旁听已接入（session ${String(sessionId).slice(0, 8)}）`);
					return true;
				}

				/**
				 * 标记"这个问题已经念过"，并判断这次到底该不该念。
				 *
				 * 内存集合 + 持久账本**两个一起查、一起记**：
				 *   - 内存集合管"本次页面生命周期内"（快，且不依赖存储）；
				 *   - 持久账本管"跨刷新"（这才是需求②要的）。
				 *
				 * 账本认不出身份时（理论上 callId 非空就一定认得，这里是兜底）
				 * 一律放行 —— 宁可多念一次，也不要把真问题吞掉。
				 *
				 * @param callId - 提问调用 id。
				 * @returns `true` = 这次该念（并已记账）。
				 */
				markAnnounced(callId) {
					const id = String(callId ?? "").trim();
					if (id === "") return true;
					if (this.announced.has(id)) return false;
					// 账本判定：`claim` 判定与记账合一，返回 false 说明**上一个页面**已经念过。
					if (this.ledger !== null && this.ledger.claim({ kind: "question", key: id }) === false) {
						// 账本说念过 —— 补进内存集合，免得本次会话里再走一遍账本判定。
						this.announced.add(id);
						return false;
					}
					this.announced.add(id);
					return true;
				}

				/**
				 * 观察一条会话事件（**主路径**）。
				 *
				 * 由会话桥在每条事件上调用。这里只关心 `tool/call` 的
				 * `ask_user_question` —— 那条不受 `timed` 闸门限制，
				 * 是 legacy 模式下**唯一**能发现问题的途径。
				 *
				 * @param event - 会话事件。
				 * @returns 是否识别出一个新的提问调用。
				 */
				observeEvent(event) {
					const call = questionCallOf(event);
					if (call === null) return false;
					this.known.set(call.callId, call.questions);
					if (this.answered.has(call.callId)) return false;
					if (!this.markAnnounced(call.callId)) return false;
					// 事件流拿不到 `state`（那是投影才知道的）→ 保守按 `open`：
					// 先播报（有价值），作答与否由 `tryAnswerQuestion` 按投影定。
					const state = this.states.get(call.callId) ?? "open";
					try {
						this.onQuestion({ sessionId: this.sessionId, callId: call.callId, state, questions: call.questions });
					} catch (error) {
						this.warn("播报提问失败", error?.message ?? error);
					}
					return true;
				}

				/**
				 * 读一次投影，把"还没播报过的"问题交出去播报，并刷新权威 `state`。
				 *
				 * 只处理 `active`（能作答的）—— `settled` 是已经答完的历史，
				 * 念它等于把陈年旧事当新闻播。
				 */
				reconcile() {
					const face = this.face;
					if (face === undefined || face === null) return;
					let snapshot;
					try {
						snapshot = face.getSnapshot();
					} catch (error) {
						this.warn("读提问投影失败", error?.message ?? error);
						return;
					}
					const active = Array.isArray(snapshot?.active) ? snapshot.active : [];
					for (const row of active) {
						const callId = typeof row?.callId === "string" ? row.callId : "";
						if (callId === "") continue;
						const state = row.state === "continued" ? "continued" : "open";
						// 权威 state 优先于事件流的保守值。
						this.states.set(callId, state);
						if (this.answered.has(callId)) continue;
						// 投影里的 questions 可能比事件流更全（例如页面刷新后
						// 事件流没重放过）→ 以投影为准补上。
						const questions = Array.isArray(row.questions) && row.questions.length > 0 ? row.questions : this.known.get(callId);
						if (!Array.isArray(questions) || questions.length === 0) continue;
						this.known.set(callId, questions);
						if (!this.markAnnounced(callId)) continue;
						try {
							this.onQuestion({ sessionId: this.sessionId, callId, state, questions });
						} catch (error) {
							this.warn("播报提问失败", error?.message ?? error);
						}
					}
					// 已经不在 active 里的（被答掉/被撤销）：清掉记录，避免集合无限长。
					// 注意**只清内存集合**，不动持久账本 —— 账本要留着跨刷新拦截
					// "问题还挂在 active 上没答"这一种重放（上面 markAnnounced 的场景）。
					const live = new Set(active.map((row) => (typeof row?.callId === "string" ? row.callId : "")));
					for (const callId of this.announced) {
						if (!live.has(callId) && this.answered.has(callId)) this.announced.delete(callId);
					}
					for (const callId of this.states.keys()) {
						if (!live.has(callId)) this.states.delete(callId);
					}
				}

				/**
				 * 提交一个回答。
				 *
				 * @param callId - 要回答的调用。
				 * @param answer - `{ answers: [{ id, selected, custom? }] }`。
				 * @returns `{ ok, reason }`；`ok:false` 时 `reason` 说明为什么（如实回报，不静默）。
				 */
				async submit(callId, answer) {
					// ## 为什么用 `ctx.get("…")` 而不是 `ctx.remote.userQuestions`
					//
					// **真机踩出来的**：`ctx.remote.userQuestions` 这种嵌套访问会被
					// cordis 的代理拦下，未在 `inject` 声明过就抛
					// `cannot get property "remote.userQuestions" without inject`
					// （`cordis/lib/index.js:1257`）。症状很隐蔽：**同步抛在
					// `try` 外面**（那句 `service.answer` 之前），所以连
					// `{ok:false, reason}` 都返回不了，直接变成浏览器里一条
					// "Uncaught (in promise)"。
					//
					// **为什么不能把它加进插件 `inject`**：官方 UI 声明了
					// `["sessions","remote","remote.userQuestions",…]`
					// （`dsh-client-ui-user-questions/lib/client.js:1973`），但我们**不能**照抄 ——
					// `inject` 是"必须就绪才启动"，精简 profile 没装
					// `dsh-user-questions` 时，整个语音球会因为等一个可选服务而
					// **永远不激活**。代价（整个 UI 消失）远大于收益（作答不可用）。
					//
					// 正解是 cordis 给的免 inject 读取口 `ctx.reflect.get(name)`
					// —— 它的文档原文就是 "Read a service from the store **without the
					// inject requirement**"。注意传的是**服务全名**（带点号的
					// `remote.userQuestions`，它是注册名而不是嵌套属性）。
					const ctx = this.ctx;
					let service;
					try {
						// `ctx.get` 与 `ctx.reflect.get` 是同一条路（mixin 把 reflect 的
						// 方法挂到了 ctx 上）；两个都试一遍是为了兼容只有其一的 ctx。
						service = ctx?.get?.("remote.userQuestions") ?? ctx?.reflect?.get?.("remote.userQuestions");
					} catch (error) {
						// 取服务本身抛错（代理的护栏）→ 如实回报，不让异常逃出去。
						return { ok: false, reason: `remote-unavailable: ${String(error?.message ?? error)}` };
					}
					if (service === undefined || service === null || typeof service.answer !== "function") {
						return { ok: false, reason: "remote-userQuestions-unavailable" };
					}
					if (this.sessionId === null) return { ok: false, reason: "no-session" };
					// 同一问题只提交一次。DSH 对第二次会以 `REPLY_QUEUED` 拒绝（实测
					// `dsh-user-questions/lib/index.js` 的 `answer()`），先发的那次已经
					// 把答复排进了 inbox —— 再发一次除了在界面上刷一条无意义的报错，
					// 没有任何作用。
					if (this.answered.has(callId)) return { ok: false, reason: "already-answered" };
					try {
						const result = await service.answer(this.sessionId, callId, answer);
						// 实测：返回是**结果对象** `{ ok, value }` / `{ ok:false, error }`，
						// 不是裸布尔。官方 UI 的 `unwrap()` 就是这个形状。
						if (result !== null && typeof result === "object" && result.ok === false) {
							const failure = result.error ?? {};
							return { ok: false, reason: String(failure.message ?? failure.code ?? "answer-rejected") };
						}
						// `ok:true` 但 `value:false` = 这个问题已不在 `continued`（多半界面已经答了）。
						const value = result !== null && typeof result === "object" ? result.value : undefined;
						if (value === false) return { ok: false, reason: "not-answerable" };
						this.answered.add(callId);
						this.onResolved({ callId, answer });
						return { ok: true, reason: "" };
					} catch (error) {
						return { ok: false, reason: String(error?.message ?? error) };
					}
				}

				/** 释放订阅与状态（换会话/卸载时调用）。 */
				dispose() {
					if (typeof this.unsubscribe === "function") {
						try {
							this.unsubscribe();
						} catch {
							// 退订失败无所谓。
						}
					}
					this.unsubscribe = null;
					this.face = undefined;
					this.sessionId = null;
					this.announced.clear();
					this.answered.clear();
					this.known.clear();
					this.states.clear();
				}

				/**
				 * 释放会话相关状态，但**保留** `ctx`（桥对象本身还要继续用）。
				 *
				 * 与 `dispose()` 的区别只在语义：`dispose()` 是"整个桥不要了"，
				 * 这个是"换了一条会话，重来"。当前两者做的事一样，分开是为了
				 * 以后给 `dispose()` 加资源释放时不会误伤换会话路径。
				 */
				detach() {
					this.dispose();
				}

				/**
				 * 诊断快照（只读，供 `__xfvDebug` 用）。
				 * @returns 计数与关键状态。
				 */
				inspect() {
					return {
						sessionId: this.sessionId ?? null,
						projectionAttached: this.face !== undefined,
						projectionSeen: this.projectionSeen,
						announced: this.announced.size,
						answered: this.answered.size,
						known: this.known.size,
						states: Object.fromEntries(this.states),
					};
				}
			}

			__exports({ ASK_USER_QUESTION_TOOL, questionCallOf, speakQuestion, matchAnswer, normalize, QuestionBridge });
		});

		__def("core/runtime.js", (__exports, __req) => {
			/**
			 * 运行期：配置读取、本机 API 调用、日志。
			 *
			 * ## 配置从哪来
			 *
			 * 宿主半通过 `webserver/index-inject` 把归一化配置编成
			 * `globalThis.__VOICE_ASSISTANT_CONFIG__` 塞进首帧，早于本 bundle 求值。
			 * 因此这里**同步读取**即可，不需要 await —— 首屏就能显示正确的唤醒词与位置。
			 *
			 * 拿不到时（纯前端调试、宿主半未装）用 `FALLBACK` 兜底：功能降级为
			 * "浏览器语音 + 规则清理"，但界面能正常渲染并明确提示未连上宿主。
			 */
			const { API_PREFIX } = __req("core/constants.js");

			/** 宿主缺失时的兜底配置（字段与 `lib/config.js` 的 clientConfig 对齐）。 */
			const FALLBACK = {
				wake: { word: "小凤", aliases: ["小风", "晓凤", "小枫"], inlineCommand: true },
				language: "zh-CN",
				sleep: { idleTimeoutMs: 60000, keepWakeWord: false, chime: true },
				asr: { engine: "webspeech", httpReady: false, httpModel: "whisper-1", maxSegmentMs: 15000 },
				tts: { engine: "browser", voice: "", rate: 1, httpReady: false, httpModel: "tts-1" },
				polish: { enabled: true, style: "clean", timeoutMs: 8000, available: false, model: "" },
				session: { mode: "dedicated", requestedMode: "dedicated", title: "小凤语音会话", workspace: "", label: "小凤 · 常驻助手" },
				agent: { enabled: false, sessionId: "", personaActive: false, steer: true },
				// 两层架构：宿主缺失时路由视为关闭（没有 worker 可切）。
				routing: { enabled: false, workers: [], reportPollMs: 1500 },
				answers: { questionTimeoutMs: 60000, chime: true, repeatOnce: true },
				// 需求④统一互动流：宿主缺失时视为关闭（没有宿主就没有审批/汇报可播）。
				interactions: { enabled: false, announceApprovals: true, announceQuestions: true, pollMs: 1500, catchupWindowMs: 600000 },
				// 全局记忆。宿主缺失时一律视为未生效 —— 它本来就只能在宿主侧注册，
				// 这里给 `global:false` 是为了让面板有一句确定的"未开启"而不是 `undefined`。
				memory: { global: false, active: false },
				// 轮次门槛：宿主缺失时也必须有一份可用默认值，否则客户端会以
				// `undefined` 建 `TurnGate`（退化成内置默认，但界面显示会缺字段）。
				turn: { silenceMs: 10000, maxTurnMs: 300000, echoGuard: true, steerWhileThinking: false },
				ui: { position: "bottom-right", accent: "#2f6bff", showTranscript: true },
				capabilities: { polishAvailable: false, asrHttpReady: false, ttsHttpReady: false, agentAvailable: false },
			};

			/** 宿主配置的全局变量名（与 `index.js` 的 `CLIENT_CONFIG_GLOBAL` 一致）。 */
			const GLOBAL = "__VOICE_ASSISTANT_CONFIG__";

			/**
			 * 读取并补全配置。
			 *
			 * 逐层合并而不是整体替换：宿主半未来新增字段时，旧客户端仍能拿到
			 * 完整的默认值，不会因为某个子对象缺失整块 `undefined` 崩掉。
			 *
			 * @returns 合并后的配置。
			 */
			function readConfig() {
				const injected =
					typeof globalThis !== "undefined" && globalThis[GLOBAL] !== null && typeof globalThis[GLOBAL] === "object"
						? globalThis[GLOBAL]
						: null;
				const base = FALLBACK;
				if (injected === null) return { config: base, fromHost: false };
				return {
					fromHost: true,
					config: {
						wake: { ...base.wake, ...(injected.wake ?? {}) },
						language: injected.language ?? base.language,
						sleep: { ...base.sleep, ...(injected.sleep ?? {}) },
						asr: { ...base.asr, ...(injected.asr ?? {}) },
						tts: { ...base.tts, ...(injected.tts ?? {}) },
						polish: { ...base.polish, ...(injected.polish ?? {}) },
						session: { ...base.session, ...(injected.session ?? {}) },
						agent: { ...base.agent, ...(injected.agent ?? {}) },
						routing: { ...base.routing, ...(injected.routing ?? {}) },
						answers: { ...base.answers, ...(injected.answers ?? {}) },
						interactions: { ...base.interactions, ...(injected.interactions ?? {}) },
						memory: { ...base.memory, ...(injected.memory ?? {}) },
						turn: { ...base.turn, ...(injected.turn ?? {}) },
						ui: { ...base.ui, ...(injected.ui ?? {}) },
						capabilities: { ...base.capabilities, ...(injected.capabilities ?? {}) },
					},
				};
			}

			/** 统一日志前缀，便于在混杂的控制台里过滤。 */
			function log(...args) {
				console.log("[小凤]", ...args);
			}

			/** 统一告警前缀。 */
			function warn(...args) {
				console.warn("[小凤]", ...args);
			}

			/**
			 * 调本机 API。
			 *
			 * @param path - 相对前缀的路径，如 `/polish`。
			 * @param options - `{ method, body, headers }`。
			 * @returns 解析后的响应；非 2xx 时抛错（`error` 字段作为 message）。
			 */
			async function request(path, options = {}) {
				const response = await fetch(`${API_PREFIX}${path}`, {
					method: options.method ?? "POST",
					headers: options.headers,
					body: options.body,
				});
				if (!response.ok) {
					let detail = `http-${response.status}`;
					try {
						const payload = await response.json();
						if (typeof payload?.error === "string") detail = payload.error;
						if (typeof payload?.detail === "string") detail += `: ${payload.detail}`;
					} catch {
						// 响应不是 JSON（例如 405 纯文本），保留状态码即可。
					}
					throw new Error(detail);
				}
				return response;
			}

			/**
			 * 请求转录润色。
			 * @param text - 原始转录。
			 * @returns `{ text, via, reason? }`。
			 */
			async function polish(text) {
				const response = await request("/polish", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text }),
				});
				return response.json();
			}

			/**
			 * 请求意图路由（两层架构第一层）。
			 * @param text - 已润色的指令文本。
			 * @returns `{ worker, task, via, ms? }`；失败时由调用方降级。
			 */
			async function route(text) {
				const response = await request("/route", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text }),
				});
				return response.json();
			}

			/**
			 * V1.3：把任务委托给 worker 后台执行（当场返回，不切会话）。
			 * @param worker - worker id。
			 * @param task - 路由改写后的任务文本。
			 * @returns `{ ok, jobId?, workerId, label?, error? }`。
			 */
			async function delegate(worker, task) {
				const response = await request("/delegate", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ worker, task }),
				});
				return response.json();
			}

			/**
			 * V1.7：列出专家（管理命令用）。
			 * @returns `{ ok, workers, custom, tombstones, problems, dir }`。
			 */
			async function listExperts() {
				const response = await request("/experts", { method: "GET" });
				return response.json();
			}

			/**
			 * V1.7：新增一位专家。
			 * @param spec - `{ id?, label, description, persona?, skills? }`。
			 * @returns `{ ok, expert?, speech?, error? }`。
			 */
			async function addExpert(spec) {
				const response = await request("/experts", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(spec),
				});
				return response.json();
			}

			/**
			 * V1.7：删除一位专家（内置专家写墓碑）。
			 * @param id - 专家 id。
			 * @returns `{ ok, id?, mode?, speech?, error? }`。
			 */
			async function removeExpert(id) {
				const response = await request(`/experts/${encodeURIComponent(id)}`, { method: "DELETE" });
				return response.json();
			}

			/**
			 * V1.3：按 after 游标取回 worker 的完成要点（按完成时间升序）。
			 * @param after - 毫秒时间戳，或 `"latest"`（首帧只取游标、不重放历史）。
			 * @returns `{ reports: [{seq,at,label,summary,ok,speech,...}], cursor }`。
			 */
			async function reports(after) {
				const query = after === undefined || after === null ? "" : `?after=${encodeURIComponent(String(after))}`;
				const response = await request(`/reports${query}`, { method: "GET" });
				return response.json();
			}

			/**
			 * 需求④：按 `at` 游标取回**统一互动流**（权限审核 / 模型提问 / 结果汇报）。
			 *
			 * 与 `reports()` 并存而不是取而代之：`reports` 仍被既有调用与冒烟脚本
			 * 使用；这条流是"需要用户知道的事"的更宽口径。两者数据有重叠（汇报），
			 * 但客户端只**播报其中一条**（见 controller 的 `interactionCursor` 注释），
			 * 否则同一条汇报会被念两遍。
			 *
			 * @param after - 毫秒时间戳，或 `"latest"`（首帧只取游标、不重放历史）。
			 * @returns `{ interactions: [{seq,at,kind,key,label,speech,detail}], cursor }`。
			 */
			async function interactions(after) {
				const query = after === undefined || after === null ? "" : `?after=${encodeURIComponent(String(after))}`;
				const response = await request(`/interactions${query}`, { method: "GET" });
				return response.json();
			}

			/**
			 * V1.6：取专家工作态（卡通桌宠的忙闲 + 当前任务）。
			 * @returns `{ at, workers:[{id,label,busy,task,...}], activeCount }`；失败返回 null。
			 */
			async function activities() {
				try {
					const response = await request("/activities", { method: "GET" });
					return await response.json();
				} catch {
					return null;
				}
			}

			/**
			 * 请求上游转写（仅 http 引擎使用）。
			 * @param blob - 音频。
			 * @param language - 语言提示。
			 * @returns `{ text }`。
			 */
			async function transcribe(blob, language) {
				const response = await request("/asr", {
					method: "POST",
					headers: {
						"content-type": blob.type === "" ? "audio/webm" : blob.type,
						"x-voice-language": language,
					},
					body: blob,
				});
				return response.json();
			}

			/**
			 * 请求上游合成（仅 http 引擎使用）。
			 * @param text - 要念的文本。
			 * @returns `{ blob }`。
			 */
			async function synthesize(text) {
				const response = await request("/tts", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text }),
				});
				return { blob: await response.blob() };
			}

			/**
			 * 探测宿主健康状态（含能力自省）。
			 * @returns 健康体；失败返回 `null`。
			 */
			async function health() {
				try {
					const response = await request("/health", { method: "GET" });
					return await response.json();
				} catch {
					return null;
				}
			}

			__exports({ readConfig, log, warn, polish, route, delegate, listExperts, addExpert, removeExpert, reports, interactions, activities, transcribe, synthesize, health });
		});

		__def("core/session.js", (__exports, __req) => {
			/**
			 * 会话桥（客户端）：把语音指令送进 DSH 会话，并把回答读出来。
			 *
			 * ## 会话从哪来：常驻 agent 优先
			 *
			 * `persistent`（默认）：retain 宿主在 DSH 层创建的**常驻 agent**会话
			 * （`config.agent.sessionId`，由宿主半 `lib/agent.js` 在启动时建好）。
			 * 语音链路不创建、也不需要打开任何 UI 会话 —— 用户对着电脑说话就行。
			 * 拿不到常驻 agent（精简 profile、宿主创建失败）时降级为 `dedicated`：
			 * 自建「小凤语音会话」，行为与旧版一致。
			 *
			 * ## 为什么 retain 而不是 binding
			 *
			 * `ctx.sessions.binding(id)` 只借"已经存在"的绑定，会话被其他视图释放后
			 * 就会失效（语音链路会在几分钟后静默断掉）。`retain` 显式持有一份引用，
			 * 生命周期归本插件所有，直到插件卸载。
			 *
			 * ## 只念新的
			 *
			 * 订阅 `eventSource` 前先把当前窗口的最大 `seq` 记为水位线。否则会话一打开，
			 * 历史里的所有 assistant 消息会被一次性念出来 —— 这是接入 TTS 时最经典的
			 * 翻车现场。常驻模式同样要水位线：agent 跨休眠续存，历史只会长。
			 */
			const { assistantTextOf } = __req("core/text.js");
			const { log, warn } = __req("core/runtime.js");

			/** 事件水位线的初始值（早于任何真实 seq）。 */
			const NO_SEQ = -1;

			/**
			 * 历史回放的时间容差（毫秒）。
			 *
			 * 判据是"事件的 `time` 是否早于绑定时刻"。留这段余量是为了容忍
			 * 浏览器与 DSH 服务的时钟差（远程访问时可能差几秒）：没有余量的话，
			 * 时钟快 1s 的浏览器会把**刚发生的新事件**也判成历史而丢掉。
			 * 历史动辄早几分钟，2s 余量远小于两者间隔，不会漏放历史。
			 */
			const HISTORY_SKEW_MS = 2000;

			/** 语音会话桥。 */
			class VoiceSession {
				/**
				 * @param options - `{ ctx, config, onTurnStart, onTurnEnd, onQuestionCall, onStatus, onError }`。
				 */
				constructor(options) {
					this.ctx = options.ctx;
					this.config = options.config;
					/**
					 * 会话 eq 水位的持久化存储（需求②，可空）。
					 *
					 * 由控制器注入（`createSeqWatermark()`）—— 放在这里而不是自己 new，
					 * 是为了让单测能把一个内存实现塞进来，也让"存储可不可用"这件事
					 * 有一个统一的出处。
					 */
					this.seqWatermark = options.seqWatermark ?? null;
					/** 绑定时采用持久化水位时的值（`null` = 用的是窗口水位，排障用）。 */
					this.savedCursorUsed = null;
					this.onTurnStart = options.onTurnStart ?? (() => {});
					this.onTurnEnd = options.onTurnEnd ?? (() => {});
					/**
					 * 发现一次 `ask_user_question` 调用时回调（主路径，见 `handleEvent`）。
					 *
					 * 为什么不走 `onTurnStart` 之类既有回调转一手：`tool/call` 与 turn
					 * 边界是**正交**的 —— 一次 turn 里可能既有工具调用又有最终回答，
					 * 混进 turn 回调会让"提问"和"回答"的语义互相污染。
					 */
					this.onQuestionCall = options.onQuestionCall ?? (() => {});
					this.onStatus = options.onStatus ?? (() => {});
					this.onError = options.onError ?? (() => {});

					this.sessionId = null;
					/** 会话来源：`persistent`（常驻 agent）| `dedicated` | `dedicated-fallback` | `switched`。 */
					this.mode = "";
					this.reference = null;
					this.binding = null;
					this.unsubscribe = null;
					/** 已处理到的事件序号。 */
					this.cursor = NO_SEQ;
					/** 当前 turn 里累积的 assistant 文本（按 step 覆盖，取最后一段）。 */
					this.turnText = "";
					this.ensuring = null;
					/**
					 * 显式指定的绑定目标（`switchTo` 设的）。
					 *
					 * 与 `sessionId` 的区别：`sessionId` 是"已经绑上了谁"，这个是"接下来要绑谁"。
					 * 分开是为了让 `createAndBind` 能区分三种意图 —— 跟随常驻 agent、自建一个、
					 * 还是绑死用户点名的那个。有了它，`switchTo` 不必重写整段绑定逻辑。
					 */
					this.pinnedId = null;
					/**
					 * 当前 pin 是否由**路由层**设置（区别于用户手动跨会话切换）。
					 *
					 * 两者都把 `mode` 置为 `switched`，但语义相反：
					 *   - 用户手动 pin（`routerPinned === false`）：比自动路由更强的意图
					 *     表达，路由让位，直到用户切回常驻助手；
					 *   - 路由 pin（`routerPinned === true`）：**每条指令都该重新路由**，
					 *     下一条话可能该换专家。
					 * 没有这个标记，第一次路由之后 `mode` 恒为 `switched`、路由被自己的
					 * 产物关掉（真机冒烟抓到：`smoke-questions` 报"期望 persistent
					 * 实际 switched"，即第一条指令路由后全部后续指令不再路由）。
					 */
					this.routerPinned = false;
					/**
					 * 最近几次 `prompt()` 的**原始**返回与异常（环形，保留 8 条）。
					 *
					 * 为什么留这个：`ask()` 把失败统一转成 `Error` 抛给上层，上层再包一层
					 * 人话提示。原始返回里那些 `ok:false` 的 `code` / `message` 就丢了，
					 * 而"提交到底被没被接受"恰恰只能从原始返回判断。排障时靠它一眼看清
					 * 「是提交被拒了」还是「提交成功、错误另有来源」。
					 */
					this.promptLog = [];
				}

				/**
				 * 确保会话就绪（幂等；并发调用共享同一次创建）。
				 *
				 * @param options - `{ open }`：是否在界面上打开该会话。
				 * @returns 会话绑定，或 `null`（DSH 会话服务不可用）。
				 */
				async ensure(options = {}) {
					if (this.binding !== null) {
						if (options.open === true) this.openInUi();
						return this.binding;
					}
					if (this.ensuring !== null) return this.ensuring;

					this.ensuring = this.createAndBind(options).finally(() => {
						this.ensuring = null;
					});
					return this.ensuring;
				}

				/** 是否应使用常驻 agent 会话。 */
				usingPersistent() {
					return (
						this.config.session?.mode === "persistent" &&
						this.config.agent?.enabled === true &&
						typeof this.config.agent?.sessionId === "string" &&
						this.config.agent.sessionId !== ""
					);
				}

				/**
				 * 真正创建/绑定会话。
				 *
				 * persistent 模式：直接 retain 常驻 agent 的 sessionId；retain 失败
				 * （会话不存在/宿主没建成）就降级为自建会话，别让语音链路整体断掉。
				 * @param options - `{ open }`。
				 */
				async createAndBind(options) {
					const sessions = this.ctx.get("sessions");
					if (!sessions) {
						this.onError(new Error("sessions-service-unavailable"));
						return null;
					}
					try {
						if (this.sessionId === null && this.pinnedId !== null) {
							// 用户点名要绑的那个（跨会话切换）。优先级最高 —— 连常驻 agent 都让位。
							this.sessionId = this.pinnedId;
							this.mode = "switched";
							log("绑定指定会话", this.sessionId);
						}
						if (this.sessionId === null && this.usingPersistent()) {
							this.sessionId = this.config.agent.sessionId;
							this.mode = "persistent";
							log("使用常驻 agent 会话", this.sessionId);
						}
						if (this.sessionId === null) {
							const created = await sessions.create(
								this.config.session.workspace !== "" ? { cwd: this.config.session.workspace } : {},
							);
							this.sessionId = created;
							this.mode = "dedicated";
							log("已创建语音会话", created);
						}

						let reference;
						try {
							reference = sessions.retain(this.sessionId, { source: "voice-assistant" });
						} catch (error) {
							// 只有**常驻会话**失败才降级自建（agent 可能没建成）；
							// 用户点名的会话绑不上就是绑不上，降级会悄悄换走目标、更糟。
							if (this.mode !== "persistent") throw error;
							warn("常驻 agent 会话不可用，降级为自建会话", error);
							this.sessionId = null;
							this.mode = "dedicated-fallback";
							return this.createAndBind(options);
						}
						this.reference = reference;
						let binding = reference.binding;
						if (binding === undefined || binding === null) {
							try {
								binding = await reference.ready;
							} catch (error) {
								binding = reference.binding;
								if (binding === undefined || binding === null) throw error;
							}
						}
						this.binding = binding;
						this.bindEvents(binding);
						if (options.open === true) this.openInUi();
						this.onStatus({ kind: "session-ready", sessionId: this.sessionId });
						return binding;
					} catch (error) {
						warn("会话准备失败", error);
						this.onError(error instanceof Error ? error : new Error(String(error)));
						return null;
					}
				}

				/** 在界面上打开语音会话（用户能看到逐句文本）。 */
				openInUi() {
					if (this.sessionId === null) return;
					const workspace = this.ctx.get("uiWorkspace");
					if (workspace && typeof workspace.openSession === "function") {
						try {
							workspace.openSession(this.sessionId);
						} catch (error) {
							// 打开失败不影响语音链路本身，只是用户看不到文本。
							warn("打开语音会话失败", error);
						}
					}
				}

				/** ── 跨会话：列出 / 切换 / 新建 ─────────────────────────────────── */

				/**
				 * 列出可以"把语音指令投过去"的会话。
				 *
				 * 只读 `ctx.sessions.list` 的快照（本地投影，不发请求）；需要更新的
				 * 列表时调 `refresh()`，那是宿主往返，由调用方决定要不要付这个代价。
				 *
				 * 过滤掉两类：
				 *   - `origin === 'subagent'`：子代理会话，按普通 id 投喂会被宿主拒
				 *     （`session/agent-busy`），列出来只会让用户选了报错；
				 *   - `blank === true`：空白会话，还没内容，投进去等于新建。
				 *
				 * @returns `{ id, title, cwd, running, current }[]`，最近的在前。
				 */
				listTargets() {
					const sessions = this.ctx.get("sessions");
					const snapshot = sessions?.list?.getSnapshot?.();
					const state = snapshot?.state ?? snapshot;
					const ids = Array.isArray(state?.ids) ? state.ids : [];
					const byId = state?.byId !== null && typeof state?.byId === "object" ? state.byId : {};
					const out = [];
					for (const id of ids) {
						const row = byId[id];
						if (row === null || row === undefined) continue;
						if (row.origin === "subagent") continue;
						if (row.blank === true) continue;
						out.push({
							id: row.id ?? id,
							title: typeof row.displayTitle === "string" && row.displayTitle !== "" ? row.displayTitle : String(row.title ?? id),
							cwd: typeof row.cwd === "string" ? row.cwd : "",
							running: row.running === true,
							// 常驻模式下列表里那个就是当前目标；否则比 pinnedId/sessionId。
							current: this.binding !== null && (row.id ?? id) === this.sessionId,
						});
					}
					return out;
				}

				/**
				 * 把语音指令的目标**切到**另一个会话。
				 *
				 * ## 切换必须重建整条订阅链，不能只换 sessionId
				 *
				 * 水位线（`cursor`）与时间地板（`floorTime`）都是**相对某一条会话**算的：
				 *   - `cursor` 是那条会话的 seq，换会话后毫无意义；
				 *   - `floorTime` 是"绑定时刻 − 2s"，专为拦住那条会话的历史回放。
				 * 只换 id 不重置这两样，新会话的历史就会整批灌进来被当成新事件念出去 ——
				 * 正是本项目已经踩过的那类"翻车现场"（见 `bindEvents` 的长注释）。
				 * 所以这里先 `dispose()` 释放旧引用与订阅，再走一遍完整的 `ensure()`。
				 *
				 * @param sessionId - 目标会话 id。
				 * @param options - `{ router?: boolean }`：由路由层发起的切换置 `routerPinned`。
				 * @returns 是否切换成功。
				 */
				async switchTo(sessionId, options = {}) {
					const id = typeof sessionId === "string" ? sessionId.trim() : "";
					if (id === "") return false;
					if (this.binding !== null && this.sessionId === id) {
						// 目标没变也要刷新归属：用户手动 pin 之后路由想切回同一会话时，
						// 归属必须翻成路由的（否则后续指令会被"用户手动 pin"挡住不路由）。
						if (options.router === true) this.routerPinned = true;
						return true;
					}
					this.dispose();
					this.sessionId = null;
					this.mode = "";
					this.cursor = NO_SEQ;
					this.turnText = "";
					this.pinnedId = id;
					this.routerPinned = options.router === true;
					const binding = await this.ensure({ open: false });
					if (binding === null) {
						// 切不过去就退回常驻会话，别把用户留在"没有目标"的状态。
						this.pinnedId = null;
						this.routerPinned = false;
						this.sessionId = null;
						await this.ensure({ open: false });
						return false;
					}
					this.onStatus({ kind: "session-switched", sessionId: this.sessionId });
					return true;
				}

				/**
				 * 当前绑定的人类可读描述（界面用）。
				 *
				 * `sessionId` 是 8 位十六进制串，直接显示给用户等于没显示。这里把它
				 * 翻成"常驻助手 / 某个会话的标题 / 语音专用会话"，用户才看得懂
				 * 现在说的话会进哪儿 —— 跨会话功能唯一真正重要的信息就是这个。
				 *
				 * @returns `{ mode, label, id }`。
				 */
				describe() {
					const id = this.sessionId;
					if (id === null || id === undefined) return { mode: "", label: "尚未建立", id: null };
					if (this.mode === "persistent") return { mode: this.mode, label: "小凤 · 常驻助手", id };
					if (this.mode === "dedicated-fallback") return { mode: this.mode, label: "语音专用会话（常驻不可用，已降级）", id };
					if (this.mode === "dedicated") return { mode: this.mode, label: "语音专用会话", id };
					const row = this.listTargets().find((item) => item.id === id);
					if (row !== undefined) return { mode: this.mode, label: row.title, id };
					return { mode: this.mode, label: String(id).slice(0, 8), id };
				}

				/**
				 * 新建一个会话，并把语音目标切过去。
				 *
				 * 用 `ctx.sessions.create()`（宿主侧创建）而不是 `uiWorkspace.startSession()`：
				 * 后者要往编辑器草稿里放文本、依赖 UI 导航选中，语音链路没有"当前选中"
				 * 这个概念（`uiWorkspace` 也不暴露读面）。直接 create + switchTo 更确定：
				 * 建好就绑上，随后 `ask()` 的指令自然落进这个新会话。
				 *
				 * @param options - `{ cwd, title }`。
				 * @returns 新会话 id，或 `null`（服务不可用/创建失败）。
				 */
				async createAndSwitch(options = {}) {
					const sessions = this.ctx.get("sessions");
					if (sessions === null || sessions === undefined || typeof sessions.create !== "function") {
						this.onError(new Error("sessions-service-unavailable"));
						return null;
					}
					const cwd = typeof options.cwd === "string" && options.cwd.trim() !== "" ? options.cwd.trim() : this.config.session.workspace;
					try {
						const created = await sessions.create(cwd === "" ? {} : { cwd });
						const id = typeof created === "string" ? created : created?.sessionId;
						if (typeof id !== "string" || id === "") throw new Error("create-returned-no-id");
						const ok = await this.switchTo(id);
						if (!ok) return null;
						this.onStatus({ kind: "session-created", sessionId: id, title: options.title ?? "" });
						return id;
					} catch (error) {
						warn("新建会话失败", error);
						this.onError(error instanceof Error ? error : new Error(String(error)));
						return null;
					}
				}

				/** 切回常驻助手会话（跨会话聊完之后的"回家"）。 */
				async switchToPersistent() {
					if (!this.usingPersistent()) return false;
					this.dispose();
					this.sessionId = null;
					this.mode = "";
					this.cursor = NO_SEQ;
					this.turnText = "";
					this.pinnedId = null;
					this.routerPinned = false;
					const binding = await this.ensure({ open: false });
					return binding !== null;
				}

				/**
				 * 订阅事件窗口。
				 *
				 * ## 为什么光有 seq 水位线不够（真机实测踩坑）
				 *
				 * 常驻 agent 的**历史是异步水合的**，不是在 `retain()` 返回时就位：
				 *
				 * ```
				 * retain() 返回 → getSnapshot().entries === []   → 水位线 = -1
				 *        ↓ 84ms
				 * 116 条历史整批灌入（seq 0..115，含几分钟前的 turn）
				 * ```
				 *
				 * 水位线按"窗口里有多大 seq"算，窗口是空的就只能定成 −1，于是**没挡住任何东西**。
				 * 紧接着历史里那条**上一轮失败的 `turn/end`**（`reason.kind === "error"`）
				 * 被当成刚发生的事重放 —— 现象极具误导性：
				 * **回答念出来了，界面却同时挂着一条陈年报错**，而且每次刷新页面都复现。
				 *
				 * 实测证据（`__xfvDebug.hydration()` + `fails()`）：
				 * `bindEntryCount:0`、`cursorAtBind:-1`、绑定后 84ms 触发 `fail()`，
				 * 而 `prompt()` 的原始返回是 `{"ok":true,"value":{"accepted":true}}` —— 提交本身成功。
				 *
				 * ## 改用事件自带的 `time` 当前置地板
				 *
				 * 每条事件都有服务端时间戳（`{ type, seq, time, data }`），它**不受水合时机影响**：
				 * 历史事件的 `time` 一律远早于我们绑定的时刻，新事件一律晚于。
				 * 所以判据是：
				 *
				 * ```
				 * time < boundAt - HISTORY_SKEW_MS  →  历史回放：只推进游标，不触发回调
				 * ```
				 *
				 * ## 这套判据的适用前提（重要）
				 *
				 * 它依赖「浏览器时钟 ≈ 服务端时钟」。设 δ = 浏览器时钟 − 服务端时钟：
				 *
				 * | 情形 | 结果 |
				 * |---|---|
				 * | `δ ≈ 0`（本机 / 同机部署） | 正确：历史被拦、新事件放行 |
				 * | `δ > +2s`（浏览器偏快） | **新事件也会被当历史拦掉** |
				 * | `δ < 0`（浏览器偏慢） | 历史可能漏放（不会漏掉新事件） |
				 *
				 * 本插件面向的是**同机部署**（`127.0.0.1:3080`，浏览器与服务在同一台机器，
				 * δ 基本为 0），所以取 2s 余量足够。两处保险：
				 * ① seq 水位线仍然生效 —— 窗口在绑定时已就绪（非本机首次加载之外的多数情形）
				 * 时由它兜住，时间地板只是补"窗口为空"那个缺口；
				 * ② 若真要用于远程访问且两端时钟差很大，应把 `HISTORY_SKEW_MS` 调大，
				 * 或改为由服务端下发"水合完成"标记（见第九节升级路线）。
				 *
				 * 兜底：若某个旧 `turn/start`…`turn/end` 整段因时钟差漏放，
				 * 它同样是**完整**漏放，`turnText` 非空 → 会念出陈年回答。
				 * 也就是说本机制**防的是"历史整批涌入"，防不了时钟严重错位** ——
				 * 后者属于环境问题，不该用逻辑去猜。
				 *
				 * @param binding - 会话绑定。
				 */
				bindEvents(binding) {
					const source = binding.eventSource;
					if (!source || typeof source.subscribe !== "function") return;

					// 先取水位线，再做订阅：两次调用之间到达的事件会被下一次回调看到。
					const initial = source.getSnapshot();
					const initialEntries = initial?.entries ?? [];
					this.cursor = maxSeq(initialEntries, NO_SEQ);
					this.turnText = "";
					// 诊断留痕：绑定时窗口里有没有东西，决定了水位线可不可信。
					this.boundAt = Date.now();
					this.bindEntryCount = countEvents(initialEntries);
					// ## 需求②：持久化水位
					//
					// 窗口为空时 `this.cursor` 是 −1，随后历史整批灌入；那道时间地板
					// （`floorTime`）对**没有 `time` 字段的事件**是**放行**的
					// （`if (time !== null && time < floorTime)`，`time` 为 null 就不判）。
					// 于是没有时间戳的历史会被当新事件处理，助手把旧回答又念一遍。
					//
					// `seq` 是**按会话单调的整数**，天生跨刷新可比 —— 比时间戳硬得多。
					// 这里从持久化水位里取"上回处理到哪"，取它和窗口最大 seq 的较大值：
					// 窗口里有内容时用它（更可信），窗口为空时靠持久化记录兜住。
					const savedSeq = this.seqWatermark?.read(this.sessionId);
					if (Number.isFinite(savedSeq) && savedSeq > this.cursor) {
						this.cursor = savedSeq;
						this.savedCursorUsed = savedSeq;
					} else {
						this.savedCursorUsed = null;
					}
					this.cursorAtBind = this.cursor;
					/** 历史回放的时间地板（见方法注释）。 */
					this.floorTime = this.boundAt - HISTORY_SKEW_MS;
					/** 被判定为历史回放而拦下的事件数（诊断用）。 */
					this.skippedHistory = 0;

					this.unsubscribe = source.subscribe(() => {
						const snapshot = source.getSnapshot();
						const entries = snapshot?.entries ?? [];
						for (const entry of entries) {
							if (entry === null || typeof entry !== "object") continue;
							if (entry.type !== "event") continue;
							const event = entry.event;
							const seq = typeof event?.seq === "number" ? event.seq : null;
							if (seq !== null && seq <= this.cursor) continue;
							// 历史回放：推进游标（避免反复评估）但不触发回调。
							const time = typeof event?.time === "number" ? event.time : null;
							if (time !== null && time < this.floorTime) {
								this.skippedHistory += 1;
								this.advanceCursor(seq);
								continue;
							}
							// ## 需求②：没有时间戳的事件不能默认放行
							//
							// 旧实现只判 `time !== null`，于是 `time` 缺失的事件**直接放行**
							// （见上面那句 `time !== null && …`）。刷新时代价是水位归零、
							// 历史整批灌入，其中的无时间戳事件会被当成新事件念出来 ——
							// 表现就是"前面汇报过的内容再打开又播一遍"。
							//
							// 绑定时刻已有一批历史（`bindEntryCount > 0`）说明窗口是
							// "带着历史"进来的：这时 `seq <= cursorAtBind` 的一律算历史。
							// 反过来窗口为空（本机首次加载）时不能这么判 —— 那时后续
							// 整批灌入的都是要处理的新事件。
							if (time === null && this.bindEntryCount > 0 && seq !== null && seq <= this.cursorAtBind) {
								this.skippedHistory += 1;
								this.advanceCursor(seq);
								continue;
							}
							this.advanceCursor(seq);
							this.handleEvent(event);
						}
					});
				}

				/**
				 * 推进事件水位（需求②：落持久化，让"处理到哪"跨刷新有效）。
				 * @param seq - 事件序号（`null` = 该事件没有 seq，忽略）。
				 */
				advanceCursor(seq) {
					if (seq === null || !Number.isFinite(seq) || seq <= this.cursor) return;
					this.cursor = seq;
					// 落盘失败只是丢持久化，不该影响本轮处理（`write` 内部只前进不后退）。
					try {
						this.seqWatermark?.write(this.sessionId, seq);
					} catch {
						// 存储不可用：退化成旧的"仅内存"行为，不抛。
					}
				}

				/**
				 * 处理单个会话事件。
				 *
				 * ## 负载在 `data` 里（实测踩坑）
				 *
				 * DSH 的会话事件形状是 `{ type, seq, time, data }` —— **业务字段全在
				 * `data` 下**，顶层只有 type/seq/time。早期版本按扁平结构读
				 * （`event.turn` / `event.reason` / `event.message`），结果全部拿到
				 * `undefined`：turn 边界照常触发（type 是对的）但 reason 永远为空、
				 * assistant 文本永远是空串 —— 现象是"回答念不出来"却又"看不出哪里错"。
				 *
				 * 这里统一先解一层 `data`，同时**兼容扁平形态**（老版本/测试桩），
				 * 免得把已有桩件全打翻。
				 *
				 * @param event - 会话事件。
				 */
				handleEvent(event) {
					if (event === null || typeof event !== "object") return;
					const payload = event.data !== null && typeof event.data === "object" ? event.data : event;
					// 提问旁听走**同一条事件流**（在 switch 之前，因为它与 turn 边界正交：
					// `tool/call` 发生在 turn 中间，不该等 turn 结束才处理）。
					//
					// 为什么必须从这里读、而不是只订阅 `userQuestions` 投影：
					// 投影对 `tool/call` 先判 `fold.timed`，而 `timed` 由 tool schema
					// 是否声明 `timeout` 决定；`dsh-tool-ask-user` 默认 `mode: legacy`
					// → **投影恒空**。原始事件流没有这道闸门。详见 questions.js 顶部。
					if (event.type === "tool/call") this.onQuestionCall(event);
					switch (event.type) {
						case "turn/start":
							this.turnText = "";
							this.onTurnStart({ turn: payload.turn });
							break;
						case "assistant/message": {
							// 每个 step 一条 assistant/message；取**最后一条**作为本 turn 的回答，
							// 因为多步任务里真正给用户看的结论在最后。
							// assistantTextOf 自己兼容 {data:{message}} 与 {message} 两种形态。
							const text = assistantTextOf(event);
							if (text.trim() !== "") this.turnText = text;
							break;
						}
						case "turn/end":
							this.onTurnEnd({ turn: payload.turn, reason: payload.reason, text: this.turnText });
							this.turnText = "";
							break;
						default:
							break;
					}
				}

				/**
				 * 把一句（已润色的）指令送进会话。
				 *
				 * @param text - 指令文本。
				 * @param mode - `"queue"`（默认，开新 turn）或 `"steer"`（插进正在跑的 turn）。
				 * @returns 是否被宿主接受。
				 */
				async ask(text, mode = "queue") {
					// 常驻 / 切换模式下都不自动打开 UI：语音就是"不占会话"的使用方式；
					// 想看记录可以自己点开（dedicated 模式仍自动打开，沿用旧行为）。
					const binding = await this.ensure({ open: this.mode === "dedicated" });
					if (binding === null) return false;
					const content = String(text ?? "").trim();
					if (content === "") return false;
					try {
						const result = await binding.session.prompt([{ type: "text", text: content }], mode);
						this.recordPrompt(mode, content, result, null);
						if (result !== null && typeof result === "object" && result.ok === false) {
							const failure = result.error ?? {};
							throw new Error(String(failure.message ?? failure.code ?? "prompt-rejected"));
						}
						return true;
					} catch (error) {
						this.recordPrompt(mode, content, undefined, error);
						warn(mode === "steer" ? "插话提交失败" : "指令提交失败", error);
						this.onError(error instanceof Error ? error : new Error(String(error)));
						return false;
					}
				}

				/**
				 * 记一条 `prompt()` 的原始结果。
				 * @param mode - `queue` | `steer`。
				 * @param content - 提交的文本。
				 * @param result - `prompt()` 的原始返回（异常时为 `undefined`）。
				 * @param error - 抛出的异常，或 `null`。
				 */
				recordPrompt(mode, content, result, error) {
					this.promptLog.push({
						at: Date.now(),
						mode,
						text: content.slice(0, 80),
						ok: error === null ? result?.ok ?? "(非对象)" : "(throws)",
						error: error === null ? undefined : String(error?.message ?? error),
						raw: error === null ? safeJson(result) : undefined,
					});
					if (this.promptLog.length > 8) this.promptLog.shift();
				}

				/**
				 * 思考中插话纠偏：steer 进正在运行的 turn（agent 在下一个 step 边界消费）。
				 * @param text - 纠偏文本。
				 * @returns 是否被接受。
				 */
				async steer(text) {
					return this.ask(text, "steer");
				}

				/** 中断当前 turn（用户说"停"或点击打断时用）。 */
				async cancel() {
					if (this.binding === null) return;
					try {
						await this.binding.session.cancel();
					} catch (error) {
						warn("取消失败", error);
					}
				}

				/** 释放引用与订阅。 */
				dispose() {
					if (typeof this.unsubscribe === "function") {
						try {
							this.unsubscribe();
						} catch {
							// 已经释放。
						}
						this.unsubscribe = null;
					}
					if (this.reference !== null) {
						try {
							this.reference.release();
						} catch (error) {
							warn("释放会话引用失败", error);
						}
						this.reference = null;
					}
					this.binding = null;
				}
			}

			/**
			 * 取事件窗口里最大的 seq。
			 * @param entries - `SessionEventLikeEntry[]`。
			 * @param fallback - 无 seq 时的兜底。
			 */
			function maxSeq(entries, fallback) {
				let max = fallback;
				for (const entry of entries) {
					if (entry === null || typeof entry !== "object" || entry.type !== "event") continue;
					const seq = entry.event?.seq;
					if (typeof seq === "number" && seq > max) max = seq;
				}
				return max;
			}

			/**
			 * 数一数窗口里有多少条真正的事件（诊断用）。
			 * @param entries - 事件窗口条目。
			 * @returns 事件条数。
			 */
			function countEvents(entries) {
				let total = 0;
				for (const entry of entries) {
					if (entry !== null && typeof entry === "object" && entry.type === "event") total += 1;
				}
				return total;
			}

			/**
			 * 安全序列化（用于诊断日志，任何异常都不该影响主链路）。
			 * @param value - 任意值。
			 * @returns 截断后的 JSON 字符串。
			 */
			function safeJson(value) {
				if (value === undefined) return "(undefined)";
				try {
					const text = JSON.stringify(value);
					return typeof text === "string" ? text.slice(0, 400) : String(value);
				} catch {
					return "(unserializable)";
				}
			}

			__exports({ VoiceSession });
		});

		__def("core/text.js", (__exports, __req) => {
			/**
			 * 文本处理：播报前清洗、分句、从会话事件里取回答文本。
			 *
			 * ## 为什么播报前一定要洗
			 *
			 * agent 的回答是 **Markdown**，而 TTS 会把符号当字念出来：
			 * `**加粗**` 念成"星号星号加粗星号星号"，`[链接](url)` 把整条 URL 念一遍，
			 * 代码块会把缩进和括号全念出来。这不是"不够优雅"，是根本没法听。
			 *
			 * 所以播报走一条独立的清洗管线，与界面显示彻底分开：
			 * 界面保留完整 Markdown，播报只留"能听懂的那部分"。
			 */

			/** 代码块围栏。 */
			const FENCE = /```[\s\S]*?```/g;
			/** 行内代码。 */
			const INLINE_CODE = /`([^`]*)`/g;
			/** 图片：整条丢掉（无法朗读）。 */
			const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
			/** 链接：保留文字，丢掉 URL。 */
			const LINK = /\[([^\]]*)\]\([^)]*\)/g;
			/** 裸 URL。 */
			const BARE_URL = /https?:\/\/\S+/g;
			/** HTML 标签。 */
			const TAG = /<[^>]+>/g;
			/** 强调与标题标记。 */
			const EMPHASIS = /(^|\s)([#>*_~]{1,6}|-{3,})(\s|$)/g;
			/** 列表前缀。 */
			const LIST_PREFIX = /^\s*(?:[-*+•]|\d+[.)])\s+/gm;
			/** 表格分隔线。 */
			const TABLE_RULE = /^\s*\|?[\s:|-]{3,}\|?\s*$/gm;
			/** 表格竖线。 */
			const TABLE_PIPE = /\|/g;
			/** Emoji（粗略范围，够用即可）。 */
			const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

			/**
			 * 把 Markdown 清洗成"适合朗读的纯文本"。
			 *
			 * @param text - 原始文本。
			 * @param options - `{ keepUrl }`：是否保留裸链接（默认 false，念 URL 体验极差）。
			 * @returns 纯文本。
			 */
			function stripForSpeech(text, options = {}) {
				if (typeof text !== "string") return "";
				let out = text;
				out = out.replace(FENCE, "，代码略。");
				out = out.replace(IMAGE, "");
				out = out.replace(LINK, "$1");
				if (options.keepUrl !== true) out = out.replace(BARE_URL, "（链接略）");
				out = out.replace(INLINE_CODE, "$1");
				out = out.replace(TAG, "");
				out = out.replace(TABLE_RULE, "");
				out = out.replace(TABLE_PIPE, "，");
				out = out.replace(LIST_PREFIX, "");
				out = out.replace(EMPHASIS, " ");
				out = out.replace(EMOJI, "");
				out = out.replace(/[*_`#>~|]+/g, "");
				out = out.replace(/[ \t]+/g, " ");
				out = out.replace(/\n{2,}/g, "\n");
				out = out.replace(/\n/g, "，");
				// 竖线/换行转换后常留下"空格 + 逗号"的组合，读出来会多一次停顿感；
				// 统一收成紧贴的逗号。
				out = out.replace(/\s*，\s*/g, "，");
				out = out.replace(/，{2,}/g, "，");
				out = out.replace(/^，+/, "").replace(/，+$/, "").trim();
				return out;
			}

			/**
			 * 按句子切分播报片段。
			 *
			 * 为什么要切：一条几百字的回答一次性塞进 `speechSynthesis.speak()`，
			 * 用户在念到一半时想打断/追问，取消的粒度太粗；而且某些浏览器对
			 * 超长 utterance 会静默截断。按句切分后可以逐句播、逐句取消。
			 *
			 * @param text - 已清洗的文本。
			 * @param maxLen - 单段字符上限。
			 * @returns 片段数组（无空段）。
			 */
			function splitForSpeech(text, maxLen = 80) {
				const source = typeof text === "string" ? text.trim() : "";
				if (source === "") return [];
				const sentences = source.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) ?? [source];
				const chunks = [];
				for (const sentence of sentences) {
					const piece = sentence.trim();
					if (piece === "") continue;
					if (piece.length <= maxLen) {
						chunks.push(piece);
						continue;
					}
					// 超长句按逗号再切；仍超长就硬切（宁可断，也不能被浏览器截断）。
					for (const clause of piece.split(/(?<=[，,、])/)) {
						if (clause.length <= maxLen) {
							chunks.push(clause);
							continue;
						}
						for (let i = 0; i < clause.length; i += maxLen) chunks.push(clause.slice(i, i + maxLen));
					}
				}
				return chunks.filter((chunk) => chunk.replace(/[\s，,。.！!？?；;]/g, "") !== "");
			}

			/**
			 * 从一段消息内容里拼出纯文本。
			 *
			 * 兼容三种形态（不同版本的 DSH 与不同 provider 会给出不同结构）：
			 *   - 字符串；
			 *   - `{ type:'text', text }` 内容块数组；
			 *   - `{ text }` 单块。
			 *
			 * 只取 `text` 类块，**跳过推理块** —— 思维链不该被念出来。
			 *
			 * @param content - 消息内容。
			 * @returns 纯文本（可能为空串）。
			 */
			function textFromContent(content) {
				if (typeof content === "string") return content;
				if (Array.isArray(content)) {
					const parts = [];
					for (const block of content) {
						if (block === null || typeof block !== "object") continue;
						if (block.type !== undefined && block.type !== "text") continue;
						if (typeof block.text === "string") parts.push(block.text);
					}
					return parts.join("\n");
				}
				if (content !== null && typeof content === "object" && typeof content.text === "string") return content.text;
				return "";
			}

			/**
			 * 从 `assistant/message` 事件里取回答文本。
			 *
			 * 会话事件的业务字段在 `data` 下（`{ type, seq, time, data }`）。这里同时
			 * 兼容两种形态，让调用方不必关心包了几层：
			 *   - 完整事件：`{ type:'assistant/message', data:{ message } }`
			 *   - 已解包：`{ type:'assistant/message', message }`
			 * 早期只认后者，导致读到的永远是空串 —— 界面显示正常、语音却一句不念。
			 *
			 * @param event - 会话事件（完整或已解包）。
			 * @returns 纯文本（非 assistant/message 事件返回空串）。
			 */
			function assistantTextOf(event) {
				if (event === null || typeof event !== "object") return "";
				if (event.type !== "assistant/message") return "";
				const payload = event.data !== null && typeof event.data === "object" ? event.data : event;
				if (payload.interrupted === true) return "";
				const message = payload.message;
				if (message === null || typeof message !== "object") return "";
				return textFromContent(message.content);
			}

			__exports({ stripForSpeech, splitForSpeech, textFromContent, assistantTextOf });
		});

		__def("core/tts.js", (__exports, __req) => {
			/**
			 * 播报器（客户端）。
			 *
			 * ## 两条引擎，一套接口
			 *
			 * - `browser`：`speechSynthesis`。零配置、零延迟、零流量，用系统自带的中文语音。
			 *   缺点是音色取决于本机装了哪些语音包（Windows 上通常是"慧慧/晓晓"那一类）。
			 * - `http`：宿主代理到 OpenAI 兼容 `/audio/speech`。音色统一、质量高，
			 *   代价是有一次网络往返（首字延迟 300–800ms）。
			 *
			 * 两者都实现 `speak(text)` / `cancel()`，上层不必关心用的是哪条。
			 *
			 * ## 为什么逐句播而不是整段播
			 *
			 * 见 `text.js` 的 `splitForSpeech`：整段塞进去，用户中途想打断时取消粒度太粗，
			 * 而且部分浏览器对超长 utterance 会静默截断（听起来像"念到一半没了"）。
			 *
			 * ## 为什么一定要 cancel 兜底
			 *
			 * `speechSynthesis` 有个著名坑：调用 `cancel()` 之后立刻 `speak()`，
			 * 新的一句会被静默丢弃。做法是 cancel 之后 `await` 一个极短延时再开口。
			 */
			const { splitForSpeech, stripForSpeech } = __req("core/text.js");
			const { SPEECH_CHUNK_MAX } = __req("core/constants.js");
			const { synthesize, warn } = __req("core/runtime.js");

			/** cancel 之后的静默间隔（毫秒）。见文件头注释。 */
			const CANCEL_SETTLE_MS = 60;

			/**
			 * 挑一个中文语音。
			 *
			 * 优先级：配置指定 > 精确语言匹配 > 语言前缀匹配 > 任意语音。
			 * 之所以要兜底到"任意语音"，是因为有些 Linux 环境只装了一个英文语音：
			 * 这时用英文语音念中文虽然难听，但**能听见**，比静默失败强。
			 *
			 * @param voices - `speechSynthesis.getVoices()` 的结果。
			 * @param hint - 配置里的音色名（可为空）。
			 * @param language - 目标语言。
			 * @returns 选中的语音或 `null`。
			 */
			function pickVoice(voices, hint, language) {
				if (!Array.isArray(voices) || voices.length === 0) return null;
				if (typeof hint === "string" && hint !== "") {
					const exact = voices.find((voice) => voice.name === hint);
					if (exact) return exact;
					const fuzzy = voices.find((voice) => voice.name.toLowerCase().includes(hint.toLowerCase()));
					if (fuzzy) return fuzzy;
				}
				const normalized = String(language ?? "zh-CN").toLowerCase();
				const prefix = normalized.split("-")[0];
				const exactLang = voices.find((voice) => String(voice.lang ?? "").toLowerCase() === normalized);
				if (exactLang) return exactLang;
				const prefixLang = voices.find((voice) => String(voice.lang ?? "").toLowerCase().startsWith(prefix));
				if (prefixLang) return prefixLang;
				return voices[0] ?? null;
			}

			/**
			 * 等待语音列表就绪。
			 *
			 * `getVoices()` 在部分浏览器首次调用返回空数组，要等 `voiceschanged`。
			 * 但**不能无限等**：某些环境（无音频设备的 CI、Linux 容器）永远不触发该事件，
			 * 无限等会让第一句播报永远挂住。所以给一个上限。
			 *
			 * @param timeoutMs - 上限毫秒。
			 * @returns 语音列表（可能为空数组）。
			 */
			function loadVoices(timeoutMs = 1200) {
				const synth = globalThis.speechSynthesis;
				if (!synth) return Promise.resolve([]);
				const immediate = synth.getVoices?.() ?? [];
				if (immediate.length > 0) return Promise.resolve(immediate);
				return new Promise((resolve) => {
					let settled = false;
					const finish = () => {
						if (settled) return;
						settled = true;
						synth.removeEventListener?.("voiceschanged", onChanged);
						clearTimeout(timer);
						resolve(synth.getVoices?.() ?? []);
					};
					const onChanged = () => finish();
					const timer = setTimeout(finish, timeoutMs);
					synth.addEventListener?.("voiceschanged", onChanged);
				});
			}

			/** 播报器。 */
			class Speaker {
				/**
				 * @param options - `{ getConfig: () => config, onChunk?: (text) => void }`。
				 */
				constructor(options) {
					this.getConfig = options.getConfig;
					this.onChunk = options.onChunk ?? (() => {});
					/** 当前代：每次 cancel 递增，用来让在途的异步链自废。 */
					this.generation = 0;
					/** 正在播放的 HTMLAudioElement（http 引擎用）。 */
					this.audio = null;
					this.speaking = false;
				}

				/** 立刻停止播报（幂等）。 */
				cancel() {
					this.generation += 1;
					this.speaking = false;
					if (this.audio !== null) {
						try {
							this.audio.pause();
							this.audio.src = "";
						} catch {
							// 音频已被回收，忽略。
						}
						this.audio = null;
					}
					const synth = globalThis.speechSynthesis;
					if (synth) {
						try {
							synth.cancel();
						} catch {
							// 同上。
						}
					}
				}

				/**
				 * 播报一段文本。
				 *
				 * @param text - 原始文本（可以是 Markdown，内部会清洗）。
				 * @returns 播完（或被取消）后 resolve；`{ spoken, reason }` 描述结果。
				 */
				async speak(text) {
					this.cancel();
					const generation = this.generation;
					const config = this.getConfig();
					const cleaned = stripForSpeech(text);
					const chunks = splitForSpeech(cleaned, SPEECH_CHUNK_MAX);
					if (chunks.length === 0) return { spoken: false, reason: "empty" };

					this.speaking = true;
					try {
						if (config.tts.engine === "http" && config.tts.httpReady) {
							try {
								await this.speakViaHttp(chunks, config, generation);
								return { spoken: true, reason: "http" };
							} catch (error) {
								// 上游不可用时**不能哑火**：退回系统语音，用户至少能听见。
								warn("上游 TTS 失败，退回系统语音：", error?.message ?? error);
							}
						}
						await this.speakViaBrowser(chunks, config, generation);
						return { spoken: true, reason: "browser" };
					} finally {
						if (generation === this.generation) this.speaking = false;
					}
				}

				/**
				 * 用 `speechSynthesis` 逐句播。
				 * @param chunks - 句子片段。
				 * @param config - 归一化配置。
				 * @param generation - 调用时的代号。
				 */
				async speakViaBrowser(chunks, config, generation) {
					const synth = globalThis.speechSynthesis;
					if (!synth || typeof globalThis.SpeechSynthesisUtterance !== "function") {
						throw new Error("speech-synthesis-unavailable");
					}
					const voices = await loadVoices();
					const voice = pickVoice(voices, config.tts.voice, config.language);

					for (const chunk of chunks) {
						if (generation !== this.generation) return;
						this.onChunk(chunk);
						await new Promise((resolve) => {
							const utterance = new globalThis.SpeechSynthesisUtterance(chunk);
							utterance.lang = config.language;
							utterance.rate = config.tts.rate;
							utterance.pitch = 1;
							if (voice) utterance.voice = voice;
							let done = false;
							const finish = () => {
								if (done) return;
								done = true;
								resolve();
							};
							utterance.onend = finish;
							// `interrupted`/`canceled` 是主动取消的产物，不算错误。
							utterance.onerror = finish;
							try {
								synth.speak(utterance);
							} catch (error) {
								warn("speak 调用失败", error);
								finish();
							}
							// 安全兜底：个别浏览器不触发 onend（尤其切标签页后），
							// 按字数估一个上限，避免整条播报链永远挂住。
							setTimeout(finish, Math.max(3000, chunk.length * 320));
						});
						// cancel 后立即 speak 会被吞掉，这里给一帧间隔。
						await new Promise((resolve) => setTimeout(resolve, CANCEL_SETTLE_MS));
					}
				}

				/**
				 * 用上游音频逐句播。
				 * @param chunks - 句子片段。
				 * @param config - 归一化配置。
				 * @param generation - 调用时的代号。
				 */
				async speakViaHttp(chunks, config, generation) {
					for (const chunk of chunks) {
						if (generation !== this.generation) return;
						this.onChunk(chunk);
						const { blob } = await synthesize(chunk);
						if (generation !== this.generation) return;
						const url = URL.createObjectURL(blob);
						try {
							await new Promise((resolve, reject) => {
								const audio = new Audio(url);
								this.audio = audio;
								audio.playbackRate = config.tts.rate;
								audio.onended = () => resolve();
								audio.onerror = () => reject(new Error("audio-playback-failed"));
								audio.play().catch(reject);
							});
						} finally {
							URL.revokeObjectURL(url);
							this.audio = null;
						}
					}
				}
			}

			__exports({ pickVoice, Speaker });
		});

		__def("core/turn.js", (__exports, __req) => {
			/**
			 * 轮次门槛（Turn Gate）：把识别片段攒成**一整轮**用户发言，再交给模型。
			 *
			 * ## 它解决什么
			 *
			 * 识别引擎的产物是**片段**，不是**发言**。浏览器识别一句一结、VAD 700ms
			 * 就切段 —— 这些粒度是给字幕用的，直接当"用户说完了"会出两个真实故障：
			 *
			 *   1. 话没说完就被提交：用户说"帮我打开 D 盘，然后……"（停顿想词），
			 *      引擎在 1 秒静音处切段并提交，模型只看到前半句。
			 *   2. 一个意图被拆成多次提交：用户连说三句组成一个完整需求，
			 *      却触发了三轮对话，助手三份回答互相不知道对方存在。
			 *
			 * 所以把「片段」和「轮次」彻底分开：引擎继续按它的粒度出片段，
			 * 这里负责累积，直到**静音超过 `silenceMs`**（默认 10 秒）才提交一次。
			 *
			 * ## 两条必须有的边界
			 *
			 * - **硬上限 `maxTurnMs`**：判据是"静音才提交"，那**连续不断**说话就永远不会
			 *   触发提交，累积文本会无限膨胀直到撑爆模型上下文。这是纯逻辑缺陷，
			 *   不是用户意图，所以到点无论如何提交一次（5 分钟，长到不打断任何正常表达）。
			 * - **手动提交 `flush()`**：等满静音阈值是默认行为，但人总有"我说完了，快答"
			 *   的时候。单击语音球即可立即提交（见 `controller.primaryAction`）。
			 *
			 * ## 为什么做成纯类
			 *
			 * 时间、定时器全部可注入（`now` / `setTimer` / `clearTimer`），
			 * 于是"抖动静音计时、到点提交、超硬上限提交、重复片段去重"这些
			 * 最容易写错的部分可以脱离浏览器和麦克风直接测。
			 */
			const { MAX_TURN_MS, SILENCE_SUBMIT_MS } = __req("core/constants.js");

			/** 轮次门槛。 */
			class TurnGate {
				/**
				 * @param options - `{ silenceMs, maxTurnMs, onCommit, join, now, setTimer, clearTimer }`。
				 *   `onCommit({ text, reason })` 在提交时调用；`reason` 为
				 *   `"silence"`（静音到点）/ `"cap"`（触到硬上限）/ `"manual"`（手动）。
				 */
				constructor(options = {}) {
					this.silenceMs = Number.isFinite(options.silenceMs) && options.silenceMs > 0 ? options.silenceMs : SILENCE_SUBMIT_MS;
					this.maxTurnMs = Number.isFinite(options.maxTurnMs) && options.maxTurnMs > 0 ? options.maxTurnMs : MAX_TURN_MS;
					this.onCommit = typeof options.onCommit === "function" ? options.onCommit : () => {};
					// 片段之间的连接符。中文没有词间空格，直接相接最自然
					// （"帮我打开D盘" + "再建个文件夹" → "帮我打开D盘再建个文件夹"），
					// 断句交给润色层。
					this.join = typeof options.join === "string" ? options.join : "";
					this.now = typeof options.now === "function" ? options.now : () => Date.now();
					this.setTimer =
						typeof options.setTimer === "function" ? options.setTimer : (callback, delay) => setTimeout(callback, delay);
					this.clearTimer = typeof options.clearTimer === "function" ? options.clearTimer : (handle) => clearTimeout(handle);

					/** 已累积的片段。 */
					this.fragments = [];
					/** 静音计时句柄。 */
					this.timer = null;
					/** 本轮首个片段的到达时刻（用于硬上限）。 */
					this.startedAt = null;
					/**
					 * 最近一次**重排**计时的时刻（每个新片段都会刷新）。
					 *
					 * 与 `startedAt` 的区别很重要：前者回答"还要等多久"（静音是从
					 * 最后一次说话算起，会不断推后），后者回答"这一轮总共多久了"
					 * （硬上限从第一次开口算起，不因中途停顿而重置）。
					 * 界面倒计时必须用前者，否则用户一说话倒计时反而跳小。
					 */
					this.armedAt = null;
					/** 当前这次计时的截止时刻（`null` = 没在计）。界面据此显示倒计时。 */
					this.dueAt = null;

					/** 诊断：提交次数 / 最近一次提交的原因与文本。 */
					this.commits = 0;
					this.lastReason = "";
					this.lastText = "";
				}

				/** 当前累积的文本（供界面显示"听到"）。 */
				get text() {
					return this.fragments.join(this.join).trim();
				}

				/** 是否有待提交的内容。 */
				get pending() {
					return this.fragments.length > 0;
				}

				/**
				 * 收一个识别片段。
				 *
				 * 去重只针对**紧邻的重复片段**：识别器 `onend` 后自动重启时可能把同一个
				 * 最终结果再送一遍，那会造成"同一句被提交两次"。但不能做全局去重 ——
				 * 用户完全可能有意重复同一句话。
				 *
				 * @param fragment - 片段文本。
				 * @returns 是否被接收（`false` 表示空或重复被丢弃）。
				 */
				push(fragment) {
					const text = typeof fragment === "string" ? fragment.trim() : "";
					if (text === "") return false;
					const last = this.fragments[this.fragments.length - 1];
					if (text === last) return false;

					if (this.startedAt === null) this.startedAt = this.now();
					this.fragments.push(text);
					this.arm();
					return true;
				}

				/**
				 * 本次静音计时的截止时刻（毫秒时间戳）。
				 *
				 * 界面拿它算"还有几秒自动提交"。比暴露 `armedAt` + `silenceMs`
				 * 更好：调用方不必知道延迟是 `min(silenceMs, 距硬上限剩余)` 这个细节。
				 */
				get deadline() {
					return this.dueAt;
				}

				/**
				 * 重排提交计时。
				 *
				 * 延迟取 `min(silenceMs, 距硬上限的剩余时间)` —— 用一个定时器同时表达
				 * 两个截止点，避免"静音计时"和"上限计时"同时存在、互相打断的复杂度。
				 */
				arm() {
					this.clearTimer(this.timer);
					this.timer = null;
					this.dueAt = null;
					if (this.fragments.length === 0) return;

					const now = this.now();
					this.armedAt = now;
					const elapsed = now - (this.startedAt ?? now);
					const remaining = this.maxTurnMs - elapsed;
					if (remaining <= 0) {
						this.commit("cap");
						return;
					}
					const delay = Math.min(this.silenceMs, remaining);
					this.dueAt = now + delay;
					this.timer = this.setTimer(() => {
						this.timer = null;
						this.dueAt = null;
						const spent = this.now() - (this.startedAt ?? this.now());
						// 到点时再判一次：若硬上限更早到，按 cap 归因（便于排障区分）。
						this.commit(spent >= this.maxTurnMs ? "cap" : "silence");
					}, delay);
				}

				/**
				 * 立即提交（用户手动结束这一轮）。
				 * @param reason - 归因，默认 `"manual"`。
				 */
				flush(reason = "manual") {
					this.commit(reason);
				}

				/**
				 * 提交并清空。
				 * @param reason - `"silence"` | `"cap"` | `"manual"`。
				 */
				commit(reason) {
					this.clearTimer(this.timer);
					this.timer = null;
					this.dueAt = null;
					const text = this.text;
					this.fragments = [];
					this.startedAt = null;
					this.armedAt = null;
					if (text === "") return;

					this.commits += 1;
					this.lastReason = reason;
					this.lastText = text;
					this.onCommit({ text, reason });
				}

				/** 丢弃当前累积（停止监听 / 误唤醒 / 用户手动休眠）。 */
				reset() {
					this.clearTimer(this.timer);
					this.timer = null;
					this.fragments = [];
					this.startedAt = null;
					this.armedAt = null;
					this.dueAt = null;
				}

				/** 释放（等同 `reset`，语义上表示不再使用）。 */
				dispose() {
					this.reset();
				}

				/** 诊断快照（供 `__xfvDebug`）。 */
				inspect() {
					return {
						pending: this.pending,
						fragments: this.fragments.length,
						text: this.text.slice(0, 200),
						commits: this.commits,
						lastReason: this.lastReason,
						silenceMs: this.silenceMs,
						maxTurnMs: this.maxTurnMs,
						waitedMs: this.startedAt === null ? 0 : this.now() - this.startedAt,
						/** 距静音提交还有多久（毫秒）；`null` = 没有在计。 */
						dueInMs: this.dueAt === null ? null : Math.max(0, this.dueAt - this.now()),
					};
				}
			}

			__exports({ TurnGate });
		});

		__def("core/wakeword.js", (__exports, __req) => {
			/**
			 * 唤醒词匹配。
			 *
			 * ## 为什么不是"字符串包含"这么简单
			 *
			 * 语音识别给出的是**音**到**字**的猜测。用户说「小凤」，识别结果可能是
			 * 「小风」「晓凤」「小枫」，甚至「小 凤」（中间多一个空格）。如果只比对
			 * 字面量，唤醒率大概只有一半 —— 用户会认为"这东西坏了"。
			 *
			 * 所以做三件事：
			 *   1. **归一化**：去空白、去标点、统一大小写，并保留「归一化下标 → 原文下标」
			 *      的映射，这样切出"唤醒词之后的指令"时还能拿到原文（数字、英文不受损）。
			 *   2. **同音别名**：别名表由配置提供（默认覆盖 `fèng` 的常见写法）。
			 *   3. **位置策略**：支持"小凤，帮我看看"这种唤醒+指令一口气说完，
			 *      由 `inline` 开关控制是否接受句中唤醒。
			 *
			 * ## 为什么不用 VAD/能量阈值做二次确认
			 *
			 * 那是另一个层次的事（判"有没有人在说话"），不该混进"说的是不是那个词"。
			 * 混在一起后，调阈值会同时改变唤醒率和误唤醒率，两个指标互相牵制，
			 * 永远调不好。
			 */

			/** 需要从归一化文本中剔除的字符：空白 + 中英文标点。 */
			const NOISE = /[\s，。！？、；：,.!?;:"'“”‘’（）()《》【】\[\]{}…—\-_~`|/\\]/;

			/**
			 * 归一化文本，并返回下标映射。
			 *
			 * @param text - 原始文本。
			 * @returns `{ normalized, map }`，`map[i]` 是 `normalized[i]` 在原文中的下标。
			 */
			function normalizeWithMap(text) {
				const source = typeof text === "string" ? text : "";
				let normalized = "";
				const map = [];
				for (let i = 0; i < source.length; i += 1) {
					const ch = source[i];
					if (NOISE.test(ch)) continue;
					normalized += ch.toLowerCase();
					map.push(i);
				}
				return { normalized, map };
			}

			/**
			 * 在文本中查找唤醒词。
			 *
			 * @param text - 识别到的文本（可能是中间结果）。
			 * @param options - `{ word, aliases, inline }`。
			 * @returns `{ hit, matched, rest, index }`：
			 *   - `hit` 是否命中；
			 *   - `matched` 命中的那个字面量（诊断用）；
			 *   - `rest` 唤醒词之后的原文（`inline` 为 false 且命中在句首时为整句去掉唤醒词）；
			 *   - `index` 命中位置（归一化下标）。
			 */
			function findWake(text, options = {}) {
				const word = typeof options.word === "string" && options.word !== "" ? options.word : "小凤";
				const aliases = Array.isArray(options.aliases) ? options.aliases : [];
				const inline = options.inline !== false;

				const { normalized, map } = normalizeWithMap(text);
				if (normalized === "") return { hit: false, matched: "", rest: "", index: -1 };

				// 长词优先：避免"小凤"先匹配掉"小凤凰"这类更长的候选。
				const candidates = [word, ...aliases]
					.filter((candidate) => typeof candidate === "string" && candidate !== "")
					.map((candidate) => ({ raw: candidate, key: normalizeWithMap(candidate).normalized }))
					.filter((candidate) => candidate.key !== "")
					.sort((a, b) => b.key.length - a.key.length);

				for (const candidate of candidates) {
					const index = normalized.indexOf(candidate.key);
					if (index < 0) continue;
					// 非 inline 模式只接受句首唤醒：句中的"小凤"多半是在谈论它，
					// 不是在下指令，否则聊天里提到这个名字就会一直被唤醒。
					if (!inline && index > 1) continue;

					const endNormalized = index + candidate.key.length;
					// 映射到原文：命中位置在原文中的结束下标。
					const lastMapped = map[endNormalized - 1];
					const rest = typeof lastMapped === "number" ? String(text).slice(lastMapped + 1) : "";
					return {
						hit: true,
						matched: candidate.raw,
						rest: rest.replace(/^[\s，。！？、；：,.!?;:]+/, "").trim(),
						index,
					};
				}

				return { hit: false, matched: "", rest: "", index: -1 };
			}

			__exports({ normalizeWithMap, findWake });
		});

		__def("ui/Experts.js", (__exports, __req) => {
			/**
			 * 专家浮动桌宠层（V1.6）。
			 *
			 * 参考 whale-girl 的形态：一张张卡通小人浮在页面最外层，跟着各自的
			 * 工作会话切换 idle / working 姿态。但**与 whale-girl 完全独立** ——
			 * 不用它的 bundle、不改它的 manifest、不争它的槽，只是借了"桌宠浮在
			 * 界面之上"这个交互形态。
			 *
			 * ## 数据来源
			 *
			 * 轮询宿主半的轻量端点 `/activities`（几十字节），拿到每位专家的
			 * `busy` / `task` / `elapsedMs`。刻意不读 /health（那是几 KB 的大对象）。
			 * 端点不可用时整层静默隐藏 —— 桌宠是装饰，绝不能因为轮询失败刷屏报错。
			 *
			 * ## 为什么单独一个 overlay 注册
			 *
			 * 挂在 `shell.overlay` 的另一个 id（`voice-assistant-experts`）上，
			 * 与语音球并列但不耦合：用户关掉桌宠不影响语音，拖桌宠也不会带球跑。
			 */
			const React = require("react");
			const { getController } = __req("core/instance.js");
			const { activities } = __req("core/runtime.js");
			const { h } = __req("ui/dom.js");
			const { positionStyle } = __req("ui/drag.js");
			const { useDrag } = __req("ui/useDrag.js");

			/** 工作态轮询间隔。 */
			const POLL_MS = 1500;

			/** 头像尺寸（用于边界收敛）。 */
			const AVATAR_SIZE = { w: 64, h: 78 };

			/**
			 * 取配置里的头像 URL（兼容 V1.5 及更早的配置：没有 avatars 字段时用空串，
			 * 组件据此走字母兜底）。
			 */
			function avatarUrl(config, workerId) {
				const avatars = config?.ui?.avatars;
				if (avatars === null || typeof avatars !== "object") return "";
				const byWorker = avatars.byWorker;
				if (byWorker !== null && typeof byWorker === "object" && typeof byWorker[workerId] === "string") {
					return byWorker[workerId];
				}
				return "";
			}

			/** 从 label 取一个字做字母头像（如「小因 · 基因分析」→「因」）。 */
			function initialOf(label) {
				const text = typeof label === "string" ? label : "?";
				const parts = text.split(/\s*[·・]\s*/);
				const name = parts[0] ?? text;
				return name.slice(0, 1) || "?";
			}

			/**
			 * 单个专家桌宠。
			 */
			function ExpertAvatar({ worker, url, collapsed }) {
				const [hover, setHover] = React.useState(false);
				const busy = worker.busy === true;
				const storageKey = `worker-${worker.id}`;
				const { position, bind, wasDrag: wasAvatarDrag } = useDrag({
					storageKey,
					getSize: () => AVATAR_SIZE,
				});

				const onPointerUp = (event) => {
					bind.onPointerUp(event);
					// 拖拽之后不切换 hover 卡（避免松手瞬间弹一张卡挡住界面）。
					if (wasAvatarDrag()) return;
					setHover((v) => !v);
				};

				const style = position !== null ? positionStyle(position) : undefined;
				const title = busy ? `${worker.label} 正在：${worker.task}` : `${worker.label} · 空闲`;

				return h(
					"div",
					{
						className: "xfv-expert",
						"data-busy": busy ? "true" : "false",
						"data-xfv": `expert-${worker.id}`,
						style,
						title,
						onPointerDown: bind.onPointerDown,
						onPointerMove: bind.onPointerMove,
						onPointerUp,
						onPointerCancel: bind.onPointerUp,
						onMouseEnter: () => setHover(true),
						onMouseLeave: () => setHover(false),
					},
					h(
						"div",
						{ className: "xfv-expert-figure" },
						url !== ""
							? h("img", { className: "xfv-expert-img", src: url, alt: worker.label, draggable: false })
							: h("span", { className: "xfv-expert-initial" }, initialOf(worker.label)),
						h("span", { className: "xfv-expert-status" }),
					),
					h("div", { className: "xfv-expert-name" }, initialOf(worker.label)),
					hover && !collapsed && busy
						? h(
								"div",
								{ className: "xfv-expert-task" },
								h("b", null, `${worker.label} · 工作中`),
								h("div", null, worker.task || "正在处理任务…"),
							)
						: null,
				);
			}

			/**
			 * 专家桌宠层组件。
			 */
			function ExpertTeam() {
				const controller = getController();
				const config = controller?.config ?? null;
				const [workers, setWorkers] = React.useState([]);
				const [available, setAvailable] = React.useState(false);
				const [collapsed, setCollapsed] = React.useState(false);

				React.useEffect(() => {
					let alive = true;
					let timer = null;

					const poll = async () => {
						if (controller === null) return;
						const data = await activities();
						if (!alive) return;
						if (data !== null) {
							setWorkers(Array.isArray(data.workers) ? data.workers : []);
							setAvailable(true);
						} else {
							setAvailable(false);
						}
					};

					poll();
					timer = setInterval(poll, POLL_MS);
					return () => {
						alive = false;
						if (timer !== null) clearInterval(timer);
					};
				}, [controller]);

				// 没有路由专家清单时不显示整层（纯个人助手模式没有 worker）。
				const list = workers.length > 0 ? workers : (config?.routing?.workers ?? []).map((w) => ({
					id: w.id,
					label: w.label,
					busy: false,
					task: "",
				}));
				if (list.length === 0) return null;

				return h(
					"div",
					{
						className: "xfv-experts",
						"data-xfv": "experts",
						"data-available": available ? "true" : "false",
					},
					h(
						"button",
						{
							type: "button",
							className: "xfv-experts-toggle",
							title: collapsed ? "展开专家桌宠" : "收起专家桌宠",
							onClick: () => setCollapsed((v) => !v),
						},
						collapsed ? "👥" : "−",
					),
					!collapsed
						? h(
								"div",
								{ className: "xfv-experts-row" },
								list.map((worker) =>
									h(ExpertAvatar, {
										key: worker.id,
										worker,
										url: avatarUrl(config, worker.id),
										collapsed,
									}),
								),
							)
						: null,
				);
			}

			__exports({ ExpertTeam });
		});

		__def("ui/Orb.js", (__exports, __req) => {
			/**
			 * 语音球浮层：注册到官方 `shell.overlay` 槽。
			 *
			 * ## 为什么是 `shell.overlay`
			 *
			 * 这个槽是官方明确留给"悬浮在整个应用之上"的席位（list 槽、可叠加、
			 * 默认 click-through）。相比之下 `root` 是单槽 —— 注册进去会把整个
			 * 应用框架顶掉。语音球必须与任何界面共存，只有 overlay 是正确选择。
			 *
			 * ## 交互约定
			 *
			 * - **单击**：启用 / 唤醒 / 打断播报（按当前状态决定，见 `controller.wake`）。
			 * - **长按 600ms**：打开设置面板。避免单击语义过载，同时不引入新按钮。
			 * - **右键**：同长按（桌面端习惯）。
			 *
			 * ## 为什么状态从 store 读而不是 React state
			 *
			 * 状态由非 React 的音频回调写（识别器 onend、播报 onend），
			 * 放进 React state 会立刻遇到闭包陈旧。这里用 `useSyncExternalStore`
			 * 直接订阅控制器快照，任何来源的变更都能立刻反映到界面。
			 */
			const React = require("react");

			const { STATES } = __req("core/constants.js");
			const { getController } = __req("core/instance.js");
			const { h, useStore } = __req("ui/dom.js");
			const { positionStyle } = __req("ui/drag.js");
			const { useDrag } = __req("ui/useDrag.js");

			/** 长按判定时长（毫秒）。 */
			const LONG_PRESS_MS = 600;

			/** 球形图标路径（声波）。 */
			const GLYPH = "M12 3v18M8 7v10M16 7v10M4 10v4M20 10v4";

			/** 状态标签：把互动类型翻成用户一眼能懂的名字（需求④）。 */
			const LAST_KIND_LABEL = {
				approval: "最近互动（权限审核）",
				question: "最近互动（模型提问）",
				report: "最近互动（任务汇报）",
			};

			/** 状态的简短操作提示。 */
			const HINTS = {
				[STATES.OFF]: "单击启用语音",
				[STATES.STANDBY]: "说「小凤」唤醒，或单击",
				// 播报结束也落在「正在听」，所以这句要能覆盖两种来路：刚唤醒、刚听完回答。
				[STATES.ACTIVE]: "正在听，接着说就行；说完单击提交",
				[STATES.THINKING]: "思考中，单击可打断",
				[STATES.SPEAKING]: "播报中，单击可打断",
				[STATES.SLEEPING]: "休眠中，单击唤醒",
			};

			/**
			 * 语音球组件。
			 */
			function VoiceOrb() {
				const controller = getController();
				if (controller === null) return null;

				const subscribe = React.useCallback((callback) => controller.subscribe(callback), [controller]);
				const getSnapshot = React.useCallback(() => controller.getSnapshot(), [controller]);
				const snapshot = useStore(subscribe, getSnapshot);

				const [panelOpen, setPanelOpen] = React.useState(false);
				const longPressTimer = React.useRef(null);
				const longPressed = React.useRef(false);

				const config = controller.config;
				const status = snapshot.status;

				/** 清除长按计时（useCallback 稳定化，供 useDrag 回调引用）。 */
				const clearLongPress = React.useCallback(() => {
					if (longPressTimer.current !== null) {
						clearTimeout(longPressTimer.current);
						longPressTimer.current = null;
					}
				}, []);

				// V1.6：拟人化音球形象 + 拖拽。拖拽一开始就取消长按判定，
				// 避免"拖一下顺手弹出设置面板"这种恼人的误触。
				const orbUrl = config?.ui?.avatars?.orb ?? "";
				const drag = useDrag({
					storageKey: "orb",
					getSize: () => ({ w: 88, h: 88 }),
					onDragStart: clearLongPress,
				});
				const dragStyle = drag.position !== null ? positionStyle(drag.position) : undefined;

				/** 指针按下：同时交给拖拽 hook 和长按计时。 */
				const onPointerDown = (event) => {
					drag.bind.onPointerDown(event);
					longPressed.current = false;
					clearLongPress();
					longPressTimer.current = setTimeout(() => {
						longPressed.current = true;
						setPanelOpen(true);
					}, LONG_PRESS_MS);
				};

				/** 指针抬起：先让拖拽 hook 收尾；判定为拖拽就不再当作单击。 */
				const onPointerUp = (event) => {
					drag.bind.onPointerUp(event);
					clearLongPress();
					if (drag.wasDrag()) {
						longPressed.current = false;
						return;
					}
					if (longPressed.current) {
						longPressed.current = false;
						return;
					}
					if (status === STATES.OFF) controller.start();
					else if (status === STATES.SLEEPING || status === STATES.STANDBY) controller.wake();
					else if (status === STATES.ACTIVE) {
						// 正在听：单击 = 「我说完了，现在提交」。
						//
						// 这是需求「静音满阈值才算说完」的逃生口 —— 干等是默认行为，
						// 但人总有想立刻要答案的时候。没攒下内容时退化为"重开这一轮"，
						// 给个提示而不是静默无反应。
						if (!controller.submitTurn()) controller.notice("还没听到内容，请直接说。", "info");
					} else controller.interrupt();
				};

				React.useEffect(() => clearLongPress, []);

				// 待提交时每秒刷一次，好让"还有 N 秒提交"真的在走。
				// 状态快照只在 patch 时变化，光靠订阅看不出时间的流逝。
				const [, tickSecond] = React.useState(0);
				const pending = snapshot.pending ?? "";
				React.useEffect(() => {
					if (status !== STATES.ACTIVE || pending === "") return undefined;
					const timer = setInterval(() => tickSecond((n) => n + 1), 1000);
					return () => clearInterval(timer);
				}, [status, pending]);

				const bubble = (() => {
					if (snapshot.notice !== "") return { text: snapshot.notice, kind: snapshot.noticeKind, tag: "" };
					if (snapshot.partial !== "" && status === STATES.SPEAKING) {
						return { text: snapshot.partial, kind: "info", tag: "播报" };
					}
					// 正在听且有内容：显示"已攒下的整轮 + 正在说的这半句"，让用户看到
					// 全部会被提交的内容。倒计时是必需的 —— 需求是"静音满阈值才提交"，
					// 不显示等待进度的话界面看起来就像卡住了。
					if (status === STATES.ACTIVE && (pending !== "" || snapshot.partial !== "")) {
						const live = snapshot.partial === "" ? "" : pending === "" ? snapshot.partial : `${pending}${snapshot.partial}`;
						return { text: `${live}${countdownSuffix(snapshot)}`, kind: "info", tag: pending === "" ? "听到" : "待提交" };
					}
					return null;
				})();

				return h(
					"div",
					{
						className: "xfv-root",
						"data-status": status,
						"data-position": config.ui.position,
						"data-xfv": "root",
					},
					panelOpen ? renderPanel(controller, snapshot, () => setPanelOpen(false)) : null,
					bubble !== null && config.ui.showTranscript
						? h(
								"div",
								{ className: "xfv-bubble", "data-kind": bubble.kind },
								bubble.tag !== "" ? h("span", { className: "xfv-tag" }, `${bubble.tag}｜`) : null,
								bubble.text,
							)
						: null,
					h(
						"button",
						{
							type: "button",
							className: "xfv-orb",
							style: dragStyle,
							title: `${HINTS[status] ?? ""}（拖动可移动，长按设置）`,
							"aria-label": `语音助手，当前${snapshot.label}。${HINTS[status] ?? ""}`,
							onPointerDown,
							onPointerMove: drag.bind.onPointerMove,
							onPointerUp,
							onPointerCancel: drag.bind.onPointerUp,
							onPointerLeave: clearLongPress,
							onContextMenu: (event) => {
								event.preventDefault();
								setPanelOpen(true);
							},
							onKeyDown: (event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									onPointerUp({ pointerId: -1 });
								}
							},
						},
						h("span", { className: "xfv-halo" }),
						orbUrl !== ""
							? h("img", {
									className: "xfv-orb-face",
									src: orbUrl,
									alt: "",
									draggable: false,
									"aria-hidden": "true",
								})
							: h(
									"svg",
									{
										className: "xfv-glyph",
										viewBox: "0 0 24 24",
										fill: "none",
										strokeWidth: 1.9,
										strokeLinecap: "round",
										"aria-hidden": "true",
									},
									h("path", { d: GLYPH, stroke: "currentColor" }),
								),
						h("span", { className: "xfv-dot" }),
					),
				);
			}

			/**
			 * 拼出"还有 N 秒自动提交"的后缀（给用户看等待进度）。
			 *
			 * 用截止时刻现算，而不是让控制器每秒 patch —— 每秒写状态快照会把整棵
			 * 订阅树刷 60 次/分钟，纯属浪费。
			 *
			 * @param snapshot - 当前快照。
			 * @returns 形如 `（还有 42 秒自动提交）` 的字符串；算不出来时返回空串。
			 */
			function countdownSuffix(snapshot) {
				const dueAt = snapshot.pendingDueAt;
				if (typeof dueAt !== "number") return "";
				const left = Math.ceil((dueAt - Date.now()) / 1000);
				if (left <= 0) return "（即将提交）";
				return `（还有 ${left} 秒自动提交）`;
			}

			/**
			 * 会话切换区（需求 ②）。
			 *
			 * ## 为什么必须是独立组件，而不是 renderPanel 里的一个函数（真机踩坑）
			 *
			 * 这段最早写成 `renderSessions(controller, snapshot)` 由 `renderPanel` 直接
			 * 调用。它里面有 `useState` / `useEffect` —— 而 `renderPanel` 只在
			 * `panelOpen === true` 时才被调用，于是：
			 *
			 * ```
			 * 面板开着 → 组件这次渲染多出 3 个 hook
			 * 面板关着 → 又少 3 个
			 * ```
			 *
			 * React 要求同一组件的 hook **调用顺序与数量在每次渲染间完全一致**，
			 * 这就直接抛 `Minified React error #310`（"Rendered more hooks than during
			 * the previous render"），整个 `shell.overlay` 槽条目崩掉、语音球消失。
			 *
			 * 根因是把带 hook 的逻辑写成了**条件调用的普通函数**：hook 是记在"当前
			 * 渲染中的组件"账上的，普通函数不会自开一个 hook 账本。提成真正的组件
			 * （`h(SessionsSection, …)`）之后，它的 hook 归自己的 fiber 管，
			 * 条件渲染它就完全合法 —— 这也是 React 里条件渲染的正确写法：**条件放在
			 * 组件外层，hooks 放在组件内部**。
			 *
			 * 注意：本文件里的 `renderPanel` / `renderSessions` 这类 `renderXxx` 命名
			 * 是"返回元素树的普通函数"，**绝不能在里面调 hook**。要用 hook 就提组件。
			 *
			 * ## 为什么列表要等用户展开才拉
			 *
			 * `ctx.sessions.refresh()` 是一次宿主往返。面板一打开就拉，会让"看一眼
			 * 状态"这种轻量操作也付网络代价；而本地投影（`listSessions()`）不发请求，
			 * 但可能落后于宿主的真实状态。折中是：**展开时拉一次**，之后用投影，
			 * 列表里给一个显式的"刷新"。
			 *
			 * @param props - `{ controller, snapshot }`。
			 */
			function SessionsSection(props) {
				const { controller, snapshot } = props;
				const [open, setOpen] = React.useState(false);
				const [rows, setRows] = React.useState([]);
				const [busy, setBusy] = React.useState(false);

				const reload = React.useCallback(
					async (withRefresh) => {
						setBusy(true);
						try {
							if (withRefresh) await controller.refreshSessions();
							setRows(controller.listSessions());
						} finally {
							setBusy(false);
						}
					},
					[controller],
				);

				// 展开时才拉一次宿主列表（见上面的取舍）。
				React.useEffect(() => {
					if (!open) return undefined;
					reload(true);
					return undefined;
				}, [open, reload]);

				const target = snapshot.sessionTarget ?? { mode: "", label: "尚未建立", id: null };
				const currentId = target.id;

				/** 切换后的统一收尾：重拉列表并折叠选择器。 */
				const act = async (operation) => {
					setBusy(true);
					try {
						await operation();
						setRows(controller.listSessions());
						setOpen(false);
					} finally {
						setBusy(false);
					}
				};

				return h(
					"div",
					{ className: "xfv-sessions" },
					h(
						"div",
						{ className: "xfv-sessions-head" },
						h("span", { className: "k" }, "语音去向"),
						h("span", { className: "v", "data-mode": target.mode }, target.label),
					),
					h(
						"div",
						{ className: "xfv-actions" },
						h(
							"button",
							{ type: "button", className: "xfv-btn", onClick: () => setOpen((value) => !value), disabled: busy },
							open ? "收起会话列表" : "切换会话…",
						),
						h(
							"button",
							{
								type: "button",
								className: "xfv-btn",
								disabled: busy,
								onClick: () => act(() => controller.newSession({})),
							},
							"新建会话",
						),
						target.mode !== "persistent"
							? h(
									"button",
									{
										type: "button",
										className: "xfv-btn",
										disabled: busy,
										onClick: () => act(() => controller.backToAssistant()),
									},
									"回到常驻助手",
								)
							: null,
					),
					open
						? h(
								"div",
								{ className: "xfv-session-list" },
								rows.length === 0
									? h("div", { className: "xfv-hint" }, busy ? "正在读取会话…" : "没有可切换的会话。")
									: rows.map((row) =>
											h(
												"button",
												{
													type: "button",
													className: "xfv-session-item",
													key: row.id,
													"data-current": row.id === currentId ? "true" : "false",
													disabled: busy,
													onClick: () => act(() => controller.switchSession(row.id)),
												},
												h("span", { className: "t" }, row.title),
												h(
													"span",
													{ className: "m" },
													[
														row.running ? "运行中" : "",
														row.id === currentId ? "当前" : "",
														row.cwd === "" ? "" : shortPath(row.cwd),
													]
														.filter((part) => part !== "")
														.join(" · "),
												),
											),
										),
								h(
									"div",
									{ className: "xfv-actions" },
									h(
										"button",
										{ type: "button", className: "xfv-btn", onClick: () => reload(true), disabled: busy },
										"刷新列表",
									),
								),
							)
						: null,
				);
			}

			/**
			 * 把工作目录压短（面板窄，完整路径会撑破布局）。
			 * @param cwd - 完整路径。
			 * @returns 缩略路径。
			 */
			function shortPath(cwd) {
				const normalized = String(cwd).replace(/[\\/]+$/, "");
				const parts = normalized.split(/[\\/]/).filter((part) => part !== "");
				if (parts.length <= 2) return normalized;
				return `…/${parts.slice(-2).join("/")}`;
			}

			/**
			 * 渲染设置/状态面板。
			 * @param controller - 语音控制器。
			 * @param snapshot - 当前快照。
			 * @param onClose - 关闭回调。
			 */
			function renderPanel(controller, snapshot, onClose) {
				const engineLabel = {
					webspeech: "浏览器识别",
					"webspeech-fallback": "浏览器识别（已降级）",
					http: "上游转写",
					"http-fallback": "上游转写（已降级）",
					ears: "dsh-ears 转写",
					none: "无可用引擎",
				}[snapshot.engine] ?? snapshot.engine;

				const polishLabel =
					snapshot.polishVia === "llm"
						? "模型润色"
						: snapshot.polishVia === "rules"
							? "规则清理"
							: snapshot.polishVia === "raw"
								? "原样发送"
								: controller.config.polish.enabled
									? "就绪"
									: "已关闭";

				return h(
					"div",
					{ className: "xfv-panel", role: "dialog", "aria-label": "语音助手设置" },
					h(
						"div",
						{ className: "xfv-panel-head" },
						h("span", { className: "xfv-title" }, "小凤 · 语音助手"),
						h("button", { type: "button", className: "xfv-close", onClick: onClose, "aria-label": "关闭" }, "×"),
					),
					row("状态", snapshot.label),
					row("唤醒词", `${controller.config.wake.word}${controller.config.wake.aliases.length > 0 ? `（含 ${controller.config.wake.aliases.length} 个同音）` : ""}`),
					row("识别", engineLabel),
					row("润色", polishLabel),
					// 两层架构：路由开关 + 最近一次派给了哪位 worker 专家。
					row(
						"专家路由",
						controller.config.routing?.enabled === true
							? snapshot.routedWorker === ""
								? `开启（${(controller.config.routing.workers ?? []).length} 位专家；最近一条未分派/派给小凤）`
								: `开启 → ${snapshot.routedWorker}`
							: "已关闭",
					),
					row("休眠", `${Math.round(controller.config.sleep.idleTimeoutMs / 1000)} 秒无语音（播报完也按这个计时）`),
					// V1.3 委托汇报：派单期间显示"处理中"，完成后这里留最近一条要点。
					// 只看"专家路由"会以为派完单就没下文了 —— 用户需要一条可见的回执。
					row(
						"后台任务",
						(snapshot.pendingDelegations ?? 0) > 0
							? `${snapshot.pendingDelegations} 项处理中（完成后我会汇报要点）`
							: "无在途任务",
					),
					// 需求④：三类互动（审批 / 提问 / 汇报）走**同一条按时间的流**，
					// 这条留的是最近一条的原话。标签随类型变 —— 都写"最近汇报"会让
					// 用户以为念的是任务结果，实际可能是"某工具需要你去界面允许"。
					row(LAST_KIND_LABEL[String(snapshot.lastInteractionKind ?? "")] ?? "最近互动", snapshot.lastReport === "" ? "暂无" : snapshot.lastReport),
					// 互动流的总闸 + 两类旁听的开关（与宿主侧配置同口径，只读展示）。
					// 为什么把"不做语音代答"写死在这里：用户会对着屏幕喊"允许"，
					// 提前说清比事后解释便宜。
					row(
						"互动流",
						controller.config.interactions?.enabled === false
							? "已关闭（不播报审批 / 提问 / 汇报）"
							: `已开启（审批 ${controller.config.interactions?.announceApprovals === false ? "关" : "开"}，提问 ${controller.config.interactions?.announceQuestions === false ? "关" : "开"}；只播报，不代答）`,
					),
					row("完成判据", `静音 ${Math.round((controller.config.turn?.silenceMs ?? 10000) / 1000)} 秒提交（单击语音球可立即提交）`),
					row("回声抑制", controller.config.turn?.echoGuard === false ? "已关闭" : "已开启"),
					// 常驻会话在侧边栏的标注名。为什么不是"隐藏"：DSH 没有安全的隐藏
					// 机制（归档会让助手哑掉、subagent 标记会让会话连不上），所以需求 ①
					// 的落点是"可见但一眼可辨"。把标注名显示在这里，用户对得上侧边栏里
					// 那一条到底是哪来的。
					row(
						"常驻会话标注",
						controller.config.session?.label === ""
							? "未设置（用自动标题）"
							: `${controller.config.session?.label ?? "小凤 · 常驻助手"}（侧边栏可见）`,
					),
					// 全局记忆：注册在根作用域的 prompt 段，对 DSH 全部会话生效。
					row(
						"全局记忆",
						controller.config.memory?.active === true
							? "已生效（对全部会话）"
							: controller.config.memory?.global === true
								? "已开启但未生效（正文为空或服务不可用）"
								: "未开启",
					),
					// 提问应答：**只做「模型提问」，不碰「工具审批」**。
					//   * 关闭 → 连旁听都不做（不念问题）
					//   * 已接入 → 显示当前是否正等作答
					//
					// 为什么把"工具审批不做"写进界面：用户会以为"语音助手能审批"，
					// 结果发现喊"允许"没用。提前说清楚比事后解释便宜。
					//
					// **范围说明必须任何时候都在**：早先只在"空闲"分支带这句，于是
					// 一进入待答态就消失了 —— 而那正是用户最可能对着屏幕喊"允许"的
					// 时刻（真机冒烟就是这么抓出来的）。所以拆成"状态 + 恒定范围"。
					row(
						"语音应答",
						`${questionSummary(controller)}（只答模型提问，工具审批请在界面操作）`,
					),
					// 会话切换区。**以组件形式渲染**（`h(SessionsSection, …)`）而不是
					// 调用 `renderSessions(...)` —— 后者会在 renderPanel 的调用栈里
					// 执行它的 useState，React 会直接抛 error #310 把浮层槽打崩。
					// 详见 SessionsSection 的注释。
					h(SessionsSection, { controller, snapshot }),
					row("语音会话", snapshot.sessionId === null ? "尚未创建" : String(snapshot.sessionId).slice(0, 8)),
					snapshot.error !== "" ? row("最近错误", snapshot.error) : null,
					h(
						"div",
						{ className: "xfv-actions" },
						h(
							"button",
							{
								type: "button",
								className: "xfv-btn",
								"data-primary": "true",
								onClick: () => (snapshot.status === STATES.OFF ? controller.start() : controller.wake()),
							},
							snapshot.status === STATES.OFF ? "启用语音" : "唤醒",
						),
						h(
							"button",
							{
								type: "button",
								className: "xfv-btn",
								onClick: () => controller.say("你好，我是小凤。语音链路正常。"),
							},
							"试听",
						),
						h(
							"button",
							{
								type: "button",
								className: "xfv-btn",
								onClick: () => controller.sleep(),
								disabled: snapshot.status === STATES.SLEEPING || snapshot.status === STATES.OFF,
							},
							"休眠",
						),
						h(
							"button",
							{
								type: "button",
								className: "xfv-btn",
								onClick: () => controller.stop(),
								disabled: snapshot.status === STATES.OFF,
							},
							"停用",
						),
					),
					snapshot.history.length > 0
						? h(
								"div",
								{ className: "xfv-history" },
								snapshot.history.map((item, index) =>
									h(
										"div",
										{ className: "xfv-history-item", key: `${item.time}-${index}` },
										h("b", null, item.role === "user" ? "你说：" : "小凤："),
										item.text.length > 60 ? `${item.text.slice(0, 60)}…` : item.text,
									),
								),
							)
						: null,
					h(
						"div",
						{ className: "xfv-hint" },
						"快捷键 ",
						h("span", { className: "xfv-kbd" }, "Alt"),
						" + ",
						h("span", { className: "xfv-kbd" }, "Shift"),
						" + ",
						h("span", { className: "xfv-kbd" }, "V"),
						" 唤醒 / 休眠。长按语音球打开此面板。",
					),
				);
			}

			/**
			 * 一行键值。
			 * @param key - 左侧说明。
			 * @param value - 右侧值。
			 */
			function row(key, value) {
				return h("div", { className: "xfv-row" }, h("span", { className: "k" }, key), h("span", { className: "v" }, value));
			}

			/**
			 * 面板里"语音应答"那一行的状态短语（不含范围说明）。
			 *
			 * 三种状态必须分得清，而且措辞要**如实**：
			 *   - 有 `continued` 问题 → 能语音答，说"可以直接说答案"；
			 *   - 有 `open` 问题 → 界面还能答，语音插不进去（DSH 的 `answer()`
			 *     只收 `continued`），说"我念给您听"；
			 *   - 没问题 → 报"已接入"或"未接入"。
			 *
			 * ⚠️ 措辞不要说"未接入（该会话无提问投影）"这种**把实现细节当结论**的话：
			 * 投影为空在本机默认配置（legacy）下是**正常**的，而播报走的是事件流，
			 * 与投影无关。说成"没接入"会让用户以为功能坏了。
			 *
			 * @param controller - 语音控制器。
			 * @returns 状态短语。
			 */
			function questionSummary(controller) {
				const current = controller.getSnapshot().question;
				if (current !== null && current !== undefined) {
					return current.state === "continued" ? "正等您作答，可以直接说答案" : "问题在界面上，我念给您听";
				}
				// 桥是否绑过会话（播报不依赖它，但能反映"会话就绪了没有"）。
				const bound = controller.questions?.sessionId !== null && controller.questions?.sessionId !== undefined;
				return bound ? "已接入，暂无待答问题" : "等会话就绪后开始旁听";
			}

			__exports({ VoiceOrb });
		});

		__def("ui/dom.js", (__exports, __req) => {
			/**
			 * 极简元素构造助手。
			 *
			 * 本插件不引入 JSX 构建链（构建脚本保持零依赖纯字符串拼装），
			 * 统一用 `h(tag, props, ...children)`。组件是普通函数组件，
			 * 与 DSH 官方的槽插件契约一致。
			 */
			const React = require("react");

			/**
			 * 创建 React 元素。
			 * @param tag - 标签名或组件。
			 * @param props - 属性；`null` 表示无属性。
			 * @param children - 子节点（自动扁平化，剔除假值）。
			 */
			function h(tag, props, ...children) {
				const flat = [];
				const push = (value) => {
					if (value === null || value === undefined || typeof value === "boolean") return;
					if (Array.isArray(value)) {
						for (const item of value) push(item);
						return;
					}
					flat.push(value);
				};
				for (const child of children) push(child);

				const nextProps = props === null || props === undefined ? {} : { ...props };
				if (flat.length === 1) nextProps.children = flat[0];
				else if (flat.length > 1) nextProps.children = flat;
				return React.createElement(tag, nextProps);
			}

			/**
			 * 拼接类名。
			 * @param parts - 片段，假值被忽略。
			 */
			function cx(...parts) {
				return parts.filter(Boolean).join(" ");
			}

			/**
			 * 订阅外部 store 的 hook。
			 *
			 * `useSyncExternalStore` 在 React 18 才有；这里做一次能力降级，
			 * 避免在旧版 React 上直接抛 "not a function"。降级版的退化是
			 * "可能撕裂渲染"，对浮层这种低频更新可以接受。
			 *
			 * @param subscribe - `(cb) => unsubscribe`。
			 * @param getSnapshot - 取当前快照。
			 */
			function useStore(subscribe, getSnapshot) {
				if (typeof React.useSyncExternalStore === "function") {
					return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
				}
				const [value, setValue] = React.useState(getSnapshot());
				React.useEffect(() => {
					const unsubscribe = subscribe(() => setValue(getSnapshot()));
					setValue(getSnapshot());
					return unsubscribe;
				}, [subscribe, getSnapshot]);
				return value;
			}

			__exports({ h, cx, useStore });
		});

		__def("ui/drag.js", (__exports, __req) => {
			/**
			 * 浮层拖拽：几何收敛 + 位置持久化（V1.6，纯函数 + 薄 DOM 壳）。
			 *
			 * ## 为什么要拆出纯函数
			 *
			 * 拖拽里最容易错的是边界收敛的符号（右边界减宽度、下边界减高度），
			 * 在浏览器里靠肉眼查极难定位。几何计算抽成 `clampPosition`，用数值单测
			 * 钉住四个角与窗口缩放后回收的场景。DOM 部分只负责把指针事件翻译成坐标。
			 *
			 * ## 为什么位置要持久化
			 *
			 * 用户把音球/专家拖到顺手的地方后刷新页面，位置必须还在 —— 否则每次
			 * 开机都要重拖一遍。存 localStorage，key 按角色区分；存储不可用时
			 * （隐私模式、配额满）静默退化成"本次会话有效"，不抛错、不影响拖拽。
			 */

			/** localStorage 的 key 前缀（与播报账本 `xfv:v1:` 同族，便于统一管理）。 */
			const STORAGE_PREFIX = "xfv:v1:pos:";

			/**
			 * 把期望位置收敛进视口（纯函数，可单测）。
			 *
			 * @param desired - 期望的 `{x, y}`（相对视口左上，元素左上角坐标）。
			 * @param size - 元素尺寸 `{w, h}`。
			 * @param viewport - 视口尺寸 `{w, h}`。
			 * @param margin - 四周留白，默认 8px。
			 * @returns 收敛后的 `{x, y}`（整数）。
			 */
			function clampPosition(desired, size, viewport, margin = 8) {
				const w = Math.max(0, Number(size?.w) || 0);
				const h = Math.max(0, Number(size?.h) || 0);
				const vw = Math.max(1, Number(viewport?.w) || 1);
				const vh = Math.max(1, Number(viewport?.h) || 1);
				const m = Math.max(0, Number(margin) || 0);

				// 元素比视口还大时，允许负坐标（否则左上角会被死钉在 margin），
				// 但至少保证露出 margin 那么宽的一角，不至于整个拖没。
				const maxX = Math.max(m - w, vw - w - m);
				const maxY = Math.max(m - h, vh - h - m);
				const x = Math.min(Math.max(Number(desired?.x) || 0, m), maxX);
				const y = Math.min(Math.max(Number(desired?.y) || 0, m), maxY);
				return { x: Math.round(x), y: Math.round(y) };
			}

			/**
			 * 从指针事件里算新的左上角坐标（纯函数，可单测）。
			 *
			 * @param origin - 按下时的元素左上角 `{x, y}`。
			 * @param start - 按下时的指针位置 `{x, y}`。
			 * @param current - 当前指针位置 `{x, y}`。
			 * @returns 期望的新左上角坐标。
			 */
			function positionFromPointer(origin, start, current) {
				return {
					x: (Number(origin?.x) || 0) + (Number(current?.x) || 0) - (Number(start?.x) || 0),
					y: (Number(origin?.y) || 0) + (Number(current?.y) || 0) - (Number(start?.y) || 0),
				};
			}

			/**
			 * 是否构成"拖拽"（而不是点击）：移动超过阈值才算。
			 *
			 * @param start - 按下位置。
			 * @param current - 当前位置。
			 * @param threshold - 阈值像素，默认 5。
			 * @returns 超过阈值返回 true。
			 */
			function isDragGesture(start, current, threshold = 5) {
				const dx = Math.abs((Number(current?.x) || 0) - (Number(start?.x) || 0));
				const dy = Math.abs((Number(current?.y) || 0) - (Number(start?.y) || 0));
				return dx > threshold || dy > threshold;
			}

			/** 取存储对象；不可用时返回 null（调用方据此退化为内存模式）。 */
			function storageOrNull() {
				try {
					if (typeof localStorage === "undefined" || localStorage === null) return null;
					return localStorage;
				} catch {
					return null;
				}
			}

			/**
			 * 读持久位置。
			 * @param key - 角色 key（如 `orb` / `worker-bioinfo`）。
			 * @returns `{x,y}`；无记录或格式坏时返回 null。
			 */
			function readPosition(key) {
				const storage = storageOrNull();
				if (storage === null || typeof key !== "string" || key === "") return null;
				try {
					const raw = storage.getItem(`${STORAGE_PREFIX}${key}`);
					if (raw === null) return null;
					const parsed = JSON.parse(raw);
					const x = Number(parsed?.x);
					const y = Number(parsed?.y);
					if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
					return { x, y };
				} catch {
					return null;
				}
			}

			/**
			 * 写持久位置（失败静默，绝不因存储问题打断拖拽）。
			 * @param key - 角色 key。
			 * @param pos - `{x,y}`。
			 */
			function writePosition(key, pos) {
				const storage = storageOrNull();
				if (storage === null || typeof key !== "string" || key === "") return false;
				try {
					storage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify({ x: pos.x, y: pos.y }));
					return true;
				} catch {
					return false;
				}
			}

			/**
			 * 把位置写成可直接塞进 `style` 的对象（React 的 style prop 形状）。
			 * @param pos - `{x,y}`。
			 */
			function positionStyle(pos) {
				return { left: `${pos.x}px`, top: `${pos.y}px`, right: "auto", bottom: "auto", transform: "none" };
			}

			__exports({ clampPosition, positionFromPointer, isDragGesture, readPosition, writePosition, positionStyle });
		});

		__def("ui/fallback-mount.js", (__exports, __req) => {
			/**
			 * 兜底挂载：槽注册失败时，直接把语音球挂到 `<body>` 上。
			 *
			 * ## 为什么需要这条退路
			 *
			 * 官方浮层槽 `shell.overlay` 由布局插件声明。如果某个 profile 用了自定义
			 * 整壳（接管 root 但没声明 `shell.overlay`），`slots.inject` 会一直等不到
			 * 声明 —— **不报错，也不渲染**，表现就是"装了插件但界面上什么都没有"。
			 * 这类静默失败对用户最不友好：没有任何线索指向"槽没声明"。
			 *
			 * 所以注册失败/超时后主动退一步：把组件挂到一个 fixed 定位的宿主节点上。
			 * 视觉效果与走槽几乎一致（我们的样式本来就是 `position: fixed`），
			 * 只是脱离了官方的层级管理。
			 *
			 * ## 为什么用超时而不是只靠 try/catch
			 *
			 * `slots.inject` 的行为是"等声明出现再执行回调"，不抛错。因此要靠一个
			 * 超时来判断"等了这么久还没声明，估计不会声明了"。
			 */
			const React = require("react");

			/** 兜底宿主节点的 id。 */
			const HOST_ID = "xfv-fallback-host";

			/** 判定"槽大概不会出现了"的等待时长。 */
			const FALLBACK_DELAY_MS = 2500;

			/**
			 * 把组件挂到 body 上。
			 *
			 * @param component - React 组件。
			 * @returns 卸载函数；环境不具备 DOM 时返回 `null`。
			 */
			function mountToBody(component, hostId = HOST_ID) {
				if (typeof document === "undefined" || document.body === null) return null;
				if (document.getElementById(hostId) !== null) return null;

				const host = document.createElement("div");
				host.id = hostId;
				// 宿主本身不参与布局：子组件自己 fixed 定位。
				host.style.position = "fixed";
				host.style.inset = "0";
				host.style.pointerEvents = "none";
				host.style.zIndex = "2147483000";
				document.body.appendChild(host);

				// react-dom 的两种入口：18+ 用 react-dom/client，17 及以下用 render。
				let root = null;
				try {
					// eslint-disable-next-line global-require
					const client = require("react-dom/client");
					if (typeof client?.createRoot === "function") {
						root = client.createRoot(host);
						root.render(React.createElement(component, null));
						return () => {
							root.unmount();
							host.remove();
						};
					}
				} catch {
					// 没有 react-dom/client，继续试老入口。
				}

				try {
					// eslint-disable-next-line global-require
					const legacy = require("react-dom");
					const render = legacy?.render ?? legacy?.default?.render;
					if (typeof render === "function") {
						render(React.createElement(component, null), host);
						return () => {
							const unmount = legacy?.unmountComponentAtNode ?? legacy?.default?.unmountComponentAtNode;
							if (typeof unmount === "function") unmount(host);
							host.remove();
						};
					}
				} catch {
					// 两条路都不通。
				}

				host.remove();
				return null;
			}

			/**
			 * 等待一段时间后，如果槽还没注册成功就兜底挂载。
			 *
			 * @param component - React 组件。
			 * @param onFallback - 兜底发生时的回调（用于日志/提示）。
			 * @returns `{ cancel, settle }`：`settle()` 表示槽已成功注册，取消兜底。
			 */
			function scheduleFallback(component, onFallback) {
				return scheduleFallbackPair([component], onFallback);
			}

			/**
			 * V1.6：一次兜底挂载多个组件（语音球 + 专家桌宠）。
			 *
			 * 与单组件版共用同一套超时与 settle 语义；差别只是每个组件各拿一个
			 * 独立宿主节点（都 fixed 定位、互不遮挡），卸载时一并收掉。之所以不让
			 * 它们共用一个 body 宿主：`mountToBody` 用固定 id 且只允许一个实例，
			 * 两个组件塞同一个 React 根会互相覆盖状态。
			 *
			 * @param components - React 组件数组。
			 * @param onFallback - 兜底发生时的回调。
			 * @returns `{ cancel, settle }`。
			 */
			function scheduleFallbackPair(components, onFallback) {
				const list = Array.isArray(components) ? components : [];
				const timer = setTimeout(() => {
					const disposers = list
					.map((component, index) => mountToBody(component, index === 0 ? HOST_ID : `${HOST_ID}-${index}`))
					.filter((fn) => typeof fn === "function");
					if (disposers.length > 0) onFallback?.();
					activeDisposers = disposers;
				}, FALLBACK_DELAY_MS);

				let activeDisposers = [];
				return {
					settle() {
						clearTimeout(timer);
					},
					cancel() {
						clearTimeout(timer);
						for (const dispose of activeDisposers) {
							try {
								dispose();
							} catch {
								// 已卸载。
							}
						}
						activeDisposers = [];
					},
				};
			}

			__exports({ mountToBody, scheduleFallback, scheduleFallbackPair });
		});

		__def("ui/styles.js", (__exports, __req) => {
			/**
			 * 浮层样式（注入 `<style>`，不依赖任何外部 CSS）。
			 *
			 * ## 为什么要自己写一套而不是套 DSH 的令牌
			 *
			 * 语音球挂在 `shell.overlay` 上，需要**悬浮在整个应用之上**：层级、阴影、
			 * 毛玻璃、动画都得自己控。官方 `--dsw-alias-*` 令牌是给文档型界面用的，
			 * 拿来做浮层会出现"浅色主题下球体透明到看不见"这类问题。
			 *
			 * 只借用一个东西：`--xfv-accent` 由配置传入，其余全部自带，
			 * 并跟随 `prefers-color-scheme` 切换深浅 —— 浮层不跟随页面主题，
			 * 是因为浮层是"画外"的，跟着系统走更稳定。
			 */

			/** 样式表 id（重复注入时先删旧的，避免 HMR 叠出多份）。 */
			const STYLE_ID = "xfv-style";

			/**
			 * 生成样式文本。
			 * @param accent - 强调色（六位十六进制）。
			 * @returns CSS 文本。
			 */
			function css(accent) {
				return `
			.xfv-root {
				--xfv-accent: ${accent};
				--xfv-ink: #171a21;
				--xfv-sub: #5b6472;
				--xfv-surface: rgba(255, 255, 255, 0.94);
				--xfv-border: rgba(16, 24, 40, 0.10);
				--xfv-shadow: 0 10px 30px rgba(16, 24, 40, 0.16), 0 2px 6px rgba(16, 24, 40, 0.08);
				position: fixed;
				/* 贴底放，但横向让出右下角：那一带被「🧠 Memory」胶囊（约 135px 宽）和
				   输入卡的发送按钮占着 —— 22px 时球被胶囊盖住，84px 时球压住发送键。
				   右移 170px 后正好落在卡片下方的空白条里，三者互不遮挡。 */
				bottom: 18px;
				right: 170px;
				z-index: 2147483000;
				display: flex;
				flex-direction: column;
				align-items: flex-end;
				gap: 10px;
				font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif;
				color: var(--xfv-ink);
				pointer-events: none;
			}
			.xfv-root[data-position="bottom-left"] { left: 22px; right: auto; align-items: flex-start; }
			.xfv-root[data-position="bottom-center"] { left: 50%; right: auto; transform: translateX(-50%); align-items: center; }

			@media (prefers-color-scheme: dark) {
				.xfv-root {
					--xfv-ink: #eef1f6;
					--xfv-sub: #a4adbb;
					--xfv-surface: rgba(28, 32, 40, 0.94);
					--xfv-border: rgba(255, 255, 255, 0.12);
					--xfv-shadow: 0 12px 34px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.4);
				}
			}

			/* ── 语音球 ─────────────────────────────────────────────────────── */
			.xfv-orb {
				pointer-events: auto;
				position: relative;
				width: 58px;
				height: 58px;
				border-radius: 50%;
				border: 1px solid var(--xfv-border);
				background: var(--xfv-surface);
				box-shadow: var(--xfv-shadow);
				display: grid;
				place-items: center;
				cursor: pointer;
				transition: transform 160ms ease, box-shadow 160ms ease;
				-webkit-user-select: none;
				user-select: none;
				padding: 0;
				color: inherit;
			}
			.xfv-orb:hover { transform: translateY(-1px) scale(1.03); }
			.xfv-orb:active { transform: scale(0.97); }
			.xfv-orb:focus-visible { outline: 2px solid var(--xfv-accent); outline-offset: 3px; }

			.xfv-glyph { width: 24px; height: 24px; display: block; }
			.xfv-glyph path, .xkv-glyph line { stroke: var(--xfv-accent); }

			/* V1.6：拟人化音球形象。铺满球体，随状态轻微起伏。 */
			.xfv-orb-face {
				width: 100%;
				height: 100%;
				object-fit: contain;
				display: block;
				pointer-events: none;
				user-select: none;
				-webkit-user-drag: none;
				filter: drop-shadow(0 2px 5px rgba(47, 107, 255, 0.28));
				transition: transform 220ms ease;
			}
			.xfv-orb:hover .xfv-orb-face { transform: translateY(-1px) scale(1.04); }
			.xfv-root[data-status="speaking"] .xfv-orb-face { animation: xfv-bob 1.1s ease-in-out infinite; }
			.xfv-root[data-status="thinking"] .xfv-orb-face { animation: xfv-bob 1.8s ease-in-out infinite; }
			@keyframes xfv-bob {
				0%, 100% { transform: translateY(0) scale(1); }
				50%      { transform: translateY(-3px) scale(1.03); }
			}

			/* 状态指示灯：球体右下角的小点 */
			.xfv-dot {
				position: absolute;
				right: 3px;
				bottom: 3px;
				width: 12px;
				height: 12px;
				border-radius: 50%;
				border: 2px solid var(--xfv-surface);
				background: #98a2b3;
				transition: background 200ms ease;
			}
			.xfv-root[data-status="standby"] .xfv-dot { background: #12b76a; }
			.xfv-root[data-status="active"] .xfv-dot { background: var(--xfv-accent); }
			.xfv-root[data-status="thinking"] .xfv-dot { background: #f79009; }
			.xfv-root[data-status="speaking"] .xfv-dot { background: #7a5af8; }
			.xfv-root[data-status="sleeping"] .xfv-dot { background: #667085; }

			/* 呼吸环：仅在"正在听"和"播报中"出现，给一个不刺眼的活动感 */
			.xfv-halo {
				position: absolute;
				inset: -6px;
				border-radius: 50%;
				border: 2px solid var(--xfv-accent);
				opacity: 0;
				pointer-events: none;
			}
			.xfv-root[data-status="active"] .xfv-halo { animation: xfv-breathe 1.8s ease-out infinite; }
			.xfv-root[data-status="speaking"] .xfv-halo { animation: xfv-breathe 1.4s ease-out infinite; border-color: #7a5af8; }

			@keyframes xfv-breathe {
				0%   { opacity: 0.55; transform: scale(0.92); }
				70%  { opacity: 0;    transform: scale(1.18); }
				100% { opacity: 0;    transform: scale(1.18); }
			}

			/* ── 字幕气泡 ────────────────────────────────────────────────────── */
			.xfv-bubble {
				pointer-events: none;
				max-width: 340px;
				padding: 8px 12px;
				border-radius: 12px;
				background: var(--xfv-surface);
				border: 1px solid var(--xfv-border);
				box-shadow: 0 6px 18px rgba(16, 24, 40, 0.12);
				font-size: 13px;
				line-height: 1.5;
				color: var(--xfv-ink);
				white-space: pre-wrap;
				word-break: break-word;
				animation: xfv-fade 140ms ease-out;
			}
			.xfv-bubble[data-kind="warn"] { border-color: #f79009; }
			.xfv-bubble[data-kind="error"] { border-color: #f04438; }
			.xfv-bubble .xfv-tag {
				display: inline-block;
				font-size: 11px;
				color: var(--xfv-sub);
				margin-right: 6px;
			}

			@keyframes xfv-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

			/* ── 设置面板 ────────────────────────────────────────────────────── */
			.xfv-panel {
				pointer-events: auto;
				width: 288px;
				border-radius: 14px;
				background: var(--xfv-surface);
				border: 1px solid var(--xfv-border);
				box-shadow: var(--xfv-shadow);
				padding: 14px;
				font-size: 13px;
				line-height: 1.55;
			}
			.xfv-panel-head {
				display: flex;
				align-items: center;
				justify-content: space-between;
				margin-bottom: 10px;
			}
			.xfv-title { font-weight: 600; font-size: 14px; }
			.xfv-close {
				border: 0;
				background: transparent;
				color: var(--xfv-sub);
				cursor: pointer;
				font-size: 16px;
				line-height: 1;
				padding: 4px;
				border-radius: 6px;
			}
			.xfv-close:hover { background: rgba(127, 127, 127, 0.12); }

			.xfv-row { display: flex; justify-content: space-between; gap: 10px; padding: 2px 0; }
			.xfv-row .k { color: var(--xfv-sub); }
			.xfv-row .v { text-align: right; word-break: break-all; }

			.xfv-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
			.xfv-btn {
				pointer-events: auto;
				border: 1px solid var(--xfv-border);
				background: transparent;
				color: var(--xfv-ink);
				border-radius: 8px;
				padding: 5px 10px;
				font-size: 12px;
				cursor: pointer;
				font-family: inherit;
			}
			.xfv-btn:hover { border-color: var(--xfv-accent); color: var(--xfv-accent); }
			.xfv-btn[data-primary="true"] {
				background: var(--xfv-accent);
				border-color: var(--xfv-accent);
				color: #fff;
			}
			.xfv-btn[data-primary="true"]:hover { filter: brightness(1.06); color: #fff; }

			.xfv-hint { margin-top: 10px; color: var(--xfv-sub); font-size: 11.5px; line-height: 1.5; }
			.xfv-kbd {
				font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
				font-size: 11px;
				border: 1px solid var(--xfv-border);
				border-radius: 4px;
				padding: 0 4px;
				background: rgba(127, 127, 127, 0.10);
			}

			.xfv-history { margin-top: 10px; border-top: 1px dashed var(--xfv-border); padding-top: 8px; }
			.xfv-history-item { color: var(--xfv-sub); font-size: 12px; margin-bottom: 4px; }
			.xfv-history-item b { color: var(--xfv-ink); font-weight: 600; }

			/* ── 会话切换（跨会话）─────────────────────────────────────────────── */
			.xfv-sessions {
				margin-top: 10px;
				border-top: 1px dashed var(--xfv-border);
				padding-top: 8px;
			}
			.xfv-sessions-head { display: flex; justify-content: space-between; gap: 10px; padding: 2px 0; }
			.xfv-sessions-head .k { color: var(--xfv-sub); }
			.xfv-sessions-head .v { text-align: right; word-break: break-all; font-weight: 600; }
			/* 非常驻模式下把"当前去向"标成强调色：这是最容易搞错的目标信息 */
			.xfv-sessions-head .v:not([data-mode="persistent"]) { color: var(--xfv-accent); }

			.xfv-session-list {
				max-height: 180px;
				overflow-y: auto;
				margin-top: 6px;
				display: flex;
				flex-direction: column;
				gap: 4px;
			}
			.xfv-session-item {
				pointer-events: auto;
				display: flex;
				flex-direction: column;
				align-items: flex-start;
				gap: 2px;
				text-align: left;
				width: 100%;
				border: 1px solid var(--xfv-border);
				background: transparent;
				color: var(--xfv-ink);
				border-radius: 8px;
				padding: 5px 8px;
				font-size: 12px;
				font-family: inherit;
				cursor: pointer;
			}
			.xfv-session-item:hover { border-color: var(--xfv-accent); }
			.xfv-session-item[data-current="true"] { border-color: var(--xfv-accent); background: rgba(47, 107, 255, 0.08); }
			.xfv-session-item .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
			.xfv-session-item .m { color: var(--xfv-sub); font-size: 11px; }

			/* ── 专家桌宠层（V1.6）──────────────────────────────────────────── */
			.xfv-experts {
				position: fixed;
				left: 18px;
				top: 92px;
				z-index: 2147482900; /* 略低于语音球，避免盖住音球 */
				display: flex;
				flex-direction: column;
				align-items: flex-start;
				gap: 6px;
				pointer-events: none;
				font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif;
				color: var(--xfv-ink, #171a21);
			}
			.xfv-experts-toggle {
				pointer-events: auto;
				width: 26px;
				height: 26px;
				border-radius: 8px;
				border: 1px solid var(--xfv-border, rgba(16, 24, 40, 0.10));
				background: var(--xfv-surface, rgba(255, 255, 255, 0.94));
				box-shadow: 0 4px 12px rgba(16, 24, 40, 0.12);
				cursor: pointer;
				font-size: 13px;
				line-height: 1;
				color: var(--xfv-sub, #5b6472);
			}
			.xfv-experts-row { display: flex; flex-direction: column; gap: 8px; }

			.xfv-expert {
				pointer-events: auto;
				position: relative;
				width: 64px;
				cursor: grab;
				touch-action: none; /* 触屏拖拽时不要滚页面 */
				user-select: none;
				-webkit-user-select: none;
			}
			.xfv-expert:active { cursor: grabbing; }

			.xfv-expert-figure {
				position: relative;
				width: 64px;
				height: 64px;
				border-radius: 14px;
				background: var(--xfv-surface, rgba(255, 255, 255, 0.9));
				border: 1px solid var(--xfv-border, rgba(16, 24, 40, 0.10));
				box-shadow: 0 5px 16px rgba(16, 24, 40, 0.14);
				overflow: visible;
				transition: transform 180ms ease, box-shadow 180ms ease;
			}
			.xfv-expert:hover .xfv-expert-figure { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(16, 24, 40, 0.2); }
			.xfv-expert[data-busy="true"] .xfv-expert-figure {
				animation: xfv-expert-work 1.6s ease-in-out infinite;
				border-color: rgba(247, 144, 9, 0.6);
				box-shadow: 0 5px 16px rgba(247, 144, 9, 0.28);
			}
			@keyframes xfv-expert-work {
				0%, 100% { transform: translateY(0) rotate(-1deg); }
				50%      { transform: translateY(-3px) rotate(1deg); }
			}
			.xfv-expert-img {
				width: 100%;
				height: 100%;
				object-fit: contain;
				display: block;
				pointer-events: none;
				user-select: none;
				-webkit-user-drag: none;
			}
			.xfv-expert-initial {
				display: grid;
				place-items: center;
				width: 100%;
				height: 100%;
				font-size: 26px;
				font-weight: 700;
				color: var(--xfv-accent, #2f6bff);
			}
			.xfv-expert-status {
				position: absolute;
				right: -2px;
				bottom: -2px;
				width: 12px;
				height: 12px;
				border-radius: 50%;
				border: 2px solid var(--xfv-surface, #fff);
				background: #12b76a;
			}
			.xfv-expert[data-busy="true"] .xfv-expert-status { background: #f79009; }
			.xfv-expert-name {
				text-align: center;
				font-size: 11px;
				line-height: 1.3;
				margin-top: 3px;
				color: var(--xfv-sub, #5b6472);
				text-shadow: 0 1px 2px rgba(255, 255, 255, 0.9);
			}
			.xfv-expert-task {
				position: absolute;
				left: calc(100% + 8px);
				top: 0;
				width: 190px;
				padding: 8px 10px;
				border-radius: 10px;
				background: var(--xfv-surface, rgba(255, 255, 255, 0.96));
				border: 1px solid var(--xfv-border, rgba(16, 24, 40, 0.10));
				box-shadow: var(--xfv-shadow, 0 10px 30px rgba(16, 24, 40, 0.16));
				font-size: 12px;
				line-height: 1.5;
				color: var(--xfv-ink, #171a21);
				word-break: break-word;
			}
			.xfv-expert-task b { display: block; margin-bottom: 3px; color: #f79009; }

			@media (prefers-color-scheme: dark) {
				.xfv-expert-figure, .xfv-expert-toggle, .xfv-expert-task { background: rgba(28, 32, 40, 0.94); }
				.xfv-expert-name { color: #a4adbb; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8); }
			}

			/* 减少动效偏好：关掉所有动画，避免前庭不适 */
			@media (prefers-reduced-motion: reduce) {
				.xfv-halo, .xfv-bubble, .xfv-orb-face, .xfv-expert-figure { animation: none; }
				.xfv-orb, .xfv-orb-face, .xfv-expert-figure { transition: none; }
			}
			`;
			}

			/**
			 * 注入样式。
			 * @param accent - 强调色。
			 * @returns 卸载函数。
			 */
			function installStyles(accent) {
				if (typeof document === "undefined") return () => {};
				const existing = document.getElementById(STYLE_ID);
				if (existing !== null) existing.remove();
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = css(accent);
				document.head.appendChild(style);
				return () => {
					style.remove();
				};
			}

			__exports({ installStyles });
		});

		__def("ui/useDrag.js", (__exports, __req) => {
			/**
			 * 拖拽 hook（V1.6）：把 pointer 事件翻译成元素左上角坐标。
			 *
			 * ## 为什么不用 HTML5 draggable
			 *
			 * `draggable` 在触屏上不一致、拖影难看、且和"单击唤醒/长按设置"冲突。
			 * Pointer Events + `setPointerCapture` 是跨鼠标/触屏/笔的统一通道：
			 * 一旦按住就捕获指针，手指移出元素也不会丢事件。
			 *
			 * ## 和原有交互的关系
			 *
			 * 语音球本来就有「单击唤醒、长按设置」。拖拽不能误触发它们：
			 *   - 只有移动超过 `isDragGesture` 阈值才进入拖拽态；
			 *   - 一旦判定为拖拽，松开时通过 `onDragEnd` 的 `moved=true` 告诉调用方
			 *     抑制这次点击（调用方在 pointerup 处理里检查 `wasDrag()`）。
			 */
			const React = require("react");
			const { clampPosition, isDragGesture, positionFromPointer, readPosition, writePosition } = __req("ui/drag.js");

			/** 默认拖动阈值。 */
			const DRAG_THRESHOLD = 5;

			/**
			 * @param options.storageKey - 位置持久化 key；空串表示不持久化。
			 * @param options.getSize - 返回元素尺寸 `{w,h}` 的函数（拖拽时取实时值）。
			 * @param options.onDragStart - 开始拖拽时回调（可选，用于切 drag 姿态）。
			 * @param options.onDragEnd - 结束回调 `(moved, pos)`。
			 * @returns `{ position, bind, wasDrag, reset }`。
			 */
			function useDrag(options = {}) {
				const storageKey = typeof options.storageKey === "string" ? options.storageKey : "";
				const getSize = typeof options.getSize === "function" ? options.getSize : () => ({ w: 72, h: 72 });

				const [position, setPosition] = React.useState(() => {
					const saved = storageKey === "" ? null : readPosition(storageKey);
					return saved ?? null; // null = 没拖过，交给 CSS 默认定位
				});

				const dragRef = React.useRef(null);
				const movedRef = React.useRef(false);
				const positionRef = React.useRef(position);
				positionRef.current = position;

				/** 本次 pointerup 是否属于拖拽（供单击处理判定，读完即清零）。 */
				const wasDrag = React.useCallback(() => {
					const moved = movedRef.current;
					movedRef.current = false;
					return moved;
				}, []);

				const onPointerDown = React.useCallback((event) => {
					// 只接管主键（鼠标左键 / 触摸 / 笔）；右键留给"设置"菜单。
					if (event.button !== undefined && event.button !== 0) return;
					const el = event.currentTarget;
					const rect = el.getBoundingClientRect();
					const current = positionRef.current ?? { x: rect.left, y: rect.top };
					dragRef.current = {
						pointerId: event.pointerId,
						start: { x: event.clientX, y: event.clientY },
						origin: { x: current.x, y: current.y },
						el,
					};
					movedRef.current = false;
					try {
						el.setPointerCapture?.(event.pointerId);
					} catch {
						// 某些环境不支持捕获，拖拽仍可用（只是移出元素会丢事件）。
					}
				}, []);

				const onPointerMove = React.useCallback((event) => {
					const drag = dragRef.current;
					if (drag === null || drag.pointerId !== event.pointerId) return;
					const point = { x: event.clientX, y: event.clientY };
					if (!movedRef.current && !isDragGesture(drag.start, point, DRAG_THRESHOLD)) return;
					if (!movedRef.current) {
						movedRef.current = true;
						options.onDragStart?.();
					}
					const desired = positionFromPointer(drag.origin, drag.start, point);
					const size = getSize();
					const next = clampPosition(desired, size, { w: window.innerWidth, h: window.innerHeight });
					positionRef.current = next;
					setPosition(next);
				}, [getSize, options]);

				const onPointerUp = React.useCallback((event) => {
					const drag = dragRef.current;
					if (drag === null || drag.pointerId !== event.pointerId) return;
					try {
						drag.el.releasePointerCapture?.(event.pointerId);
					} catch {
						// 已自动释放。
					}
					dragRef.current = null;
					if (movedRef.current) {
						if (storageKey !== "") writePosition(storageKey, positionRef.current);
						options.onDragEnd?.(true, positionRef.current);
					} else {
						options.onDragEnd?.(false, positionRef.current);
					}
				}, [storageKey, options]);

				const bind = React.useMemo(() => ({
					onPointerDown,
					onPointerMove,
					onPointerUp,
					onPointerCancel: onPointerUp,
				}), [onPointerDown, onPointerMove, onPointerUp]);

				/** 清除持久位置并回到 CSS 默认定位（设置面板的"位置重置"用）。 */
				const reset = React.useCallback(() => {
					if (storageKey !== "") {
						try {
							localStorage.removeItem(`xfv:v1:pos:${storageKey}`);
						} catch {
							// 存储不可用，只重置内存。
						}
					}
					positionRef.current = null;
					setPosition(null);
				}, [storageKey]);

				return { position, bind, wasDrag, reset };
			}

			__exports({ useDrag });
		});

		__def("index.js", (__exports, __req) => {
			/**
			 * 客户端入口：装配语音球。
			 *
			 * ## 装配顺序（有依赖，不可调换）
			 *
			 *   1. 读宿主下发的配置（同步，首帧即就位）；
			 *   2. 注入样式（先于组件渲染，避免首帧无样式闪动）；
			 *   3. 构造控制器（此时还不会碰麦克风）；
			 *   4. 挂到官方 `shell.overlay` 槽；
			 *   5. 绑定全局快捷键；
			 *   6. 注册卸载清理。
			 *
			 * **第 3 步刻意不自动申请麦克风**：浏览器要求"用户手势之后"才能拿到
			 * 麦克风与音频输出许可。自动申请会被静默拒绝，表现为"提示音不响、
			 * 喊了没反应"，反而更难排查。所以启用动作交给用户的一次点击
			 * （语音球 / 快捷键 / 面板按钮）。
			 *
			 * ## 为什么用 `slots.inject` 而不是裸 `register`
			 *
			 * `shell.overlay` 由 `ui-layout`（或接管的整壳插件）在自己的 root
			 * children 里声明，其声明时机可能早于或晚于本插件。`inject` 是惰性等待，
			 * 顺序无关；裸 `register` 在声明未到时直接抛 "slot is not declared"。
			 * 同时 `inject` 也保证插件卸载时把注册一起收掉。
			 */
			const { readConfig, log, warn } = __req("core/runtime.js");
			const { VoiceController } = __req("core/controller.js");
			const { setController, clearController } = __req("core/instance.js");
			const { unlockAudio } = __req("core/chime.js");
			const { VoiceOrb } = __req("ui/Orb.js");
			const { ExpertTeam } = __req("ui/Experts.js");
			const { installStyles } = __req("ui/styles.js");
			const { scheduleFallbackPair } = __req("ui/fallback-mount.js");

			/** 需要 `slots` 服务（槽注册的唯一入口）。 */
			const inject = ["slots"];

			/** 全局快捷键：Alt + Shift + V。 */
			const HOTKEY = { alt: true, shift: true, code: "KeyV" };

			/**
			 * 插件主体。
			 *
			 * ## 为什么整体套 try/catch
			 *
			 * 客户端 bundle 的 `apply` 一旦抛出，DSH 的前端启动器会把本插件标记为
			 * `failed`，并**直接中断整个 web boot** —— 用户看到的是"Failed to load
			 * plugins"的空白页，而不是"语音球没出来"。一个可选功能不该有这种杀伤力，
			 * 所以装配异常一律就地吞掉并落一条带堆栈的 console.error：
			 * 丢的是语音球，不是整个界面。
			 *
			 * @param ctx - 客户端 Cordis 上下文。
			 */
			function apply(ctx) {
				try {
					mount(ctx);
				} catch (error) {
					reportInstallFailure(error);
				}
			}

			/**
			 * 装配失败时的兜底：只报错，不抛。
			 * @param error - 捕获到的异常。
			 */
			function reportInstallFailure(error) {
				const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
				console.error("[小凤] 装配失败，语音球未挂载：", detail);
			}

			/**
			 * 真正的装配逻辑（异常由 `apply` 统一兜住）。
			 * @param ctx - 客户端 Cordis 上下文。
			 */
			function mount(ctx) {
				const { config, fromHost } = readConfig();
				const disposeStyles = installStyles(config.ui.accent);

				const controller = new VoiceController({ ctx, config, fromHost });
				setController(controller);

				// 1) 注册到官方浮层槽。
				//
				//    `shell.overlay` 是 **list 槽**：同一个位置可以叠多个浮层，
				//    所以 `register` 必须带 `id`（唯一键，否则重复挂载会互相覆盖），
				//    `order` 决定同优先级下的叠放顺序（小的先渲染）。少写 `id`
				//    会直接抛 "list slot ... requires options.id"，把整个 web boot 带崩。
				//
				//    同时挂一个 2.5s 的兜底：如果当前 profile 用的是自定义整壳、
				//    没有声明 `shell.overlay`，`slots.inject` 会**永远静默等待**
				//    （不抛错、不渲染）。超时后直接把语音球挂到 body 上，
				//    把"装了但界面上没有"变成"看起来正常"。
				// V1.6：兜底时语音球与专家桌宠一起挂（两者都是 fixed 定位，互不干扰）。
				const fallback = scheduleFallbackPair([VoiceOrb, ExpertTeam], () =>
					warn("没有等到 shell.overlay 槽（可能是自定义整壳未声明），已兜底挂载到页面。"),
				);
				ctx.effect(
					() =>
						ctx.slots.inject("shell.overlay", () => {
							fallback.settle();
							return ctx.slots.register({ name: "shell.overlay", id: "voice-assistant", order: 60 }, VoiceOrb);
						}),
					"voice-assistant: 语音球浮层",
				);

				// 1b) V1.6 专家桌宠层。与语音球并列的另一个浮层条目，独立 id。
				//     它自己会轮询 /activities，端点不可用时整层静默隐藏，
				//     所以这里不需要额外的降级/告警逻辑。
				ctx.effect(
					() =>
						ctx.slots.inject("shell.overlay", () =>
							ctx.slots.register({ name: "shell.overlay", id: "voice-assistant-experts", order: 55 }, ExpertTeam),
						),
					"voice-assistant: 专家桌宠浮层",
				);

				// 2) 全局快捷键。
				//
				//    不用官方 `shortcuts` 服务，是为了让本插件在未加载该服务的
				//    精简 profile 里也能用；代价是不进 "快捷键" 设置页，因此
				//    在面板与 README 里都写明。
				const onKeyDown = (event) => {
					if (event.repeat) return;
					if (event.altKey !== HOTKEY.alt || event.shiftKey !== HOTKEY.shift) return;
					if (event.code !== HOTKEY.code) return;
					// 有输入焦点时也让快捷键生效：唤醒是"我要说话"，不会误伤打字
					// （Alt+Shift 组合本身不产生字符）。
					event.preventDefault();
					unlockAudio();
					const status = controller.getSnapshot().status;
					if (status === "off") controller.start();
					else if (status === "sleeping" || status === "standby") controller.wake();
					else controller.sleep();
				};
				if (typeof window !== "undefined") window.addEventListener("keydown", onKeyDown);

				ctx.effect(
					() => () => {
						if (typeof window !== "undefined") window.removeEventListener("keydown", onKeyDown);
						fallback.cancel();
						if (typeof document !== "undefined") {
							document.querySelectorAll('[id^="xfv-fallback-host"]').forEach((node) => node.remove());
						}
						controller.dispose();
						clearController();
						disposeStyles();
					},
					"voice-assistant: 资源清理",
				);

				if (!fromHost) {
					warn("没有拿到宿主配置，已退回内置默认值（润色与上游语音不可用）。");
				}
				log(
					`已装配（唤醒词「${config.wake.word}」，识别 ${controller.getSnapshot().engine}，休眠 ${Math.round(config.sleep.idleTimeoutMs / 1000)}s）`,
				);
			}

			__exports({ inject, apply });
		});

		const __entry = __req("index.js");
		exports.apply = __entry.apply;
		if (__entry.inject !== undefined) exports.inject = __entry.inject;
		if (__entry.name !== undefined) exports.name = __entry.name;
		return module.exports;
	}
});
