/**
 * 极简元素构造助手。
 *
 * 本插件不引入 JSX 构建链（构建脚本保持零依赖纯字符串拼装），
 * 统一用 `h(tag, props, ...children)`。组件是普通函数组件，
 * 与 DSH 官方的槽插件契约一致。
 */
import * as React from "react";

/**
 * 创建 React 元素。
 * @param tag - 标签名或组件。
 * @param props - 属性；`null` 表示无属性。
 * @param children - 子节点（自动扁平化，剔除假值）。
 */
export function h(tag, props, ...children) {
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
export function cx(...parts) {
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
export function useStore(subscribe, getSnapshot) {
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
