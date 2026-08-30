# 000 · 设备 ↔ 模型匹配指南（device-vs-model）

> 回答一个问题：**"我这台电脑，能装什么样的本地语音/对话模型？"**——本文既是给人看的选型指南，也是给 OpenSound 实现硬件检测与模型推荐功能的产品规格。
> 口径：2026-08-26 · 数据来源全部复用本仓库已实测登记的数字（002 / 005 / 006 / 007 / 001），未实测的一律标 ⚠️待实测登记（遵守 007 纪律：不得猜测）。
> 关联文档：`002-voice-research.md` §六（平台×加速矩阵）、`007`（模型库规划）、`006`（模型体积实测登记）、`001`（显存实判与 RTF 口径）、`005`（CosyVoice3 下载清单）

---

## 一、参照项目盘点（你记忆中的那些工具）

| 项目 | 它做什么 | 值得抄的机制 |
| --- | --- | --- |
| **LM Studio** | 检测本机硬件，按内存推荐能跑的 LLM 并下载 | "打开就知道自己能跑什么"的零配置体验 |
| [llmfit](https://github.com/AlexsJones/llmfit) | 分析硬件 → 输出"哪些模型装得下、量化档怎么选"的顾问工具 | 显式把"设备画像→模型清单"做成独立可测的逻辑 |
| **GPT4All** | 官方维护[内存→模型尺寸对照表](https://github.com/nomic-ai/gpt4all/blob/main/gpt4all-chat/system_requirements.md)（推荐 16GB；8GB 仅够 3B 档） | 用一张静态对照表代替复杂检测——简单可靠 |
| **Ollama** | 本地运行时 + 动态加载卸载 | 运行时按需加载，弱化"安装前判断"的重要性 |
| **Pinokio** | 一键安装 AI 应用（ComfyUI 等）的"AI 浏览器" | 把环境依赖打包成脚本，用户只点按钮 |
| **Stability Matrix**（绘画侧） | Stable Diffusion WebUI 包管理器 + checkpoint 管理 | 你记忆中"绘画 model 可安装配置"的那个——按显卡 VRAM 过滤可选模型的交互 |

**共同点**：都不训模型，只做"**设备画像 → 模型过滤 → 一键安装**"。这正是 OpenSound 模型管理页（P3）该有的形态。

---

## 二、一分钟自检：你的设备在哪一档

| 档位 | 设备画像（满足其一即可） | 能装什么（详见 §三） |
| --- | --- | --- |
| 🟢 入门档 | 内存 8GB 无独显；或 M1/M2 8GB | SenseVoice(量化) + Piper/Kokoro 朗读 + Whisper base + Qwen3-0.6B 对话。全功能可用，克隆与大模型除外 |
| 🔵 标准档 | 内存 16GB 的 Apple Silicon；或 NVIDIA 显存 ≥12GB（如 4070 Ti） | 上一档全部 + whisper large-v3(Metal/int8) + Audio8-TTS(INT4) + **CosyVoice3 克隆**（N 卡流畅 / Mac 慢速可用）+ Qwen3-8B(q4) |
| 🟣 高配档 | 内存 24–32GB；或 NVIDIA ≥16GB | 标准档全部 + 全量常驻组合（CosyVoice3+whisper ≈7GB 同驻）+ Qwen3-14B + FireRedASR-AED |
| 🔴 旗舰档 | 统一内存 ≥48GB 的 Mac；或双卡/24GB+ 多卡 | 多模型同时常驻 + FireRedASR-LLM(8.3B) 级精度档 |

> 你的两台开发机都在标准档：16GB M 系列 Mac、RTX 4070 Ti 12GB。

---

## 三、模型目录 × 资源需求总表

### 3.1 ASR（识别）

| 模型 | 磁盘体积 | 内存/显存需求 | 硬件底线 | 体验预期 | 项目状态 |
| --- | --- | --- | --- | --- | --- |
| SenseVoice sherpa 量化版 | ~228–239MB | 几百 MB RAM | 任何设备含入门档 | CPU 实时率<0.1，即说即出 | ✅ 默认引擎 |
| SenseVoice funasr 原始版 | ~2.1GB（900MB 主模型 + VAD + 标点） | ~1.5GB RAM | 入门档可用 | 高精度档 | ✅ 已装（055） |
| Whisper base (transformers.js) | 75–500MB | 浏览器内运行 | 入门档 | 兜底质量 | ✅ 已装 |
| whisper large-v3 (whisper.cpp GGUF) | ~3GB | Metal/CUDA 加速后流畅；CPU 慢 | 标准档起 | 多语兜底 CER 9.86 | 🔶 待接入 |
| faster-whisper large-v3 int8 | ~1.6GB 盘 / ~3GB 显存 | N 卡 int8 后轻松同驻 | 标准档（N 卡） | 原版 4 倍速 | 🔶 自托管档 |
| Paraformer-zh | ~226MB | CPU 可跑 | 入门档可用 | 中文 SOTA 级 + 真流式 | 🔶 候选 |
| FireRedASR2 (int8) | ⚠️待实测登记 | sherpa 同栈 | 标准档起 | 中文+方言精度第一 | 🔶 候选（002 排期） |
| Qwen3-ASR 0.6B int8 | ⚠️待实测登记 | 边缘设备可跑 | 标准档起 | 30 语+22 方言 | 🔶 候选 |

### 3.2 TTS（朗读）

| 模型 | 磁盘体积 | 需求 | 硬件底线 | 备注 |
| --- | --- | --- | --- | --- |
| **Piper** | 每语言 20–60MB | CPU 即实时 | 🟢 入门档 | 机械感但零门槛 |
| **Kokoro-82M** | ~350MB（006 实测登记） | CPU 可跑，GPU 更好 | 🟢 入门档 | TTS-Arena 高排名小钢炮，项目现役 |
| Qwen3-TTS（本项目 ：8001 所用） | ~2.3GB（006 登记） | 建议 GPU/MPS | 🔵 标准档 | 中文表现好 |
| Audio8-TTS-Preview-0.6b | fp16 ~2–3GB；官方 ONNX INT4 更小 | INT4 版可下探 CPU 甚至浏览器 | 🟢 入门档（INT4）/ 🔵 标准（fp16） | Apache-2.0 可商用（001 已核验） |

### 3.3 克隆（音色复刻）

| 模型 | 磁盘体积 | 推理需求 | 硬件底线 | 速度预期 |
| --- | --- | --- | --- | --- |
| **Fun-CosyVoice3-0.5B** | **~9GB**（005 清单） | fp16 推理 ≈4GB 显存/等效内存 | 🔵 标准档 | N 卡 RTF≈0.15–0.25（10 秒语音 2 秒出）；**Mac MPS RTF 0.5–1.5（慢速可用）**——001 §7.1 口径 |
| GPT-SoVITS | ~1–2GB | 低配友好 | 🟢 入门偏上 | 1 分钟样本微调克隆，中文生态第一（MIT） |

### 3.4 LLM（对话）——通用估算规则

> 规则：q4_K_M GGUF 文件体积 ≈ 参数量 × 0.6GB；**内存底线 = 文件体积 × 1.15 + 系统 2–4GB 开销**；Apple 统一内存下 GPU 可用约 75%（系统占用）。

| 模型档位 | q4 体积 | 内存底线 | 适配档位 |
| --- | --- | --- | --- |
| Qwen3-0.6B | ~0.4–0.5GB | 4GB | 🟢 入门 |
| Qwen3-4B | ~2.5GB | 8GB | 🟢 入门偏上 |
| Qwen3-8B（项目现役） | ~5GB | 12GB | 🔵 标准 |
| Qwen3-14B | ~9GB | 16GB | 🟣 高配（16GB 机勉强） |
| Qwen3-32B | ~19GB | 28GB | 🔴 旗舰 |

---

## 四、可执行方案：给 OpenSound 做"设备画像 → 模型过滤"

### 4.1 新增接口 `GET :9528/device-profile`

```jsonc
// asr-server 启动时探测一次并缓存
{
  "os": "darwin-arm64",
  "accel": "metal",              // metal | cuda | cpu
  "ramGB": 16,
  "gpu": { "vendor": "apple", "vramGB": null },   // N 卡时读 nvidia-smi
  "diskFreeGB": 42,
  "tier": "standard",            // entry | standard | high | flagship
  "canInstall": ["sensevoice", "sensevoice-funasr", "kokoro", "qwen3-tts", "cosyvoice3", "whisper-large-v3-metal", "qwen3-8b"],
  "cannotInstall": [
    { "engine": "firered-asr-llm", "reason": "需 ≥48GB 统一内存/多卡", "tierRequired": "flagship" }
  ]
}
```

探测手段：Node 内置 `os.totalmem()/cpus()`；GPU 用 `systeminformation` 库；N 卡显存 `nvidia-smi --query-gpu=memory.total --format=csv`；Mac 芯片代次 `sysctl -n machdep.cpu.brand_string`；磁盘 `checkDiskSpace` 类库。全部只读操作，无权限问题。

### 4.2 判定规则（伪代码，与 §三表格一一对应）

```
if ram >= 48 or vram >= 24*2: tier = flagship
elif ram >= 24 or vram >= 16: tier = high
elif ram >= 16 or vram >= 12: tier = standard
else:                         tier = entry

canInstall(engine) =
    diskFree >= engine.diskGB * 1.2            # 安装+解压余量
 && (engine.memNeed == null || usableMem() >= engine.memNeed)
 && (engine.accel == 'any' || accel == engine.accel)

usableMem() = apple ? totalMem * 0.75 : vram ?? totalMem * 0.6
```

### 4.3 模型管理 UI 改造点（验收标准）

1. 打开「模型库」3 秒内看到分组徽标：**✅ 可安装 / ⚙️ 可装但慢（黄色，标注预期速度，如"Mac 上克隆约 1:1 语速"）/ 🚫 设备不满足**；
2. 🚫 项点击显示缺口（"还差 6GB 磁盘"/"建议 16GB 内存机型"），而不是隐藏；
3. 首次启动若检测为入门档，默认勾选轻量组合（SenseVoice+Kokoro+Qwen3-0.6B），一键装齐即用；
4. 所有体积数字以 `/models` 接口的实测登记为准，禁止写死猜测值（007 纪律）。

---

## 五、数据来源与复用声明

- 体积数字：006（变更记录实测登记）、007（模型库表）、005（CosyVoice3 清单）
- 显存/RTF 口径：001 §三显存实判、§7.1 吞吐测算
- 平台×加速最优组合：002 §六平台表（macOS=Metal/MPS、Windows=CUDA）
- LLM 估算规则与 GPT4All 参照表：https://github.com/nomic-ai/gpt4all/blob/main/gpt4all-chat/system_requirements.md
- 参照项目：LM Studio / llmfit / Ollama / Pinokio / Stability Matrix（§一）
- ⚠️ 未实测项（FireRedASR2/Qwen3-ASR 体积等）接入时按 007 流程实测登记后回填本表

## 六、变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-08-26 | 初版：四档设备画像 + 四类模型资源总表（复用仓库实测数据）+ 匹配规则伪代码 + `/device-profile` 接口与 UI 验收标准 |
| 2026-08-26 | §四落地（S6）：① 新增 `asr-server/device-profile.js`（探测+tier+canInstall+缺口 blocks）与 `GET :9528/device-profile`（启动探测一次并缓存，失败 503 不阻塞）；② `engines/*.json` 全量登记 `profile`（diskGB/memNeedGB/accel/tierRequired/slowNote，数字取本表已登记口径，无登记打 null）；③ 模型库 UI（ModelsPanel）：设备摘要条 + ✅可安装/⚙️可装但慢/🚫设备不满足徽标 + 🚫点击展开缺口 + 入门档一键装齐轻量组合（sensevoice+kokoro+llm-0.5b）。canInstall 引擎 id 采用 engines/*.json 现有 id |
