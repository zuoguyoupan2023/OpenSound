# 006 · OpenSound 后续任务规划（最新参考）

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
| T2 | **启动健壮性：防旧服务进程占端口** | ✅ 已完成 | 无 | 已完成 |
| T3 | **Realtime 实时语音（用 VAD）** | ✅ 已完成 | T2 | 已完成 |
| T4 | **CI 三平台打包**（M4） | 🟡 中 | 无 | 进行中 |
| T5 | **本地 LLM 增强** | ✅ 已完成 | 无 | 已完成 |
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

## T2 · 启动健壮性：防旧服务进程占端口 —— ✅ 已完成

> 来自 `000-summary.md §6.1` 踩坑：旧 asr-server 进程占 `9528`，导致新代码起不来、"实际启用但显示 ✗"、中文识别回退 Whisper。

### 已实现
- **asr-server.js**：新增 `SERVER_VERSION = '2.0.0'` 并在 `/health` 返回 `version`（架构指纹）。
- **start-all.js**：启动前探测 `9528` 的 `/health`，若服务在跑但 `version !== '2.0.0'` → 判定为残留旧进程 → `lsof` 找 PID → `SIGTERM` 终止 → 稍候重启新代码。`lib.rs` 的 `start_service` 调的就是 `start-all.js`，故 **App 与 `npm run all` 均自动受益**。
- 已实测：假"旧版"服务占 9528 → start-all 正确识别并终止 → 拉起新 asr-server（`version: 2.0.0`，engines 含 `sensevoice-original`）。

### 注意
- 新版本判断依赖 `version` 指纹；后续再改 asr-server 时**务必同步递增 `SERVER_VERSION` 与 `start-all.js` 的 `EXPECTED_VERSION`**。

---

## T3 · Realtime 实时语音（用 VAD）—— ✅ 已完成

> 方案选型：**cpal（Rust）方案 B**。macOS WKWebView 无 `getUserMedia`（000 踩坑 7.5），故 AudioWorklet 方案 A 不可行。

### 已实现
- **Rust 实时采集**：`src-tauri/src/realtime.rs`（独立模块，与 `recorder.rs` 隔离）。`realtime_start / realtime_read / realtime_stop / realtime_pause / realtime_resume`，按游标增量返回 16k 单声道 f32。
- **前端 VAD 切句**：`ui/src/realtime.ts`（独立模块）。周期拉增量 → `/vad` 检测语音段 → 停顿≥600ms 自动切句 → 每句单独 `/transcribe?punct=0&vad=0`（规避多逗号）→ 逐句回调 UI。
- **UI 面板**：`ui/src/panels/RealtimePanel.tsx`「实时语音」。支持边说边显示、音量条、暂停/继续、静音自动停止（2/3/5s）、复制/导出、**保存整段录音到音频库**。
- **代码隔离**：Rust `realtime.rs` 与录音 `recorder.rs` 分离；前端 `realtime.ts` 不触碰 `audio.ts`；每句识别强制关标点。

### 注意
- 依赖 T2（服务链路干净）已完成。

---

## T5 · 本地 LLM 增强 —— ✅ 已完成

### 结论
- **Qwen3-8B-Q4_K_M（~4.9GB）是 M4/16GB 甜点档**（`models/llm/Qwen3-8B-Q4_K_M.gguf`）。27B 在 16GB 上不可行（"装得下 ≠ 跑得快"）。
- 当前默认 0.5B 质量太弱，已改为**多档位**。

### 已实现
- 后端 `LLM_MODELS` 注册表：`llm-0.5b`（默认兜底）+ `llm-qwen3-8b`。
- `/chat`、`/voice-chat` 支持 `model` 参数切换；同一时间只保留一个活跃模型（省内存）。
- `/models` 上报多个 LLM 档位；`/install-model` 动态生成下载器。
- 前端模型管理 UI + 对话面板/工作台「模型」下拉切换。
- 版本指纹 `2.2.0`（start-all 同步）。

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

---

## 四、踩坑记录（T3/T5 新增）

### 4.1 LLM「下载后没自动加载」的根因（⚠️ 重要）
**现象**：8B 模型下载完成后，App 对话报 `Failed to load model` / 空回复，以为要重启。

**根因（三重叠加）**：
1. **`installed` 判定只看 `existsSync`**：下载到一半（哪怕 5MB）也显示"已安装"→ 用户误以为可用就去加载残缺文件。
2. **加载错误被永久缓存**：`getLlamaSession` 里 `llmInitError` 一旦设置，之后永远 `throw`，即使文件后来补全也不重试 → 必须重启服务。
3. **磁盘空间不足（根本阻塞）**：M4 数据盘曾只剩 100MB（100% 满），8B 推理写临时/swap 失败 → 加载成功但推理空输出。**遇到 8B 类大模型"空回复/不产 token"，先查磁盘 `df -h`**。

**已修复（`asr-server.js`）**：
- LLM 下载改为**先下到 `.part`，完整后 rename 成正式文件**（`runLlmDownload`）；`llmReady` 只认正式文件 → 下载中绝不误报"已安装"。
- `getLlamaSession` 失败重试：文件就位后自动清 `llmInitError` 重试。
- `/install-model` 完成后调 `llmInvalidate()` 清空加载缓存 → **下载完无需重启即可加载新模型**。

### 4.2 `fs.renameSync` 未 import（下载完成崩溃）
- `runLlmDownload` 用 `fs.renameSync`，但文件头 `import { existsSync, mkdirSync, readdirSync } from 'node:fs'` 缺 `renameSync` → 下载完成后 rename 抛 `ReferenceError: fs is not defined`，`.part` 永不改名为正式文件。
- **已修复**：import 补 `renameSync`。
- **教训**：改 asr-server 时若用 `node:fs` 新函数，记得同步 import。

### 4.3 磁盘清理（M4 大模型空间紧张）
- 8B(4.9G) + CosyVoice(9.1G) + 0.5B + target(2.6G) 等，M4 数据盘易满。
- 安全清理项：`src-tauri/target`（Rust 缓存，重建会再生）、`~/.npm`。
- 大模型下载/推理前，先确认 `df -h` 有足够空间。

### 4.4 Qwen3-8B 的 node-llama-cpp 兼容注意
- 8B 加载成功但**推理空输出**时，排查顺序：① 磁盘空间 ② 模型文件是否完整 ③ node-llama-cpp / llama.cpp 对 Qwen3 的已知兼容问题（llama.cpp Metal "spins but no output"）。
- 已确认：tokenizer/加载均正常，空输出主要源于磁盘满。
