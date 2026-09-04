# 056 · Whisper base（transformers.js）补齐安装方案

> 目的：修复模型页 Whisper base 卡片**永远「缺文件 / hf/onnx-community/whisper-* 无匹配」且「补齐」无动作**的问题，
> 让普通用户在 App 内一键下载 Whisper（多语兜底 ASR），并让状态显示与真实落盘一致。
> 关联：坑 U（000-install §四，2026-08-31 实锤）、005（模型下载）、S1 统一落盘（002-plan）、055（同批文档收尾）。

---

## 一、目标与验收（可见即验收）

- **目标**：模型页 Whisper base 卡片 —— 未下载时「补齐」可点击并**真正下载**（进度可见）；下载完成后状态变「就绪 · 未运行」，不再显示「无匹配」；识别面板选 Whisper 出字。
- **验收**：
  1. 新装机器：模型页 Whisper 卡片点「补齐」→ 进度可见（≈150MB）→ 完成 → 状态「就绪」；
  2. 已由首次识别自动下载过的机器：刷新后卡片直接「就绪」（不再误报缺文件）；
  3. `models/hf/onnx-community/whisper-base/` 文件齐全（config.json / model_quantized.onnx / preprocessor_config.json / tokenizer.json / tokenizer_config.json / vocab.json / generation_config.json 等）；
  4. 识别面板选 Whisper base → 上传/录制音频 → 出文字。

## 二、现状与根因（坑 U，2026-08-31 实锤）

| 现象 | 根因 |
|---|---|
| 卡片永远「缺文件 / hf/onnx-community/whisper-* 无匹配」 | `checkEntry` 的 **glob 型走 `globExists()` = `path.join(__dirname, pattern)`（代码目录）**，而 transformers.js `env.cacheDir = <数据目录>/models/hf`（S1 落盘）→ 两端路径不一致，即使模型已下载也永远 0 匹配。file/dir 型 checks 都走 `resolveData()`（数据目录），唯独 glob 型是代码目录——**检查器内部不一致**（坑 K 同族） |
| 「补齐」点了没反应（只有一句提示） | `INSTALLERS['whisper']` 是占位 stub（`Whisper 无独立下载脚本：首次识别时由 transformers.js 自动下载`）→ 无真安装器（坑 F「补齐没安装器」同族）；且用户可能从未触发过 engine=whisper 的识别，模型自然没下载 |
| 首次识别自动下载不可见 | 依赖用户主动切 whisper 引擎才触发，且下载过程在 /transcribe 请求里阻塞（无独立进度） |

补充事实（源码核对）：
- `getWhisper()`：`env.cacheDir = CACHE_DIR/hf`（= `<数据目录>/models/hf`）、`env.remoteHost = https://hf-mirror.com/`、`dtype: 'q8'`、模型 `onnx-community/whisper-base`（`ASR_MODEL_SIZE` 默认 base）；
- `whisperInstalled()`：`<数据目录>/models/hf/onnx-community` 下存在含 `whisper` 的目录即视为已装 —— 与 glob 检查不一致（前者对、后者错）；
- `engines/whisper.json`：checks 仅一条 glob；install.kind=hint（无安装器）。

## 三、方案设计

### ① 修 glob 解析（一行级修复，先做）
`globExists()` 与 `checkEntry` 其它类型统一：`models/` 前缀经 `resolveData()` 解析到数据目录。

```js
function globExists(pattern) {
  const abs = resolveData(pattern);            // ← 关键修复：与 file/dir 型同一套解析
  if (!pattern.includes('*')) return existsSync(abs);
  const sep = abs.lastIndexOf(path.sep, abs.indexOf('*'));
  const baseDir = abs.slice(0, sep);
  const tail = abs.slice(sep + 1);
  const rx = new RegExp('^' + tail.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  try { return readdirSync(baseDir).some((n) => rx.test(n) && existsSync(path.join(baseDir, n))); } catch { return false; }
}
```
> 效果：模型已落盘时卡片立即「就绪」；未落盘时如实「缺文件」。**本项独立验收**：把 `models/hf/onnx-community/whisper-base/` 拷到数据目录后刷新，卡片不再报无匹配。

