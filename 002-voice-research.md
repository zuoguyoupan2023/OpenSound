# 002 · 语音模型技术路线调研与 Tabu-Local 实现对照

> 状态：**调研（2026-08）**；定位：梳理 Tabu-Local（Tauri 桌面 App）当前用到的语音模型技术路线，横向调研**其它可选语音模型**（ASR / TTS / 语音克隆 / Realtime），并给出**在当前 App 里如何实现**的落地方案与**跨平台（Win/Mac）差异**。
> 关联：`014`（TTS 调研）、`016`（ASR 调研）、`013`（性能/硬件加速）、`017`（浏览器 SenseVoice）、`007`（接入）、`010`（一体化）。
> 本项目正文：`000-voice-tauri-app规划.md`（M0–M6 分期）。

---

## 〇、结论先行

1. **当前 Tabu-Local 已具备"一条本地语音链路"**：SenseVoice(ASR) → llama-cpp(LLM) → Kokoro/Qwen3(TTS)，全部本机运行，走 9528 统一 HTTP 端口。
2. **技术路线核心 = 运行时（Runtime/EP）决定模型选型**：
   - **ASR**：主流走 **ONNX Runtime（sherpa-onnx）** 或 **whisper.cpp/ggml**（Mac 用 Metal，Win 用 CUDA）。
   - **TTS**：轻量走 **sherpa-onnx OfflineTts**（Kokoro/VITS/MMS），高质量走 **PyTorch/MPS（Qwen3）**，云端走 **OpenAI 兼容 /v1/audio/speech**。
3. **跨平台差异（Win vs Mac）是真实的、必须提前规划**：
   - **Mac（Apple Silicon）**：Metal / CoreML / MPS 三套加速可用，统一内存（16GB 可直接跑 medium 级 Whisper / 0.6B TTS）。
   - **Windows**：有 NVIDIA → CUDA；无独显 → DirectML / CPU int8。**同一套 ONNX 模型跨平台复用，但 EP（执行提供器）不同**。
   - **结论：以 sherpa-onnx 的 ONNX 模型为"唯一事实源"，按平台选 EP —— 一套模型，三平台可跑。**
4. **能做的增量（按性价比）**：
   - **ASR**：Mac 加 `whisper.cpp + Metal`（高质量多语）；中文实时加 `Paraformer-zh 流式`（sherpa-onnx）；极轻量 `Moonshine`。
   - **TTS**：中低配换 `MOSS-TTS-Nano-100M`（CPU 可跑，替换 kokoro）；高配加 `IndexTTS2`（克隆+情绪）或 `CosyVoice3`（多角色+克隆）；云端加 `Cartesia / MiniMax`。
   - **语音克隆**：`IndexTTS2 / CosyVoice / XTTS-v2`。
   - **Realtime 实时语音**：M6 远期，走 WebSocket，本地引擎首帧普遍 1.5–5s，真实时需云端或专用模型。

---

## 一、当前 Tabu-Local 技术栈（基线）

| 能力 | 引擎 | 运行时 | 端口 | 模型 |
|---|---|---|---|---|
| 识别 ASR | SenseVoice（默认） | sherpa-onnx-node **CPU** | 9528 | `model.int8.onnx`（239MB）|
| 识别 ASR（兜底） | Whisper | transformers.js | 9528 | 按需下载 |
| 朗读 TTS | Kokoro | sherpa-onnx-node **CPU** | 9528 | kokoro-multi-lang（~350MB）|
| 朗读 TTS（可选） | Qwen3 | Python `qwen3-tts-server.py` **MPS** | 8001 | Qwen3-TTS-12Hz-0.6B（~1.2GB）|
| 朗读 TTS（云端） | cloud/azure/cosyvoice | HTTP 转发 | 9528 | OpenAI 兼容 / Azure SSML / DashScope |
| 对话 LLM | llama-cpp | node-llama-cpp（Metal） | 9528 | qwen2.5-0.5b GGUF（~469MB）|
| 对话 LLM（后备） | Ollama | HTTP 转发 | 11434 | 任意 GGUF |

**接口事实源**：`GUIDE.md`（调用）；`000-voice-tauri-app规划.md §二`（对外规范设计）。统一抽象已就绪：`TTS_ENGINES` 注册表（014 §5.2）+ `INSTALLERS`（/install-model）+ `/health` 能力上报。

