# 057 · 新会话提示词：Whisper 语言配置 + 000-plan-2 文档补充

> 用法：把本文件内容（或本文件路径）交给新对话。新对话无旧上下文，**先读本文件 + AGENTS.md + 勘察现状再动手**。
> 铁律（AGENTS.md 会话开始会自动加载，必须遵守）：分阶段每步确认；不猜测先查证/直接问用户；UI 优先、可见即验收；
> 禁止 AI 代装（pip/uv/触发下载，执行由用户在 App 内点击）；git 只读；沙箱 curl 被拦但 **node fetch 可用**（实测 hf-mirror/modelscope 200，用它做网络查证与下载验证）。
> 关联：任务 1 的正式方案文档见 `058-whisper语言配置方案.md`（设计/坑预案/验收已定稿，按它执行）；000-plan-2 的文档修订**已在本会话完成**（§四 系统 node 保留 + Node 恢复手册），新对话核对即可、无需重写。

---

## 一、项目背景（勘察起点，勿假设）

- 项目：**OpenSound**——Tauri 本地语音 App（Win/macOS），代码根目录 `E:\Github\opensound`。
- 服务端：`asr-server/`（Node ESM）。主服务 `asr-server.js`（端口 9528），`start-all.js` 一键拉起全部子服务（8001 qwen3 / 8002 funasr原始版 / 8003 cosyvoice），`engines/*.json` 驱动模型页（checks/runtime/install）。
- 数据目录：App 配置里 `data_dir = E:\Downloads\opensound-download`（`OPENSOUND_DATA_DIR`）；模型统一落 `<数据>/models/`；受管 uv/python/venv 落 `<数据>/runtime/`、`<数据>/venvs/`。
- 当前版本：`asr-server.js` 的 `SERVER_VERSION = 2.9.0`，`start-all.js` 的 `EXPECTED_VERSION = 2.9.0`（二者必须一致；改动后同步递增）。
- 已完成（勿重做，勘察确认即可）：
  - S8/S9：sensevoice-original（funasr）二段式安装器 + bpe.model 别名自愈（`sensevoice-server.py`）；glob 检查跨平台修复（`globExists` 用 `resolveData`）；mac venv site-packages 修复（`venvSpOf`）。
  - **S10：Whisper 引擎已从 transformers.js 换为 sherpa-onnx**（与 SenseVoice 共用一套原生运行时，根治 onnxruntime-node DLL 冲突，见 000-install 坑 X）。`download-whisper.js` 已删除；`@huggingface/transformers` 不再被 import。
  - 坑账本（`000-install-安装链路与避坑.md`）：坑 A–X 已有记录，新增坑请续编。

## 二、Whisper 现状（S10 之后的准确状态）

- 模型：sherpa-onnx 官方导出 **fp32 全精度**，落 `<数据>/models/sherpa-whisper/`：
  - `base-encoder.onnx`（95,087,154 B）、`base-decoder.onnx`（196,548,998 B）、`base-tokens.txt`（816,730 B）
  - 下载源：`https://hf-mirror.com/csukuangfj/sherpa-onnx-whisper-base/resolve/main/<文件名>`（huggingface.co 兜底）
- `asr-server.js` 相关代码（勘察后核对行号）：
  - `SHERPA_WHISPER_DIR` / `WHISPER_FILES` 常量（CACHE_DIR 定义之后）
  - `getWhisper()`：`sherpa.createOfflineRecognizer({ modelConfig: { whisper: { encoder, decoder, **language: ''（当前写死，自动检测）**, task:'transcribe', tailPaddings:-1 }, tokens, numThreads:2, provider:'cpu' } })`，模块级单例 `whisperRec`
  - `whisperTranscribe(pcm16)`：stream → acceptWaveform(16000) → decode → getResult
  - `whisperInstalled()`：三文件 existsSync
  - `engines/whisper.json`：install.kind=url-multi（3 文件 checks+mirrors），label「Whisper base（多语兜底）」
- 语言事实（已实测，勿重复）：`language:''` = 自动检测（中文录音出中文）；`'zh'` 显式中文可用；**`'auto'` 不支持（会崩）**。sherpa whisper 支持 99 种语言（加载日志 `all_language_codes` 含 fr/zh/en 等）。

## 三、任务 1：Whisper 指定语言配置（S11）——核心任务

**目标**：用户能在界面里给 Whisper 指定语言（如法语），说该语言时按该语言识别；默认保持自动检测。

