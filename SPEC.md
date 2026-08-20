# SPEC · Tabu-Local 对外开放接口规范

> **Tabu-Local** 是一个**点开即用的本地语音服务桌面 App**：识别（ASR）、朗读（TTS）、对话（LLM）全本机运行，并作为**开放端口后端**供任意网站 / 浏览器插件 / 其它 App / 命令行终端接入。
>
> 本文档是**对外唯一事实来源**。目标读者：想接入本地识别/朗读/对话能力的任意开发者。
>
> 配套文档：`GUIDE.md`（现状接口调用）、`000-backend.md`（启动手册）。当前端口默认 `http://127.0.0.1:9528`。

---

## 一、连接与鉴权

### 1.1 默认地址
| 项 | 值 |
|---|---|
| 主入口（Base URL） | `http://127.0.0.1:9528` |
| 可选 qwen3-tts | `http://127.0.0.1:8001`（一般经 9528 转发，无需直连）|
| bridge（WS 终端桥接） | `http://127.0.0.1:9527` |

默认绑定 `127.0.0.1`，**仅本机可访问，本机默认免鉴权**（Tabu-AI 等本机接入零配置）。

### 1.2 鉴权（Token，可选）
- 本机访问：**免鉴权**。
- 开放局域网时：绑定 `0.0.0.0` + Token 鉴权。携带方式：

```
Authorization: Bearer <token>
```

### 1.3 CORS
- 允许任意来源跨域访问（`Access-Control-Allow-Origin: *`），供网站/浏览器插件接入。
- 支持 `GET / POST / OPTIONS`，预检请求自动放行。

### 1.4 错误码表
| 状态码 | 含义 |
|---|---|
| `200` | 成功 |
| `400` | 请求体/参数错误（响应含 `{error}`）|
| `404` | 路径不存在 |
| `409` | 资源冲突（如已有安装任务进行中）|
| `500` | 服务端推理错误 |

错误响应统一：`{ "error": "<原因>" }`。

---

## 二、端点总览

| 方法 / 路径 | 作用 | 返回 |
|---|---|---|
| `GET /health` | 服务状态 + 引擎 + 模型清单 | JSON |
| `POST /transcribe` | 语音 → 文本（ASR） | `{ text, engine }` |
| `POST /speak` | 文本 → 语音（TTS，含克隆引擎） | **帧流**（octet-stream）|
| `POST /chat` | 文本 → LLM 回答 | `{ text, engine }` |
| `POST /voice-chat` | 语音 → LLM → 语音（一次完成）| WAV 或 `{recognized,answer,audioBase64}` |
| `GET /models` | 模型清单与安装状态 | `{ models }` |
| `POST /install-model` | 安装模型 | NDJSON 进度流 |
| **`POST /clone`** | 创建克隆音色（参考音频+文本） | `{ voiceId, name, … }` |
| **`GET /voices`** | 列出克隆音色 | `{ voices: [...] }` |
| **`POST /voice/rename`** | 克隆音色改名 | `{ ok }` |
| **`POST /voice/delete`** | 删除克隆音色 | `{ ok }` |
| **`GET /voice-preview`** | 取某音色预生成试听音频 | WAV |
| `WS /realtime`（未来） | 实时语音 | — |

---

## 三、端点详解

### 3.1 健康检查 + 能力上报 `GET /health`

```bash
curl -s http://127.0.0.1:9528/health | python3 -m json.tool
```

响应结构（`tts` / `asr` / `llm` / `models` 四维能力）：

```json
{
  "ok": true,
  "engines": ["whisper", "sensevoice"],
  "tts": {
    "kokoro": "ready",          // ready | missing | not-installed
    "kokoroSpeakers": 53,
    "qwen3": "reachable",       // reachable | unreachable
    "cosyvoice": "reachable"    // 克隆服务：reachable | missing
  },
  "llm": {
    "engine": "llama-cpp",
    "model": "qwen2.5-0.5b-instruct-q4_k_m.gguf",
    "ollama": "unreachable"
  },
  "models": [ { "category": "tts", "engine": "kokoro", "label": "…", "size": "~350MB", "installed": true } ],
  "port": 9528
}
```