---

## 二、ASR（语音识别）技术路线调研

### 2.1 技术路线分类

| 路线 | 运行时 | 代表模型 | 跨平台 | 特点 |
|---|---|---|---|---|
| **ONNX 路线** | sherpa-onnx（ORT）| SenseVoice / Paraformer / Zipformer / Parakeet / Whisper / Moonshine | ✅ 一套 ONNX 全平台 | **Tabu-Local 现用**；VAD/流式/热词/说话人全包；Mac CoreML、Win CUDA/DirectML |
| **ggml 路线** | whisper.cpp（C/C++）| Whisper 全家 | ✅ | Mac **Metal** 最快；Win CUDA/CPU；内存小；非流式 |
| **transformers.js 路线** | WebGPU/WASM | Whisper | 浏览器 | 现用作兜底；SenseVoice 不支持 |
| **系统级** | Apple SFSpeech / Win11 语音 | 系统 | 平台原生 | 零体积；定制性差；无热词 |

### 2.2 关键 ASR 模型对照（本地部署）

| 模型 | 大小(int8) | 中文 | 流式 | 热词 | 定位 | 在当前 App 实现 |
|---|---|---|---|---|---|---|
| **SenseVoice**（现用）| 239MB | ✅优（中/粤/日/韩）| ❌（配 VAD 伪流式）| ❌ | 中文+情感/标点 | 已有；可加 VAD 变实时 |
| **Whisper**（现用兜底）| base 75–140MB | 一般 | ❌ | ❌ | 多语兜底 | 已有；Mac 换 whisper.cpp+Metal 提质 |
| **Paraformer-zh** | ~226MB | ✅✅中文 SOTA | ✅ **真流式** | 部分 | 中文实时首选 | 加 sherpa-onnx 流式引擎 + `/install-model` |
| **Zipformer/Transducer** | 50–174MB | 中英 | ✅ | ✅ | 通用实时+热词 | 同上，热词适合唤醒/人名 |
| **Parakeet**（NVIDIA）| 120M~1.2GB | 弱（英文向）| ✅（120M/0.6B）| ❌ | 英文实时 | 可选，Win NVIDIA 生态 |
| **Moonshine** | tiny 45–50MB | v2 多语 | v2 ✅ | ❌ | 端侧速度王 | 极轻量，低配 Mac/Win 可用 |
| **FunASR Nano** | 很小 | ✅ | ❌ | ❌ | 阿里系省资源 | 可选 |

> **Mac 实测结论**（016 §四）：whisper.cpp Metal 是本地 Whisper 最快路径（M4 上 small RTF≈0.05、~20×实时）；中文实时留 sherpa-onnx Paraformer/SenseVoice（与手机共用同一批 ONNX）。

### 2.3 在当前 App 实现增量 ASR 的方式
- **Paraformer-zh 流式**：在 `TTS_ENGINES` 同构的 ASR 侧加一个引擎 → 前端识别面板可选「流式中文」；模型走 `/install-model?engine=paraformer`。
- **whisper.cpp + Metal（Mac）**：asr-server 增加一个子进程引擎，`ASR_ENGINE=whisper-metal`；模型 GGUF/bin 走下载器。
- **共用 ONNX**：Paraformer/SenseVoice 的 ONNX 文件与手机端复用，迁移成本最低。

---

## 三、TTS（语音合成）技术路线调研

### 3.1 技术路线分类

| 路线 | 运行时 | 代表模型 | 跨平台 | 首帧 |
|---|---|---|---|---|
| **sherpa-onnx OfflineTts** | ORT | Kokoro / VITS / MMS / Piper | ✅ | CPU 慢（Kokoro ~2.7s/短句）|
| **PyTorch/MPS** | Python | Qwen3-TTS / IndexTTS2 / CosyVoice / MOSS | ✅（需对应依赖）| Qwen3 0.6B MPS 首帧 ~1.2–4.5s |
| **vllm-omni / 专用流式** | CUDA | Qwen3-omni / MOSS-Realtime | 偏 NVIDIA | 百 ms 级（需 GPU）|
| **云端 API** | HTTP | OpenAI / Cartesia / MiniMax / Azure / ElevenLabs | ✅ | TTFB 100–500ms |
| **系统 TTS** | 系统 | macOS / Windows 原生 | 平台 | 即时 |

