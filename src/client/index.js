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
import { readConfig, log, warn } from "./core/runtime.js";
import { VoiceController } from "./core/controller.js";
import { setController, clearController } from "./core/instance.js";
import { unlockAudio } from "./core/chime.js";
import { VoiceOrb } from "./ui/Orb.js";
import { installStyles } from "./ui/styles.js";
import { scheduleFallback } from "./ui/fallback-mount.js";

/** 需要 `slots` 服务（槽注册的唯一入口）。 */
export const inject = ["slots"];

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
export function apply(ctx) {
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
	const fallback = scheduleFallback(VoiceOrb, () =>
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
			if (typeof document !== "undefined") document.getElementById("xfv-fallback-host")?.remove();
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
