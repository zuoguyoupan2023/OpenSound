# 051 · 本地部署规划：Piper（Rhasspy，MIT，CPU 实时 TTS）

> 目的：Piper **独立本地验证/部署**（轻量 CPU 路线，先出声最后回 App）。纪律见 043 §一；总清单见 043 §〇（新增候选）。
> 关联：Piper 属 sherpa-onnx 生态（[sherpa-onnx TTS assets](https://github.com/k2-fsa/sherpa-onnx/blob/c6691594/wasm/tts/assets/README.md)），与 FireRedASR 路线 B 同栈；坑账本见 047。

---

## 一、这是什么 / 效果依据

| 项 | 内容 |
|---|---|
| 官方 | Rhasspy/Piper，MIT 许可；单说话人 VITS 合成 |
| 特点 | **CPU 可实时**、极轻（单模型几十 MB）、sherpa-onnx 现成、无 GPU 依赖 |
| 中文 | 需专用中文 voice 模型（espeak-ng 文本前端 + 中文模型文件） |
| 对比 | [Kokoro vs Piper vs XTTS 本地对比](https://contracollective.com/blog/kokoro-vs-piper-vs-xtts-local-text-to-speech-m5-max-2026)：Kokoro 音质更好（已集成 App），Piper 胜在极轻量/CPU/自由 |

## 二、独立部署步骤（顺序执行，每步停下汇报）

1. **源实测**：官方 repo（`rhasspy/piper`）README raw；pip 包（`piper-tts`）与 sherpa-onnx 预编译 wheel 可用性；中文 voice 模型清单 + 字节（HF rhasspy/piper-voices）。
2. **环境**：目录（如 `E:\Github\piper\`）；**轻量路线**：pip 装 `piper-tts`（含 espeak-ng 依赖）+ 中文 voice 模型文件；**不强制 venv**（如与 App 隔离则建独立 venv）。
3. **模型**：中文 voice（如 `zh_CN-huayan-medium`）整文件下载 + 字节校验；espeak-ng 数据预装（禁运行时拉，036 坑 F）。
4. **验证**：CLI 合成一句中文 + 一句英文 → wav 可播放；测 CPU RTF。
5. **验收**：出声 + 体积/RTF/音质评价 + 许可（MIT）登记。
6. **坑映射**：网络走 urllib（坑1）；espeak-ng 路径缺失是 Piper 特有坑（装时验证）；模型文件与 voices.json 需配对。

## 三、风险/待实测登记
- ⚠️ 中文音质一般（不如专精克隆模型）；单说话人（无克隆）；多语音模型文件管理；espeak-ng 在 Windows 的安装方式实测。

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-30 | 初版：Piper 独立部署规划（来源：用户提出 + 榜单调研） |