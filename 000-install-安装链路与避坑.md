# 000-INSTALL · 安装链路与避坑手册（新会话接手必读）

> 定位：把"用户自己点击下载安装"这件事的**全部层级、全部已知坑、全部验收标准**一次讲清。
> 来源：034（自举设计）+ 035（python 引擎点亮，实测）+ 本册实测复现（08-28 晚 四连修）。
> 目标：**App 是一个好用的壳——用户决定装什么、不装什么；装的时候顺利，不跳坑、不静默、不白下**。
> 适用范围：所有"安装/下载"相关开发（新增引擎、改安装器、动 UI、动 Rust）。动手前先读 000 开头的铁律与本文件第四、五节。

---

## 〇、最高原则（任何安装功能的第一性约束）

1. **一切安装/下载由用户点击触发**（App 内按钮 / 用户跑脚本），AI、App、服务端绝不自动装。
2. **用户决定装什么、不装什么**：全局基础（node / python）各自独立按钮、可选；引擎 venv 归模型页卡片；模型文件归卡片「补齐」。分层不混淆（见 §二）。
3. **大流量（>1GB）必须二次确认**：服务端抛 `BIG_DOWNLOAD_CONFIRM:<size>GB:<name>`，前端弹确认行，用户确认后带 `confirm=1` 重试才真下载。
4. **可见即验收**：点按钮后必须有可见反应（确认行 / 进度流 / 错误日志）。"晃一下没反应" = bug，且通常是前端链路 bug（见 §四坑 A/B）。
5. **服务端改动 = 重启服务即生效；前端/Rust 改动 = 必须重建 exe 才生效**（构建前关掉 opensound.exe）。"改了没生效"九成是这个没分清。
6. **算力自动选择原则（三平台统一，见 §〇·A）**：有 GPU/MPS 用 GPU/MPS，没有就用 CPU；检测与降级都要如实、可见，绝不静默。
7. **用户三种情况的统一体验（App 内闭环，用户零手动操作）**：
   - **只用 CPU** → 默认装 CPU 版 torch（清华 PyPI），UI 如实显示"CPU"。
   - **有 GPU（装机即装 CUDA 版）** → 首次装 venv 时装 CUDA 版 torch（多镜像探测，国内优先）。
   - **CPU → 后来加显卡** → 已装 CPU 版 → 模型页出现**「升级 GPU 加速」按钮** → 点击 → 二次确认 → **App 自动停掉占用 venv 的引擎服务 → 复用已下载 wheel 秒装 → 校验 `+cu` → 提示重启服务**。全程无一条手动命令。
   - **铁律**：能在 App 内做的一律 App 内做；禁止把安装/升级动作写成"让用户手动跑命令"（用户明确要求）。

### §〇·A 算力自动选择原则（Win / macOS / Linux 统一口径，杜绝以后踩坑）

**一句话**：`torch` 等深度学习依赖按"本机可用加速器"选装——**有 N 卡装 CUDA 版、Apple Silicon 用内置 MPS、其它一律 CPU 版**；选错了要能检测出来并如实告知，宁可明说"CPU 模式"也不要悄悄慢。

| 平台 | 加速器 | 判定依据 | torch 变体 | 说明 |
|---|---|---|---|---|
| Windows + NVIDIA GPU | CUDA | `where nvidia-smi` 找到 | `--index-url https://download.pytorch.org/whl/cuXXX torch torchaudio` | 驱动需 ≥ 对应 cu 版本门槛（cu126≈550+，cu128≈570+）；装完必须校验 `torch.__version__` 含 `+cu` |
| Windows 无独显 | CPU | 无 nvidia-smi | PyPI 默认（清华镜像） | 无加速，如实显示"CPU"即可 |
| macOS（Apple Silicon M1+） | MPS | `torch.backends.mps.is_available()`（torch 自带，无需额外 wheel） | **PyPI 默认就行**，MPS 是内建后端 | 千万别给 macOS 装 CUDA 版（不存在）；qwen3-tts-server.py 的 `--device` 自动检测 mps |
| macOS Intel | CPU | — | PyPI 默认 | 无 MPS |
| Linux + NVIDIA GPU | CUDA | `nvidia-smi` | `--index-url .../whl/cuXXX` | 同 Windows CUDA 判定 |
| Linux + AMD GPU | ROCm（未来） | `rocm-smi`（预留） | `--index-url https://download.pytorch.org/whl/rocmXXX` | 当前未实现，属计划；实现时参照 CUDA 分支同样"装后校验" |
| Linux 无独显 | CPU | 无 GPU 工具 | PyPI 默认 | 无加速 |

**实现要点（已落地 / 将来必须遵守）**：
1. **判定用"硬件工具存在性"**：Win/Linux 用 `nvidia-smi` 在 PATH 中；macOS 用 torch 自带 `mps.is_available()`（不能靠 `uname` 猜，Intel Mac 无 MPS）。
2. **装完必须校验**：CUDA 版校验 `torch.__version__` 含 `+cu`（`torchBuildTag`，禁 `+cpu`）；MPS 校验 `is_available()` 为真。校验失败给**明确可操作的报错**（驱动门槛 / 换源 / 未真下载），禁止静默回落。
3. **uv/pip 升级已装包必须 `--reinstall-package`**：不带会"秒跳"不真装（实测坑，见 §四坑 N）。
4. **没有加速器就老实 CPU**：不装 CUDA 版、不吓用户；UI 如实显示"CPU 模式"（不要伪装就绪）。
5. **平台分支宁可多写几行也别猜**：Win 判定 nvidia-smi、mac 判定 mps、Linux 判定 nvidia-smi/rocm-smi，各自独立、互不干扰。

