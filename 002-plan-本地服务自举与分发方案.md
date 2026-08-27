# 002-plan · 本地服务自举与分发方案（App 打底，用户只下模型）

> 状态：**方案（2026-08-22 定稿待实施）**。
> 目标一句话：把现在的「开发者本机可用」变成「**其他人下载 App + 下载模型 = 直接用识别 / LLM / 朗读（含克隆）**」。App 把基础打好：运行时检测引导、依赖自动创建、模型文件逐项校验补齐、就绪后拉起服务。所有引擎（包括需要 GPU 的大模型）走同一套逻辑。
>
> 衔接：`010`（问题诊断与 CosyVoice 方案，本文承接其 §五行动项）、`000-summary`（项目总览 §二架构、§六克隆实现）、`002-voice-research`（能力目录，本方案的 manifest 就是它的落地机制）、`005`（CosyVoice 权重手动下载史）。

---

## 〇、本次已拍板的决策（讨论定案）

| 决策点 | 结论 |
|---|---|
| 文档命名 | 就叫 `002-plan-*`（编号让位于语义，002 已有 research 文档并存） |
| 目标平台 | **仅 macOS Apple Silicon 先做**；Windows 另立后续专项 |
| Node/Python 运行时 | **首启检测 + 引导安装**（不内置 sidecar，保持小包；sidecar 列为后备选项） |
| **打包边界**（08-22 二次拍板） | **只打包必要代码**（JS/PY 源码 + CosyVoice 源码子集 + engines manifest + 依赖锁定文件）；**node_modules 与 Python 环境一律是「可安装项」**——首启检测缺失后自动安装，绝不打进发布包 |
| 模型下载源 | **默认 HuggingFace 官方**，UI 可切换 hf-mirror（国内加速）/ ModelScope（魔搭） |
| 本期范围 | **框架 + 现有全部引擎就绪化**（ASR 3 + TTS 3 + LLM 2 档）；新引擎只做一个「试金石」验证同构性 |

---

## 一、目标与验收标准（用户视角）

### 1.1 用户故事

```
① 下载 OpenSound.app 与 asr-server 资源包（release 页两个文件）
② 首启：App 检测 Node.js / Python3 → 缺则给出可复制安装指引；node_modules 与各 venv 自动创建（进度条）
③ 模型管理面板：每个引擎一张状态卡 —— ✓就绪 / ✗缺哪些文件共几 GB[一键下载] / ✗缺运行时[看指引]
④ 点下载：进度条、断点续传、失败自动换镜像源
⑤ 全绿 → 服务自动拉起 → 识别 / 朗读 / 对话 / 克隆 全部可用
```

### 1.2 验收标准（可看见、可操作）

- [ ] 在一台**只有 macOS + 浏览器**的干净 M 系列机器上，不看任何开发文档，纯按 UI 引导完成上述 ①–⑤。
- [ ] 模型管理面板对每个引擎能回答三件事：**缺什么、多大、从哪下**。
- [ ] 故意删掉任一必需文件（如 `tokens.txt`），面板立即显示该引擎 ✗ 及缺失明细，一键补齐后恢复 ✓。
- [ ] CosyVoice 克隆在新机器上**不再依赖手工步骤**（建 venv、找源码、配缓存目录均由 App 完成）。
- [ ] 接入一个新引擎（FireRedASR2）只需新增 manifest + 引擎注册，不改框架代码（S7 验证）。

---

## 二、现状差距盘点（以代码核实为准）

### 2.1 现有引擎 × 差距矩阵

