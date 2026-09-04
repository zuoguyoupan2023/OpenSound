# 036 · Python 引擎全链路规范（venv 系引擎从零到可用的唯一路线图）

> 定位：**以 qwen3tts 为完整范本**，规定任何一个 Python venv 系引擎（qwen3 / sensevoice-原始 / cosyvoice）从零到"正常运行"必须遵循的全部环节、顺序、坑与验收标准。
> 起源：qwen3tts 从 CPU 到能跑的完整过程花了 1 亿 token（035 全程复现：确认行不弹 → venv 建不出 → runCmd 不 resolve → 模型没安装器 → CPU torch 太慢 → 驱动过旧 → uv 秒跳 → 镜像 404 → 文件锁）。**本文档存在的唯一目的：让 sensevoice-原始 / cosyvoice 照抄 qwen3tts 的已踩通的路径，不再花第二个 1 亿。**
> 硬前提：**一切操作在 App 内完成，用户零手动命令**（000 最高原则第 7 条）。只有 App 内走不通时才给用户命令兜底。
> 坑账本：**000-install §四 = 全部实测坑的总账本**（A~Q，Q 后有增量继续编号）；036 只引用坑编号不重复全文。**存在其他对话踩出的坑待并入**（用户指定：会在另一对话结束后要求补充本文件）——新会话接手先查 000-install 坑表是否已含全部，缺则补。

---

## 〇、三种用户的统一体验（所有引擎通用）

| 用户情况 | 期望行为 | 判定 | App 动作 |
|---|---|---|---|
| 只用 CPU | 能装能用，如实显示 CPU | 无 nvidia-smi / 无 GPU | venv 装 CPU 版 torch（清华 PyPI）；徽标「CPU」（灰） |
| 有 GPU（装机即 CUDA） | 首次安装直接用 GPU | `nvidia-smi` 在 PATH | venv 装 CUDA 版 torch（多镜像探测，阿里云优先）；徽标「CUDA cuXXX」（绿） |
| CPU → 后来加显卡 | **App 内一键升级**，不手动 | torch 为 CPU 版 + 检测到 N 卡 | 卡片出「升级 GPU 加速」→ 二次确认 → App 自动停引擎 → 复用/下载 wheel → 秒装 → 校验 +cu → 提示重启服务 |

---

## 〇·补 引擎部署正确逻辑（官方口径定档 · 2026-08-28）