---

## 一、四层安装模型（谁负责哪层）

```
┌────────────────────────────────────────────────────────────┐
│ L0 全局基础：node + npm 依赖          ← 设置页/引导条「安装 Node 与依赖」│
│ L0 全局基础：uv + CPython 3.11(~100MB) ← 设置页/引导条「安装 Python 基础」(可选)│
├────────────────────────────────────────────────────────────┤
│ L1 引擎 venv：uv venv + pip 依赖       ← 模型页该引擎卡「检测/修复」      │
│     （含 torch 等大依赖，约 2.5GB，二次确认；N 卡可选升级 CUDA torch）       │
├────────────────────────────────────────────────────────────┤
│ L2 模型文件：权重/快照                  ← 模型页该引擎卡「补齐」           │
│     （qwen3 走 hf hub 快照；cosyvoice 走多镜像单文件下载，均二次确认）       │
└────────────────────────────────────────────────────────────┘
无 L0（eg. 不装 python）的其他引擎（kokoro/sensevoice/llm）完全不受影响。
```

| 层 | 用户入口 | 落盘位置 | 触发 | 大流量确认 |
|---|---|---|---|---|
| L0 node | 设置/引导条「安装 Node 与依赖」 | 数据目录 runtime/node*（Rust 侧） | App 按钮 | 无（~50MB） |
| L0 python | 设置/引导条「安装 Python 基础」 | 数据目录 runtime/uv + runtime/python | App 按钮 | 无（~100MB） |
| L1 venv | 模型页卡片「检测/修复」 | 数据目录 venvs/.venv-* | App 按钮 | 有（2.5GB） |
| L1 CUDA torch | 模型页卡片「升级 GPU 加速」（N 卡+CPU torch 时出现） | 同 venv | App 按钮 | 有（2.5GB） |
| L2 模型 | 模型页卡片「补齐」 | 数据目录 models/（hf / cosyvoice / sensevoice...） | App 按钮 | 有（2.3GB / 4.4GB） |

---

## 二、服务端安装器结构（asr-server.js，改动重启服务即生效）

- `uvVenvInstaller({ name, pkgs, lockRel, keyPkg, label, estGB })`：L1 引擎 venv 通用工厂。
  - 就绪判定 = **venv python 在 + site-packages 有 `VENV_KEY_PKG` 关键包**（防空壳假就绪，见坑 J）。
  - 未确认大流量 → `throw BIG_DOWNLOAD_CONFIRM:<estGB>GB:<name>`（坑 A 要求前端能接住）。
  - **035 扩展**：`HAS_NVIDIA && ready && torchIsCpuOnly(name)` → 走 CUDA 升级路径（坑 E/G）。
- `qwen3ModelInstaller(venvInst)`：qwen3 二段式 = venv（复用 uvVenvInstaller）+ 模型（`snapshot_download`，HF_HOME=models/hf）（坑 F）。
- `downloadOneFile`：多镜像 + .part 断点续传 + 可取消 + 字节校验（cosyvoice 权重等）。
- `/install-model?engine=&confirm=1`：NDJSON 进度流；`installer()` 抛错 → 服务端写成 `{"type":"error",...}` 行（坑 A）。
- `engineReadiness`：checkEntry 逐项核对 checks → state（running/ready/partial-files/missing-runtime/incomplete）+ `gpuUpgrade` 标记。

---

## 三、一次完整安装（以 qwen3 为例，验收标准）

1. 用户缺 python → 引导条/设置页「安装 Python 基础」（可选层，uv+CPython 3.11）。
2. 模型页 qwen3 卡「检测/修复」→ 确认 2.5GB → venv 装好（uv venv --clear + uv pip 清华镜像）。
3. N 卡机器若 venv 内 torch 是 CPU 版 → 卡片出现「升级 GPU 加速」→ 确认 2.5GB → CUDA torch（PyTorch 官方源）→ 重启服务。
4. 模型页 qwen3 卡「补齐」→ 确认 2.3GB → snapshot_download（hf-mirror）→ 徽标变绿。
5. 重启服务 → 朗读可选 Qwen3，GPU 秒级出声。
6. **全程用户点击，App 不自动装；每层失败都有可见错误，不静默。**

---

## 四、已实测的坑（症状 → 根因 → 修复 → 防复发）——新会话开发安装功能前必读

### 坑 A：大流量二次确认行永不出现（"点按钮晃一下")
- **症状**：点「检测/修复」按钮短暂 loading 即恢复；进度日志里出现裸文本 `BIG_DOWNLOAD_CONFIRM:2.5GB:.venv-qwen3`；无确认行、无后续。
- **根因（双层断链）**：
  1. 服务端 catch 到安装器抛错后，是把错误写成 **NDJSON error 行**（HTTP 仍 200）下发，不是 HTTP 错误；
  2. 前端 `api.ts/installModel` 把每条 NDJSON 行 `JSON.parse` 后直接丢给 `onProgress`，**对 `type:"error"` 行从不抛错** → `await installModel()` 正常返回 → `ModelsPanel` 的 catch 永不触发 → `setBigConfirm` 永不执行。
