# 006 · Tabu-Local 后续任务规划（最新参考）

> 状态：**作为项目最新的参考规划文档**。已完成基线见 `000-summary.md`；本文件汇总**所有未完成**的后续任务，按优先级/依赖排序，供接手直接执行。
> 各旧规划文档（`000`/`003`/`004`）中未完成的部分，统一在此登记；执行时以此为准。

---

## 〇、已完成基线（不再重复规划）

识别（SenseVoice 量化+原始 / Whisper / VAD / 标点）、朗读（Kokoro / Qwen3 / 云端 / Azure / CosyVoice 云端）、对话（llama-cpp / Ollama）、全链路 voice-chat、录音（cpal）、音频库（落盘/播放/删除/导出）、桌面壳（托盘/守护）、模型管理 UI、开放后端 9528 + SPEC。
→ 详见 `000-summary.md`。

---

## 一、后续任务清单（按优先级排序）

| # | 任务 | 优先级 | 依赖 | 状态 |
|---|---|---|---|---|
| T1 | **语音克隆（CosyVoice 3.0）后端 + GUI** | 🔴 高 | 模型下载（`005` 进行中） | 待做 |
| T2 | **启动健壮性：防旧服务进程占端口** | 🔴 高 | 无 | 待做 |
| T3 | **Realtime 实时语音（用 VAD）** | 🟡 中 | T2 | 待做 |
| T4 | **CI 三平台打包**（M4） | 🟡 中 | 无 | 进行中 |
| T5 | **本地 LLM 增强** | 🟢 低 | 无 | 待做 |
| T6 | **音频库增强** | 🟢 低 | 无 | 待做 |

---

## T1 · 语音克隆（CosyVoice 3.0）—— 🔴 最高优先

> 依据：`004-voice-clone规划.md`（已定决策）、`005`（模型下载）。音频库的"克隆样本标记"已具备。

### 现状
- 模型：`Fun-CosyVoice3-0.5B`（~9GB）正在 `005` 命令下载到 `asr-server/models/cosyvoice/`。
- **后端 `/clone` 未写、GUI 未接**；`VoicePanel.tsx`（音色管理）已有骨架待接真实后端。

### 实施步骤
**阶段 A · 克隆后端（asr-server 接入 CosyVoice）**
1. Python 推理环境：仿 `.venv-qwen3` 建 `.venv-cosyvoice`（复用系统 torch），安装官方 `cosyvoice` 包 + `third_party/Matcha-TTS` 子模块。
2. 新建 `cosyvoice-tts-server.py`：独立进程 + 端口（建议 `8003`），仿 `qwen3-tts-server.py` 的 ThreadedHTTPServer 模式。
   - `POST /clone`：参考录音 + 提示文本 → 生成克隆音色并保存。
   - `POST /speak`：`voice=克隆音色id` → 克隆合成朗读。
3. `asr-server.js` 接入：
   - `POST /clone`（并入 9528，转发 8003）。
   - `/speak` 扩展：`voice=克隆音色id` 走克隆合成；`/models`/`/health` 上报克隆引擎就绪状态。
4. 克隆音色保存：`app_data_dir()/audio/clone-voices/<voice_id>/`（参考音频 + 配置）。

**阶段 B · GUI（UI 优先）**
- 音色管理面板（`VoicePanel.tsx`）：列出克隆音色、新建（从音频库选已标记样本）、删除、改名。
- 朗读/对话引擎下拉可加「克隆音色」选项。

**阶段 C · 打磨**
- 克隆音色与原始录音解耦（可删录音保留音色）；多音色并存；音色试听。

### 验收
- 从音频库选一个样本 → 生成克隆音色 → 朗读/对话用它发声，可切换回其它引擎。

---

## T2 · 启动健壮性：防旧服务进程占端口 —— 🔴 高

> 来自 `000-summary.md §6.1` 踩坑：旧 asr-server 进程占 `9528`，导致新代码起不来、"实际启用但显示 ✗"、中文识别回退 Whisper。

### 目标
- App 启动 / `npm run all` 时，**自动检测并清理残留的旧 asr-server / qwen3 / sensevoice-original 进程**，确保跑的是项目当前代码。

### 方案（二选一或结合）
- **A. start-all.js 端口探测 + 提示**：启动前探测 9528/8001/8002，若端口被占用但对应服务"指纹"不匹配（如 `/health` 的 `engines` 无 `sensevoice-original`），提示用户停止旧进程或自动 kill。
- **B. App(Rust) 侧**：`lib.rs` 的 `start_service` 在 spawn 前，查找并终止残留的 node/python 服务进程（按端口或命令行特征）。

### 验收
- 反复"旧代码进程占着 9528"的复现场景下，新 App 一键即可正确拉起新服务，不再出现"显示 ✗ 但实际可用"。

---

## T3 · Realtime 实时语音（用 VAD）—— 🟡 中

> 详见 `000-voice-tauri-app规划.md §七`（已记录设计：AudioWorklet 方案 A / cpal 方案 B）。VAD 后端（`/vad` + fsmn-vad 模型）已就绪，直接复用。

### 要点
- 录音层改 Web Audio + AudioWorklet（实时 PCM 流）或 Rust cpal 回调；周期性调 `/vad` 判断说话结束自动停 / 只识别有效段。
- asr-server 可选加 `/realtime`（WS/RT）通道承载流式识别。
- 依赖 T2（先保证服务链路干净）。

---

## T4 · CI 三平台打包（M4）—— 🟡 中

### 目标
- GitHub Actions 矩阵 `macos-latest / windows-latest / ubuntu-latest` 跑 `tauri build`，产出 `.dmg / .msi / .deb + .AppImage`。
- 首版"按需下载模型"：安装包只含壳，模型首次启动经 `/install-model` 下载。

### 注意
- 模型体积大（SenseVoice 228M + 原始版 897M + Kokoro 350M + Qwen3 2.3G + LLM 469M + CosyVoice 9G），**不要把大模型打进安装包**。
- 需处理 Python 子服务（qwen3 / sensevoice / cosyvoice）在各平台的启动路径与依赖。

---

## T5 · 本地 LLM 增强 —— 🟢 低

- 内置更大 GGUF（如 Qwen3-4B）提升对话质量；`/models` + 模型管理 UI 支持换用。
- 评估是否需要加载加速（Metal）与内存预算。

---

## T6 · 音频库增强 —— 🟢 低

- 自定义音频库路径；录音重命名；批量管理；按文本搜索；克隆样本从录音库选取（衔接 T1）。

---

## 二、优先级与执行顺序建议

1. 先做 **T2**（启动健壮性）——它直接影响每个用户的体验（本次踩坑），且是 T3 的前提。
2. 再按 **T1** 语音克隆（模型已在下载，趁热打铁）。
3. 然后 **T3 Realtime**、**T4 CI** 并行。
4. **T5 / T6** 视需要排期。

## 三、待拍板的决策点
- T1：首版只做**单个克隆音色**还是**多音色管理**？（004 遗留）
- T3：Realtime 优先走 AudioWorklet（前端）还是 cpal（Rust）？（先验证 WKWebView 是否支持 AudioWorklet）
- T2：自动 kill 旧进程是否可接受，还是仅提示由用户确认？
