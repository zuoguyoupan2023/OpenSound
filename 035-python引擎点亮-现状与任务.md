# 035 · Python 引擎点亮 · 现状实录与后续任务（新会话接手必读）

> 目的：接续 034 阶段3（uv 自举解锁 python 系引擎：Qwen3-TTS / SenseVoice 原始版 / CosyVoice 克隆），
> 把「模型页检测/修复按钮真正点亮 python 引擎」这件事做完。
> 本文全部为**实测事实**（2026-08-28 Win 本机），「已修」≠「已生效」（前端改动需重建 exe 才生效，必须区分）。
> 关联：034（路线图）、033（Win 坑）、032（自举设计）、000（交付铁律：安装下载必须用户点击）。

---

## 一、当前真实状态（已实测，勿重查，除非文内标注「待验证」）

### 1. 服务本体：**一直在跑，正常**
- `netstat -ano -p tcp | findstr ":9528"` → `127.0.0.1:9528 LISTENING`（PID 动态，App 拉起）
- App 侧边栏显示「服务运行中」**是真的**（此前误报"服务没起来"是我沙箱探测问题，与代码无关）
- `%LOCALAPPDATA%\world.opensound.local\logs\asr-server.log` 实测（12:58 那次启动）：
  ```
  [12:58:20] 服务已启动 http://127.0.0.1:9528 ✓
  [12:58:22] Kokoro TTS 就绪（53 音色）✓
  × sensevoice-original 崩：No module named 'numpy'     ← .venv-funasr 空壳（依赖没装）
  × qwen3-tts 崩：          No module named 'torch'     ← .venv-qwen3 空壳（依赖没装）
  × cosyvoice 崩：          No module named 'modelscope' ← .venv-cosyvoice 缺 modelscope（旧 lock 漏装）
  ```
- **结论**：9528 + Kokoro 正常；差的只是三个 python 引擎的 **venv 依赖**，不是服务。

### 2. 环境（已就绪）
- Node v24.19.0（系统 PATH）+ asr-server/node_modules 已装（sherpa-onnx-node 等 4 关键包在）
- 受管 python 基础已装：`E:\Downloads\opensound-download\runtime\uv\uv.exe` + `runtime\python\cpython-3.11*` ✓
- 数据目录 `E:\Downloads\opensound-download`；config.json 在 `%APPDATA%\world.opensound.local\config.json`（server_path / data_dir 正确）
- 引擎 venv 现状（数据目录 venvs/）：
  - `.venv-qwen3`：**空壳**（site-packages 只有 _virtualenv；无 torch/qwen_tts）
  - `.venv-funasr`：**空壳**（无 numpy/funasr）
  - `.venv-cosyvoice`：有 torch+numpy（214 项）但**无 modelscope**

### 3. UI 症状（用户实测，多次复现）
- 模型页 qwen3 / sensevoice-原始 卡片显示「缺文件+缺环境 / 缺环境」→ 按钮 **「检测/修复」（或「补齐」）**
- **点按钮 → 按钮晃一下（短暂 loading）→ 立即恢复，无确认框、无进度、无日志显示** ← 「晃一下没反应」是核心 bug 现象

---

## 二、「晃一下没反应」的已定位根因与修复状态

### 根因链（服务端已 100% 验证对，前端关键修复已写但**是否进 exe 待验证**）

1. **服务端** `asr-server.js` 的 `uvVenvInstaller`（已实现并实测）：
   - 点「检测/修复」→ `/install-model?engine=qwen3` → 检测 `.venv-qwen3` 空壳 → 抛 `BIG_DOWNLOAD_CONFIRM:2.5GB:.venv-qwen3`（NDJSON error 行）
   - 无头实测（9530 端口）确认：不带 confirm 时只返回确认标记，**不装任何东西** ✓
2. **前端** `ModelsPanel.tsx` 原逻辑：catch 到 `BIG_DOWNLOAD_CONFIRM` → `setBigConfirm(...)` 准备弹确认行，
   **但确认行渲染在 `install-log` 内部，而 `install-log` 只在 `progress.length > 0` 时渲染；BIG_DOWNLOAD 分支不推 progress → 整块不渲染 → 用户只见按钮晃一下**。
