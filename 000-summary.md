# 000-SUMMARY · Tabu-Local 语音工作台（项目总览）

> 定位：面向后续快速上手/接手的**项目总览**，不是开发流水账。讲清"是什么、整体怎么搭的、能做什么、有哪些坑"，帮你 5 分钟建立全貌。
> 现状：**已可独立完整使用**（识别 / 朗读[含历史] / 对话[含历史] / 语音工作台 / 实时语音 / 模型管理 / 音频库 / 音色管理 / 设置），且是**开放端口后端**（`9528`）可被插件/网站/CLI 接入。
> 衔接：接口细节见 `SPEC.md`（其 §六 = 本地数据存储规范摘要）/ `GUIDE.md`；音频库·对话历史·存储规范的方案与决策见 `011`（P1–P4 已全部落地）；后续任务规划以 `006-voice-后续规划.md` 为参考。

---

## 一、项目是什么

一个 **Tauri 桌面 App（macOS 优先）+ 本地语音服务** 的一体化产品，对标"Ollama 之于大模型"——用一个 App 管好"完整语音链路"（ASR → LLM → TTS），同时：

- **独立模式**：自带 GUI，界面里完成 识别 / 朗读 / 对话 / 语音工作台 全流程。
- **服务模式**：App 启动即在本地拉起 HTTP 服务（`9528`），任何网站 / 浏览器插件(Tabu-AI) / 其它 App / CLI 都能接入本地语音与 LLM。

**设备**：Apple M4 / 16GB 统一内存，全本地推理，隐私优先（音频/推理不出本机，云端来源才出网）。

---

## 二、整体架构

分四层，各层独立、通过 HTTP/端口解耦：

```
┌─ Tauri 壳 (Rust, src-tauri/) ──────────────┐
│  窗口/托盘 · 拉起并守护服务 · 原生录音(cpal) · 本地数据落盘 │
└──────────────┬──────────────────────────────┘
               │  spawn 子进程
┌─ 本地语音服务 (asr-server/, Node.js) ────────┐
│  9528 主服务：/transcribe /speak /chat /voice-chat  │
│  /clone /voices /voice-preview /health /models      │
└───┬──────────────┬───────────────┬──────────┬──────┘
    │ 转发          │ 转发           │ 转发      │ 内嵌
┌────▼───────┐ ┌────▼────────┐ ┌────▼──────┐ ┌▼──────────┐
│ qwen3-tts  │ │ sensevoice- │ │ cosyvoice │ │ sherpa-   │
│ 8001 (py)  │ │ original    │ │ 克隆       │ │ onnx      │
│            │ │ 8002 (py)   │ │ 8003 (py) │ │ kokoro/   │
└────────────┘ └─────────────┘ └───────────┘ │ whisper   │
                                             └───────────┘
┌─ 前端 (ui/, React+Vite) ────────────────────┐
│  9 个面板：工作台/朗读/识别/实时/对话/模型/音频库/音色/设置 │
└─────────────────────────────────────────────┘
```

- **`asr-server/`（Node.js, 9528）**：核心引擎总入口，聚合 ASR/TTS/LLM/克隆，并转发到各 Python 子服务。模型默认从 hf-mirror 下载。
- **Python 子服务（独立进程，避免污染 Node 主服务）**：
  - `qwen3-tts-server.py`（8001）：Qwen3-TTS 0.6B，MPS 低延迟朗读。
  - `sensevoice-server.py`（8002）：SenseVoice **原始版**（funasr，`model.pt`），另加载标点 + VAD 模型。
  - `cosyvoice-tts-server.py`（8003）：CosyVoice3 本地语音克隆（`.venv-cosyvoice`，MPS），`/clone /speak /voices`。