### ② Whisper 真安装器：`download-whisper.js`（transformers.js 预下载脚本，首选方案）
不手工维护文件清单/字节（无网络实测前禁止猜测字节，铁律 B），**直接复用 transformers.js 自己的下载器**预跑一次，把「首次识别才下载」提前到「点补齐就下载」：

- 脚本内容 ≈ `getWhisper()` 的加载逻辑（同款 `env.cacheDir` / `remoteHost` / `dtype` / 模型名，读 `ASR_MODEL_SIZE`），跑完打印结果；
- 挂进 `INSTALLERS['whisper']`：`runDownload(process.execPath, ['download-whisper.js'])`（与 kokoro/sensevoice 同款），stdout 行 → NDJSON 安装日志；
- 进度可见性：transformers.js 下载日志为 `\r` 进度条——脚本内**改为按文件完成后打印一行**（`✓ whisper-base/model_quantized.onnx (…)`），避免刷屏（参照 035 坑「curl % Total 刷日志」教训）；
- 断点/失败：transformers.js 有 etag/缓存机制；失败时重试点「补齐」即可，无需 .part 手工续传（与 downloadOneFile 不同但等价可用）；
- 下载完自检 `whisperInstalled()`（或直接打印目录文件数）→ `done`。

> 备选方案（不采用，仅记录）：手写 `url-multi` 文件清单（config.json/model_quantized.onnx/… 逐个镜像下载）。缺点：文件清单与字节必须实测登记（本沙箱无网络），且 transformers.js 缓存结构（blobs/snapshots/etag）与 plain 文件混放易出「缓存不认」问题。**结论：预下载脚本复用官方机制，最稳。**

### ③ `engines/whisper.json` 同步
- `install.kind`: `hint` → `script`（或沿用 legacy 语义，标注真安装器）；
- `install.message`: 改为「点补齐 = 预下载 whisper-base（q8，约 150MB，hf-mirror）」；
- checks 保持 glob（① 修复后即准确）；可选：把 glob 换成逐文件字节 checks（须先实测登记字节，实施时若走方案 B 则不必）。

### ④ 保留首次识别自动下载兜底
`getWhisper()` 不动：模型未预下载时首次识别仍自动拉取（远程可达时），与「补齐」双保险。

## 四、实施步骤（顺序执行，每步停下验收）

1. **修 glob 解析**（①）：`asr-server.js` `globExists` 首行改 `resolveData(pattern)` → 重启服务 → 卡片状态按真实落盘显示（**本步即消除误报**）。
2. **写 `download-whisper.js`**（②）：复用 getWhisper 逻辑 + 文件级完成日志 + 自检 done。
3. **挂安装器**：`INSTALLERS['whisper']` 改为 `runDownload(process.execPath, ['download-whisper.js'])`；`whisper.json` install 段同步（③）。
4. **SERVER_VERSION / EXPECTED_VERSION** 递增（如 2.8.0）。
5. **验收**（§一 4 条全过）；把「首次识别自动下载」与「补齐下载」两条路径各验一遍。

## 五、坑预案（对照 047/055 坑账本）

| # | 坑 | 预案 |
|---|---|---|
| 1 | transformers.js 下载进度 `\r` 刷屏 | 脚本按文件完成打一行（035 坑同款教训） |
| 2 | 磁盘不足 | 补齐前提示余量（模型页已有磁盘行，≥10GB 警示） |
| 3 | hf-mirror 慢/断 | 重试点补齐可续（transformers.js 缓存）；可设 `HF_ENDPOINT` 覆盖 |
| 4 | dtype q8 与 fp32 体积差异 | sizeHint 注明随 `ASR_MODEL_SIZE` 档位变化（tiny/base/small/medium） |
| 5 | 补完后识别仍用旧缓存 | transformers.js 按 etag 校验，无需清缓存 |
| 6 | 前后端不一致复发 | 所有 checks 类型统一 `resolveData`（坑 K/U 防复发条款） |

