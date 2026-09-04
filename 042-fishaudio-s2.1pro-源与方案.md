# 042 · FishAudio S2.1 Pro 实现方案（先把官方/镜像源全部实测找清，再谈实现）

> 目的：按用户要求——**先实测把 fishaudio 2.1 pro 的官方源与镜像源全部找清、登记成表，禁止猜测**，然后才给出云端/本地两条实现路线。
> 前置必读：038 §三（FishAudio 云端定案）、038 §五.2（源实测结果）、036（全链路规范）、007 §3.3（云端引擎定案）。
> 云端接入的既有规划已在 **`000-summary.md`（L81：fish.audio compat/v1 + s2-pro/s2.1-pro/s2.1-pro-free 三档）** 与 **`007-product-UI-models规划.md` §3.3（S2 专项）** 中定案，另有 `009`（云端引擎注册表通用架构）——**本文件不再重复云端实现细节，只引用**。
> 实测时间：2026-08-30（Win 本机，直连网络）。标 ⚠️ 的项为**本网络未能验证、必须换网络/代理再验**，绝不就此拍板。

---

## 一、源实测总表（全部实测，禁止再猜）

### 1.1 代码/文档源

| 源 | URL | 实测结果（2026-08-30） | 结论 |
|---|---|---|---|
| 官方 GitHub 仓库 | `https://github.com/fishaudio/fish-speech` | api.github.com：✅ 存在，default_branch=**main**，32.4k★；**git clone 直连被墙**（21s connect 超时，实测） | 仓库真实；直连慢/被墙 → 文件走 jsdelivr |
| jsdelivr CDN（文件镜像） | `https://cdn.jsdelivr.net/gh/fishaudio/fish-speech@main/<path>` | ✅ 实测拉到 README.md（官方安装入口指向 [[speech.fish.audio/install]]） | **本网络下官方源码/README 的最可靠通道** |
| 官方文档站 | `https://speech.fish.audio/install/` 等 | ❌ 直连超时（WinError 10060，实测） | 内容可从 README（jsdelivr）追溯；代理网络再验 |
| 官方在线体验/云 API | `https://api.fish.audio` | ⚠️ `https://api.fish.audio/v1/tts`、`/compat/v1/models` 均超时（本网络连不上 fish.audio 全线，实测） | **接入前必须先验证 api.fish.audio 可达性**（代理/海外网络），否则云端链路无从谈起 |

### 1.2 模型权重源（HF 镜像 = hf-mirror.com，实测）

| 模型仓 | 实测结果 | 用途/显存 |
|---|---|---|
| **fishaudio/s2.1-pro** | ❌ **HF 上不存在**（author=fishaudio 全量 50 个实测无此仓；全站 search "s2.1" 无此 id） | **S2.1 Pro = 云端 API 模型名（字符串），无公开本地权重** |
| `fishaudio/s2-pro` | ✅ 存在（pipeline=text-to-speech，下载 35.7 万） | S2（4B）本地权重；官方 BF16 ≈9.1GB，**需 NVIDIA ≥24GB**（本机 4070 Ti 12GB 不够） |
| `fishaudio/fish-speech-1.5` | ✅ 存在（author 列表实测命中） | 上一代本地 TTS（1.2B 级），**本机 12GB 可试本地路线** |
| `fishaudio/fish-speech-1.4 / 1.2-sft / 1.2 / 1 / s1-mini / speech-lm-v1 / fish-agent-v0.1-3b` | ✅ author 列表实测命中 | 旧版本档，观察备选 |
| 社区量化（s2.cpp 生态） | search "s2.1" 仅命中无关 GGUF（mradermacher/7ocho 等） | s2-pro 的 GGUF/量化另行验证（s2.cpp 官方仓库为准，参见 §二） |

### 1.3 Python 包源（PyPI 镜像，实测）

