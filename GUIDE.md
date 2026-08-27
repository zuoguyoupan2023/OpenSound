# OpenSound 本地能力服务 · 调用指南

> 📌 **命名说明**：本目录当前为 `OpenSound/`，但**严格应称 `OpenSound`**——它不仅提供"语音"（TTS / ASR），还提供 **LLM**（`/chat`、`/voice-chat`）。"Voice" 会漏掉 LLM 让人误解。改名随桌面应用阶段推进（见 `crazycodecat2/015` 规划）。
>
> 📖 **本文档 = 如何调用当前端口**。能力变化时随改随更新，让 OpenSound 既可独立使用，也可作为 浏览器扩展 / 网站 / 其他 app 的后端。

---

## 一、它是什么

本地模型能力服务：把 **朗读(TTS) / 识别(ASR) / 对话(LLM)** 三类本地模型封装成 HTTP 端口。

- **独立可用**：不装插件，curl / 其他程序直接调用。
- **作为后端**：Tabu-AI 插件、未来桌面应用、网站、其他 app 都走这套 HTTP 端口。

能力矩阵（对应 015 规划 §一 的"本地"列）：

| 维度 | 引擎 | 模型 |
|---|---|---|
| 朗读 TTS | kokoro（默认）/ qwen3 | sherpa-onnx 原生 / Qwen3-0.6B |
| 识别 ASR | sensevoice（中文优先）/ whisper（兜底） | sherpa-onnx / transformers.js |
| 对话 LLM | llama-cpp（内嵌默认）/ ollama（后备） | GGUF（默认 qwen2.5-0.5B）/ 转发 11434 |

---

## 二、快速启动

```bash
cd /Users/burenweiye/Documents/GitHub/OpenSound/asr-server
npm install            # 首次（含 sherpa-onnx 原生绑定）
npm run all            # 一键起 asr-server(9528) + qwen3(8001)，幂等（已在跑自动跳过）
```

| 端口 | 进程 | 说明 |
|---|---|---|
| **9528** | asr-server（node） | **统一入口**：ASR / TTS / LLM / 全链路 / 模型管理 |
| **8001** | qwen3-tts（python） | Qwen3-TTS 推理（通常经 9528 转发，一般无需直连） |

> 国内模型下载：`HF_ENDPOINT=https://hf-mirror.com npm run all`。

---

## 三、接口总览（9528）

| 方法/路径 | 作用 | 返回 |
|---|---|---|
| `GET /health` | 服务状态 + 引擎 + 模型清单 | JSON |
| `POST /transcribe?engine=sensevoice\|whisper\|auto` | 语音识别（body = WAV/RAW PCM） | `{ text, engine }` |
| `POST /speak?engine=kokoro\|qwen3` | 朗读（body = JSON） | **帧流** octet-stream（逐句，每帧=4B大端长度+WAV） |
| `POST /chat` | 本地 LLM 对话 | `{ text, engine }` |
| `POST /voice-chat?...` | 识别→LLM→朗读 全链路（body = WAV） | WAV / `{recognized,answer,audioBase64}` |
| `GET /models` | 模型清单与安装状态 | `{ models: [...] }` |
| `POST /install-model?engine=...` | 安装模型 | NDJSON 进度流 |

---

## 四、各接口调用示例

### 1) 健康检查 + 能力上报
```bash
curl -s http://127.0.0.1:9528/health | python3 -m json.tool
# tts.kokoro / tts.qwen3 / llm / models → 各引擎与模型就绪状态
```

### 2) 朗读 TTS（帧流，逐句，边播边出）
```bash
# kokoro（CPU 轻量，sid 0-52，中文试 48-52）
curl -sN -X POST 'http://127.0.0.1:9528/speak?engine=kokoro' \
  -H 'Content-Type: application/json' \
  -d '{"text":"你好，欢迎使用本地语音助手。今天天气不错。","sid":18,"speed":1}' \
  -o /tmp/tts.bin
# 返回帧流：每帧 = 4 字节大端长度 + 一段 WAV（解析见 Tabu-AI sidepanel forEachSpeakFrame）

# qwen3（MPS 流式，voice 预设：Vivian/Serena/Uncle_Fu/Dylan/Eric/Ryan/Aiden/Ono_Anna/Sohee）
curl -sN -X POST 'http://127.0.0.1:9528/speak?engine=qwen3' \
  -H 'Content-Type: application/json' \
  -d '{"text":"你好，欢迎使用本地语音助手。","voice":"Vivian","language":"Auto"}'

# 多角色朗读（015 §五 / 014 §七 A 路线）：文本含「角色名：内容」行时自动按角色分音色
#   roles=auto（默认）：≥2 角色自动启用；roles=on 强制；roles=off 关闭；roleMap 可显式指定角色→音色
curl -sN -X POST 'http://127.0.0.1:9528/speak?engine=qwen3' \
  -H 'Content-Type: application/json' \
  -d '{"text":"小明：你好呀，今天天气不错。\n小红：是啊，适合去公园走走。","voice":"Vivian","language":"Auto","roles":"auto"}'
#   → 小明用 Vivian、小红用 Serena（角色按出现顺序轮转 9 个预设音色）；可 roleMap 指定：
#     {"text":"老板：把方案发我。\n助理：好的。","roles":"on","roleMap":{"老板":"Uncle_Fu","助理":"Sohee"}}

# 云端 TTS（🌐 OpenAI 兼容 /audio/speech）：逐句调用 → 帧流，首帧 ≈ 首句云端 TTFB（100-500ms）
curl -sN -X POST 'http://127.0.0.1:9528/speak?engine=cloud' \
  -H 'Content-Type: application/json' \
  -d '{"text":"你好，这是云端朗读。第二句。","cloud":{"baseUrl":"https://api.openai.com/v1","apiKey":"sk-…","model":"tts-1","voice":"alloy"}}'
```

