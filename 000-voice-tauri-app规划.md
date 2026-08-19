# 000 · Tabu-Voice 桌面 App 规划（Tauri · 开放本地语音后端）

> 状态：**规划**（可作为 010 相位1 的落地文档；目录当前为 `Tabu-Voice/`，正式名 **Tabu-Local**）
> 目标：把本地语音服务做成一个**点开即用的 Tauri 桌面 App**——既能独立完整使用（识别/朗读/对话），又作为**开放端口后端**支撑 浏览器插件(Tabu-AI) / 网站 / 其它 App / 命令行终端 接入本地语音与 LLM 能力。
> 关联文档：`007`（本地 ASR/TTS 实现与踩坑）、`008`（语音助手）、`009`（桌面 App 愿景）、`010`（本地语音一体化 voice-server）、`011`（项目拆分）、`013`（性能/硬件加速）、`014`（TTS 调研）、`015`（Tabu-AI 能力来源）、`016`（手机 ASR 调研）、`017`（浏览器 SenseVoice）。
> 本文件是「Tabu-Voice 作为桌面 App + 后端」的**专项规划**；接口细节以 `Tabu-Voice/GUIDE.md`（调用指南）与 `000-backend.md`（启动手册）为准。

---

## 〇、结论速览

| 维度 | 结论 |
|---|---|
| 形态 | **Tauri（Rust + Web 前端）桌面 App**，一个应用承载「本地语音服务 + GUI」 |
| 交付节奏 | **macOS 本机先跑通**（当前开发/测试环境）→ GitHub Actions **CI 构建 Windows / Linux / macOS** 三平台安装包 |
| 双模式 | **服务模式**：App 启动即拉起本地服务，暴露 HTTP/WS 端口，供 tabu-ai / 网站 / 其它 app / CLI 接入；**独立模式**：App 自带完整 GUI，直接在界面里完成 识别 → LLM → 朗读 全流程 |
| 对外开放 | App 内提供 **SPEC 规范文档**（`SPEC.md` / GUIDE），定义端口、鉴权、请求/响应、模型清单——任何外部方都能接 |
| 兼容现状 | 保留 asr-server 现有端口习惯（9528 主服务 / 8001 qwen3 / 9527 bridge），**保证 Tabu-AI 现有接入不改** |
| 模型路线 | 现状：SenseVoice/whisper(ASR) + Kokoro/Qwen3(离线 TTS) + llama-cpp/Ollama(LLM)；未来：**实时语音(Realtime)**、**语音克隆 TTS**、更多 ASR/TTS、本地 LLM 内置 |
| 定位 | 像 **Ollama** 管大模型那样管「完整语音链路」，且带 GUI、可独立使用 |

---

## 一、核心要求落地（5 条）

### 1.1 创建 Tauri App
- 桌面壳：**Tauri 2**（Rust core + 前端 Webview），轻量、低内存、Rust 侧可直接管本地服务进程与模型文件。
- 仓库：建议独立 `Tabu-Voice/`（当前目录）升级为 Tauri 工程，或 `tabu-local` monorepo。
- 结构：
  ```
  Tabu-Voice/
   ├─ src-tauri/            # Rust：窗口、托盘、系统集成、拉启/守护 voice-server 子进程
   ├─ ui/ (前端)            # 可选：内置 GUI 界面（识别/朗读/对话/模型管理）
   ├─ asr-server/           # 现有 Node 语音服务（核心引擎，作为子进程被拉起）
   ├─ SPEC.md               # 对外开放接口规范（核心交付物之一）
   └─ GUIDE.md / README.md
  ```

