/**
 * 专家工作态投影（V1.6，纯函数、零依赖）。
 *
 * 把委托中枢的 `activeJobs` 投影成"每位专家此刻在不在干活"，供客户端的
 * 卡通形象切换 idle / working 姿态。之所以单独抽一层而不是让客户端自己
 * 解析 `/health`：
 *   - `/health` 是**大对象**（技能、preset、记忆……），1.5s 轮询一次太重；
 *   - 投影规则（多任务取最新、任务截断、任务 id）集中在一处，单测能钉住；
 *   - 用户在配置里自加的专家也要出现在清单里（哪怕空闲），否则浮层缺人。
 */

/**
 * 投影专家工作态。
 *
 * @param workers - 专家清单 `[{id,label,...}]`（来自 config.routing.workers）。
 * @param activeJobs - 在途任务 `[{jobId,workerId,task,startedAt}]`。
 * @param now - 当前时刻（毫秒），用于算已运行时长。
 * @returns `{ at, workers: [{id,label,busy,task,jobId,startedAt,elapsedMs}], activeCount }`。
 */
export function projectActivities(workers, activeJobs, now = Date.now()) {
	const list = Array.isArray(workers) ? workers : [];
	const jobs = Array.isArray(activeJobs) ? activeJobs : [];

	// 同一 worker 理论上串行（委托中枢保证），但防御性地取"最近启动"的那条。
	const latestByWorker = new Map();
	for (const job of jobs) {
		if (job === null || typeof job !== "object") continue;
		const id = typeof job.workerId === "string" ? job.workerId : "";
		if (id === "") continue;
		const started = Number(job.startedAt) || 0;
		const existing = latestByWorker.get(id);
		if (existing === undefined || started > existing.started) {
			latestByWorker.set(id, { job, started });
		}
	}

	const rows = list.map((worker) => {
		const id = typeof worker?.id === "string" ? worker.id : "";
		const label = typeof worker?.label === "string" && worker.label !== "" ? worker.label : id;
		const hit = latestByWorker.get(id);
		if (hit === undefined) {
			return { id, label, busy: false, task: "", jobId: "", startedAt: 0, elapsedMs: 0 };
		}
		const job = hit.job;
		const task = typeof job.task === "string" ? job.task.slice(0, 60) : "";
		return {
			id,
			label,
			busy: true,
			task,
			jobId: typeof job.jobId === "string" ? job.jobId : "",
			startedAt: hit.started,
			elapsedMs: Math.max(0, now - hit.started),
		};
	});

	return {
		at: now,
		workers: rows,
		activeCount: rows.reduce((sum, row) => sum + (row.busy ? 1 : 0), 0),
	};
}
