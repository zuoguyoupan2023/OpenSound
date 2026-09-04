# 040 · IndexTTS 单独安装（脱离 App，从头按官方 README，一条命令一条命令来）

> 目的：App 内安装器已连续踩坑（039 全程），用户拍板**脱离 App、在 E 盘按官方文档单独装好**。
> 原则：**一切以官方 README（reference/indextts/README.md）为准**，本文件只做"官方命令 → 本机对应实现"的逐条对照；
> 不发明、不改官方约束、不预装、不猜版本。
> 现状（2026-08-29 实测定稿）：① vendor/index-tts 源码已齐（jsdelivr 67 文件 = 官方仓库裁剪，含 pyproject.toml==官方原样，无 uv.lock）② 受管 uv + CPython 3.11 已在数据目录 E:\Downloads\opensound-download\runtime ③ .venv-indextts 已建（内部 torch 为 App 早期自装 2.11.0+cu128，**按官方应重来**）。

---

## 〇、官方 README 的安装步骤（原文摘录，一字不改）

> ### 1. Prerequisites
> `git clone https://github.com/index-tts/index-tts.git && cd index-tts`
> ### 2. Install Dependencies（用 uv）
> `pip install -U uv`
> `uv sync --all-extras`
> 慢则换镜像：`uv sync --all-extras --default-index "https://mirrors.aliyun.com/pypi/simple"`
> `uv sync --all-extras --default-index "https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple"`
> ⚠️ IMPORTANT（Windows）：DeepSpeed 难装，可去掉 `--all-extras` 手动加其它 feature flag。
> （extras：`--extra webui` / `--extra deepspeed` / `--extra accel` / `--extra torch_compile`）
> ### 3. Download Models
> `uv tool install "huggingface-hub"` → `hf download IndexTeam/IndexTTS-2.5 --local-dir=checkpoints`
> 或 `uv tool install "modelscope"` → `modelscope download --model IndexTeam/IndexTTS-2.5 --local_dir checkpoints`
> （小模型首次运行自动下载；HF 慢设 `export HF_ENDPOINT="https://hf-mirror.com"`）
> ### 4. Check GPU Acceleration
> `uv run tools/gpu_check.py`

---

## 一、官方步骤 → 本机对应实现（逐条）

| 官方步骤 | 官方命令 | 本机对应（E 盘，脱离 App） | 性质 |
|---|---|---|---|
| 1. 源码 | `git clone ... && cd index-tts` | 已就位：`E:\Github\opensound\asr-server\vendor\index-tts`（jsdelivr 拉取 = 官方仓库裁剪；pyproject.toml 已还原官方原样） | ✅ 已完成 |
| 2a. 装 uv | `pip install -U uv` | 已有：`E:\Downloads\opensound-download\runtime\uv\uv.exe` | ✅ 已完成 |
| 2b. 建环境 | `uv sync --all-extras`（在仓库目录内） | 受管 CPython 3.11 已有。**官方语义**：uv 在仓库目录建 `.venv` + 按 pyproject（含 `[tool.uv.sources]`：torch → `download.pytorch.org/whl/cu128`，即 CUDA 版）解析全部依赖。**本机对应**：不重复建系统 venv，直接 `uv pip install --python <受管py> -e vendor/index-tts`（uv pip 同样会读 pyproject 的 tool.uv.sources → torch 从官方 cu128 源装 CUDA 版；`--all-extras` 在 Windows 按官方建议跳过 deepspeed） | 🚧 待执行（用户跑） |
| 3. 模型 | `modelscope download --model IndexTeam/IndexTTS-2.5 --local_dir checkpoints` | 数据目录 `E:\Downloads\opensound-download\models\indextts\checkpoints`（ModelScope 优先，038 已定；或 hf-mirror） | 🚧 待执行（用户跑） |
| 4. GPU 检查 | `uv run tools/gpu_check.py` | `.venv-indextts\Scripts\python.exe tools/gpu_check.py` | 🚧 装完验证 |

**关键事实（为什么之前 App 里失败）**：官方 pyproject 锁定 `torch==2.8.*` 且 `[tool.uv.sources]` 强制 torch 从 **download.pytorch.org/whl/cu128**（CUDA 版）下载——**该官方源国内 connect 超时**（坑 O，035 已记录"官方源 30 秒 +0MB"；039 实测 connect 超时后 uv 静默重试 20 分钟）。**官方方案本来就要求能访问官方源**（或提前下载好 weight 后离线）。所以：
- **有外网/代理 → 直接官方源，零改动，最干净**；
- 镜像命令（README 给出的阿里云/清华）只换 PyPI 的 python 包源，**torch 仍走 tool.uv.sources 的官方 cu128**（uv 不受 --default-index 影响 sources 指定）。

---

## 二、执行命令（用户在自己终端跑；全程不再碰 App 安装器）