> 客户端据此判断各引擎就绪状态，做**能力路由与自动回退**（本地不可达 → 云端 → 系统）。

### 3.2 识别 ASR `POST /transcribe?engine=…`

请求体 = **WAV 或 RAW PCM（16kHz 单声道）**，`Content-Type: audio/wav`。

```bash
curl -s -X POST 'http://127.0.0.1:9528/transcribe?engine=auto' \
  -H 'Content-Type: audio/wav' --data-binary @in.wav
```

参数：
| 参数 | 值 | 说明 |
|---|---|---|
| `engine` | `auto`（默认）/ `sensevoice` / `whisper` | auto = SenseVoice 优先 |

响应：
```json
{ "text": "你好，今天天气不错。", "engine": "sensevoice", "durationSec": 2.1, "rms": 0.35 }
```

> 注意：`engine=sensevoice` 但模型未下载时返回 400 并提示运行下载。

### 3.3 朗读 TTS `POST /speak?engine=…`

请求体 = JSON；**返回帧流**（`application/octet-stream`），每帧 = 4 字节大端长度 + 一段 WAV，逐句流式，首帧 ≈ 首句合成时间。

#### kokoro（CPU 轻量，sid 0-52，中文试 48-52）
```bash
curl -sN -X POST 'http://127.0.0.1:9528/speak?engine=kokoro' \
  -H 'Content-Type: application/json' \
  -d '{"text":"你好，欢迎使用本地语音助手。今天天气不错。","sid":18,"speed":1}'
```

#### qwen3（MPS 流式，voice 预设：Vivian/Serena/Uncle_Fu/Dylan/Eric/Ryan/Aiden/Ono_Anna/Sohee）
```bash
curl -sN -X POST 'http://127.0.0.1:9528/speak?engine=qwen3' \
  -H 'Content-Type: application/json' \
  -d '{"text":"你好，欢迎使用本地语音助手。","voice":"Vivian","language":"Auto"}'
```

#### 多角色朗读（qwen3）
文本含「角色名：内容」行时自动按角色分音色：
```bash
curl -sN -X POST 'http://127.0.0.1:9528/speak?engine=qwen3' \
  -H 'Content-Type: application/json' \
  -d '{"text":"小明：你好呀。\n小红：是啊。","voice":"Vivian","language":"Auto","roles":"auto"}'
```
- `roles=auto`（默认，≥2 角色触发）/ `on` / `off`；`roleMap: {角色名:音色名}` 显式映射。

#### 云端 TTS（OpenAI 兼容 /v1/audio/speech）
```bash
curl -sN -X POST 'http://127.0.0.1:9528/speak?engine=cloud' \
  -H 'Content-Type: application/json' \
  -d '{"text":"你好，这是云端朗读。","cloud":{"baseUrl":"https://api.openai.com/v1","apiKey":"sk-…","model":"tts-1","voice":"alloy"}}'
```

#### 克隆音色（CosyVoice3 本地，engine=clone）
先用 `/clone` 创建音色得到 `voiceId`，再朗读：
```bash
curl -sN -X POST 'http://127.0.0.1:9528/speak?engine=clone' \
  -H 'Content-Type: application/json' \
  -d '{"text":"你好，这是克隆音色的朗读。","voice":"cv_xxxxxxxxxx"}'
```
- `voice` = `/clone` 或 `/voices` 返回的 `voiceId`（必填）。

