# 「小凤」语音助手 —— 安装与使用说明

> 适用版本：**V2.0.0**（接入官方 SenseVoice 识别 + UI 自主选择识别方式/语言）
> 项目：`dsh-voice-assistant` —— 一个 DeepSeek Harness（DSH）bundle 插件。

它把 DSH 从「打字对话」变成「对着电脑说话」：**常驻待机 → 喊「小凤」唤醒 →
说话 → 润色 → 意图路由 → 派给后台专家 → 只播报专家回报的一句要点 → 静默休眠**。

---

## 0. 名词先分清（避免踩坑）

| 概念 | 是什么 | 不是什么 |
|---|---|---|
| **小凤 / router** | 语音入口 + 意图路由（根 agent），负责听、润色、派单、按时间播报要点 | 不是干活的执行者 |
| **专家 / worker** | 后台常驻的领域 agent（基因分析、病理、蛋白设计…），真正执行任务 | 与 DSH 原生「智能体团队」是**两套独立机制** |
| **会话 / session** | 运行时资源。每位专家可有多个会话（默认会话 + 按需新建），有跨会话记忆摘要 | V1.8 起不再与专家一对一硬绑定 |

V1.8 已把插件专家系统和 DSH 自带的团队功能彻底隔离：常驻助手在全新干净的
`session-voice-assistant-root-v2` 会话里启动，不带任何 team 事件。

---

## 1. 前置要求

| 项 | 要求 |
|---|---|
| DSH | 已安装并能以 web profile 启动；需 `@deepseek-ai/dsh-host-webserver >=0.2.2-rc.1 <0.3.0` |
| Node.js | 20+（推荐 22.x） |
| 浏览器 | Chrome / Edge 等支持 Web Speech API 的现代浏览器 |
| 麦克风 | 系统已授权浏览器使用（首次点击语音球后浏览器才申请权限） |
| 网络 | 浏览器 Web Speech 识别依赖境外云端；受限网络下用插件**内置**的识别后端（见第 8 节） |
| 模型（可选但推荐） | 内置识别需要约 700 MB 磁盘：Whisper small 465 MB + SenseVoice int8 228 MB，由 `npm run setup:asr` 安装；首次可离线从已装插件目录校验后复制 |

V2.1 起识别 runtime 是**随项目入库的 vendored 原生包**（`vendor/node_modules/`，约 23 MB），
不依赖 DSH profile 是否装了 `dsh-ears` / `voice-input-bundle`。`lib/client.js` 仍由
`build.mjs` 零依赖打成 classic script。

---

## 2. 安装

### 2.1 通用步骤（其他机器）

```sh
cd dsh-voice-assistant
node build.mjs                        # 生成 lib/client.js（首次必做）
npm run setup:asr                     # 安装内置识别模型（离线可加 --no-download）
dsh plugin --profile web add "$PWD"   # 把当前目录装进 web profile
```

`setup:asr` 把模型装进项目内 `.data/asr/`（可用 `DSH_VOICE_ASR_HOME` 改路径），
逐文件做字节数 + SHA256 校验；本机若已装 `dsh-ears` / `voice-input-bundle`，
会优先从它们的模型目录**校验后复制**（不联网）。模型二进制不入库。

`dsh plugin add` 会触发 pnpm 重装；如果用 `link:` 依赖，注意从
`profiles/web` 到项目根的相对路径层数（通常是 `../../../`）。

### 2.2 加入 bundle 列表

确认 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里含
`dsh-voice-assistant`：

```json
"bundles": [ "...", "dsh-voice-assistant" ]
```

### 2.3 启动 / 重启 DSH

```sh
node <DSH_HOME>/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open
```

> Windows + PowerShell 环境若因 `HTTP_PROXY` / `http_proxy` 冲突导致 `Start-Process`
> 报「已添加项」，用上面的 `node` 直调 + 日志重定向，绕开 `Start-Process`。

### 2.4 开发者本机安装（junction 方式）

若要把源码目录直接挂进 profile（改代码即时生效）：

```
源码：   <项目目录>/dsh-voice-assistant
已装为： <DSH_HOME>/profiles/web/node_modules/dsh-voice-assistant（junction 指向源码）
```

> 注意：**改 `src/client/**` 必须 `node build.mjs` 重建**；改宿主半（`lib/**`、
> `index.js`、`cordis.patch.yml`）必须**重启 DSH**。旧浏览器页需**硬刷新**才拿到新 bundle。

---

## 3. 配置

