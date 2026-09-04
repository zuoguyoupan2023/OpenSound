# 038 · 引擎三连规划：cosyvoice GPU 版 / FishAudio 最新 / IndexTTS 双版本（2026-08-29）

> ⚠️ **新会话接手必读（035 式入口）**：动手前先读 036（全链路规范 + 铁律 13/14）、037（cosyvoice 全坑 + 重复度对照）、本文件 §〇（R0~R5）、§〇·补（T1~T4）与 §二 开工预检清单——**先过研究关卡再动代码**。
> 范围：cosyvoice CPU 版已收工（037），下一步按 036 §7.2 顺序推进三个目标：**① cosyvoice GPU 版 ② IndexTTS-2.5（含 IndexTTS2） ③ FishAudio（最新 S2.1 Pro）**。
> 原则（036 §八 铁律 13/14 + §§五、〇·补）：**部署按官方 README 口径**；模型**整仓全量 + 动态清单**；CPU 可装可用、GPU 一键升级；App 内闭环、进度可见、字节不符即失败。
> 全部执行前按 007 §3.4 **实测登记**（下载源/字节/启用方式/依赖清单），禁止猜测。

---

## 〇、执行规则（最高要求 · 三引擎动手前必读 · 防 3000 万 token 事故重演）

> 本规划内任何引擎，**不满足以下规则不得动代码**。规则来源全部是已付过钱的教训：
> 037（cosyvoice 10 坑）、035（qwen3）、000-install §四（坑账 A~Q+）、036（铁律 13/14、§〇·补）、AGENTS.md（铁律 E）、本机全部实测。

