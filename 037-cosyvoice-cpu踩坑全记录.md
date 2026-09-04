# 037 · CosyVoice CPU 版踩坑全记录（2026-08-29 收工 · 与 qwen3 坑账重复度对照）

> 目的：cosyvoice CPU 版终于跑通（App 内：权重全量下载 → 依赖补全 → vendor 修复 → 8003 加载 → 克隆出声）。
> 本文档把当天所有坑（按时间线）逐一登记：症状 → 根因 → 修复 → 与既有坑账本的重复度 → 防复发。
> 关联：035（qwen3 成功范例，本文对照基准）、036（全链路规范）、000-install §四（坑账本 A~Q+）。
> 全部为**实测事实**（2026-08-29 Win 本机 4070Ti），勿重查。

---

## 〇、最终结论（一句话）

**cosyvoice CPU 版 = 模型整仓全量下载 + 锁文件依赖补全 + vendor matcha 补齐，三件事做完就通。**
耗时大头的根因只有一个家族：**"省流量/省事"的自造清单（必需子集、锁文件手筛、vendor 漏拷）——每个都省出了新坑**。

---

## 一、踩坑时间线（按发生顺序）

| # | 症状 | 根因 | 修复 | 是否与 qwen3/既有坑重复 |
|---|---|---|---|---|
| 1 | 权重下载 hf-mirror 低速判死、huggingface 直连超时 | 国内网络镜像问题（意料中） | 新增 **ModelScope 首选镜像**（实测 1.6MB/s+、Range 206 续传、字节与 HF 一致） | ⚠️ **坑 O 同族重复**（镜像真因/换源）——既往经验没防住，因没登记"Alibaba 系模型走 modelscope" |
| 2 | 权重下完 UI 仍报「缺环境」 | engineReadiness 把非 venv runtime 路径项（vendor 源码）误当 venv 防空壳查（`venvs/vendor` 必缺） | 按路径首段 `.venv-*` 判定是否 venv 项 | ❌ **坑 J/L 家族新变体**（防空壳判定不精确） |
| 3 | 8003 秒退：`import onnxruntime` 崩 | **requirements-cosyvoice.lock 漏 onnxruntime/omegaconf/librosa/soundfile/unidecode**（Mac freeze 时"系统碰巧有"的没进锁） | 补锁 + 安装器补装清单化（逐个查 site-packages，缺则 App 内 uv 补装） | 🔴 **坑 I 完全重复（第二次！）**——坑 I 就是"cosyvoice 旧 lock 漏 modelscope → 8003 秒退"，同根同源又踩一次 |
| 4 | 补装报「仍缺 soundfile」 | soundfile 0.14.0 以**单文件模块 `soundfile.py`** 安装，无目录 → 防空壳目录判定误报 | `venvPkgPresent`：目录 / 单文件模块 / dist-info 任一命中即已装 | ❌ 坑 J 家族新变体 |
| 5 | 8003 秒退：`HFValidationError ... CosyVoice-BlankEN` | **S4 自造"必需清单"漏了 `CosyVoice-BlankEN/*`**（LLM 主干，`from_pretrained` 加载必需） | 清单 → 整仓全量（19 文件，字节实录，keyFiles 由清单派生） | 🔴 **坑 F/K 家族新严重变体**：清单错误漏缺 → 加载才炸。根因=自造必需清单 |
| 6 | 8003 秒退：`pydoc ErrorDuringImport: No module named 'matcha.models'` | **vendor 的 Matcha-TTS 漏拷 `matcha/models`**（S4 vendoring 只拷了 hifigan/text/utils） | matcha/models 从官方源（jsdelivr）**作为源码 vendoring 落进仓库**，随包分发；安装器留兜底修复 | ❌ 新坑：vendor 完整性（与模型清单同族"漏拷"） |
| 7 | `.gitattributes 大小不符 1574 vs 2572`、README 不符 | 元数据/展示文件在镜像间**本来就不同**，却被放进字节校验清单 | **元数据豁免**：`.gitattributes / README.md / asset/*` 不下载不校验；清单动态化 | ❌ 新坑（元数据文件不该进字节校验） |
| 8 | 「47 B / 47 B」进度冻结 5 分钟 | 下载全完成后，matcha 修复步骤无进度事件 → 进度条停在最后一个 47B 小文件 | matcha 修复加逐文件进度日志（每 5 个/完成打一行） | ⚠️ 坑 O/P 家族（进度可见性） |
| 9 | 「启动中」无限等、卡片无任何按钮可点 | state=ready 但服务应启动未健康 → UI 只渲染"启动中"，`检测/修复` 只在缺文件/缺环境态出现 → **用户无路径** | 服务端：缺运行时依赖如实报「缺环境」出按钮（venvPkgPresent 判定） | ⚠️ **坑 A/B/F 家族重复**（按钮/反馈 UX"无入口"） |
| 10 | 升级 GPU 按钮点了不升级（空壳） | cosyvoice 自定义安装器**没实现 §四 CUDA 升级分支**（036 §7.1 写"同"但代码没有） | 登记 038：cosyvoice GPU 版规划（复用 §四 全套） | ⚠️ **坑 E 家族**（CUDA 升级流程未全覆盖） |