配置文件：`~/.dsh/profiles/web/cordis.patch.yml`（随插件模板，按 id `voice-assistant` 覆盖）。
V1.8 常用项：

```yaml
- id: voice-assistant
  name: 'dsh-voice-assistant'
  config:
    wake:
      word: '小凤'                      # 唤醒词
      aliases: ['小风', '晓凤', '小枫']  # 同音容错
      inlineCommand: true               # "小凤，帮我看下" 一句话唤醒+下指令
    language: 'zh-CN'
    sleep:
      idleTimeoutMs: 60000              # 静默多久休眠
      keepWakeWord: false               # false=休眠真关麦（喊不醒，需点球/快捷键）
      chime: true                       # 唤醒/休眠提示音
    asr:
      engine: 'auto'                    # auto | ears | webspeech | http
    tts:
      engine: 'browser'                 # browser=系统语音零延迟 | http
    turn:
      silenceMs: 5000                   # 声音停多久算"这轮说完"（3s–10min）
      maxTurnMs: 300000
      echoGuard: true
    agent:
      enabled: true
      sessionId: 'session-voice-assistant-root-v2'   # 常驻助手会话 id（V1.8 换新）
      persist: true
    memory:
      global: false                     # 全局记忆（对所有会话生效），默认关闭
      text: ''
    routing:
      expertDirs:                       # 专家定义唯一真相源（不配则用 ~/.dsh/voice-assistant/experts）
        - /path/to/your/experts
```

⚠️ **`turn.silenceMs` 是「四层一致」旋钮**：实机值在 `cordis.patch.yml`，代码默认在
`lib/config.js`，客户端兜底在 `src/client/core/constants.js` + `runtime.js`，还有测试哨兵。
只改一处会造成「代码默认 10s、实机跑 5s」的幽灵差异。改宿主半配置**必须重启 DSH**。

---

## 4. 使用

| 操作 | 方式 |
|---|---|
| 启用语音 / 唤醒 / 打断播报 | 单击语音球 |
| **说完了，立即提交** | **正在听时单击语音球**（不必等满静音） |
| 打开状态面板 | 长按语音球 600ms，或右键 |
| 唤醒 / 休眠切换 | `Alt + Shift + V` |
| 喊「小凤」 | 待机态直接说；「小凤，帮我看看这个报错」一句话下发 |
| 试听 | 面板里的「试听」 |

**状态点颜色**：绿=待机、蓝=在听、橙=思考、紫=播报、灰=休眠。
气泡显示待提交内容 + 倒计时，或实时字幕。

### 4.0 专家桌宠（V1.9）

- **空闲看不到、工作才出现**：没有专家在干活时，页面上一张桌宠都没有；一旦派单给
  某位专家，它才从左侧滑入 + 轻微弹跳冒出来，任务结束自动收起。
- **透明底**：桌宠形象是透明背景的卡通图，没有白色卡片边框，直接浮在界面上。
- **单个控制**：每张桌宠右上角有自己的「−」按钮，可单独收起这位专家（不影响其它）；
  位置可各自拖拽，拖过的位置会记住。收起只在本任务内生效，任务结束自动恢复。
- hover 桌宠可看到它当前正在处理的任务。

### 4.1 专家管理（V2.2：唯一真相源 + 实时同步）

**专家定义只有一份**：`~/.dsh/voice-assistant/experts/*.json`（可用
`routing.expertDirs` 改路径，不配就用这个默认目录）。代码里不再内置任何
领域专家，只有 `general` 这一个系统兜底锚点（路由失败落点，不可删）。
目录里每个顶层 `*.json` 是一位专家，字段是**完整定义**、不跟任何模板合并：

```json
{
  "id": "chem",
  "label": "小化 · 化学",
  "description": "分子建模与性质预测。",
  "persona": "你是「小化」，专注化学分析……",
  "skills": []
}
```

四个入口都汇到同一份文件、且**当场生效（约 250ms，无需重启）**：

| 入口 | 做法 |
|---|---|
| 语音 | 「列出专家」「新增专家 化学，负责化学分析」「删除专家 化学」 |
| HTTP（前缀 `/plugins/dsh-voice-assistant/api`） | `GET /experts` 列出；`POST /experts` 新增；`DELETE /experts/<id>` 删除 |
| 手工改目录 | 直接往目录丢/删/编辑 `*.json`，`fs.watch` 自动重扫 |
| 直接编辑 JSON | 同上，改完即时同步 |

