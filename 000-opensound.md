# 000 · 声音版 OpenRouter / Ollama —— TTS·ASR 聚合与中转平台全景

> 回答一个问题：**LLM 圈有 OpenRouter（注册一家、用多家）、Ollama（本地运行时）、LiteLLM/one-api（自建网关转接）；那 TTS 和 ASR 领域有没有同类平台？**
> 结论先行：**有，而且已经分层成熟**——OpenRouter 自己在 2026-05 正式上线了音频端点；推理托管平台上开源语音模型琳琅满目；自建网关软件原生支持 `/audio/*`；甚至出现了官方自述"Ollama, but for TTS/STT models"的本地运行时。
> 口径：2026-08-26 · 关联文档：`001-asr-stt全景调研.md`（各家单价）、`028-mac-win系统TTS与Tauri调用调研.md`（系统 TTS 与插件）、`009`（云端接入架构）
> 核实方式：OpenRouter 官方博客原文、DeepInfra 模型目录实时抓取、LiteLLM/Speaches 官方文档；无法核实的标 ⚠️。

---

## 一、先给框架：声音圈的"四层结构"

| 层 | LLM 圈对应物 | 声音圈代表 | 特征 |
| --- | --- | --- | --- |
| ① 统一云 API 聚合商 | OpenRouter | **OpenRouter(音频端点)**、Eden AI、AI/ML API | 注册一个账号、一把 Key，转发多家官方模型，统一计费 |
| ② 开源模型推理托管 | Together / Fireworks / Groq | **fal.ai**、**Replicate**、**DeepInfra**、SiliconFlow、Novita、HF Inference Providers、Groq/Together/Fireworks(whisper) | 平台自己部署开源模型卖按量 API，不经过模型原厂 |
| ③ 自建网关软件 | LiteLLM / one-api / new-api | **LiteLLM**（原生 `/audio/*`）、one-api/new-api（音频支持有限 ⚠️） | 开源软件自己部署，把各厂商 API 转成统一协议 |
| ④ 本地运行时 | Ollama / llama.cpp server | **Speaches**（官方自述"Ollama, but for TTS/STT models"）、OpenedAI-speech ⚠️、sherpa-onnx HTTP、**本项目 asr-server** | 本地起服务、动态加载模型、暴露 OpenAI 兼容端口 |

---

## 二、逐个说清楚

### 2.1 OpenRouter —— 已官宣音频端点（标志性事件）

