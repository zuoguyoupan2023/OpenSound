# 002 · Tabu-Local 可接入语音能力目录（模型与技术路线）

> 状态：**调研（2026-08）**。
> 定位：**Tabu-Local 不是一个"配好单一模型"的 App，而是一个"封装好的模型接入器"**——把市场上做得好的**语音识别（ASR）、语音合成（TTS）、语音克隆、对话（LLM）、实时语音（Realtime）**各路线与模型都列出来；能技术验证、能在本项目里接入的，就都接进来。发布后，用户要做的是：
>
> ```
> ① 下载 Tabu-Local App
> ② 设置模型下载路径
> ③ 下载自己想要的模型
> ④ 启用对应引擎
> ```
>
> 本文档 = **能力目录 + 各模型的接入状态（已接入 / 可接入待验证 / 规划中）+ 技术路线说明**。实现与现状见 `GUIDE.md` / `SPEC.md` / `000-voice-tauri-app规划.md`。
> 参考：母项目 `crazycodecat2` 的 `014`（TTS）、`016`（ASR 核验）、`013`（性能）、`017`（浏览器 SenseVoice）、`007`（接入）、`010`（一体化）。详细榜单见附录两份报告。
> **2026 重点新能力**：小红书 **FireRedASR2**（中文 ASR SOTA，sherpa 同栈可接入）、**DOTS-TTS**（零样本克隆开源第一）、**MiniCPM-o 4.5**（端侧全双工 Realtime）。

---

## 〇、Tabu-Local 接入模型的方式（架构）

所有能力走**统一 HTTP 端口 9528**，模型由 `/models` + `/install-model` 管理：

```
外部方（网站/插件/App/CLI）或 GUI
   │  HTTP :9528
   ▼
Tabu-Local App（Tauri 壳 → asr-server 子进程）
   ├─ 识别 POST /transcribe   （引擎可配：sensevoice/whisper/…）
   ├─ 朗读 POST /speak        （引擎可配：kokoro/qwen3/cloud/…）
   ├─ 对话 POST /chat         （llama-cpp/ollama/…）
   ├─ 全链路 POST /voice-chat
   ├─ 模型 GET /models · POST /install-model
   └─ (未来) WS /realtime
```

- **引擎抽象**：`TTS_ENGINES` / `ASR_ENGINES` 注册表 → 新增引擎只需注册 + 加下载器。
- **用户启用流程**：GUI「模型管理」下载模型 → 各面板选引擎 → 生效。也可直接用 HTTP 接口。
- **跨平台**：以 sherpa-onnx 的 ONNX 模型为唯一事实源，按平台选 EP（Mac: Metal/CoreML/MPS；Win: CUDA/DirectML/CPU）。

---

## 一、语音识别（ASR）

### 技术路线
| 路线 | 运行时 | 跨平台 | 说明 |
|---|---|---|---|
| **ONNX** | sherpa-onnx（ORT）| ✅ 一套模型全平台 | 主流；VAD/流式/热词/说话人全包 |
| **ggml** | whisper.cpp | ✅ | Mac Metal 最快；Win CUDA/CPU |
| **transformers.js** | WebGPU/WASM | 浏览器 | 现用作兜底 |
| **系统级** | Apple / Win11 | 平台原生 | 零体积；无热词 |

### 1.1 中文 ASR 公开基准 CER 排行榜（越低越好）

