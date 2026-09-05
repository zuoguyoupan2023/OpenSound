# 059 · Mac 显示「缺少受管 Python 基础环境」：原因、Win/Mac 出厂差异与处理建议（2026-09-05）

> 起因（用户原话整理）：Mac 上打开**新构建的 .app** 后，顶部出现「缺少受管 Python 基础环境（uv + CPython 3.11）」；而**旧的 .app 直接可用**。用户疑问：① 这是为什么；② 旧 App 能用是不是因为第一阶段直接在命令行/代码环境里跑；③ Mac 不是自带 python 吗，Win 出厂配置是怎样的、Mac 是怎样的；④ Mac 这边如何处理，建议是什么。
> 前提澄清（已确认）：旧包问题已定位 = 打开的是**旧的 .app**（多副本残留）；新 .app 界面正常，此文档只回答受管 py 缺失问题。
> 代码依据（均已只读核实）：`src-tauri/src/lib.rs`（ensure_python_base / python_base_status / data_root / ensure_node）、`asr-server/start-all.js`（venvPy / detectSysPython / DATA_DIR）、`ui/src/App.tsx`（引导条文案）、`ui/src/panels/SettingsPanel.tsx`（环境与运行时区块）、`asr-server/asr-server.js`（uv venv 安装器分层）。
> 关联文档：`032`（运行时自举与数据目录统一）、`034`（uv 自举阶段3）、`001-跨平台适配.md`（Win 现状 + Mac 对齐）、`000-plan-2.md`（Win 阶段 C/D）。
> 状态：**说明 + 建议文档**（未改代码）。处理动作在 Mac 的 App 内完成，无命令行要求。

---

## 〇、环境自举全景（先读这段，再看后面细节）

> 本节回答"这个项目里 node / py 等环境**整体逻辑**是什么、Win 与 Mac 各自怎么跑、不同场景为什么这么设计"。细节展开见后文各节与 `032`（设计）、`034`（uv 自举）、`001-跨平台适配`（两端差异表）。

### 0.1 一条主线：一切运行时都由 App 内按钮自举，不依赖系统环境

```
App 要跑通 = 两个前提，各自由独立按钮负责（普通用户全程只点按钮）：

前提① 后端服务能跑：node 运行时 + asr-server 依赖（npm ci）
  入口：引导条/设置页「安装 Node」→ 检查链：App 便携版 → 系统 node(≥18 捡现成) → 下载便携版
前提② 引擎能跑（python 系三个：qwen3/原始版/cosyvoice）：
  入口A：引导条/设置页「安装 Python 基础」→ 下载 uv → uv python install 3.11（受管 CPython）
  入口B：模型管理页对应卡片 → uv 用受管 3.11 建 venv(.venv-*) + 下载权重（装完自动启用）
轻量引擎（kokoro/SenseVoice 量化/Whisper/本地 LLM GGUF/云端）不需要前提②。
```

### 0.2 组件落盘总表（Win/Mac 同构；默认数据根 = `<HOME>/Downloads/opensound-download`，设置「模型存放目录」可改）

| 组件 | 谁触发 | 装到哪 | 就绪判定只看 |
|---|---|---|---|
| 便携 Node v24.19.0 | 「安装 Node」（无系统 node 或 <18 时） | App 私有目录：`~/Library/Application Support/world.opensound.local/runtime/node/`（Win: `%APPDATA%\world.opensound.local\runtime\node`） | 系统 node ≥18 即算就绪（不下载） |
| asr-server 依赖 | 「安装 Node」连带 npm ci | 服务代码目录 node_modules | 关键包在（deps_ready） |
| uv 工具 | 「安装 Python 基础」 | 数据根 `runtime/uv/` | uv 可执行文件在 |
| 受管 CPython 3.11 | 「安装 Python 基础」（uv python install） | 数据根 `runtime/python/cpython-3.11*/` | cpython-3.11*/bin/python3 在 |
| 引擎 venv（3 个） | 模型管理页对应卡片 | 数据根 `venvs/.venv-qwen3 / .venv-funasr / .venv-cosyvoice` | venv python + 关键依赖包在（防空壳） |
| 模型文件 | 模型管理页对应卡片 | 数据根 `models/…` | 文件 + 字节校验 |

### 0.3 Win 与 Mac 的差异 = 仅此几处（其余全部同一份代码同一套逻辑）