---

## 二、与 qwen3（035 / 000-install 坑账）重复度对照

| 坑账编号 | 名称 | 今天是否再踩 | 说明 |
|---|---|---|---|
| 坑 A/B/F | 确认行/按钮/安装器 UX | ✅ 重复（#9，#2 关联） | 老问题换皮：这一次是"ready 态没按钮、启动中死等" |
| 坑 C/D | uv venv 建不出/不 resolve | ❌ 未踩 | 已有 --clear / resolve 修复生效 |
| 坑 E/G | CPU torch / 驱动门槛 / 升级 | ⚠️ #10 空壳 | CUDA 升级分支没接到 cosyvoice 安装器 |
| 坑 I | 锁文件漏依赖 → 8003 秒退 | 🔴 **完全重复（#3）** | 同一引擎第二次踩同根坑：**锁要按官方 requirements 全录，不许"系统碰巧有"** |
| 坑 J/L | 防空壳假就绪 / venv 路径形态 | ⚠️ #2/#4 变体 | 判定不精确的两个新变体 |
| 坑 N | uv 秒跳 | ❌ 未踩 | 本地 wheel 安装路径天然规避 |
| 坑 O | 镜像/进度 | ⚠️ #1/#8 重复 | modelscope 镜像没早入账本 |
| 坑 P/Q | 文件锁 / curl 刷屏 | ❌ 未踩 | 已有修复生效 |
| 坑 K | 落盘路径不一致 | ❌ 直接未踩 | resolveData 一直对齐 |
| 坑 H/M | 三件套缺失 / 重建生效 | ⚠️ #10 | cosyvoice 的 CUDA 分支=三件套未齐的残留 |

**重复度结论：10 个坑里，与既往账本同根的占 6 个（A/B/F、E、I、J、L、O、P），其中坑 I 是 100% 重复、同引擎第二次踩。**
**新增的根因只有一个词：自造清单（必需子集 / 锁漏 / vendor 漏拷 / 元数据硬编码）→ #5/#6/#7/#10 全部源于此。**

---

## 三、防复发铁律（已并入 036 §五 / §八）

1. 模型下载：**整仓全量**（动态清单：安装时拉 ModelScope repo/files API，静态登记只兜底）；禁自造必需子集（036 铁律 13）。
2. 依赖锁：**按官方 requirements.txt 全录**，禁止"系统碰巧有就没写进锁"（坑 I 三连的教训）。
3. vendor：**完整性校验进安装器**（matcha/models 等 import 目标缺失 → 自动从 jsdelivr 补），且好做法是源码直接 vendoring 进仓库随包分发。
4. 校验：字节不符 = **失败**（自动换镜像重下一次），杜绝假完成；元数据文件不进校验。
5. 判定：防空壳既认目录也认单文件模块（venvPkgPresent）。
6. 可见性：任何长步骤必须有逐文件/分步进度日志；无按钮可点=设计 bug（坑 A/B/F）。

---

## 四、验收记录（2026-08-29）

- [x] 19 权重文件全量落盘，动态清单字节校验通过（含 llm.rl.pt 2.0GB）
- [x] venv 依赖补全（modelscope/onnxruntime/omegaconf/librosa/soundfile/unidecode）import 全绿
- [x] vendor matcha/models 就位，干跑 `BASECFM / SinusoidalPosEmb / BasicTransformerBlock + cosyvoice boot chain` 全绿
- [x] 8003 服务启动 → 模型加载 → **克隆出声（CPU）**

## 五、GPU 版升级段的坑（2026-08-29 续 · 自问自答三问）

