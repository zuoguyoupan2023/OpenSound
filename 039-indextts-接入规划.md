# 039 · IndexTTS-2.5 接入规划（研究定档 · 新会话接手必读）

> 目的：承接 038 §四 顺序 2（IndexTTS-2.5），在**动手写码前**完成 R0 研究关卡并把结论落档。
> 全篇为**已查证事实**（官方文档 web 查证 2026-08-29 + 本机代码/磁盘只读实测）；标注「待实测」的项 = 我的执行沙箱无外网、无法替你拉取，须由**你在 App 内点击触发安装时动态获取/回填**（038 R0 允许：动态清单优先，静态登记仅兜底）。
> 关联：038（三连规划 + R0~R5 + T1~T4）、036（全链路规范 + 铁律）、037（cosyvoice 全坑）、035（qwen3 范本）、001（跨平台：IndexTTS Win CUDA 最顺）。

---

## 〇、已拍板决策（用户确认，2026-08-29）

| # | 决策 | 内容 |
|---|---|---|
| D1 | **GPU 直装 CUDA** | IndexTTS venv 建好后若检测到 N 卡 → **直接装 CUDA 版 torch**（复用已验证的 wheel 探测+下载+本地安装链路），一步到位；无 N 卡才装 CPU 版。不复用 qwen3/cosyvoice 的"先 CPU 后升级"两步走 |
| D2 | **先接 IndexTTS，公共 torch 层单独下一阶段** | 本阶段 IndexTTS 用独立 venv（`.venv-indextts`），wheel 缓存复用（cache/torch-wheels 实测仍在，零下载）；「公共 torch（受管 CPython 层 + --system-site-packages）+ 私有覆盖」方案作为下一独立阶段立项，不与新引擎混做 |
| D3 | **torch 共享问题答用户**（已答，结论存档） | ①每引擎 venv 各装一份 torch 是隔离架构固有行为（防坑 I 依赖打架）；②Mac 不麻烦 = MPS 内建单一变体，Win 麻烦 = CPU/CUDA 双变体 + 驱动门槛 + 镜像结构（坑 O/N/P）；③公共 torch 层技术上可行且是 Python 标准做法，代价 = 防空壳判定改查两层 + 坑 I 家族掩盖风险 → 单独立项 |

---

## 一、代码现状（本机只读实测，2026-08-29）

### 已存在
- `asr-server/indextts-tts-server.py`（2026-08-27）：8004 端口、ZH 默认、`from indextts.infer_v2_5 import IndexTTS2`、voice=克隆音色 id（`data/clone-voices/<id>/ref.wav`，与 cosyvoice 同结构）、设备自动检测（CUDA→XPU→MPS→CPU）、推理串行化 RLock。
  - ⚠️ 其依赖注释写 `vendor/index-tts`（uv sync 安装）——**vendor/index-tts 当前不存在**（vendor 下只有 cosyvoice）。接入方式定为：**venv 内 `uv pip install index-tts`（官方 PyPI 包），sys.path.insert 仅是无害兜底**；装包后本地即有包源码，可做 T1 解码调用面扫描。
- `asr-server/test-indextts.py`：临时首测脚本（use_bf16=True，MPS 注释；接入服务后按 038 惯例可随代码清理）。

### 缺失（= 本轮全部工作，038 §二 三件套）
- `engines/indextts.json`：**缺**（模型页卡片由 /models 驱动的 ENGINE_MANIFESTS 自动渲染，一加即出现）
- `INSTALLERS['indextts']`：**缺**（点「检测/修复」目前只会 400 未知模型，坑 H）
- `VENV_KEY_PKG['indextts']`：**缺**（关键包 = `indextts`，防空壳判定，坑 J）
- `start-all.js` 8004 拉起：**缺**（现只有 8001/8002/8003）
- `asr-server.js` `/speak` 转发 engine=indextts + `TTS_ENGINES` 注册：**缺**（文件头 L571 注释预留：新增引擎只需注册 stream+wav）
- 前端朗读/聊天面板引擎选项：目前硬编码 `kokoro | qwen3 | clone`（api.ts L247/313、ChatPanel、ReadPanel）——**属阶段 D**，本轮不做（D2 定案先服务端）

