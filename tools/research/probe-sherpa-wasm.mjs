/**
 * 列出 sherpa-onnx 的 wasm 相关发布资产，用于挑选「直接可用、体积可控」的浏览器端组件。
 */
const url = "https://api.github.com/repos/k2-fsa/sherpa-onnx/releases?per_page=100";
const res = await fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "dsh-probe" } });
console.log("status", res.status);
const releases = await res.json();
const rows = [];
for (const r of releases) {
	for (const a of r.assets ?? []) {
		if (!/wasm/i.test(a.name)) continue;
		if (!/kws|zh|asr|tts|vad/i.test(a.name)) continue;
		rows.push({ tag: r.tag_name, name: a.name, mb: +(a.size / 1048576).toFixed(1), url: a.browser_download_url });
	}
}
rows.sort((x, y) => x.mb - y.mb);
for (const r of rows.slice(0, 60)) console.log(`${r.mb}\tMB\t${r.tag}\t${r.name}`);
console.log("total wasm-ish assets", rows.length);