| 引擎（MODEL_ITEMS 条目） | 权重落盘现状 | 运行时现状 | 点「安装」行为 | 差距 |
|---|---|---|---|---|
| Kokoro | `models/tts/kokoro-multi-lang-v1_0/` ✓ | npm sherpa-onnx-node | 下 ONNX | 无大碍，纳入 manifest 即可 |
| SenseVoice 量化版 | `models/sensevoice/`（model.int8.onnx + tokens.txt）✓ | 同上 | 下 ONNX | 同上 |
| Whisper | `./.cache` ⚠️ 位置漂移 | 同上 | 仅提示 | 缓存目录统一到 `models/whisper` |
| LLM 两档 | `models/llm/*.gguf` ✓（已有 .part 原子改名+断点续传的好实现） | node-llama-cpp prebuilt | curl GGUF | 逻辑最好，**作为通用下载器的原型**推广 |
| Qwen3-TTS | `~/.cache/huggingface` ⚠️ | `.venv-qwen3` 手工建 ⚠️ | 仅提示 | `HF_HOME` 统一 + venv 自举 |
| SenseVoice 原始版 | `~/.cache`（modelscope/funasr）⚠️ | **系统 python3 绝对路径硬编码** ⚠️ | 无 | 受管 venv + `MODELSCOPE_CACHE` 统一 |
| CosyVoice3 克隆 | `models/cosyvoice/…/` ✓（但混入非必需大文件，见 §四.7） | `.venv-cosyvoice` 手工建 + **源码目录依赖** ⚠️ | 只检查不代下 | vendoring + venv 自举 + 逐文件清单 |

### 2.2 三类根因

1. **知识外置**：「要装什么、放哪、怎么起」散落在开发者脑子和手工步骤里，App 不知道 → 无法校验、无法引导。
2. **位置漂移**：模型缓存三分天下（`models/`、`./.cache`、`~/.cache/*`）→ 「校验所有文件就绪」无从做起。
3. **布尔化安装器**：`installed()` 只返回 true/false，看不到缺失明细 → UI 只能显示 ✗，不能指路。

---

## 三、总体设计：三层分发 + manifest 驱动

### 3.1 三层分发形态

```
层1  Tauri App 壳（不变，保持小而纯：UI + 编排 + 首启引导向导）
层2  asr-server 运行时资源包（本次主战场，只含必要代码，~10MB 级）
       ├─ 代码（asr-server.js / *.py / start-all.js，实测仅 236KB）
       ├─ vendor/（vendored CosyVoice 源码子集，锁定 commit，~7MB）
       ├─ engines/*.json（全部引擎清单 ← 新增的核心）
       └─ requirements-*.lock（Python 依赖锁定，从现有 venv freeze 提炼）

层2′ 可安装项（⚠️ 不在包内！首启由自举器创建/安装）
       ├─ node_modules/（npm ci 安装；native 推理栈实测 523MB 磁盘 / 压缩传输 ~142MB）
       └─ .venv-*（python -m venv + pip install -r <lock> 创建；torch 等大头走网络）
层3  模型文件（用户按需下载，统一落盘 <asr-server>/models/）
```

- 层2 作为整体随 release 发布（zip），用户解压到任意目录，在设置里指认（沿用现有 `server_path` 机制，校验条件仍为「目录下有 `start-all.js`」）。
- 层2 内置**自举脚本**：建 venv → 装锁定依赖 → 按 manifest 报告缺啥 → 补齐 → 拉起。层2 可独立更新（改了后端不用重发 App 壳）。

### 3.2 引擎清单（engine manifest）

每个引擎一份 JSON，是整个方案的中枢：

```jsonc
// asr-server/engines/cosyvoice-clone.json（示意）
{
  "id": "cosyvoice-clone",
  "category": "tts",
  "label": "CosyVoice3 语音克隆（0.5B · MPS）",
  "license": "Apache-2.0",
  "serve": { "port": 8003, "health": "/health" },

  "files": [                          // 必需文件逐个列出 = 「验证所有文件就绪」的依据
    { "path": "models/cosyvoice/Fun-CosyVoice3-0.5B/llm.pt",
      "bytes": 2024669519,
      "required": true,
      "mirrors": [                    // 按序尝试；默认 HF 官方在前
        { "name": "huggingface", "url": "https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B/resolve/main/llm.pt" },
        { "name": "hf-mirror",   "url": "https://hf-mirror.com/FunAudioLLM/Fun-CosyVoice3-0.5B/resolve/main/llm.pt" },
        { "name": "modelscope",  "url": "https://modelscope.cn/models/.../resolve/master/llm.pt" } ] }
    // … flow.pt / hift.pt / campplus.onnx / speech_tokenizer_v3.onnx / cosyvoice3.yaml …
  ],

  "runtime": {                        // 运行时需求，App 负责满足
    "venv": ".venv-cosyvoice",
    "requirementsLock": "requirements-cosyvoice.lock",
    "pythonMin": "3.10"
  },

  "env": {                            // 启动注入（根治缓存漂移）
    "HF_HOME": "models/hf", "NUMBA_CACHE_DIR": "data/cache/numba", "MPLCONFIGDIR": "data/cache/mpl"
  },

  "gpu": { "device": "mps", "minUnifiedMemGB": 16 }   // 大模型只是门槛字段不同，逻辑完全同构
}
```

