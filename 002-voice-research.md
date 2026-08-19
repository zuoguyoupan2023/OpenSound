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
> 参考：母项目 `crazycodecat2` 的 `014`（TTS）、`016`（ASR 核验）、`013`（性能）、`017`（浏览器 SenseVoice）、`007`（接入）、`010`（一体化）。

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

### 模型清单 + 接入状态
| 模型 | 大小(int8) | 中文 | 流式 | 热词 | 接入状态（Tabu-Local）|
|---|---|---|---|---|---|
| **SenseVoice** | 239MB | ✅优（中/粤/日/韩）| ❌(配VAD伪流式) | ❌ | ✅ **已接入**（默认）|
| **Whisper**（transformers.js）| base 75–140MB | 一般 | ❌ | ❌ | ✅ **已接入**（兜底）|
| **Whisper**（whisper.cpp+Metal）| 同源 | 一般 | ❌ | ❌ | 🔶 可接入（Mac 提质，待验证）|
| **Paraformer-zh** | ~226MB | ✅✅中文SOTA | ✅真流式 | 部分 | 🔶 可接入（中文实时，待验证）|
| **Zipformer/Transducer** | 50–174MB | 中英 | ✅ | ✅ | 🔶 可接入（热词，待验证）|
| **Parakeet**（NVIDIA）| 120M–1.2GB | 弱(英文) | ✅ | ❌ | 🔶 可接入（Win NVIDIA 生态）|
| **Moonshine** | tiny 45–50MB | v2 多语 | v2✅ | ❌ | 🔶 可接入（极轻量，待验证）|
| **FunASR Nano** | 很小 | ✅ | ❌ | ❌ | ◻️ 规划中 |

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

### 模型清单 + 接入状态
| 模型 | 大小 | 授权 | 克隆 | 多角色 | 语言 | 设备 | 接入状态（Tabu-Local）|
|---|---|---|---|---|---|---|---|
| **Kokoro** | ~350MB | Apache2 | ❌ | ❌ | 英/少中 | CPU | ✅ **已接入**（默认）|
| **Qwen3-TTS** | 0.6B~1.2GB | Apache2 | ✅ | 9预设拼装 | 中英多语 | MPS | ✅ **已接入**（流式）|
| **cloud**（OpenAI 兼容）| — | API | ✅ | — | 多语 | 联网 | ✅ **已接入**（引擎已注册）|
| **azure**（SSML 合成）| — | API | ✅ | ✅多角色 | 100+语 | 联网 | ✅ **已接入**（引擎已注册）|
| **cosyvoice**（DashScope）| — | API | ✅ | ✅ | 中英日韩粤 | 联网 | ✅ **已接入**（引擎已注册）|
| **MOSS-TTS-Nano** | 100M | Apache2 | ✅(VoiceGen) | 家族多档 | 中文强 | 4核CPU | 🔶 可接入（CPU 新默认，待验证）|
| **IndexTTS2** | ≥8GB | Apache2 | ✅20-30s | ❌ | 中英混+18语 | ≥8GB | 🔶 可接入（克隆+情绪，待验证）|
| **CosyVoice 2/3** | ~4GB | Apache2 | ✅3s | ✅ | 中英日韩粤 | ~4GB | 🔶 可接入（多角色+克隆，待验证）|
| **Fish S2.1-Pro** | 大 | 按版本 | ✅ | ✅ | 82语 | 大显存 | 🔶 可接入（顶级质量，待验证）|
| **XTTS-v2** | ~4GB | Coqui⚠️ | ✅6s | ❌ | 17语 | ~4GB | ◻️ 规划（授权需审）|
| **ChatTTS** | ~2B | CC BY-NC⚠️ | — | ✅ | 中英 | ~4GB | ◻️ 排除（非商用授权）|
| **云端**：Cartesia / MiniMax / ElevenLabs | — | API | ✅ | Azure/MiniMax✅ | 多语 | 联网 | 🔶 可接入（加引擎即可）|

---

## 三、语音克隆（Voice Cloning）