- **`src-tauri/`（Rust）**：桌面壳。窗口/托盘/系统集成；`start-all.js` 拉起守护服务；原生录音（cpal）；**本地数据统一持久化**——`audio_store.rs`（音频库：落盘/索引/导出/头部自愈）、`conversation_store.rs`（对话历史）、`config.json` 统一配置（启动项 + GUI 设置 `ui` 节：服务地址/token/云端 API Key）。
- **`ui/`（React + Vite）**：GUI。`api.ts` 封装后端调用与设置缓存（启动时从 config.json 载入，含 localStorage 旧数据一次性迁移），`audio.ts` 统一录音/播放/帧流，`audioStore.ts` / `conversationStore.ts` 分别封装音频库与对话历史的存取，`toast.ts` 全局保存提示。

---

## 三、支持的技术路径（能力矩阵）

### 语音识别 ASR
| 引擎 | 实现 | 说明 |
|---|---|---|
| SenseVoice 量化版 | sherpa-onnx `model.int8.onnx`（228MB） | 快、省内存，中英日韩粤 |
| SenseVoice **原始版** | funasr `model.pt`（897MB，Python 8002） | 精度更高；多语言自动检测 |
| Whisper | transformers.js q8 | 多语兜底 |

**后处理（可选，默认开）**：
- **自动标点**：funasr `punc_ct-transformer`（`/punc`），给无标点文本加标点，改善 LLM 理解与 TTS 停顿。
- **VAD 过滤静音**：funasr `fsmn_vad`（`/vad`），识别前裁剪静音，识别更干净更准。

### 语音合成 TTS
| 引擎 | 实现 | 说明 |
|---|---|---|
| Kokoro | sherpa-onnx-node（53 音色） | CPU 轻量兜底，中英混合 |
| Qwen3-TTS | Python 8001（MPS） | 低延迟，9 预设音色，流式 |
| **CosyVoice3 克隆** | Python 8003（MPS，本地） | **克隆音色 → 合成**，`engine=clone` |
| 云端 OpenAI 兼容 | 转发 /audio/speech | 需 Base URL + Key |
| Azure TTS | 独立 SSML 协议 | 需 Key + Region |
| CosyVoice（云端） | DashScope multimodal-generation | 需 Key |

> **帧流采样率事实（重要）**：本地三引擎的 `/speak` 帧流每帧都是完整 WAV，且均为 **24kHz 单声道 16-bit**（kokoro/qwen3/cosyvoice）。逐帧播放用各帧自带的头；把帧合并归档时必须从首帧读真实参数写合并头——**不可写死 16kHz**，否则重播变慢变调（踩坑见 §7.7）。

> **规划中 · FishAudio S2（007 已定案）**：
> - **云端（当前版本即可用）**：fish.audio 提供 OpenAI 兼容层 `https://api.fish.audio/compat/v1`（`POST /v1/audio/speech`），复用上表「云端 OpenAI 兼容」通道即可；模型档 `s2-pro` / `s2.1-pro`（$15/M UTF-8 bytes）、`s2.1-pro-free`（免费测试档）。⚠️ `voice` 必须填 Fish voice ID 或空串——现有 `cloudTtsCall` 默认 `alloy` 会静默合成无关音色，接入时须改默认值。
> - **本地（需 GPU，当前本机不可行）**：官方权重 S2-Pro 4B 要求 NVIDIA ≥24GB 显存 + Linux/WSL（自有协议 `/v1/tts`）；fp8 社区量化仅限 N 卡。**本机 M4/16GB 唯一可行路线 = 社区 s2.cpp（ALPHA）+ GGUF q4~q8 档走 Metal**（q6_k 4.5GB 推荐），需在 asr-server 新增引擎转发其 HTTP `/generate`，未实测速度，列为候选。
> - 详见 `007 §3.3 FishAudio S2 专项`。

### 对话 LLM
| 引擎 | 实现 | 说明 |
|---|---|---|
| llama-cpp | node-llama-cpp 内嵌 | 默认，GGUF 本地 |
| Ollama | 转发 | 后备 |

