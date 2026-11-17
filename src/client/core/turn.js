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
import { MAX_TURN_MS, SILENCE_SUBMIT_MS } from "./constants.js";

/** 轮次门槛。 */
export class TurnGate {
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
