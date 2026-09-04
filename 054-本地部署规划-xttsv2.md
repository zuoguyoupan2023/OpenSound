# 054 · 本地部署规划：Coqui XTTS v2（CPML 许可，17 语克隆经典）

> 目的：XTTS v2 **独立本地验证/部署**（先源/路径/出声，最后回 App）。纪律见 043 §一；总清单见 043 §〇（新增候选）。
> 关联：流程与踩坑口径复用 **047**。

---

## 一、这是什么 / 效果依据

| 项 | 内容 |
|---|---|
| 官方 | Coqui AI（已停更，仓库冻结）；17 语零样本克隆经典 |
| 特点 | 克隆效果好、支持多语；~1.8GB 权重；社区生态多 |
| **许可** | ⚠️ **CPML（Coqui Public Model License）非 Apache**——[商用有条款限制](https://www.promptquorum.com/zh/power-local-llm/local-tts-voice-cloning-piper-coqui-xtts)；商用前必须读原文 |
| 风险 | 公司停更 → 依赖老旧（可能需降 numpy/transformers 版本） |

## 二、独立部署步骤（顺序执行，每步停下汇报）

1. **源实测**：官方 repo（`coqui-ai/TTS`，fork 冻结版）README raw；**许可原文读取登记（CPML 条款）**；requirements 登记（torch/transformers 版本，注意老旧依赖）；HF 权重（`coqui/XTTS-v2`）整仓字节清单。
2. **独立环境**：目录（如 `E:\Github\xttsv2\`）；venv + CUDA torch（版本按 requirements 实测，可能非 cu128 最新）；PyPI aliyun 镜像；**预装 soundfile**（047 坑4）。
3. **模型**：整仓（~1.8GB）+ 字节校验；辅助件（tokenizer/vocoder 随整仓或预下载）。
4. **验证**：import 探针 + 克隆出声（参考音频 + 文本）。
5. **验收**：出声 wav + torch/cuda、体积、耗时/RTF、克隆效果、**CPML 许可登记**。
6. **坑映射（047 全套）**：urllib（坑1）；磁盘余量（坑2）；flash_attn grep（坑3）；soundfile（坑4）；分进程（坑5）；签名 bug（坑6）；UTF-8（坑7）；**另：老旧依赖与 numpy/transformers 兼容性是特有坑**。

## 三、风险/待实测登记
- ⚠️ CPML 许可商用限制；停更导致依赖旧（numpy<2 / transformers 版本锁定）；多语克隆质量参差。

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-30 | 初版：Coqui XTTS v2 独立部署规划（来源：用户提出 + 榜单调研） |