### 全链路
- `POST /voice-chat`：语音 → ASR → LLM → TTS 一次完成（识别 + 回答 + 音频）。

### 录音 / 音频库 / 对话历史（本地数据）

- 录音：Tauri 原生 `cpal`（macOS WebView 无 getUserMedia）→ 16kHz 单声道 WAV；Web API 回退。
- **音频库**：所有面板产生的音频统一落盘 `app_data_dir()/audio/`（`recordings/` + `tts/` + `index.json`）；asset protocol 播放；删除 / 导出 zip（wav+txt）。
  - **来源角标**：每条记录带 `source` 字段标记产生它的界面——识别(asr)/工作台(home)/对话(chat)/实时(realtime)/音色导入(voice)/朗读(read)，列表显示彩色角标；旧记录按 kind 回退显示「识别/朗读」。
  - **元数据快照**：tts 记录保存 voice/sid/speed/language 参数与 `interrupted` 截断标记（`serde(default)` 向后兼容旧索引），列表可见所用音色。
  - **保存语义**：流读完（含被手动停止中断）即合并落盘，**不等播放完成**——中途关 App 不丢音频；停止时 AbortController 中断合成请求（服务端不再白算），已收帧以「已截断」角标入库，0 帧则不入库；入库成功有 toast 提示。
  - **头部自愈**：打开音频库/朗读面板时自动两级幂等修复历史文件（坏头重建 + 错标 16k 的 24k 文件改回真实采样率），见 §7.7。
- **朗读历史区块**：朗读面板内嵌最近 20 条（与音频库同源），可重听/删除，「在音频库中查看」一键跳转。
- **对话历史**：`conversations/index.json`（会话列表）+ `<session_id>.json`（消息全文，按会话分文件）；每轮对话后自动保存（不设上限、手动删）；标题=首条提问前 20 字；回答的朗读音频 id 关联回对应消息（`tts_audio_id`，为"点击重听当轮回答"埋点）。
- **存储规范**：GUI 用户数据全部集中 app_data_dir，目录树与六原则见 `SPEC.md §六`；设置面板提供「📂 打开数据文件夹」入口与路径展示。

### 端口约定（保持兼容）
| 端口 | 服务 |
|---|---|
| 9528 | asr-server（主入口） |
| 8001 | qwen3-tts |
| 8002 | sensevoice-original（funasr） |
| 8003 | cosyvoice-tts（本地克隆） |

---

## 四、UI 面板（`ui/src/panels/`）

| 面板 | 文件 | 功能 |
|---|---|---|
| 语音工作台 | `HomePanel.tsx` | 说→想→读 一键闭环 |
| 朗读 | `ReadPanel.tsx` | 文本→TTS，引擎/音色/语速；内嵌「朗读历史」区块（最近 20 条可重听/删除） |
| 识别 | `AsrPanel.tsx` | 录音→文本；引擎选择 + 标点/VAD 开关 |
| 对话 | `ChatPanel.tsx` | 文字/语音→LLM→朗读；顶部「新会话 / 历史▾」，每轮自动保存、跨重启恢复 |
| 模型管理 | `ModelsPanel.tsx` | 查看/下载模型（`/models`+`/install-model`） |
| 音频库 | `AudioLibraryPanel.tsx` | 我的录音 / 朗读历史，来源角标（识别/朗读/对话/工作台/实时/导入）、播放/删除/导出/标记样本 |
| 音色管理 | `VoicePanel.tsx` | **克隆音色**：新建（音频库样本 / 导入音频+ASR 识别）、生成、试听（秒开）、改名/删除 |
| 设置 | `SettingsPanel.tsx` | 服务地址/asr-server 路径/Token/云端 API Key——修改后防抖自动保存+toast；「打开数据文件夹」入口 |

---

## 五、已完成功能清单