> 每个 python 引擎怎么部署，**以官方 README / 模型卡为准**（链接登记在本表与 engines/*.json），App 不发明套路，只做两件事：
> ① 按官方依赖链自建 venv；② 按官方模型仓**整仓全量**下载（动态清单 §五，非死清单）。CPU/GPU 由 torch 构建决定：
> **CPU 版一律可装可用（慢是特性、如实提示）；N 卡装完一键升 CUDA（§四）——不因本机无加速器拒绝安装**。这就是"CPU 怎么办 / GPU 怎么办"的最终口径。

| 引擎 | 官方安装口径（来源） | 官方设备要求 | 本 App 动作 | 许可（官方） |
|---|---|---|---|---|
| CosyVoice 3（0.5B） | [FunAudioLLM/CosyVoice](https://github.com/FunAudioLLM/CosyVoice) Readme：`pip install -r requirements.txt`、torch≥2.3；模型走 ModelScope/HF | 官方 demo 面向 GPU；CPU 可跑但慢（官方明示） | venv `.venv-cosyvoice` + `requirements-cosyvoice.lock`（torch 按 §〇 三型）+ 整仓全量 ~9.1GB + 8003 | Apache-2.0（权重以仓库 LICENSE 为准） |
| IndexTTS-2.5（0.8B） | **官方 README（index-tts 仓库，040 实测原文）**：`git clone https://github.com/index-tts/index-tts.git` → `pip install -U uv` → `uv sync --all-extras`（Windows 建议去 `--all-extras` 跳过 DeepSpeed）；模型 `hf download IndexTeam/IndexTTS-2.5 --local-dir=checkpoints` 或 `modelscope download --model IndexTeam/IndexTTS-2.5 --local_dir checkpoints`；小模型首次运行自动下载 | CUDA 原生；Win CUDA 最顺；0.8B 显存友好 | venv `.venv-indextts`（**官方 uv.lock** + torch==2.8.* cu128 经 `[tool.uv.sources]`）+ 8004 + 模型整仓全量（§五 动态清单） | **LicenseRef-Bilibili-IndexTTS（pyproject 实测；另有 INDEX_MODEL_LICENSE）**——非 Apache-2.0，商用前必须读 LICENSE 原文 |
| Fish Audio（S2.1 Pro / s2-pro 4B） | [fishaudio/s2-pro](https://huggingface.co/fishaudio/s2-pro) + fish.audio API；本地 BF16 4B | 本地需 NVIDIA ≥24GB（本机 12GB 不够）；**官方主推云端 API** | 按 007 §3.3 定案：**云端 compat/v1 复用 cloud 引擎**（`s2.1-pro-free` 免费档先验链路）；本地路线待 ≥24GB 或 s2.cpp GGUF | FISH AUDIO RESEARCH LICENSE（商用需书面授权） |

---

## 一、全链路总览（qwen3tts 为范本，六层顺序不可乱）

```
① 安装 Python 基础（uv + CPython 3.11，~100MB）   ← 设置页/引导条独立按钮（可选层，不装不影响 kokoro/sensevoice/llm）
        ↓
② 安装引擎 venv + 依赖（含 torch，~2.5GB）         ← 模型页卡片「检测/修复」+ 二次确认
        ↓
③ （有 GPU 且装成 CPU 版时）升级 CUDA torch        ← 卡片「升级 GPU 加速」+ 二次确认（见 §四流程）
        ↓
④ 补齐模型文件（qwen3: 2.3GB hf 快照）             ← 卡片「补齐」+ 二次确认
        ↓
⑤ 重启服务                                        ← 托盘/侧边栏（或安装完成后 UI 提示）
        ↓
⑥ 正常运行（朗读可选 Qwen3 / 识别可选原始版 / 克隆可用） ← 引擎徽标绿 + 实测出声/出字
```

**对应代码位置（asr-server.js，全部已实装并经 1 亿 token 实测踩通）：**
| 层 | 实现 | 关键点 |
|---|---|---|
| ① | Rust `install_python` + `ensure_python_base` | uv 多镜像 + `uv python install 3.11` + 清华 UV_INDEX_URL |
| ② | `uvVenvInstaller({ name, pkgs, keyPkg, label, estGB })` | `uv venv --clear` → `uv pip install`；就绪判定=`venvKeyPkgOk`（关键包在 site-packages，防空壳） |
| ③ | `uvVenvInstaller` 内 `torchCpuHere` 分支 | `torchCuDirForDriver` 按驱动选 cu 目录 → `probeWheelOnMirror` 探测镜像 → `downloadOneFile` 直下 wheel → `uv pip install 本地 wheel` |
| ④ | qwen3: `qwen3ModelInstaller`（venv + 模型二段式） | `snapshot_download`，HF_HOME=models/hf |
| ⑤ | Tauri 托盘/侧边栏 start_service | 重启后 start-all.js 重新拉起全部引擎 |
| ⑥ | 前端选引擎处可见 | 徽标「运行中」+ `accelTag`（CUDA/CPU） |

---

## 二、驱动与算力（①的前置检查，N 卡必须）

**判定**：`HAS_NVIDIA`（`where nvidia-smi`）+ `NVIDIA_DRIVER`（查询驱动版本）。
**cu 目录选择**（Win 桌面驱动门槛）：

| 驱动版本 | cu 目录 | 日志示例 |
|---|---|---|
| ≥ 570 | cu128 | 实测 RTX 4070 Ti + 616.56 → cu128 |
| ≥ 560 | cu126 | |
| ≥ 550 | cu124 | |
| < 550 | 无 → 报错引导升级驱动 | 绝不白下 2.5GB（坑 G） |

- **有 N 卡但 torch 是 CPU 版** → `torchBuildTag` 检测（site-packages 目录名无 `+cu`）→ 走 §四升级流程。
- **无 N 卡** → 永不装 CUDA 版，CPU 版如实用（徽标灰色 CPU）。
- macOS：MPS 内建，PyPI 默认即可，**禁止**装 CUDA 版；Linux：nvidia-smi → CUDA，rocm-smi（预留）→ ROCm。

---

## 三、安装引擎 venv（②）—— qwen3tts 范本流程

1. 用户点卡片「检测/修复」→ `/install-model?engine=qwen3`
2. 服务端 `uvVenvInstaller`：
   - `venvKeyPkgOk('.venv-qwen3', 'qwen_tts')` 就绪 → 直接 done（不再装）
   - 缺 → 打日志「缺引擎环境 → 开始检测/安装…」
   - **无 uv** → 报错「先装 Python 基础」（不静默）
   - **大流量（estGB=2.5）** → 抛 `BIG_DOWNLOAD_CONFIRM:2.5GB:.venv-qwen3` → 前端确认行 → 带 `confirm=1` 重试
   - `uv venv --python 3.11 --clear`（**--clear 必须**：空壳 venv 已存在时 uv 拒绝覆盖，坑 C）
   - `uv pip install qwen-tts torch torchaudio`（清华镜像）→ 装后 `venvKeyPkgOk` 校验
3. 前端：进度流（runCmdWithEnv 每行 log）+ 完成 done

**完整依赖链**：uv → CPython 3.11 → venv → 引擎关键包（qwen_tts / funasr / torch+modelscope）。任何一环缺失 = 如实报错，不假装就绪（坑 J 防空壳）。

---

## 四、CPU→GPU 升级（③）—— 022 最复杂的五种连坑的完整防复发清单

**触发**：`HAS_NVIDIA && venv 就绪 && torchIsCpuOnly(name)` → 绿色（黄）按钮「升级 GPU 加速」。

**完整流程（全在 App 内，1 亿 token 实测踩通）：**
1. 点击 → 日志「检测到 NVIDIA 显卡，但 torch 为 CPU 版 → 建议升级 CUDA 版」
2. `torchCuDirForDriver(NVIDIA_DRIVER)` 选 cu 目录；驱动过旧 → 报错引导升级驱动（不白下）
3. 二次确认 `BIG_DOWNLOAD_CONFIRM:2.5GB:<name>-torch-cuda`
4. **自动停占用引擎**（坑 P）：检测 8001/8002/8003 占用 → `taskkill` 该 PID（App 拉起的子服务，正常操作）→ 等 1.2s 释放 .pyd 锁。**绝不把"手动停服务"甩给用户**
5. **探测镜像**（坑 O 真因）：`probeWheelOnMirror` 按 `layout: flat|simple` 逐个探测目录页：
   - 阿里云/清华 = **平铺**（`/cuXXX/xxx.whl`）；官方 = **simple 子目录**（`/cuXXX/torch/xxx.whl`）
   - 正则解析版本**兼容 `&#43;` / `%2B` / `+` 三种编码**（阿里云页面实测 `&#43;`）
   - 探测结果打日志（哪个镜像、版本、大小）；失败原因打日志，**禁止吞**（坑 A 同族）
6. `downloadOneFile` 直下 wheel（`-sS` 静默 curl，坑 Q；800ms 真实 progress 事件；.part 断点续传；多镜像失败换源）
7. `uv pip install <本地 wheel 路径>`（本地安装，秒装不联网）
8. 校验 `torchBuildTag` 含 `+cu` → 成功日志「torch 已升级为 CUDA 版 ✓（2.11.0+cu128）」
9. 提示「重启服务后生效」

**已踩通的实测事实（勿重查）**：
- 阿里云 `https://mirrors.aliyun.com/pytorch-wheels/cu128/torch-2.11.0&#43;/...`：torch v2.11.0+cu128（2.6GB）与 torchaudio v2.11.0+cu128（1.6MB）真实存在 ✅
- 官方 `download.pytorch.org/whl/cu128/torch/`：同版本存在 ✅（备用）
- 清华 pytorch-wheels：当前 404，探测如实跳过，不阻塞
- 驱动 616.56 自动选 cu128；装后 `torch.cuda.is_available()` = True
- **uv 秒跳（坑 N）**：uv 发现同版本已装会 `Checked N packages in 90ms` 不真装——但我们走"本地 wheel 安装"路径，天然无此问题（本地文件会真实替换）

---

## 五、补齐模型（④）

- qwen3：`qwen3ModelInstaller` —— venv 后接 `snapshot_download('Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice')`，`HF_HOME=<数据目录>/models/hf`、`HF_ENDPOINT=hf-mirror`，落盘正好是 checks 路径 `models/hf/hub/models--Qwen--...`（坑 K）。
- 通用的：`downloadOneFile` 多镜像 + 字节校验（url-multi 类，如 LLM / cosyvoice 权重）。
- 大流量（>1GB）必须二次确认（`BIG_DOWNLOAD_CONFIRM`）；前端确认行独立渲染（坑 A/B）。
- **每个引擎必须有端到端安装器**（venv + 模型都要能一键补齐）——不能"缺模型靠重启服务顺带拉取"当唯一路径（坑 F）。

**⚠️ 铁律（2026-08-28 血泪教训）：模型权重一律「整仓全量下载」，禁止维护自定义"必需子集"清单。**
S4 曾为省流量自造"必需清单"（只挑 6 个文件），结果漏 BlankEN（LLM 主干，加载即崩）、漏其它，一个接一个在名单上添文件 → 打地鼠式翻车一天。整仓清单 = 模型仓官方全文件（逐文件字节实录，与 engines/*.json checks 保持一致）。
真要标注"可选文件"，必须**先 grep 代码 + 读配置文件确认零引用**才可跳过（2026-08-28 实测：llm.rl.pt 代码零引用=真可选；BlankEN 被 S4 想当然划为非必需=翻车根源）。
选型想省流量可以跑"最小集"，但最小集必须是**官方发布口径**（如 005 方案 B），不是自己拍脑袋列。

**2026-08-28 再升级（正确方式定档）**：
- **清单动态化**：安装时从 ModelScope 整仓文件 API（`repo/files`，Path+Size）拉取清单 → 仓库文件变动自动跟随；API 失败才回退代码内静态登记（兜底，不是首选）。代码里不再"维护一份会过期的硬编码清单"当真相。
- **元数据/展示文件豁免**：`.gitattributes` / `README.md` / `asset/*` 等在镜像间必然不同（实测 HF vs ModelScope 字节不一致）且非运行必需 → 不下载、不进 checks、不校验（消除"大小不符"红字）。
- **校验纪律**：模型文件字节校验（`statSync().size` 为字节，跨平台一致、无舍入）**不符 = 失败**（自动换镜像重下一次再校验，仍不符才报错）——杜绝"下了 2MB 却说 200MB 完成"式假完成。
- **hash 升级待办**：字节校验挡不住"同长不同内容"；HF 用 ETag/sha256、pip 用 hash。ModelScope 文件级 API 是否提供 MD5 待实测登记，可用后升为 md5 校验。

**中国网络实测可用/不可用源头清单（2026-08-28 实测定档，新引擎先查此表，勿重复踩）**：

| 源头 | 用途 | 实测状态 |
|---|---|---|
| hf-mirror.com（`/…/resolve/main/<file>`） | HF 仓库直链 | ✅ 可用（偶发低速 <20KB/s×90s 被判死换源） |
| modelscope.cn（`/models/<org>/<repo>/resolve/master/<file>`，API `dolphin/models` 可查） | Alibaba 系模型整仓；Range 206 续传 | ✅ 国内最快首选（Fun-CosyVoice3-0.5B-2512 19 文件字节与 HF 一致） |
| cdn.jsdelivr.net（`/gh/<owner>/<repo>@<ref>/<path>`；data.jsdelivr.com 可枚举目录树） | GitHub 仓库文件（vendor 代码补齐） | ✅ 可用（GitHub 直连被墙时的标准补救） |
| pypi.tuna.tsinghua.edu.cn | Python 包（uv 默认 UV_INDEX） | ✅ 可用（⚠️ matcha-tts 仅 sdist 旧版 0.0.x） |
| 阿里云/清华/官方 pytorch-wheels | torch cuXXX wheel（§四 升级用） | ✅ 阿里云/清华=平铺目录、官方=simple（坑 O 结构） |
| huggingface.co 直连 | — | ❌ 被墙（连接 15s 超时） |
| github.com 直连（git clone / ls-remote） | — | ❌ 被墙（21s 超时）→ 一律走 jsdelivr |
| gitee.com | — | ⚠️ 可达，但 Matcha-TTS 无可用镜像（mirrors/ 401、direct 404） |

**CosyVoice3 容量口径（2026-08-28 实测）**：运行必需 ≈ **5.05GB**（llm.pt 2.0 + flow.pt 1.3 + BlankEN 0.99 + tokenizer 0.97 + hift 0.08 + campplus 0.03 + 配置，即 Mac 最小集口径）；整仓全量 ≈ **9.1GB**（另含 llm.rl.pt 2.0【代码零引用】/ flow.decoder.estimator.fp32.onnx 1.3【onnx 加速变体，CPU 不触发】/ speech_tokenizer_v3.batch.onnx 0.9【流式批量路径，非流式推理不触发】）。磁盘充足一律整仓全量，一次买断"永不再缺文件"。

---

## 六、重启服务与正常运行（⑤⑥）

- 装完 venv / torch / 模型后必须「重启服务」：start-all.js 重新拉起全部子服务（qwen3-tts 8001 / sensevoice-原始 8002 / cosyvoice 8003）。
- 正常运行验收 = **引擎徽标绿（running）+ 实测出声/出字**：朗读选 Qwen3 出音频、识别面板出文字、克隆面板出音色。只看"安装完成"不算数（000 可见即验收）。
- `accelTag` 徽标：CUDA（绿）= GPU 在职；CPU（灰）= 无加速，如实告知。

---

## 七、各引擎照此办理（防 1 亿 token 重演）—— 已通 + 在办 + 规划

### 7.1 已通 / 在建引擎（venv + CUDA 通用范式，§三§四§五）

| 环节 | qwen3（已通 ✅） | sensevoice-原始（在办） | cosyvoice（在办） |
|---|---|---|---|
| venv 名 | `.venv-qwen3` | `.venv-funasr` | `.venv-cosyvoice` |
| 关键包（`VENV_KEY_PKG`） | `qwen_tts` | `funasr` | `torch` + `modelscope`（旧 lock 漏装坑 I） |
| venv 依赖 | qwen-tts torch torchaudio | funasr torch torchaudio | requirements-cosyvoice.lock（已补 modelscope） |
| 模型 | 2.3GB hf 快照（snapshot_download） | ~900MB models/sensevoice-original（funasr 运行时拉取？**未验证**⚠️） | 4.4GB 必需权重（downloadOneFile 多镜像，二次确认） |
| CUDA 升级 | ✅ 已通（§四） | 走 `uvVenvInstaller` 同分支（venv 装好 + N 卡 + CPU torch → 自动出升级按钮） | 同 |
| 安装器 | `qwen3ModelInstaller(uvVenvInstaller(...))` | `uvVenvInstaller` + 模型补齐（**需确认模型来源**） | 内联 cosyvoice-clone 安装器 |
| **待办（新会话第一步）** | — | ① 装 venv→验证 8002 活 ② 模型 900MB 的安装器要接上 ③ .venv-funasr 缺 numpy（2026-08-28 实测 8002 秒退） | ① 4.4GB 权重 ✓（modelscope 镜像，2026-08-28）② modelscope ✓ ③ 锁漏 onnxruntime 等已补（坑 I 扩展，补锁+安装器补装）④ 验证 8003 活 + 克隆出声（在验） |

> sensevoice-原始 / cosyvoice 的 venv + CUDA 升级逻辑**已随 uvVenvInstaller 自动获得**；剩余工作是各自**模型补齐安装器 + 实测 8002/8003 活**。照着 §五、§六做即可。

### 7.2 目标引擎（三模型 = CosyVoice / IndexTTS-2.5 / Fish Audio —— 2026-08-28 用户确认，从本节起开始执行）

> 结论先行：三个目标模型 = **CosyVoice（§7.1 在办，先做）**、**IndexTTS-2.5**、**Fish Audio（fish-speech 已更名 fish audio，最新为 S2.1 Pro）**。三者都走「venv + CUDA torch + 独立子服务端口 + 模型按需补齐」的同一范式（qwen3 已验证的路线），不需要也不应该发明新套路。下表给出判定要点；执行前按 §六"实测登记"补齐数字再动手。

| 引擎 | 是否 venv+CUDA 本地部署 | 判定依据（现有调研） | 接入要点 | 风险/待确认 |
|---|---|---|---|---|
| **CosyVoice 3（0.5B，先做）** | ✅ 是（本机加速档待实测登记） | §7.1 在办：INSTALLERS `cosyvoice-clone`（venv 自建 + modelscope 补装 + 4.4GB 权重自动下载已实装）+ `cosyvoice-tts-server.py`(8003) + `engines/cosyvoice-clone.json` 已齐 | 收尾 = App 内一键补齐 4.4GB 必需权重（二次确认）→ 验证 8003 活 → 克隆面板真实出声（可见即验收） | CUDA 升级走 §四（venv 装好后自动出「升级 GPU 加速」）；依赖锁已含 modelscope（坑 I 已修） |
| **IndexTTS-2.5（0.8B）** | ✅ **是**（0.8B，CUDA 原生，**040 已独立部署成功**） | 040/035 §七：官方 README `git clone + uv sync`；`torch==2.8.* +cu128`（`[tool.uv.sources]` 指向 pytorch-cuda 索引）；模型整仓 5.23GB + 辅助四件套自动（总 10.4GB） | 接三件套：engines/indextts.json + INSTALLERS（venv `.venv-indextts` + 官方 uv.lock 经 `--frozen` 安装；关键包 `indextts` + `infer_v2_5` import 探针）+ start-all 拉起 8004 + `/speak` 转发 engine=indextts；**详见 041** | 许可 **LicenseRef-Bilibili-IndexTTS（pyproject 实测，非 Apache）**；s2mel 基座 RTF≈108 慢（提速=accel/bf16，041 待办） |
| **Fish Audio（fish-speech 更名；最新 S2.1 Pro）** | ⚠️ **分档**：官方 BF16 ≈9.1GB 需 **NVIDIA ≥24GB**（本机 4070Ti 12GB **不够**）；fp8 社区版 ≈4.6GB 需 fp8 指令集；GGUF（s2.cpp）可 CPU/Vulkan/CUDA/**Metal**（q8/q6 档 4-6GB 本机可试） | 007 §3.3 定案：**云端 compat/v1 当前即可用**（复用 cloud 引擎）；本地权重路线需 ≥24GB 或走 s2.cpp GGUF | 本地：s2.cpp HTTP server（非 Python venv 系）或 fish-audio venv + `tools/api_server.py`（**自有协议 POST /v1/tts，非 OpenAI 兼容** → 需新引擎转发）| **FISH AUDIO RESEARCH LICENSE（商用需书面授权）**；s2.cpp 为 ALPHA 状态；**S2.1 Pro 最新（2026：API/实时对话，本地权重开源与否、体积待实测登记）** |

**部署范式统一为**（全部复用 §三~§六，不新发明）：
1. 独立 venv（`venvPyOf` 跨平台路径，坑 L）
2. 关键包就绪判定入 `VENV_KEY_PKG`（防空壳，坑 J）
3. N 卡 + CPU torch → 自动「升级 GPU 加速」（§四，含坑 P 自动停引擎）
4. 模型走 `downloadOneFile` / `snapshot_download` 多镜像补齐（§五，坑 K 落盘路径对齐 checks）
5. 独立子服务端口 + start-all.js 拉起（§六）
6. 三件套齐：INSTALLERS + engines/*.json（坑 H）+ 端到端安装器（坑 F）

**执行前必须实测登记**（007 §3.4，禁止猜测）：下载源（hf-mirror 优先）、字节数、GGUF/文件头 magic、启用方式、模型依赖清单。

---

## 七·补 引擎依赖/体积实测登记总表（硬性要求 · 防"猜来猜去"）

> **背景（2026-08-29 IndexTTS 实测教训）**：接入 IndexTTS 时因不知道 `index-tts` 包的真实 extras 名单，先后踩坑 R（官方 README `--all-extras` 在 pip/uv 均不可用）、坑 S（fetch pypi.org 被墙挂死 / 清华无 JSON API 404）。**结论：每个引擎的依赖/extras/体积必须"实测登记"成表，写入本文档，禁止任何环节靠猜。**
> 数据来源：本机 venv site-packages 实测（2026-08-29）+ 各引擎安装日志；登记后新会话直接照表，不重查（035 口径）。

### 实测登记总表（2026-08-29 本机实测）

| 引擎 | 关键包（VENV_KEY_PKG，实测） | 依赖清单（venv site-packages 实测摘要） | extras（实测） | 模型体积/来源 | 状态 |
|---|---|---|---|---|---|
| **qwen3** | `qwen_tts`（site-packages 实测 0.1.1） | 179 包：qwen_tts / torch / torchaudio / transformers 4.57.3 / librosa 0.11 / soundfile 0.14 / onnxruntime 1.29 / fastapi / gradio 6.17 / huggingface_hub 0.36 等 | 无 extras（qwen-tts 单包） | 2.3GB HF 快照 `models/hf/hub/models--Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice` | ✅ 已通（035） |
| **sensevoice-原始** | `funasr` | `.venv-funasr` **空壳（0 包，未装）**——待安装后登记 | — | ~900MB models/sensevoice-original | ⚠️ venv 还没装（036 §7.1 在办） |
| **cosyvoice-clone** | `torch`（+ 坑 I 扩展清单：modelscope/onnxruntime/omegaconf/librosa/soundfile/unidecode） | 243 包：modelscope 1.39.1 / onnxruntime 1.29.0 / librosa 0.11 / torch / torchaudio / Matcha-TTS(vendor) / diffusers 0.29 / transformers 4.51.3 / pyworld / pytorch_lightning 2.6.5 等 | 无 extras（依赖走 requirements-cosyvoice.lock） | 9.1GB 整仓全量 ModelScope Fun-CosyVoice3-0.5B（19-20 文件，字节实录 037） | ✅ CPU 已通，GPU 已接（037/038） |
| **indextts** | `indextts`（venv site-packages 实测） | **uv sync 官方 uv.lock 全量安装（--frozen），venv 实测 8.16GB**：torch 2.8.0+cu128 / torchaudio 2.8.0 / transformers 4.52.1 / modelscope 1.27.0 / librosa / soundfile / wetext / keras 2.9.0 / numba 0.63.0 / numpy 2.2.6 等 40+ 直接依赖（官方 pyproject 原文，非猜） | **pyproject 官方 extras（040 实测原文）**：`webui`=gradio==5.45.0；`deepspeed`=deepspeed==0.17.1；`accel`=flash-attn==2.8.3.post1 + nvidia-cuda-runtime-cu12 + nvidia-cudnn-cu12 + triton-windows==3.1.0.post17(win)；`torch_compile`=triton-windows==3.1.0.post17(win)；`test`=pytest——**Windows 官方建议跳过 deepspeed** | **10.4GB**（整仓 5.23GB / 26 文件，ModelScope 实测 + 运行时自动补齐辅助四件套 w2v-bert / MaskGCT codec / CAMPPlus / BigVGAN 入 checkpoints/hf_cache） | ✅ **独立部署完成（040，E:\Github\indextts2.5 验收四条全过）；App 接入 = 041** |

### 登记纪律（每引擎强制）
1. **extras 名单**：只认 wheel METADATA 的 `Provides-Extra:`（清华 simple index 下载 wheel 实测），**禁止** fetch pypi.org JSON API（被墙挂死，坑 S）或猜官方 README（`--all-extras` 是文档 bug，坑 R）。
2. **依赖体积**：装完 venv 后把 site-packages 包清单落表（上表格式），供新会话/排障直接查。
3. **模型体积/来源**：整仓全量动态清单（ModelScope API 实测字节），元数据文件豁免（036 §五）。
4. 表内容变化时更新日期；**登记不全的引擎 = 未完成接入**（不许以"装完=完成"收工）。

---

---

## 八、铁律（py 引擎开发/排障全程）

1. **App 内闭环**：UI 优先、用户点击触发；能在 App 内做的绝不让用户手动跑命令（000 第 7 条）。
2. **大流量二次确认**：>1GB 一律 `BIG_DOWNLOAD_CONFIRM`，前端确认行独立渲染（坑 A/B）。
3. **可见即验收**：每个按钮点击必须有确认行/进度/错误日志；"晃一下" = bug。
4. **不静默、不吞错**：所有失败原因打日志；NDJSON error 行 → 前端必须抛错（坑 A）。
5. **防空壳**：venv 就绪 = 关键包在（坑 J）；torch 加速必须校验 `+cu` / `mps`（坑 E/G）。
6. **uv 三坑**：venv 用 `--clear`（坑 C）；换包必须 `--reinstall-package` 或走本地 wheel（坑 N）；成功必须 `resolve()`（坑 D）。
7. **镜像真因**：PEP 503 vs 平铺目录、`&#43;` 编码、探测先行、失败原因可见（坑 O）——**"用错镜像地址导致找错目录/404"是全链路最烧 token 的傻逼坑**，任何镜像 URL 必须实测目录页确认，禁止照抄他源格式。
8. **文件锁**：升级 torch 前自动停占用引擎（坑 P）；curl 一律 `-sS`（坑 Q）。
9. **服务端改动=重启服务生效；前端/Rust=重建 exe**（坑 M）。
10. **新引擎三件套**：INSTALLERS + engines/*.json checks/runtime/install **齐了才算接好**；缺一个 = 点按钮 400"未知模型"（坑 H）。
11. **跨平台 venv 路径**：Win=`Scripts/python.exe`、Unix=`bin/python3`，一律走 `venvPyOf/venvDirOf` 封装，禁止手写（坑 L）。
12. 不执行 git 写操作；不杀非 App 进程；每步停下汇报等用户确认。
13. **模型权重 = 整仓全量下载**，禁止自造"必需子集"；真要标"可选"必须 grep 代码+配置验证零引用（§五；BlankEN 误标 = 翻车一天）。
14. **改任何文件：先 read 再 edit**，禁止盲改（本会话多次盲改失败返工——先读、再改、改后校验）。

---

## 九、IndexTTS 部署定档（040 独立部署成功后的权威口径 · 2026-08-30）

> 目标：把「怎么装 IndexTTS」从 035/038 的旧认知（pip install index-tts --all-extras / Apache-2.0 / 裁剪 vendor）**全部纠正为实测验证过的口径**，App 接入按 041 执行，不再踩 035 §七 的七连坑。

1. **官方安装口径（README 原文，一字未改）**：`git clone` → `pip install -U uv` → `uv sync --all-extras`（Windows 去 all-extras 跳过 DeepSpeed）→ `hf download IndexTeam/IndexTTS-2.5 --local-dir=checkpoints` 或 `modelscope download` → `uv run tools/gpu_check.py`。
2. **torch 来源**：pyproject `[tool.uv.sources]` 把 torch/torchaudio/torchvision 钉到命名索引 `pytorch-cuda`（url=`download.pytorch.org/whl/cu128`，explicit）→ **必须 `uv sync`（或等价 uv pip + 显式 index），不能裸 pip install -e .**（pip 会拿 PyPI 的 CPU 版 torch）。
3. **锁文件**：仓库自带官方 `uv.lock`（torch 2.8.0+cu128 win32 已解好）→ **用锁、只换注册源主机（官方→镜像），`--frozen` 安装**；**禁止重新 `uv lock`**（非当前平台环境必撞 accel/flash-attn 冲突）。
4. **国内源（040 实测速度）**：PyPI 依赖 → aliyun 11MB/s（README 镜像命令同属）；torch cu128 → aliyun `pytorch-wheels/cu128`（平铺目录，2-6MB/s）；模型 → modelscope 8.8MB/s（hf-mirror 兜底）。官方源仅兜底（90-330KB/s）。
5. **模型形态**：整仓 5.23GB/26 文件 + **首次运行自动补齐辅助四件套**（w2v-bert-2.0、MaskGCT codec、CAMPPlus、BigVGAN，落 `<model_dir>/hf_cache/`，官方代码自动择源：modelscope 优先 → hf-mirror 兜底）→ 总 10.4GB。**App 集成必须预下载辅助四件套**（036 坑 F 反模式禁止，见 041）。
6. **就绪判定（防空壳）**：关键包 `indextts` 在 + `import indextts.infer_v2_5` 探针（裁剪版缺此模块=不可用，035 §7.1 坑 1）。
7. **性能基线（基座无 extras，4070 Ti 实测）**：装载 15.7s；GPT 12s；**s2mel 462s（RTF≈108）**；提速 = accel extra（flash-attn/triton-windows）+ `use_bf16=True`。
8. **许可（实测纠错）**：pyproject `license = "LicenseRef-Bilibili-IndexTTS"` + 仓库 LICENSE/INDEX_MODEL_LICENSE → **不是 Apache-2.0**；商用前必须读许可原文。

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-28 | 初版：以 qwen3tts 全链路为范本（①Python 基础 ②venv ③CUDA 升级 ④模型 ⑤重启 ⑥运行），三种用户统一体验、六层顺序、驱动/cu 门槛、升级五连坑防复发清单、sensevoice/cosyvoice 照抄清单；配套 000 最高原则第 7 条 + `accelTag` GPU/CPU 徽标 |
| 2026-08-28 | 补充：① 坑覆盖核对——补铁律 10/11（坑 H 三件套、坑 L 跨平台 venv 路径）与「镜像用错地址=最烧 token 的傻逼坑（坑 O）」显式警示；② 新增 §7.2 规划引擎（IndexTTS2.5 / FishAudio S2 / Fish-Speech 1.5）——统一结论：**都走 venv+CUDA 同一范式**（IndexTTS2.5 0.8B ✅、Fish-Speech1.5 1.2B ✅、FishAudio S2 4B 本机 12GB 显存不够需 ≥24GB 或 GGUF 降档），执行前按 007 §3.4 实测登记；③ 标注外部对话坑待并入机制 |
| 2026-08-28 | §7.2 更正目标三模型（用户确认）：**CosyVoice（§7.1 在办，先做）/ IndexTTS-2.5 / Fish Audio**——fish-speech 已更名 fish audio，并入一行；最新为 **S2.1 Pro**（2026，API/实时对话，本地权重待验证）；§7.2 由"规划暂不执行"改为"开始执行" |
| 2026-08-28 | cosyvoice 实机（Windows+4070Ti）三坑：① **镜像**：权重下载新增 modelscope 首选（`FunAudioLLM/Fun-CosyVoice3-0.5B-2512` 六必需权重字节与 HF 全一致 + Range 206 续传，已实测登记进 cvWeightSpec；hf-mirror 偶发 <20KB/s 判死换源）；② **坑 L 同族**：修复 engineReadiness 误把非 venv runtime 项（vendor 源码路径）当 venv 防空壳检查 → 权重+venv+源码全就绪仍误报「缺环境」（按路径首段 `.venv-*` 判定）；③ **坑 I 扩展**：requirements-cosyvoice.lock 又漏 onnxruntime（frontend.py import 崩 → 8003 秒退、UI 无限「启动中」）/ omegaconf / librosa / soundfile / unidecode——补锁（onnxruntime==1.24.4 兼容 numpy 2.4.6；官方 1.18.0 只配 numpy<2）+ 安装器补装清单化（逐个查 site-packages 缺则 uv 补装）。另发现 .venv-funasr 缺 numpy → 8002 也崩（下阶段处理） |
| 2026-08-28 | cosyvoice 实机续：④ 防空壳检查宽容化 `venvPkgPresent`（soundfile 0.14.0 以 soundfile.py 单文件模块安装，纯目录判定误报缺失）；⑤ **模型必需清单补全**：S4 误判 `CosyVoice-BlankEN/` 非必需（约 0.99GB）——llm/llm.py `Qwen2ForCausalLM.from_pretrained(<model_dir>/CosyVoice-BlankEN)` 加载 LLM 主干，缺 config.json/model.safetensors → HFValidationError → 8003 秒退；扩展 CV_WEIGHTS + engines json checks（字节来自 ModelScope 实录），安装器 keyFiles 改为由 CV_WEIGHTS 键派生（防新增文件漏下） |
| 2026-08-28 | cosyvoice 收口（血泪定档）：⑥ **下载策略改版——整仓全量**（ModelScope Fun-CosyVoice3-0.5B-2512 共 19 文件、字节实录，含 llm.rl.pt / fp32.onnx / batch.onnx 原"可选"），废除"必需子集+缺啥补啥"（打地鼠一天）；⑦ **vendor 修复**：Matcha-TTS 缺 matcha/models（S4 漏拷，flow/decoder import 崩）→ jsdelivr 枚举全量补齐 + venv import 校验；⑧ **源头实测表**落入 §五（hf-mirror/modelscope/jsdelivr/清华 PyPI ✅；huggingface/github 直连 ❌ 被墙；gitee ⚠️ 无可用镜像）；⑨ **容量口径**：运行必需 5.05GB vs 整仓 9.1GB（llm.rl.pt 代码零引用）；⑩ §八 新增铁律 13（整仓全量/可选须 grep 验证）、14（先 read 再 edit） |
| 2026-08-28 | cosyvoice 下载再定档（用户追问"仓库变动怎么办/怎么验证"）：⑪ **清单动态化**（安装时拉 ModelScope repo/files API，仓库变动自动跟随；静态登记仅兜底）+ **元数据豁免**（.gitattributes/README.md/asset 镜像间必然不同，不校验不下载）+ **字节不符=失败**（自动换镜像重下一次，杜绝假完成）+ **hash 校验待办**（ModelScope md5 字段待实测，可用后升级）；⑫ matcha 修复加逐文件进度日志（防"卡住无感知"） |
| 2026-08-28 | ⑬ **matcha/models 已作为源码 vendoring 落入仓库**（jsdelivr 官方源 8 文件，随包分发；安装器修复步骤成为兜底不再必需），干跑验证 `BASECFM/SinusoidalPosEmb/BasicTransformerBlock + cosyvoice boot chain` 全绿；⑭ 新增 **§〇·补 引擎部署正确逻辑（官方口径定档）**：每引擎按官方 README 部署（CosyVoice `pip install -r requirements.txt` / IndexTTS `pip install index-tts --all-extras` / Fish 云端 compat/v1），**CPU 版一律可装可用（慢是特性）**、N 卡一键升 CUDA —— 不因无加速器拒绝安装 |
| 2026-08-29 | **cosyvoice CPU 版收工**（8003 出声）；坑全记录 → **037**（10 坑 + 与 qwen3 重复度：6/10 同根、坑 I 完全重复）；三连规划 → **038**（cosyvoice GPU §四 分支 / IndexTTS-2.5+2 官方 index-tts 口径 / FishAudio S2.1 Pro 云端 compat/v1 定案） |
| 2026-08-29 | 新增 **§七·补 引擎依赖/体积实测登记总表**（响应 IndexTTS 接入踩坑 R/S）：每引擎强制登记"关键包/extras（wheel METADATA 实测）/依赖清单（venv site-packages 实测摘要）/模型体积来源"，禁止 fetch pypi.org JSON API（坑 S）与猜官方 `--all-extras`（坑 R）；登记不全 = 未完成接入 |