- **修复**（ui/src/api.ts）：`installModel` 读到 `parsed.type === "error"` 时 `throw new Error(parsed.message)`。catch 才能统一处理（识别 BIG_DOWNLOAD_CONFIRM → 弹确认行；其它 → 错误日志）。
- **防复发**：服务端"抛错给前端"的通道只有这一个——NDJSON error 行。前端流式读取时**必须**把 error 行转成抛错，否则 catch 里的一切（含二次确认）都是死代码。

### 坑 B：确认行渲染在 install-log 内，progress=0 时整块不渲染
- **症状**：确认行被写在 `<div className="install-log">` 内部，而该容器只在 `progress.length > 0` 时渲染；BIG_DOWNLOAD 分支不推 progress → 整块消失。
- **修复**（ModelsPanel.tsx）：确认行移出 install-log，**独立无条件渲染**（`{bigConfirm && (...)}`）。
- **防复发**：确认行/错误提示这类"关键交互"永远独立于"进度流"渲染，别依赖 progress 长度。

### 坑 C：uv venv 拒绝覆盖已存在的空壳 venv（exit 2）
- **症状**：`uv venv` 报 `A virtual environment already exists`，退出码 2，安装中止。
- **根因**：034 阶段曾建过**空壳 venv**（site-packages 只有 `_virtualenv`），uv 默认不覆盖。
- **修复**（asr-server.js）：`uv venv --clear`（仅在不达标走重建分支时使用；就绪时直接 done 不碰）。
- **防复发**：任何 `uv venv` 建环境命令都要考虑"已存在（哪怕是空的）"，加 `--clear` 或用"先判 keyPkg 再动"。

### 坑 D：runCmdWithEnv 成功分支漏调 resolve() —— venv 建完就没进展
- **症状**：日志停在 `✓ 命令完成（exit 0）`，后续"安装依赖…"与 pip 步骤永不执行，界面无进展。
- **根因**：`p.on('exit')` 回调里成功时只 `ctx.nd(...)` 打日志、**没调 `resolve()`** → Promise 永久挂起 → 外层 `await` 死等。
- **修复**（asr-server.js）：`code === 0` 分支补 `resolve()`。（此函数同时服务 cosyvoice venv/补 modelscope，一并解锁。）
- **防复发**：写 Promise+进程封装时，**exit 0 必须 resolve，非 0 必须 reject**，两者都要有；测试至少覆盖"成功路径返回"。

### 坑 E：清华 PyPI 默认给 CPU 版 torch → N 卡机器 GPU 闲置、朗读极慢
- **症状**：qwen3 朗读近 1 分钟不出声；实测 8 个字 178 秒。`torch.__version__` 是 `2.13.0+cpu`。
- **根因**：uv pip 走清华镜像解析到 **CPU 版 torch**（Windows PyPI 默认无 CUDA 依赖），N 卡从未被使用。
- **修复**（asr-server.js + 前端）：
  - `uvVenvInstaller` 检测 `HAS_NVIDIA && ready && torchIsCpuOnly(name)` → `BIG_DOWNLOAD_CONFIRM:2.5GB` → `uv pip install --index-url ${TORCH_INDEX} --reinstall-package torch --reinstall-package torchaudio torch torchaudio`（默认 `https://download.pytorch.org/whl/cu126`，可用 `OPENSOUND_TORCH_INDEX` 覆盖）；
  - 升级后仍 CPU 版 → **明确报错**（源无匹配 wheel / 驱动门槛 / 未真下载三选一排查，见坑 N）；
  - `/models` 输出 `gpuUpgrade`，前端模型卡出现黄色「升级 GPU 加速」按钮（需重建 exe）。
- **防复发**：任何带 torch 的 venv 安装，**安装/升级后必须校验 torch 是否 CUDA 版**（`torchBuildTag` 检查 `+cu` 后缀）；N 卡机器一律提示 GPU 加速选项。macOS 走 MPS（内建，PyPI 默认即可），Linux 走 nvidia-smi 判定，规则见 §〇·A。

### 坑 N：uv pip 升级已装包必须 --reinstall-package（"Checked N packages in 90ms"秒跳）
- **症状**：点「升级 GPU 加速」→ 日志 `> uv.exe pip install ... torch torchaudio` 后只出现 `Checked 2 packages in 90ms`、`✓ 命令完成`——**一个字节都没下载**，升级后 torch 仍为 CPU 版。
- **根因**：uv/pip 对"已安装的同版本包"默认跳过（认为已满足），不带重装标志 = 秒返回、不真装。
- **修复**（asr-server.js）：CUDA 升级命令加 `--reinstall-package torch --reinstall-package torchaudio`；装后校验 `torchIsCpuOnly` 仍为 true 时给出三选一排查（源无匹配 wheel / 驱动门槛 / 未真下载）。
- **防复发**：**凡是"把已装的包换源/换变体重装"（CPU→CUDA、cu126→cu128），命令必须带 `--reinstall-package <包名>`**；验收看日志有没有实际下载字节数，不能只看"命令完成"。