- 本地 ASR：SenseVoice（量化 + 原始两档）、Whisper、VAD 过滤、自动标点。
- 本地 TTS：Kokoro、Qwen3-TTS（流式）；云端 OpenAI 兼容 / Azure / CosyVoice 云端。
- 本地 LLM：llama-cpp + Ollama。
- 全链路 voice-chat、语音工作台。
- **语音克隆（006 T1）**：CosyVoice3 本地克隆——音色管理面板新建（音频库样本或**导入音频+ASR 识别文本**）、生成音色、预生成试听音频秒开试听、改名/删除；朗读/对话引擎可选「克隆音色」。
- 录音链路（macOS cpal + CORS 修复）、音频库落盘/播放/删除/导出；**来源角标 + 元数据快照 + 坏头自愈（011 P1/P2）**；朗读面板内嵌历史区块、停止语义（中断合成、已截断入库）。
- **对话历史持久化（011 P3）**：会话每轮自动保存 / 历史下拉恢复 / 删除，跨重启可用；朗读音频 id 关联回消息。
- **设置与存储规范化（011 P4）**：服务地址/token/云端 API Key 迁入 config.json（localStorage 一次性自动迁移），设置项防抖自动保存 + toast，「打开数据文件夹」入口。
- 桌面壳：窗口/托盘常驻/拉起守护服务/模型管理 UI。
- 开放后端：`9528` + CORS + SPEC 文档。

---

## 六、语音克隆（CosyVoice3）实现说明

> 006 T1 已完成。模型在 `005` 方案A全量下载；克隆引擎 = CosyVoice3（`Fun-CosyVoice3-0.5B`）。

### 6.1 架构与流程
```
GUI 新建音色 ──▶ 参考音频(base64) + 参考文本 ──▶ asr-server 9528 /clone
                                                ──▶ cosyvoice-tts-server 8003
                                                     ├ 存 ref.wav + config.json 到 data/clone-voices/<vid>/
                                                     ├ add_zero_shot_spk 缓存音色特征（内存）
                                                     └ 预生成 preview.wav（试听秒开）
合成：/speak?engine=clone&voice=<vid> ──▶ 8003 /speak 用缓存特征 → 帧流
```

- **音色存储**：`asr-server/data/clone-voices/<voice_id>/`（`ref.wav` 参考音频 + `config.json` + `preview.wav` 试听音频）。
- **关键机制**：CosyVoice3 零样本克隆 = 保存参考音频 + 参考文本；`add_zero_shot_spk` 缓存音色特征，`inference_zero_shot` 用 `zero_shot_spk_id` 直接合成（多音色并存）。
- **试听**：生成音色时即预合成一段试听句存 `preview.wav`，试听走 `/voice-preview` 直接播（秒开）；旧音色启动时自动补生成。
- **导入音频克隆**：新建面板可导入本地音频 → 转 16kHz 单声道存音频库 → 自动 ASR 识别文本填入参考提示（可核对修改，准确文本提升克隆质量）。

### 6.2 依赖与模型
- Python 环境：`asr-server/.venv-cosyvoice`（复用系统 torch 2.8 MPS）。
- CosyVoice 源码：`asr-server/CosyVoice/`（官方仓库 + `third_party/Matcha-TTS` 子模块）。
- 需额外装：`transformers==4.51.3` `x-transformers==2.11.24` `diffusers==0.29.0` `conformer==0.3.2` `einops` `hyperpyyaml` `inflect` `openai-whisper` `gdown` `matplotlib` `pyworld` `rich` `tensorboard` `lightning` `pyarrow` `tiktoken` `wget`；运行时需 `NUMBA_CACHE_DIR` / `MPLCONFIGDIR`（避免 numba/matplotlib 缓存报错）。

### 6.3 对外接口（详见 SPEC）
- `POST /clone`、`GET /voices`、`POST /voice/rename`、`POST /voice/delete`、`GET /voice-preview?voiceId=`
- `POST /speak?engine=clone`（帧流）、`/voice-chat?ttsEngine=clone`
- `/health` 的 `tts.cosyvoice` 上报就绪；`/models` 上报 `cosyvoice-clone`

