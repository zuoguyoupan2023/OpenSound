# 001 · RTVI 协议子集接入规划（OpenSound 本地语音服务开放协议）

> 状态：**规划中**（本文档为设计稿，未开始编码）
> 背景来源：pipecat / LiveKit Agents 调研（对比详见对话记录；协议事实以官方文档为准，见 §七 待核实清单）
> 目标读者：OpenSound 开发者、未来接入 OpenSound 的第三方客户端开发者
> 一句话：**在现有多端口 REST 服务之上，新增一层标准化的 RTVI 实时语音协议端点，让 pipecat / LiveKit 等生态的现成客户端 SDK 能零改动直连 OpenSound 的本地语音引擎。**

---

## 一、为什么做 RTVI（背景）

**RTVI（Real-Time Voice Interface）** 是 2024 年由 **Daily（pipecat 维护方）、LiveKit、Vapi** 等公司组成的联盟共同推动的**开放协议**，用于标准化"语音 AI 客户端（浏览器/App）↔ 语音 AI 服务端（bot）"之间的实时双向通信：

- **传输**：WebSocket（JSON 消息 + 二进制音频帧）。
- **消息模型**：事件式（`client-ready` / `bot-ready` / `user-utterance` / `bot-utterance` / 说话状态事件 / TTS 事件）+ **Action 指令**（客户端向服务端发指令：打断、发 TTS、查配置、改配置）。
- **客户端生态**：`@pipecat-ai/client-js`、`@pipecat-ai/react-client`、pipecat iOS/Android SDK、LiveKit 客户端、Vapi 等**都实现了 RTVI 协议**——一个 RTVI 兼容的服务端，等于一次接入上述所有客户端。

**为什么 OpenSound 值得做**：pipecat 与 LiveKit Agents 是同一赛道互相竞争的两个最大开源语音 Agent 框架，但**都共同支持 RTVI**（协议互通）。OpenSound 目前是私有 REST API（SPEC.md），第三方要接入必须按我们的文档手写代码；实现 RTVI 子集后，**整个生态的现成客户端都能直接连 OpenSound 的本地引擎**——这是把"本地语音能力"开放给世界的钥匙。

---

## 二、现状盘点：OpenSound 已有的多端口对外服务

> 事实来源：`SPEC.md`（对外开放接口规范，唯一事实来源）+ `000-summary.md §三`。

### 2.1 端口与协议全貌

| 端口 | 服务 | 协议形态 | 对外性质 |
|---|---|---|---|
| **9528** | asr-server 主入口 | **HTTP REST**（`/transcribe` `/speak` `/chat` `/voice-chat` `/models` `/install-model` `/clone` `/voices` …）+ 帧流响应（`/speak` 返回 4B 长度 + WAV 的逐句流）+ NDJSON 进度流（`/install-model`） | 主要对外接口；本机免鉴权，开放局域网时 Token 鉴权 |
| **9527** | bridge（WS 终端桥接） | WebSocket（规划中，见 `000-voice-tauri-app规划.md`） | 扩展侧接入预留 |
| **8001** | qwen3-tts（Python） | HTTP（`/speak` 帧流） | 一般经 9528 转发，可直连 |
| **8002** | sensevoice-original（Python） | HTTP（`/transcribe` 等） | 一般经 9528 转发，可直连 |
| **8003** | cosyvoice-tts 克隆（Python） | HTTP（`/clone` `/speak` `/voices`） | 一般经 9528 转发，可直连 |

### 2.2 这些服务的能力边界（与 RTVI 的差距所在）

- **全部是"请求-响应"（一问一答）**：`POST /voice-chat` 一次请求完成"识别→LLM→朗读"，但整个过程是**同步阻塞的一次调用**，客户端拿不到中间事件（何时开始识别、何时开始说话、是否被打断）。
- **单向流**：`/speak` 的帧流是"服务器→客户端"的响应流，是**一次请求的产物**，不是双向持续对话。
- **无会话状态**：服务端不维护"这个连接是谁、在说什么、进行到哪"；对话历史由 GUI 侧（`conversation_store.rs`）管理。
- **无控制面**：客户端无法中途打断 TTS、无法查询/修改服务端配置（只能带参数发起新请求）。
- **无事件推送**：TTS 开始/结束、用户开始/停止说话等**状态事件**全部没有——客户端只能自己猜。

---

## 三、RTVI 协议子集设计（OpenSound 如何实现）

### 3.1 总体思路

**在 9528 之上新增 WS 端点，复用现有引擎，不动现有 REST 约定**（SPEC 承诺端口稳定）：