**设计要点（先查证再动手，铁律 B）**：
1. asr-server 支持语言参数：`/transcribe?engine=whisper&lang=fr`（或 `ASR_WHISPER_LANG` 环境变量）。
   - ⚠️ `getWhisper()` 是单例——语言可变时按语言缓存识别器（`Map<lang, rec>`）或按请求重建（createOfflineRecognizer 加载模型约 1–2s，可接受但频繁切换要设计好）。**先查证 sherpa-onnx-node 是否支持运行时改 language，再定方案。**
   - 请求参数与配置优先级：显式 `?lang=` > 环境变量 > 默认 `''`（自动检测）。
   - 非法语言代码（如 `auto`）要优雅回退自动检测，**不能崩**。
2. UI 入口（UI 优先，铁律 D）：识别面板（`ui/src/panels/AsrPanel.tsx`）或设置页加「Whisper 语言」下拉：自动检测 / 中文 zh / 英文 en / 法语 fr / 日语 ja / 韩语 ko / 西班牙语 es 等常用语言。
   - ⚠️ 前端改动需**重建 exe 生效**（000-install 坑 M）；服务端改动重启服务即生效。
3. 实测验收（每步停下汇报，铁律 C）：
   - 默认自动检测不回归（中文录音出中文）；
   - 指定 `zh` 出中文；指定其它语言需**用户提供对应语言音频**（如法语）实测「说法语→按法语识别」；
   - 非法语言代码回退自动检测不崩；
   - `node --check` 通过；temp server 功能探测（参考旧对话做法：临时端口 + 临时 OPENSOUND_DATA_DIR + scratch 模型目录）。
4. 完成后同步：`engines/whisper.json` 的 install.message（提及语言可配）、`SERVER_VERSION`/`EXPECTED_VERSION` → 2.10.0、坑账本如有新坑续编、文档（056 变更记录）更新。

## 四、任务 2：000-plan-2 文档补充（与任务 1 一起做，先文档后代码均可）

在 `000-plan-2.md` 补/改（先读全文，目前 125 行）：
1. **§四（卸载）修订**：卸载清单里「手动装的 node/python（仅开发机）」改为**保留系统 node**——
   - 依据：App 优先使用自举便携 node（`src-tauri/src/lib.rs` `find_node`/`check_runtime`：runtime_node 优先于系统 node），从零验证不依赖删系统 node；
   - **删系统 node 会杀掉 DeepSeek Harness（DSH，开发对话工具）**——风险必须标注；
   - 卸载方式细化：数据目录**改名备份**而非删除（可回滚），`%APPDATA%\world.opensound.local` 与日志可删；
   - 标注：App 目前**无内置卸载/清理功能**（src-tauri 无相关命令），卸载为开发期验证操作，普通用户删 App 即卸载——与铁律 E「App 内闭环」的缺口如实记录。
2. **新增「系统 node 风险与恢复手册」章节**：node 没了怎么装回——
   - 下载：`https://npmmirror.com/mirrors/node/`（国内快）或 nodejs.org，Node LTS（如 v22.x x64 MSI/zip）；
   - 装回原位置（本机 `D:\001-2024-5-soft\node`）→ 加 PATH → `node --version` 验证 → 重启 DSH（重跑 harness 启动命令）；
   - 验证前建议先备份系统 node 目录或记录安装方式。
3. 更新变更记录行；如必要在 000-install 坑账本加一条「卸载/环境清理」坑。

## 五、总体验收（任务 1+2 完成才算完）

- [ ] `node --check` 全过；temp server 探测：默认自动检测不回归、指定语言生效、非法语言回退不崩；
- [ ] 用户在 App 内实测：识别面板选 whisper + 指定语言 → 对应语言音频出字（法语需用户提供音频）；
- [ ] 000-plan-2 文档：§四修订 + node 恢复手册 + 变更记录；坑账本/056 同步；
- [ ] 版本号 2.10.0 一致；git 只读（未做任何写操作，需要提交时列命令交用户执行）。

## 六、给新对话的执行纪律

1. 开始：读 AGENTS.md → 读本文件 → `git status`（只读）→ 勘察 asr-server.js / whisper.json / AsrPanel.tsx / 000-plan-2.md 现状，与上文核对（若有出入以实际代码为准并说明）；
2. 每完成一个可验证的步骤停下汇报，等用户确认（铁律 C）；方向不明先问用户（铁律 B）；
3. 全程不执行 pip/uv/npm 安装、不触发模型下载（用户 App 内点击）；沙箱内网络查证用 **node fetch**（curl 被拦）；
4. UI 改动提醒用户重建 exe（坑 M）；服务端改动提醒重启服务。
