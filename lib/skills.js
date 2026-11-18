/**
 * 专家技能（宿主半）—— 让常驻专家 agent「会做什么」可被声明。
 *
 * ## 这一层解决什么
 *
 * 光有人格（persona）只能约束**语气**，不能让专家掌握**流程**。基因分析这类
 * 工作有固定的多步纪律（先确认参考基因组、按 gnomAD 过滤、按 AMP/ASCO/CAP
 * 分级、每个结论都要有来源）—— 这些写进 persona 会挤爆提示词，也会在每轮
 * 对话里重复计费。
 *
 * DSH 的 skill 机制正是为此设计的**两段式加载**：
 *   1. catalog 段只放 `name` + 截断的 `description`（默认 500 字）常驻提示词，
 *      让模型知道「有这么个技能、什么时候该用」；
 *   2. 模型判断需要时，`tool-skill` 才把**正文**注入上下文按需加载。
 *
 * 所以专家的能力 = 挂哪些技能，而不是提示词里塞多少字。
 *
 * ## 技能从哪来（三个来源，优先级从高到低）
 *
 * | 来源 | 位置 | 谁维护 |
 * |---|---|---|
 * | 插件内置 | `<插件>/skills/<name>/SKILL.md` | 随 git 版本管理，装插件即生效 |
 * | 用户技能目录 | `$DSH_HOME/voice-assistant/skills/<name>/SKILL.md` | 用户自己丢文件 |
 * | 用户单文件 | `$DSH_HOME/voice-assistant/skills/<name>.md` | 同上 |
 *
 * 内置技能**不落磁盘**也能用：插件被 junction 装进 DSH 时 `import.meta.url`
 * 解析到真实路径（`WorkBuddy/DSH_dev/…`），`../skills/` 就在那条真实路径下，
 * 与是否 junction 无关。打包安装（拷贝进 node_modules）时由 `package.json`
 * 的 `files` 字段把 `skills/` 带上。
 *
 * ## 为什么不用 `dsh-skill-filesystem` 去发现
 *
 * 那个 provider 扫的是 `~/.dsh/skills`、`~/.agents/skills` 这类**全局**根，
 * 注册进的是**全局层** —— 全 DSH 的会话都会看到基因分析技能。需求是
 * 「专家掌握它」，作用域必须是**那一个 agent**。所以在 `setup(agentCtx)` 里
 * `agentCtx.skills.register()`：`SkillRegistry.register` 按**调用时 ctx 的
 * scope** 归档（`scopeOf(this.ctx)`），agent 作用域注册只对该 agent 可见。
 *
 * ## 失败策略
 *
 * 任何一步失败都**只降级、不阻断**：技能缺失时 agent 仍能建起来、仍能对话，
 * 只是不会那个流程。降级必须**可见**（`describeExpertSkills` 会把结果交给
 * health），否则用户只会看到"专家好像不太懂行"而无从排查。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 技能名白名单（与 `dsh-skill` 的 `SKILL_NAME` 同一条文法）。 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 单个技能正文长度上限：超过说明写成了手册，该拆或该外置到资源目录。 */
const SKILL_CONTENT_LIMIT = 60000;

/** 技能描述长度上限（catalog 段常驻提示词，长了等于每轮都烧 token）。 */
const SKILL_DESCRIPTION_LIMIT = 600;

/**
 * 本插件的根目录（`lib/` 的上一级）。
 *
 * 用 `import.meta.url` 是**有意为之**：插件以 junction 装进 DSH 时，Node 按
 * 真实路径解析，于是这里拿到的是源码目录 —— 那正是 `skills/` 所在的目录。
 * （`lib/messages.js` 反过来必须避开 `import.meta.url`，因为它要去 profile
 * 的 `node_modules` 里找 `@deepseek-ai` 包，那条链上确实没有。两者需求
 * 相反，不是笔误。）
 */
function pluginRoot() {
	try {
		return resolve(dirname(fileURLToPath(import.meta.url)), "..");
	} catch {
		return "";
	}
}

/**
 * 用户技能根目录（`$DSH_HOME/voice-assistant/skills`）。
 * @returns 绝对路径。
 */
export function userSkillRoot() {
	const root = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(root, "voice-assistant", "skills");
}

