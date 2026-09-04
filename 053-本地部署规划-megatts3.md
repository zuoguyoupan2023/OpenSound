# 053 · 本地部署规划：MegaTTS3（ByteDance，0.5B，克隆+情感）

> 目的：MegaTTS3 **独立本地验证/部署**（先源/路径/出声，最后回 App）。纪律见 043 §一；总清单见 043 §〇（新增候选）。
> 关联：流程与踩坑口径复用 **047**。

---

## 一、这是什么 / 效果依据

| 项 | 内容 |
|---|---|
| 出品 | ByteDance（字节跳动）；FireRedTTS3 README 榜单对照：MegaTTS3 0.5B，克隆 WER 2.79/77.1、ZH 1.52/79.0 |
| 特点 | 0.5B 轻量，中文克隆 + 情感；有 [ComfyUI-MegaTTS 节点](https://github.com/1038lab/ComfyUI-MegaTTS)（社区，基于官方权重） |
| 中文 | 中文强，英文一般（官方定位） |
| 许可 | ⚠️ 待实测（README/LICENSE raw 读） |

## 二、独立部署步骤（顺序执行，每步停下汇报）

1. **源实测**：官方仓库 README raw（安装命令原文）；**权重 gated 检查**（HF 卡 401 则先匿名试，需 token 则登记）；requirements 登记；整仓字节清单。
2. **独立环境**：目录（如 `E:\Github\megatts3\`）；venv + CUDA torch cu128（aliyun 平铺镜像）；PyPI aliyun 镜像；**预装 soundfile**（047 坑4）。
3. **模型**：整仓 + 字节校验；辅助件预下载（036 坑 F）。
4. **验证**：import 探针 + 中文克隆出声 + 情感参数验证。
5. **验收**：出声 wav + torch/cuda、体积、耗时/RTF、效果、许可登记。
6. **坑映射（047 全套）**：urllib（坑1）；磁盘余量（坑2）；flash_attn grep（坑3）；soundfile（坑4）；分进程（坑5）；签名 bug（坑6）；UTF-8（坑7）。

## 三、风险/待实测登记
- ⚠️ **权重 gated 是最大风险**（官方可能未完全开源/需授权）；英文效果一般；ComfyUI 节点非官方（仅参考）。

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-30 | 初版：MegaTTS3 独立部署规划（来源：用户提出 + 榜单调研） |