### 5.1 又犯了哪些错
1. **坑 P 变体**：端口探测漏掉"加载中未监听/孤儿"的 venv python 进程（8003 存活却漏停）→ uv 升级 torch 报"拒绝访问"（_C.pyd 锁）；
2. **半成品 torch 态**：uv 装 torch 失败（.pyd 锁）可能留下 half-state（dist-info 异常）→ 后续 import 校验崩（`InvalidVersion: None`）；
3. **torchcodec 双坑（新）**：GPU 升级把 torchaudio 2.8→2.11，「load() 强制 torchcodec」→ 克隆加载参考音频崩；首轮修法（装 torchcodec==0.16.0）**没先查它在 Windows 还需要系统 FFmpeg full-shared DLL**（torchcodec README 明示）→ 装完仍崩，返工。

### 5.2 怎么解决
1. 端口停 + **按命令行枚举 venv python 停**（`cosyvoice-tts-server` / `.venv-cosyvoice`）+ uv 文件锁失败自动宽杀重试一次（asr-server.js）；
2. matcha import 校验挪到 CUDA 之后；CUDA 触发条件 = CPU 版 **或 torch dist-info 缺失（损坏）** → 升级即自愈；
3. **绕开 torchaudio.load**：vendor `file_utils.load_wav` 改 `soundfile` 直读（自带 libsndfile、零系统依赖），**撤销 torchcodec 依赖**；实测返回 (1,16000) float32，与 torchaudio.load 形状一致。

### 5.3 合理吗？安全吗？（自答）
- 坑 P 加强：合理（App 拉起子服务，坑 P 同逻辑）；安全（只匹配 python.exe 且命令行含 cosyvoice-tts-server/.venv-cosyvoice，不碰无关进程）。
- 半成品自愈：改进合理；**弱项 = 无独立 torch 完整性探针**（损坏态依赖升级动作触发重装）→ 已列 038 T3 待办。
- soundfile 直读：合理且更安全（无系统级依赖、可随包分发、CPU/GPU 同一路径）；覆盖范围已全仓扫过（运行时唯一 wav 读取点），若未来 vendor 更新引入新解码点须重扫。
- **流程反思**：① 升级大版本前没查该库的 OS 级依赖（torchcodec/FFmpeg 公开已知，该先查）；② 修法先"装依赖"而非"先扫调用面"→ 一次返工。两点已落入 038 预检规则 T1/T4。

## 六、IndexTTS 独立部署（040）中"老坑命中"对照（2026-08-30 补）

> 037 的防复发铁律在 IndexTTS 部署里全部应验/新增，登记如下（细节见 035 §七 / 036 §九 / 041）：

| 037 铁律 | IndexTTS 命中情况 |
|---|---|
| 1 整仓全量（禁自造清单） | ✅ 命中：**裁剪 vendor（jsdelivr 69 文件）就是"自造缩减"，缺 infer_v2_5/gpu_check → import 必炸**——与 037 #5（BlankEN 漏清单）同根 |
| 2 锁按官方全录 | ✅ 命中：IndexTTS **官方自带 uv.lock**，正确做法=直接用锁+换镜像主机；乱 re-lock 撞 accel 冲突（035 §7.1 坑 5） |
| 3 vendor 完整性 | ✅ 命中：裁剪 vendor 缺文件 = 037 #6 同族（vendor 漏拷） |
| 4 字节校验/元数据豁免 | ⚠️ 部分：模型走 modelscope 整仓（字节 OK）；元数据豁免逻辑沿用即可 |
| 5 防空壳（目录+单文件） | ✅ 新增变体：737 numba/沙箱缓存路径问题（`NUMBA_CACHE_DIR`），属"运行环境可写性"防空壳 |
| 6 进度可见 | ✅ 网络抖动导致 uv 静默冻结（0 连接）→ 必须 `-v` 日志定位 + 缓存续传重跑（035 §7.1 坑 7） |

**一句话**：037 的全部教训在 IndexTTS 上是"提前踩"，且多出三个新坑（uv 缓存 ACL 损坏 / BOM 编码 / download-r2 变体）——详见 035 §7.1。

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-29 | 初版：cosyvoice CPU 版全程 10 坑 + 与 qwen3 重复度对照（6/10 同根，坑 I 完全重复）+ 防复发铁律 + 验收记录 |
| 2026-08-29 | §五续：GPU 升级段 3 坑（坑 P 变体 / 半成品 torch / torchcodec 双坑）+ 三问自答 + 流程反思（升级大版本先查 OS 级依赖、先扫解码调用面） |
| 2026-08-30 | §六补：IndexTTS 独立部署（040）老坑命中对照——037 教训全部应验（尤其"自造缩减=致命"），新坑登记于 035 §7.1 |