### torch 现状（本机磁盘实测）
- `.venv-qwen3`：torch 2.11.0+cu128（CUDA）· 4.8GB
- `.venv-cosyvoice`：torch 2.11.0+cu128（CUDA）· 5.6GB
- `.venv-funasr`：无 torch（空壳）
- `cache/torch-wheels/torch-2.11.0+cu128-cp311-cp311-win_amd64.whl`（2.56GB）+ torchaudio **仍在** → IndexTTS 直装 CUDA 可**复用缓存 wheel，零下载、秒装**（038 §一 第 3 条机制）

---

## 二、官方口径（web 查证 2026-08-29）

| 项 | 结论 | 来源 |
|---|---|---|
| 安装 | `pip install index-tts --all-extras` | [IndexTeam/IndexTTS-2.5 模型卡](https://huggingface.co/IndexTeam/IndexTTS-2.5)、[index-tts GitHub](https://github.com/index-tts/index-tts) |
| 生产部署 | vLLM recipes 可用（`recipes.vllm.ai/IndexTeam/IndexTTS-2.5`） | [vLLM recipes](https://recipes.vllm.ai/IndexTeam/IndexTTS-2.5) |
| 双版本 | 2.5 = 0.8B（主做）；2 = 1.5B（辅，同 `index-tts` 包、不同模型仓） | 038 §二 |
| 模型体积 | ~5.5GB 级（**具体字节**待实测登记）；辅助四件套（w2v-bert-2.0 / MaskGCT codec / CAMPPlus / BigVGAN）由包**首次推理自动下载** ← 坑 F 反模式 | 038 预检清单 + 本机 indextts-tts-server.py 注释 |
| 许可 | Apache-2.0（**以官方 LICENSE 文件为准**，待验证） | 038 §二 |
| 显存 | 0.8B 显存友好（社区称 6G 可跑） | [cnblogs 部署分享](https://www.cnblogs.com/zhikes/p/18808551) |

### Windows 已知坑（他人经验，web 查证）——与 036/037 坑账同族，**T1 预检必须覆盖**

| 坑 | 说明 | 来源 |
|---|---|---|
| **中文文本归一化** | index-tts 依赖 pynini/WeTextProcessing（`tn` 模块），Windows **无预编译 wheel** → MSVC 编译 `_pywrapfst` 报错（Microsoft Visual C++ 14.0 required） | [Issue #44](https://github.com/index-tts/index-tts/issues/44)、[Issue #61 pynini](https://github.com/index-tts/index-tts/issues/61)、[Issue #36 tn 缺失](https://github.com/billwuhao/ComfyUI_IndexTTS/issues/36) |
| **官方/社区解法** | **wetext**（Rust 实现替代，免 MSVC 免 pynini）——Windows 安装指南 | [Issue #150 wetext for windows](https://github.com/index-tts/index-tts/issues/150) |
| 中文避坑贴 | 部署细节与踩坑（含多音字/WeTextProcessing） | [技术栈指南](https://jishuzhan.net/article/2092967678068314113)、[CSDN WIN部署](https://blog.csdn.net/name_liu_pu/article/details/148502450)、[CSDN WeTextProcessing 编译失败解决](https://blog.csdn.net/TonyNotes/article/details/146958395) |

**定档**：Windows 上 index-tts 的文本归一化链路是**本引擎最大未知数**（037 5.1-3 教训：升级大版本前先查 OS 级依赖 + 先扫调用面）。**T1 扫描必须包含**：包内 `tn / pynini / wetext / WeTextProcessing` 的 import 与调用点；若官方包在 Win 上依赖 pynini 编译 → 按 Issue #150 换 wetext 或在 venv 内预装可用替代，绝不能把 MSVC 编译甩给用户（铁律 E）。

---

## 三、「待实测」清单（安装时动态获取，不猜不写死）

> 038 R0 允许：清单动态化（安装时拉官方 repo files API），静态登记仅兜底。以下各项由用户在 App 内点「检测/修复」首次安装时触发实测，结果回填本节 + engines/indextts.json。

1. **`index-tts` 包真实依赖清单**：win_amd64 cp311 下 `uv pip install index-tts --all-extras` 的实际解析结果（PyPI 元数据为准，装完 freeze 出 `requirements-indextts.lock` 回填 036 坑 I 教训）
2. **`infer_v2_5` 模块与 IndexTTS2 API 匹配**：当前 PyPI 版的 `indextts.infer_v2_5.IndexTTS2(cfg_path, model_dir, use_bf16, device)` 与 indextts-tts-server.py 的调用是否吻合（不吻合则以装到的版本签名改 server.py）
3. **模型整仓清单**：IndexTeam/IndexTTS-2.5（ModelScope 首选，hf-mirror 兜底）repo files API 的 Path+Size 动态清单 → 落 engines/indextts.json checks
4. **辅助模型四件套来源/路径**：装包后 grep 包源码确认 w2v-bert-2.0 / MaskGCT codec / CAMPPlus / BigVGAN 各自的 HF repo 名与本地落盘路径（HF_HOME=models/hf 对齐坑 K）→ **改为 App 内预下载 + 二次确认 + 字节登记**（消灭"首次推理自动下载"坑 F 反模式）
5. **解码调用面 T1 扫描**：grep 包内 `torchaudio.load / load_with_torchcodec / soundfile / librosa / ffmpeg / tn / pynini` 调用点，登记结论（037 T1：解码优先自带解码器库，不依赖系统 FFmpeg、不引 torchcodec）
6. **CUDA 直装分支实测**：uvVenvInstaller 新增「N 卡首次直装 CUDA」分支后，装 `.venv-indextts` 全程日志 + 校验 `torchBuildTag` 含 `+cu`（复用 torch-wheels 缓存 → 若命中则零下载）

---

## 四、执行阶段（每阶段完成停下汇报，等用户确认再进下一阶段）

| 阶段 | 内容 | 生效方式 | 验收 |
|---|---|---|---|
| **A 服务端三件套** | `engines/indextts.json`（动态清单 checks + runtime + profile：accel CUDA / slowNote CPU）+ `VENV_KEY_PKG['indextts']='indextts'` + `INSTALLERS['indextts']`（复用 `uvVenvInstaller`，加 D1 CUDA 直装分支）+ start-all 8004 + `/speak` 转发 + `TTS_ENGINES['indextts']` 注册 | 重启服务即生效 | 模型卡出现 IndexTTS；点「检测/修复」→ 确认行 → 进度可见 → `.venv-indextts` 就绪（关键包在） |
| **B 模型补齐** | 安装时 ModelScope 动态清单 → 缺失走二次确认 + downloadOneFile（modelscope→hf-mirror）；辅助四件套改预下载（T1 后登记字节）；装完 import 校验 | 重启服务即生效 | 模型文件全绿；8004 活 → 用现有克隆音色 POST /speak 出声 |
| **C GPU 验证** | 驱动→cu 目录自动选（616.56→cu128）；wheel 缓存复用；装后 `torchBuildTag` 含 +cu；徽标 CUDA 绿 | 重启服务即生效 | /models accelTag=CUDA cu128；实测 RTF/冷启动登记 |
| **D 前端可见（下一轮，D2 定案本轮不做）** | 朗读/聊天面板引擎选项加 indextts（api.ts 类型 + ChatPanel/ReadPanel） | 需重建 exe（坑 M） | 朗读面板可选 IndexTTS → 克隆音色出声 |

## 五、防复发清单（036 §八 / 037 对照，接入时逐条核对）

1. 三件套齐（engines json + INSTALLERS + start-all 8004 + /speak 转发）缺一个 = 400 未知模型（坑 H）
2. 防空壳：venv 就绪 = `indextts` 关键包在 site-packages（venvPkgPresent 宽容版，坑 J/L）
3. 依赖锁：装完 freeze `requirements-indextts.lock`，按官方 requirements 全录（坑 I 三连）
4. 大流量（>1GB）二次确认；前端确认行独立渲染（坑 A/B）
5. 模型整仓全量 + 动态清单 + 元数据豁免 + 字节不符即失败（坑 F/K + 铁律 13）
6. 镜像探测先行、失败原因落日志、禁吞错（坑 O）
7. 升级/安装 torch 前自动停占用引擎（坑 P）；curl 一律 -sS（坑 Q）
8. venv 路径走 venvPyOf/venvDirOf、uv venv 用 --clear（坑 C/L）
9. 每步可见（确认行/进度/错误日志），"晃一下"=bug（坑 A/B/F）
10. **T1 解码+文本归一化调用面扫描**（本引擎特有：pynini/wetext，见 §二）

---

## 五·A 阶段 A 实测修正记录（2026-08-29，全 App 内实测——新会话接手必读）

> 阶段 A 接入过程中连踩 3 坑，全部已修复并登记 000-install §四（坑 R/S/T）与 036 §七·补 实测登记总表。**结论先行：extras 名单必须走"清华 simple index 下载 wheel → 读 METADATA"，禁止 fetch pypi.org/猜官方命令。**

| # | 症状 | 根因 | 修复 | 坑号 |
|---|---|---|---|---|
| 1 | `uv pip install index-tts --all-extras` 报 `Requesting extras requires a pylock.toml/pyproject...` | **uv 的 `--all-extras` 只对本地项目生效**，远程包必须 `package[extra]` 语法 | 改用 uv `package[extra]` 语法 + 动态解析 extras | 坑 R |
| 2 | 改走 venv 内 `pip install ... --all-extras` 报 `no such option: --all-extras` | **pip 根本没这个选项**——官方 README 那行命令是文档 bug | 彻底弃用 `--all-extras`，回到 uv `package[extra]` | 坑 R |
| 3 | fetch `pypi.org/pypi/index-tts/json` 解析 extras → **安装无声卡死**（日志停在"跳过 venv 重建…"） | pypi.org 国内直连被墙黑洞，fetch 挂死无超时输出 | 弃用 pypi.org；改清华 `pypi.tuna.tsinghua.edu.cn/pypi/index-tts/json` → **仍 404**（清华无 JSON API）→ 终版：**清华 simple index 下载 wheel + adm-zip 读 `Provides-Extra:`** | 坑 S |
| 4 | 每次重试 `uv venv --clear` 重装整套 torch | 上次失败残留（venv 已建好+torch CUDA 就绪）无需重建 | uvVenvInstaller 加"venv 残留跳过"分支（跳过重建，直接补装引擎包） | — |
| 5 | "跳过 venv 重建"分支后**再无任何输出**（不报错不 done） | if/else 结构错误：**「安装引擎依赖」代码被留在 else 块内**，条件为真时整个 else 被跳过、函数直接结束 | `if (!(venvAlready && torchCudaOk))` 只包"创建 venv + CUDA 直装"，安装依赖/校验/done 移到 if 外共用 | 坑 T |

**阶段 A 当前状态（2026-08-29）**：`.venv-indextts` 已有 21 包（torch 2.11.0+cu128 ✓、torchaudio ✓、pip/setuptools ✓）——**CUDA torch 直装已成功，只差 `index-tts` 本体 + extras**。extras 解析器终版 = 清华 simple `https://pypi.tuna.tsinghua.edu.cn/simple/index-tts/` → 正则解析最新 wheel URL → downloadOneFile 下载（真实进度+缓存）→ adm-zip 读 `*.dist-info/METADATA` 的 `Provides-Extra:` 行 → `uv pip install "index-tts[e1,e2,...]"`。装完把 extras 名单 + 包清单回填 036 §七·补 总表（indextts 行）。

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-29 | 初版：R0 研究定档（代码缺口实测 + 官方口径 + Win 归一化坑 + 待实测清单 + 四阶段计划 + 防复发清单）；用户拍板 D1（GPU 直装 CUDA）/ D2（先接 IndexTTS，公共 torch 层单独立项） |
| 2026-08-29 | §五·A 阶段 A 实测修正记录：连踩坑 R/S/T（官方 `--all-extras` 文档 bug / pypi.org 被墙 fetch 挂死+清华无 JSON API / if-else 跳过分支静默缠结），全部修复并登记 000-install §四 与 036 §七·补；extras 解析终版 = 清华 simple + wheel METADATA 实测，回填登记表 |