设计要点：
- **校验规则分级**：`bytes` 必填（便宜且够用）；`sha256` 可选——HF 的 LFS pointer 自带 sha256，可从 API 取，避免本地算大文件哈希。
- **`required: false` 支持瘦身**：如 CosyVoice 目录里 `llm.pt` 与 `llm.rl.pt` 并存、两种 speech_tokenizer 并存，实施前须读 `cosyvoice3.yaml` 确认实际加载哪个，非必需者标记后可为用户省约 3GB 下载（见 §四.7）。
- **`mirrors` 数组**承载「默认 HF 官方、可切 hf-mirror / 魔搭」的拍板结论；下载失败自动降级下一镜像。

### 3.3 就绪状态机 + readiness API

```
missing-runtime ──(装好 Node/Python/依赖)──▶ partial-files ──(文件补齐)──▶ ready ──(start-all 拉起)──▶ running
     │                                            │                                          │
     └── UI：[查看运行时指引]                      └── UI：缺 n 个文件 共 x.xGB [一键下载]      └── UI：✓ 服务运行中
```

`GET /models` 升级为返回就绪明细（保持旧字段向后兼容，GUI 逐步切换）：

```jsonc
{ "category": "tts", "engine": "cosyvoice-clone",
  "state": "partial-files",
  "missingFiles": [ { "path": ".../flow.pt", "bytes": 1329116148 } ],
  "missingRuntime": [],
  "totalMissingBytes": 4382751667 }
```

### 3.4 通用下载器

把 `runLlmDownload`（.part 临时文件 → 完整后原子改名 → 失败保留 .part 断点续传）**泛化为唯一下载器**，所有引擎共用：

- HTTP `Range` 断点续传；字节数校验（可选 sha256 流式计算）；
- 镜像数组顺序尝试，失败自动换源；
- NDJSON 进度流（复用现有 `/install-model` 协议：`log / done / error`，增加 `progress {received,total}` 事件供 UI 画进度条）；
- 下载队列串行执行，防并发写坏同一文件。

---

## 四、各引擎 manifest 落地要点

> 以下为逐引擎的实施备注；文件大小以本机磁盘实测为准。

1. **Kokoro**：除 `model.onnx`/`tokens.txt` 外还有 `espeak-ng-data/`、`dict/`、`*.fst`、`voices.bin` 等必要文件——正好证明 manifest 应列**目录级完整清单**而非单个权重。来源 sherpa-onnx 官方 release（GitHub/HF 均可）。
2. **SenseVoice 量化版**：最简单（`model.int8.onnx` + `tokens.txt`），作为 manifest 化的第一个试点。
3. **Whisper**：transformers.js 的 `env.cacheDir` 显式设为 `models/whisper`；manifest 标记「首次识别自动下载」也可改为面板主动下载。
4. **LLM 两档**：现有实现已是范本，仅需迁到 manifest 格式；顺手把 `MODEL_ITEMS` 里「按内存档位多 GGUF」扩展位留好（Qwen3.5-9B 等，属于 002-research 的后续接入，不在本期范围）。
5. **Qwen3-TTS**：`HF_HOME=<server>/models/hf` 注入后，权重落到受管目录；存量 `~/.cache/huggingface` 权重在引导时提示「重新下载或手动移动」（不做静默搬移，避免半路损坏）。
6. **SenseVoice 原始版（funasr）**：新建受管 `.venv-funasr`（torch MPS + funasr + modelscope，锁定版本），替换 `/opt/homebrew/bin/python3` 硬编码；funasr 的模型缓存经 `MODELSCOPE_CACHE` 统一进 `models/modelscope/`。
7. **CosyVoice3 克隆**（最重，单独见 §六 S4）：vendoring 源码 + venv 自举 + 权重逐文件清单。**实施前必须验证**：`cosyvoice3.yaml` 实际加载的是 `llm.pt` 还是 `llm.rl.pt`、`speech_tokenizer_v3.onnx` 还是 `.batch.onnx`、以及 `flow.decoder.estimator.fp32.onnx` 与 `flow.pt` 的关系——据此把非必需文件标 `required:false`，预计可省 ~3GB。