> 来源：[FireRedASR 官方 README](https://github.com/FireRedTeam/FireRedASR)（[arXiv:2501.14350](https://arxiv.org/abs/2501.14350)）；Average-4 = aishell1/aishell2/ws_net/ws_meeting 平均。

| 模型 | 参数量 | 开源 | aishell1 | aishell2 | ws_net | ws_meeting | Average-4 |
|---|---|---|---|---|---|---|---|
| **FireRedASR-LLM**（小红书）| 8.3B | ✅ | **0.76** | **2.15** | **4.60** | **4.67** | **3.05** |
| **FireRedASR-AED**（小红书）| 1.1B | ✅ | 0.55 | 2.52 | 4.88 | 4.76 | 3.18 |
| Seed-ASR（字节）| 12B+ | ❌API | 0.68 | 2.27 | 4.66 | 5.69 | 3.33 |
| SenseVoice-Large | 1.6B | ❌仅Small | 2.09 | 3.04 | 6.01 | 6.73 | 4.47 |
| Paraformer-Large（阿里）| 0.2B | ✅ | 1.68 | 2.85 | 6.74 | 6.97 | 4.56 |
| Qwen-Audio（阿里）| 8.4B | ✅ | 1.30 | 3.10 | 9.50 | 10.87 | 6.19 |
| Whisper-Large-v3 | 1.6B | ✅ | 5.14 | 4.96 | 10.48 | 18.87 | 9.86 |

**2026 最新 FireRedASR2**（[FireRedASR2S](https://github.com/FireRedTeam/FireRedASR2S)，[arXiv:2603.10420](https://arxiv.org/abs/2603.10420)，24 测试集：4 普通话+19 方言+1 歌词）：

| 模型 | 普通话平均 | 方言平均 | 全部平均 |
|---|---|---|---|
| **FireRedASR2-LLM** | **2.89** | 11.55 | **9.67** |
| **FireRedASR2-AED** | **3.05** | 11.67 | 9.80 |
| Qwen3-ASR-1.7B（开源）| 3.76 | **11.85** | 10.12 |
| Fun-ASR（非流式全链路）| 4.16 | 12.76 | 10.92 |

> **结论**：中文 ASR 精度第一梯队 = 小红书 FireRedASR2（LLM 版）＞ Paraformer/SenseVoice（阿里）＞ Whisper。国产在中文上全面超越 Whisper。

### 1.2 小红书 FireRedASR 专项

> 小红书开源的工业级 ASR 家族，中文方言 + 歌词识别 + SOTA。

| 变体 | 参数量 | 架构 | 特点 |
|---|---|---|---|
| FireRedASR-LLM | 8.3B | Encoder-Adapter-LLM（Qwen2-7B 底座）| SOTA 精度、端到端语音交互 |
| FireRedASR-AED | 1.1B | Attention Encoder-Decoder | 精度/效率均衡 |
| **FireRedASR2S** | — | 一体化四模块 | **ASR + VAD + LID + Punc 全 SOTA** |
| FireRedVAD | — | DFSMN | 100+语言语音检测，FLEURS-VAD-102 F1 97.57%（超 Silero-VAD 95.95）|
| FireRedLID | — | Encoder-Decoder | 100+语言+20+方言，FLEURS 准确率 97.18% |
| FireRedPunc | — | BERT | 中文标点恢复 F1 78.90%（vs FunASR 62.77%）|

- **训练**：约 7 万小时人工精选标注，论文结论"数据质量可弥补参数量差距"。
- **sherpa-onnx 支持** ✅：[sherpa-onnx-fire-red-asr2-zh_en-int8-2026-02-26](https://k2-fsa.github.io/sherpa/onnx/FireRedAsr/index.html)（AED/CTC，Node.js/WASM/Python 全支持）。
- **Tabu-Local 接入**：🔶 可接入——sherpa-onnx 已提供 Node.js 接口，与现有 SenseVoice 同栈，加引擎 + `/install-model` 即可。

### 1.3 流式 vs 非流式分类

| 类别 | 模型 | 说明 |
|---|---|---|
| **真流式（在线）** | sherpa-onnx zipformer transducer/CTC、Paraformer-online、UniASR、WeNet | 边说话边出字 |
| **非流式（离线）** | Whisper、SenseVoice、FireRedASR、Qwen-Audio、Paraformer-offline | 整段输入一次出结果 |
| **模拟流式** | sherpa-onnx 对离线模型用 VAD 切段 + 逐段推理 | 近似流式体验 |

### 1.4 sherpa-onnx 本地可部署 ASR 模型清单 + 接入状态

| 模型 | 大小(int8) | 中文 | 流式 | 热词 | 接入状态（Tabu-Local）|
|---|---|---|---|---|---|
| **SenseVoice** | 239MB | ✅优（中/粤/日/韩）| ❌(配VAD伪流式) | ❌ | ✅ **已接入**（默认）|
| **Whisper**（transformers.js）| base 75–140MB | 一般 | ❌ | ❌ | ✅ **已接入**（兜底）|
| **Whisper**（whisper.cpp+Metal）| 同源 | 一般 | ❌ | ❌ | 🔶 可接入（Mac 提质，待验证）|
| **Paraformer-zh** | ~226MB | ✅✅中文SOTA | ✅真流式 | 部分 | 🔶 可接入（中文实时，待验证）|
| **Zipformer/Transducer** | 50–174MB | 中英 | ✅ | ✅ | 🔶 可接入（热词，待验证）|
| **FireRedASR2**（小红书）| int8 | ✅✅SOTA（20+方言）| ❌(VAD模拟) | ❌ | 🔶 可接入（精度第一，待验证）|
| **Qwen3-ASR** | 0.6B int8 | ✅（30语+22方言）| ❌ | ❌ | 🔶 可接入（多方言，待验证）|
| **FunASR-Nano** | 很小 | ✅（7方言+26口音）| ❌ | ❌ | 🔶 可接入（省资源，待验证）|
| **Parakeet**（NVIDIA）| 120M–1.2GB | 弱(英文) | ✅ | ❌ | 🔶 可接入（Win NVIDIA 生态）|
| **Moonshine** | tiny 45–50MB | v2 多语 | v2✅ | ❌ | 🔶 可接入（极轻量，待验证）|

> **状态图例**：✅ 已接入（可用）｜🔶 可接入（技术验证后即可用）｜◻️ 规划中（成本/优先级未排）

---

## 二、语音合成（TTS）

### 技术路线
| 路线 | 运行时 | 跨平台 | 首帧 |
|---|---|---|---|
| **sherpa-onnx OfflineTts** | ORT | ✅ | CPU 慢（Kokoro ~2.7s/短句）|
| **PyTorch/MPS** | Python | ✅（需对应依赖）| Qwen3 0.6B MPS ~1.2–4.5s |
| **vllm-omni / 流式** | CUDA | 偏 NVIDIA | 百 ms 级（需 GPU）|
| **云端 API** | HTTP | ✅ | TTFB 100–500ms |
| **系统 TTS** | 系统 | 平台 | 即时 |

### 2.1 开源 TTS 排行榜（Seed-TTS-Eval 零样本克隆，WER↓/SIM↑）

> 来源：[dots.tts 技术报告](https://arxiv.org/abs/2606.07080)（官方自报，未独立复现）；WER 越低越好，SIM（说话人相似度）越高越好。

| 模型 | 参数量 | en WER/SIM | zh WER/SIM | 平均 WER/SIM | 授权 |
|---|---|---|---|---|---|
| **DOTS-TTS（小红书，开源第一）** | 2B | 1.30/77.1 | **0.94/81.0** | **2.95/79.2** | Apache 2.0 |
| **Qwen3-TTS** | 1.7B | **1.23**/71.7 | 1.22/77.0 | 3.07/74.5 | Apache 2.0 |
| **CosyVoice 3** | 1.5B | 2.22/72.0 | 1.12/78.1 | 3.06/75.3 | Apache 2.0 |
| IndexTTS 2 | 1.5B | 2.23/70.6 | 1.03/76.5 | 3.46/74.2 | bilibili 许可 |
| F5-TTS | 0.3B | 2.00/67.0 | 1.53/76.0 | 4.10/71.4 | CC BY-NC⚠️ |

**社区盲听榜（TTS-Arena / Artificial Analysis，2026）**：闭源登顶（MiniMax Speech-02/2.6、Cartesia）；开源第一梯队 = Fish S2 Pro（Elo 1129）、Kokoro-82M（Elo 1056）、Step Audio。开源与闭源差距已从 >200 Elo 缩小到 ~107。

### 2.2 小红书 DOTS-TTS 专项

> 小红书+上海交大开源（2026-06），**连续自回归 TTS 基座**，Seed-TTS-Eval 开源第一，Apache 2.0。

| 项 | 说明 |
|---|---|
| 技术路线 | **连续自回归**（全流水线无离散 token）：AudioVAE(48kHz) 连续潜空间 + LLM 主干（Qwen2.5-1.5B）+ AR flow-matching 头 + 冻结 CAM++ 说话人 x-vector |
| 与 Qwen3-TTS/CosyVoice 区别 | Qwen3-TTS/CosyVoice 用**离散多码本 token**；DOTS-TTS 在**连续空间**自回归，规避离散 token 信息瓶颈 |
| 克隆 | 零样本克隆（~10s 参考）；延续式克隆 SIM 最高（79.2 开源第一）；跨语克隆领先 |
| 双流式 | `dots.tts-mf-2steps-stts` 支持**双流式对话**（逐 token 推文本、边推边出音频）|
| 部署 | PyTorch（MPS 待验证）｜SGLang-Omni（`sgl-omni serve`，OpenAI 兼容 `/v1/audio/speech`）|
| sherpa-onnx 支持 | ❌ 不支持（大 AR 模型）；ONNX 零样本克隆可用官方 **ZipVoice** |
| 授权 | **Apache 2.0 可商用** |

**Tabu-Local 接入**：🔶 可接入——SGLang-Omni 暴露 OpenAI 兼容 `/v1/audio/speech`，Tabu-Local 的 `/speak` 可像转发 cloud 引擎一样接入（需 GPU）。

### 2.3 模型清单 + 接入状态

| 模型 | 大小 | 授权 | 克隆 | 多角色 | 语言 | 设备 | 接入状态（Tabu-Local）|
|---|---|---|---|---|---|---|---|
| **Kokoro** | ~350MB | Apache2 | ❌ | ❌ | 英/少中 | CPU | ✅ **已接入**（默认）|
| **Qwen3-TTS** | 0.6B~1.2GB | Apache2 | ✅ | 9预设拼装 | 中英多语 | MPS | ✅ **已接入**（流式）|
| **cloud**（OpenAI 兼容）| — | API | ✅ | — | 多语 | 联网 | ✅ **已接入**（引擎已注册）|
| **azure**（SSML 合成）| — | API | ✅ | ✅多角色 | 100+语 | 联网 | ✅ **已接入**（引擎已注册）|
| **cosyvoice**（DashScope）| — | API | ✅ | ✅ | 中英日韩粤 | 联网 | ✅ **已接入**（引擎已注册）|
| **MOSS-TTS-Nano** | 100M | Apache2 | ✅(VoiceGen) | 家族多档 | 中文强 | 4核CPU | 🔶 可接入（CPU 新默认，待验证）|
| **DOTS-TTS**（小红书）| 2B | Apache2 | ✅零样本 | 双流式 | 中英 | GPU | 🔶 可接入（开源克隆第一，待验证）|
| **IndexTTS2** | ≥8GB | bilibili许可 | ✅20-30s | ❌ | 中英混+18语 | ≥8GB | 🔶 可接入（克隆+情绪，待验证）|
| **CosyVoice 2/3** | ~4GB | Apache2 | ✅3s | ✅ | 中英日韩粤 | ~4GB | 🔶 可接入（多角色+克隆，待验证）|
| **Fish S2.1-Pro** | 大 | 研究许可⚠️ | ✅ | ✅ | 82语 | 大显存 | 🔶 可接入（顶级质量，商用需授权）|
| **XTTS-v2** | ~4GB | Coqui⚠️ | ✅6s | ❌ | 17语 | ~4GB | ◻️ 规划（授权需审）|
| **ChatTTS** | ~2B | CC BY-NC⚠️ | — | ✅ | 中英 | ~4GB | ◻️ 排除（非商用授权）|
| **云端**：Cartesia / MiniMax / ElevenLabs | — | API | ✅ | Azure/MiniMax✅ | 多语 | 联网 | 🔶 可接入（加引擎即可）|

---

## 三、语音克隆（Voice Cloning）

> 2026 开源零样本克隆已成熟。综合质量+商用许可，**DOTS-TTS（Apache 2.0）是开源第一**；OmniVoice（小米）覆盖 646 语言。

| 模型 | 参考音频 | 语言 | 授权 | 设备 | 克隆质量 | 接入状态 |
|---|---|---|---|---|---|---|
| **DOTS-TTS**（小红书）| ~10s | 中英 | Apache2 | GPU | Seed-TTS-Eval SIM 79.2（开源第一）| 🔶 可接入（第一）|
| **OmniVoice**（小米）| ~3s | **646 语言** | Apache2 | 开源 | CV3-Eval WER 6.76/SS 70.39 | 🔶 可接入（超多语言）|
| **IndexTTS2** | 20–30s | 中英混+18语 | bilibili许可 | ≥8GB | 情感/语速精细可控 | 🔶 可接入（高配）|
| **CosyVoice 3.0** | 3s 零样本 | 中英日韩粤 | Apache2 | ~4GB | 方言多、最顺 | 🔶 可接入 |
| **MOSS-TTS VoiceGenerator** | 短 | 中文强 | Apache2 | CPU | 家族多档 | 🔶 可接入（轻量）|
| **XTTS-v2** | 6s 跨语 | 17语 | Coqui⚠️ | ~4GB | 旧基准良好 | ◻️ 规划（授权需审）|
| **OpenVoice v2** | 短 | 多语 | MIT | 轻量 | 音色/情绪/口音 | ◻️ 规划 |
| **ZipVoice**（sherpa-onnx）| 短 | zh-en | Apache2 | CPU | ONNX 离线克隆首选 | 🔶 可接入（sherpa 同栈）|

> **GUI 落地**（对应 000 §1.4）：录音（复用 Rust cpal）→ 克隆 → 保存音色 → 朗读引擎可选克隆音色。需新增 `/clone` 端点 + 克隆引擎。

---

## 四、对话（LLM）

> Tabu-Local 不只做语音，还内置本地 LLM 对话（`/chat` / `/voice-chat`）。本节讲清楚三件事：
> 1. **omlx** 是什么（用户问到的 Mac 方案，一个 LLM **推理服务器**，不是格式）；
> 2. **MLX vs GGUF**（Apple 框架/格式 vs 跨平台通用格式）；**Windows 没有"专属格式"，GGUF 是跨平台事实标准**；
> 3. 有哪些消费级可用的开源 LLM、Mac/Win 怎么部署。

### 4.1 oMLX（Apple Silicon LLM 推理服务器）

> 用户问的 `omlx.ai` / `github.com/jundot/omlx` —— 注意它**不是模型格式**，而是**一个基于 MLX 的本地 LLM 推理服务器**（桌面 App / 后台服务）。

| 项 | 说明 |
|---|---|
| 是什么 | **LLM 推理服务器**（App + 后台服务），基于 Apple **MLX** 框架，专为 Apple Silicon 优化 |
| 核心创新 | **Paged SSD KV Cache**（热层 RAM + 冷层 SSD 双层 KV 缓存）+ continuous batching |
| 解决什么 | **长上下文 / coding agent 场景**：prefill 每次重算全部上下文 → oMLX 把 KV cache 分块，前缀命中时从 SSD 恢复跳过 prefill，**TTFT 从 ~90s 压到 1–3s** |
| 支持模型 | LLM / VLM / OCR / embedding / reranker；GLM、Qwen、MiniMax 等（自定义 kernel 更快）|
| API | **OpenAI 兼容** `http://localhost:8000/v1` → **任何 OpenAI 兼容客户端可连** |
| 形态 | macOS App（菜单栏常驻）、Homebrew、源码；`omlx serve` 后台服务 |
| 平台 | **仅 macOS 15+，Apple Silicon（M1–M4）** |
| 授权 | Apache 2.0 |
| 与 MLX 关系 | oMLX **构建在 MLX 之上**（MLX 是底层框架，oMLX 是面向用户的推理服务器产品）|

**接入 Tabu-Local 的可行性**：
- oMLX 暴露 **OpenAI 兼容 `/v1`** → Tabu-Local 的 `/chat` 可像转发 Ollama(11434) 一样**转发 oMLX(8000)**，作为 **Mac 上的高质量 LLM 后端**。
- 优势：长上下文/工具调用场景（语音助手的连续对话、上下文累积）比 llama.cpp 默认更优。
- 注意：**仅 Mac**；Windows 无对应物（Windows 用 GGUF + CUDA/DirectML，见 4.2）。

### 4.2 格式：MLX vs GGUF（关键）

| 格式 | 全称 | 平台 | 说明 |
|---|---|---|---|
| **GGUF** | llama.cpp 通用格式 | **跨平台**（Mac/Win/Linux）| 事实标准；`.gguf` 单文件；支持 Q4/Q5/Q8 等量化；**Windows 就是用它** |
| **MLX** | Apple 机器学习框架格式 | **仅 Apple Silicon（M 芯片）** | Apple 官方框架；`.safetensors` 权重；针对统一内存 + Metal 优化，**Apple 硬件上通常比 GGUF 快**；**oMLX 用它做 KV 缓存持久化** |
| **safetensors / fp16** | 原始权重 | 通用（需转换）| 未经量化，体积大 |
| **ONNX** | 通用推理格式 | 通用 | 主要给语音模型（sherpa-onnx）用 |

**关键结论**：
- **oMLX 是"服务器"，MLX 是"框架+格式"，GGUF 是"跨平台格式"**——三者不同层。用户在 Mac 上可用 **oMLX（基于 MLX）** 或 **llama.cpp（GGUF）**。
- **Windows 没有"专属格式/服务器"**——它用 **GGUF**（llama.cpp），配合 CUDA（NVIDIA）/ DirectML（AMD/Intel）。Windows 上没有 oMLX 对应物。
- **同一模型的 GGUF 可在 Mac 和 Win 都跑**（跨平台）；MLX/oMLX 只能在 Mac 跑（但有速度优势）。
- **接入 Tabu-Local**：Mac 可转发 **oMLX(OpenAI 兼容 /v1)** 或加 **MLX 引擎**作速度优先；Win / 跨平台用现有 GGUF(llama.cpp) 引擎。用户选引擎即可，无需关心底层。

### 4.3 消费级可用的开源本地 LLM（按内存档位，2026 前沿）

> 详细数据见附录 `2026本地可部署开源LLM调研报告.md`。Q4 = GGUF 4-bit 量化。**2026 综合首选 Qwen3.5 家族**（Apache 2.0，原生多模态，262K 上下文可扩 1M）。

| 模型 | 参数量 | Q4 大小 | 内存 | 上下文 | 特点 | 授权 |
|---|---|---|---|---|---|---|
| **Qwen3.5-0.8B / 2B / 4B** | 0.8/2/4B | ~0.6/1.3/2.6GB | 8GB | 262K | 端侧/轻量 Agent | Apache 2.0 |
| **Qwen3.5-9B** | 9B | **5.3GB（实测）** | 16GB | 262K | **16GB 甜点**（知识超 GPT-OSS-120B）| Apache 2.0 |
| **Qwen3.5-27B** | 27B | ~16GB | 32GB | 262K | 稠密、创作/复杂推理 | Apache 2.0 |
| **Qwen3.5-35B-A3B** | 35B/3B激活 | 19GB（实测）| 32GB | 262K | MoE，4090 ~196 tok/s | Apache 2.0 |
| **Gemma 4** | E2B/E4B/12B/26B-A4B/31B | 9.6–18GB | 8–32GB | 128–256K | 原生多模态（含音频）| Apache 2.0 |
| **Mistral Small 3.2** | 24B | ~14-15GB | 16–32GB | 128K | 视觉、函数调用 | Apache 2.0 |
| **Phi-4 / Phi-4-mini** | 14B / 3.8B | ~9 / 2.5GB | 16 / 8GB | 16K / 128K | 代码/数学 | MIT |
| **DeepSeek-R1 蒸馏** | 1.5–32B | 1–20GB | 8–32GB | 128K | 推理强（工具调用弱）| MIT |
| **MiniCPM-V 4.6** | 1.3B | ~1.5GB | **6GB 手机** | 262K | 多模态端侧之王 | Apache 2.0 |
| **GLM-4.6V-Flash** | 9B | ~6GB | 16GB | 200K | 多模态工具调用 | MIT |

> **默认档位建议**（Tabu-Local 当前默认 qwen2.5-0.5b，偏小用于验证）：16GB 可跑 **Qwen3.5-9B**（Q4≈5.3GB，可开 128K+ 上下文）；32GB 可跑 **Qwen3.5-35B-A3B**（Q4≈19GB）或 27B。
> ⚠️ **纠错**：中文媒体流传的「Qwen3.5-27B-A3B」不存在——27B 是稠密模型，MoE 3B 激活的是 **35B-A3B**。

### 4.4 Mac / Win 部署方式

| 平台 | 引擎/运行时 | 格式/端口 | 说明 |
|---|---|---|---|
| **macOS（M 芯片）** | llama.cpp | GGUF | 现状（Tabu-Local 内嵌 node-llama-cpp）；Metal 加速 |
| **macOS（M 芯片，长上下文/agent）** | **oMLX** | safetensors；`:8000/v1` | 🔶 可接入：SSD KV 缓存，长上下文 TTFT 快；OpenAI 兼容转发 |
| **macOS（M 芯片，速度优先）** | **MLX** | safetensors/mlx | 🔶 可接入：Apple 硬件 decode 最快（+20~87%），作可选用引擎 |
| **Windows（NVIDIA）** | llama.cpp + CUDA | GGUF | 推荐：GPU 加速 |
| **Windows（AMD/Intel/集显）** | llama.cpp + Vulkan / CPU | GGUF | **Vulkan**（DirectML 已维护模式，不推荐）|
| **任意（跨平台）** | Ollama | 任意；11434 | 后备：HTTP 转发 11434，用户自装 Ollama 管理模型 |
| **跨平台统一** | llama.cpp + GGUF | GGUF | **当前方案**，一套模型 Mac/Win 通用 |

**引擎结论（2026）**：短/中上下文 Mac 选 MLX/oMLX（decode 快 20-87%）；长上下文（>40K）选 llama.cpp（GGUF+FlashAttention）；Windows NVIDIA 用 CUDA、AMD/Intel 用 Vulkan（**DirectML 已边缘化**）。

**接入状态**：
- ✅ **已接入**：llama.cpp（GGUF，跨平台默认）+ Ollama（后备）
- 🔶 **可接入**：**oMLX**（Mac 长上下文 agent）、MLX（Mac 速度优先）、按内存档位提供多个 GGUF 下载（Qwen3.5-9B / Qwen3.5-4B / Gemma-4 等）
- **用户启用**：GUI「模型管理」按平台列出可下载模型 → 下载 → `/chat` 选引擎（Mac 可选手动/自动拉起 oMLX）。

---

## 五、实时语音对话（Realtime，M6 远期）

> 实时对话 = 端到端 Omni 模型 或 流式 ASR+TTS 流水线。**端到端最自然**（全双工、可打断），流水线可纯 CPU（工程成熟）。

### 5.1 实时语音对话（Omni）模型排行榜

| 模型 | 出品 | 参数 | 实时能力 | 本地可部署 | 授权 |
|---|---|---|---|---|---|
| **MiniCPM-o 4.5** | 面壁 | ~9B | **业界首个端到端全双工全模态**；自由打断、无需外部 VAD | **RTX 5070 12GB 流畅（RTF 0.4）**；M1–M5 Max 可用 | Apache 2.0 |
| **Qwen3-Omni** | 阿里 | 30B-A3B | 原生端到端、流式双输出 | vLLM-Omni/SGLang 可部署 | Apache 2.0 |
| **GLM-4-Voice-9B** | 智谱 | 9B | 端到端中英实时；20 token 出语音 | int4 ~12GB 可部署 | 代码 Apache 2.0 |
| **Qwen3.5-Omni** | 阿里 | 未公开 | 语义打断、音色克隆 | 以 API 为主 | 待验证 |
| **MOSS-TTS 家族** | MOSI | 多档 | 语音+声音生成、多说话人 | 开源可部署 | 待验证 |

> **端侧首选**：MiniCPM-o 4.5（9B/Apache/12GB 显存/原生打断）；**能力最强**：Qwen3-Omni-30B-A3B。

### 5.2 流式 ASR+TTS 本地流水线（工程方案）

| 环节 | 组件 | 说明 |
|---|---|---|
| VAD | silero-vad / sherpa-onnx 内置 | 说话起点检测 |
| 流式 ASR | sherpa-onnx（Zipformer/Paraformer/SenseVoice）、FunASR | 增量识别，首词 100–300ms |
| 流式 TTS | sherpa-onnx TTS（Kokoro/Matcha）、CosyVoice3 | 首音频 60–200ms |
| 参考框架 | sherpa-voice-assistant、FastVoice（Apple Silicon 63ms 首音频）| 本地语音助手整机 |

**典型流水线**：`麦克风 → VAD → 流式ASR → LLM(流式) → 流式TTS(分块播放)`，整链路 0.5–1.5s。取舍：Omni 端到端最自然但可控性受限；流水线每环节可替换、工程成熟但需自拼打断逻辑。

### 5.3 语音到语音（S2S）与云端

- **本地 S2S**：Qwen3-Omni、MiniCPM-o 4.5、GLM-4-Voice、MOSS-TTS。
- **云端实时**：Cartesia Sonic 3.5（<90ms 首音频）、StepAudio 2.5 Realtime、OpenAI Realtime。

---

## 六、跨平台（Win / Mac）差异与统一底座

| 平台 | 加速 | 最优 ASR | 最优 TTS | 最优 LLM | 备注 |
|---|---|---|---|---|---|
| **macOS（M 系列）** | Metal/CoreML/MPS/ANE | whisper.cpp+Metal；sherpa-onnx Paraformer/FireRedASR2 | Qwen3(MPS)；MOSS-Nano(CPU) | **oMLX**(SSD KV) / **MLX** 或 llama.cpp GGUF(Metal) | 统一内存，medium Whisper/0.6B TTS/4B LLM 直接跑 |
| **Windows（NVIDIA）** | CUDA | Faster-Whisper int8；sherpa-onnx CUDA/FireRedASR2 | Qwen3(CUDA)；IndexTTS2；DOTS-TTS | llama.cpp GGUF + CUDA | VRAM 硬上限；int8 压显存 |
| **Windows（AMD/Intel/集显）** | Vulkan/CPU int8 | sherpa-onnx DirectML | Kokoro/MOSS(CPU int8) | llama.cpp GGUF + Vulkan/CPU | **DirectML 已维护模式，不推荐新项目** |
| **Linux** | CUDA/CPU | 同 Win NVIDIA | 同 | llama.cpp GGUF + CUDA | CI 用 |

**核心结论**：
1. **模型可跨平台复用**（ONNX/ggml 同一份文件），换平台只换运行时 EP。
2. **依赖不同**：PyTorch 引擎 Win 装 CUDA torch、Mac 装 MPS torch → 下载器/CI 按平台装。
3. **下载器按平台**：whisper.cpp Metal 的 `.bin`、CUDA 的 onnxruntime 平台相关。
4. **用户侧零感知**：GUI「模型管理」按平台显示可下载模型，点下载即用。

---

## 七、落地优先级（按"接入更多模型"逻辑）

> 目标：**用户能在 App 里下载并启用的模型越多，Tabu-Local 越有价值**。按"验证成本低 / 用户收益高"排序：

| 优先级 | 内容 | 难度 | 用户价值 |
|---|---|---|---|
| 1 | **引擎选择 UI 完善**（识别/朗读/对话选引擎，当前已做）| 低 | 高 |
| 2 | **ASR 加 FireRedASR2**（小红书，精度第一，sherpa 同栈）| 中 | 高（中文方言精度）|
| 3 | **ASR 加 Paraformer-zh 流式** | 中 | 高（中文实时）|
| 4 | **TTS 加 MOSS-TTS-Nano** | 中 | 高（CPU 新默认）|
| 5 | **TTS 加 DOTS-TTS**（小红书，克隆第一，SGLang-Omni 转发）| 高 | 高（克隆/质量）|
| 6 | **LLM 多模型下载**（按内存档位：Qwen3.5-9B / 4B / Gemma-4 等 GGUF）| 中 | 高（对话质量）|
| 7 | **Mac oMLX/MLX 引擎**（速度/长上下文优先）| 中 | 中（Mac 提速）|
| 8 | **语音克隆页**（DOTS-TTS/CosyVoice/ZipVoice）| 高 | 高 |
| 9 | **云端引擎 UI**（凭据配置 + 回退）| 低 | 中 |
| 10 | **Realtime**（MiniCPM-o 4.5 或流水线）| 高 | 中 |
| 11 | **CI 三平台**（按平台装依赖 + EP）| 中 | 高（发布）|

---

## 附录（详细调研报告）

- `2026本地可部署开源LLM调研报告.md` —— LLM 全家族技术路线、量化体积、Apple/Windows 部署、推理引擎排行榜
- `2026-实时语音与语音克隆开源方案调研报告.md` —— Realtime 模型排行、克隆模型对比、流水线方案

## 参考链接

**ASR**
- FireRedASR：[GitHub](https://github.com/FireRedTeam/FireRedASR) · [论文](https://arxiv.org/abs/2501.14350) · [FireRedASR2S](https://github.com/FireRedTeam/FireRedASR2S) · [sherpa-onnx FireRedAsr 文档](https://k2-fsa.github.io/sherpa/onnx/FireRedAsr/index.html)
- sherpa-onnx：[GitHub](https://github.com/k2-fsa/sherpa-onnx) · [SenseVoice（239M）](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17)
- FunASR benchmark：[FunASR](https://github.com/modelscope/FunASR/blob/main/benchmarks/benchmark_pipeline_cer.md) · [SenseVoice 论文](https://arxiv.org/abs/2407.04051)

**TTS / 克隆**
- DOTS-TTS（小红书）：[GitHub](https://github.com/studio-dots-ai/dots.tts) · [论文](https://arxiv.org/abs/2606.07080) · [HF 模型集](https://huggingface.co/collections/dots-studio/dotstts)
- Qwen3-TTS：[GitHub](https://github.com/QwenLM/Qwen3-TTS) · [CosyVoice](https://github.com/FunAudioLLM/CosyVoice) · [IndexTTS](https://github.com/index-tts/index-tts) · [MOSS-TTS](https://github.com/OpenMOSS/MOSS-TTS)
- sherpa-onnx TTS 文档：[ZipVoice](https://github.com/k2-fsa/sherpa/blob/master/docs/source/onnx/tts/zipvoice.rst) · [vLLM-Omni](https://vllm.ai/blog/2026-06-23-vllm-omni-tts)

**LLM**
- MLX vs GGUF：[MLX vs GGUF](https://dev.to/jacksonxly/mlx-vs-gguf-on-apple-silicon-which-local-llm-format-should-you-actually-use-53gj) · [llama.cpp vs MLX](https://www.local-llm.net/compare/llama-cpp-vs-mlx/) · [Apple Silicon 五引擎论文](https://arxiv.org/abs/2511.05502)
- oMLX：[官网](https://omlx.ai/) · [GitHub](https://github.com/jundot/omlx) · [SSD KV 原理（HN）](https://hn.svelte.dev/item/47247294)
- 消费级 LLM 选型：[by RAM 2026](https://www.frankx.ai/blog/best-local-llm-2026) · [Qwen3.5-9B](https://huggingface.co/Qwen/Qwen3.5-9B) · [Gemma 4](https://huggingface.co/google/gemma-4-31B-it)

**Realtime / Omni**
- MiniCPM-o 4.5：[HF](https://huggingface.co/openbmb/MiniCPM-o-4_5) · [Qwen3-Omni](https://github.com/QwenLM/Qwen3-Omni) · [GLM-4-Voice](https://github.com/THUDM/GLM-4-Voice)

- 母项目调研：`014`（TTS）、`016`（ASR）、`013`（性能）、`017`（浏览器 SenseVoice）、`007`（接入）、`015`（LLM 能力来源）