### 1.2 点开即用（macOS 先测，CI 多平台）
- **macOS 本机验证**：`npm run all`（已集成 qwen3 镜像修复）→ Tauri 壳拉起 asr-server(9528)+qwen3(8001)，托盘常驻，`/health` 就绪即"点开可用"。
- **GitHub Actions CI**：
  - 矩阵：`macos-latest` / `windows-latest` / `ubuntu-latest`。
  - 步骤：装 Node + Rust toolchain → 装 Python venv(qwen3) + 依赖 → 下载/校验模型 → `tauri build` → 产物上传（`.dmg`/`.msi`/`.deb`+`.AppImage`）。
  - 注意：模型体积大（SenseVoice 228M + Kokoro 350M + Qwen3 2.3G + LLM 469M），**首版可做成"首次启动按需下载模型"**（复用 `install-model` NDJSON 进度流），安装包只含壳。

### 1.3 提供端口，保障 Tabu-AI 可用，并写规范文档
- **端口约定（保持兼容）**：
  | 端口 | 服务 | 说明 |
  |---|---|---|
  | 9528 | asr-server（主入口） | ASR / TTS / LLM / voice-chat / models / health |
  | 8001 | qwen3-tts | 可选，低延迟朗读 |
  | 9527 | bridge（WS） | 终端桥接（扩展侧接入） |
- **Tabu-AI 兼容**：Tabu-AI 的「本地服务」地址默认 `http://127.0.0.1:9528`，端口不变 → 现有朗读/识别/LLM 直接可用，无需改动 Tabu-AI。
- **规范文档 `SPEC.md`**：随 App 分发，写清楚：
  - 端点表、鉴权（Token，类比 `~/.tabu-bridge/token`）、错误码。
  - 请求/响应示例（curl）、音频格式（WAV/RAW PCM 16kHz 单声道）。
  - 帧流协议（`/speak` 每帧 = 4B 大端长度 + WAV）。
  - 能力上报（`/health`）、模型清单（`/models`）、安装进度流（`/install-model`）。
  - 目标读者：**任意网站 / 插件 / App / 命令行终端**，让它们在用户许可下接入本地识别/朗读/对话。

### 1.4 未来支持各种语音模型
- **Realtime 实时语音**：WebSocket/RT 通道，边说话边出字 + 低延迟回复（008 语音助手、013 性能/硬件加速衔接）。
- **语音克隆 TTS**：014 已调研（本地 CosyVoice 3.0 / 云端 Azure SSML 等多角色）；GUI 提供"录 10s 语音 → 生成克隆音色 → 用于朗读"。
- **更多 ASR**：whisper larger / Parakeet / 其它；`ASR_ENGINE` 已支持选择性启用（SenseVoice/whisper）。
- **模型管理**：`/models` + `/install-model` 已具备，GUI 可视化 增删/下载/换音色（类比 `ollama pull`）。

### 1.5 本地 LLM 接入 + 独立完整使用
- 后端：`/chat`（内嵌 llama-cpp / Ollama 后备）已具备；未来内置更大 GGUF（Qwen3-4B 等）提升质量。
- 独立使用：App GUI 内含「语音工作台」——录音 → 识别 → LLM → 朗读 一次完成（复用 `/voice-chat`），不依赖任何插件/浏览器。
- 后台一体化：识别 + LLM + 朗读 + Realtime 全部内聚成"完整后台"，同时可被外部接入。

---

## 二、对外开放接口（服务模式 · 设计）

```
外部方（网站/插件/App/CLI/终端）
   │  HTTP :9528   （Token 可选；本机默认免鉴权，需开放局域网时才启用 Token）
   ▼
Tabu-Voice App（Tauri 壳 → 常驻 asr-server 子进程）
   ├─ POST /transcribe   语音 → 文本   （SenseVoice/whisper，engine 可选）
   ├─ POST /speak        文本 → 语音   （kokoro/qwen3/cloud/azure/cosyvoice；帧流）
   ├─ POST /chat         文本 → LLM    （llama-cpp/ollama）
   ├─ POST /voice-chat   语音 → LLM → 语音（一次完成）
   ├─ GET  /health       状态 + 能力上报
   ├─ GET  /models       模型清单/安装状态
   ├─ POST /install-model 模型安装（NDJSON 进度）
   └─ (未来) WS/RT /realtime  实时语音
```