/**
 * 切出 YAML frontmatter 与正文。
 *
 * 只认文件**开头**的 `---` 块（与 DSH 的 skill 解析器同口径）；正文里的
 * 分割线不会被误当 frontmatter。frontmatter 缺失时整篇都是正文。
 *
 * @param raw - 文件全文。
 * @returns `{ front, body }`；`front` 为原始 YAML 文本（可能为空串）。
 */
export function splitFrontmatter(raw) {
	const text = String(raw ?? "");
	if (!text.startsWith("---")) return { front: "", body: text };
	const end = text.indexOf("\n---", 3);
	if (end === -1) return { front: "", body: text };
	return { front: text.slice(3, end), body: text.slice(end + 4) };
}

/**
 * 从 frontmatter 里取一个标量字段。
 *
 * 只做**够用**的解析，不引 YAML 依赖：本项目要在无 `node_modules` 的环境里
 * 也能单测。支持三种写法：
 *   - `key: value`
 *   - `key: "value"` / `key: 'value'`（去引号）
 *   - `key: >` 或 `key: |` 后跟缩进块（拼成一行，块内换行转空格）
 *
 * 复合结构（数组、嵌套 map）**不支持**——技能元数据只需要标量。
 *
 * @param front - frontmatter 原始文本。
 * @param key - 字段名。
 * @returns 值（未找到返回空串）。
 */
export function frontmatterField(front, key) {
	const lines = String(front ?? "").split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[index]);
		if (match === null || match[1] !== key) continue;
		const inline = match[2].trim();
		// 块标量：`>` 折叠 / `|` 字面 —— 都拼成一行（描述只要一行）。
		if (inline === ">" || inline === "|") {
			const parts = [];
			for (let next = index + 1; next < lines.length; next += 1) {
				const line = lines[next];
				if (line.trim() === "") continue;
				if (!/^\s/.test(line)) break; // 缩进结束 = 块结束。
				parts.push(line.trim());
			}
			return parts.join(" ");
		}
		return inline.replace(/^["']|["']$/g, "").trim();
	}
	return "";
}

/**
 * 读一个 SKILL.md（或扁平 `<name>.md`），解析成技能定义。
 *
 * 名称以 **frontmatter 的 `name` 为准**，缺省才回落到文件名 —— 与 DSH 的
 * 解析口径一致，避免"目录名和里面写的不一样"时两处记的名字不同。
 *
 * @param file - SKILL.md / <name>.md 的绝对路径。
 * @param fallbackName - frontmatter 没有 name 时用的名字（目录名或文件名）。
 * @returns `{name, description, whenToUse, content}` 或 `null`（不可用）。
 */
export function readSkillFile(file, fallbackName) {
	let raw = "";
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const { front, body } = splitFrontmatter(raw);
	const name = (frontmatterField(front, "name") || fallbackName || "").trim();
	if (!SKILL_NAME.test(name)) return null;
	const description = (frontmatterField(front, "description") || "").trim();
	// description 是 register 的硬性要求（空描述会被 validateRuntimeSkill 抛错），
	// 缺失时用正文首行兜底，而不是让整个技能不可用。
	const fallbackDescription = String(body ?? "")
		.split(/\r?\n/)
		.map((line) => line.replace(/^#+\s*/, "").trim())
		.find((line) => line !== "") ?? "";
	const finalDescription = (description || fallbackDescription).slice(0, SKILL_DESCRIPTION_LIMIT);
	if (finalDescription === "") return null;
	const content = String(body ?? "").trim().slice(0, SKILL_CONTENT_LIMIT);
	if (content === "") return null;
	const whenToUse = frontmatterField(front, "whenToUse") || frontmatterField(front, "when_to_use");
	return { name, description: finalDescription, content, whenToUse: whenToUse.trim() };
}

/**
 * 扫一个技能根目录（`<root>/<name>/SKILL.md` 与 `<root>/<name>.md`）。
 *
 * 深度为**一层**，与 DSH 的 skill-filesystem 同口径：嵌套的
 * `**\/SKILL.md` 不被发现（`mutation-clinical-report/mutation-clinical-report/`
 * 那种双层目录就是踩这个坑，本机实测过）。
 *
 * @param root - 技能根目录。
 * @returns `名字 → 技能定义`（目录按名字升序，保证结果稳定可测）。
 */
export function scanSkillRoot(root) {
	const found = new Map();
	if (typeof root !== "string" || root === "") return found;
	let entries = [];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return found; // 目录不存在是正常情况（用户还没建过技能）。
	}
	const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of sorted) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory()) {
			const file = join(root, entry.name, "SKILL.md");
			if (!existsSync(file)) continue;
			const skill = readSkillFile(file, entry.name);
			if (skill !== null && !found.has(skill.name)) found.set(skill.name, skill);
			continue;
		}
		if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
			const fallback = entry.name.slice(0, -3);
			const skill = readSkillFile(join(root, entry.name), fallback);
			if (skill !== null && !found.has(skill.name)) found.set(skill.name, skill);
		}
	}
	return found;
}