3. **已修复（本轮已写，tsc 通过）**：确认行已移出 `install-log` **独立无条件渲染**；BIG_DOWNLOAD 分支同时推一条日志。
   ⚠️ **待验证**：用户最后一次 `npm run build` 的 exe（12:58:15）**是否包含**此修复（ModelsPanel.tsx 修改时间 12:56:39 早于 exe，疑似已含）——
   新会话第一步：确认 `ui/dist` 与 exe 是否最新，必要时重建。

### 必须区分的两件事
- **服务端改动**（asr-server.js + engines/*.json）：**重启服务即生效**，无需重建 exe。
- **前端/Rust 改动**（ui/*、src-tauri/src/lib.rs）：**必须 `npm run build` 重建 exe 才生效**（构建前关掉 opensound.exe，033 §10）。
- 用户多次"改了没生效"的根因极可能就是：**前端改了但 exe 没重建 / 重建了但还有一环没验证**。

---

## 三、本次会话已完成的改动清单（全部已落盘，按层归类）

### A. 服务端 asr-server（重启服务生效）
| 文件 | 改动 | 验证 |
|---|---|---|
| `asr-server/asr-server.js` | ① 新增 `runCmdWithEnv`（带 env 子进程+NDJSON 行进度）② 新增 `uvVenvInstaller` 工厂（引擎 venv：检测→大流量二次确认→uv venv+uv pip，清华镜像）③ **qwen3 / sensevoice-original 从空提示变为真安装器**（原 sensevoice 连 INSTALLERS 条目都没有→点按钮直接 400"未知模型"）④ cosyvoice venv 改用 uv + **补装 modelscope**（旧 lock 漏装→8003 秒退）⑤ `engineReadiness` 空壳判定：venv 无关键依赖包=缺环境（不做假就绪）⑥ `VENV_KEY_PKG` 映射（qwen3→qwen_tts / funasr / torch） | `node --check` 过；无头 /models + /install-model 实测符合预期 |
| `engines/qwen3.json` / `sensevoice-original.json` | install 元数据 hint→env（说明两步：装引擎环境→模型自动拉取） | JSON 合法 |
| `engines/sensevoice-original.json` | fsmn-vad minFiles 5→4（与下载脚本对齐，防空转） | JSON 合法 |

### B. Rust src-tauri（需重建 exe）
| 改动 | 内容 |
|---|---|
| `install_runtime` 拆分 | **node 一个按钮**：只装 node + npm deps + 起服务（不再装 python） |
| 新增 `install_python` | **py 一个按钮**：只装 uv + CPython 3.11（~100MB，可选装，不含 torch/引擎 venv） |
| `check_runtime` | python_ready = uv + CPython 基础；qwen3_venv/funasr_venv/cosy_venv 单列（引擎归模型页） |
| `ensure_python_base` | 基础层安装实现（uv 多镜像 + uv python install 3.11 + UV_INDEX_URL 清华） |

### C. 前端 ui（需重建 exe）
| 改动 | 内容 |
|---|---|
| `App.tsx` 引导条 | **node / py 各自独立按钮**（不再"一个按钮装两个"；py 可选，不在全局引导条强制） |
| `SettingsPanel.tsx` | 「安装 Node 与依赖」/「安装 Python 基础」两个按钮 + venv 状态明细 |
| `ModelsPanel.tsx` | ① 大流量确认行独立渲染（**晃一下 bug 的修复**）② 缺环境时按钮显示「检测/修复」③ BIG_DOWNLOAD 分支推日志 |
| `api.ts` | `installPythonBase()` + RuntimeStatus 新字段（uv_ready/py311_ready/python_ready/venv 三态） |

### D. 脚本
- `asr-server/bootstrap-python.ps1`（UTF-8 BOM）：手动路径的 uv 自举（-Check 只看不装；默认清华镜像；可被 UV_INDEX_URL 覆盖）——**与 App 内按钮功能等价，不是必须**

---

## 四、任务目标（新会话验收标准，用户一句话）

> **在模型管理页，用户点 qwen3 / sensevoice-原始 / cosyvoice 卡片的「检测/修复」（或补齐）→ 弹出大流量确认行 → 确认 → 进度可见地装好该引擎 venv（含 torch 等）→ 重启服务 → 对应引擎徽标变绿、真正可用。全程用户点击触发，App 不自动装。**

### 验收清单
- [ ] 点「检测/修复」**必有可见反应**（确认行或错误日志，绝不是"晃一下恢复"）
- [ ] 确认后下载有进度条、可取消、失败可重试（NDJSON 已支持）
- [ ] qwen3：venv 装好 → 重启服务 → 模型自动拉取（2.3GB，HF 镜像）→ 朗读可选 Qwen3
- [ ] sensevoice-原始：venv 装好 → 重启服务 → 8002 活 → 识别原始版可用
- [ ] cosyvoice：补齐 4.4GB 模型 + venv（补 modelscope）→ 重启 → 克隆可用
- [ ] 全局两个按钮（node / py）各自独立、py 可选
- [ ] 不装 py 的用户：其余引擎（sensevoice/kokoro/llm）完全不受影响

---

## 五、新会话要做的事（按序，每步验证后停下汇报）

### 第 0 步：确认前端产物是否含『晃一下』修复（**先做这个，可能直接解决用户痛点**）
- 查 `src-tauri/target/release/opensound.exe` 与 `ui/dist/index.html` 的修改时间 vs `ui/src/panels/ModelsPanel.tsx`（12:56:39）
- 若 exe/dist 早于 ModelsPanel 修复 → 让用户关 opensound.exe 后 `npm run build` 重建，重测
- **用户已明确：错误提示"点一下还是晃一下无反应"——如果重建后仍晃，必须拿到用户点击后卡片下方/设置页日志区的实际文字再定位，禁止再盲改**

### 第 1 步：把三个 python 引擎的 venv 依赖真正装好（用户点击触发）
- App 内引导条若显示 py 缺 →（可选，若已装过可跳过）「安装 Python 基础」按钮
- 模型页 qwen3 卡 →「检测/修复」→ 确认 2.5GB → 观察进度（应出现 uv 输出日志流）
- 完成后检查 `.venv-qwen3\Lib\site-packages\qwen_tts` 是否存在（关键包判定）→ 重启服务 → 8001 是否活
- sensevoice-原始 → `.venv-funasr` 关键包 `funasr` → 重启 → 8002 活
- cosyvoice → 补齐按钮 → 确认 4.4GB → venv 会自动补 modelscope → 重启 → 8003 活
- **全程用户点按钮、用户看进度；AI 只改代码/给命令，绝不代为执行安装下载**

### 第 2 步：兜底验证（若 App 内按钮仍有问题）
- 手动等价命令（用户跑）验证链路本身通：
  `powershell -ExecutionPolicy Bypass -File E:\Github\opensound\asr-server\bootstrap-python.ps1`
- 或直接无头验证服务端：`node asr-server.js --port 9530` + `Invoke-WebRequest` 不带 confirm 调 `/install-model?engine=qwen3`（应返回 BIG_DOWNLOAD_CONFIRM，不会真装）

### 第 3 步：剩余开放项（非本轮阻塞）
- ⏳ **uv pip 大文件下载无实时进度**（08-28 晚六实测登记）：`uv pip install` 时只看到 `Downloading torch (2.6GiB)` 后干等，无百分比/速度/取消。**待办**：在 `runCmdWithEnv` 的 uv pip 分支加进度——间隔读下载目标大小发 `type:'progress'`（复用前端现有进度条），并支持取消（kill uv 子进程）。**用户已明确：本轮先不做，等下载完成再说**。
- qwen3 依赖 `qwen-tts` 包名/清华镜像可用性：前端安装日志如实可见后再定（此前网络有沙箱干扰，勿轻信本机 HTTP 探测）
- `requirements-qwen3.lock` / `requirements-funasr.lock` 不存在（当前用最小依赖集安装，后续可 freeze 钉版）
- 分发策略 A/B（034 阶段2）未拍板；bundle.resources（034 阶段4）未做

### 第 3·A 步：PyTorch 下载的镜像与进度（08-28 晚七已实现+登记）
> 用户踩坑实录：官方源 `download.pytorch.org` 国内下载 torch 2.6GiB 要数小时（实测 30 秒仅 +0MB，靠 .tmp 目录确认在下载）。
> **已实现（asr-server.js，重启服务生效）**：
> 1. **多镜像 fallback**：`TORCH_MIRRORS` = [阿里云 pytorch-wheels → 清华 pytorch-wheels → 官方]，按驱动自动选 cu 目录（≥570→cu128 / ≥560→cu126 / ≥550→cu124），逐个 `--index-url` 尝试，装完校验 `torch.__version__` 含 `+cu`，失败自动切下一镜像；全失败给三选一排查。`OPENSOUND_TORCH_INDEX` 可单源覆盖（高级用户）。
> 2. **实时进度**：`runCmdWithEnv` 新增 `opts.progressDir`——uv 下载时先落 `%LOCALAPPDATA%\uv\cache\.tmp*`，每 800ms 统计其字节数发 `type:'progress'`（复用前端进度条，不再"Downloading 一行干等"）。
> **防复发（写进铁律）**：**任何大文件下载必须双做——国内镜像优先 + 实时进度**；官方源只作兜底。这不再是建议，是坑 O 的强制要求。

---

## 六、铁律提醒（新会话全程）
1. **一切安装/下载由用户点击触发**（App 内按钮或用户跑脚本），AI 只改代码/写命令；大流量（>1GB）需二次确认（已有内嵌确认行实现）
2. **不执行任何 git 写操作**（命令列给用户自己跑）；git 只读不受限
3. **不杀进程**（除自己启动的明确 PID；杀 node 会连 DSH 一起杀）
4. **分层不混淆**：node/py 基础=全局按钮；引擎 venv+依赖=模型页卡片；模型文件=模型页补齐
5. 前端/Rust 改动必须 `npm run build`（先关 opensound.exe）；服务端改动重启服务即生效
6. 每完成一步停下汇报，用户确认后再继续；用户说停就停

---

## 六·A 算力选型原则（强制：Win / macOS / Linux 统一口径，防"一堆屎"）

> **一句话**：**有 GPU 用 GPU，没有就用 CPU**；macOS 走自带 MPS；Linux 有 N 卡走 CUDA、AMD 预留 ROCm。检测必须可靠、装完必须校验、失败给明确指引，绝不静默回落。

| 平台 | 加速器 | 判定依据 | torch 变体 | 说明 |
|---|---|---|---|---|
| Windows + NVIDIA | CUDA | `where nvidia-smi` 找到 | `--index-url https://download.pytorch.org/whl/cuXXX`（按驱动版本自动选） | 驱动 ≥570→cu128 / ≥560→cu126 / ≥550→cu124；<550 拒绝安装并提示升级驱动（防白下 2.5GB）；装完校验 `torch.__version__` 含 `+cu` |
| Windows 无独显 | CPU | 无 nvidia-smi | PyPI 默认（清华镜像） | 如实显示 CPU，不骗就绪 |
| macOS（Apple Silicon） | MPS | torch 内建 `mps.is_available()` | **PyPI 默认即可**（MPS 是内建后端，无需 cu wheel） | 千万别给 macOS 装 CUDA 版（不存在）；qwen3-tts-server.py `--device` 自动检测 |
| macOS（Intel） | CPU | — | PyPI 默认 | 无 MPS，无加速 |
| Linux + NVIDIA | CUDA | `nvidia-smi` | 同 Windows CUDA 分支 | 同驱动版本门槛 |
| Linux + AMD（未来） | ROCm | `rocm-smi`（预留） | `--index-url .../whl/rocmXXX` | 当前未实现；实现时参照 CUDA 分支"装后校验" |

**落地要点（已实现 / 后续必须遵守）**：
1. 判定用**硬件工具存在性**（nvidia-smi / rocm-smi / torch mps），不靠系统猜测。
2. **uv/pip 换变体重装必须 `--reinstall-package <包名>`**——不带会"Checked N packages in 90ms"秒跳不真装（实测坑，见 000-install 坑 N）。
3. 装完**必须校验**加速器可用（`+cu` 后缀 / `mps.is_available()`），失败给三选一排查（源无匹配 wheel / 驱动门槛 / 未真下载）。
4. 无加速器 = CPU：不装错变体、UI 如实标注；**有加速器但没生效 = 必须报错，不许装完悄悄还是 CPU**。
5. 环境变量 `OPENSOUND_TORCH_INDEX` 仅高级用户覆盖，普通用户零配置。

---

## 七、IndexTTS 独立部署复盘（040 实测定档 · 2026-08-30）——"5000 万 token 装不好"的真相

> 关联：040（官方 README 逐条对照 + 独立部署）、041（App 接入方案）、036（全链路规范）、038（三连规划）。
> 全部为**本机实测**（Win + RTX 4070 Ti，E:\Github\indextts2.5 独立目录，2026-08-30 验收四条全过）。

### 7.1 之前"死都装不好"的真正根因链（按发现顺序，全部有实测证据）

| # | 根因 | 证据 | 处置 |
|---|---|---|---|
| 1 | **040 说"vendor 裁剪源码已齐"是假的**：jsdelivr 裁剪版只有 69 文件，实测缺 `tools/gpu_check.py`、缺 `indextts/infer_v2_5.py`、缺 `index_tts` 包——040 自己的验收第 2 条（import infer_v2_5）在这份源码上**不可能通过** | 目录列举 + glob 实测 | 改用官方 tar 包（71 文件全量，1.72MB） |
| 2 | **App 管理 uv 的缓存目录 ACL 损坏**：`C:\Users\Administrator\AppData\Local\uv\cache\sdists-v9\.git` 拒绝访问（os error 5）→ uv 任何操作直接失败 | uv 报错实测 | 弃用；全新独立 uv（官方 README `pip install uv` 同款） |
| 3 | **OpenVPN 隧道 80KB 断流**：任何 HTTPS 响应体传到 81920 字节必被掐断（IncompleteRead 铁证），DNS 间歇挂起；schannel 系（IWR/curl）全挂、git/python(OpenSSL) 部分通 → 官方源 torch 2.6GB 在这条管道上**物理传不完** | 多次 IncompleteRead(81920) + DNS gaierror | 用户切直连网络（040 阶段 0） |
| 4 | **直连也抖**：GitHub ≈94KB/s、pypi ≈90KB/s 且偶发断流；**aliyun 镜像 ≈11MB/s、modelscope ≈8.8MB/s、aliyun pytorch-wheels cu128 2-6MB/s**——同一镜像测速忽快忽慢（网络波动，非源问题） | 全端点 2MB 实测表（040） | 依赖/torch/模型全部走国内镜像（README 官方认可的镜像路径） |
| 5 | **`uv lock` 不可重新生成**：官方 pyproject 的 `[tool.uv.sources]` + `[[tool.uv.index]] explicit` 结构下，re-lock 会在"非当前平台环境"撞官方自带冲突（accel 的 flash-attn 要求 torch<2.8.dev0 或 >=2.9，与 torch==2.8.* 互斥）——官方自己在 pyproject 注释里警示过"别乱 re-lock" | uv lock 报错原文 | **用官方 uv.lock，只把注册源 URL 换成 aliyun 镜像（字节/sha256 全一致），`uv sync --frozen` 安装** |
| 6 | **PowerShell `Set-Content -Encoding utf8` 写文件带 BOM** → 官方构建器 hatchling/tomllib 第一行直接 "Invalid statement" | 首字节 0xEF 0xBB 0xBF 实测 | `utf8NoBOM` 重写 pyproject.toml 与 uv.lock |
| 7 | **官方 uv.lock 里 torch 的注册源是 `download-r2.pytorch.org`（官方慢源变体）**，补丁换 `download.pytorch.org` 时漏了这个 `-r2-` 变体 → uv 偷偷从官方源拉 3.2GB（330KB/s，反复冻） | verbose 日志 `Sending fresh GET request for: download-r2...` | uv.lock 全量替换为 aliyun（0 残留，tomllib 解析验证） |

### 7.2 结论（一句话版）

**IndexTTS-2.5 是标准 uv 项目，官方流程本身没问题；装不上 = ①裁剪源码缺文件 ②App 污染环境（uv 缓存 ACL） ③网络隧道 80KB 断流 ④官方源国内不可达且没有"官方锁不重锁、镜像换主机"的认知。五层全踩齐，才烧掉前面几千万 token。**

### 7.3 独立部署验收实录（040 第四条，全过）

| 验收项 | 结果 |
|---|---|
| torch 2.8.0+cu128 + cuda=True | ✅（RTX 4070 Ti） |
| `import indextts.infer_v2_5 → IndexTTS2` | ✅ |
| checkpoints（config.yaml + 权重） | ✅ 10.4GB（整仓 5.23GB + 运行时自动补齐辅助四件套 w2v-bert/MaskGCT codec/CAMPPlus/BigVGAN） |
| 真出声 | ✅ out_test.wav（4.7s，22.05kHz 16bit；**注意运行环境需要可写缓存：沙箱下 numba 会报 "cannot cache function: no locator" → 设 `NUMBA_CACHE_DIR` 到可写目录**） |

**性能实录（基座无 extras）**：模型装载 15.7s；GPT 11.95s；**s2mel 462s（占比 90%，RTF≈108）**；BigVGAN 0.28s。提速方向：`--extra accel`（flash-attn+triton-windows）与 `use_bf16=True`，见 041/060 后续。

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-28 | 初版：实测状态（9528 正常+三 python 崩缺依赖）、「晃一下」根因（前端确认行藏在 install-log 内不渲染）与修复、本轮全部改动清单、验收标准与新会话执行步骤 |
| 2026-08-28 | 复现修复（08-28 晚）：①「晃一下」真实剩余根因 = **api.ts 的 installModel 对 NDJSON `type:"error"` 行不抛错**（服务端 L1757 把 BIG_DOWNLOAD_CONFIRM 写成 error 行、HTTP 仍 200 → 前端 catch 永不触发 → bigConfirm 永不设置，确认行渲染修复因此无效）→ 已在 installModel 把 error 行转成抛错；②确认行「取消」提示去掉写死的 cosyvoice 路径；③uv 建引擎 venv 加 `--clear`（空壳 venv 已存在时 uv venv 报 exit 2 拒绝覆盖，实测卡住） |
| 2026-08-28 | 复现修复（08-28 晚 二）：**runCmdWithEnv 成功分支漏调 `resolve()`**——`uv venv` exit 0 打出「✓ 命令完成」后 Promise 永不 resolve，后续「安装依赖…」与 pip 步骤全部挂起（用户实测"venv 建完就没进展"）；已补 `resolve()`。此函数同时服务 cosyvoice venv/modelscope 补装，一并解锁。服务端改动，重启服务即生效 |
| 2026-08-28 | 复现修复（08-28 晚 三）：**qwen3「补齐」静默 done**——uvVenvInstaller 只查 venv，模型 2.3GB（models/hf/hub/）此前只能靠重启服务时 qwen3-tts-server.py 顺带拉取，点「补齐」无模型安装器 → 立即 done「环境就绪」→ 前端刷新后仍缺文件，观感"晃一下没反应"。改为 `qwen3ModelInstaller` 二段式：① venv（复用 uvVenvInstaller）② 模型缺失 → BIG_DOWNLOAD_CONFIRM:2.3GB 二次确认 → .venv-qwen3 python 跑 huggingface_hub snapshot_download（HF_HOME=models/hf，默认 hf-mirror）→ 落盘正好是 checks 检查的路径。服务端改动，重启服务即生效 |
| 2026-08-28 | 复现修复（08-28 晚 四）：**qwen3 朗读近 1 分钟不出声 = CPU 推理**（实测 8 字 178s）。根因：uv 装 venv 走清华 PyPI 默认给了 **CPU 版 torch**（2.13.0+cpu），本机 RTX 4070 Ti 全程闲置。驱动 545.84 仅支持到 CUDA 12.3，装 cu126+ 新 torch 需要驱动 ≥550。方案（用户已确认）：**先升级 NVIDIA 驱动到 550+ → 再装 CUDA torch**。已实现：① `uvVenvInstaller` 增加 CUDA 升级路径——检测到 N 卡 + venv 就绪但 torch 为 CPU 版 → BIG_DOWNLOAD_CONFIRM:2.5GB → `uv pip install --index-url <TORCH_INDEX> torch torchaudio`（默认 `https://download.pytorch.org/whl/cu126`，可 OPENSOUND_TORCH_INDEX 覆盖）；升级后仍 CPU 版则明确报错提示驱动/源问题 ② `/models` 输出 `gpuUpgrade` 标记 ③ 前端模型卡新增黄色「升级 GPU 加速」按钮 + Button 组件支持 className。前端改动需重建 exe |
| 2026-08-28 | 复现修复（08-28 晚 五）：① **uv pip 换变体重装必带 `--reinstall-package torch --reinstall-package torchaudio`**——旧命令 `uv pip install ... torch torchaudio` 因同版本已装被 uv 秒跳（日志 `Checked 2 packages in 90ms`），一个字节没下载、升级后仍 CPU 版（实测坑，已修+登记 000-install 坑 N）；② **TORCH_INDEX 不再写死 cu126**：按驱动版本自动选 PyTorch 官方源（`torchIndexForDriver`：≥570→cu128 / ≥560→cu126 / ≥550→cu124 / <550→null 并提示升级驱动，防白下 2.5GB），`OPENSOUND_TORCH_INDEX` 仅高级覆盖；③ 新增 §六·A **算力选型原则**（Win CUDA / macOS MPS / Linux CUDA·ROCm·CPU 三平台矩阵 + 装后校验 + 不静默回落） |
| 2026-08-28 | 实测确认（08-28 晚 六）：CUDA 升级链路走通——驱动 616.56 自动选 cu128 ✓、`--reinstall-package` 真下载 ✓（日志出现 `Downloading torch (2.6GiB)`）。**已知缺口：uv pip 大文件下载无实时进度**（runCmdWithEnv 只按行传 log，uv 的字节进度条不落 NDJSON；用户只能看到"Downloading torch (2.6GiB)"干等，无法显示百分比/速度/取消）。**待办已登记 §五 第 3 步**：后续给 uv pip 加大流量进度（如间隔读 .part/文件大小发 `type:'progress'`，复用现有进度条，需要时可取消）。本轮用户明确"先不改代码，等下载完成"。 |
| 2026-08-28 | 复现修复（08-28 晚 七）：① **PyTorch 下载多镜像 fallback**——官方源国内太慢（torch 2.6GiB 数小时，用户踩坑），`TORCH_MIRRORS`=[阿里云 → 清华 pytorch-wheels → 官方]，按驱动自动选 cu 目录，逐个尝试+装后校验（+cu 后缀），全失败给三选一排查；`OPENSOUND_TORCH_INDEX` 单源覆盖（高级）。② **uv pip 实时进度**——`runCmdWithEnv` 加 `opts.progressDir`，每 800ms 统计 uv cache `.tmp*` 字节发 `type:'progress'`（复用前端进度条）。③ 035 §五·3A 登记镜像/进度规范；000-install 坑 O 更新为"已修+强制要求" |
| 2026-08-28 | 复现修复（08-28 晚 九，镜像"全失败"真因）：**阿里云/清华 pytorch-wheels 是平铺目录（/cuXXX/xxx.whl），不是官方那种 /cuXXX/torch/ 子目录**；且 `uv pip --index-url` 只认 PEP 503 → 之前"多镜像 fallback"把国内镜像当 PEP 503 用 → 全 404、失败原因还被 catch 吞。已重构：① `probeWheelOnMirror()` 按 `layout: flat|simple` 探测真实目录结构 + 正则解析最新 cp311 win_amd64 wheel（兼容 `&#43;`/`%2B`/`+` 三种编码）+ HEAD 字节数，探测原因全部打日志；② 下载改用 `downloadOneFile` 直下 wheel（真实进度+断点续传），装用 `uv pip install 本地文件`；③ 实测验证：阿里云 ✅ torch/torchaudio v2.11.0+cu128 存在，官方 ✅，清华 404 会如实跳过。000-install 坑 O 全面更新 |
| 2026-08-28 | 胜利收口（晚十）：qwen3tts 全程跑通（CPU→CUDA 可正常朗读）。① **三种用户统一体验固化**（000 最高原则第 7 条）：纯 CPU / 有 GPU 直装 CUDA / CPU→加显卡 App 内一键升级（自动停占用引擎→复用 wheel→秒装→校验→重启），用户零手动命令；② **GPU/CPU 徽标**：`/models` 新增 `accelTag`（CUDA cuXXX 绿徽标 / CPU 灰徽标），前端 model-meta 渲染；③ **坑 P（升级 torch 时引擎服务锁 _C.pyd，拒绝访问 os error 5）**：App 自动 taskkill 8001/8002/8003 占用进程 + 等 1.2s 释放，不再甩锅手动停服；④ **坑 Q（curl % Total 刷日志）**：downloadOneFile 加 `-sS`；⑤ 新文档 **036-python引擎全链路规范.md**（qwen3tts 为范本：①Python 基础②venv③CUDA 升级④模型⑤重启⑥运行六层顺序 + 驱动/cu 门槛 + 五连坑防复发 + sensevoice/cosyvoice 照抄清单） |