| 差异点 | Windows | macOS |
|---|---|---|
| 便携 node 包 | `node-vXX-win-x64.zip` | `node-vXX-darwin-arm64.tar.gz`（⚠️ Intel Mac 缺口见 001 §6.2） |
| 系统 node 查找 | PATH → `%APPDATA%\nvm\<v>\node.exe` → Program Files | PATH → `~/.nvm/versions/node/*/bin/node` → `/opt/homebrew`、`/usr/local` |
| venv 结构 | `Scripts/python.exe` | `bin/python3`（venvPy 助手统一） |
| uv 包 | `uv-x86_64-pc-windows-msvc.zip` | `uv-aarch64/x86_64-apple-darwin.tar.gz` |
| 系统 python 角色 | 探测展示（`where python3/python`），**不参与引擎** | 探测展示（`which` + 常见路径），**不参与引擎**（即使存在也不用） |
| 数据根默认 | `<USERPROFILE>/Downloads/opensound-download` | `<HOME>/Downloads/opensound-download` |

### 0.4 分场景设计思路（为什么这样设计）

| 场景 | 行为 | 设计原因 |
|---|---|---|
| 开发者机器已有 node ≥18（你的 Mac） | node 直接"捡现成"用（显示其真实路径，不下载） | node 只跑 JS 后端，任何 ≥18 来源等价；省一次下载、首启快 |
| 开发者机器有系统 python（你的 Mac） | **不捡**，仍装受管 3.11 | python 承载引擎 venv/torch，版本来源必须锁死：两端一致（Win 无系统 py，捡现成分支本就不成立）、可复现、不依赖 Xcode CLT、不污染系统 |
| 全新 Mac/Win，普通用户（无 node 无 py） | 引导条两步各点一次：装 Node（便携）→ 装 Python 基础（uv+3.11）；模型页再逐引擎 | 全 App 内闭环、无终端/sudo/CLT；位置都在 App/数据根私有目录，不进系统、不改 PATH |
| 系统 node 版本 <18 | 自动下载便携 v24.19.0 覆盖 | 后端最低要求 ≥18，版本由 App 控制 |
| 网络受限/国内 | npm/uv/github 全部走镜像链（npmmirror/tuna/ghfast）+ 失败判死换源 | 官方优先 + 自动切换（AGENTS 铁律 F / 000-summary §十） |
| 换机/重装想复用已下载模型 | 设置「模型存放目录」可改位置/迁移旧 models | 数据根可配置，避免大体积重下 |

---

## 一、一句话结论

「受管 Python 基础」= **App 自己下载安装的 uv 工具 + uv 托管的独立 CPython 3.11**（不是系统 python）。它**只在你在 App 内点「安装 Python 基础」时才安装，App 不自动装**。Mac 新 .app 是首次运行这套逻辑、数据根里还没有 uv/CPython → 所以提示缺失。这**不是报错**，是 Win 阶段二定下的"App 内自举、普通用户零环境"设计的正常第一步；Mac 上与"系统有没有 python"无关（设计上**故意不用**系统 python）。

---

## 二、直接原因（代码级）

### 2.1 "受管 py"到底指什么、检查哪个路径

- 分层（lib.rs 注释 + `python_base_status()`，L1234）：
  - **① 全局 py 基础** = `uv` 可执行文件（数据根 `runtime/uv/uv` 或 `uv.exe`）+ **受管 CPython 3.11**（数据根 `runtime/python/cpython-3.11*/bin/python3`）。两者齐备才 `python_ready = true`。
  - **② 引擎 venv**（`venvs/.venv-qwen3` / `.venv-funasr` / `.venv-cosyvoice`）= 模型管理页对应卡片安装，**不属于**这个全局按钮。
- 数据根（`data_root()`，L1343）：默认 **`<HOME>/Downloads/opensound-download`**（Win/Mac 一致，032 P3 拍板：模型体积大，不放系统盘/系统目录）；设置「模型存放目录」可改（Win 这台实测改到了 `E:\Downloads\opensound-download`）。
- 触发安装的唯一入口（lib.rs L912 注释明确"只在用户点…执行——App 不自动触发"）：顶部引导条「安装 Python 基础」按钮或设置页「安装 / 修复 Python 基础」→ `ensure_python_base()`：下载 uv（双镜像，~20MB）→ `uv python install 3.11`（~100MB 口径，不碰系统 python）。

### 2.2 为什么 Mac 新 .app 会显示它