---

## 五、运行时引导（拍板：首启检测 + 引导安装）

### 5.1 检测项与判定

| 依赖 | 探测方式 | 缺失时的引导 |
|---|---|---|
| Node.js ≥ 20 | Rust 侧 `which node` + `node -v` | 显示两条路：`brew install node`（可复制）/ 官网 pkg 下载链接 →「我装好了」复检 |
| Python3 ≥ 3.10 | `which python3` + 版本 | 同上（macOS 自带或 Xcode CLT 通常满足） |
| git | `which git` | 仅标注「可选，CosyVoice 源码兜底克隆用」；vendoring 生效后非必需 |
| asr-server 资源包 | 设置里的 `server_path` 校验 | 引导下载 release zip → 解压 → 指认目录 |
| **node_modules** | 关键包存在性检查（`node_modules/sherpa-onnx-node` 等） | **自动安装**：向导内执行 `npm ci`，NDJSON 进度条；支持 npmmirror registry 切换 |
| **各引擎 Python 环境** | manifest `runtime.venv` 目录存在且依赖完整 | **自动创建**：`python -m venv` + `pip install -r <lock>`，进度可见；支持 pypi 镜像切换 |

### 5.2 自举时序（依赖安装与模型下载同级、同可视化）

```
探测 Node/Python/git
   → npm ci（一次，进度条）
   → 逐引擎按 manifest.runtime：建 venv + pip install（哪个引擎要用到才装，进度条）
   → 按 manifest.files 校验模型文件 → 缺件进入下载队列（多镜像）
   → 全绿 → start-all 拉起就绪的服务
```

每一步都是向导里的一张卡片：状态 / 耗时预估 / 失败重试。**原则：包里只有必要代码，其余一切（npm 依赖、Python 环境、模型）都是「检测 → 可安装」**。

### 5.3 交互形态

首启若检测不通过，主界面上方出现常驻引导条（不阻塞浏览其他面板）；点击展开分步向导，每步：说明 + 可复制命令 + 「我装好了，重新检测」。**检测逻辑同时用于启动期与设置面板**（设置面板新增「环境自检」区块，随时可看）。

### 5.4 明确不做（本期）

- 不内置 Node/Python sidecar（体积代价 ~100MB+；若上线后用户流失于此环节，再评估内置方案，接口上留好）。
- 不做静默系统级安装（不弹管理员密码，全部用户态操作）。
- **任何发布产物内不出现 node_modules / .venv-\* / models**（CI 加体积断言防回归）。

---

## 六、分阶段实施计划（每阶段独立可见、可验收）

### S1 · 前置清理：统一落盘 + 环境探测（地基，改动小）
- 改 `start-all.js`：注入 `HF_HOME` / `TRANSFORMERS_CACHE`(即 transformers.js cacheDir) / `MODELSCOPE_CACHE` → 全部收敛到 `<server>/models/`；`PY_SYS` 改探测序列（env → PATH `python3` → 报错指引）。
- 改动面：`start-all.js`、`asr-server.js` 少量、各 py 服务读取 env。
- **验收**：清空散落后从零安装，所有模型文件只出现在 `models/` 子树下；「打开数据文件夹」肉眼可查。

### S2 · manifest 机制 + readiness API（框架成型）
- 新增 `engines/*.json`（8 份）+ 加载器 + `checkReadiness()`；`GET /models` 返回明细；通用下载器落地（§3.4）；`POST /install-model` 改为按 manifest 逐文件补齐。
- **验收**：curl `/models` 能看到每引擎缺失明细；删一个文件后 API 如实报告；一键补齐恢复。

### S3 · 模型管理 UI 改造（用户价值主交付）
- `ModelsPanel.tsx` 重构：每引擎状态卡（§3.3 的三种状态三种按钮）、NDJSON 进度条、暂停/续传、镜像源切换下拉、磁盘剩余空间提示、许可证角标。
- **验收**：新目录从零开始，纯点 UI 完成 Kokoro + SenseVoice + LLM 安装，识别/朗读/对话跑通。

