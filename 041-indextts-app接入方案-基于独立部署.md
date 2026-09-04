# 041 · IndexTTS App 接入方案（基于 040 独立部署实测定档）

> 目的：把 040 在 `E:\Github\indextts2.5` 验证通过的部署逻辑（官方 uv sync 语义 + 国内镜像 + 官方锁 + 全量模型）落进 App（asr-server），
> 让用户在模型页点「检测/修复」即得：venv + 模型 + 8004 服务 + 克隆出声。**全程 App 内闭环（000 铁律一 / AGENTS 铁律 E）。**
> 前置必读：040（官方 README 逐条对照）、035 §7（七连坑复盘）、036（全链路规范 §三§四§五§八、§九）、038 §五。
> 时间：2026-08-30 定稿。全部参考数据均为 040 本机实测（RTX 4070 Ti，直连+国内镜像）。

---

## 一、独立部署（040）已证明的正确口径（App 照抄，不许另发明）

| 环节 | 040 实测定案 | App 对应实现 |
|---|---|---|
| 源码 | 官方全量（71 文件，1.72MB）：pyproject + **官方 uv.lock** + indextts 全包 + tools/gpu_check.py；**裁剪 vendor（69 文件）缺 infer_v2_5 = 直接炸** | **第一步：全量替换 `asr-server/vendor/index-tts`**（jsdelivr 逐文件 / 官方 tar，随包分发） |
| uv | 全新独立 uv（`pip install uv`），**勿用 App 旧管理 uv（缓存 ACL 已损坏，035 §7.1 坑 2）** | 复用 036 §三 uvVenvInstaller（uv venv --clear） |
| 依赖 | `uv sync` 语义 + **官方 uv.lock 只换主机** → torch 2.8.0+cu128（aliyun cu128 平铺目录 2-6MB/s） | venv `.venv-indextts` + **torch 走 036 §四 现成套路：probeWheelOnMirror(flat 探测) → downloadOneFile 本地 wheel → uv pip install 本地文件 → 校验 +cu**；其余依赖走 aliyun PyPI（--default-index） |
| 锁 | **禁止重新 uv lock**（非当前平台必撞 accel 冲突）；用官方锁 | 官方 uv.lock（主机已换 aliyun）随 App 资源分发；`uv pip install -e <repo>` 时显式给 index |
| 模型 | 整仓 5.23GB/26 文件（modelscope 整仓 API 动态清单，8.8MB/s）+ **辅助四件套首次运行自动下载**（w2v-bert-2.0 / MaskGCT codec / CAMPPlus / BigVGAN → `<model_dir>/hf_cache/`，官方代码 modelscope→hf-mirror 自动择源）→ 总 **10.4GB** | App 安装器：整仓下载（§三）+ **辅助四件套预下载落 hf_cache**（036 坑 F 反模式禁止，不能靠首次运行拉） |
| 就绪判定 | venv 关键包 `indextts` + **`import indextts.infer_v2_5` 探针**（裁剪版缺此模块） | `VENV_KEY_PKG['indextts']='indextts'` + install 后跑 import 探针（探针失败=未就绪，如实红字） |
| 解码面（T1，038 §〇·补） | 已扫：`infer_v2_5._load_and_cut_audio` 用 **librosa.load（soundfile 解码）**，输出走 soundfile → **无 torchaudio.load / 无 torchcodec / 无系统 FFmpeg 依赖** ✅ 安全 | 不需要额外解码层 |

---

## 二、三件套清单（坑 H：齐才接好）

| 件 | 内容 | 现状 |
|---|---|---|
| `engines/indextts.json` | checks = venv + 关键包 + infer_v2_5 探针 + 模型整仓（动态清单：config.yaml + gpt.pth + qwen0.6bemo4-merge/ + codec.pth + s2mel.pth + ...）+ 辅助四件套（hf_cache）字节校验；runtime = `.venv-indextts` cwd vendor 源码；profile（diskGB≈15 incl 模型 / mem ≈12GB VRAM / accel CUDA / tier / slowNote：s2mel 基座 RTF≈108） | ❌ 缺（新建） |
| `INSTALLERS['indextts']` | ① venv：uv venv --clear + 依赖（官方锁语义 + torch 本地 wheel，§三）② 模型：整仓 5.23GB（modelscope 动态清单，二次确认）+ 辅助四件套预下载（二次确认，可合并）③ 全部字节校验，失败换镜像重下 | ❌ 缺（新建，复用 qwen3ModelInstaller 二段式骨架） |
| `start-all.js` 拉起 8004 + `/speak` 转发 engine=indextts | `indextts-tts-server.py --model-dir <数据目录>models\indextts\checkpoints --port 8004`；asr-server /speak 转发（参考 cosyvoice 段） | ❌ 缺（服务脚本已有，需小改 §四） |