[官方公告（2026-05-01）](https://openrouter.ai/blog/announcements/announcing-audio-apis)：新增两条专用端点，与你已有的文本路由/账单/Key 管理**完全同一套**：

```
POST /api/v1/audio/speech          # 文本 → 语音（TTS）
POST /api/v1/audio/transcriptions  # 语音 → 文本（STT）
POST /chat/completions             # audio-in/out 多模态模型（原有）
```

- 上架情况（公告口径）：Speech 支持 **OpenAI、Google、Mistral** 的音色；Transcription 支持 **OpenAI Whisper**；
- 判断：✅ 你听说的模式成立，但语音目录目前仍以大厂官方模型为主，ElevenLabs/Fish 这类专业玩家是否上架 ⚠️ 以官网模型页为准；
- 对用户的价值：**一个 Key 同时拿 LLM+TTS+ASR**，做原型和切换供应商的成本最低。

### 2.2 推理托管平台（②层，开源模型的"批发市场"）

| 平台 | 语音目录（2026-08 实测/来源） | 计费 | 特点 |
| --- | --- | --- | --- |
| **fal.ai** | 语音类目最广之一：Orpheus-TTS、PlayAI、MiniMax speech、Whisper 等（[Audio API 文档](https://fal.ai/docs/model-api-reference/audio-api/overview)） | 按量/serverless | 出图出视频出语音的"多模态批发部"，延迟优化好 |
| **Replicate** | 社区模型海量：whisper 系、f5-tts、cosyvoice、bark… | 按秒计费 | 找冷门开源模型的最快途径；质量参差 |
| **DeepInfra**（本次实测抓取目录） | TTS：Kokoro-82M、**Audio8-TTS-Preview-0.6b**、Qwen3-TTS(+VoiceDesign)、MiMo-V2.5-tts(**+voiceclone/+voicedesign**)、Inworld-tts-1.5 max/mini、realtime-tts-1.5/2；ASR：whisper 系 | 单价低著称 | 001 表里 Together $0.001/min 一档的同类玩家，目录比 Together 广得多 |
| **SiliconFlow 硅基流动** | FunAudioLLM 系（SenseVoice/CosyVoice）+ fish-speech 等 ⚠️目录以官网为准 | 按 token/字符量 | **国内代表**：中文开源语音模型上云的主通道，国内网络友好 |
| Novita AI | 有音频类目 ⚠️ | 按量 | HF Inference Providers 的后端之一 |
| **Hugging Face Inference Providers** | 路由到 fal/replicate/novita 等执行 | 按 HF 订阅+用量 | "聚合之聚合"：一个 HF 账号调全网托管模型 |
| Groq / Together / Fireworks | Whisper 专用通道 | 见 001 §四表 | 单模型通道，不算聚合但常被一起比较 |

### 2.3 自建网关软件（③层，"自己部署+转接中转"的标准答案）

- **[LiteLLM](https://docs.litellm.ai/docs/text_to_speech)**：代理服务器原生支持 **`/audio/transcriptions` 与 `/audio/speech`** 两端点，背后路由到 OpenAI/Azure/Vertex 等多家——这就是你描述的"自己部署+转接各厂商 API"的开源实现，LLM 圈事实标准在音频上同样可用；
- one-api / new-api：国内自建网关流行款，主要覆盖 LLM，音频端点支持有限 ⚠️ 用前确认版本；
- 自建价值：统一日志/配额/降级路由（比如"本地 SenseVoice 失败 → 智谱 → Azure"三级回退），这正是本项目 `asr-server` 引擎注册表的思路。

### 2.4 本地运行时（④层，声音版 Ollama）

- **[Speaches](https://github.com/dograh-hq/speaches)**（MIT）：README 原话 *"This project aims to be Ollama, but for TTS/STT models."*
  - OpenAI API 兼容（现有 SDK 直接连）；STT 用 faster-whisper，TTS 用 **piper + Kokoro**；
  - **动态模型加载/卸载**（请求里指定哪个就自动加载，闲置自动卸载——和 Ollama 行为一致）；
  - 支持流式转录（SSE）、Realtime API、GPU/CPU、Docker 部署；
- OpenedAI-speech：OpenAI TTS 兼容的自托管方案（piper/coqui 系）⚠️活跃度需复核；
- sherpa-onnx HTTP 服务：离线识别的轻量服务化路径（002 已论证）；
- **本项目 `asr-server` 本身就是这个定位**：9528 一个端口暴露 ASR/TTS/LLM/克隆全能力，引擎可插拔——相当于"私有版 Speaches+LiteLLM 合体"，且多了克隆和 voice-chat 链路。

---

## 三、结论与对本项目的建议

1. **你的直觉完全正确，且时机正好**：OpenRouter 官宣音频端点意味着"注册一家、语音文字全包"的模式已进入主流；②层平台让开源语音模型的使用门槛降到一行 curl；
2. **接入优先级建议**：
   - 原型期要省事 → **OpenRouter**（一个 Key 拿 OpenAI/Google/Mistral 语音 + Whisper）；
   - 要跑开源模型且便宜 → **DeepInfra / SiliconFlow**（后者对国内网络友好，Fun-Audio 系原生支持）；
   - 要多供应商回退与配额管理 → **LiteLLM 自建**，或继续强化 asr-server 的引擎注册表（同构思路）；
   - 纯本地离线 → Speaches 可作为 asr-server 的对标参照系（它的动态加载设计值得抄）；
3. **风险提示**：聚合层普遍有加价、限流与模型下架风险（DeepInfra 目录里今天有 Audio8 明天未必有）；本项目"本地默认 + 云端可选"的双轨架构天然抗这种风险，云端一律走引擎抽象，不做硬依赖。

---

## 四、参考链接

- OpenRouter 音频端点公告：https://openrouter.ai/blog/announcements/announcing-audio-apis
- fal.ai Audio API：https://fal.ai/docs/model-api-reference/audio-api/overview
- DeepInfra 模型目录（实时抓取）：https://deepinfra.com/models?type=text-to-speech 、https://deepinfra.com/models?type=automatic-speech-recognition
- LiteLLM 音频端点文档：https://docs.litellm.ai/docs/text_to_speech
- Speaches（Ollama for TTS/STT）：https://github.com/dograh-hq/speaches · https://speaches.ai
- Eden AI（多供应商聚合老牌）：https://www.everydev.ai/tools/eden-ai
- AI/ML API 语音模型文档：https://docs.aimlapi.com/api-references/speech-models

---

## 五、变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-08-26 | 初版：四层分类框架 + OpenRouter 音频端点官宣核实 + fal/Replicate/DeepInfra/SiliconFlow/HF 托管目录 + LiteLLM/one-api 自建网关 + Speaches 本地运行时（官方自述 Ollama for TTS/STT）+ 接入优先级建议 |
