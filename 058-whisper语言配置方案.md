# 058 · Whisper 指定语言配置方案（S11）

> 目的：让用户能在界面给 Whisper 指定识别语言（如法语），说该语言时按该语言识别；默认保持自动检测（多语兜底定位）。
> 状态：**方案已定稿（2026-08-31）并已实施（S11，同日，SERVER_VERSION→2.10.0）**；实施记录见 056/000-install 变更记录与 057 提示词。
> 关联：056（whisper 补齐安装）、000-install 坑 U/V/W/X/**Y**、055（funasr 原始版）、000-plan-2（从零验证）。

---

## 一、目标与验收（可见即验收）

- **目标**：识别面板（或设置页）可选「Whisper 语言」：自动检测 / 中文 / 英文 / 法语 / 日语 / 韩语 / 西班牙语等常用项；指定语言后 `/transcribe?engine=whisper` 按该语言解码；不指定保持自动检测。
- **验收**：
  1. 默认自动检测不回归（中文录音出中文）；
  2. 指定 `zh` → 中文录音出中文；
  3. 指定其它语言（如 `fr`）→ **用户提供对应语言音频**实测「说法语→按法语识别」；
  4. 非法语言代码（如 `auto`）优雅回退自动检测，**不崩**；
  5. `node --check` 通过；temp server 功能探测通过；UI 重建 exe 后下拉可用。

## 二、现状（S10 之后的准确状态，2026-08-31 查证）

- Whisper 引擎 = **sherpa-onnx**（与 SenseVoice 共用原生运行时，根治 onnxruntime-node DLL 冲突，坑 X）。
- 模型：`<数据>/models/sherpa-whisper/` fp32 三件套（base-encoder.onnx 95,087,154B / base-decoder.onnx 196,548,998B / base-tokens.txt 816,730B；url-multi 安装器，hf-mirror 镜像）。
- `asr-server.js`：`getWhisper()` 单例 `whisperRec`，`language: ''`（写死，自动检测）；`whisperTranscribe()` stream 解码；`whisperInstalled()` 三文件检查；`engines/whisper.json` install.kind=url-multi。
- 语言事实（已实测）：`''` 自动检测（中文录音→中文）✓；`'zh'` 显式中文 ✓；**`'auto'` 崩溃** ✗。sherpa whisper 支持 99 种语言（加载日志 `all_language_codes` 含 fr/zh/en…）。

## 三、设计（执行时先查证再落码，铁律 B）

### 3.1 服务端语言参数
- 优先级：请求参数 `?lang=xx` > 环境变量 `ASR_WHISPER_LANG` > 默认 `''`（自动检测）。
- **识别器按语言缓存**：`getWhisper(lang)` → `Map<lang, rec>`；首次某语言才创建识别器（加载约 1–2s）。
  - ⚠️ **执行前先查证**：sherpa-onnx-node 的 `createOfflineRecognizer` 是否支持对同一实例改 language，或必须按语言重建。若必须重建 → 用 Map 缓存（切换成本 = 首次该语言的加载时间，可接受）。
- **非法语言回退**：语言代码不在 99 种内（或空/`auto`）→ 回退 `''`（自动检测），**不得抛错**。
- 校验方式：用已知语言集合（可从 sherpa 加载日志的 `all_language_codes` 固化一份，或维护常用清单 + 白名单放行）。

### 3.2 UI 入口（UI 优先，铁律 D）
- `ui/src/panels/AsrPanel.tsx`（识别面板）加「Whisper 语言」下拉：自动检测 / 中文 zh / 英文 en / 法语 fr / 日语 ja / 韩语 ko / 西班牙语 es（可加更多）。
- 仅当识别引擎为 whisper 时显示（或始终显示、仅 whisper 生效）。
- 选中值随 `/transcribe` 请求的 `lang` 参数传给服务端。
- ⚠️ 前端改动**需重建 exe 生效**（坑 M）；服务端改动重启服务即生效。

### 3.3 兼容性
- `ASR_ENGINE=whisper`（默认引擎场景）同样生效；
- 与 VAD/标点（punc 走 funasr 8002）互不影响；
- 节能/全能模式逻辑不变（whisper 在 9528 最小集内，资源模式零改动）。

## 四、实施步骤（待新会话执行，顺序执行每步汇报）

1. 查证：sherpa-onnx-node 语言机制（能否改实例 language / 语言代码合法集）→ 定缓存方案；
2. asr-server：`getWhisper(lang)` Map 缓存 + `?lang=` 解析 + 非法回退；`whisperTranscribe` 透传；
3. 前端：AsrPanel 语言下拉 + 请求参数；
4. `engines/whisper.json` install.message 提及语言可配；`SERVER_VERSION`/`EXPECTED_VERSION` → 2.10.0；
5. 实测验收（§一 5 条）+ 用户提供法语音频验证指定语言；
6. 文档同步（056 变更记录、坑账本如有新坑）。

## 五、坑预案

| # | 坑 | 预案 |
|---|---|---|
| 1 | `language:'auto'` 崩溃 | 非法代码一律回退 `''`，白名单校验（3.1） |
| 2 | 单例识别器语言不可变 | 按语言 Map 缓存（3.1），首次切换有 1–2s 加载 |
| 3 | UI 改完看不到 | 重建 exe（坑 M） |
| 4 | 指定语言与音频不符 | 结果会乱——预期行为，UI 提示「语言请与所说语言一致」 |
| 5 | 沙箱 curl 被拦 | 网络查证/下载验证用 node fetch（实测 hf-mirror/modelscope 200） |

## 六、变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-31 | 初版：Whisper 指定语言配置方案（S11）——目标/验收、现状、设计（按语言缓存 + 非法回退 + UI 下拉）、实施步骤、坑预案。**代码待新会话执行（057 提示词）** |
| 2026-08-31 | **已实施（S11，SERVER_VERSION→2.10.0）**：服务端 `?lang=`/`ASR_WHISPER_LANG` + 按语言 Map 缓存（LRU≤3，坑 Y）+ 99 码白名单非法回退；前端识别面板「Whisper 语言」下拉 20 项（仅 Whisper 引擎显示，**重建 exe 生效**）；`whisper.json` install.message 更新；temp server 实测全过（自动检测回归 / zh 指定 / EN→en 同一中文音频出英文=语言真生效 / auto·zzz 非法不崩 / fr+中文音频不崩·乱码预期）；fr 真人音频实测待用户提供 |