---

## 七、踩坑记录（单独章节）

> 供后续避免重蹈，均为实际遇到并解决的问题。

### 7.1 旧 asr-server 进程占端口 → "实际启用但显示 ✗"（⚠️ 最影响体验）
- **现象**：App 重新构建后，识别面板"原始版"显示 ✗，且原始版中文识别成英文。
- **根因**：一个**旧的 asr-server 进程**（手动启动或未彻底退出）一直占着 `9528`。App 重启后新 asr-server 绑不上端口，App 连的还是旧进程——旧代码没有 `sensevoice-original` 逻辑，导致 `/models` 不上报它（徽标 ✗），且选该引擎时回退到 Whisper（中文变英文/乱码）。
- **排查方法**：`curl 127.0.0.1:9528/health` 看 `engines` 是否含 `sensevoice-original`；`lsof -nP -iTCP:9528` 看占端口进程。
- **解决**：`kill <旧pid>` 释放 9528，再启动新代码；或 App 完全退出重开。
- **已从根上解决（006 T2）**：`start-all.js` 启动时探测 9528 的 `version` 指纹，若是旧代码则自动终止残留进程并重启——App / `npm run all` 均生效，不再出现"显示 ✗ 但实际可用"。

### 7.2 macOS TCC 弹"访问文稿"多次（项目在 `~/Documents` 下）
- **现象**：App 启动连续弹"文稿"文件夹访问授权（多次）。
- **根因**：项目位于 `~/Documents/GitHub/Tabu-Voice`，App 拉起的 node/python 子进程读写项目内模型/配置文件，被 macOS 视为访问受 TCC 保护的"文稿"，且**未签名 App** 的授权缓存不稳定 → 多次弹。
- **解决**：弹窗点"允许"即可记住；**公开发布签名/公证后通常只弹一次**。
- **长期**：如需彻底避免，可把模型/运行数据移出 `~/Documents`（但项目要公开，目录明确性更重要，暂不移）。

### 7.3 两个 Python venv 内容重复
- `cut-pic`（另一项目）曾有两个几乎相同的 venv；本项目 `asr-server` 的 qwen3 用 `.venv-qwen3`，funasr 用系统 python3（`/opt/homebrew/bin/python3`），**不要重复装同一套大依赖**。

### 7.4 SenseVoice 原始版初次加载慢
- funasr 加载 `model.pt`（897MB）需几十秒，期间 `8002 /health` 的 `ok=false`，App 徽标可能暂显 ✗；加载完成后即 ✓。**这是正常的**，非故障。

### 7.5 WKWebView 无 getUserMedia
- macOS WebView 无 `navigator.mediaDevices.getUserMedia`，录音必须走 Rust 原生（cpal）——已解决（见 000 规划 §六）。

### 7.6 语音克隆（CosyVoice3）踩坑
- **CosyVoice3 参考文本必须含 `<|endofprompt|>`**：`llm.py` 会断言否则合成失败。后端 `/clone` 已对 referenceText 自动加 `You are a helpful assistant.<|endofprompt|>` 前缀。
- **`.venv-cosyvoice` 的 torch 版本**：`pip install` 某依赖（x-transformers/torch-einops-utils 链）可能把 torch 升级进 venv，与系统 torchaudio 2.8 不匹配 → 需卸载 venv 内 torch/numpy 回落系统自洽版本（torch 2.8 + numpy 2.4 + torchaudio 2.8）。
- **CosyVoice 依赖多且逐个缺**：yaml 加载会 import 大量模块，逐个补装 `wget/matplotlib/lightning/pyarrow/tiktoken/gdown` 等；运行时需 `NUMBA_CACHE_DIR`/`MPLCONFIGDIR`（numba/matplotlib 缓存报错）。
- **Tauri 里读参考音频不能用 `fetch(asset URL)`**：WKWebView 抛 `NotSupportedError`。改用 Rust 原生命令 `audio_read_base64`（按 id 读音频库文件返回 base64）。
- **`/speak` 返回帧流不是单 WAV**：直接丢给 `<Audio>` 会 `NotSupportedError`。试听需用帧流播放器 `createFramePlayer`；本功能改为生成音色时预生成 `preview.wav`，试听走 `/voice-preview` 直接播（秒开）。
- **启动慢**：cosyvoice 服务启动时会对每个已有音色重建特征 + 补生成 preview，音色多则就绪慢（一次性，非故障）。