### 鉴权与安全
- 默认绑定 `127.0.0.1`（仅本机），Tabu-AI 等本机接入零配置。
- 可选「局域网开放」：绑定 `0.0.0.0` + Token 鉴权（复用 bridge 的 Token 机制），供同一局域网内的手机 App / 其它设备接入。
- Token 生成/展示在 GUI「连接」页，与插件设置一致。

### SPEC 文档要点（交付物）
`Tabu-Voice/SPEC.md` 作为唯一对外事实来源，含：
1. 端口、鉴权、CORS、错误码表。
2. 每个端点的请求/响应 JSON 与 curl 示例。
3. 音频编码约定与帧流协议。
4. 能力上报格式（`/health` 的 tts/asr/llm/models 结构）。
5. 快速接入示例（curl / fetch / Python / 小程序）。
> 与 `GUIDE.md`（现状接口）、`000-backend.md`（启动）形成三件套：GUIDE=接口调用，000-backend=怎么启动，SPEC=对外规范。

---

## 三、独立模式（App 内直接使用）

- **语音工作台**：一键「说 → 想 → 读」闭环；波形/文本流/停止。
- **朗读面板**：粘贴文本 / 打开文件 → 选引擎（系统/本地/云端）→ 朗读。
- **识别面板**：录音 → 转文本 → 复制/导出。
- **对话面板**：文字或语音 → 本地 LLM → 朗读回答（跟随朗读引擎）。
- **模型管理**：可视化 下载/删除/换音色/换 ASR 引擎；离线状态提示。
- **设置**：服务端口、鉴权 Token、开机自启（托盘常驻）、本地/云端路由。

---

## 四、其它重要功能 / 逻辑 / 交互（补充）

### 4.1 生命周期与常驻
- 托盘图标常驻，点击展开/隐藏；关闭窗口不退出服务（后台继续供 Tabu-AI 用）；「退出」才真正停服务。
- 开机自启可选；多实例防重（已探测 `/health` 幂等跳过）。

### 4.2 服务进程守护
- Tauri 拉启/守护 asr-server 子进程：崩溃自动重启；异常时 GUI 给出可读错误 + 日志查看。
- 模型加载失败（如 qwen3 联网校验超时）→ GUI 明确提示并引导用镜像/离线（`HF_ENDPOINT`/`HF_HUB_OFFLINE`，已集成进 start-all）。

### 4.3 模型按需下载
- 首次启动按维度懒下载（识别/朗读/LLM 各自独立），进度条走 `/install-model` NDJSON 流。
- 未下载的引擎在 GUI/SPEC 中标灰，点「安装」即拉取（默认 hf-mirror）。

### 4.4 能力路由与自动降级
- 每维度（识别/朗读/LLM）支持 本地 / 云端 / 系统 来源，**按可达性自动回退**（与 Tabu-AI 已做的统一来源一致，见 `000-plan.md`）。
- `/health` 上报各引擎就绪状态，客户端据此回退。

### 4.5 与插件、终端桥接的关系
- Tabu-AI：走 9528 本地服务（无需改）。
- 终端桥接：复用 9527 bridge（见 `000-bridge.md`）——Tabu-Voice 作为桥接后端的宿主之一。
- 手机 App（016）：后续经局域网 Token 接入本 App 的本地模型。

### 4.6 隐私与可观测
- 所有音频/推理本机完成，不上传（云端来源才出网）。
- 日志分级 + 请求计数/延迟指标（便于排障与性能分析，衔接 013）。

---

## 五、分期与里程碑