```
任意 RTVI 客户端（pipecat JS/React/iOS/Android、LiveKit、Vapi …）
        │  WebSocket（RTVI 协议子集）
        ▼
┌─ asr-server 新增 WS 端点（如 ws://127.0.0.1:9528/rtvi）─────────┐
│   RTVI 会话层：握手 / 消息解析 / 事件合成 / Action 分发            │
│   ┌──────────────────────────────────────────────────────────┐ │
│   │ 复用现有引擎（内部调用，不改动）：                          │ │
│   │  · VAD 切句       → 现有 /vad（funasr fsmn_vad）           │ │
│   │  · ASR            → 现有 /transcribe（sensevoice/whisper） │ │
│   │  · LLM            → 现有 /chat（llama-cpp / ollama）       │ │
│   │  · TTS            → 现有 /speak（kokoro / qwen3 / clone）  │ │
│   └──────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

### 3.2 传输与音频

| 项 | 设计 | 说明 |
|---|---|---|
| 端点 | `ws://127.0.0.1:9528/rtvi`（或独立端口，待定） | 与 REST 同源、同鉴权（本机免鉴权 / Token） |
| 消息格式 | JSON 文本帧（`{type, id?, session_id?, data?}`） | 与 RTVI 规范一致 |
| 音频上行 | **二进制 WS 帧**（16kHz 单声道 16-bit PCM，与现有 ASR 输入一致） | 客户端麦克风流直接进 VAD |
| 音频下行 | **二进制 WS 帧**（24kHz WAV 或 PCM，跟随引擎实际采样率；策略待定，见 §七） | 与现有 `/speak` 帧流采样率事实一致（kokoro/qwen3/cosyvoice 均 24k） |
| 会话 | **一个 WS 连接 = 一个会话**；服务端生成 `session_id` 并在 `bot-ready` 下发 | 轻量会话对象，内存态，断连即销毁 |

### 3.3 握手流程（子集）

```
客户端                                  服务端（OpenSound /rtvi）
  │  connect                                │
  │ ── {type:"client-ready"} ──────────────▶ │
  │ ◀── {type:"bot-ready", session_id} ──── │
  │ ◀── {type:"config", data:{services,     │  能力上报（可用引擎/采样率/是否克隆可用）
  │        config}} ──────────────────────  │
  │ ── {type:"action", data:{service:      │
  │      "rtvi", action:"describe-config"}}▶│  （可选，客户端主动再查）
  │ ◀── {type:"config", ...} ────────────── │
```

### 3.4 支持的消息子集

