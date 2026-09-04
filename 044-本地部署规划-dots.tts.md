# 044 · 本地部署规划：dots.tts（小红书 RED，2B 克隆，Apache-2.0 可商用）

> 目的：dots.tts **独立本地部署**（先把源、路径、出声全部验证），最后才回 App。纪律见 043 §一；总清单见 043 §〇 #7。
> 实测：2026-08-30（网络全通）。官方 README 存档 `043-ref-readmes/dots.tts-README.md`。

---

## 一、这是什么 / 许可
- **dots.tts** = 小红书 RED 出品的 **2B 全连续自回归 TTS**，语音克隆第一梯队（007 表）；**Apache-2.0，官方明示「code and released checkpoints are licensed under Apache-2.0」→ 可商用**。
- 特性：pretrained / SOAR（说话人相似度最高）/ MeanFlow（蒸馏）多档；双流（double-stream）选项；语音编辑（dots.tts.edit，2026.08 新增）。

## 二、官方源（2026-08-30 实测）

| 源 | 地址/内容 | 实测 |
|---|---|---|
| 官方仓库 | `github.com/studio-dots-ai/dots.tts`（main，1287★） | ✅ 搜索命中；README raw 拉取成功 |
| PyPI | **`pip install dots.tts`**（官方主安装；完整功能 `'dots.tts[full]'`） | ✅ README 原文 |
| 模型（HF `dots-studio`，7 档同骨干） | `dots.tts-base`（预训练基线）/ **`dots.tts-soar`**（相似度最高）/ `dots.tts-mf` / `dots.tts-mf-2steps` / **`dots.tts-mf-2steps-stts`（推荐双流）** / `dots.tts-mf-1step` / `dots.tts.edit` | ✅ HF 命中 |
| ModelScope 镜像 | ⚠️ 无（搜索无结果；API 无关键词端点）→ **模型走 HF 直连或 hf-mirror** | ✅ 已测 |
| 生产服务（可选观察） | SGLang Omni OpenAI 兼容 `/v1/audio/speech` | ✅ README 明示 |
| 许可 | **Apache-2.0（官方 README 明示）** | ✅ |

## 三、官方安装口径（README 原文，一字不改）
```
conda create -n dots_tts python=3.10 -y
conda activate dots_tts
pip install dots.tts                       # 官方主路径
# 或源码：
git clone https://github.com/studio-dots-ai/dots.tts
pip install -e . -c constraints/recommended.txt
# 完整功能：pip install 'dots.tts[full]' / pip install -e .[full] -c constraints/recommended.txt
```
推理示例（README）：`dots.tts` CLI + `--prompt-audio`（单用=x-vector 克隆；配 `--prompt-text`=续写克隆）。

## 四、模型体积（已实测）
- **`dots.tts-soar`：15 文件，5.16GB**：model.safetensors 4.40GB + vocoder.safetensors 0.72GB + speaker_encoder 29.2MB + tokenizer.json 11.4MB + vocab/merges。
- 其余档（base/mf/mf-2steps/mf-2steps-stts）同骨干——下载时以 HF tree 逐文件实测登记字节清单。
- 4070 Ti 12GB：bf16 可行（骨干 ~4.4GB）。

## 五、独立部署步骤（顺序执行，每步停下汇报）
1. **源实测收尾**：拉所选档 HF 整仓字节清单落表；`constraints/recommended.txt` 的 torch/Python 约束（README 已存，细读）；PyPI 包在 aliyun/tuna 测速（新网络直连也可）。
2. **独立环境**：目录 `E:\Github\dotstts\`；venv + `pip install dots.tts`（PyPI 镜像定速后使用）；torch 按官方约束 CUDA 版（4070 Ti → cu128，aliyun 平铺探测，坑 O）。
3. **模型**：整仓全量（HF 直连或 hf-mirror）逐文件字节校验；**预下载**（禁首次运行自动拉，036 坑 F）。
4. **验证**：`import` 探针（包名以官方实际为准）+ CLI `dots.tts` 克隆出声。
5. **验收（可见即验收）**：出声 wav 可播放；汇报 torch/cuda、模型体积与字节清单、克隆相似度、单条耗时；WebUI/CLI 任一可起。
6. **坑映射（043 §一 8 条全量执行）**：独立环境弃 App / 源先实测 / 官方约束不重造 / 镜像+BOM+残留0 / 整仓+字节 / 防空壳探针 / 分阶段 / 禁 git 写。
7. **最后才回 App**：三件套（engines/...json + INSTALLERS + start-all 端口 + /speak 转发），参考 041。

## 六、风险/待实测登记（禁止跳过）
- ⚠️ docs 尚无"=== 待实测"即本节：torch 确切版本（读 constraints 后登记）；soar/mf-2steps-stts 两档实测 RTF 与显存；`dots.tts` 包 import 名（点号 vs 下划线）以安装后实测为准；语音克隆滥用风险（README 明示 Misuse risk——产品化需合规备注，Apache 许可不豁免滥用责任）。

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-30 | 初版：dots.tts 独立部署规划（官方源/安装原文/5.16GB 实测/步骤/坑映射/待实测） |