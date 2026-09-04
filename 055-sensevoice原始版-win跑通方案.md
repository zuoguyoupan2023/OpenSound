# 055 · SenseVoice 原始版（funasr）Windows 跑通方案

> 目的：在 **Windows** 上把「SenseVoice 原始版（funasr · 高精度）」引擎真正跑通（8002 出字），
> 供 App 内「识别增强」使用。参考对象：**已实现的 sherpa-onnx 版 SenseVoice（sensevoice.json，已通）** 与 qwen3/cosyvoice 的 venv 套路。
> 现状（035 实测）：`.venv-funasr` 是**空壳**（0 包，无 numpy/funasr）→ 8002 启动即崩 `No module named 'numpy'`。
> 关联：035 §一（现状）、036 §三§四（venv+CUDA 范式）、001 §三（跨平台）、000-plan-2（本轮规划任务）。
> 状态（2026-08-31）：✅ **Win 已跑通**——App 内「检测/修复」装 venv+模型 → 重启服务 → 8002 出字（含标点）；
> 踩坑与经验见 §四 坑 8、§六 经验总结、000-install 坑 V；GPU 升级见 §五（发布版按钮暂隐藏）。

---

## 一、目标与验收

- **目标**：Win 上 `.venv-funasr` 装好 funasr+torch（+numpy 等依赖）→ `start-all.js` 拉起 8002 → asr-server `/transcribe?engine=sensevoice-original` 对一段中文音频出字。
- **验收（可见即验收）**：模型页 sensevoice-原始卡片「检测/修复」→ 确认 2.5GB → 进度可见装好 → 重启服务 → 8002 活 → 识别面板选「SenseVoice 原始版」→ 上传/录制音频 → **出文字**；徽标绿。

## 二、与已实现 sensevoice（sherpa 版）的差异（为什么原始版要单独跑）

| 维度 | sensevoice（sherpa-onnx，已通） | sensevoice-original（funasr，本方案） |
|---|---|---|
| 运行形态 | **node 二进制**（sherpa-onnx-node，npm 装） | **python 独立进程**（sensevoice-server.py，8002） |
| 依赖 | npm 包（平台 optionalDependencies 自动装） | venv：funasr + torch + torchaudio + numpy + modelscope |
| 模型 | `models/sensevoice/model.int8.onnx` 228MB | `models/sensevoice-original/model.pt` 900MB + fsmn-vad + punc-cn-en |
| 精度 | int8 量化 | fp32 原始，更高 |
| 转发 | asr-server 内置（sherpa 同进程） | asr-server → HTTP 8002 转发 |

> 结论：原始版 = **python 系引擎**，走 036 已验证的「独立 venv + 依赖 + 独立端口」范式（同 qwen3/cosyvoice），**与 sherpa 版互不干扰，可并存**（UI 两个版本都展示）。

## 三、Windows 跑通步骤（顺序执行，每步停下汇报）

### 第 1 步：确认环境缺口（035 已实测，勿重查）
- `.venv-funasr` 空壳（0 包）→ **缺 numpy/funasr/torch** → 8002 秒退。
- 模型文件：`models/sensevoice-original/`（model.pt 936,291,369 B + config.yaml + am.mvn + bpe.model）是否已下载？`models/fsmn-vad/`（4 文件）与 `models/punc-cn-en/`（6 文件）是否齐全？（引擎 json checks 已定义字节，安装器会校验）。

### 第 2 步：venv 依赖（用户 App 内点击或等价命令）
- App 内：模型页 sensevoice-原始 →「检测/修复」→ 确认 ~2.5GB → uvVenvInstaller 建 `.venv-funasr`（`pkgs: ['funasr','torch','torchaudio']`，`keyPkg: 'funasr'`，已在 asr-server.js L2022-2025）。
- 手动等价（诊断用，用户跑）：
  ```powershell
  # 受管 uv（数据目录 runtime）或独立 uv
  uv venv --python 3.11 --clear E:\Downloads\opensound-download\venvs\.venv-funasr
  uv pip install --python E:\Downloads\opensound-download\venvs\.venv-funasr\Scripts\python.exe funasr torch torchaudio numpy --default-index https://mirrors.aliyun.com/pypi/simple/
  ```
- **坑提醒（036/047 经验）**：
  - torch 若被装成 CPU 版且本机有 N 卡 → 走 036 §四 CUDA 升级（aliyun cu128 平铺镜像本地 wheel + `--reinstall-package`，校验 `+cu`）；
  - **必装 numpy**（035 已记 8002 因缺 numpy 崩）——`funasr` 依赖里通常有，但确认装后 import 探针过；
  - `uv pip install` 大文件无实时进度是已知缺口（035 §五 第3步），耐心等或走 downloadOneFile 直下 wheel 再本地装（047 坑 4 同法）。