### 坑 O：uv pip 大文件下载无实时进度 + 官方源太慢 + 镜像"全失败"真因（08-28 晚六~九已修）
- **症状**：① CUDA 升级 2.6GiB 时日志只有 `Downloading torch (2.6GiB)` 一行后干等；② 官方源国内下载数小时（30 秒 +0MB）；③ 配了阿里云/清华镜像却**全部失败**，只显示"切换下一镜像…"不报原因。
- **根因（三层，全部实测复现）**：
  1. `runCmdWithEnv` 只按行转发 uv stdout，uv 进度条不落 NDJSON；
  2. `uv pip --index-url` **只认 PEP 503 simple index**，而**阿里云/清华 pytorch-wheels 是平铺目录**（`/cuXXX/xxx.whl`，**没有** `/cuXXX/torch/` 子目录）——统一按官方结构拼 URL = 国内镜像全 404；
  3. 镜像失败原因被 catch 吞了（只赋值 lastErr 不打日志）→ 用户只见"切换镜像"看不到为什么。
- **修复（asr-server.js，重启服务生效）**：
  1. **不再用 uv 下载大文件**——`probeWheelOnMirror()` 逐个镜像探测目录页（记录 `layout: flat|simple` 区分 URL 结构），正则解析最新 cp311 win_amd64 wheel（**兼容 `&#43;` / `%2B` / `+` 三种编码**，阿里云页面实测用 `&#43;`）→ 收集成功候选（含 HEAD 字节数）→ `downloadOneFile` 直下 wheel（多镜像+断点续传+800ms 真实 `type:'progress'`）→ `uv pip install 本地 wheel`（秒装不联网）。
  2. **探测失败原因全部打日志**（"镜像探测 X 失败：原因"），不再吞。
  3. 驱动门槛：`torchCuDirForDriver`（≥570→cu128 / ≥560→cu126 / ≥550→cu124 / <550 拒绝并提示升级驱动）。
- **防复发（强制）**：① **任何大文件下载必须双做——国内镜像优先 + 真实进度事件**；② **镜像 URL 结构必须先探测目录页再拼**（flat 平铺 vs simple 子目录，两者 URL 完全不同）；③ **wheel 文件名解析必须兼容 `&#43;`（HTML 实体）+ `%2B` + `+` 三种**；④ **任何失败原因打日志，禁止吞**；⑤ 验收标准：日志有 `镜像探测：aliyun ... → v2.11.0（2.5GB）` + 进度条动起来 + 装完校验 `+cu`。
- **镜像清单（已实测验证 2026-08-28）**：阿里云 `https://mirrors.aliyun.com/pytorch-wheels/<cu>/`（平铺，✅ torch/torchaudio v2.11.0+cu128 存在）、官方 `https://download.pytorch.org/whl/<cu>/torch/`（simple 子目录 ✅）、清华 `https://mirrors.tuna.tsinghua.edu.cn/pytorch-wheels/<cu>/`（当前 404，探测会如实跳过）。

### 坑 P：升级 torch 时引擎服务还在运行 → _C.pyd 被锁（拒绝访问 os error 5）
- **症状**：wheel 下载完成、`uv pip install 本地文件` 时报 `error: failed to remove file ...\torch\_C.cp311-win_amd64.pyd: 拒绝访问 (os error 5)`，安装失败退出码 2。
- **根因**：qwen3-tts（8001）/ sensevoice（8002）/ cosyvoice（8003）等引擎进程还活着，加载了旧 torch → site-packages 的 .pyd 被进程锁住，无法替换。
- **修复（App 内闭环，用户零手动操作）**：`uvVenvInstaller` 二次确认后**自动检测并 taskkill 占用 8001/8002/8003 的引擎进程**（这些是 App 拉起的子服务，升级时停掉属正常操作）、等待 1.2s 释放锁 → 复用已下载 wheel 秒装 → 校验 `+cu` → 提示「重启服务」重新拉起引擎。
- **防复发**：升级 torch / 换 venv 依赖前，App 必须自动停掉占用该 venv 的服务进程；禁止把"手动停服务"甩给用户（用户原则：**能在 App 内做的一律 App 内做**）。

### 坑 Q：curl 进度动画刷日志（% Total 表头）
- **症状**：downloadOneFile 下载时日志区出现 `% Total % Received % Xferd ...` curl 进度表头，干扰真实进度（App 进度条其实在工作，被刷屏掩盖）。
- **根因**：curl 的 stderr 进度动画被当 log 行转发。
- **修复**（asr-server.js）：downloadOneFile 的 curl 加 `-sS`（静默进度、保留真实错误）；进度只靠每 800ms 读 .part 发 `type:'progress'`。
- **防复发**：所有 curl 调用一律 `-sS` + 自管进度；禁止把 curl 原生进度转发成日志。

### 坑 R：官方 README 的 `pip install xxx --all-extras` 在 pip/uv 上都不能直接照抄（IndexTTS 实测，2026-08-29）
- **症状**：照抄官方命令 `uv pip install index-tts --all-extras` → uv 报 `error: Requesting extras requires a pylock.toml, pyproject.toml, setup.cfg, or setup.py file` + hint `Use package[extra] syntax instead`；改走 venv 内 `pip install index-tts --all-extras` → pip 报 `no such option: --all-extras`。
- **根因**（两层，全部 App 内实测）：
  1. **uv 的 `--all-extras` 只对"本地项目（有 pyproject/pylock 的目录）"生效**，对远程包一律拒绝，必须用 `package[extra1,extra2]` 语法；
  2. **pip 根本没有 `--all-extras` 这个选项**（报 no such option）——IndexTTS 官方 README 那行命令本身就是文档 bug（常见于镜像站转载/未验证）。