每次变动都会调 `applyChanges()`：原地更新运行时花名册（路由 prompt、
客户端配置、桌宠头像映射都跟着变），新增的建常驻 agent、删除的从委托中枢
注销并清掉会话注册表里该专家的会话与跨会话摘要。

- 删除 = 直接删掉 `<id>.json`（旧版 `{"disabled":true}` 墓碑仍兼容）。
- `general` 不可删；目录里写 `general.json` 会被忽略。
- `id` 必须匹配 `[a-z0-9][a-z0-9_-]{0,63}`，`label` 与 `description` 必填。
- 目录不存在属正常初始态，不会报假红；`routing.workers` / `routing.experts`
  内联清单只在目录全部不可读时作兼容兜底，不再作为配置入口。

### 4.2 会话管理（V1.8）

每位专家有默认会话，可按需新建/切换/关闭；派单可指定投到哪个会话（省略走活跃会话）。

- 语音：「列出会话」「给小因开个会话」「切换到小因会话」「关闭小因会话 2」
- HTTP：`GET /sessions`、`POST /sessions/<id>`、`POST /sessions/<id>/switch`、
  `DELETE /sessions/<id>/<sid>`；`POST /delegate` 可带 `sessionId` 指定会话。

专家记忆是**每专家一份跨会话摘要**：派单时注入、完成后回写要点，所以新会话也能
接上这位专家此前在别的会话做过的事。

### 4.3 常见问题

- **说完不提交？** 默认要静音满 5 秒才算一轮结束，中途文字在涨但不发给模型是正常的；
  单击语音球可立即提交。
- **喊「小凤」叫不醒？** 休眠默认真关麦（`keepWakeWord:false`），这是设计语义；
  想随时喊醒就把它设为 `true`。
- **首次无反应？** 浏览器要求用户手势后才给麦克风/音频权限，先点一次语音球。
- **识别报 `speech-network`？** 浏览器 Web Speech 连不上境外云端，见第 8 节换后端。
- **侧栏会话全消失 / 新建不出来？** 别慌，数据通常完好。先跑
  `npm run check:sessions`。根因几乎都是有人在 `~/.dsh/sessions/` 里**原地改了会话目录名**
  → 目录名与日志首帧 `header.id` 错配 → workspace 插件挂载失败。**绝不原地改名，坏会话只移出。**

---

## 5. 验证

改完代码先跑纯逻辑层（不需要 DSH 在跑）：

```sh
npm test                    # 7 个测试文件全绿
node build.mjs --check      # 只校验不写盘
npm run verify              # 会话完整性 + 宿主半冒烟 + agent 路由
```

需要 DSH 在跑的真机验收：

```sh
npm run probe:ledger        # 播报水位 / 去重
npm run probe:expert-http   # 专家管理 HTTP（GET/POST/DELETE）
npm run probe:sessions      # 会话管理 HTTP
npm run probe:visuals       # 真浏览器：素材/桌宠/拖拽/音球
npm run probe:expert-cmd    # 语音专家命令
npm run probe:session-cmd -- "<带 token 的 URL>"   # 语音会话命令
```

健康自省（需认证）：

```sh
# 1) 取 token（按 mtime 取最新日志里的 token）
# 2) GET /?token=xxx → 303 + Set-Cookie
# 3) 带 cookie 访问：/plugins/dsh-voice-assistant/api/health
#    期望：HTTP 200、version=2.2.0、ok=true、problems=[]、asrLocal.native 两项为 true
```

---

## 6. 目录结构（V2.2）

```
index.js                     插件入口：装配宿主半
cordis.patch.yml             增量配置（唤醒/识别/播报/轮次/专家/会话…）
build.mjs                    零依赖 ESM → classic script 打包器
lib/
  config.js  client.js      配置归一化 / 客户端注入
  router.js  delegation.js  意图路由 / 派单中枢（slot 复合键）
  workers.js  agent.js      general 锚点 + 目录 JSON 扫描 / agent 定义
  expert-registry.js        目录 JSON 的 CRUD + 校验 + 原子写盘
  expert-manager.js         增删落盘 + 原地 splice 热生效 + fs.watch 目录监听
  expert-sessions.js        会话注册表 + 跨会话记忆摘要（<expertDir>/_state/sessions.json）
  session-manager.js        会话管理中枢（HTTP 与语音命令共用）
  routes.js                 HTTP 路由（health/experts/sessions/delegate…）
  report.js  interactions.js 要点汇报队列 / 统一互动流
  skills.js                 专家技能注册
  avatars.js  activities.js 素材白名单路由 / 专家忙闲投影
  asr/manifest.js            内置识别模型清单（URL/字节/SHA256）与校验
  asr/runtime.js             内置识别服务（可用性/子进程生命周期/转写）
  asr/worker.js              SenseVoice / Whisper 推理子进程
src/client/                  客户端半（状态机/唤醒/采集/TTS/浮层 UI）
skills/somatic-mutation-report/  内置基因分析技能
assets/characters/           专家卡通素材（Q 版透明底 PNG）
vendor/node_modules/         内置识别的 vendored 原生包（随源码入库）
.data/asr/                   内置识别模型（不入库，npm run setup:asr 安装）
tests/  tools/               单测 / 冒烟探针 / 会话自检工具
```

