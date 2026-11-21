# 「小凤」语音助手 —— 安装与使用说明

> 适用版本：**V1.9.0**（桌宠透明底 + 空闲隐藏 + 单个控制；V1.8 为专家与会话解耦 + 分层记忆）
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
| 网络 | 浏览器 Web Speech 识别依赖境外云端；受限网络下需自备识别后端（见第 8 节） |

插件**无 native 依赖、无运行时 npm 依赖**：`lib/client.js` 由 `build.mjs` 零依赖打成
classic script。

---

## 2. 安装

### 2.1 通用步骤（其他机器）

```sh
cd dsh-voice-assistant
node build.mjs                        # 生成 lib/client.js（首次必做）
dsh plugin --profile web add "$PWD"   # 把当前目录装进 web profile
```

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
      expertDirs:                       # 自定义专家目录（可选，追加不替换）
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

### 4.1 专家管理（V1.7，写文件 + 当场生效）

默认 4 位专家：`general`（小凤·通用，兜底）、`bioinfo`（小因·基因分析）、
`pathologist`（小理·病理分析）、`protein-designer`（小蛋·蛋白设计）。

- 语音：「列出专家」「新增专家 化学，负责化学分析」「删除专家 化学」
- HTTP（前缀 `/plugins/dsh-voice-assistant/api`）：
  - `GET /experts` 列出；`POST /experts` 新增；`DELETE /experts/<id>` 删除
- 也可以直接往 `expertDirs` 目录丢 JSON 专家定义，重启或热更新生效。
- 内置专家删除写 `{"disabled":true}` 墓碑；`general` 不可删。

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
#    期望：HTTP 200、version=1.9.0、ok=true、problems=[]
```

---

## 6. 目录结构（V1.8）

```
index.js                     插件入口：装配宿主半
cordis.patch.yml             增量配置（唤醒/识别/播报/轮次/专家/会话…）
build.mjs                    零依赖 ESM → classic script 打包器
lib/
  config.js  client.js      配置归一化 / 客户端注入
  router.js  delegation.js  意图路由 / 派单中枢（slot 复合键）
  workers.js  agent.js      专家 worker 建立 / agent 定义
  expert-registry.js        专家定义 CRUD + 校验 + 墓碑
  expert-manager.js         专家热生效（原地 splice）
  expert-sessions.js        会话注册表 + 跨会话记忆摘要（<expertDir>/_state/sessions.json）
  session-manager.js        会话管理中枢（HTTP 与语音命令共用）
  routes.js                 HTTP 路由（health/experts/sessions/delegate…）
  report.js  interactions.js 要点汇报队列 / 统一互动流
  skills.js                 专家技能注册
  avatars.js  activities.js 素材白名单路由 / 专家忙闲投影
src/client/                  客户端半（状态机/唤醒/采集/TTS/浮层 UI）
skills/somatic-mutation-report/  内置基因分析技能
assets/characters/           专家卡通素材（Q 版透明底 PNG）
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
| `dsh-ears` 插件 | DSH 生态成熟输入插件，8 个后端（本地 Whisper / 阿里云 / 腾讯云 / Groq 等） |
| `http` 自建端点 | 任意 OpenAI 兼容 `/audio/transcriptions`，在 `asr.http` 配置 baseURL/apiKey/model |

> 本机实测：本地 Whisper 的 `ggml-tiny.bin`（最小档）把中文短片段识别成英文/西语并
> 产生幻觉，质量明显不如浏览器识别，因此当前基线只走浏览器 Web Speech。要不要加
> `dsh-ears` 兜底，请按各自网络与识别质量实测决定。

---

## 9. 版本

`1.9.0` · MIT License · 详细变更与历史踩坑见 [README.md](./README.md)。