> ✅ **已用 pipecat 当前源码核实**（`src/pipecat/processors/frameworks/rtvi/models.py`，2026-04 main 分支，[源码链接](https://raw.githubusercontent.com/pipecat-ai/pipecat/main/src/pipecat/processors/frameworks/rtvi/models.py)）。
> 注意命名：**pipecat 当前实现已从 RTVI v0.1 旧名（`user-utterance`/`bot-utterance`）演进为新名**（`user-transcription`/`bot-output`/`bot-tts-audio`…）；OpenSound 子集以"能连上 `@pipecat-ai/client-js` 等真实客户端"为验收标准，故**跟随 pipecat 当前命名**，必要时兼容 v0.1 别名。

**客户端 → 服务端**

| 消息 | 用途 | OpenSound 落地 |
|---|---|---|
| `client-ready` | 客户端就绪 | 触发握手 |
| `action`（含 `interrupt` / `describe-config` / `update-config` / `send-text`） | 指令（见下） | 分发到对应引擎/会话逻辑 |
| `ping` | 保活 | 回 `pong` |
| （上行音频） | 麦克风流 | 进 VAD/ASR（承载方式待实测，见 §七） |

**服务端 → 客户端（子集 = 标 ✅ 的项，其余为可选增强）**

| 消息 | 用途 | OpenSound 落地 | 子集 |
|---|---|---|---|
| `bot-ready` | bot 就绪（含 `session_id`） | 握手完成 | ✅ |
| `config`（`server-response`） | 能力/配置上报 | 由 `/health` 数据生成（引擎就绪状态映射） | ✅ |
| `user-transcription` | 用户识别文本（分 `final`/中间态） | `/transcribe` 结果 | ✅ |
| `user-started-speaking` / `user-stopped-speaking` | 用户说话状态 | VAD 事件（现有 `/vad` 能力） | ✅ |
| `bot-started-speaking` / `bot-stopped-speaking` | bot 说话状态 | TTS 首帧/末帧事件 | ✅ |
| `bot-llm-started` / `bot-llm-stopped` | LLM 生命周期 | `/chat` 起止 | ✅ |
| `bot-tts-started` / `bot-tts-stopped` | TTS 生命周期 | 逐句 TTS 时触发 | ✅ |
| `bot-output` | bot 最终输出文本 | `/chat` 结果 | ✅ |
| `bot-tts-audio` | **TTS 音频下行** | `/speak` 帧流 → 消息化 | ✅ |
| `bot-tts-text` / `bot-llm-text` | TTS 句文本 / LLM 原文 | 调试/字幕用 | 可选 |
| `bot-transcription` / `user-llm-text` | bot 侧转写 / 用户送 LLM 的文本 | — | 可选 |
| `vad-user-started-speaking` / `vad-user-stopped-speaking` | VAD 级说话事件（早于 ASR 结果） | 现有 `/vad` | 可选 |
| `user-mute-started` / `user-mute-stopped` | 静音状态 | — | 可选 |
| `bot-interrupted` | bot 被打断事件 | `interrupt` 后的确认 | 可选 |
| `metrics` / `user-audio-level` / `bot-audio-level` | 指标 / 音量级 | 调试用 | 可选 |
| `system-log` | 服务端日志 | 调试用 | 可选 |
| `error` / `error-response` | 错误上报 | 复用现有错误语义（400/500 映射） | ✅ |
| `llm-function-call` 系列 | 函数调用 | 与本地 LLM 工具调用对接（远期） | 可选 |

**Action 子集（`action` 消息的 `data.action`，pipecat processor 已确认 `interrupt_bot` 与配置管理）**

| action | 用途 | OpenSound 落地 |
|---|---|---|
| `describe-config` | 查询 bot 能力 | 回 `config` 消息 |
| `update-config` | 修改配置（如换 TTS 音色/引擎） | 阶段 3 再支持 |
| `send-text` / `send-tts-text` | 让 bot 直接说一段话（不经过 LLM） | 调 `/speak`（可指定引擎/音色） |
| `interrupt` | 打断当前 TTS/对话 | 中止当前 `/speak` 帧流 + 清空待播队列 + 发 `bot-interrupted` |

### 3.5 全双工与打断（核心难点，分两阶段落地）

- **现状基础**：T3 已完成"前端 VAD 切句 → 逐句 `/transcribe`"（`ui/src/realtime.ts`），但驱动方在前端，且是"句 → 句"顺序。
- **RTVI 子集目标**：把驱动方移到**服务端会话层**——上行音频持续进 VAD，识别出句子 → LLM → TTS → 下行；TTS 播放期间若 VAD 再次检测到人声 → 触发 `interrupt`（这是 pipecat/LiveKit 的 barge-in 机制）。
- **阶段划分**（详见 §六）：阶段 1 先做"半双工一问一答"（握手 + 文本 + 单句音频），阶段 2 再做"真全双工 + 打断"。

---

## 四、好处（为什么值得做）

1. **白拿整个客户端生态**：pipecat 的 JS / React / iOS / Android SDK、LiveKit 客户端、Vapi 等 RTVI 客户端**零改动直连** OpenSound 本地引擎——从"一个私有插件（Tabu-AI）"变成"全生态通用"。
2. **业界稀缺的"本地 RTVI 服务端"**：现网 RTVI 服务端几乎都是云端 bot（要 API Key、要出网）；OpenSound 是**本地、隐私、免费、离线可用**的 RTVI 服务端，差异化明显。
3. **标准化接入**：网站/插件/小程序/手机 App 走同一协议，第三方无需读 SPEC 手写对接层；协议文档由 RTVI 联盟维护，我们不用自造。
4. **全双工体验升级**：事件式协议天然支持"边说边听、可打断"，把现有"句→句"实时语音升级为真对话。
5. **未来可迁移**：同一套 RTVI 服务端逻辑以后可原样部署到云端（引擎换成云端 API），协议层零改动——本地版、云端版同构。
6. **可复用官方调试工具**：pipecat / LiveKit 的 Agents Playground 可直接连我们的服务端做调试与演示。

---

## 五、与现有多端口服务的区别（重点）

| 维度 | 现有多端口（9528 REST / 8001–8003） | RTVI 子集（新增 WS /rtvi） |
|---|---|---|
| **协议形态** | HTTP **请求-响应**（一问一答、无状态） | WebSocket **双向事件流**（长连接、有状态） |
| **通信方向** | 客户端发起 → 服务端返回（唯一方向） | **双向**：音频上行 + 文本/音频下行 + 事件 + 指令 |
| **状态** | 服务端无会话概念（历史在 GUI 侧） | **每连接一个会话**（`session_id`），会话内状态连续 |
| **事件推送** | 无（客户端无法知道 TTS 何时开始/结束、用户何时说话） | 完整状态事件（`bot-started-speaking` / `tts-stopped` …） |
| **控制面** | 无（只能带参发新请求） | Action 指令（`interrupt` 打断、`send-tts-text`、`describe-config`） |
| **流式** | `/speak` 帧流是**单向响应流**（一次请求的产物） | **持续双向流**：麦克风持续上行、bot 持续下行，边听边说 |
| **接入成本** | 第三方须读 SPEC 手写 HTTP 对接 + 自己实现播放/录音/状态机 | **现成客户端 SDK 直接用**（生态标准） |
| **能力协商** | `/health` 探测 + 文档约定 | `config` 消息结构化协商，可 `update-config` 动态改 |
| **适用场景** | 一次性调用：识别一句话、朗读一段文本、完成一轮对话 | 实时连续对话：语音助手、陪练、实时翻译、数字人 |

> **结论：不是替代，是叠加。** RTVI 端点复用现有引擎（内部仍调 `/transcribe` `/chat` `/speak`），不改变 9528 REST 语义（SPEC 兼容承诺不变）；RTVI 是加在 REST 之上的一层"**实时会话门面协议**"。

---

## 六、实施阶段（分阶段，每阶段可独立验收）

| 阶段 | 内容 | 验收标准（用户可见可用） |
|---|---|---|
| **P1 · 最小子集（半双工）** | WS `/rtvi` 端点 + 握手（`client-ready`/`bot-ready`/`config`）+ 文本问答（`user-utterance`/`bot-utterance`）+ `describe-config` + `send-tts-text` + `error` + 单句音频上行下行（二进制帧） | `@pipecat-ai/client-js` 最小示例连上：发一句话 → 收到识别文本 + bot 文本 → 收到 TTS 音频并播放（本地引擎发声） |
| **P2 · 全双工 + 打断** | 持续上行音频 + 服务端 VAD 切句（复用 `/vad`）+ `interrupt` action（中止 TTS + 清队列）+ `bot-started/stopped-speaking`、`tts-started/stopped` 事件 | pipecat React 客户端：边说边答；说话打断 bot 立即停止；多轮连续对话不掉线 |
| **P3 · 能力完整化** | `update-config`（换引擎/音色/语速）+ 克隆音色接入（`voice` 参数映射 `/voices`）+ 多会话并发（内存会话池）+ 鉴权（复用 Token）+ 官方 JS/React 示例入库 | 手机/浏览器/桌面三端客户端同时连同一台 OpenSound 各自对话互不干扰；克隆音色可直接被 RTVI 客户端选用 |

> 遵守项目铁律：每阶段完成后先让用户看到、能连、能用，再进下一阶段；不铺开一次性大改。

---

## 七、风险与待核实清单（铁律 B：不猜测）

> ✅ 已核实（2026-04，网络恢复后）：pipecat 当前 RTVI 消息全集与 action（`rtvi/models.py` + `rtvi/processor.py` 源码，见附参考）；pipecat 仓库状态（15k★ / Python / MIT / Daily 维护）。

1. **RTVI v0.1 规范原文**：docs.rtvi.ai 仍不可达（网络受限）；当前以 **pipecat 源码实现为准**（客户端 SDK 的对接对象就是它）。实施 P1 前若需 v0.1 规范原文，可在能联网环境再核对 docs.rtvi.ai。
2. **客户端兼容性实测**：`@pipecat-ai/client-js` 对服务端的握手时序、`config` 结构、**音频承载方式（`bot-tts-audio` 消息内 base64 vs 独立二进制帧）**有具体预期——必须以真实客户端连上为准（不能只做服务端自测）。
3. **采样率策略待定**：上行 16k（与 ASR 一致）无争议；下行 24k（引擎实际采样率）是否需要统一转 16k / 由 `config` 上报——待 P1 实测后定。
4. **单机并发上限**：M4/16GB 上多会话并发会互相争抢 GPU/内存；P3 需定并发上限与排队策略。
5. **`/realtime` 与 9527 bridge 的关系**：SPEC 中 `WS /realtime`（未来）与本文 `/rtvi` 是否合一（建议合一：`/rtvi` 即实时语音通道，避免两套 WS 协议并存）——需与既有规划（`000-voice-tauri-app规划.md` 的 bridge）对齐后定稿。

---

## 附：参考来源

- [RTVI 官方文档（Messages / Actions / Callbacks）](https://docs.rtvi.ai/api-reference/messages)（本机网络受限时不可达，以 pipecat 源码为准）
- [pipecat RTVI 消息模型源码（models.py，已核实）](https://raw.githubusercontent.com/pipecat-ai/pipecat/main/src/pipecat/processors/frameworks/rtvi/models.py)
- [pipecat RTVI 处理器源码（processor.py，含 interrupt/config 管理）](https://raw.githubusercontent.com/pipecat-ai/pipecat/main/src/pipecat/processors/frameworks/rtvi/processor.py)
- [pipecat-client-web RTVI 协议说明（DeepWiki）](https://deepwiki.com/pipecat-ai/pipecat-client-web/2.4-rtvi-protocol)
- [LiveKit Agents 官方对比 Pipecat](https://livekit.net.cn/field-guides/guide/livekit-vs-pipecat)
- [OpenSound SPEC.md（现状接口事实来源）](SPEC.md)
- [OpenSound 000-summary.md §三（能力矩阵）](000-summary.md)