- **修复**：uv 语法 `uv pip install "index-tts[e1,e2]"`，extras 名单从包 wheel 的 METADATA（`Provides-Extra:` 行）动态解析（见坑 S）。
- **防复发（强制，写入 checklist）**：**任何官方 README 的 pip 安装命令，动手前先判断"flag 是否 pip/uv 真正支持"**——`--all-extras` 已知不可用；等价语义 = uv `package[extra]` 语法或 `pip install "package[extra]"`；extras 名单不许猜，只能从 METADATA/官方 pyproject 实测，登记进 §五 checklist 与引擎依赖实测总表（036）。

### 坑 S：解析"包 extras/元数据"偷懒 fetch PyPI JSON API → 国内网络挂死/404（IndexTTS 实测，2026-08-29）
- **症状**：为拿 index-tts 的 extras 名单，先 fetch `pypi.org/pypi/index-tts/json` → **无声挂死**（国内直连黑洞，日志停在"跳过 venv 重建…"无任何输出，用户等半天）；改 fetch 清华 `pypi.tuna.tsinghua.edu.cn/pypi/index-tts/json` → **HTTP 404**（清华镜像只镜像 simple index，不提供 /pypi/<name>/json）。
- **根因**：pypi.org 国内被墙（036 §五 源头表同族：huggingface/github 直连同理）；清华无 JSON API。
- **修复**：**从清华 simple index（`/simple/index-tts/`）正则解析最新 wheel 直链 → downloadOneFile 下载 wheel（小，走真实进度+缓存）→ adm-zip 读 `*.dist-info/METADATA` 的 `Provides-Extra:` 行 → 得真实 extras 名单 → `uv pip install "index-tts[e1,e2]"`**。全程国内源、零猜测、可缓存。
- **防复发（强制）**：**任何"查包元数据/extras/依赖清单"一律走国内可达源（清华 simple + wheel METADATA / ModelScope API / hf-mirror），禁止 fetch pypi.org/官方 JSON API**（被墙挂死且无明显超时——曾直接表现为"安装无声卡住"一整轮）；解析结果必须打日志（extras：xxx,yyy），供实测登记。

### 坑 T：if/else 重构漏闭合，导致"跳过分支静默结束"（IndexTTS 接入自定义 bug，2026-08-29）
- **症状**：点「检测/修复」→ 日志停在 `已存在且 torch 为 CUDA 版 → 跳过 venv 重建` 后再无任何输出（不报错、不 done、不安装）。
- **根因**：给 uvVenvInstaller 加"venv 残留跳过"分支时，if/else 写错位置——「安装引擎依赖」的代码被留在了 else 块内，条件为真（跳过重建）时**整个 else 被跳过**，函数直接结束 → 前端只见两行日志。
- **修复**（asr-server.js ×2 次定位）：`if (!(venvAlready && torchCudaOk))` 只包住"创建 venv + CUDA 直装"，「安装依赖/校验/done」移到 if **外**共用（重建与否都执行）。
- **防复发**：**加"跳过/复用"分支时，把"必须总是执行"的步骤（装依赖/done）放在条件块外**；改控制流后必须 `node --check` + **逐个分支演练（条件真假各跑一遍逻辑）**，不能只看语法过。此坑与坑 D（resolve 漏调）同族：**"看起来完成一半就静默"永远优先查代码流，不是查网络**。

### 坑 F：模型"补齐"没安装器 → 静默 done（"晃一下没反应"Ⅱ）
- **症状**：qwen3 环境就绪后点「补齐」→ 立即 done「环境就绪」，模型文件仍缺，观感=没反应。
- **根因**：qwen3 的 INSTALLERS 只有 `uvVenvInstaller`（只管 venv）；2.3GB 模型文件此前仅靠**重启服务时 qwen3-tts-server.py 顺带拉取**，点补齐无对应安装器 → 立即 done。
- **修复**（asr-server.js）：`qwen3ModelInstaller` 二段式——venv（复用）+ 模型缺失 → 二次确认 → `.venv-qwen3` python 跑 `huggingface_hub.snapshot_download('Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice')`，`HF_HOME=models/hf` 正好是 checks 检查路径，默认 hf-mirror。
- **防复发**：**每个引擎必须有完整的端到端安装器**（venv + 模型），不能让"缺 xx 时靠重启服务顺带"成为唯一路径——用户点击按钮必须能补齐全部缺失项，否则就是静默。

### 坑 G：驱动过旧装 CUDA torch 白下 2.5GB
- **症状**：升级 CUDA torch 后 `cuda.is_available()` 仍 False → 白下载。
- **根因**：新 torch 的 cu126+ wheel 要求驱动 ≥550；545.84（2023-10）只支持到 CUDA 12.3。
- **修复**：升级驱动到最新（如 616.56）；服务端升级后校验仍 CPU 版 → 明确报错提示驱动/源（见坑 E 修复）。
- **防复发**：CUDA 升级路径**必须先给用户讲清驱动门槛**（界面上也能看到日志），装完必须校验，别让用户白下 2.5GB。