- Mac 新 .app 首次运行 → 数据根（`~/Downloads/opensound-download`，首次为空）`runtime/` 下没有 uv、没有 cpython-3.11 → `python_ready=false` → 引导条显示「缺少受管 Python 基础环境（uv + CPython 3.11）」，设置页「环境与运行时」同步显示 ❌ uv / ❌ CPython 3.11。
- 若没提示缺 Node：因为 `ensure_node()`（L844）允许**系统 node 版本达标直接使用**（Mac 开发机一般有 node）；而 python 系引擎**没有"系统 python 达标可用"的替代选项**——被设计为只用受管 3.11（版本可控、与 Win 一致、不依赖 Xcode CLT）。系统 python 在设置页只做展示行（`✅ 系统 Python x.x.x（仅展示；python 系引擎用 App 受管环境）`）。

### 2.3 不装会怎样

- 只影响三个 python 系引擎：**Qwen3 TTS（8001）/ SenseVoice 原始版（8002）/ CosyVoice 克隆（8003）**——UI 文案与设置页均注明「不装 py 则这三个引擎不可用，其余不受影响」。
- 不受影响：kokoro / SenseVoice 量化版 / Whisper（9528 内进程内引擎）、本地 LLM（llama-cpp GGUF）、全部云端能力。

---

## 三、为什么旧 App 能直接用（第一阶段 vs 现在的架构）

**基本正确——第一阶段是"开发者模式"，环境本来就在机器上/项目里：**

| | 第一阶段（Mac 开发期） | 现在（Win 阶段二定稿，两端一致） |
|---|---|---|
| 后端放哪 | 跑在**代码目录** asr-server（App 是壳，`server_path` 指向它） | 仍是代码目录/随包资源，但**用户数据全部搬出**到数据根 |
| python 从哪来 | **系统 python**（homebrew `/opt/homebrew/bin/python3` 等，`detectSysPython()` 探测）在项目里建 `.venv-*` | **uv 受管 CPython 3.11**（数据根 `runtime/`），引擎 venv 建到数据根 `venvs/.venv-*` |
| 模型/venv 落点 | 项目目录 `asr-server/models`、`asr-server/.venv-*`（命令行 `npm run all` 或 App 指向） | 数据根 `models/`、`venvs/`（`OPENSOUND_DATA_DIR` 注入；start-all `venvPy()`：受管 venv 优先，**代码目录 .venv-\* 仅作历史兼容回退**） |
| 谁来装环境 | **开发者自己**（终端/脚本/第一阶段的安装器，机器上早配好了） | **App 内按钮自举**（普通用户不碰终端）——这才是 Win 阶段二验收的核心（001 共性目标） |

所以：旧 App 能直接用，是因为"系统 python + 项目目录里建好的 venv + 下好的模型"都是你第一阶段在开发机上早已备好的东西；新 App 换到全新受管数据根，那套旧环境不在它的账上，需要按新架构走一遍 App 内自举。这正是跨平台统一要付的"一次性的首次设置费"。

---

## 四、Win 出厂 vs Mac 出厂（你到底在问什么）

### 4.1 系统层面（OS 自带）

| | Windows（Win10/11） | macOS |
|---|---|---|
| python | **默认没有**（系统基本不带；商店版需用户自行安装） | 自带 `/usr/bin/python3`，但**版本通常较旧**（常见 3.9.x），首次真实执行可能弹"Command Line Tools"安装 |
| node | 默认没有 | 默认没有 |
| 其它 | WebView2 自带 | — |

### 4.2 App 层面（设计口径，两端刻意一致）

| | Windows（这台开发机，实测） | macOS（你的新 .app，所见） |
|---|---|---|
| 受管 node | 引导条装过（或系统 node 达标直用） | 系统 node 达标直用（故没提示缺 Node） |
| 受管 uv + CPython 3.11 | ✅ `E:\Downloads\opensound-download\runtime\{uv,python}`（config.json `data_dir` 指向 E 盘） | ❌ 数据根 `~/Downloads/opensound-download/runtime/` 为空 → 提示缺失 |
| 引擎 venv | ✅ `venvs\.venv-cosyvoice` / `.venv-funasr`（模型页装的） | ❌ 尚无（引擎还没在模型页装） |
| 系统 python | 本机有 3.12.3，**仅展示不用**（设置页那行字） | macOS 自带 python3，同样**仅展示不用** |

结论：**"Mac 有 python 所以不该缺"是把系统 python 与受管 python 混为一谈了。** App 缺的是自己数据根里由 uv 下载的 CPython 3.11；系统 python 存在与否、版本多少，都不影响这个判定——这是有意的（版本固定 3.11、与 Win 完全同构、不污染系统、不依赖 Xcode CLT/开发者工具）。

---

