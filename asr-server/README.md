# TabU 本地语音服务（asr-server）

在**电脑本地**跑语音模型（隐私优先、离线可用、中文友好），TabU 侧边栏通过 HTTP 调用。
同时提供 **ASR（语音识别）** 与 **TTS（本地朗读）**，是「识别 → 朗读」闭环的本地基础。

## 快速开始（中文用户推荐）

```bash
cd asr-server
npm install
npm run download-sensevoice   # 下载 SenseVoice 中文识别模型（~228MB，中文识别最优）
npm run download-kokoro       # 下载 Kokoro 中英混合 TTS 模型（~350MB，本地朗读）
npm run download-llm          # 下载 LLM 小模型（Qwen2.5-0.5B Q4 ~469MB，/chat 用，可 LLM_MODEL 换大模型）
npm run all                   # 一键启动 asr-server(9528) + qwen3-tts(8001)，幂等（已在跑的自动跳过）
```

> ⚠️ whisper-tiny 对中文几乎不可用（严重幻觉）。本服务**默认自动选 SenseVoice**（中文/粤/日/韩 最优）；未下载 SenseVoice 时回退 whisper（默认 base）。
> TTS 默认引擎 **Kokoro**（sherpa-onnx 原生，CPU 可跑）；**Qwen3-TTS** 可选（低延迟，需 Python 服务）。

## 引擎

| 能力 | 引擎 | 模型 | 说明 |
|---|---|---|---|
| ASR | **sensevoice**（自动优先） | sherpa-onnx（wasm） | 中文/粤/日/韩 最优（实测中文精准） |
| ASR | **whisper**（兜底） | transformers.js / onnxruntime-node | 99 语言，q8 量化；`ASR_MODEL_SIZE=small|medium` 可换更大 |
| TTS | **kokoro**（默认） | sherpa-onnx-node（原生）+ `sherpa-onnx-darwin-arm64` | 中英混合、53 音色（sid 0-52，18 混合、48-52 中文），CPU 可跑；⚠️ 需原生绑定（wasm 版加载失败） |
| TTS | **qwen3**（可选） | Python qwen-tts（0.6B） | 低延迟轻量，需 `npm run start-qwen3` 另起服务 |
| LLM | **llama-cpp**（内嵌默认） | node-llama-cpp + GGUF（`models/llm/`） | 单进程自控，Metal 加速；`LLM_MODEL` 换 Qwen3-4B 等 |
| LLM | ollama（后备，预留） | 转发 `http://127.0.0.1:11434` | 需 `ollama serve`；`OLLAMA_URL` 可配 |

> ⚠️ **TTS 依赖原生绑定**：Kokoro 需 `sherpa-onnx-node` + `sherpa-onnx-darwin-arm64`（`npm install` 自动装）。wasm 版 `sherpa-onnx` 加载 325M Kokoro 会报 `unreachable`（wasm trap），故 ASR 用 wasm 版、TTS 用原生版。

## 接口

- `POST /transcribe` — body 为 WAV/RAW PCM 音频 → `{ text, engine }`；`?engine=sensevoice|whisper|auto`（默认 auto）
- `POST /speak?engine=kokoro|qwen3` — body 为 JSON `{ text, sid, speed, voice, language }` → **帧流**（`application/octet-stream`；每帧 = 4 字节大端长度 + 一段 WAV，逐句流式，首帧 ≈ 首句合成时间，013-P1/P2）
  - kokoro：`{ "text": "你好世界", "sid": 48, "speed": 1 }`（sid 默认 18；speed 范围 0.5-2）
  - qwen3：`{ "text": "hello", "voice": "Vivian", "language": "Auto" }`（转发到 Qwen3 服务 `?stream=1` 帧流透传；`/voice-chat` 仍取整段 WAV）
  - **多角色朗读**（qwen3）：文本含「角色名：内容」行时自动按角色分音色——`roles: "auto"|"on"|"off"`（默认 auto，≥2 角色触发）+ 可选 `roleMap: {角色名:"音色名"}`；不同角色用 Qwen3 9 预设音色逐句流式（见 `../GUIDE.md`）
- `GET /models` — 模型清单与安装状态 `{ models: [{ category, engine, label, size, installed }] }`（014 §5.2 统一引擎抽象）
- `POST /install-model?engine=kokoro|sensevoice|llm|qwen3|whisper` — 按引擎安装/下载模型，**NDJSON 流式进度**（每行 `{ type:'log'|'done'|'error', message }`）
- `POST /chat` — body JSON `{ messages: [{role,content}], engine?, temperature?, top_p?, maxTokens? }` → `{ text, engine }`（LLM 引擎抽象层：`llama-cpp` 默认 / `ollama` 后备）
- `POST /voice-chat?asrEngine=&llmEngine=&ttsEngine=&prompt=&system=` — body **WAV 音频** → 识别→LLM→朗读 → **WAV 二进制**（一次完成全链路）
- `GET /health` — 服务状态、可用引擎与 TTS/LLM/模型状态（`tts: {...}`、`llm: {...}`、`models: [...]`）

### Qwen3-TTS（可选）

> macOS Homebrew Python 受 PEP 668 限制不能直接 `pip3 install`，用虚拟环境（复用系统 torch）：

```bash
cd asr-server
uv venv --system-site-packages .venv-qwen3          # 或用 python3 -m venv --system-site-packages .venv-qwen3
uv pip install -p .venv-qwen3 -U qwen-tts           # 只装 qwen-tts（torch 复用系统，MPS 可用）
npm run start-qwen3                                  # 已指向 .venv-qwen3/bin/python3（另起 8001）
# 国内下载模型加速：HF_ENDPOINT=https://hf-mirror.com npm run start-qwen3
```

### LLM（本地聊天 / 全链路 voice-chat）

> 内嵌 node-llama-cpp，单进程加载 GGUF，无需外部服务。默认小模型 `qwen2.5-0.5b-instruct-q4_k_m.gguf`（验证链路用）；质量不足可换 Qwen3-4B：
> `LLM_MODEL=/path/to/qwen3-4b-instruct-q4_k_m.gguf npm start`

```bash
# 单次对话
curl -X POST http://127.0.0.1:9528/chat -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"用一句话介绍你自己"}]}'
# → { "text": "...", "engine": "llama-cpp" }

# 全链路：语音 → 识别 → LLM 回答 → 朗读（body 为 WAV）
curl -X POST "http://127.0.0.1:9528/voice-chat?ttsEngine=kokoro" \
  -H 'Content-Type: audio/wav' --data-binary @in.wav -o out.wav
```

## 在 TabU 中使用

1. 蓝区「语音服务」→「本地服务」→ 确认地址 `http://127.0.0.1:9528`
2. 蓝区点「测试识别」应显示「本地服务在线」+ TTS 状态
3. 转写面板选「💻 本地服务」→ 录音
4. 朗读面板「朗读引擎」选 **Kokoro / Qwen3** → 朗读选中 / 全文 / 输入框 → 走本地 TTS

## 隐私

所有音频与合成只在本机处理，不上传任何云端。
