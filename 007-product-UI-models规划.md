# 007 · 产品化 / UI 打磨 / 模型库扩展规划（第二轮）

> 状态：**规划文档**，承接 `006`。本文件登记第二轮需求（CI 分发、UI 打磨、模型库扩展），供新对话逐步执行。
> 原则：分阶段、先确认后动手、UI 优先、可见即验收、不反复测试、不确定就问。

---

## 〇、本轮需求总览（按 P 优先级）

| # | 需求 | 优先级 | 状态 |
|---|---|---|---|
| P1 | **CI 构建 + publish（GitHub Actions 三平台打包）** | 🔴 高 | 待做 |
| P2 | **UI 打磨**：去 emoji → Iconify、小圆角、i18n、明暗主题 | 🟡 中 | 待做 |
| P3 | **模型库扩展**：TTS / ASR / LLM 候选模型，定下载路径 + 启用方式 + 准确安装检测 | 🔴 高 | 待做 |

> 本轮**先不执行**，仅登记需求。执行前先与用户确认每个子项的具体方案。

---

## P1 · CI 构建 + publish（GitHub Actions）

### 目标
- 在 GitHub 上构建三平台安装包（对应 `006 T4`）：
  - macOS → `.dmg`
  - Windows → `.msi`
  - Linux → `.deb` / `.AppImage`
- **用户先自己执行一次 `publish`**，打通发布链路。

### 需要实现的代码
- `.github/workflows/` 新增 CI workflow：
  - 矩阵 `macos-latest / windows-latest / ubuntu-latest`
  - 跑 `rustup run stable npm run build`（Tauri build）
  - 产出安装包并发布到 **GitHub Release**
- **发布方式：GitHub Release**（已确认）。Tauri 的 `publish` 可一次发布**多个版本的安装包**到同一 Release（`.dmg` / `.msi` / `.deb` / `.AppImage` 同时上传），按 tag 区分版本。
- **注意（来自 006 T4）**：
  - 安装包**只含壳**，模型首次启动经 `/install-model` 下载（勿把大模型打进包）。
  - Python 子服务（qwen3 / sensevoice / cosyvoice）在各平台的启动路径与依赖需处理。
  - Rust 工具链需 ≥1.88（用 rustup stable）。

### 待确认
- 是否先只出 macOS（当前开发机），三平台后续补？
- Release 命名/tag 规范（如 `v0.1.0` 语义化版本）。

---

## P2 · UI 打磨