> 以下在 **PowerShell** 执行。`<uv>` = `E:\Downloads\opensound-download\runtime\uv\uv.exe`；`<py>` = `E:\Downloads\opensound-download\venvs\.venv-indextts\Scripts\python.exe`；`<repo>` = `E:\Github\opensound\asr-server\vendor\index-tts`。

### 步骤 0：清掉 App 早先自装的 dirty 状态（按官方重来）
```powershell
# 官方语义：uv sync 会新建 .venv，且 torch==2.8.* 必须从官方源装——
# App 早期自装的 2.11.0+cu128 不符合，清掉避免残留干扰 uv 解析
Remove-Item -Recurse -Force "E:\Downloads\opensound-download\venvs\.venv-indextts"
```

### 步骤 1：官方依赖安装（PowerShell，**先开代理/外网**，逐行执行）
> 用受管 CPython 3.11（已确认存在：`E:\Downloads\opensound-download\runtime\python\cpython-3.11-windows-x86_64-none`）
> 建 venv（等价官方 `uv sync` 的"创建项目环境"），再 `uv pip install -e`（等价官方主依赖解析，
> uv 会自动读 pyproject 的 `[tool.uv.sources]` → torch 从官方 cu128 源装 CUDA 版）。

```powershell
$uv = "E:\Downloads\opensound-download\runtime\uv\uv.exe"
$pyBase = "E:\Downloads\opensound-download\runtime\python\cpython-3.11-windows-x86_64-none"
$repo = "E:\Github\opensound\asr-server\vendor\index-tts"
$venvPy = "E:\Downloads\opensound-download\venvs\.venv-indextts\Scripts\python.exe"

# ① 建 venv（--clear 清旧；受管 CPython 3.11）
& $uv venv --python "$pyBase\python.exe" --clear "E:\Downloads\opensound-download\venvs\.venv-indextts"

# ② 官方安装主依赖（等价 uv sync；Windows 官方建议跳过 deepspeed → 不加 --all-extras）
& $uv pip install --python $venvPy -e $repo
```

### 步骤 2：模型（ModelScope 国内可达，优先）
```powershell
$venvPy = "E:\Downloads\opensound-download\venvs\.venv-indextts\Scripts\python.exe"
& $venvPy -m pip install modelscope
& $venvPy -m modelscope download --model IndexTeam/IndexTTS-2.5 --local_dir "E:\Downloads\opensound-download\models\indextts\checkpoints"
```

### 步骤 3：GPU 验证
```powershell
$venvPy = "E:\Downloads\opensound-download\venvs\.venv-indextts\Scripts\python.exe"
& $venvPy -c "import torch; print(torch.__version__, torch.cuda.is_available())"
# 期望：2.8.0+cu128 True（无代理时这一步就是之前卡死的地方；有外网/代理则秒过）
```

---

## 三、排错速查（按官方语义，不再自创）

| 症状 | 官方解释/处理 |
|---|---|
| torch 从 download.pytorch.org 卡住/超时 | 官方源国内不可达（坑 O）→ **开代理/外网重试**；torch 必须按 tool.uv.sources 走官方 cu128 源 |
| `Failed to fetch` / connect timeout 4 次 | 同上，网络问题，不是代码问题；uv 自带重试 4 次，失败即报错（App 版因无超时曾静默 20 分钟，已修） |
| DeepSpeed 相关报错 | Windows 官方建议跳过：不加 `--all-extras`，只装主依赖（我们就是这么做的） |
| `No module named 'wetext'` 类 | 官方 Windows 依赖就是 `wetext>=0.0.9`（pyproject 已声明），uv 会装；无需 WeTextProcessing/pynini |
| 模型下载慢 | README：`export HF_ENDPOINT="https://hf-mirror.com"`，或 ModelScope（国内快） |

---

## 四、验收（可见即验收）

1. `torch.__version__ == 2.8.0+cu128` 且 `torch.cuda.is_available() == True`
2. `import indextts.infer_v2_5; IndexTTS2` 可导入（venv python）
3. 模型 checkpoints 目录有 config.yaml + 权重（ModelScope 实测字节）
4. `indextts-tts-server.py --port 8004` 能起、/speak 出声

## 五、执行复盘（2026-08-30 实机跑完后的修正与坑登记）

> 按 040 全文执行完毕（E:\Github\indextts2.5 独立部署，验收四条全过）。以下为**原规划与实况的出入**，新会话直接按修正后口径执行，别照旧文。

### 5.1 原规划里"有问题/被修正"的点

