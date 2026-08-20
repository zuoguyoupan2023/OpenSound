# 000-SUMMARY · Tabu-Local 语音工作台（项目总览）

> 定位：面向后续快速上手/接手的**项目总览**，不是开发流水账。讲清"是什么、整体怎么搭的、能做什么、有哪些坑"，帮你 5 分钟建立全貌。
> 现状：**已可独立完整使用**（识别 / 朗读 / 对话 / 语音工作台 / 模型管理 / 音频库 / 设置），且是**开放端口后端**（`9528`）可被插件/网站/CLI 接入。
> 衔接：接口细节见 `SPEC.md` / `GUIDE.md`；**后续任务规划以 `006-voice-后续规划.md` 为最新参考**。

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
│  窗口/托盘 · 拉起并守护服务 · 原生录音(cpal) · 音频库落盘 │
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
│  8 个面板：工作台/朗读/识别/对话/模型/音频库/音色/设置 │
└─────────────────────────────────────────────┘
```

- **`asr-server/`（Node.js, 9528）**：核心引擎总入口，聚合 ASR/TTS/LLM/克隆，并转发到各 Python 子服务。模型默认从 hf-mirror 下载。
- **Python 子服务（独立进程，避免污染 Node 主服务）**：
  - `qwen3-tts-server.py`（8001）：Qwen3-TTS 0.6B，MPS 低延迟朗读。
  - `sensevoice-server.py`（8002）：SenseVoice **原始版**（funasr，`model.pt`），另加载标点 + VAD 模型。
  - `cosyvoice-tts-server.py`（8003）：CosyVoice3 本地语音克隆（`.venv-cosyvoice`，MPS），`/clone /speak /voices`。
- **`src-tauri/`（Rust）**：桌面壳。窗口/托盘/系统集成；`start-all.js` 拉起守护服务；原生录音（cpal）；音频库持久化（`audio_store.rs`）。
- **`ui/`（React + Vite）**：GUI。`api.ts` 封装后端调用，`audio.ts` 统一录音/播放/帧流。

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

### 对话 LLM
| 引擎 | 实现 | 说明 |
|---|---|---|
| llama-cpp | node-llama-cpp 内嵌 | 默认，GGUF 本地 |
| Ollama | 转发 | 后备 |

### 全链路
- `POST /voice-chat`：语音 → ASR → LLM → TTS 一次完成（识别 + 回答 + 音频）。

### 录音 / 音频库
- 录音：Tauri 原生 `cpal`（macOS WebView 无 getUserMedia）→ 16kHz 单声道 WAV；Web API 回退。
- 音频库：`audio_store.rs` 落盘到 `app_data_dir()/audio/`（`recordings/`+`tts/`+`index.json`）；asset protocol 播放；删除 / 导出 zip（wav+txt）。

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
| 朗读 | `ReadPanel.tsx` | 文本→TTS，引擎/音色/语速 |
| 识别 | `AsrPanel.tsx` | 录音→文本；引擎选择 + 标点/VAD 开关 |
| 对话 | `ChatPanel.tsx` | 文字/语音→LLM→朗读 |
| 模型管理 | `ModelsPanel.tsx` | 查看/下载模型（`/models`+`/install-model`） |
| 音频库 | `AudioLibraryPanel.tsx` | 我的录音 / 朗读历史，播放/删除/导出/标记样本 |
| 音色管理 | `VoicePanel.tsx` | **克隆音色**：新建（音频库样本 / 导入音频+ASR 识别）、生成、试听（秒开）、改名/删除 |
| 设置 | `SettingsPanel.tsx` | 服务端口、asr-server 路径、Token |

---

## 五、已完成功能清单

- 本地 ASR：SenseVoice（量化 + 原始两档）、Whisper、VAD 过滤、自动标点。
- 本地 TTS：Kokoro、Qwen3-TTS（流式）；云端 OpenAI 兼容 / Azure / CosyVoice 云端。
- 本地 LLM：llama-cpp + Ollama。
- 全链路 voice-chat、语音工作台。
- **语音克隆（006 T1）**：CosyVoice3 本地克隆——音色管理面板新建（音频库样本或**导入音频+ASR 识别文本**）、生成音色、预生成试听音频秒开试听、改名/删除；朗读/对话引擎可选「克隆音色」。
- 录音链路（macOS cpal + CORS 修复）、音频库落盘/播放/删除/导出。
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
桌面 App：`npm run build`（tauri build，需用 rustup 的 stable 工具链 ≥1.88）→ 运行生成的 `.app`；或 `npm run dev`（tauri dev）。

> ⚠️ 构建注意：本机 `PATH` 里的 `rustc` 是 Homebrew 旧版（1.86），tauri build 会因依赖要求 rustc≥1.88 失败——需用 `rustup run stable npm run build`（stable 已装 1.97）。

---

## 九、后续任务（详见 006）
Realtime 实时语音（T3）、CI 三平台打包（T4）、本地 LLM 增强（T5）、音频库增强（T6）；克隆阶段C 剩余「音色与原始录音解耦」（可删录音保留音色）。