---

## 三、安装器关键实现（照抄已验证套路，新增点只有两个）

1. **venv（037/036 §四 现成）**：
   - `BIG_DOWNLOAD_CONFIRM:2.5GB:.venv-indextts`（torch 为主）→ 确认 → `uv venv --clear` → 依赖：
     - torch/torchaudio：`probeWheelOnMirror`（**layout:flat** 探测 aliyun `pytorch-wheels/cu128/`，正则兼容 `&#43;`/`%2B`/`+`，坑 O）→ `downloadOneFile`（进度+断点）→ `uv pip install <本地 wheel>`（坑 N 天然规避）→ 校验 `torch.__version__` 含 `+cu128`；
     - 其余依赖：`uv pip install -e <vendor-全量> --default-index aliyun`；
     - **新增校验**：装完跑 `import indextts.infer_v2_5`（防空壳探针）。
2. **模型（036 §五 现成 + 新增辅助预下载）**：
   - 整仓：modelscope `repo/files` 动态清单（Path+Size）→ downloadOneFile 逐文件（modelscope 直链 `resolve/master/<file>`，实测 8.8MB/s）→ 字节校验 → 元数据豁免（README/.gitattributes/asset）；
   - **新增：辅助四件套预下载**：官方代码的下载器（`indextts/utils/model_download.py` + `network_detection.py`）已自动择源（modelscope→hf-mirror），安装器直接调用它把四件套拉进 `<checkpoints>/hf_cache/`（复现 040 runtime 行为 = 版本/字节与官方一致），或按官方下载 URL 直下 + 登记字节。**验收凭证：`hf_cache` 下 w2v-bert-2.0、maskgct codec、campplus、bigvgan 就位。**

---

## 四、indextts-tts-server.py 改动点（在 App 内生效）

- 删/弱化 `sys.path.insert(0, _VENDOR)`：vendor 全量替换后仍建议**以 venv 安装为准**（`import indextts` 走 venv editable，不与 vendor 混叠）；vendor 仅作 cwd 源码兜底。
- `--model-dir` 默认 → 数据目录 `models\indextts\checkpoints`；`--voice-dir` 沿用 `data\clone-voices`（与 cosyvoice 同结构，克隆面板共用）。
- 语言默认 ZH；设备自动（CUDA→CPU），`use_bf16` 默认 False（对齐 040 实测基线）。
- start-all.js 增加 indextts=new：`<venvPy> indextts-tts-server.py --model-dir ... --port 8004`。

---

## 五、验收清单（可见即验收，036 铁律 3）

- [ ] 模型页出现 IndexTTS-2.5 卡片「检测/修复」→ 点必有确认行/进度/日志（坑 A/B）
- [ ] venv 装好 → 依赖装好 → `import indextts.infer_v2_5` 探针过 → 徽标不再「缺环境」
- [ ] 模型整仓 + 辅助四件套下载有逐文件进度、可取消、失败换镜像
- [ ] 8004 活；克隆面板选 IndexTTS → 参考音频 → **出声**（22.05kHz WAV）
- [ ] 全程用户点击；App 不自动装（杜绝安装器之外的自动动作）
- [ ] （后续实验项，非本版阻塞）加速：`--extra accel`（flash-attn+triton-windows 走 aliyun）与 `use_bf16=True` 对比 RTF（040 基线 s2mel 462s，预期数倍提升）

---

## 六、风险与待实测登记（禁止跳过）

1. 辅助四件套的确切版本/字节清单：以 040 运行时落盘为准（已在 E:\Github\indextts2.5\checkpoints 实存，可对照登记）。
2. modelscope 动态清单在安装器里的 API 路径（036 §五 已实现过一次：`repo/files`）。
3. 许可证：**LicenseRef-Bilibili-IndexTTS**（非 Apache-2.0）——App 展示许可时如实标注；商用前必须读 LICENSE/INDEX_MODEL_LICENSE 原文。

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-30 | 初版：基于 040 独立部署实测定档的 App 接入方案——官方口径照抄表、三件套清单、安装器复用点（torch 本地 wheel / 模型整仓 / 辅助预下载新增）、server 改动点、验收清单 |