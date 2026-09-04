# 049 · 本地部署规划：VoxCPM2（OpenBMB，2B，tokenizer-free 克隆）

> 目的：VoxCPM2 **独立本地验证/部署**（先源/路径/出声，最后回 App）。纪律见 043 §一；总清单见 043 §〇 #10。
> 关联：姊妹项目 FireRedTTS3 完整流程与踩坑见 **047**（本规划直接复用其流程口径）。

---

## 一、这是什么 / 效果依据

| 项 | 内容 |
|---|---|
| 官方仓库 | `OpenBMB/VoxCPM2`（2B DENSE；官方 README 标注 MegaTTS3 对照：0.5B 与 2B 两档） |
| 特点 | Tokenizer-Free TTS：多语种 + 创意音色设计（voice design）+ 高保真克隆；FireRedTTS3 README 榜单中 VoxCPM2 克隆 WER/SIM 在开源前列（EN 1.84/75.3、ZH 0.97/79.5） |
| 部署形态 | 官方 python 推理；社区有 [vllm-omni recipe](https://github.com/vllm-project/vllm-omni/blob/963ba1ab7a02b2c1f687285fcd2072cd57cd0b34/recipes/OpenBMB/VoxCPM2.md)（vLLM 路线，Windows 不适用，仅参考） |
| 许可 | ⚠️ 待实测（pyproject/README raw 读，043 纪律 1） |

## 二、独立部署步骤（顺序执行，每步停下汇报）

1. **源实测**：README raw（安装命令原文）+ requirements/pyproject 登记（torch 版本）；许可读取登记；HF/ModelScope 权重整仓字节清单（tree API）。
2. **独立环境**：目录（如 `E:\Github\voxcpm2\`）；venv（Python 3.12）+ CUDA torch cu128（aliyun 平铺镜像本地 wheel，坑 O）；PyPI 依赖 aliyun 镜像；**venv 预装 soundfile**（047 坑4）。
3. **模型**：整仓全量 + 字节校验；预下载（036 坑 F）。
4. **验证**：import 探针 + 官方推理脚本出声（克隆/造音色 wav 可播放）。
5. **验收**：出声 wav + 汇报 torch/cuda、模型体积、耗时/RTF、许可登记。
6. **坑映射（047 全套）**：沙箱 TLS 走 urllib（坑1）；磁盘余量 ≥20GB（坑2）；flash_attn 硬编码 grep 检查（坑3）；soundfile（坑4）；分进程验证避免页文件（坑5）；官方签名 bug 先读真实签名（坑6）；输出 UTF-8 无 BOM（坑7）。

## 三、风险/待实测登记
- ⚠️ torch 版本锁定（勿被 pip 自动升最新）；vLLM 路线 Windows 不可用；2B 模型显存评估（预计 ~5-6GB fp16，12GB 可行）；语音 codec/tokenizer 辅助件是否运行时自动拉取（须预下载）。

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-30 | 初版：VoxCPM2 独立部署规划（来源：043 #10 + 047 流程复用） |