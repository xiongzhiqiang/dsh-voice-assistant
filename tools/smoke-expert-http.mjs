/**
 * V1.7 真机专家管理接口冒烟（HTTP）。
 *
 * 验证：列出 → 新增（热生效，health 可见）→ 删除（清文件）→
 *       删除内置专家（墓碑，health 移除）→ 清理现场。
 *
 * 用临时 id，且**无论成败都在 finally 里删掉测试写的文件/墓碑**，不污染
 * 用户的专家目录。
 */
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const state = JSON.parse(readFileSync(new URL("./_dsh-serve.json", import.meta.url), "utf8"));
const BASE = "http://127.0.0.1:3080/plugins/dsh-voice-assistant/api";
const COOKIE = `dsh_token=${state.token}`;
const HEADERS = { "content-type": "application/json", cookie: COOKIE };

const failures = [];
const check = (name, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) failures.push({ name, actual, expected });
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` → ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`}`);
};
const get = async (path) => (await fetch(BASE + path, { headers: HEADERS })).json();
const post = async (path, body) => (await fetch(BASE + path, { method: "POST", headers: HEADERS, body: JSON.stringify(body) })).json();
const del = async (path) => (await fetch(BASE + path, { method: "DELETE", headers: HEADERS })).json();

const TEST_ID = "xfv-smoke-temp";
const BUILTIN_ID = "bioinfo"; // 拿内置专家测墓碑（测试后恢复）

async function healthIds() {
	const j = await get("/health");
	return (j.routing?.workers ?? []).map((w) => w.id);
}
async function listedIds() {
	const j = await get("/experts");
	return (j.workers ?? []).map((w) => w.id);
}

let addedFile = null;
let tombFile = null;
try {
	// 目录路径从 list 拿，便于清理。
	const list0 = await get("/experts");
	check("GET /experts 成功", list0.ok, true);
	const dir = list0.dir;
	addedFile = join(dir, `${TEST_ID}.json`);
	tombFile = join(dir, `${BUILTIN_ID}.json`);
	check("列出了 4 位默认专家", (list0.workers ?? []).length, 4);
	check("默认含 pathologist", (list0.workers ?? []).some((w) => w.id === "pathologist"), true);
	check("默认含 protein-designer", (list0.workers ?? []).some((w) => w.id === "protein-designer"), true);

	const ids0 = await healthIds();
	check("health 初始 4 位", ids0.length, 4);

	// 新增
	const add = await post("/experts", {
		id: TEST_ID, label: "测试专家", description: "仅用于冒烟测试", persona: "你是测试专家。", skills: [],
	});
	check("POST /experts 新增成功", add.ok, true);
	check("新增返回播报文案", typeof add.speech === "string" && add.speech.includes("测试专家"), true);
	check("新增落盘", existsSync(addedFile), true);
	check("health 热更新含新专家（5 位）", (await healthIds()).includes(TEST_ID), true);
	check("GET 清单含新专家", (await listedIds()).includes(TEST_ID), true);

	// 删自定义
	const rm = await del(`/experts/${TEST_ID}`);
	check("DELETE 自定义专家成功", rm.ok, true);
	check("删自定义走删文件", rm.mode, "file");
	check("文件已删", existsSync(addedFile), false);
	check("health 移除新专家（回到 4 位）", (await healthIds()).length, 4);

	// 删内置 → 墓碑
	const rmBuiltin = await del(`/experts/${BUILTIN_ID}`);
	check("DELETE 内置专家成功", rmBuiltin.ok, true);
	check("删内置写墓碑", rmBuiltin.mode, "tombstone");
	check("墓碑文件生成", existsSync(tombFile), true);
	check("health 移除内置专家", (await healthIds()).includes(BUILTIN_ID), false);
	const listTomb = await get("/experts");
	check("GET 清单显示墓碑", (listTomb.tombstones ?? []).includes(BUILTIN_ID), true);
} finally {
	// 清理：删掉测试新增文件与墓碑（无论成败）。
	for (const f of [addedFile, tombFile]) {
		if (f && existsSync(f)) {
			try { unlinkSync(f); console.log(`  清理 ${f}`); } catch (e) { console.log(`  清理失败 ${f}: ${e.message}`); }
		}
	}
}

// 清理后再确认 health 恢复 4 位（墓碑移除后需重新 applyChanges —— 直接调不了热更新，
// 但 health 的清单来自 normalized，删文件不会自动触发 reload。这里只验证文件层已清）。
const finalList = await get("/experts");
check("清理后墓碑不在磁盘", (finalList.tombstones ?? []).includes(BUILTIN_ID), false);

if (failures.length > 0) {
	console.error(`\n${failures.length} 项失败`);
	process.exit(1);
}
console.log("\nV1.7 真机专家管理接口冒烟通过");