### 2.1 去 emoji → Iconify 图标
- **现状**：`ui/src/App.tsx` 的导航、`AsrPanel/HomePanel/ChatPanel` 等处用 emoji（🎙️🔊🎧 等）作图标。
- **改法**：引入 [Iconify](https://iconify.design/)（`@iconify/react` + 一个图标集，如 `lucide` / `material-symbols`），统一替换所有 emoji 图标。
- 涉及文件：`App.tsx`（NAV 图标）、各面板按钮/徽标。

### 2.2 圆角改小
- **现状**：`App.css` 圆角偏大（如 `border-radius: 8px` 及以上、`mic-btn` 大圆角）。
- **改法**：全局统一为**小圆角**（建议 `4px` 为主、面板/卡片不超过 `6px`），需先定规范再批量改。

### 2.3 i18n（国际化）
- **目标**：UI 文案抽离成 key，支持多语言（至少中/英），可切换。
- **技术建议**：`react-i18next` + 语言资源文件（`ui/src/locales/{zh,en}.json`）。
- 范围：所有面板标题、按钮、提示、错误文案。

### 2.4 明暗主题
- **现状**：`App.css` 目前是固定亮色（或单色）。
- **改法**：CSS 变量化（`:root` / `[data-theme=dark]`），支持明/暗切换 + 跟随系统；设置面板提供切换项。

### 待确认
- Iconify 用哪个图标集？（推荐 lucide，风格统一）
- i18n 首版覆盖哪些语言？（推荐 中文 + English）
- 明暗主题默认跟随系统还是手动？

---

## P3 · 模型库扩展（TTS / ASR / LLM）

### 3.1 目标
- 整理可选的 TTS / ASR / LLM 模型，**定好每个的下载路径 + 启用方式**。
- 安装 App 的用户可**自行安装并启用**（走 `/install-model` + `/models`）。
- **必须要有准确的安装检测机制，不能用"文件 >1G 就算成功"这类猜测式逻辑。**

### 3.2 安装检测机制（⚠️ 核心要求）
**拒绝猜测式判定**（如只看 `existsSync` / `大小>阈值`）。准确机制应满足：
1. **下载完整性**：下载先写 `.part`，完成后 rename 正式文件（`006 §4.1` 已建立此机制）。
2. **校验**：完成后校验
   - 文件大小 == 服务器声明的 Content-Length（或 LLM_MODELS 里登记的预期字节数）
   - GGUF 文件头 magic（`GGUF` 四字节）有效
   - 可选：SHA256 校验和（模型源提供时）
3. **可加载性**：`installed` 最终应反映"**该模型当前是否可被加载使用**"，而不只是文件存在。
4. 检测失败（不完整 / 校验失败）时：`installed=false`，并在 `/models` 或 UI 给出明确原因（如"文件不完整，请重新下载"）。

> 落地建议：为每个模型在 `LLM_MODELS`（及同类注册表）登记 `expectedSize` 与 `magic`/`checksum`；`installed` 函数据此校验，而不仅是 `existsSync`。

### 3.3 候选模型清单（源自 000/002/调研报告，标注出处）

> `audio8` 已确认 = **Audio8 TTS**（[Audio8-AI/Audio8_TTS](https://github.com/Audio8-AI/Audio8_TTS)，"SOTA-Class TTS at Compact Scale"，含 0.1B 档位与 ONNX Runtime）。注意：它不是 002 里的 Qwen-Audio（那是 ASR/音频理解），是独立的轻量 TTS 模型。

#### TTS（本地可部署，开源）
| 模型 | 规模 | 特色 | 许可 | 下载源 | 状态 |
|---|---|---|---|---|---|
| Kokoro | 82M | 中英混合 · 53 音色 | MIT | 已集成 | ✅ 已装 |
| Qwen3-TTS | 0.6B | 低延迟 · MPS · 流式 | — | 已集成 | ✅ 已装 |
| CosyVoice3 | 0.5B | 中文克隆 · 18 方言 | — | 已集成 | ✅ 已装 |
| **IndexTTS2 / 2.5** | 1.5B / 0.8B | B站开源 · 情感/语速/发音精细可控 | Apache-2.0（待验证） | [index-tts](https://github.com/index-tts/index-tts) | 🔶 候选（本轮加入）|
| **VoxCPM / VoxCPM2** | 0.5B / 2B | OpenBMB 开源 | — | [OpenBMB/VoxCPM](https://github.com/OpenBMB/VoxCPM) | 🔶 候选（本轮加入）|
| **Audio8 TTS** | 0.1B | SOTA-Class · 紧凑 | — | [Audio8-AI/Audio8_TTS](https://github.com/Audio8-AI/Audio8_TTS) | 🔶 候选（本轮加入）|
| **FishAudio S2** | S2-Pro **4B**（唯一官方权重档；社区另有 fp8 / GGUF 量化，见 §3.3 专项）| AA 开源 TTS 第一梯队；**云端 compat/v1 已确认可复用现有 `cloud` 引擎** | FISH AUDIO RESEARCH LICENSE（非商用免费，商用需授权）| [s2-pro@HF](https://huggingface.co/fishaudio/s2-pro) / [fish-speech](https://github.com/fishaudio/fish-speech) | ✅ 云端可用 · 🔶 本地候选（见专项）|
| **OmniVoice** | 0.8B | **646 语言** · 3s 克隆 | Apache-2.0 | sherpa 生态 | 🔶 候选 |
| **DOTS-TTS** | 2B | 小红书 · 克隆第一 | Apache-2.0（可商用）| [dots.studio](https://dots.studio) | 🔶 候选 |
| **Fish-Speech 1.5** | 1.2B | 克隆第一梯队 | 研究许可（商用需授权）| [fish-speech](https://github.com/fishaudio/fish-speech) | 🔶 候选（注意许可）|

#### ASR
| 模型 | 规模 | 特色 | 许可 | 状态 |
|---|---|---|---|---|
| SenseVoice 量化版 | 228MB | 中英日韩粤 | — | ✅ 已装 |
| SenseVoice 原始版 (funasr) | 897MB | 高精度 · 多语言 | — | ✅ 已装 |
| **FunASR 全家桶**（funasr 可加） | — | Paraformer / FireRedASR / 流式等 | Apache-2.0 | 🔶 候选（本轮加入，作为可选 ASR 引擎）|
| Whisper base | ~500MB | 多语兜底 | MIT | ✅ 已装 |
| **Paraformer / FireRedASR** | — | 流式/高精度中文 | — | 🔶 候选 |

#### LLM（对话）
| 模型 | 规模 | 特色 | 状态 |
|---|---|---|---|
| Qwen2.5-0.5B | 469MB | 默认兜底 | ✅ 已装 |
| Qwen3-8B | ~4.9GB | M4/16GB 甜点档 | ✅ 已加（P3 需加准确检测）|
| Ollama（转发）| — | 后备引擎 | 🔶 可选 |

> **本轮 P3 决策**：TTS 加入 **IndexTTS2 + VoxCPM + Audio8 TTS**；ASR 加入 **funasr（可选引擎）**；**LLM 暂不加新档位**（保留现有 Qwen3-8B + 0.5B）。

#### Omni / 端到端（需 GPU，参考）
- **Qwen3-Omni**（30B-A3B）、**MiniCPM-o 4.5**（9B · 12GB 端侧）、**GLM-4-Voice**（9B）——本地 GPU 部署参考，不在本次模型库首版范围。

#### FishAudio S2 专项：部署形态定案 · GPU 本地部署 · 量化档清单（2026 官方调研）

> **结论：S2 在当前版本可用——走云端 OpenAI 兼容层 `https://api.fish.audio/compat/v1`（`POST /v1/audio/speech`），直接复用现有 `cloud` TTS 引擎（`cloudTtsCall`），后端零协议改动，只需补 UI 配置入口。**
> 两个必知坑（官方兼容性契约）：① `voice` 必须是 Fish voice ID 或空串 `""`；OpenAI 预设名 `nova`/`echo` 等会 400；② 现有 `cloudTtsCall` 默认 `voice:'alloy'` 不会报错——小写 `alloy` 恰好命中一个真实 Fish 音色，会**静默合成无关音色**，接 S2 时必须改掉默认值。
> 云端模型档（`compat/v1/models` 实测）：`fish-audio/s2-pro`、`fish-audio/s2.1-pro`（均 $15/百万 UTF-8 字节）、**`fish-audio/s2.1-pro-free`（免费，测试用，无生产延迟保证——建议先免费验证链路）**。

**① 官方本地部署要求（有 NVIDIA GPU 时才考虑）**
- 硬件/系统：**24GB 显存**、Linux / WSL、CUDA（cu126/cu128/cu129）；CPU-only 可装但极慢；Intel Arc XPU 有支持；**macOS 无 MPS 路径、`--compile` 明确不支持**。
- 服务形态：仓库自带 `tools/api_server.py`（**自有协议 `POST /v1/tts`，非 OpenAI 兼容**）；生产级串流走 SGLang-Omni / vLLM-Omni；另有 Docker 镜像（GPU/CPU）。
- 接入本项目方式：在 `asr-server` 的 `TTS_ENGINES` 新增一个"独立协议"引擎（仿 azure / cosyvoice-cloud 注册方式）转发 `/v1/tts` + UI 加选项——中等工作量。

**② 量化档清单（fp8 / GGUF 均为社区非官方发布；官方仅 s2-pro 一个权重档）**

| 档位 | 大小 | 运行时 | 适用硬件 | 本机 M4/16GB 可用？ |
|---|---|---|---|---|
| 官方 BF16 权重 | ≈9.1GB（4.56B 参数） | fish-speech / SGLang / vLLM | NVIDIA ≥24GB，Linux/WSL | ❌ |
| fp8 社区版（[drbaph/s2-pro-fp8](https://huggingface.co/drbaph/s2-pro-fp8)、AEmotionStudio/fish-speech-s2-pro-fp8 等） | ≈4.6GB | vLLM 等 NVIDIA 服务端 | 现代 N 卡（fp8 指令集） | ❌（Apple Silicon 无 fp8 支持） |
| GGUF f16（[rodrigomt/s2-pro-gguf](https://huggingface.co/rodrigomt/s2-pro-gguf)） | 9.9GB | s2.cpp | CPU/Vulkan/CUDA/**Metal** | ⚠️ 16GB 统一内存偏紧 |
| GGUF q8_0 | 5.6GB | s2.cpp | 同上 | ✅ 近无损，可试 |
| GGUF q6_k | 4.5GB | s2.cpp | 推荐 6GB+ 显存档 | ✅ **推荐** |
| GGUF q5_k_m | 4.0GB | s2.cpp | 同上 | ✅ |
| GGUF q4_k_m | 3.6GB | s2.cpp | 最紧凑可用档 | ✅ |
| GGUF q3_k / q2_k | 3.0 / 2.6GB | s2.cpp | 实验档（短词拉伸） | ⚠️ 质量明显下降 |

- **[s2.cpp](https://github.com/rodrigomatta/s2.cpp)**：社区 C++/GGML 推理引擎（**ALPHA 状态**），纯 C++ 无 Python 依赖，**支持 Metal 后端（macOS / Apple GPU）**；GGUF 权重含 transformer + audio codec 单文件。带 CLI + HTTP server（`POST /generate`，multipart 表单；支持 PCM16 流式 / 逐句合成 / 低延迟预设 / 参考音频克隆与 `.s2voice` 音色档案）。
- **本机接入路径（理论可行，未实测速度）**：编译 s2.cpp（`-DS2_METAL=ON`）→ 起 HTTP server → `asr-server` 新增引擎转发 `/generate`。因 ALPHA + 未实测 RTF，列为候选，不进本轮范围。
- ⚠️ 所有本地权重档（含量化版）均继承 **FISH AUDIO RESEARCH LICENSE**：研究/非商用免费；**商用需向 fish.audio 单独书面授权**。走云端按量付费则不受此许可证约束。

### 3.4 需要为每个候选模型落实的字段
- `engine` 标识、`label`、`size`、`category`
- **下载 URL**（优先 hf-mirror 镜像）
- **预期文件大小（字节）** 用于安装检测
- **GGUF / 文件头 magic**（模型文件类型）
- **启用方式**（走现有 `/speak` `/transcribe` `/chat` 哪个引擎；需新增哪个 Python/子服务进程）
- **安装后生效**：调 `llmInvalidate()`（LLM）或对应引擎重载，免重启

### 待确认
- 每个候选模型（IndexTTS2 / VoxCPM / Audio8 / funasr）的下载源与预期大小需在实现时**实测登记**（不得猜测）。
- ~~FishAudio S2 的"当前版本可用性"~~ **已定案（2026 官方调研，见 §3.3 S2 专项）**：走云端 OpenAI 兼容层 `api.fish.audio/compat/v1` 复用 `cloud` 引擎；本地权重路线当前无 N 卡不可行，s2.cpp GGUF/Metal 为候选观察项。

---

## P4 · 延伸规划（暂不实现，登记备查）

> 来自用户兴趣点，属**后续延伸**，不在本轮 P3 首版范围。

### 4.1 FishAudio S2 + Qwen-TTS 声音设计组合
- **想法**：把 FishAudio S2 与 Qwen3-TTS 结合做"声音设计"（如音色/风格混合、多角色、精细韵律控制）。
- **现状判断**：**已定案——S2 经云端 compat/v1 可用（复用 cloud 引擎），P4 组合的前提已成立**。S2 核心卖点即 `[whisper]` `[excited]` 等 15000+ 自然语言行内标签（随 `input` 文本下发）；组合方案落地前只需先补 cloud 引擎的 UI 配置入口。（兼容层是否透传行内标签建议首验时实测一条。）
- 参考：fish.audio 官方（S2 已开源、AA 开源 TTS 第一梯队）。

### 4.2 ComfyUI 工作流 / 集成进 App 的工作流
- **来源**：博主 **T8 STAR-AIX** 的 ComfyUI 教程，展示"语音生成工作流"（可能含 S2 / 声音设计）。
- **方向**：把该 ComfyUI 方案**或**作为独立 ComfyUI 用法，**或**集成进 App 成为"工作流"功能（节点式编排语音/音色/合成）。
- **状态**：延伸规划。执行前需：确认 T8 STAR-AIX 教程内容与许可、ComfyUI 集成成本、与现有 asr-server 引擎的关系。

---

## 三、执行顺序建议
1. **P3 安装检测机制**先落地（它决定模型库体验，也复用 006 §4.1 已有 `.part+rename` 机制）——先完善"准确安装检测"。
2. **P1 CI + publish**（打通分发，GitHub Release）。
3. **P2 UI 打磨**（去 emoji、圆角、i18n、明暗），按小阶段推进。
4. P4 延伸规划（S2 声音设计 / ComfyUI）——视 S2 接入成熟后再评估。

## 四、待拍板决策点汇总
- P1：首版是否只出 macOS；Release tag 规范。
- P2：Iconify 图标集；i18n 语种；明暗主题默认策略。
- P3：IndexTTS2 / VoxCPM / Audio8 TTS / funasr 的下载源与预期大小（实现时实测登记）；`audio8` 已确认 = Audio8 TTS；~~S2 接入通道~~ **S2 已定案：云端 compat/v1 复用 cloud 引擎（见 §3.3 S2 专项）**。
- P4：S2+Qwen3 声音设计组合是否推进；ComfyUI 集成 vs 独立用法。
- **Electron 平行版本**：见 `008-electron版本规划.md`（Electron 为主、Tauri 保守维护）。
