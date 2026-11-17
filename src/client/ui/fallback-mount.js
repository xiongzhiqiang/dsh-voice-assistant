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
import * as React from "react";

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
export function mountToBody(component) {
	if (typeof document === "undefined" || document.body === null) return null;
	if (document.getElementById(HOST_ID) !== null) return null;

	const host = document.createElement("div");
	host.id = HOST_ID;
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
export function scheduleFallback(component, onFallback) {
	const timer = setTimeout(() => {
		const dispose = mountToBody(component);
		if (dispose !== null) onFallback?.();
	}, FALLBACK_DELAY_MS);
	return {
		settle() {
			clearTimeout(timer);
		},
		cancel() {
			clearTimeout(timer);
		},
	};
}