| 阶段 | 内容 | 状态/依赖 |
|---|---|---|
| M0 | 现有 asr-server 服务化（`npm run all` 可用、qwen3 镜像修复、ASR_ENGINE 选择、SPEC 雏形） | ✅ 已完成 |
| M1 | **Tauri 壳**：拉起 asr-server、托盘、点开即用；macOS 本机验证 | ⏳ 本次启动 |
| M2 | **GUI**：语音工作台 + 识别/朗读/对话/模型管理面板 + 设置（端口/Token/自启） | ✅ 已完成 |
| M2.5 | **录音链路修复**：macOS WebView 无 getUserMedia → Rust 原生录音（cpal）+ CORS | ✅ 已完成（见 §六） |
| M3 | **SPEC.md 定稿**：对外开放规范（鉴权/帧流/能力上报/接入示例） | ✅ 已完成 |
| M4 | **GitHub Actions CI**：macOS/Windows/Linux 三平台 `tauri build` 产物 | 并行 |
| M5 | **Realtime 实时语音 + 语音克隆 TTS**：WS/RT 通道 + 克隆音色 GUI | 远期 |
| M6 | **本地 LLM 增强 + 独立完整闭环打磨** | 远期 |

---

## 六、M2.5 任务记录：录音链路（macOS WebView 无 getUserMedia → Rust 原生录音）

> 状态：✅ **已完成（2026-08）**。记录问题、根因、方案与落地代码位置，供后续参考。

### 问题
语音工作台 / 识别面板点「录音」报错：`TypeError: navigator.mediaDevices.getUserMedia is undefined`。识别/朗读再报 `TypeError: Load failed`。

### 根因（两个独立问题）
1. **macOS WKWebView 默认无 `navigator.mediaDevices.getUserMedia`**：Tauri 的 WebView 不暴露该 API → 前端 Web API 录音不可用。
2. **CORS 拦截**：Tauri WebView 前端 `fetch http://127.0.0.1:9528` 属跨域，asr-server 无 `Access-Control-Allow-Origin` 头 → 被同源策略拦截 → `Load failed`。

> 注：母项目 `crazycodecat2` 里的 Insta360 麦克风「静音」问题（浏览器 getUserMedia 音频处理压静音）是**另一回事**，与本问题不同。

### 方案：Rust 原生录音（cpal）+ asr-server 加 CORS

### 落地代码位置
| 模块 | 文件 | 内容 |
|---|---|---|
| Rust 录音核心 | `src-tauri/src/recorder.rs` | cpal 采集 → 重采样 16kHz 单声道 WAV → base64 |
| Rust 命令 | `src-tauri/src/lib.rs` | `recorder_start` / `recorder_stop` / `recorder_is_recording` |
| 麦克风权限 | `src-tauri/Info.plist` | 声明 `NSMicrophoneUsageDescription` |
| 前端接入 | `ui/src/audio.ts` | `createRecorder()`：Tauri 环境走原生、Web API 回退；`inTauri()` 用 userAgent 检测 |
| 面板调用 | `ui/src/panels/HomePanel.tsx` `AsrPanel.tsx` `ChatPanel.tsx` | 语音工作台 / 识别 / 对话 |
| CORS | `asr-server/asr-server.js` | 统一加 `Access-Control-Allow-Origin: *` + 处理 OPTIONS 预检 |

### 技术要点
- `cpal::Stream` 在 macOS 上不是 `Send`（含 `*mut ()`）→ `RecorderInner` 手动 `unsafe impl Send`（所有访问在同一 Mutex 锁内，跨线程 drop 在 macOS CoreAudio 下可行）。
- 录音输出：16kHz 单声道 16-bit WAV（与 asr-server `decodeToPcm16` 期望一致）。
- 实测：cpal 录 2s（48000Hz 立体声 F32）→ 重采样 16kHz WAV，WAV 头校验通过。
- asr-server 绑定 `127.0.0.1` 仅本机，开放 CORS 无外部网络风险，且符合「开放端口后端」规划。

---

## 附：与既有文档的边界
- 本文 = **Tabu-Voice 桌面 App（Tauri）专项**：形态、CI、开放端口+SPEC、独立/服务双模式、realtime/克隆路线。
- `010` = 本地语音一体化服务（voice-server）架构与相位。
- `009` = 更大的「内容助理」App 愿景（不限于语音）。
- `015` / `000-plan.md` = Tabu-AI 能力来源与待办。
- `000-backend.md` = 启动速查；`GUIDE.md` = 接口调用；本文提议新增 `SPEC.md` = 对外规范。