### S4 · CosyVoice 专项（唯一「非纯模型」引擎根治）
- vendoring：裁剪子集进 `asr-server/vendor/cosyvoice/`（锁定 commit、保留 LICENSE、记录版本号）；installer 改「校验优先、clone 兜底」（010 §3.2-A 定案）。
- `requirements-cosyvoice.lock` 从现 `.venv-cosyvoice` freeze 提炼；自举脚本自动建 venv 装依赖；`NUMBA_CACHE_DIR` / `MPLCONFIGDIR` 注入。
- 权重清单化 + 非必需文件甄别（§四.7，省 ~3GB）。
- **验收**：删除 venv + vendor 目录后，纯靠 UI 引导重建，克隆全流程（新建音色→生成→朗读）可用。

### S5 · 运行时首启引导向导（§五 落地）
- Rust 探测命令 + 引导条/向导组件 + 设置面板「环境自检」区块。
- 向导卡片覆盖全链路：Node/Python 检测 → `npm ci`（进度）→ 各 venv 创建 + 装依赖（进度）→ 模型下载入口（衔接 S3 的 UI）。
- **验收**：干净机器（无 node、无 node_modules、无 venv）跟向导走通识别 + 朗读；每步失败可重试，镜像可切换。

### S6 · 打包发布形态
- 定义 release 双产物：`OpenSound.app`（预计 **~27–30MB**）+ `opensound-asr-server-macos-arm64.zip`（**仅必要代码**：源码 + vendor/ + engines/ + locks，~10MB 级）；GitHub Actions 打包脚本；README「三步上手」。
- 体积红线入 CI：发布物内出现 node_modules / .venv-* / models 即构建失败。
- **验收**：他人在自己机器按 README 走通全链路（真实外测，不以本机通过为准）。

### S7 · 同构性试金石：接入 FireRedASR2
- 按 002-research §1.2：sherpa-onnx 同栈，只新增 `engines/fire-red-asr2.json` + 引擎注册 + 识别面板选项。
- **验收**：全程不改框架代码；记录实际耗时/代码量，作为「框架成熟度」量化指标。此后任何 GPU 大模型（DOTS-TTS、IndexTTS2…）都只是「再写一份 manifest + 一份 requirements」。

> 顺序依据：S1 是 S2 的前提（位置统一才能校验）；S2 是 S3 的前提（API 先于 UI 数据）；S3/S4/S5 相互独立可并行；S6 收口；S7 验证框架主张。遵循铁律：每阶段完成后停下汇报，经确认再进入下一阶段。

---

## 七、风险与开放问题

| # | 风险/问题 | 应对 |
|---|---|---|
| R1 | HF 官方在国内直连慢或不稳（已拍板默认 HF） | 镜像切换入口放在每张状态卡上（不只全局设置）；后续可加自动测速选源 |
| R2 | 大文件 sha256 本地计算昂贵 | 优先取 HF LFS pointer 的 sha256（API 免费拿）；拿不到就退化为字节数校验 |
| R3 | CosyVoice 非必需文件甄别错误导致启动失败 | 甄别结论必须经「最小文件集启动实测」验证后才标 `required:false`；保守时可全标必需 |
| R4 | vendoring 粒度（010 开放决策）：裁剪子集 vs 整仓浅拷贝 | 建议裁剪子集（~7MB）；升级麻烦的代价可接受，clone 兜底仍在 |
| R5 | 引导安装 Node 仍是小白门槛（拍板已知取舍） | 向导文案做到「复制一条命令」级别；埋点统计流失，必要时再评估 sidecar |
| R6 | 各模型许可证差异（IndexTTS2 bilibili 许可、Fish S2 研究许可等） | manifest 增加 `license` 字段，UI 角标展示，商用风险留给用户知情判断 |
| R7 | 全家桶磁盘占用 > 20GB | 安装前显示总体积与剩余空间，超限预警 |
| R8 | funasr/modelscope 的缓存环境变量是否完全生效需实测 | S1 验收项包含「从零安装后 models/ 子树外无任何模型缓存残留」的核查 |
| R9 | npm / pypi 拉取在国内慢（依赖安装也是下载） | 自举器支持 registry 切换（npmmirror / 清华 pypi），与模型镜像同一套切换 UI |
| R10 | 现有两个 venv 均借用系统 torch（`include-system-site-packages=true`），自建 venv 会各自拉一份 torch（~500MB/份） | 本期按引擎分 venv（与现状一致）；合并共享 venv 列为后续优化，须先验证三套依赖可共存 |

