# 046 · 本地部署规划：FireRedASR（小红书 FireRedTeam，中文+方言识别第一梯队）

> 目的：FireRedASR **独立本地验证/部署**（先源/路径/出字，最后回 App）。纪律见 043 §一；总清单见 043 §〇 #9。
> 归属：**FireRedTeam = 小红书 Super Intelligence 基础算法实验室**（GitHub org 描述原文，2026-08-30）。
> 实测：2026-08-30（网络全通）。

---

## 一、这是什么 / 效果依据

| 项 | 内容 |
|---|---|
| 官方仓库 | **`FireRedTeam/FireRedASR`（1973★）**：“工业级开源 ASR：普通话/中文方言/英语”；**`FireRedTeam/FireRedASR2S`（659★）**：“SOTA All-in-One ASR：识别 + VAD + 语种识别 + 标点 一体” |
| 官方权重（HF FireRedTeam） | `FireRedASR-AED-L`（AED 编码器-解码器，大档）、`FireRedASR-LLM-L`（LLM 解码）、`FireRedASR2-AED` 均存在（模型卡 401=gated，评测数字须解锁/README 补录） |
| 效果（本项目 001/000 文档早已收录） | 001：**FireRedASR-AED 1.1B → 中文+方言精度第一梯队（★★★★★ SOTA 级）**；000-device-vs-model：**FireRedASR2 (int8) 中文+方言精度第一**（sherpa 同栈） |
| 生态（社区实测线索） | 流式/低延迟改版（`xphh/fireredasr-streaming`）、UI（`jianchang512/fireredasr-ui`）、ONNX/TensorRT 移植——生态活跃 |
| 许可 | ⚠️ 待读仓库 LICENSE（规划第 1 步 raw 抓取登记） |

## 二、官方源（2026-08-30 实测）

| 源 | 地址 | 实测 |
|---|---|---|
| 官方仓库 | `github.com/FireRedTeam/FireRedASR`（main）；`FireRedTeam/FireRedASR2S` | ✅ 搜索命中 + 描述确认 |
| HF 权重 | `FireRedTeam/FireRedASR-AED-L` / `-LLM-L` / `FireRedASR2-AED` | ✅ 存在（卡 401 待解锁） |
| sherpa-onnx（轻量部署路线） | 001 文档：FireRedASR-AED 有 **sherpa-onnx int8（2026-02 版）** 可 CPU/GPU 跑 | ✅ 文档记录（实现时以 sherpa 官方模型库实测登记） |
| ModelScope 镜像 | ⚠️ 未探测（第 1 步实测：FireRedTeam 在 modelscope 是否有 ASR 仓） |

## 三、本地部署路线（二选一，先验证再定）

- **路线 A（首选验证）**：官方 Python 推理（仓库 README 原文命令）→ venv + torch（CUDA）+ 权重（HF 直连/hf-mirror 整仓）→ 对测试音频出字（可见即验收）。
- **路线 B（App 落地更轻）**：**sherpa-onnx int8**（CPU/GPU 均可，ASR/流式/VAD 全家桶在同一栈）→ 001 已有调研；可作为 App ASR 候选引擎（与 sensevoice-原始并列）。
- 二选一的标准：路线 A 出字 + 准确率/RTF 实测登记；若 A 的权重门禁/体积过重，退回 B（int8 轻量）。

## 三·补 本机可行性实测结论（2026-08-30，硬数字）

| 项 | 实测 |
|---|---|
| 官方依赖 | `requirements.txt` 全文仅 **`torch>=2.0.0`**；README 配置 `"use_gpu": 1`（torch.cuda）→ GPU 为标准路径 |
| 权重体积（HF tree 实测） | **AED-L 4.68GB**（model.pth.tar 4.66GB）/ **LLM-L 3.63GB** / **FireRedASR2-AED 4.73GB** |
| 显存 | 最大 4.73GB fp32 → **本机 4070 Ti 12GB 余量 >7GB，可跑**（fp16/bf16 更省） |
| 平台 | requirements 无系统依赖；torch CUDA Windows 原生支持 → **Win 本机可跑**（README 命令为 Linux 风格 conda/bash，Windows 同款 pip 即可） |
| 结论 | ✅ 本机可行，走本项目已踩熟的「独立 venv + CUDA torch（aliyun cu128 镜像）+ 权重整仓 + 字节校验」流程；轻量备选 = sherpa-onnx int8（CPU 亦可） |