#### 请求体字段
| 字段 | 类型 | 说明 |
|---|---|---|
| `text` | string | **必填**；qwen3 ≤2000 字，kokoro ≤30000 字 |
| `sid` | int | kokoro 音色 0-52 |
| `speed` | float | kokoro 语速 0.5-2 |
| `voice` / `language` | string | qwen3 音色 / 语言（Auto/zh/en）；`engine=clone` 时 `voice`=克隆音色 id |
| `roles` / `roleMap` | string/object | 多角色（qwen3）|
| `cloud` / `azure` / `cosyvoice` | object | 云端引擎凭据 |

#### 帧流协议（关键！）
```
[4字节大端长度][WAV数据][4字节大端长度][WAV数据]...
```
- 每个 WAV 帧独立完整（含 RIFF 头）。
- 客户端按"读 4 字节 → 取整帧 → 播放"解析，逐帧顺序播放。

### 3.4 对话 LLM `POST /chat`

```bash
curl -s -X POST 'http://127.0.0.1:9528/chat' \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"用一句话介绍你自己"}],"engine":"llama-cpp"}'
```

请求体：
| 字段 | 类型 | 说明 |
|---|---|---|
| `messages` | array | `[{role: system/user/assistant, content}]`，**必含 user 消息** |
| `engine` | string | `llama-cpp`（默认）/ `ollama` |
| `temperature` / `top_p` / `maxTokens` / `model` | 可选 | LLM 采样参数 |

响应：
```json
{ "text": "我叫李华。", "engine": "llama-cpp" }
```

### 3.5 全链路 `POST /voice-chat`

请求体 = WAV 音频；识别 → LLM → 朗读 一次完成。

```bash
curl -s -X POST 'http://127.0.0.1:9528/voice-chat?ttsEngine=kokoro&llmEngine=llama-cpp&fmt=json' \
  -H 'Content-Type: audio/wav' --data-binary @in.wav
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `asrEngine` | auto | auto/sensevoice/whisper |
| `llmEngine` | llama-cpp | llama-cpp/ollama |
| `ttsEngine` | kokoro | kokoro / qwen3 / clone（克隆音色，`voice`=音色id） |
| `prompt` | — | 追加指令 |
| `system` | 默认助手提示词 | 系统提示 |
| `fmt` | — | `json` 时返回 文本+音频 base64 |
| `sid` / `voice` / `language` | — | TTS 参数 |

- `fmt=json` → `{ "recognized": "…", "answer": "…", "engine": "kokoro", "audioBase64": "…" }`
- 不带 `fmt=json` → 直接返回整段 WAV 二进制。

> qwen3 不可达时自动回退 kokoro，保证全链路始终可用。

### 3.6 模型清单 `GET /models`

```bash
curl -s http://127.0.0.1:9528/models
```

响应：
```json
{ "models": [ { "category": "asr", "engine": "sensevoice", "label": "SenseVoice…", "size": "~228MB", "installed": true } ] }
```

### 3.7 模型安装 `POST /install-model?engine=…`

```bash
curl -sN -X POST 'http://127.0.0.1:9528/install-model?engine=kokoro'
```

- 支持引擎：`kokoro` / `sensevoice` / `llm` / `qwen3` / `whisper`。
- 返回 **NDJSON 进度流**，每行 `{type:'log'|'done'|'error', message}`，逐行可解析进度：

```
{"type":"log","message":"下载中…"}
{"type":"done","message":"安装完成"}
```

---

### 3.8 克隆音色管理（CosyVoice3 本地）

本地语音克隆：`POST /clone` 用参考音频 + 参考文本生成一个克隆音色，随后 `engine=clone` 朗读/对话即可用它发声。

#### 创建克隆音色 `POST /clone`
请求体 = JSON，`wavBase64` 为参考音频（**16kHz 单声道 WAV 的 base64**；建议 3–10s、清晰单人声）：
```bash
curl -s -X POST 'http://127.0.0.1:9528/clone' \
  -H 'Content-Type: application/json' \
  -d '{"name":"我的声音","referenceText":"这句话是参考录音的内容。","wavBase64":"<base64>"}'