---

## 八、决策记录

- 2026-08-22：五项拍板见 §〇；本方案获方向认可，S1 未开工。后续每阶段验收后在本文档追加一行进度记录。
- 2026-08-22（二次）：**打包边界定案——只打包必要代码，node_modules 与 Python 环境一律是「可安装项」**（首启检测 → 自动/引导安装）。依据实测：纯代码仅 236KB；node_modules 523MB（native 栈压缩传输 ~142MB）；`.venv-qwen3` 1.2GB / `.venv-cosyvoice` 565MB 且均借用系统 torch（不可搬运）。结论：App 本体 ~27–30MB，远低于 100M 期望线；CosyVoice 非模型文件 = 源码子集 ~7MB（打进包）+ Python 依赖（可安装项）+ 权重（用户下载）。
- **S1 实施完成（2026-08-22，待用户验收）**：`start-all.js` 注入 `HF_HOME`/`MODELSCOPE_CACHE`/`NUMBA_CACHE_DIR`/`MPLCONFIGDIR`（用户显式设置优先）+ 启动横幅打印生效路径；`PY_SYS` 探测序列（env → `which python3` → homebrew/usr 兜底 → 缺失给指引并跳过该服务不拖垮整体）；存量 qwen3 权重 2.3GB 已迁 `models/hf/hub/`（同盘 rename，未动 ~/.cache 其它项目模型）。核实修正：whisper JS 缓存与 funasr 三件套本就已落 `models/`（010 §2.2 表述过时）。验证：9528/8001/8002 全绿；kokoro+qwen3 合成→16k 重采样→sensevoice-original 识别闭环通过；`~/.cache/huggingface` 无再生。⚠️ 发现：`HF_HUB_OFFLINE=1` 会触发 transformers `fix_mistral_regex` 强制联网的 upstream bug（S5 引导设计时不得默认开离线旗）。
- **S2 实施完成（2026-08-23，待用户验收）**：① `asr-server/engines/*.json` 8 份清单落地（checks=文件/目录/glob 三类校验含期望字节数，runtime=依赖声明，install 四种方式）；② `/models` 升级为就绪明细（state ∈ running/ready/partial-files/missing-runtime/incomplete + missingFiles/missingRuntime/totalMissingBytes），旧字段向后兼容；③ 通用多镜像下载器 `downloadOneFile`（.part 原子改名 + curl -C 断点续传 + <20KB/s 持续 90s 自动换源 + 下载后字节数校验）落地，LLM 两档安装器已切 manifest 驱动；④ SERVER_VERSION → 2.3.0。验收：删 tokens.txt → partial-files 精确报告 → install-model 补齐恢复（字节数正确、大文件不重下），8 引擎状态全部正确（cosyvoice-clone 如实报 missing-runtime=源码子集）。顺手修两个存量 bug：start-all 自杀（自身探测连接被 lsof 列入杀戮名单 → `-sTCP:LISTEN` + 排除自身 PID）；runLlmDownload 的 `fs.renameSync` 未定义引用。待办移交 S3/S4：punc 权重实际来源未查明（目录仅词典+`.mdl` 指针但 /punc 功能正常）；镜像顺序现按「hf-mirror 优先」保可用，S3 镜像切换 UI 落地时把拍板的「默认 HF 官方」做成可配置默认值。
- **S3 实施完成（2026-08-23，待用户验收）**：`ModelsPanel.tsx` 重构为状态卡（五态徽标、缺失文件逐条+字节、运行时缺失、许可证角标、补齐按钮带体积、进度条、取消续传、镜像切换下拉）+ 磁盘余量行；后端配套 `/install-cancel`、`/disk`、`/install-model&mirror=`、progress 事件（800ms 打点 .part 大小）；TS 构建通过；vite dev 可见即验（http://localhost:1420）。
- **S4 主路径完成（2026-08-23，待用户验收）**：① vendoring 落地 `vendor/cosyvoice/`（裁剪 3.6MB，commit 记录 VENDOR_COMMIT；源码甄别实锤：CosyVoice3 仅加载 llm.pt/flow.pt/hift.pt/speech_tokenizer_v3.onnx/campplus.onnx/yaml，llm.rl.pt/.batch.onnx/fp32.onnx 非必需共 4.3GB，暂未删）；② `requirements-cosyvoice.lock`（freeze --local + torch/torchaudio/numpy 显式钉版）；③ installer 升级全自举链（vendor 优先→clone 进 vendor 并自动修剪→venv 缺失自动创建+pip 装锁→模型校验）；④ `cosyvoice-tts-server.py` sys.path 优先 vendor；⑤ 8003 从 vendor 启动成功，4 音色全部加载并试听合成，克隆朗读端到端通过（4.8s 音频）——最初报告的「克隆引擎未就绪」已根治。**遗留（拍板移至 S5 验）**：删 venv+vendor 后的全自举重建路径未实测；SERVER_VERSION → 2.4.0。

