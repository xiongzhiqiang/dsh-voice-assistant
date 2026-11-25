# 内置识别运行时（vendored native）

本目录随项目入库，是 V2.1「不依赖 dsh-ears / voice-input-bundle 安装」的运行时部分。
`vendor/node_modules/` 下的包由 Node 的标准解析规则从本项目代码加载，
**不读** `~/.dsh/profiles/*/node_modules`，也不经过 DSH 的 remote 通道。

| 包 | 版本 | 来源 | 用途 |
|---|---|---|---|
| `sherpa-onnx-node` | 1.13.8 | 官方 `dsh-experimental-speech-to-text-sensevoice` 依赖 | SenseVoice ONNX 推理 |
| `sherpa-onnx-win-x64` | 1.13.8 | 同上 | Windows x64 原生 DLL + `.node` |
| `@fugood/whisper.node` | 1.1.3 | `dsh-ears` 依赖 | Whisper JS 绑定 |
| `@fugood/node-whisper-win32-x64` | 1.1.3 | 同上 | Windows x64 `index.node` |

许可：上游包分别为 Apache-2.0 / MIT，见各包内 `LICENSE`（若上游未随包分发，
按其 npm 元数据所述许可使用）。这里只做逐字节复制，未修改上游二进制。

## 换平台怎么办

当前 vendored 的是 **Windows x64**。换到 Linux/macOS 时，在本目录执行对应平台的
安装（模型清单与代码不变）：

```bash
npm install --prefix vendor --no-save sherpa-onnx-node@1.13.8 \
  sherpa-onnx-linux-x64@1.13.8 @fugood/whisper.node@1.1.3 \
  @fugood/node-whisper-linux-x64@1.1.3
```

平台包名规则：`sherpa-onnx-<platform>-<arch>`、`@fugood/node-whisper-<platform>-<arch>`。
缺包时 `GET /asr/status` 会明确报 `native-runtime-missing`，而不是静默不可用。

## 模型

模型二进制不入库（数百 MB），由 `npm run setup:asr` 安装到项目 `.data/asr/`。
清单（URL / 字节数 / SHA256）在 `lib/asr/manifest.js`，逐字抄自上面两个插件。