/**
 * 载入全部可用技能（内置优先，用户技能补位）。
 *
 * 优先级体现在**同名不覆盖**：内置技能是插件版本管理的一部分，用户放一个
 * 同名文件不该悄悄改掉它（要改用不同名字，或改配置点名用户技能）。
 *
 * @param options - `{ builtinDir, userDir }`（测试用；省略走默认路径）。
 * @returns `{ skills: Map, sources: [{name, from}], builtinDir, userDir }`。
 */
export function loadSkillCatalog(options = {}) {
	const builtinDir = options.builtinDir ?? join(pluginRoot(), "skills");
	const userDir = options.userDir ?? userSkillRoot();
	const skills = new Map();
	const sources = [];
	for (const [name, skill] of scanSkillRoot(builtinDir)) {
		skills.set(name, skill);
		sources.push({ name, from: "builtin" });
	}
	for (const [name, skill] of scanSkillRoot(userDir)) {
		if (skills.has(name)) {
			sources.push({ name, from: "user-shadowed" });
			continue;
		}
		skills.set(name, skill);
		sources.push({ name, from: "user" });
	}
	return { skills, sources, builtinDir, userDir };
}

/**
 * 把技能注册到**一个 agent 的作用域**（必须在 `setup(agentCtx)` 内调用）。
 *
 * @param agentCtx - agent 的作用域上下文（`setup` 的第一个参数）。
 * @param names - 要挂的技能名数组。
 * @param catalog - `loadSkillCatalog()` 的产物。
 * @returns `{ registered: string[], missing: string[], reason: string }` —— 供 health 与日志。
 */
export function registerExpertSkills(agentCtx, names, catalog) {
	const wanted = Array.isArray(names) ? names.filter((name) => typeof name === "string" && name !== "") : [];
	const out = { registered: [], missing: [], reason: "" };
	if (wanted.length === 0) return out;

	// ⚠️ 取服务必须包 try/catch：Cordis 对**未声明 inject 的服务**访问是
	// **同步抛出**而不是返回 undefined（本项目在 workspaceRegistry 上踩过，
	// 见 lib/identity.js）。这里由 agent 作用域取，服务缺席时要降级不要带崩。
	let registry;
	try {
		registry = agentCtx?.get?.("skills") ?? agentCtx?.skills;
	} catch (error) {
		out.reason = `get-threw: ${String(error?.message ?? error)}`;
		out.missing = wanted.slice();
		return out;
	}
	if (registry === undefined || registry === null || typeof registry.register !== "function") {
		out.reason = "skills-service-missing";
		out.missing = wanted.slice();
		return out;
	}

	for (const name of wanted) {
		if (out.registered.includes(name)) continue;
		const skill = catalog?.skills?.get(name);
		if (skill === undefined) {
			out.missing.push(name);
			continue;
		}
		try {
			registry.register({
				name: skill.name,
				description: skill.description,
				content: skill.content,
				...(skill.whenToUse === "" || skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
			});
			out.registered.push(name);
		} catch (error) {
			// 单个技能注册失败（名字非法、描述为空、同层重名）不连坐其它技能。
			out.missing.push(name);
			out.reason = out.reason === "" ? `register-failed(${name}): ${String(error?.message ?? error)}` : out.reason;
		}
	}
	return out;
}

/**
 * 取某个专家声明的技能在当前环境下的**可用性**（health / 日志用）。
 *
 * @param names - 专家声明的技能名。
 * @param catalog - `loadSkillCatalog()` 的产物。
 * @returns `{ declared, available, missing }`。
 */
export function describeExpertSkills(names, catalog) {
	const declared = Array.isArray(names) ? names.filter((name) => typeof name === "string" && name !== "") : [];
	const available = declared.filter((name) => catalog?.skills?.has(name) === true);
	return { declared, available, missing: declared.filter((name) => !available.includes(name)) };
}