### 坑 H：sensevoice-原始 曾经连 INSTALLERS 都没有（点按钮直接 400 "未知模型"）
- 已修：`INSTALLERS['sensevoice-original'] = sensevoiceOriginalInstaller(uvVenvInstaller(...))` 二段式（funasr/torch/torchaudio/numpy/soundfile venv ≈2.5GB + 模型三件套 ≈2.1GB 自动下载，见 055）。⚠️ 完整链路待用户 App 内实测验收。
- **防复发**：新引擎注册 = INSTALLERS + engines/*.json checks/runtime/install 三件套齐，缺一视为未完成。

### 坑 I：cosyvoice venv 旧 lock 漏装 modelscope → 8003 秒退
- 已修：venv 就绪但缺 modelscope → `uv pip install --python <venv-py> modelscope` 补装（034 uv 化）。
- **防复发**：venv 关键依赖检查用 `VENV_KEY_PKG` 多维（torch + modelscope），lock 文件变更必须对照运行时 import 需求。

### 坑 J：空壳 venv 假就绪（只建目录没装依赖）
- 根因：venv 存在 ≠ 依赖就绪；早期检查只 `existsSync(python)`。
- 已修：`venvKeyPkgOk(name, keyPkg)` = venv python 在 **且 site-packages 有 VENV_KEY_PKG 关键包**；`engineReadiness` 据此如实报"缺环境"，不做假就绪。
- **防复发**：venv 就绪判定永远看"关键包"，不看"目录在不在"。

### 坑 K：模型落盘路径与 checks 不一致
- 例：qwen3 checks 是 `models/hf/hub/models--Qwen--...`，snapshot_download 必须 `HF_HOME=models/hf`，hf-mirror 默认；cosyvoice 权重在 `models/cosyvoice/Fun-CosyVoice3-0.5B/`。
- **防复发**：安装器的落盘路径必须与 engines/*.json 的 checks 逐一对应，写完自检 `checkEntry` 全绿。

### 坑 L：Windows venv 路径形态（bin/python3 vs Scripts/python.exe）
- 031 跨平台：Win = `Scripts/python.exe`，Unix = `bin/python3`；所有 venv 查找用 `venvDirOf/venvPyOf` 封装，禁止手写路径。
- 已处理：start-all.js `venvPy()`、asr-server.js `venvPyOf()`、Rust 侧均按此。

### 坑 M：前端/Rust 改动必须重建 exe（分层生效）
- **症状**（反复出现）：改了前端，App 里看不到变化。
- **根因**：Tauri 生产模式从 exe 内嵌资源加载 UI；`ui/dist` 与 exe 未重建。
- **规则**：服务端 = 重启服务即生效；前端/Rust = 关掉 opensound.exe → `npm run build` → 重开。构建前确认 exe 时间戳 ≥ 源码时间戳。

### 坑 U：glob 型 checks 从代码目录解析，与文件/目录型不一致 → whisper 永远「无匹配」（2026-08-31 实锤）
- **症状**：Whisper base 卡片永远「缺文件 / hf/onnx-community/whisper-* 无匹配」，即使 transformers.js 已把模型下到 `models/hf/onnx-community/whisper-base/`；点「补齐」只有提示没动作。
- **根因**：`checkEntry` 的 file/dir 型走 `resolveData()`（`models/` 前缀 → 数据目录），而 **glob 型走 `globExists()` = `path.join(__dirname, pattern)`（代码目录）**。两端落盘位置不一致：transformers.js `env.cacheDir = <数据目录>/models/hf`，glob 却去 `<代码目录>/models/hf` 找 → 永远 0 匹配（056 方案根因）。
- **已修（S9 glob 修复 + S10 引擎换 sherpa）**：① glob 型改用 `resolveData()` 解析（一行级修复）；② whisper 引擎整体换 sherpa-onnx（fp32 官方导出，与 SenseVoice 共用原生运行时，见坑 X），transformers.js/onnxruntime-node 不再使用。
- **防复发**：`checkEntry` 所有类型必须统一 `resolveData`；写新 glob checks 时先确认落盘目录与 `env.cacheDir`/`HF_HOME` 一致（坑 K 同族）。

### 坑 X：onnxruntime-node 与 sherpa-onnx 同进程 DLL 冲突 → 「The operating system cannot run %1」（2026-08-31 实锤）
- **症状**：先使用 SenseVoice（sherpa-onnx）后，任何 whisper 调用报 `Error: The operating system cannot run %1. \\?\...onnxruntime-node\bin\napi-v6\win32\x64\onnxruntime_binding.node`；但**单独** `require('onnxruntime-node')` 完全正常。
- **根因（证据链，非猜测）**：① 运行中 asr-server 进程模块列表：`sherpa-onnx-win-x64\onnxruntime.dll`（**1.27.0**）已加载；② onnxruntime-node 1.24.3 自带自己的 `onnxruntime.dll`（1.24.x）——**同进程两个不同版本同名 DLL**；③ 实验：全新进程单独加载 onnxruntime-node OK；先 `require('sherpa-onnx')`（不建识别器，DLL 惰性未进进程）再加载也 OK；**创建 sherpa 识别器（强制加载 1.27.0 DLL）后再加载 onnxruntime-node → 进程硬崩**；④ 官方同类案例：[agentic-flow PR #155](https://github.com/ruvnet/agentic-flow/pull/155)（Windows 上 "OS cannot run %1" 加载 onnxruntime_binding.node，修复=延迟/隔离加载）。
- **处理（S10，方案 C）**：Whisper 引擎整体换 sherpa-onnx（sherpa 官方导出 whisper fp32 模型，与 SenseVoice 共用同一套原生运行时）→ onnxruntime-node 不再被加载 → 冲突从根上消失；**零新进程**（契合节能模式最小进程集，030 资源模式体系零改动）。
- **防复发**：一个 node 进程内不混装多个捆绑**不同版本同名原生 DLL** 的 npm 包；新引擎优先复用已加载的原生运行时（sherpa）或独立进程隔离（funasr 8002 范式）；接新原生依赖前先查其捆绑 DLL 与现有包是否同名同版本。

### 坑 V：funasr 本地加载只认固定文件名 bpe.model → SenseVoice 原始版 8002 启动即崩（2026-08-31 实锤）
- **症状**：`.venv-funasr` + 模型三件套全就绪，8002 仍起不来；`/health` 无响应，卡片卡「启动中」；模型页日志看不到（App 旧 exe 输出被丢弃）。
- **根因**：ModelScope SenseVoiceSmall 仓库 bpe 文件名是 `chn_jpn_yue_eng_ko_spectok.bpe.model`，且 `config.yaml` 里 `tokenizer_conf.bpemodel: null`；funasr 本地加载（`download_model_from_hub.py`）只认**字面量 `bpe.model`** 来补 `bpemodel` → 补不上 → `SentencepiecesTokenizer` 执行 `sp.load("None")` → `RuntimeError: NOT_FOUND: "None"`。
- **已修**：`sensevoice-server.py` 加载主模型前自愈——若目录缺 `bpe.model` 且有 `*.bpe.model`，复制一个别名。实测三件套加载 + 真实录音转写出字通过。
- **防复发**：funasr 引擎接新模型时，先核对 config.yaml 的 `tokenizer_conf.bpemodel` 与仓库实际文件名；本地目录加载必须满足 funasr 的固定文件名约定（`bpe.model` / `tokens.txt|json` / `am.mvn` / `jieba_usr_dict`）。

### 坑 W：mac venv site-packages 路径（`Lib/site-packages` 是 Windows 布局）→ mac 上 python 引擎永远误报「缺环境」（2026-08-31 修复）
- **症状**：mac 上 qwen3 / sensevoice-original / cosyvoice venv 明明装好了，模型页仍显示「缺环境」，点「检测/修复」反复装。
- **根因**：`venvKeyPkgOk` / `venvPkgPresent` / `torchBuildTag` 硬编码 `Lib/site-packages`（Windows venv 布局）；mac/Linux venv 是 `<venv>/lib/python3.x/site-packages` → 永远找不到关键包目录。
- **已修**：新增 `venvSpOf(name)` 跨平台解析（Win=`Lib/site-packages`；unix 扫描 `lib/python3*/site-packages`，兜底 python3.11），三处调用统一替换（056 实施顺带）。
- **防复发**：venv 内路径一律经 `venvSpOf`/`venvPyOf`/`venvDirOf` 封装，禁止手写 `Lib`/`Scripts`/`bin`（坑 L 同族，加 site-packages 维度）。

### 坑 Y：sherpa-onnx-node 识别器 `language` 是创建期配置，无可靠的运行时改语言接口（2026-08-31 查证，S11）
- **症状**：想给 Whisper 指定识别语言（如法语），但 `OfflineRecognizer` 实例没有"改语言"方法；`setConfig()` 虽存在（`offlineRecognizerSetConfig`）但 C++ 层语义**未文档化**——不确定替换 `whisper.language` 是否真重建模型/生效，不可依赖。
- **根因**：sherpa-onnx-node 1.13.4 类型定义 `OfflineWhisperModelConfig.language` 在 `createOfflineRecognizer` 时烘焙进模型配置；Whisper 解码起始 SOT 语言 token 在初始化阶段决定。
- **已修（S11）**：按语言缓存识别器 `Map<lang, rec>`（语言烘焙进创建配置，保证正确性）+ **LRU 上限 3**（防多语言常驻内存膨胀，每个识别器约 300–400MB；超限淘汰最久未用，再次使用重载 1–2s）。优先级：`?lang=` > `ASR_WHISPER_LANG` > `''`（自动检测）；99 码白名单校验（与模型加载日志 `all_language_codes` 逐项一致），非法码（如 `auto`）回退自动检测**不崩**。实测：同一段中文音频，自动检测出中文、`lang=en` 出英文——语言参数确实生效。
- **防复发**：新增"按模型配置变体缓存"类功能时，先查证底层绑定是否支持运行时改配置（未文档化的 `setConfig` 不可依赖）；多实例缓存必须带上限策略（LRU），并登记每个实例的内存成本。

---

## 五、新引擎接入 checklist（S5 起硬性要求）

1. `engines/<id>.json`：checks（文件/目录+字节数）、runtime、install.kind/mirrors、profile 齐。
2. `INSTALLERS[<id>]`：完整安装器——**venv（若 python 引擎）+ 模型文件**都要能一键补齐（坑 F 教训）。
3. 大流量（>1GB）必须 `BIG_DOWNLOAD_CONFIRM`（坑 A：确认前端能接住 error 行 → 弹确认行）。
4. 装完 `checkEntry` 自检全绿；venv 用 `venvKeyPkgOk` 防空壳（坑 J）。
5. N 卡 + CPU torch → `gpuUpgrade` 提示（坑 E/G）。
6. 下载统一 `downloadOneFile`（多镜像/断点/取消/字节校验）或 snapshot_download（HF 快照）。
7. 每个按钮点击都必须有可见反应（确认行/进度/明确错误），禁止静默 done（坑 A/B/F）。
8. 改前端/Rust → 重建 exe 再验收（坑 M）。
9. **官方 README 的 pip 命令照抄前先验证 flag**：`--all-extras` 在 pip/uv 上均不可用（坑 R）→ 用 `uv pip install "pkg[extra1,extra2]"` 语法；extras 名单必须从 wheel METADATA（`Provides-Extra:`）实测解析（坑 S），**禁止猜、禁止 fetch 被墙的 pypi.org JSON API**（清华也无 /pypi JSON，404）。
10. **加"跳过/复用"分支时，必须总是执行的步骤（装依赖/done）放条件块外**；改控制流后逐分支演练真假路径，防"跳过分支静默结束"（坑 T，与坑 D 同族）。

---

## 六、铁律提醒（安装相关）

1. 一切安装由用户点击触发；AI 只改代码/给命令，**绝不代跑下载安装**。
2. 不执行 git 写操作（命令列给用户）；只读 git 自由。
3. 不杀进程（除自己启动的明确 PID）。
4. 分层不混淆：node/py 基础=全局按钮；venv+依赖=卡片检测/修复；模型=卡片补齐；CUDA torch=卡片升级 GPU。
5. 前端/Rust 必须重建 exe；服务端重启服务即生效。
6. 每完成一步停下汇报，用户确认后再继续；用户说停就停。

---

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-28 | 初版：四层安装模型 + 全部实测坑（A–M）+ 新引擎 checklist。来源：034/035 + 08-28 晚四连修（error 行抛错 / venv --clear / runCmdWithEnv resolve / CUDA torch 升级） |
| 2026-08-29 | IndexTTS 接入实测新增坑 R/S/T + checklist 9/10：① 坑 R（官方 README `--all-extras` pip/uv 均不可用 → uv `package[extra]` 语法）；② 坑 S（查元数据禁 fetch pypi.org JSON API——被墙无声挂死；清华也无 /pypi JSON 返回 404 → 走清华 simple + wheel METADATA `Provides-Extra:` 解析）；③ 坑 T（if/else 跳过分支静默结束——必须总是执行的步骤放条件块外，改控制流逐分支演练）；④ checklist 新增 9/10 条 |
| 2026-08-31 | SenseVoice 原始版跑通新增坑 U/V：① 坑 U（glob 型 checks 用 `path.join(__dirname,…)` 走代码目录，与 file/dir 型 `resolveData` 不一致 → whisper 永远「无匹配」，根因见 056）；② 坑 V（funasr 本地加载只认字面量 `bpe.model`，ModelScope 仓库文件名不匹配 + `config.yaml bpemodel: null` → `sp.load("None")` 8002 秒崩，sensevoice-server.py 自愈别名修复）；③ 055 新增 §五「升级 GPU 方案」；④ 发布前暂隐藏「升级 GPU 加速」按钮（ModelsPanel，恢复见 055 §五） |
| 2026-08-31 | **056 实施（S9）**：① 坑 U 修复（glob 型改 `resolveData`）；② Whisper 真安装器 `download-whisper.js`（transformers.js 预下载 + 静音冒烟推理强制拉权，实测完整下载通过）；③ 新增坑 W（mac venv `Lib/site-packages` 是 Win 布局 → `venvSpOf()` 跨平台扫描修复，否则 mac 上 python 引擎永远误报「缺环境」）；④ SERVER_VERSION/EXPECTED_VERSION → 2.8.0 |
| 2026-08-31 | **S10：Whisper 引擎换 sherpa-onnx（方案 C，SERVER_VERSION→2.9.0）**：① 新增坑 X（onnxruntime-node × sherpa-onnx 同进程同名 onnxruntime.dll 不同版本冲突 → "cannot run %1"，实锤证据链：进程模块列表 1.27.0 + 建识别器后加载即崩 + 官方同类案例 PR #155）；② whisper 改 sherpa 官方导出 fp32 模型（语言自动检测 `language:''` 实测），onnxruntime-node 不再加载；③ `download-whisper.js` 废弃删除；④ `manifestUrlMultiInstaller` 跳过检查改 `resolveData`（坑 U 同族）；⑤ 实测出字「現在開始做第一次。試。」 |
| 2026-08-31 | **S11：Whisper 指定语言配置（SERVER_VERSION→2.10.0）**：① 新增坑 Y（sherpa-onnx-node 识别器 language 是创建期配置、setConfig 语义未文档化 → 按语言 Map 缓存 + LRU 上限 3）；② `/transcribe?lang=` > `ASR_WHISPER_LANG` > `''`（自动检测）优先级；99 码白名单（与模型加载日志 all_language_codes 逐项一致），非法码（auto 等）回退自动检测不崩；③ 前端识别面板加「Whisper 语言」下拉 20 项（仅引擎选 Whisper 时显示，**重建 exe 生效**）；④ temp server 实测：自动检测中文回归✓、zh 指定✓、EN 大写规范化后同一中文音频出英文✓（语言参数真生效）、auto/zzz 非法回退不崩✓、fr+中文音频不崩（乱码为预期，坑预案 4）；fr 真人音频实测待用户提供 |