### 3.2 关键 TTS 模型对照（本地部署，商用安全优先）

| 模型 | 大小 | 授权 | 克隆 | 多角色 | 语言 | 设备 | 在 App 实现 |
|---|---|---|---|---|---|---|---|
| **Kokoro**（现用）| ~350MB | Apache 2.0 | ❌ | ❌ | 英/少中文 | CPU | 已有（CPU 兜底）|
| **Qwen3-TTS**（现用）| 0.6B ~1.2GB | Apache 2.0 | ✅ | 9 预设拼装 | 中英多语 | MPS | 已有；已启用逐句流式 |
| **MOSS-TTS-Nano** | 100M | Apache 2.0 | ✅(VoiceGen) | 家族多档 | 中文强 | **4 核 CPU** | **推荐替换 kokoro**（中低配默认）|
| **IndexTTS2** | ≥8GB | Apache 2.0 | ✅20–30s | ❌ | 中英混+18语 | ≥8GB | 高配：克隆+8维情绪 |
| **CosyVoice 2/3** | ~4GB | Apache 2.0 | ✅3s | ✅ | 中英日韩粤 | ~4GB | 多角色+克隆首选 |
| **Fish S2.1-Pro** | 大 | 按版本 | ✅ | ✅ | 82语 | 大显存 | 顶级质量 |
| **XTTS-v2** | ~4GB | Coqui⚠️ | ✅6s | ❌ | 17语 | ~4GB | 商用需审 |
| **ChatTTS** | ~2B | CC BY-NC⚠️ | — | ✅ | 中英 | ~4GB | **商用排除** |
| **云端**：Cartesia / MiniMax / Azure / ElevenLabs | — | API | ✅ | Azure/MiniMax✅ | 多语 | 联网 | 加引擎即可 |

> **多角色最强**：本地 CosyVoice3 / ChatTTS；云端 Azure(SSML) / MiniMax。
> **克隆最顺**：IndexTTS2（8GB）/ CosyVoice（4GB）/ XTTS-v2（4GB）。

### 3.3 在当前 App 实现增量 TTS 的方式
- **MOSS-TTS-Nano**：新增 `TTS_ENGINES.moss`，模型走 `/install-model?engine=moss`；CPU 可跑，替换 kokoro 作中低配默认。
- **IndexTTS2 / CosyVoice**：新增引擎 + 安装流程；GUI「克隆音色」页（录 10s → 生成克隆 → 朗读）。
- **云端**：`TTS_ENGINES.cloud/azure/cosyvoice` 已就绪，前端朗读引擎下拉加云端项 + 凭据配置（设置面板）。

---

## 四、语音克隆（Voice Cloning）技术路线

| 模型 | 参考音频长度 | 语言 | 授权 | 设备 | 在 App 实现 |
|---|---|---|---|---|---|
| **IndexTTS2** | 20–30s | 中英混+18语 | Apache 2.0 | ≥8GB | 高配克隆首选 |
| **CosyVoice 3.0** | 3s 零样本 | 中英日韩粤 | Apache 2.0 | ~4GB | 最顺、工程生态成熟 |
| **MOSS-TTS VoiceGenerator** | 短 | 中文强 | Apache 2.0 | CPU | 轻量克隆 |
| **XTTS-v2** | 6s 跨语种 | 17语 | Coqui⚠️ | ~4GB | 需审授权 |
| **OpenVoice v2** | 短 | 多语 | MIT | 轻量 | 音色/情绪/口音控制 |

> **GUI 落地**（对应 000 规划 §1.4「录 10s 语音 → 生成克隆音色」）：录音（复用 Rust cpal）→ POST 克隆接口 → 保存音色到模型目录 → 朗读引擎可选克隆音色。需新增 `/clone` 端点 + `TTS_ENGINES` 克隆引擎。

---

## 五、Realtime 实时语音（M6 远期）

- **现状**：本地 TTS 首帧普遍 1.5–5s（013 §十），**真实时（百 ms 级）需云端或专用模型**。
- **路线**：
  - 本地：Qwen3-omni / MOSS-Realtime（流式，偏 NVIDIA）；whisper.cpp Metal（ASR 近实时）。
  - 云端：Cartesia（WebSocket 双向流式，<90ms）、OpenAI Realtime。
