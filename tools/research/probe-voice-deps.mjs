/**
 * 探测语音插件依赖的可达性：模型下载站、npm 包、TTS 服务端点。
 * 只做 HEAD/GET 首字节，不落盘。
 */
const targets = [
	["kws-model-hf", "https://huggingface.co/csukuangfj/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/resolve/main/test_wavs/3.wav"],
	["kws-model-hfmirror", "https://hf-mirror.com/csukuangfj/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01/resolve/main/test_wavs/3.wav"],
	["sherpa-github-release", "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2"],
	["npm-sherpa-onnx", "https://registry.npmmirror.com/sherpa-onnx-node"],
	["npm-registry-official", "https://registry.npmjs.org/sherpa-onnx-node"],
	["edge-tts-voices", "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4"],
	["aliyun-pypi", "https://mirrors.aliyun.com/pypi/simple/"],
	["vosk-model-cn", "https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip"],
];

const results = [];
for (const [name, url] of targets) {
	const started = Date.now();
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 12000);
		const res = await fetch(url, { method: "GET", signal: controller.signal, redirect: "follow" });
		clearTimeout(timer);
		const len = res.headers.get("content-length");
		results.push({ name, status: res.status, ok: res.ok, ms: Date.now() - started, bytes: len, type: res.headers.get("content-type") });
		try { await res.body?.cancel(); } catch {}
	} catch (error) {
		results.push({ name, status: "ERR", ok: false, ms: Date.now() - started, error: String(error?.message ?? error) });
	}
}
console.log(JSON.stringify(results, null, 1));
