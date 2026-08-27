# 001 · ASR / STT 全景调研（云端 API + 本地开源 + 本项目现状）

> 回答一个问题：**语音识别（ASR/STT）到底有哪些选择——云端 API 多少钱、本地开源模型哪些能打、本项目现在用的是什么、下一步该接什么？**
> 口径：2026-08-26 · 关联文档：`000` §五（阿里 ISI 价格已详录）、`002-voice-research.md`（中文 CER 排行榜与 sherpa-onnx 清单的原始出处）、`007`（模型库规划）、`009`（智谱 GLM-ASR 接入方案）、`001`（自托管架构）
> 原则：**能从官方页面核实的给数字；核实不了的标 ⚠️，绝不编数。**

---

## 目录

1. [结论速览](#一结论速览)
2. [本项目现状](#二本项目现状asr-server-已接引擎)
3. [中文精度基准](#三中文精度基准引自-002)
4. [云端商用 API 价格总表](#四云端商用-api-价格总表)
5. [国内云端 API 专项](#五国内云端-api-专项)
6. [本地开源部署矩阵](#六本地开源部署矩阵)
7. [选型建议](#七选型建议结合本项目)
8. [参考链接](#八参考链接)

---

## 一、结论速览

| 维度 | 判定 |
| --- | --- |
| 中文精度天花板 | 开源本地已超越 Whisper：FireRedASR2（小红书）＞ Paraformer/SenseVoice（阿里）＞＞ Whisper-large-v3（002 榜单口径） |
| 最便宜的云端转写 | Groq Whisper-Large-V3-Turbo ≈ **$0.0006/分钟**（≈$0.036/小时）；正经商业 SLA 里 Deepgram Nova-3 batch $0.0036/min 性价比最佳 |
| 国内云端首选 | 智谱 `glm-asr` ≈¥0.06/分钟（支持 SSE 流式、8 方言、热词，009 已定 P1 接入方案） |
| 本地默认 | SenseVoice-Small（239MB sherpa int8，CPU 实时率<0.1）——本项目现役默认引擎 |
| 明确不做 | 系统 ASR：macOS 听写是系统 UI 层能力、Windows COM 质量差（009 §4.5 已论证） |

---

## 二、本项目现状（asr-server 已接引擎）

| 引擎 | 形态 | 体积 | 状态 |
| --- | --- | --- | --- |
| **SenseVoice**（sherpa-onnx 量化版） | 本地 · CPU/MPS（:8002） | ~228–239MB | ✅ 默认引擎，中英日韩粤 |
| **SenseVoice**（FunASR 原始版） | 本地 | ~897MB | ✅ 已装，高精度档 |
| **Whisper**（transformers.js） | 本地兜底 | base ~500MB | ✅ 已装，首次识别自动下载 |
| 云端识别（azure / openai / aliyun） | 未接 | — | GUIDE 提及后端可透传，尚未实现；009 规划了 `zhipu-asr` 引擎为 P1 |

调用方式：`POST :9528/transcribe?engine=auto|sensevoice|whisper`（auto = SenseVoice 优先）。规格要求 WAV/RAW PCM 16kHz 单声道。

---

## 三、中文精度基准（引自 002）

> 原始出处：[FireRedASR 官方 README](https://github.com/FireRedTeam/FireRedASR)（arXiv:2501.14350）；Average-4 = aishell1/aishell2/ws_net/ws_meeting 平均 CER，越低越好。

| 模型 | 参数量 | 开源 | aishell1 | Avg-4 |
| --- | --- | --- | --- | --- |
| FireRedASR-LLM（小红书） | 8.3B | ✅ | **0.76** | **3.05** |
| FireRedASR-AED | 1.1B | ✅ | 0.55 | 3.18 |
| SenseVoice-Large | 1.6B | ❌仅Small | 2.09 | 4.47 |
| Paraformer-Large（阿里） | 0.2B | ✅ | 1.68 | 4.56 |
| Whisper-Large-v3 | 1.6B | ✅ | 5.14 | 9.86 |

2026 新榜（FireRedASR2S，24 测试集含 19 方言）：FireRedASR2 系列 ＞ Qwen3-ASR-1.7B（开源）＞ Fun-ASR。**结论：中文场景国产开源全面领先，Whisper 只当多语种兜底。**

---

## 四、云端商用 API 价格总表

> 国际部分来自 [Awesome Agents 2026-04 价格对比](https://awesomeagents.ai/pricing/transcription-api-pricing/)（逐厂商核验口径），换算：$0.006/min = $0.36/小时。免费额度多为平台级 credit 而非永久额度。

| 厂商 / 模型 | $/分钟 | $/千分钟 | 流式 | 免费额度 | 备注 |
| --- | --- | --- | --- | --- | --- |
| **Groq** Whisper-Large-V3-Turbo | **≈$0.0006** | $0.60 | ❌ | 有 | 全场最便宜（按推理时长折算 ⚠️实际账单随音频浮动） |
| Together AI / Fireworks Whisper-v3 | ≈$0.001 | $1.00 | ❌ | Credits | 自托管 whisper 的算力批发价 |
| **Deepgram** Nova-3 batch / streaming | $0.0036 / $0.0056 | $3.60/$5.60 | ✅ | $200 credit | 对比文评定的"最佳性价比" |
| **AssemblyAI** Universal batch | $0.0037 | $3.70 | 另付 | $50/月 | Streaming $0.0074；Slam-1 $0.01 |
| **ElevenLabs Scribe** | $0.004 | $4.00 | ❌ | 有 | **说话人分离不额外收费**（别家多要加钱） |
| **OpenAI** gpt-4o-mini-transcribe | $0.003 | $3.00 | ✅ | $5 trial | 比 whisper-1 便宜一半、干净音频精度相当 |
| OpenAI gpt-4o-transcribe / whisper-1 | $0.006 | $6.00 | ✅/❌ | $5 trial | 噪声/口音更稳；单请求 ≤25MB 需分段 |
| Google Chirp 2 / Chirp 3 (HD) | $0.0048 / $0.016 | $48/$160 每千分 | ✅ | $300 credit | HD 档贵 3 倍+ |
| Azure Speech Standard / Custom | $0.016 / $0.027 | $16/$27 | ✅ | **5 小时/月** | Custom 需先做定制模型 |
| Speechmatics Enhanced | $0.0082 | $8.20 | ✅ | 联系销售 | 英欧市场强 |
| AWS Transcribe standard / Medical | $0.024 / $0.075 | $24/$75 | ✅ | 60 分钟/月 | 传统云厂最贵一档 |
| Rev.ai 机器 / 人工 | $0.02 / $1.50 | — | ✅ | ❌ | 人工转录是另一个物种 |

---

## 五、国内云端 API 专项

| 服务商 | 产品/模型 | 价格 | 流式 | 免费额度 | 备注 |
| --- | --- | --- | --- | --- | --- |
| **智谱 GLM** | `glm-asr` / `glm-asr-2512` | **≈¥0.06/分钟**（≈¥3.6/h） | ✅ SSE | 有试用 | 中英混 + 8 方言 + 热词；`POST /api/paas/v4/audio/transcriptions`（009 已给出完整接入方案） |
| **阿里云 ISI** | 实时识别 | 国际站 $1.40/h 起（量大至 $0.70）；国内资源包 ≈¥3.33→1.8 元/h | ✅ | 商用版无免费额；试用版 4 服务各 3 个月并发≤2 | 一句话识别按千次计费；录音文件 $1/h 起——**计费暗坑详见 000 §五原文** |
| **腾讯云** | 一句话识别 / 实时 / 录音文件 | ⚠️官方文档 JS 渲染未抓到单价 | ✅ | 有月度免费额度 ⚠️ | 与"阿里一句话识别"对位，可作冗余通道；接入前查控制台 |
| **讯飞** | 流式听写 | ⚠️按套包计费未抓到单价 | ✅ | 试用每日 500 次（服务说明原文） | 合规友好；方言/英文另选发音人体系外的识别产品 |
| **火山豆包** | 流式语音识别大模型 | ⚠️待核验 | ✅ | 新用户赠送 | 大模型版识别在噪声/口语上表现好，价格需控制台确认 |
| **Fish Audio** | ASR 转写 | **$0.36/小时** | — | ❌ | 顺手挂在 TTS 平台下，便宜但非主打 |

---

## 六、本地开源部署矩阵

> 体积/接入状态与 002/007 的实测登记对齐；许可列凡未亲手复核的一律标 ⚠️（接入时必须看仓库 LICENSE 与模型卡双确认）。

| 模型 | 参数/体积 | 中文档位 | 许可 | 部署形态 | 硬件要求 | 本项目状态 |
| --- | --- | --- | --- | --- | --- | --- |
| **SenseVoice-Small** | 239MB(sherpa int8) / 897MB(原始) | ★★★★☆（自带情感/事件标注） | ⚠️仓库与权重分别复核 | sherpa-onnx / funasr-python | CPU 即实时（RTF<0.1） | ✅ **默认引擎** |
| **Paraformer-large** | 0.2B / ~226MB(sherpa) | ★★★★★·真流式可用 | FunASR 代码 Apache-2.0；权重 ⚠️逐个核对 | sherpa-onnx / funasr | CPU 可跑 | 🔶 候选（中文实时） |
| **FireRedASR-AED** | 1.1B | ★★★★★ SOTA 级 | ⚠️复核 | PyTorch / sherpa-onnx int8（2026-02 版） | GPU 舒适，CPU 勉强 | 🔶 候选（精度第一梯队） |
| FireRedASR-LLM / FireRedASR2S | 8.3B / 一体化四模块 | 中文+方言 SOTA | ⚠️复核 | sherpa-onnx（AED/CTC） | 显卡 | 🔶 观察（太重） |
| **Qwen3-ASR** | 0.6B int8 / 1.7B | 30 语 + 22 方言 | Qwen 系通常 Apache-2.0 ⚠️复核 | sherpa/transformers | 边缘可跑 | 🔶 候选（方言场景） |
| **Whisper large-v3** | 1.6B | ★★★（CER 9.86） | MIT | transformers.js / faster-whisper / whisper.cpp | Mac Metal 或 CUDA | ✅ 兜底已装（base） |
| faster-whisper large-v3(int8) | ~3GB 显存 | 同 whisper | MIT | CTranslate2 | int8 后 12GB 卡轻松同驻 | 001 自托管高质量档 |
| Fun-ASR / FunASR-Nano | 很小 | 7 方言 + 26 口音 | ⚠️复核 | funasr | CPU | 🔶 候选（省资源） |
| 浏览器端 Whisper(base) | 75–140MB | 一般 | MIT | transformers.js(WebGPU/WASM) | 用户浏览器 | ✅ 已装 |
| 浏览器端 SenseVoice | 239MB | 同本地版 | 同上 | sherpa-onnx WASM | 用户浏览器 | 🔶 002/017 论证过可行 |

> 英文向的 Parakeet/Canary/Moonshine 不进中文主线，仅备注存在。

---

## 七、选型建议（结合本项目）

1. **本地默认保持 SenseVoice**；方言/噪声补强按 002 排序接 **FireRedASR2（int8，sherpa 同栈）**，再往后排 Paraformer-zh 流式、Qwen3-ASR——三者都只需在 `ASR_ENGINES` 注册 + `/install-model` 加下载器；
2. **云端兜底首选智谱 `glm-asr`**（009 的 P1 方案照抄即可）：¥0.06/分钟买方言和热词，作为本地识别置信度低时的回退通道；海外文本场景备 OpenAI gpt-4o-mini-transcribe（$0.003/min 且带流式）；
3. **自托管对外（001 场景）**：SenseVoice-CPU 扛免费流量 + faster-whisper int8 高质量档，与 001 §三推荐组合一致；
4. **成本心算表**：1 小时音频 → Groq $0.036 / gpt-4o-mini $0.18 / Deepgram $0.216 / 智谱 ¥3.6 / Azure $0.96——**本地 SenseVoice ≈ ¥0**，这就是本项目坚持"本地优先"的经济学依据；
5. **不做系统 ASR**（009 §4.5 结论维持）：macOS 听写无命令行入口、Windows COM 质量差且配置繁琐。

---

## 八、参考链接

- STT 国际价格对比（2026-04 核验口径）：https://awesomeagents.ai/pricing/transcription-api-pricing/
- 智谱 glm-asr 接入方案：本项目 `009-云端语音API与系统语音引擎.md`
- 阿里 ISI 计费暗坑原文：本项目 `000-device-tts.md` §五
- 中文 CER 排行榜出处：https://github.com/FireRedTeam/FireRedASR · https://github.com/FireRedTeam/FireRedASR2S
- sherpa-onnx 模型清单：https://github.com/k2-fsa/sherpa-onnx · https://k2-fsa.github.io/sherpa/onnx/FireRedAsr/index.html
- Fish Audio ASR 定价：https://tokenmix.ai/blog/fish-audio-tts-api-pricing-voice-cloning-2026
- 待核验项（JS 渲染页面）：腾讯云 ASR 计费概述 https://cloud.tencent.com/document/product/1093/35686 、火山豆包语音识别 https://www.volcengine.com/product/tts

---

## 九、变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-08-26 | 初版：整合 000/002/007/009 散落的 ASR 信息成单文档；新增国际 STT API 价格总表（Groq/Deepgram/AssemblyAI/ElevenLabs/OpenAI/Google/Azure/AWS 等 14 家）与国内专项（智谱/阿里/腾讯/讯飞/火山/Fish）；本地开源部署矩阵与选型建议 |
