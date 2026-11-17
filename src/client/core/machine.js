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
import { EVENTS, STATES } from "./constants.js";

/** 迁移表。 */
export const TRANSITIONS = {
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
export function nextState(current, event) {
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
export class VoiceMachine {
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