| # | 040 原规划 | 实况 / 修正 |
|---|---|---|
| 1 | §一：vendor 源码"已齐"（jsdelivr 67/69 文件） | ❌ **假**：裁剪版实测缺 `tools/gpu_check.py`、`indextts/infer_v2_5.py`、`index_tts` 包（040 验收第 2 条在这份源码上不可能过）。**正解：官方 tar 全量（71 文件，1.72MB）** |
| 2 | §二：用受管 uv + Downloads venv（步骤 0 删 `.venv-indextts`） | ❌ 用户否决 + 实测 App 的 uv 缓存 `C:\Users\…\AppData\Local\uv\cache` **ACL 损坏（sdists-v9\.git 拒绝访问）** → **全新独立 uv（pip install uv）+ 独立缓存（UV_CACHE_DIR 重定向部署目录）** |
| 3 | §二：`uv pip install -e vendor/index-tts` 等价 uv sync | ⚠️ 语义上 uv pip 也读 tool.uv.sources，但**真正的官方语义是 `uv sync`**（仓库自带官方 uv.lock）。最终：官方全量源码 + `uv sync --frozen` 一次性装齐 |
| 4 | §一：镜像只换 PyPI、torch 仍走官方源；"外网/代理 → 官方源零改动最干净" | ⚠️ 本机直连官方源实测 **90-330KB/s 且抖动**（torch 3.2GB = 2-3 小时级）。**修正：torch 也走 aliyun cu128 平铺镜像（同一 whl，2-6MB/s，实测 20 分钟级）**——"官方源优先"仅在快网成立 |
| 5 | §二 步骤 0：只清 .venv-indextts | ⚠️ 不够：App 的 uv 缓存/权限链都必须绕开（=废弃整个 App 管理环境，见 2） |
| 6 | 验收第 4 条：`indextts-tts-server.py --port 8004` | ⚠️ 该脚本 `sys.path.insert(0, vendor)` 指向 App 裁剪 vendor（缺 infer_v2_5）→ **独立部署验收改用官方 API 直接合成出声**（等价产出 WAV）；App 服务集成 = 041 |

### 5.2 执行中踩的坑（七连坑，细节在 035 §7.1）

① 裁剪 vendor 缺文件（040 自己的错）
② App 的 uv 缓存 ACL 损坏 → 弃用
③ OpenVPN 隧道 **80KB 必断流**（IncompleteRead 铁证）+ DNS 挂起 → 切直连
④ 直连也抖：GitHub 94KB/s / pypi 90KB/s 且断流；**aliyun 11MB/s、modelscope 8.8MB/s、aliyun pytorch-wheels 2-6MB/s**（同源忽快忽慢=网络波动）
⑤ **uv.lock 不可重新生成**（非当前平台必撞 accel/flash-attn 冲突）→ 官方锁只换主机 + `--frozen`
⑥ PowerShell `Set-Content -Encoding utf8` 写文件带 **BOM** → tomllib 崩 → 一律 utf8NoBOM
⑦ 官方 uv.lock 里 torch 注册源是 **download-r2.pytorch.org 变体**，换 download.pytorch.org 时漏换 → verbose 日志揪出 → 全量替换+0 残留校验

另记（非 040 范围但影响执行）：numba 需可写缓存（沙箱报 "no locator" → `NUMBA_CACHE_DIR`）；模型总量 **10.4GB**（整仓 5.23GB + 运行时自动补辅助四件套）；s2mel 基座 RTF≈108（提速=accel/bf16，见 041）。

### 5.3 对 fishaudio 的预防（防同坑 → 042 已落实）

| 040 的坑 | fishaudio 预防（042 对应项） |
|---|---|
| 裁剪源码缺文件 | 源码/安装口径**只用官方仓库 + jsdelivr 全量文件**，禁"裁剪"；README 全文先拉再定安装命令（042 §三.3） |
| App 污染环境 | 全新独立 uv/venv/缓存，绝不复用 App 管理环境（042 同 040 修正 2） |
| 隧道/网络抖动 | 开工先做"1MB 完整下载门禁"；大文件先测速再定源；官方源仅兜底（042 §一 源表已实测） |
| uv lock 重锁撞冲突 | **能锁就锁官方，只换主机、禁 re-resolve**（fish-speech 若有 lock/requirements 同此纪律） |
| BOM / 源变体漏换 | 写文件一律 utf8NoBOM；换源后 grep 残留=0 才放行 |
| 模型运行时才拉辅助 | 整仓动态清单 + 辅助件**预下载**（036 坑 F 反模式禁止） |
| 防空壳 | venv 关键包 + import 探针 双重判定 |
| 显存不够硬上 | s2-pro 需 ≥24GB（本机 12GB）→ 不硬装，本地只选 fish-speech-1.5（042 §二） |

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-29 | 初版：脱离 App 单独装 IndexTTS——官方 README 逐条对照 + 本机执行命令 + 排错速查 + 验收标准；vendor pyproject 已还原官方原样 |
| 2026-08-30 | §五 执行复盘：6 条原规划修正（vendor 假齐/弃 App 环境/uv sync 语义/torch 走镜像/验收用官方 API）+ 七连坑登记（035 §7.1）+ fish 预防映射（042） |