### 7.7 朗读音频无法播放 / 重播"变声"（WAV 头两连坑，011 P2 验收时发现）
- **现象①**：朗读实时播放正常，但音频库/历史里重播报"文件可能已删除"。
  **根因**：`mergeWavFrames` 用游标 `o` 连写头部字符串——`ws("RIFF")` 后游标停在 4，`setUint32(4,…)` 刚写入的 RIFF 尺寸又被 `ws("WAVE")` 从偏移 4 覆盖，导致尺寸丢失、所有块名整体前移 4 字节，系统级无法解码（`afinfo` 报 `AudioFileOpenURL failed`）。录音走 `pcmToWavBlob`（绝对偏移写头）所以只有帧流合并的朗读坏——这个 bug 从 003 起一直存在。
- **现象②**：头部修好后重播**变慢、音调压低，像换了个人**（文本正确）。
  **根因**：本地三引擎帧实际都是 **24kHz**（见 §三），而合并头写死 16kHz → 24k 数据按 16k 播放；第一版修复也写死 16k，又把一批文件错标。
- **解决（现行实现）**：合并函数改为绝对偏移写头 + **从首帧读真实采样率/声道/位深**；时长估算同样按头解析（base64 只解前缀）；Rust `audio_get_dir` 打开面板时两级幂等自愈——①坏头重建（按记录的 engine 取真实采样率）②错标 16kHz 的 24k TTS 文件改回并同步纠正索引时长。
- **教训**：二进制格式拼装一律用绝对偏移；采样率/声道等参数永远从头里读、不写死；排查组合拳 = `xxd -l 48 file.wav` 看头 + `afinfo file.wav` 验证系统能否解码。

---

## 八、启动方式

```bash
cd asr-server
npm install
npm run all          # 一键拉起 asr-server(9528) + qwen3(8001) + sensevoice-original(8002) + cosyvoice(8003)
# 可选：TABU_SKIP_QWEN3=1 跳过 qwen3；TABU_SKIP_SENSEVOICE_ORIGINAL=1 跳过原始版
#       TABU_SKIP_COSYVOICE=1 跳过克隆服务（省内存/加载时间）
# 单独：npm run start-sensevoice-original  # funasr 原始版
```
桌面 App：`npm run build`（tauri build，需 rustc ≥1.88）→ 运行生成的 `.app`；或 `npm run dev`（tauri dev）。

> ✅ 工具链现状（2026-08-22 更新）：已卸载 Homebrew 的 rust 1.86，全机只剩 rustup 管理的 stable 1.97——直接 `npm run build` 即可；以后升级 Rust 用 `rustup update`。背景：此前 brew 旧版在非交互 shell 里抢占 PATH 导致构建报"rustc 版本不够"，已从根上消除。

---

## 九、后续任务（详见 006 / 011）
Realtime 实时语音（T3）、CI 三平台打包（T4）、本地 LLM 增强（T5）、音频库增强（T6）；克隆阶段C 剩余「音色与原始录音解耦」（可删录音保留音色）。
011 遗留候选（本期明确不立项）：「按原参数重读」按钮（元数据快照已备好）、「预读缓冲」抹平句间卡顿、对话消息点击重听当轮回答（`tts_audio_id` 关联已埋点）。
