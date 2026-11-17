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
export function unlockAudio() {
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
export function playChime(kind) {
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
