# 008 · Electron 平行版本规划（对比 Tauri）

> 状态：**评估/规划**。当前实现基于 **Tauri 2**（`000-voice-tauri-app规划.md`）。因发现 Tauri 存在一些不足，决定**平行开发 Electron 版本，作为主要发展方向**。
> 本文件记录：Tauri 的不足、前后端分工判断、Electron 与 Tauri 的差异、迁移策略、待决策点。

---

## 〇、方向决策（已确认）

| 决策 | 结论 |
|---|---|
| 是否开 Electron 平行版 | ✅ **平行开发** |
| 与 Tauri 关系 | ✅ **并存**（两者共用 `ui/` + `asr-server/`）|
| 内存代价 | ✅ **接受**（Electron 常驻 Chromium 额外内存，在 16GB M4 上可承受）|
| **目标首选平台** | **macOS（当前开发机 M2）**，先跑通再扩三平台 |
| **开发重心（重点）** | ⚠️ **未来以 Electron 为主要开发方向，Tauri 转为保守维护**（不再新增功能，仅修 bug/保兼容） |

> **战略定位：Electron 是主开发线，Tauri 退居保守维护。** 新功能、UI 打磨、模型库扩展优先在 Electron 落地。

## 一、核心判断：前端是"壳"，后端才是主体

**结论：你的判断正确——当前前端更多是"壳"，核心业务几乎全部在后端实现。**

代码事实（量级对比）：
- **前端 `ui/src`**：18 个 ts/tsx 文件，约 **2256 行**。职责 = 调 HTTP API（`/transcribe /speak /chat /voice-chat /install-model /vad`）+ 录音（调 Rust 命令或 WebAPI）+ 渲染 UI。**没有模型加载、音频合成、LLM 推理等任何核心逻辑**。
- **后端 `asr-server`**：7 个 js/py 文件，承载 ASR（SenseVoice/Whisper/funasr）、TTS（Kokoro/Qwen3/CosyVoice3 克隆）、LLM（llama-cpp/Ollama）、VAD、标点、语音克隆、模型管理。

**含义**：
- 前端作为壳，**与具体桌面框架（Tauri/Electron）的耦合很小**——它通过 HTTP 调本地后端，录音走少量桥接。
- 因此**平行开发 Electron 版本，前端 React 部分几乎可复用**（仅录音/系统桥接需改）。
- 真正的引擎（asr-server）与框架无关，两个版本共用。

---

## 二、Tauri 的不足（本次发现，记录）

> 以下为实际踩到/观察到的点，逐条核对后再决定是否 Electron。

| # | 不足 | 影响 | 严重度 |
|---|---|---|---|
| 1 | **macOS WKWebView 无 `getUserMedia`**（000 踩坑 7.5） | 录音必须走 Rust cpal 桥接，不能直接用 Web 麦克风 API | 高 |
| 2 | **WebView 引擎碎片化**：macOS=WKWebView、Win=WebView2、Linux=WebKitGTK，三平台 Web 能力不一致 | 前端 API 兼容性难保证，需反复做平台分支 | 中 |
| 3 | **构建链复杂**：Rust + Tauri + Node + Python venv 多套工具链 | CI 三平台打包易碎，`rustc` 版本/依赖常出问题（如 1.86→1.88 卡点） | 高 |
| 4 | **Tauri 生态/文档相对新** | 遇问题可参考少，需自行趟坑 | 中 |
| 5 | **Python 子进程桥接**（qwen3/sensevoice/cosyvoice 作为独立进程）在 Tauri 下路径/环境处理繁琐 | 多平台启动路径易错 | 中 |
| 6 | 部分能力（如原生窗口/托盘/对话框）Tauri 有但要额外插件 | 与 Electron 内置相比多配置 | 低 |

## 三、Electron 的优势（对应弥补）

| Tauri 不足 | Electron 如何解决 |
|---|---|
| 无 getUserMedia | Chromium 内置，`navigator.mediaDevices.getUserMedia` 直接用，录音可走纯前端，省去 cpal 桥接 |
| WebView 碎片化 | 打包自带 Chromium，三平台渲染/API 完全一致 |
| 构建链复杂 | Node.js 生态，`electron-builder` 成熟，CI 相对简单；前端 React 无缝复用 |
| 生态/文档 | 生态极成熟，案例/插件/文档丰富 |
| 音频处理 | Chromium 有完整 Web Audio / AudioWorklet，实时语音（T3）可走纯前端方案 A，比 cpal 简单 |

## 四、Electron 相对 Tauri 的差异 / 取舍