## 五、Mac 处理建议（按顺序，全在 App 内完成）

1. **确认打开的是新 .app**：看设置页「环境与运行时」底部展示的**数据目录/服务目录**，确认是当前期望路径；若数据根为空目录即正常（首次）。
2. **装受管 py 基础**：点顶部引导条「安装 Python 基础」（或设置页同按钮）→ 自动下载 uv + CPython 3.11（~100MB，走双镜像；uv 支持 Apple Silicon / Intel 双架构）。完成后设置页「uv / CPython 3.11」两行变 ✅。
   - 若下载中被 macOS 拦截提示"无法验证开发者"（仅未签名分发会遇到的 Gatekeeper 问题，与功能无关）：系统设置 → 隐私与安全性 → 允许。开发自签构建一般不会触发。
3. **到模型管理页逐个装 python 系引擎**：Qwen3 TTS、SenseVoice 原始版、CosyVoice 克隆——各自建 venv（数据根 `venvs/.venv-*`）+ 下载权重，装完自动启用并重启服务；kokoro / SenseVoice 量化 / Whisper / LLM 不需要 py，随时可装。
4. **可选：复用第一阶段已下载的模型，省流量**（仅当你不想重下）：
   - 若旧模型在**服务代码目录 `asr-server/models/`**：设置页「模型存放目录」区块有**迁移按钮**（把旧 models 搬进数据根）。
   - 若旧模型在其它位置：把「模型存放目录」直接填成旧模型所在父目录 → 保存并重启服务（uv/python/venv 也会随之建在该目录）。
   - ⚠️ 两步都别在没把握时乱改；改前先记下设置页当前数据目录，失败可改回默认（清空该项 = 回默认 `~/Downloads/opensound-download`）。
5. **不要**为省事去"让 App 用系统 python / 把旧项目环境指给它"——那等于绕回第一阶段开发者模式，与 Win 行为分裂，正是第三阶段要消除的差异；旧项目目录留着继续做开发可以，但**新 .app 的唯一数据源是数据根**。

> 与 001 §6.4 的关系：以上 1–3 走通 = 001 §6.4 P2「Mac 从零验收」的运行时自举段（普通新 Mac 用户 App 内全搞定，不依赖系统 python/node，两端 uv 受管 CPython 3.11 保证版本一致）。

---

## 六、登记 / 后续可选小改进（本次不做）

1. **uv 下载/安装镜像**：`uv python install` 默认走官方 python-build-standalone（GitHub）。若国内网络下 Mac 下载 3.11 慢，可后续给 `run_uv` 注入 `UV_PYTHON_INSTALL_MIRROR`（同类镜像 env 已有 UV_INDEX_URL 先例）——小改动，列入可选。
2. **Intel Mac node 缺口**：`ensure_node` 非 Win 一律下 `darwin-arm64`（lib.rs L864-868），Intel Mac 会拿错包——已登记 001 §6.2 缺口 1，P1 排期修；你的 M4 不受影响。
3. **旧 .app 残留**：Mac 上删掉旧的 OpenSound.app 副本（/Applications、~/Applications、Dock 固定项），避免再次误开旧包（本次"还是第一阶段 UI"的根因）。

---

## 七、Node 为什么不缺、py 却缺 —— 判定差异，与全新 Mac 会怎么装

> 用户追问：Mac 上有 node 和 py，为什么新 App 只提示装 py，node 却显示「就绪 /Users/xxx/.nvm/versions/node/v22.14.0」？这个差异是怎么造成的？全新 Mac 的普通用户，node 和 py 分别会怎么装、装到哪？

### 7.1 判定逻辑差异（代码级，check_runtime / lib.rs L1177-1208）

- **node（L1184-1191）**：在 `[App 已下载的便携版, 系统 node（find_node() 找到的）]` 里**依次取**，谁先能跑出版本且主版本 ≥18（`RUNTIME_NODE_MIN_MAJOR`），就 `node_ok=true` 并**原样显示它的路径**。`find_node()`（L694-753）按：显式环境变量 → PATH → nvm 目录（Unix 扫 `~/.nvm/versions/node/*/bin/node`）→ 固定位置（homebrew 等）。
  - 你的情况 = 便携版没下载过，于是命中 `~/.nvm/versions/node/v22.14.0`（你自装的）→ 版本 22 ≥ 18 → **直接用，路径如实显示**。
- **python（L1192-1208）**：系统 python **只做一行展示**（`python`/`python3 --version` 跑通就显示版本）；真正的 `python_ready` **只认**数据根 `runtime/uv` + `runtime/python/cpython-3.11*`。**系统 python 永不参与就绪判定**——所以 Mac 有没有 py、版本多少，与该提示无关。