### 3) 识别 ASR
```bash
# body = WAV/RAW PCM 16kHz 单声道；engine 默认 auto（SenseVoice 优先，中文最优）
curl -s -X POST 'http://127.0.0.1:9528/transcribe?engine=auto' \
  -H 'Content-Type: audio/wav' --data-binary @in.wav
# → {"text":"...","engine":"sensevoice",...}
```

### 4) 对话 LLM
```bash
curl -s -X POST 'http://127.0.0.1:9528/chat' \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"用一句话介绍你自己"}],"engine":"llama-cpp"}'
# → {"text":"...","engine":"llama-cpp"}   （ollama 后备：engine=ollama）
```

### 5) 全链路：语音 → 识别 → LLM → 朗读（一次完成）
```bash
curl -s -X POST 'http://127.0.0.1:9528/voice-chat?ttsEngine=kokoro&llmEngine=llama-cpp&fmt=json' \
  -H 'Content-Type: audio/wav' --data-binary @in.wav
# fmt=json → {"recognized":"...","answer":"...","audioBase64":"..."}  识别文本 + 回答 + 音频
# 不带 fmt=json → 直接返回整段 WAV
```

### 6) 模型管理与安装
```bash
curl -s http://127.0.0.1:9528/models        # 模型清单 + installed 状态
curl -sN -X POST 'http://127.0.0.1:9528/install-model?engine=kokoro'
# → NDJSON 进度流：{"type":"log","message":"..."} ... {"type":"done","message":"安装完成"}
# 支持引擎：kokoro / sensevoice / llm / qwen3（首次启动自动下载）/ whisper（首次识别自动下载）
```

---

## 五、独立使用示例（不装插件）

```bash
# 一段"说 → 听 → 回"的最小闭环（本地全离线）
# 1) 朗读：文字 → 音频
curl -sN -X POST 'http://127.0.0.1:9528/speak?engine=kokoro' \
  -H 'Content-Type: application/json' -d '{"text":"你好，我是本地语音助手。"}' -o /tmp/hello.bin
# 2) 识别：把音频送回来 → 文本
curl -s -X POST 'http://127.0.0.1:9528/transcribe?engine=auto' \
  -H 'Content-Type: audio/wav' --data-binary @/tmp/hello.wav
# 3) 对话：文本 → LLM 回答
curl -s -X POST 'http://127.0.0.1:9528/chat' \
  -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"1+1等于几"}]}'
```

---

## 六、Tabu-AI 插件如何用它（分工速览）

| 能力 | Tabu-AI 走本地（OpenSound） | 走 API / 浏览器 |
|---|---|---|
| 朗读 | 引擎下拉选 kokoro / qwen3 → `POST /speak` | 系统 `chrome.tts`（即时兜底）/ 云端 API |
| 识别 | 后端选「💻 本地服务」→ `POST /transcribe` | azure / openai / aliyun |
| 对话 | `/chat`（llama-cpp / ollama） | ai-api.js 多供应商 |
| 全链路 | 语音工作台 → `/voice-chat` | — |

> 自动回退：本地不可达时朗读已回退浏览器系统 TTS；工作台自动朗读固定系统 TTS（即时）。

---

## 七、维护约定

- **能力变化 → 更新本指南**（端口、参数、示例），同时同步 `asr-server/README.md` 与 `crazycodecat2/015`。
- 阶段二桌面应用（GUI）推进后：**端口保持稳定**，只加 GUI 层与鉴权；本指南继续作为接口事实来源。
- 命名：当前目录 `OpenSound/`，正式名 **OpenSound**（见 015 规划 §〇）。