### 3.1 劣势（Electron 不如 Tauri 的地方）
| 维度 | Tauri | Electron | 影响 |
|---|---|---|---|
| **安装包体积** | 小（~10MB 级，用系统 WebView）| 大（打包 Chromium + Node，~80–150MB）| 分发体积 Electron 大 |
| **内存占用** | 低（复用系统 WebView）| 高（自带 Chromium 常驻）| 运行时 Electron 更吃内存 |
| **原生能力/系统集成** | Rust 可深度管进程/文件 | 主进程 Node，也够用但弱于 Rust | 边缘场景 |
| **性能** | 轻量 | 较重 | 资源敏感场景 |

### 3.2 对本项目（本地语音+大模型）的特别影响
- **内存**：本项目要常驻 asr-server + Python 子服务（可能多个模型）。Electron 自带 Chromium 会额外占内存 → 在 16GB M4 上，**Electron 更吃紧**。这是本项目选 Electron 的最大顾虑。
- **录音**：Electron 反而省事（Chromium 有 getUserMedia / AudioWorklet），可简化 T3 Realtime。
- **子进程管理**：Electron 主进程是 Node，与 asr-server（Node）同构，`child_process` 管理更顺；Tauri 需 Rust `Command`。

### 3.3 差异对照表（前端可复用度）
| 层 | Tauri 实现 | Electron 实现 | 复用度 |
|---|---|---|---|
| 前端 UI（React）| `ui/` | `ui/`（几乎不改）| ~100% |
| HTTP API 封装 `api.ts` | fetch 调 9528 | 相同 | 100% |
| 录音 | Rust cpal 命令 / Web 回退 | 纯 `getUserMedia` | 需改（简化）|
| 系统桥接（托盘/窗口/对话框）| Rust + Tauri 插件 | Electron 主进程 | 需重写 |
| 子进程拉起 asr-server | Rust `Command` | Node `child_process` | 需重写（更简单）|
| 核心引擎 asr-server | 独立 | 独立（共用）| 100% 共用 |

---

## 五、迁移 / 平行策略建议

### 4.1 建议路线（先确认）
- **不推翻 Tauri**：Tauri 版本已可用，且轻量。**Electron 作为平行版本**，共用 `ui/` + `asr-server/`。
- **复用策略**：前端 React 与 api 层 100% 复用；只重写"壳"（主进程/托盘/子进程拉起/录音桥接）。
- **目录**：建议新增 `electron/`（主进程 + electron-builder 配置），与 `src-tauri/` 平行。

### 4.2 工作量预估
| 项 | 工作量 |
|---|---|
| Electron 壳（主进程 + 托盘 + 拉起 asr-server）| 中（复用 asr-server 启动逻辑）|
| 录音改为 getUserMedia / AudioWorklet | 低–中（反而简化）|
| 前端微调（去掉 Tauri 特定 invoke，改 HTTP/fetch）| 低 |
| electron-builder 三平台打包 CI | 中（比 Tauri 简单）|

### 4.3 关键取舍待定
- **内存 vs 录音便利**：16GB M4 上 Electron 常驻 Chromium 更吃内存。若模型推理频繁，Tauri 更稳；若更看重录音/Web 一致，Electron 更顺。
- **是否需要双线维护**：两个壳共用引擎，前端改动要同步验证两平台 → 维护成本 ×2。

---

## 六、已确认决策（执行依据）
1. ✅ **平行开发 Electron 版本**（作为主开发线）。
2. ✅ **与 Tauri 并存**（共用 `ui/` + `asr-server/`）。
3. ✅ **接受 Electron 内存代价**（16GB M4 可承受）。
4. ✅ **目标首选平台：macOS（当前 M2）**，先跑通再扩 Windows/Linux。
5. ✅ **开发重心：Electron 为主，Tauri 保守维护**（不再新增功能，仅修 bug / 保兼容）。

## 七、待拍板决策点（剩余）
1. Electron 工程初始化：目录 `electron/` 与脚手架选择（electron-builder / electron-vite）？
2. Electron 首版要包含哪些功能？（建议先复刻当前 Tauri 全部面板）
3. 录音方案：Electron 直接用 `getUserMedia`/AudioWorklet（替代 cpal 桥接），是否首版就切换？

## 八、关联文档
- 当前 Tauri 架构：`000-voice-tauri-app规划.md`、`000-summary.md`
- 后续任务：`006`（T3/T5 完成）、`007`（UI/CI/模型库）
- 模型库（含 S2 等候选）：`007`
