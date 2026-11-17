/**
 * 筛选 sherpa-onnx 最新版本里与中文 KWS / 中文流式 ASR 相关的 wasm 资产。
 */
const res = await fetch("https://api.github.com/repos/k2-fsa/sherpa-onnx/releases?per_page=60", {
	headers: { accept: "application/vnd.github+json", "user-agent": "dsh-probe" },
});
const releases = await res.json();
console.log("latest tags:", releases.slice(0, 5).map((r) => r.tag_name).join(", "));

const wanted = /wasm/i;
const rows = [];
for (const r of releases.slice(0, 12)) {
	for (const a of r.assets ?? []) {
		if (!wanted.test(a.name)) continue;
		const interesting = /kws|zh|zh_hans|bilingual|wenetspeech|paraformer|zipformer|tts|kokoro|vits/i.test(a.name);
		if (!interesting) continue;
		if (!/\.tar\.bz2$/.test(a.name)) continue;
		rows.push({ tag: r.tag_name, name: a.name, mb: +(a.size / 1048576).toFixed(1) });
	}
}
rows.sort((x, y) => (x.tag < y.tag ? 1 : x.tag > y.tag ? -1 : x.mb - y.mb));
for (const r of rows.slice(0, 40)) console.log(`${r.tag}\t${r.mb} MB\t${r.name}`);