## 六、变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-31 | 初版：Whisper base 补齐安装方案——根因（坑 U：glob 走代码目录 + 无真安装器）、三部分方案（修 glob / transformers.js 预下载安装器 / json 同步）、5 步实施、坑预案。实施时机：可与当前发布同批（改动小、风险低）或下一版 |
| 2026-08-31 | **已实施（S9，SERVER_VERSION→2.8.0）**：① `globExists()` 首行改 `resolveData(pattern)`（与 file/dir 型统一，实测：数据目录放 whisper-base 后卡片 state=running、missing=0）；② 新增 `download-whisper.js`（复用 transformers.js 下载器；**实测发现 pipeline() 惰性构造不下载 → 增加 1s 静音冒烟推理强制拉取权重**；缓存目录为 `<数据>/models/hf/onnx-community/whisper-base/`，权重落 `onnx/` 子目录；跨平台 Win/mac/Linux 同一脚本）；③ `INSTALLERS['whisper']` 占位 stub → `runDownload(node download-whisper.js)`；④ `engines/whisper.json` install.kind hint→script、message 更新；⑤ 顺带修 mac venv site-packages 路径（坑 W：`Lib/site-packages` → `venvSpOf()` 跨平台扫描，否则 mac 上 python 引擎永远误报「缺环境」）。**实测（沙箱内 scratch 目录）**：完整下载 whisper-base（config/tokenizer/onnx 权重）+ 冒烟推理通过 + 缓存自查打印。App 内「补齐」按钮流程待用户在真实环境点一次验收 |
| 2026-08-31 | **S10：Whisper 引擎换 sherpa-onnx（方案 C 落地，SERVER_VERSION→2.9.0）**——用户确认 fp32 全精度 + 语言自动检测。触发根因（坑 X）：transformers.js 的 onnxruntime-node 与 sherpa-onnx 各捆绑不同版本 `onnxruntime.dll`，同进程先加载者占名 → whisper 报 `The operating system cannot run %1`（实锤证据链见 000-install 坑 X）。改动：① `engines/whisper.json` → url-multi（sherpa 官方导出 fp32 三件套 `models/sherpa-whisper/`，checks+安装器，字节实测登记：encoder 95,087,154 / decoder 196,548,998 / tokens 816,730）；② `asr-server.js` getWhisper/whisperTranscribe/whisperInstalled 全换 sherpa-onnx（`language:''` 自动检测已实测，模型缺失时提示「模型页点补齐」）；③ 删除 `download-whisper.js` 与 `@huggingface/transformers` 使用（onnxruntime-node 不再加载）；④ `manifestUrlMultiInstaller` 跳过检查改 `resolveData`（坑 U 同族）；⑤ 实测：temp server + fp32 模型 → `/models` running、补齐「已存在跳过」、`/transcribe?engine=whisper` 中文录音出「現在開始做第一次。試。」 |
| 2026-08-31 | **S11：Whisper 指定语言配置（SERVER_VERSION→2.10.0）**——方案见 058。服务端：`/transcribe?lang=` / `ASR_WHISPER_LANG` 指定识别语言（优先级：请求参数 > 环境变量 > `''` 自动检测）；识别器**按语言 Map 缓存 + LRU 上限 3**（坑 Y：language 是创建期配置、setConfig 语义未文档化）；99 码白名单校验（与加载日志 all_language_codes 一致），非法码（auto 等）回退自动检测不崩。前端：识别面板引擎选 Whisper 时显示「Whisper 语言」下拉（20 项常用，**重建 exe 生效**）。temp server 实测：自动检测中文回归✓、zh 指定✓、EN→en 同一中文音频出英文✓（语言参数真生效）、auto/zzz 非法回退不崩✓、fr+中文音频不崩（乱码预期）；fr 真人音频实测待用户提供 |