### 第 3 步：模型齐全性（App 内「补齐」或 download-all-models.ps1）
- `models/sensevoice-original/`：model.pt + config.yaml + am.mvn + bpe.model + **tokens.json**（checks 已定义字节，安装器会校验）；
- `models/fsmn-vad/`：4 文件（model.pt/config.yaml/am.mvn/configuration.json，ModelScope speech_fsmn_vad_zh-cn-16k-common-pytorch）；
- `models/punc-cn-en/`：6 文件（model.pt 1,125,507,622B / config.yaml / configuration.json / tokens.json / jieba.c.dict / jieba_usr_dict，ModelScope punc_ct-transformer_cn-en-common-vocab471067-large，**构成已实测登记**，与 ps1 对齐）。

### 第 4 步：启动与转发
- `start-all.js` 已实现：`.venv-funasr` 存在 → `run(PY_FUNASR, ['sensevoice-server.py','--port','8002'])`（L234-238）；
- asr-server `/transcribe?engine=sensevoice-original` → 8002 转发（L2567/2725）；
- 验证：`netstat -ano | findstr :8002` LISTENING；`curl http://127.0.0.1:8002/health` → `{ok:true,...}`。

### 第 5 步：出字验收
- 识别面板选「SenseVoice 原始版」→ 一段中文音频 → 出文字（含标点，punc 模型生效）；
- 对比 sherpa 版同音频：原始版精度/耗时记录（RTF）；
- 控制台中文乱码 = GBK 显示问题，落盘验证用 UTF-8（047 坑 7）。

## 四、Windows 特有坑（对照 001 §三 + 047 坑账本）

| # | 坑 | 现象 | 预案 |
|---|---|---|---|
| 1 | venv 路径 | `bin/python3` vs `Scripts/python.exe` | start-all.js `venvPy()` 已跨平台（001 §三.A.1 已修） |
| 2 | torch CPU 版 | N 卡闲置、识别慢 | 036 §四 CUDA 升级（aliyun cu128 + --reinstall-package + 校验 +cu） |
| 3 | 缺 numpy | 8002 秒退 `No module named 'numpy'`（035 实测） | venv 装依赖显式含 numpy + import 探针 |
| 4 | torchaudio 无后端 | 音频解码失败（047 坑 4） | venv 预装 soundfile |
| 5 | 磁盘空间 | 依赖 ~2.5GB + 模型 ~900MB+ | 执行前查余量（≥10GB） |
| 6 | 网络 | 官方源慢/被墙 | 一切走 aliyun PyPI / modelscope / hf-mirror（036 §五源表） |
| 7 | .pyd 文件锁 | 升级 torch 时 8002 占用 | App 自动停 8001/8002/8003（坑 P 已实现） |

## 五、升级 GPU 方案（CUDA torch；2026-09-05 已恢复按钮，本节为机制与验证说明）

> 背景：`.venv-funasr` 当前装的是 CPU 版 torch（PyPI/清华默认，2.13.0+cpu）。
> 本机 RTX 4070 Ti（驱动 616.56，满足 cu128 门槛）。**日常短音频交互 CPU 已实时（RTF≈0.3）。
> ⚠️ 2026-09-05：源码验证阶段**已恢复「升级 GPU 加速」按钮**（取消 ModelsPanel 注释块，055 §五 早期
> 因发布策略隐藏；后端 gpuUpgrade 标志与 uvVenvInstaller 的 torchCpuHere 分支一直都在）。何时值得升、怎么升、怎么验如下。

### 1. 什么时候值得升级（决策标准，不盲目升）
| 场景 | 结论 |
|---|---|
| 交互式短音频（≤30s）识别 | **不需要**：CPU RTF≈0.3，出字无感知差距（本机实测 3.4s 音频 ~1s 出字） |
| 经常转写长音频（数分钟以上） | **值得**：CPU 约 3× 实时耗时；GPU 可压到接近实时 |
| 同时跑 qwen3/cosyvoice 等重引擎且都要 GPU | **值得**：各自 venv 分别升级（按钮出现在每个 python 引擎卡片） |
| 仅 SenseVoice 偶尔用 | 不升，省 2.5GB 下载 + 显存占用 |

### 2. 升级路径（按钮恢复后 = 模型页点「升级 GPU 加速」）
已实现于 `uvVenvInstaller` 的 `torchCpuHere` 分支（035 实证链）：
1. 探测 N 卡 + venv 就绪 + torch 无 `+cu` 后缀 → 显示「升级 GPU 加速」；
2. 二次确认（约 2.5GB）→ **坑 P 自动停止 8001/8002/8003**（site-packages .pyd 文件锁）；
3. 按驱动选 cu 目录：**驱动 ≥570→cu128 / ≥560→cu126 / ≥550→cu124 / 更老→拒绝并提示升级驱动**（防白下）；
4. 探测 aliyun/清华/官方 pytorch-wheels（**平铺目录结构**，035 坑 O 教训）→ `downloadOneFile` 直下 torch+torchaudio wheel（多镜像 + 断点 + 真实进度）→ `uv pip install` 本地 wheel（秒级）；
5. 校验 `torchBuildTag` 含 `+cuXXX` 才算成功；仍 CPU 版 → 明确报错（驱动/wheel 不匹配排查指引）。