## 四、独立验证步骤（顺序执行，每步停下汇报）
1. **源实测收尾**：仓库 README raw 拉取（安装命令原文）；许可读取；HF 三档权重字节清单（tree API）；ModelScope 是否镜像；评测/准确率数字（README or 卡解锁）落表。
2. **独立环境**：目录（如 `E:\Github\fireredasr\`）；torch CUDA（4070 Ti → cu128，镜像平铺探测坑 O）。
3. **权重/模型**：HF 直连或 hf-mirror 整仓 + 字节校验；**预下载**。
4. **验证**：对一段中文/方言音频跑官方脚本 → 出文字（文本可见即验收）；记录 RTF/准确率（按 repo 自带测试集或示例音频）。
5. **验收**：识别文本正确 + 汇报体积/耗时/RTF；流式版可选验证。
6. **坑映射（043 §一 8 条）**：同 044 §五.6。
7. **最后才回 App**：ASR 引擎三件套（engines json + INSTALLERS + 端口 + /transcribe 转发），或并入 sherpa-onnx 路线。

## 五、风险/待实测登记
- ⚠️ 模型卡 401（gated）→ 权重下载可能需要接受条款/带 token，先试匿名；评测数字以仓库 README 为准补录；sherpa-onnx int8 的具体模型 id/字节（sherpa 模型库实测）；方言覆盖清单（官方宣称方言+英语，具体方言表实测登记）。

## 五·补 047 踩坑映射（FireRedTTS3 部署经验移植，2026-08-30）

> 同 org 姊妹项目 FireRedTTS3 已独立部署完成（047），其 7 项实测坑对 FireRedASR 直接适用，执行前照此预案，不重复踩。

| 047 坑 | FireRedASR 对应风险 | 预案 |
|---|---|---|
| 坑1 沙箱 TLS（curl/Invoke-WebRequest 全断 SEC_E_NO_CREDENTIALS） | 源拉取/权重下载同环境 | **一切网络操作走 Python urllib(OpenSSL)**，勿用 curl |
| 坑2 磁盘满（下载中 No space left on device） | 权重 13GB（AED-L 4.68 + LLM-L 3.63 + 2-AED 4.73）+ venv ~7GB ≈ 20GB | 执行前查 E 盘余量（实测应 >25GB）；断点续传有效（清 0 字节残留重启即可） |
| 坑3 flash_attn→sdpa | ASR requirements 仅 `torch>=2.0.0`（046 已实测），**大概率无此坑** | 仍需 grep 代码确认无 `flash_attention_2` 硬编码；有则按 047 法改 `sdpa` |
| 坑4 torchaudio 无后端 | ASR 读音频同依赖 torchaudio | **venv 预装 soundfile**（torchcodec 豁免后必需） |
| 坑5 os error 1455（Windows 页文件耗尽） | AED/LLM/2-AED 为独立模型，一次只加载一个，风险低 | 仍建议分进程验证各档，避免同驻 |
| 坑6 官方代码打包/签名 bug | 推理脚本可能有官方代码不一致 | 遇 unpack/参数错误先读官方 llm 层真实签名再修（047 core.py 先例） |
| 坑7 GBK 控制台乱码 | 出字验收中文乱码 | 验收文本落盘 UTF-8 无 BOM，不依赖控制台显示 |

**流程口径（对齐 047）**：独立 venv（Python 3.12）+ CUDA torch cu128（aliyun 平铺镜像本地 wheel）+ 权重整仓 + 字节校验 + import 探针 + 分进程验证；modelscope 用 `modelscope.exe download`（`-m modelscope` 不可用）；pip 本地 wheel 安装须带 `--index-url aliyun` 解析依赖。

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-30 | 初版：FireRedASR 独立验证规划（存在性/效果依据/官方源/双路线 A·B/步骤/待实测）；归属=小红书 FireRedTeam |
| 2026-08-30 | 追加 §五·补：047 踩坑映射（7 坑预案 + 流程口径） |