| 模型 | 参考音频 | 语言 | 授权 | 设备 | 接入状态 |
|---|---|---|---|---|---|
| **IndexTTS2** | 20–30s | 中英混+18语 | Apache2 | ≥8GB | 🔶 可接入（高配克隆）|
| **CosyVoice 3.0** | 3s 零样本 | 中英日韩粤 | Apache2 | ~4GB | 🔶 可接入（最顺）|
| **MOSS-TTS VoiceGenerator** | 短 | 中文强 | Apache2 | CPU | 🔶 可接入（轻量克隆）|
| **XTTS-v2** | 6s 跨语 | 17语 | Coqui⚠️ | ~4GB | ◻️ 规划（授权需审）|
| **OpenVoice v2** | 短 | 多语 | MIT | 轻量 | ◻️ 规划 |

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

### 4.3 消费级可用的开源本地 LLM（按内存档位）

> 参考 2026 主流选型（按 8/16/32GB 内存档）：

| 模型 | 参数量 | 量化后大小 | 语言 | 特点 | 适合内存 | 授权 |
|---|---|---|---|---|---|---|
| **Qwen3-0.6B / 1.7B / 4B** | 0.6/1.7/4B | Q4 ~0.5/1/2.5GB | 中英强 | 国产中文友好、档位全 | 8–16GB | Apache 2.0 |
| **Qwen3-8B / 14B** | 8/14B | Q4 ~5/9GB | 中英强 | 质量高 | 16–32GB | Apache 2.0 |
| **Llama 3.2 1B / 3B / 8B** | 1/3/8B | Q4 ~0.7/2/5GB | 英强 | 生态成熟、Meta | 8–32GB | Llama 许可证 |
| **Gemma 3 2B / 4B / 12B** | 2/4/12B | Q4 ~1.5/2.5/7GB | 英强多语 | Google、多模态 | 8–32GB | Gemma 许可证 |
| **Mistral 7B** | 7B | Q4 ~4.5GB | 英/法/德 | 轻快、上下文长 | 16GB | Apache 2.0 |
| **Phi-3/4 小模型** | 3.8–14B | Q4 ~2–8GB | 英 | Microsoft、代码/数学强 | 8–32GB | MIT |
| **DeepSeek-R1 蒸馏小模型** | 1.5–7B | Q4 ~1–4.5GB | 中英 | 推理强（Reasoning）| 8–16GB | MIT |
| **GLM-4 系列** | 4–9B | Q4 ~2.5–5GB | 中英 | 智谱、中文+工具 | 16GB+ | 开源（部分宽松）|

> **默认档位建议**（Tabu-Local 当前默认 qwen2.5-0.5b，偏小用于验证）：16GB 可跑 Qwen3-4B 或 Llama-3.2-3B；32GB 可跑 Qwen3-8B 或 Gemma-3-12B。

### 4.4 Mac / Win 部署方式

| 平台 | 引擎/运行时 | 格式/端口 | 说明 |
|---|---|---|---|
| **macOS（M 芯片）** | llama.cpp | GGUF | 现状（Tabu-Local 内嵌 node-llama-cpp）；Metal 加速 |
| **macOS（M 芯片，长上下文/agent）** | **oMLX** | safetensors；`:8000/v1` | 🔶 可接入：SSD KV 缓存，长上下文 TTFT 快；OpenAI 兼容转发 |
| **macOS（M 芯片，速度优先）** | **MLX** | safetensors/mlx | 🔶 可接入：Apple 硬件上更快，作可选用引擎 |
| **Windows（NVIDIA）** | llama.cpp + CUDA | GGUF | 推荐：GPU 加速 |
| **Windows（AMD/Intel/集显）** | llama.cpp + DirectML / CPU | GGUF | CPU int8 兜底 |
| **任意（跨平台）** | Ollama | 任意；11434 | 后备：HTTP 转发 11434，用户自装 Ollama 管理模型 |
| **跨平台统一** | llama.cpp + GGUF | GGUF | **当前方案**，一套模型 Mac/Win 通用 |

**接入状态**：
- ✅ **已接入**：llama.cpp（GGUF，跨平台默认）+ Ollama（后备）
- 🔶 **可接入**：**oMLX**（Mac 长上下文）、MLX（Mac 速度优先）、按内存档位提供多个 GGUF 下载（Qwen3-4B / Llama-3.2-3B 等）
- **用户启用**：GUI「模型管理」按平台列出可下载模型 → 下载 → `/chat` 选引擎（Mac 可选手动/自动拉起 oMLX）。

---

## 五、实时语音（Realtime，M6 远期）