### 7.2 差异为什么这样设计

- **node 的角色** = 跑 asr-server（JS 后端）+ `npm ci` 装依赖。要求只有"版本 ≥18"，**任何来源等价**：系统里有现成的就直接用（省一次 ~50MB 下载、首启更快）；没有或版本旧 → App 下载**便携 Node v24.19.0**（nodejs.org → npmmirror 镜像）兜底。注释原文："受管便携版优先 → 系统 node（版本达标）→ 下载便携版"。
- **python 的角色** = 三个引擎（qwen3 / sensevoice-原始 / cosyvoice）venv 的底座，要装 torch（MPS/CUDA）等与 Python 版本/OS/加速器强绑定的东西。必须**锁定版本与来源**：① 与 Win 一致（Win 根本没有系统 py 可选，"系统 py 达标先用"这种分支在 Win 上不成立，两端会口径分裂）；② 可复现可排障（macOS `/usr/bin/python3` 版本旧、可能只是 CLT 空壳；homebrew 升级会连带弄坏旧 venv——本项目踩过 torch/依赖漂移的坑）；③ 不依赖 Xcode CLT/开发者工具；④ 不污染用户系统。
- 一句话：**node 是"有现成捡现成、没有才自带"；python 是"一律自带、版本锁死 3.11"。**

### 7.3 全新 Mac、不懂代码的普通用户，会看到什么、装到哪

| 步骤 | 界面 | 做了什么 | 装到哪（普通用户无需关心，App 全自动） |
|---|---|---|---|
| 1 | 顶部引导条「缺少 Node.js 运行环境」→ 点「安装 Node」 | 下载便携 Node v24.19.0（darwin-arm64）→ 解压 | `~/Library/Application Support/world.opensound.local/runtime/node/node-v24.19.0-darwin-arm64/bin/node`（App 私有目录，不进系统、不改 PATH）；随后用它 `npm ci` 装服务端依赖到服务代码目录 |
| 2 | 顶部引导条「缺少受管 Python 基础」→ 点「安装 Python 基础」 | 下载 uv（GitHub 官方 → ghfast 镜像）→ `uv python install 3.11` | uv → `~/Downloads/opensound-download/runtime/uv/`；受管 CPython 3.11 → `~/Downloads/opensound-download/runtime/python/cpython-3.11*/` |
| 3 | 模型管理页逐引擎点安装 | 引擎 venv 用 uv + 受管 3.11 建 | venv → `~/Downloads/opensound-download/venvs/.venv-*`；模型 → 同数据根 `models/` |

全程无终端、无 sudo、无 CLT、不碰系统 python/node。数据根与 App 数据目录都可用设置/全局清理管理。

对照你现在的 Mac：node 被"捡"到现成的 nvm v22.14.0 → 就绪并显示该路径；py 没有可捡项 → 只能装受管。

> 备注登记：便携 node 仍在 **App 数据目录**（`~/Library/Application Support/...`），而 uv/python/venv/models 在**数据根**（默认 `~/Downloads/opensound-download`）——两处不一致是历史形成（node 自举早于 032 P3 数据根迁移，node 体积小未搬），可接受；未来可统一收敛到数据根 `runtime/node`，非必须。

## 八、变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-05 | 初版：定位"缺少受管 Python 基础"= uv + CPython 3.11 未在数据根自举（App 不自动装，须点按钮）；受管 py 与系统 python 的区分；第一阶段=系统 python+项目目录环境的开发者模式 vs 现在的 App 内自举架构；Win/Mac 出厂对照（含本机实测）；Mac 处理步骤与复用旧模型两条可选路径；登记 uv 镜像与 Intel node 缺口。 |
| 2026-09-05 | 增补 §七：node 判定链（便携版→系统 node，≥18 即用并显示路径）与 python 判定链（系统 py 仅展示、就绪只看受管 3.11）的差异与设计原因；全新 Mac 普通用户的 node/py 安装步骤与落盘位置对照；备注便携 node 在 App 目录、uv/python 在数据根的历史不一致。 |
| 2026-09-05 | 增补 §〇「环境自举全景」：一条主线（node→py 基础→引擎 venv/模型三层自举）+ 组件落盘总表 + Win/Mac 全部差异清单（6 行）+ 分场景设计思路表（6 场景），作为全项目 node/py 环境逻辑的总速览（细节仍在下文各节与 032/034/001）。 |
