/**
 * 读 DSH 会话日志：`session.v4.jsonl.zstd` 是**多帧拼接**的 zstd，
 * 不是整文件一个流 —— 直接 `zstdDecompressSync` 只解出第一帧（症状：
 * 164KB 的文件解出 171 字节、只有 1 行 `session`）。
 *
 * 做法：按 zstd 魔数 `28 B5 2F FD` 切帧，逐帧解压再拼接。
 * 帧内是标准 zstd 帧；解压时给足输出缓冲（`maxOutputLength`）。
 */
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 把一个多帧 zstd buffer 解成文本。
 * @param buffer - 整个文件的字节。
 * @returns 拼接后的文本。
 */
export function decompressMultiFrame(buffer) {
	const starts = [];
	let at = buffer.indexOf(MAGIC, 0);
	while (at !== -1) {
		starts.push(at);
		at = buffer.indexOf(MAGIC, at + 4);
	}
	if (starts.length === 0) return buffer.toString("utf8");
	const parts = [];
	for (let index = 0; index < starts.length; index += 1) {
		const from = starts[index];
		const to = index + 1 < starts.length ? starts[index + 1] : buffer.length;
		const frame = buffer.subarray(from, to);
		try {
			parts.push(zstdDecompressSync(frame, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8"));
		} catch {
			// 帧损坏（例如写入被打断）就跳过这一帧，不影响其余。
		}
	}
	return parts.join("");
}

/**
 * 读一个会话日志文件并解成文本。
 * @param path - `.jsonl.zstd` 路径。
 * @returns 文本内容。
 */
export function readSessionLog(path) {
	return decompressMultiFrame(readFileSync(path));
}