| 方案 | 路线 | 首帧 | 说明 |
|---|---|---|---|
| **本地流水线** | ASR流式 + LLM流式 + TTS流式 | 1.5–5s | 013 §九"播放与合成重叠"机制，引擎无关 |
| **Qwen3-omni / MOSS-Realtime** | 专用流式模型 | 百ms级 | 偏 NVIDIA |
| **whisper.cpp Metal** | ASR 近实时 | — | Mac |
| **云端 Cartesia** | WebSocket 双向流式 | <90ms | 需联网付费 |

---

## 六、跨平台（Win / Mac）差异与统一底座

| 平台 | 加速 | 最优 ASR | 最优 TTS | 最优 LLM | 备注 |
|---|---|---|---|---|---|
| **macOS（M 系列）** | Metal/CoreML/MPS/ANE | whisper.cpp+Metal；sherpa-onnx Paraformer | Qwen3(MPS)；MOSS-Nano(CPU) | **oMLX**(SSD KV) / **MLX** 或 llama.cpp GGUF(Metal) | 统一内存，medium Whisper/0.6B TTS/4B LLM 直接跑 |
| **Windows（NVIDIA）** | CUDA | Faster-Whisper int8；sherpa-onnx CUDA | Qwen3(CUDA)；IndexTTS2 | llama.cpp GGUF + CUDA | VRAM 硬上限；int8 压显存 |
| **Windows（AMD/Intel/集显）** | DirectML/CPU int8 | sherpa-onnx DirectML | Kokoro/MOSS(CPU int8) | llama.cpp GGUF + DirectML/CPU | DirectML 通吃 DX12 |
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
| 2 | **ASR 加 Paraformer-zh 流式** | 中 | 高（中文实时）|
| 3 | **TTS 加 MOSS-TTS-Nano** | 中 | 高（CPU 新默认）|
| 4 | **LLM 多模型下载**（按内存档位：Qwen3-4B / Llama-3.2-3B / Gemma-3-4B 等 GGUF）| 中 | 高（对话质量）|
| 5 | **Mac MLX 引擎**（速度优先）| 中 | 中（Mac 提速）|
| 6 | **语音克隆页**（IndexTTS2/CosyVoice）| 高 | 高 |
| 7 | **云端引擎 UI**（凭据配置 + 回退）| 低 | 中 |
| 8 | **Realtime**（WebSocket）| 高 | 中 |
| 9 | **CI 三平台**（按平台装依赖 + EP）| 中 | 高（发布）|

---

## 参考链接

- sherpa-onnx：[GitHub](https://github.com/k2-fsa/sherpa-onnx) · [SenseVoice 模型（239M）](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17)
- MOSS-TTS-Nano：[HF ONNX](https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX) · [GitHub](https://github.com/OpenMOSS/MOSS-TTS-Nano)
- whisper.cpp Metal：[benchmark](https://www.getspeakup.app/blog/whisper-cpp-benchmark-mac/) · [Metal](https://fazm.ai/blog/whisper-cpp-metal-apple-silicon)
- Faster-Whisper：[SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- MLX vs GGUF：[MLX vs GGUF on Apple Silicon](https://dev.to/jacksonxly/mlx-vs-gguf-on-apple-silicon-which-local-llm-format-should-you-actually-use-53gj) · [GGUF vs MLX 2026](https://contracollective.com/blog/gguf-vs-mlx-quantization-formats-apple-silicon-2026) · [llama.cpp vs MLX](https://www.local-llm.net/compare/llama-cpp-vs-mlx/) · [Ollama MLX](https://dev.classmethod.jp/en/articles/apple-mlx-ollama-deep-dive/)
- 消费级本地 LLM 选型：[by RAM 2026](https://www.frankx.ai/blog/best-local-llm-2026) · [VRAM 计算](https://willitrunai.com/blog/what-llm-can-i-run-locally) · [小模型桌面 App](https://unstore.io/discover/best-apps-for-tiny-local-llms-desktop/)
- oMLX：[官网 omlx.ai](https://omlx.ai/) · [GitHub jundot/omlx](https://github.com/jundot/omlx) · [SSD KV 缓存原理（HN）](https://hn.svelte.dev/item/47247294) · [MLX 讨论](https://github.com/ml-explore/mlx/discussions/3203) · [CSDN 实战](https://openeuler.csdn.net/6a216fe910ee7a33f277a23b.html) · [知乎对比](https://zhuanlan.zhihu.com/p/2028536283694122713)
- 母项目调研：`014`（TTS）、`016`（ASR）、`013`（性能）、`017`（浏览器 SenseVoice）、`007`（接入）、`015`（LLM 能力来源）