---

## 7. 卸载

从 `dsh.profile.bundles` 里删掉 `dsh-voice-assistant` 并重启 DSH 即可。
本插件**没有 disable 任何官方行**，删除不牵连其他插件。

---

## 8. 语音识别后端说明

默认基线是**浏览器 Web Speech**（零配置），但它依赖境外云端，国内受限网络下会报
`speech-network`。可选：

| 后端 | 说明 |
|---|---|
| 浏览器 Web Speech | 零配置，依赖境外云端 |
| **内置本地 Whisper（V2.1）** | 项目自带 `whisper.node` 原生包 + `ggml-small.bin`（465MB），语言钉死 `zh`；**不需要装 `dsh-ears`** |
| **内置本地 SenseVoice（V2.1）** | 项目自带 `sherpa-onnx-node` + SenseVoice Small INT8（228MB）+ Silero VAD；支持 auto/zh/en/粤/ja/ko；**不需要装 `voice-input-bundle`** |
| `http` 自建端点 | 任意 OpenAI 兼容 `/audio/transcriptions`，在 `asr.http` 配置 baseURL/apiKey/model |

### 8.1 在 UI 里选识别方式（V2.1）

**长按语音球（或右键）打开设置面板 → 「识别方式」下拉**，即可自主切换：
`自动` / `浏览器识别` / `本地 Whisper（内置）` / `本地 SenseVoice（内置）` / `上游转写`。
没探测到的引擎会标「（未检测到）」且不可选。选中 SenseVoice 后会多出「识别语言」下拉
（auto / zh / en / yue / ja / ko）。

- **即时生效**：选中即切引擎，不用改配置、不用重启。
- **刷新保留**：选择存在浏览器 `localStorage`（key `xfv:v1:asr-preference`），覆盖
  `cordis.patch.yml` 的 `asr.engine`。想回到配置文件的值，选「自动」即可。
- **仍有降级**：手动选的引擎运行时失败（如网络不通）照样自动回退到其它可用引擎。
- **两个外部语音插件都不是前置条件**：它们即使完全卸载，内置后端照常工作。

### 8.2 内置后端的配置与排障

档位写在**插件配置**（`cordis.patch.yml` 的 `voice-assistant.config`），不再写 dsh-ears 段：

```yaml
asr:
  engine: auto          # auto / webspeech / ears(内置Whisper) / sensevoice(内置) / http
  local:
    enabled: true
    whisperModel: small # tiny / base / small / medium / large / turbo
    sensevoicePrecision: int8
    whisperLanguage: zh # 短片段自动语言检测必错，钉死中文
```

- 模型检查：`GET /plugins/dsh-voice-assistant/api/asr/status`——两项 `available` 都应为 true；
  `reason` 会明说 `missing` / `size:*` / `sha256-mismatch` / `native-runtime-missing`。
- 推理验证：`node tools/probe-local-asr.mjs`（不启 DSH）、
  `node tools/smoke-local-asr-http.mjs`（启 DSH 后）、
  `node tools/cdp-local-asr-probe.mjs`（真浏览器）。
- 换模型档位后重跑 `node tools/setup-asr.mjs --model <档位>`；下载器支持 `hf-mirror` 回退。
- 换平台时按 `vendor/README.md` 替换平台原生包；缺包时状态接口会明确报
  `native-runtime-missing`，不会静默不可用。

> **当前配置（2026-11-25，V2.1）**：识别基线仍是浏览器 Web Speech；受限网络下
> `asr-unreachable` → 死名单 → 自动切到内置 Whisper（本会话内不切回，避免抖动横跳）。
> 两条本地链都在本项目的子进程里跑，模型在 `.data/asr/`，与两个外部插件的安装状态无关。

---

## 9. 版本

`2.2.0` · MIT License · 详细变更与历史踩坑见 [README.md](./README.md)。