---

## 九、执行进度总览与答疑（2026-08-23）

### 9.1 进度总览

| 阶段 | 内容 | 状态 | 验收情况 |
|---|---|---|---|
| S1 | 统一落盘 + 环境探测清理 | ✅ 完成 | 用户确认（qwen3 缓存迁入 models/、PY_SYS 探测、路径横幅、缓存无再生） |
| S2 | manifest 机制 + readiness API + 通用下载器 | ✅ 完成 | 用户确认（删文件→报告→补齐闭环；顺手修 start-all 自杀 + runLlmDownload 未定义引用） |
| S3 | 模型管理 UI 状态卡 | ✅ 完成 | 用户确认（状态卡/进度条/取消续传/镜像切换/磁盘余量，vite dev 可见） |
| S4 | CosyVoice 专项（vendoring + venv 自举 + 权重甄别） | ✅ 主路径完成 | 克隆功能已恢复并实测合成通过；**删 venv+vendor 全自举重建按拍板移到 S5 一起验** |
| S5 | 运行时首启引导向导（Node/Python 检测、npm ci、venv 自建、模型下载入口） | ⏳ 未开始 | — |
| S6 | 打包发布形态（App + asr-server 资源包、CI 体积红线） | ⏳ 未开始 | — |
| S7 | 同构性试金石（FireRedASR2 接入） | ⏳ 未开始 | — |

当前运行时版本：asr-server **2.4.0**（S1–S4 代码全在；8001/8002/8003 正常）。

### 9.2 答疑 Q1：现在重新构建 App，能测什么？

**能测（= 开发者本机闭环，已全部打通）**：
- 最新「模型管理」状态卡 UI（五态 / 缺失明细 / 进度条 / 取消续传 / 镜像切换 / 磁盘余量）
- 8 个引擎的就绪态如实显示（cosyvoice-clone 恢复可用）
- 删除/补齐/镜像切换/取消下载全流程（可在新目录从零下载验证）
- 克隆音色朗读（S4 已治愈）

前提：App 设置里的模型保存路径指向**当前 asr-server 目录**（本机一切依赖与模型齐备）。

**不能测 / 尚未实现（= 新装机体验）**：
- 无 Node.js / 无 Python 时的一键引导向导（S5 未做）
- asr-server 资源包（含 vendored 代码的 zip）发布形态（S6 未做）
- 除 cosyvoice 外其它引擎的 venv 自动创建（S4 只做了 cosyvoice 一家）

**结论**：当前「重新构建 App → 本机完整测试最新逻辑」✅ 成立；但「别人下载 App → 只选目录 + 下模型就能用」的对外闭环还差 S5 + S6。

### 9.3 答疑 Q2：关于「打包必要代码」

现状：**必要代码（asr-server JS/PY + vendor/cosyvoice 3.6MB + engines/*.json + requirements locks ≈ 4MB 级）已经全部就位于 asr-server 目录内**，且已在 v2.4.0 千真实运行——它们就是打包候选物。但「对外发布产物」本身（App 内含 or 随附 zip）要等 S6 落地才会成型；当前 16.5MB 的 App 仍是壳，运行依赖项目目录里的 asr-server。

换句话说：**打包内容已备好、打包动作未做**。这正是 S6 的活（release 双产物 + CI 体积红线：发布物不含 node_modules / .venv-* / models）。