### 3. 版本匹配与风险预案
| 项 | 说明 |
|---|---|
| torch/torchaudio | 必须同 cu 版本（wheel 探测成对下载；torchaudio 无对应 cu 即报错不上） |
| funasr 1.4.9 兼容性 | CPU 版 2.13.0 已实测可用；CUDA 版仅 `+cu` 后缀差异，机制等价（037/038 同款 torch 升级经验） |
| .pyd 文件锁 | 已自动停服务（坑 P）；升级完提示「重启服务」重新拉起 |
| 白下风险 | 驱动过旧直接拒绝（步骤 3），不浪费流量 |
| 校验失败 | 日志给 wheel 名与驱动版本，可设 `OPENSOUND_TORCH_INDEX` 手动指定源重试 |

### 4. 验证（升级后）
- 模型页 sensevoice-原始 卡片：`accelTag` 由「CPU」变为「CUDA cu128」徽标；
- 8002 日志/`/health` 正常；识别同段音频对比耗时（GPU 应显著快于 CPU 长音频场景）；
- 探针：`.venv-funasr/Scripts/python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available())"` → `2.13.0+cu128 True`。

### 5. 发布版按钮隐藏与恢复
- 隐藏：`ui/src/panels/ModelsPanel.tsx` 中「升级 GPU 加速」按钮块已注释（含原因说明）；后端 `gpuUpgrade` 标志保留不删。
- 恢复：取消注释该按钮块 → 重建 exe（坑 M：前端改动必须重建）→ 模型页按钮即回归。
- 定位：搜索 `gpu-upgrade`（按钮）或 asr-server.js `gpuUpgrade:`（后端标志）。

## 六、经验总结（本轮 Win 跑通 funasr 原始版）
1. **venv 空壳 ≠ 装好**：关键包探针（`venvKeyPkgOk`）防空壳；显式装 numpy/soundfile（坑 3/4）堵 8002 秒退。
2. **本地模型目录 ≠ 官方 AutoModel 等价**：funasr 本地加载有一组**固定文件名约定**（`bpe.model`/`tokens.json`/`am.mvn`/`jieba_usr_dict`），ModelScope 仓库文件名与之不一致时须自愈别名（坑 8/000-install 坑 V）。
3. **先跑最小探针再谈集成**：本次先 import 探针 → 模型加载探针 → 真实录音转写，三步定位，比反复重启服务快得多。
4. **校验路径必须与落盘路径同一套**：glob 型 checks 走代码目录、file 型走数据目录的割裂是 whisper「无匹配」根因（坑 U/056）。
5. **发布前砍风险功能**：CUDA 升级虽已实现，但属「优化非必需」，发布版隐藏按钮、文档留指引，降发布风险。

## 七、变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-30 | 初版：SenseVoice 原始版（funasr）Win 跑通方案——与 sherpa 版差异、5 步执行、Win 特有坑预案；关联 000-plan-2 |
| 2026-08-31 | 实施：① `INSTALLERS['sensevoice-original']` 升级为**二段式安装器**（venv：funasr/torch/torchaudio/numpy/soundfile ≈2.5GB；模型三件套 ≈2.1GB 自动下载，downloadOneFile 多镜像 + 断点续传 + 逐文件字节校验 + 大流量二次确认）② engines json checks 逐文件化（15 项，tokens.json 补入；fsmn-vad/punc 从"目录"改"逐文件字节"，totalMissingBytes 准确）③ 坑 3/坑 4 落地：pkgs 显式含 numpy/soundfile ④ start-all.js 增加系统 python 回退的 `import funasr, numpy` 探针守卫（防 8002 秒退）⑤ SERVER_VERSION/EXPECTED_VERSION → 2.7.0；punc-cn-en 构成已实测登记（6 文件）。**待用户 App 内实测验收** |
| 2026-08-31 | **实测坑 8（8002 起不来的根因）**：funasr 本地加载只认固定文件名 `bpe.model`（download_model_from_hub.py 按此名补 `tokenizer_conf.bpemodel`），而 ModelScope 仓库该文件名为 `chn_jpn_yue_eng_ko_spectok.bpe.model` 且 config.yaml 里 `bpemodel: null` → `sp.load("None")` → `RuntimeError: NOT_FOUND: "None"` 8002 秒崩。**修复**：`sensevoice-server.py` 加载主模型前自动把 `*.bpe.model` 复制为 `bpe.model` 别名（自愈式）。实测通过：三件套加载 + 真实录音转写「现在开始做第一次测试。」（CPU 推理实时率 RTF≈0.3，无需 GPU） |
| 2026-08-31 | ✅ **验收通过（用户 App 内实测）**；文档收尾：① 新增 §五「升级 GPU 方案」（决策标准/升级路径/版本匹配/验证/按钮恢复指引）；② 新增 §六「经验总结」；③ **发布版暂隐藏「升级 GPU 加速」按钮**（ModelsPanel.tsx 注释按钮块，后端 gpuUpgrade 标志保留，恢复 = 取消注释 + 重建 exe）；④ 坑 8 同步登记 000-install 坑 V、Whisper glob 路径问题登记坑 U（见 056） |