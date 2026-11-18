/**
 * 互动条目类型（宿主半与客户端半**共用**的常量）。
 *
 * ## 为什么单独一个文件
 *
 * 类型名会被写进 HTTP 响应、又被客户端读出来分派播报语气 —— 两边各写一份
 * 字符串字面量，改一处漏一处就是"某类互动永远不播报"这种静默故障。收在
 * 一个文件里，改名时编译器/测试会一起跟上。
 *
 * ## 三类互动的共同点
 *
 * 它们都是"需要用户知道、或需要用户去界面处理"的事，因此共用一条**按时间
 * 排序**的流（需求④），而不是各播各的。
 */

/** 权限审核：专家要用一个有副作用的工具，需要用户在界面上允许/拒绝。 */
export const APPROVAL_KIND = "approval";

/** 模型提问：`ask_user_question`，需要用户去界面选答案。 */
export const QUESTION_KIND = "question";

/** 结果汇报：后台任务完成，只需听结论。 */
export const REPORT_KIND = "report";

/** 全部类型（白名单；客户端据此判断收到的条目认不认识）。 */
export const INTERACTION_KINDS = [APPROVAL_KIND, QUESTION_KIND, REPORT_KIND];

/**
 * 该类型是否需要用户**去界面处理**（而不是只听）。
 *
 * 客户端据此决定提示音的响法与文案措辞：需要处理的要说"请到界面上处理"，
 * 纯汇报的只说结论。**注意"需要处理"不等于"语音可以代答"** —— 语音助手
 * 一律不代答，这条只影响播报语气。
 *
 * @param kind - 互动类型。
 * @returns 是否需要用户操作。
 */
export function needsAction(kind) {
	return kind === APPROVAL_KIND || kind === QUESTION_KIND;
}