### R0 动手前必查（研究关卡：先查后写，查完落文档才许写码）
1. 查坑账：000-install §四 A~Q+、036 §五/§八、037、035 → 新发现坑不回填文档不许继续；
2. 查官方：目标引擎**官方 README / 模型卡 / vLLM recipes**（链接登记在本表与 engines/*.json）——部署方式以官方为准，禁止自创套路；
3. 查他人：web 搜该模型公开部署经验/踩坑（Win/CUDA 常见坑先登记）；
4. 结论写进文档（实测登记：下载源、字节、启用方式、依赖清单）→ 才许写代码。

### R1 下载（防 037 坑 #1/#5/#6/#7）
- 模型 = **整仓全量 + 动态清单**（安装时拉官方 repo files API，Path+Size；静态登记仅兜底）；**禁自造必需子集**；
- 元数据文件（README.md/.gitattributes/asset/*）**不下载不校验**（镜像间必然不同）；
- 标"可选"必须先 grep 代码+配置**零引用**；
- **字节不符 = 失败**（自动换镜像重下一次，仍不符才报错）；hash（md5/sha）可用后升级；
- 大文件逐文件进度事件（防"进度冻结"假卡死）。

### R2 依赖与 vendor（防 037 坑 #3/#4/#6）
- 锁文件按**官方 requirements.txt 全录**（坑 I 三连的教训：不许"系统碰巧有就不写进锁"）；
- 防空壳判定用 **venvPkgPresent**（目录/单文件模块/dist-info 任一命中）；
- vendor 源码完整性进安装器校验（import 目标缺失自动从 jsdelivr 补），且**源码 vendoring 随包分发优先**。

### R3 App 内闭环（000 铁律一 / AGENTS 铁律 E —— 最高要求）
- **一切安装/下载/修复由用户在 App 界面点击触发**；禁止要求用户终端命令、手动删文件、改配置；
- **禁止 AI 代装**（pip/uv/写数据目录）；AI 只改代码 + 只读诊断；
- 生效方式写清：服务端改动=重启服务生效；前端/Rust=重建 exe（坑 M）——不让用户白等。

### R4 工程纪律
- **先 read 再 edit**（036 铁律 14）；小步分阶段、每步可见可验收（坑 A/B/F）；
- 三件套齐才算接好：engines/*.json（checks/runtime/install）+ INSTALLERS + start-all 端口 + /speak 转发（坑 H）；
- 每个引擎完成 = **徽标绿 + 实测出声/出字**（可见即验收），不许"装完=完成"。

### R5 禁止清单（违反即停，向用户说明）
不猜测；不列死清单；不省流量自造子集；不跳官方 requirements；不让用户手动操作；不代装；不盲改；不静默失败；不把"装完"当"能用"。

---

## 〇·补 T 预检 / 验收规则（GPU 升级与解码器预检 —— IndexTTS/Fish 动手前必做）

> 来源：037 §五（GPU 升级段 3 坑）。**升级 CUDA torch 会连带换 torch/torchaudio 大版本，是"隐藏依赖变更"的高危动作**，必须预检。

- **T1 解码调用面扫描（先做）**：升级 torch/torchaudio 大版本前，grep 目标引擎 vendor 全部 `torchaudio.load` / `load_with_torchcodec` / `soundfile` / `librosa` / `ffmpeg` 调用；解码优先选**自带解码器**的库（soundfile/libsndfile、librosa）——**不依赖系统 FFmpeg / 不引 torchcodec**（037 5.1-3：torchaudio 2.11 load() 强制 torchcodec，torchcodec 在 Win 又强制系统 FFmpeg full-shared DLL = 双坑）。
- **T2 升级即自愈**：CUDA 升级统一走 036 §四 + 坑 P 加强（端口停 + 按 venv 命令行停 + uv 文件锁失败自动宽杀重试）；torch dist-info 缺失（半成品）也触发升级；**可运行性 import 校验（如 matcha）必须放在升级之后**。
- **T3 torch 完整性独立探针（待做）**：损坏态不依赖"用户恰好在升级"——检测 dist-info 缺失 / `torch.__version__` 为 None / import 失败 → 自动重装（App 内）。
- **T4 分段验收**：新引擎先 **CPU 出声** → 再 **GPU 升级** → 再**复验出声**；每段可见、可回退（037 教训：升级后才暴露解码坑，隔离成本高、用户火大）。

### 同类问题会不会在 IndexTTS / Fish 重演（排查结论）
- **IndexTTS-2.5（本地 CUDA）**：若其音频读取也走 `torchaudio.load` / 系统 ffmpeg（index-tts 官方依赖含 librosa/soundfile，大概率安全，**但必须 T1 扫一遍确认**），升级 torch 后可能撞同类解码坑。→ **能避免，前提 = 开工第一件事做 T1 扫描 + 锁按官方 requirements 全录。**
- **FishAudio S2.1 Pro（云端 compat/v1）**：音频由播放端解码，无本地软件栈 → 不踩此类坑；本地路线（≥24GB / GGUF）按 T1~T4 另做预检。→ 本阶段不涉及。

---

## 一、CosyVoice GPU 版（承接 037 #10：升级按钮目前是空壳）

**现状**：CPU 版通了（8003 出声）；但 cosyvoice 自定义安装器**没有 §四 CUDA 升级分支**——卡片「升级 GPU 加速」点了只重跑安装器，不真升级（036 §7.1 表写"同"是文档没跟上代码）。

**方案（复用 036 §四 已验证全套，照抄 uvVenvInstaller 的 torchCpuHere 分支）**：

1. `HAS_NVIDIA && torchIsCpuOnly('.venv-cosyvoice')` → 触发升级路径；
2. `torchCuDirForDriver(NVIDIA_DRIVER)`（616.56 → cu128）；驱动过旧 → 明确报错；
3. **cache/torch-wheels 复用优先**：本机已缓存 `torch-2.11.0+cu128-cp311-cp311-win_amd64.whl`（2.6GB）+ torchaudio（1.59MB）→ **零下载秒装**；无缓存 → 二次确认 2.5GB → 镜像探测（阿里云/清华平铺 + 官方 simple，坑 O 结构）→ downloadOneFile 直下 → 本地安装；
4. 坑 P：升级前自动停 8001/8002/8003（.pyd 锁）；
5. `uv pip install --python <venvPy> <本地 wheel>` → 校验 `torchBuildTag` 含 `+cu` → 徽标 CUDA 绿；
6. done → 提示重启服务。

**验收**：徽标「CUDA cu128」绿色；冷启动 <1-2 分钟（vs CPU 5-15 分钟）；克隆 RTF 明显提升；GPU 升级后 CPU 用户路径不受影响（无 N 卡不出现按钮）。

---

## 二、IndexTTS-2.5（主）与 IndexTTS-2（辅）—— 官方口径：`pip install index-tts --all-extras`

**官方部署口径**（[IndexTeam/IndexTTS-2.5](https://huggingface.co/IndexTeam/IndexTTS-2.5)）：
- 安装：`pip install index-tts --all-extras`；CUDA Wheel 可用，**Win CUDA 最顺**（001 §跨平台）；vLLM recipes 可生产部署（[recipes.vllm.ai/IndexTeam/IndexTTS-2.5](https://recipes.vllm.ai/IndexTeam/IndexTTS-2.5)）；
- 双版本：**IndexTTS-2.5 = 0.8B（最新，主做）**；**IndexTTS-2 = 1.5B（上一代，辅）**——同一 `index-tts` 包，模型仓不同；
- 模型仓：`IndexTeam/IndexTTS-2.5`（~5.5GB 级）与 `IndexTeam/IndexTTS-2`；许可证 **Apache-2.0（以官方 LICENSE 文件为准，待验证）**。

**接入步骤（三件套，036 §七 部署范式 6 条）**：
0. **开工预检清单（2026-08-29 实测定稿，新会话先过此单再动码）**：
   - ✅ 模型镜像：ModelScope 已有 `IndexTeam/IndexTTS-2.5`（API 200 实测）→ 主镜像走 modelscope（hf-mirror 兜底）；
   - ⚠️ **辅助模型四件套（w2v-bert-2.0 / MaskGCT codec / CAMPPlus / BigVGAN）**：现有 `indextts-tts-server.py` 是"首次推理时自动下载"——这是 036 坑 F 反模式（缺模型靠运行时拉）→ **必须改为 App 内预下载 + 二次确认 + 字节登记**；
   - ⚠️ **无官方 lock**：`index-tts` 只有 requirements（无 lock）→ 用 uv pip compile 生成 lock 并按官方全录（坑 I 三连教训）；
   - ⚠️ **T1 解码调用面**：vendor/index-tts 拉入后先 grep 音频读取（官方依赖含 librosa/soundfile，大概率安全，但要眼见为实）；
   - ⚠️ CUDA torch：按 §〇 三型 / T4（先 CPU 出声 → 再 GPU 升级，复用 §四 + 坑 P 加强）；
   - ⚠️ 许可 Apache-2.0：以官方 LICENSE 文件为准（待验证）。
1. `indextts-tts-server.py` **已有**（读 vendor + cosyvoice 同款模式，8004，ZH 默认）；依赖声明写的是 `vendor/index-tts（uv sync 安装，Python 3.11）` + `checkpoints`；需把 `uv sync` 与受管 venv 对齐（`UV_PYTHON_INSTALL_DIR`/清华源），且**无官方 lock → 按官方 requirements 全录生成 lock**（预检清单项）；
2. `engines/indextts.json`（**缺**）：checks = 模型整仓全量动态清单 + runtime = `.venv-indextts` + vendor/index-tts 源码 + profile（diskGB/mem/accel CUDA/tier/slowNote：CPU 慢、MPS 不可用 bf16 注）；
3. `INSTALLERS['indextts']`（**缺**）：venv（uv sync 官方依赖）+ vendor 完整性 + 模型整仓全量下载（动态清单，modelscope 优先镜像，hf-mirror 兜底，字节不符即失败）；
4. `start-all.js` 拉起 8004（**缺**）；`asr-server.js /speak` 转发 engine=indextts（**缺**，参考 cosyvoice 转发段）；
5. 就绪判定入 `VENV_KEY_PKG`（`indextts`）+ `engineReadiness` extras（防空壳，venvPkgPresent）。

**验收**：卡片就绪 → 8004 活 → 克隆面板可选 IndexTTS → 参考音频 3-10s → 出声；Win CUDA 冷启动与 RTF 实测登记。

---

## 三、FishAudio（最新 = S2.1 Pro —— 按 007 §3.3 定案走云端，本地为观察项）

**官方口径**：
- 最新模型 **s2.1-pro**（2026：实时对话/TTS API）；上一代 s2-pro（4B）；产品线已从 fish-speech 更名为 fish audio（036 §7.2 已更正）。
- 许可 **FISH AUDIO RESEARCH LICENSE**：研究/非商用免费，**商用需书面授权**；走云端 API 按量付费不涉该许可。
- 本地权重：官方 BF16 ≈9.1GB 需 **NVIDIA ≥24GB**（本机 4070Ti 12GB 不够）；fp8 社区版 ~4.6GB 需 fp8 指令集；GGUF（s2.cpp）可 CPU/Vulkan/CUDA/Metal——**均为观察项**。

**接入步骤（云端，先通链路）**：
1. 007 §3.3 定案：复用现有 `cloud` TTS 引擎，`https://api.fish.audio/compat/v1`（OpenAI 兼容 POST /v1/audio/speech）；
2. 用 **`fish-audio/s2.1-pro-free`**（免费档，无生产延迟保证）先验证链路 → 再切 `fish-audio/s2.1-pro`（$15/百万 UTF-8 字节）；
3. **两个坑（007 已登记）**：① `voice` 必须是 Fish voice ID 或空串，OpenAI 预设名会 400；② `cloudTtsCall` 默认 `voice:'alloy'` 会静默命中真实 Fish 音色 → 接 S2 必须改默认值；
4. UI：云引擎配置页补 Fish model/voice 入口（KEY 复用现有云端 Key 逻辑）；
5. 本地路线：待 ≥24GB 硬件或 s2.cpp GGUF 成熟，届时按 §七 范式（非 python venv 系则单独起 s2.cpp server + 转发）。

**验收**：云端模型选择里出现 FishAudio → 出语音；免费档先通、再验付费档；许可提示如实展示。

---

## 四、执行顺序与依赖

| 顺序 | 任务 | 前置 | 产出 |
|---|---|---|---|
| 1 | cosyvoice GPU 版（§四 分支接入） | CPU 版已通（037） | 升级按钮真生效，徽标 CUDA 绿 |
| 2 | IndexTTS-2.5 三件套 | — | 8004 活、克隆出声、实测登记 |
| 3 | IndexTTS-2（1.5B 辅） | 2.5 通后复用 | 同框架双档 |
| 4 | FishAudio 云端 compat/v1 | 007 §3.3 | 云端链路活；本地观察项建档 |

**风险/待实测**：IndexTTS 官方依赖清单与 uv sync 的落地（`vendor/index-tts` 需要 vendoring 或 clone 兜底）；IndexTTS 双版本模型字节；Fish 免费档配额与延迟；S2.1 Pro 本地权重开源状态。

## 五、执行结果更新（2026-08-30 实测定档）

### 5.1 IndexTTS-2.5（§二）：✅ 独立部署已完成，官门口径被实测打脸/纠正

- **完成**：E:\Github\indextts2.5 独立部署全通（torch 2.8.0+cu128 / import infer_v2_5 / 模型 10.4GB / 出声），验收见 040 + 035 §7.3。
- **纠正三处旧认知**：① 官方安装口径是 **`git clone + uv sync`**（不是 036 旧表的 `pip install index-tts --all-extras`）；② 许可 **LicenseRef-Bilibili-IndexTTS（非 Apache-2.0）**；③ 辅助模型四件套**官方运行时自动下载**（modelscope→hf-mirror 自动择源）——App 侧必须预下载（041），036 坑 F 反模式。
- **新坑**（035 §7.1 七连坑）：裁剪 vendor 缺文件 / App uv 缓存 ACL 损坏 / OpenVPN 80KB 断流 / uv lock 不可重锁 / PowerShell BOM / download-r2 变体漏换。
- **性能基线**：s2mel 462s（RTF≈108）——不装 extras 的官方常态；提速=accel/bf16（041 待办）。

### 5.2 FishAudio S2.1 Pro（§三）：源实测结果（042 详案，此处结论先行）

| 项 | 实测结果（2026-08-30） |
|---|---|
| 官方仓库 | `github.com/fishaudio/fish-speech`（main 分支，32.4k★；api.github.com 可达，**git clone 直连被墙 21s 超时**；文件走 jsdelivr CDN ✅ 实测拉到 README） |
| 官方文档 | `speech.fish.audio/*`（直连超时 ❌；README 内链接同源，可用 jsdelivr 拉 README 读链接） |
| 云端 API | `api.fish.audio`（compat/v1 OpenAI 兼容；**本网络实测超时 ⚠️ 待代理网络验证**——038 §三 云端定案保持，接入前必须过这一步） |
| **S2.1 Pro 权重仓** | **HF 上不存在 `fishaudio/s2.1-pro` 仓库**（author=fishaudio 全量 50 个实测；全站 search s2.1 无命中）→ **S2.1 Pro = 云端 API 模型名（fishaudio/s2.1-pro），无公开本地权重** |
| HF 镜像可用的本地权重（hf-mirror 实测） | `fishaudio/s2-pro`（4B 本地，TTS，35.7 万下载；**需 ≥24GB 显存**，本机 12GB 不够）；`fishaudio/fish-speech-1.5`（上一代本地 1.2B 档，4070 Ti 可试本地路线） |
| PyPI 包 | `fish-speech` 在 aliyun/tuna 仅 0.1.0（占位级）→ **非官方常规分发渠道**；安装口径待官方 install 文档（不可直连时用 jsdelivr 拉 README 全文） |

**结论**：S2.1 Pro 走**云端 compat/v1**（038 §三 步骤不变）；本地路线本机只剩 **fish-speech-1.5（1.2B）** 可实际部署，s2-pro 挂"≥24GB 观察项"。详见 042。

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-29 | 初版：cosyvoice GPU（承接 037 #10）/ IndexTTS-2.5+2（官方 index-tts 口径）/ FishAudio S2.1 Pro（007 定案云端）三连规划，含执行顺序与实测登记清单 |
| 2026-08-29 | 新增 **§〇 执行规则（R0~R5，最高要求）**：研究关卡（查坑账/官方/他人→落文档再写码）+ 下载/依赖/闭环/工程纪律 + 禁止清单——三引擎动手前必读，防 3000 万 token 事故重演 |
| 2026-08-29 | 新增 **§〇·补 T 预检/验收规则（T1~T4）**：升级 CUDA torch 前必做解码调用面扫描（T1）、升级自愈与校验顺序（T2）、torch 完整性独立探针待做（T3）、CPU→GPU 分段验收（T4）；并给排查结论：IndexTTS-2.5 需开工先 T1 扫描解码面，FishAudio 云端无此类坑 |
| 2026-08-30 | 新增 §五：IndexTTS-2.5 独立部署完成 + 三处纠正（官方口径 uv sync / 许可非 Apache / 辅助模型自动下载）；FishAudio S2.1 Pro 源实测（HF 无 s2.1-pro 仓=云端模型名；本地仅 fish-speech-1.5 可选；api.fish.audio 待验证）→ 042 |