```
响应：
```json
{ "voiceId": "cv_xxx", "name": "我的声音", "referenceText": "You are a helpful assistant.<|endofprompt|>这句话是…", "created_at": 1787, "engine": "cosyvoice" }
```
- 后端会自动为 `referenceText` 补 `<|endofprompt|>` 前缀（CosyVoice3 必需）。
- 生成时会顺带预生成一段试听音频（`preview.wav`），试听秒开。

#### 列出克隆音色 `GET /voices`
```bash
curl -s http://127.0.0.1:9528/voices
# → { "voices": [ { "voiceId":"cv_xxx", "name":"…", "referenceText":"…", "created_at":…, "engine":"cosyvoice" } ] }
```

#### 改名 / 删除 `POST /voice/rename` · `POST /voice/delete`
```bash
curl -s -X POST 'http://127.0.0.1:9528/voice/rename' -H 'Content-Type: application/json' \
  -d '{"voiceId":"cv_xxx","name":"新名字"}'
curl -s -X POST 'http://127.0.0.1:9528/voice/delete' -H 'Content-Type: application/json' \
  -d '{"voiceId":"cv_xxx"}'
```

#### 试听 `GET /voice-preview?voiceId=…`
返回该音色**预生成的 WAV**（非帧流，可直接播放）：
```bash
curl -s 'http://127.0.0.1:9528/voice-preview?voiceId=cv_xxx' -o preview.wav
```
- 若该音色无 preview（老数据）返回 404 `{error}`。

> 端口 8003 为 cosyvoice 独立服务，一般经 9528 转发，无需直连。

---

## 四、音频约定

| 项 | 约定 |
|---|---|
| 输入（ASR / voice-chat） | WAV 或 RAW PCM，**16kHz 单声道 16-bit** |
| 输出（TTS） | 帧流：每帧 = 4B 大端长度 + 独立 WAV；采样率 kokoro/qwen3/cosyvoice 均 24000 |
| 克隆参考音频 | `/clone` 的 `wavBase64` = 16kHz 单声道 WAV；试听 `/voice-preview` 返回 24000 WAV |
| 内容类型 | 输入 `audio/wav`；TTS 输出 `application/octet-stream` |

---

## 五、快速接入示例

### curl（见上文各端点）

### fetch（JavaScript / 浏览器）

```js
// 识别
const wav = new Blob([pcmBytes], { type: "audio/wav" });
const r = await fetch("http://127.0.0.1:9528/transcribe?engine=auto", {
  method: "POST",
  headers: { "Content-Type": "audio/wav" },
  body: wav,
});
const { text } = await r.json();

// 朗读（帧流解析）
const res = await fetch("http://127.0.0.1:9528/speak?engine=kokoro", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ text: "你好", sid: 18 }),
});
const buf = await res.arrayBuffer();
// 逐帧：4 字节大端长度 + WAV

// 对话
const chat = await fetch("http://127.0.0.1:9528/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: "1+1=?" }] }),
});
```

### Python

```python
import requests, json

# 识别
wav = open("in.wav", "rb").read()
r = requests.post("http://127.0.0.1:9528/transcribe?engine=auto",
                  data=wav, headers={"Content-Type": "audio/wav"})
print(r.json()["text"])

# 对话
r = requests.post("http://127.0.0.1:9528/chat", json={
    "messages": [{"role": "user", "content": "你好"}],
})
print(r.json()["text"])
```

### 微信小程序（简略）

```js
wx.request({
  url: 'http://127.0.0.1:9528/chat',
  method: 'POST',
  data: { messages: [{ role: 'user', content: '你好' }] },
  success: (res) => console.log(res.data.text)
});
```

---

## 六、变更与维护

- 端口约定保持稳定，仅新增能力不改既有端点。
- 能力/模型变化 → 同步更新本文档、`GUIDE.md`、`asr-server/README.md`。
- 本文档 = 对外事实来源；`GUIDE.md` = 现状接口调用；`000-backend.md` = 启动手册。