- **在 App 实现**：M6 走 WebSocket/RT 通道（000 规划 §1.4），前端边说话边出字 + 低延迟回复；本地用「ASR 流式 + LLM 流式 + TTS 流式」拼流水线（013 §九的"播放与合成重叠"机制是引擎无关的，云端流式同样适用）。

---

## 六、跨平台（Win / Mac）实现差异与统一底座

### 6.1 平台加速矩阵

| 平台 | 加速可用 | 最优 ASR | 最优 TTS | 备注 |
|---|---|---|---|---|
| **macOS（M 系列）** | Metal / CoreML / MPS / ANE | whisper.cpp+Metal；sherpa-onnx Paraformer | Qwen3(MPS)；MOSS-Nano(CPU) | 统一内存，medium Whisper / 0.6B TTS 直接跑 |
| **Windows（NVIDIA）** | CUDA | Faster-Whisper int8；sherpa-onnx CUDA | Qwen3(CUDA)；IndexTTS2 | VRAM 是硬上限；int8 压显存 |
| **Windows（AMD/Intel/集显）** | DirectML / CPU int8 | sherpa-onnx DirectML | Kokoro/MOSS(CPU int8) | DirectML 通吃任意 DX12 卡 |
| **Linux** | CUDA / CPU | 同 Win NVIDIA | 同 | CI 用 |

### 6.2 关键结论
1. **模型跨平台可复用**：sherpa-onnx 的 ONNX 模型（SenseVoice/Paraformer/Kokoro）与 ggml（whisper.cpp）都是跨平台同一份文件；**换平台只换运行时 EP，不换模型**。
2. **依赖不同**：Qwen3-TTS 等 PyTorch 引擎，Win 要 CUDA torch、Mac 要 MPS torch，`pip install` 命令不同 → 打包/CI 需按平台装。
3. **下载器要按平台**：部分模型（如 whisper.cpp Metal 的 `.bin`、CUDA 的 onnxruntime）平台相关 → `/install-model` 的下载脚本需区分平台。
4. **CI（M4）**：macos/windows/ubuntu 三平台各装 Node+Rust+Python，下载各自 EP 依赖后 `tauri build`。

> **统一底座建议**（014 §5.2 / 016 §五）：以 **sherpa-onnx 的 ONNX 模型 + 引擎抽象**为唯一事实源，手机/桌面/服务端一套模型；按平台选 EP。**这正好支撑 000 规划 §1.4「未来支持各种语音模型」**。

---

## 七、落地优先级（结合 000 规划分期）

| 优先级 | 内容 | 对应 000 | 难度 |
|---|---|---|---|
| 1 | **GUI 引擎选择 UI**（识别/朗读选引擎，当前已做）| M2 | 已做 |
| 2 | **ASR 加 Paraformer-zh 流式**（中文实时）| M2 识别面板扩展 | 中 |
| 3 | **TTS 加 MOSS-TTS-Nano**（CPU 中低配默认）| M2 朗读面板 | 中 |
| 4 | **语音克隆页**（IndexTTS2/CosyVoice）| M3/M6 | 高 |
| 5 | **云端引擎 UI**（凭据配置 + 可达性回退）| M3 | 低（引擎已就绪）|
| 6 | **Realtime**（WebSocket，边说话边出字）| M6 | 高 |
| 7 | **CI 三平台**（按平台装依赖 + EP）| M4 | 中 |

---

## 参考链接

- sherpa-onnx：[GitHub](https://github.com/k2-fsa/sherpa-onnx) · [SenseVoice 模型（239M）](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17) · [DeepWiki](https://deepwiki.com/k2-fsa/sherpa-onnx/1-overview)
- MOSS-TTS-Nano：[HuggingFace ONNX](https://huggingface.co/OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX) · [GitHub](https://github.com/OpenMOSS/MOSS-TTS-Nano)
- whisper.cpp Metal：[getspeakup benchmark](https://www.getspeakup.app/blog/whisper-cpp-benchmark-mac/) · [fazm.ai Metal](https://fazm.ai/blog/whisper-cpp-metal-apple-silicon)
- Faster-Whisper：[SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- 母项目已有调研：`014`（TTS）、`016`（ASR 核验）、`013`（性能）、`017`（浏览器 SenseVoice）、`007`（接入）