| 源 | 实测结果 | 结论 |
|---|---|---|
| aliyun PyPI `simple/fish-speech/` | ✅ HTTP 200；仅 `fish-speech-0.1.0` wheel | **不是官方常规分发渠道**（版本号明显占位级） |
| tuna PyPI `simple/fish-speech/` | ✅ HTTP 200；同 0.1.0 | 同上 |
| 官方 install 口径 | README 指向 `speech.fish.audio/install/`（jsdelivr 实测 README 链接） | 安装方式（pip 包名/源码自建）**待该页全文**（jsdelivr 拉 README 全文 + 代理网络拉 install 页） |

---

## 二、结论（定案）

1. **S2.1 Pro = 云端模型**：官方只给 API（模型名 `fishaudio/s2.1-pro`，另有免费档 `fishaudio/s2.1-pro-free`），**HF/ModelScope 上无权重仓** → 本地部署 S2.1 Pro **不存在**，不必再找。
2. **本地可部署的 Fish 系**（本机 4070 Ti 12GB）：
   - 首选观察：**fish-speech-1.5（1.2B）**——走 036 全链路范式（venv + CUDA torch + 模型整仓 + 独立端口），可实际跑通出声；
   - s2-pro（4B）需 ≥24GB 显存 → **非本机路线**，登记为"换硬件/s2.cpp GGUF 降低档"观察项；
   - s2.cpp（GGUF，CPU/Vulkan/CUDA/Metal）为 ALPHA 状态 → 观察项（后续单独调研登记）。
3. **云端接入（038 §三 细化，本机短期主路径）**：
   - 前置预检：**先验 `api.fish.audio` 可达 + /compat/v1 鉴权**（本网络 2026-08-30 连不上 → 需代理/换网后重验；过不了这一步就停在云端链路门外）；
   - 复用 cloud 引擎 `https://api.fish.audio/compat/v1`（OpenAI 兼容 `POST /v1/audio/speech`）；
   - **两个已登记坑**（007/038）：① `voice` 必须 Fish voice ID 或空串，OpenAI 预设名会 400；② 默认 `voice:'alloy'` 会静默命中真实 Fish 音色 → 接 S2 必须改默认值；
   - 免费档 `fishaudio/s2.1-pro-free` 先验链路 → 再切付费 `fishaudio/s2.1-pro`（$15/百万 UTF-8 字节）；
   - 许可：**FISH AUDIO RESEARCH LICENSE**（研究/非商用免费，商用需书面授权；云端按量付费不涉）→ UI 如实提示。
4. **接入步骤（App 内闭环，三件套）**：`engines/fish-cloud.json`（cloud 复用 + model 列表补 fishaudio/s2.1-pro / s2.1-pro-free / 默认 voice 修正）+ UI 云引擎配置页补 Fish model/voice 入口（KEY 复用现有云端 Key）+ 许可提示。本地 fish-speech-1.5 若做，另按 036 范式新引擎接入。

---

## 三、待实测登记清单（谁先做完谁才有资格动码；不许跳过）

- [ ] ⚠️ `api.fish.audio` 可达性 + `/compat/v1/models` 鉴权方式 + 免费档配额/限速（代理网络实测）
- [ ] Fish voice ID 的创建/获取方式（fish.audio 控制台）与 voice 参数格式（id/或空）
- [ ] 官方安装口径全文：jsdelivr 拉 README 全文 → 定位 install 链接指向的安装命令（pip 包名 or 源码自建 + torch 版本要求）
- [ ] fish-speech-1.5 模型整仓字节（hf-mirror 逐文件清单，动态清单用）
- [ ] s2-pro / s2.cpp GGUF 现状（≥24GB 路线与 ALPHA 工具链，登记为观察档检查点，不做本机安装）

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-30 | 初版：fishaudio 2.1 pro 官方/镜像源全实测表（代码/文档/权重/PyPI 四类）+ 定案（S2.1 Pro=云端模型名、HF 无权重仓；本地仅 fish-speech-1.5 可试；api.fish.audio 待代理验证）+ 云端接入细化 + 待实测登记清单 |