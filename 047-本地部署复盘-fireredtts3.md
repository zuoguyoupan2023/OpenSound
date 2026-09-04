# 047 · 本地部署复盘：FireRedTTS3（2026-08-30 实机全流程 + 踩坑账本）

> 定位：FireRedTTS3 独立本地部署（E:\Github\fireredtts3\）从零到出声的**全流程复盘**，含逐坑记录与修正后口径。
> 前置材料：规划 = 045；纪律 = 043 §一；官方 README 存档 = 043-ref-readmes/FireRedTTS3-README.md。
> 版本：**TTS3**（main 分支，Apache-2.0）；1S/2 未部署（许可已登记，见 §7）。

---

## 一、总体结论（先看这个）

- ✅ **部署成功，4 类任务全部真合成出声**（24kHz wav，非空壳）。
- 环境：`E:\Github\fireredtts3\.venv`（Python 3.12.3）+ `pretrained_models/` 整仓 20.78GB + 官方源码 43 文件。
- 硬件：RTX 4070 Ti 12GB + 32GB RAM；torch **2.8.0+cu128**，CUDA 12.8，`cuda.is_available()=True`。
- 性能：Base 克隆 RTF≈30（274.7s/9.1s）；Instruct ICL 含 CoT 文本生成 ≈ 1890s/11.7s。12GB 显存满载（11.8/12.3GB）。
- **官方无 WebUI**（仓库无 webui/gradio 脚本，README 仅 Python API）——需要界面须自建（见 §9 建议，未执行）。

## 二、安装口径（实测修正后，与 045 一致并细化）

| 环节 | 做法（本机实测） | 关键点 |
|---|---|---|
| 目录 | `E:\Github\fireredtts3\`（全新，不碰 App） | 沙箱/权限外，注意磁盘空间 |
| venv | 系统 Python 3.12 建 `.venv` | torch wheel 为 cp312-win_amd64，版本必须对齐 |
| torch | aliyun pytorch-wheels cu128 **平铺镜像**下载本地 wheel → pip 本地安装 | `torch-2.8.0+cu128-cp312-cp312-win_amd64.whl` 3,461,384,651 B；URL 用 `+` 解码形式；**裸 pip 会装 CPU 版**（requirements 无 `+cu` 后缀） |
| PyPI 依赖 | aliyun simple 镜像：transformers==5.6.2 / einops==0.8.2 / dotenv==0.9.9 / wetext==0.1.7 / regex | 装后 import 探针全过 |
| 源码 | jsdelivr 逐文件拉 43 个（fireredtts3/ 包 + 24 语言模板 + LICENSE 等） | 仓库无 pyproject/setup.py，包以源码目录方式运行（sys.path 指向仓库根） |
| 模型 | `modelscope download --model FireRedTeam/FireRedTTS3 --local_dir pretrained_models` | 整仓 13 文件 19.35 GiB（20.78GB），运行文件字节校验 10/10 |
| 辅助件 | `lid.176.ftz`（938,013 B）预下载到 `fireredtts3/utils/llm_tn/models/` | 禁运行时拉（036 坑 F）；CAM++ 已在整仓内 |

**requirements.txt 官方原文（144B，登记）**：
```
torch==2.8.0 / torchaudio==2.8.0 / torchcodec==0.7.0 / flash_attn==2.8.3
transformers==5.6.2 / einops==0.8.2 / dotenv / regex / wetext / fasttext / faster-whisper
```

**依赖豁免登记（grep 零引用证明，036 铁律 13）**：

| 包 | 判定 | 证据 |
|---|---|---|
| torchcodec | ⏭️ 豁免 | 全源码 grep 零引用；且 0.7.0 无 cp312-win wheel |
| faster-whisper | ⏭️ 豁免 | 全源码 grep 零引用 |
| flash_attn | ⏭️ 豁免+适配 | Windows 无 wheel；仅 `_supports_flash_attn=True` 特征标志 → 改 sdpa |
| fasttext | ⏭️ 豁免 | 无 win wheel（源码编译失败）；代码 try/except 容错 + 汉字/假名回退 |

## 三、推理入口（README + core.py 实测原文）

```python
from fireredtts3.core import FireRedTTS3, FireRedTTS3Instruct
# Base 克隆/方言：language 传 None=自动，或显式 "ZH_Sichuan" 等 21 方言 / 24 语言 tag
tts = FireRedTTS3("pretrained_models", use_wetext=True, use_llm_tn=False)
gen_audio, gen_sr = tts.generate(language="ZH_Sichuan", prompt_text=..., prompt_audio=..., prompt_audio_sr=..., text=..., do_tn=True)
torchaudio.save("gen.wav", gen_audio.cpu(), gen_sr)
# Instruct 造音色（无参考音频）
instruct = FireRedTTS3Instruct("pretrained_models", use_wetext=True, use_llm_tn=False)
gen_audio, gen_sr, gen_text = instruct.generate_voice_design(instruction="一个年轻女性的温柔嗓音，语速稍慢，带一点俏皮。", text=...)
# Instruct ICL 克隆 / 语义编辑 / 声学编辑见 README §Instruct API
```

## 四、验收结果（实测数字）

| 输出 | 任务 | 耗时 | 时长 | 字节 |
|---|---|---|---|---|
| out/base_clone_zh.wav | Base 中文零样本克隆 | 274.7s | 9.1s | 875,600 |
| out/base_dialect_sichuan.wav | Base 四川话方言克隆 | 466.7s | 17.1s | 1,643,600 |
| out/instruct_design.wav | Instruct 指令造音色 | 143.7s | 2.9s | 276,560 |
| out/instruct_icl_zh.wav | Instruct ICL 克隆 | 1,890.7s | 11.7s | 1,121,360 |

- prompt 参考：IndexTTS 官方示例 `voice_01.wav`（2.4s @48kHz），文本「欢迎大家来体验indextts2，并给予我们意见与反馈，谢谢大家。」
- 模型加载：Base 5.9s / Instruct 5.6s（独立进程）。
- Instruct 造音色输出 voice plan CoT（性别/年龄/音色/情绪属性标签）✅。

## 五、性能基线（4070 Ti 12GB 登记，供 App 集成参考）

- 显存：推理时 11,709–11,845/12,282 MiB，满载。fp32 权重驻留 + bf16 autocast 推理。
- Base AR 逐 patch 串行（最长 400 步）× DiT 流匹配（默认 n_timesteps=10）= 慢主因；无 flash-attn（sdpa）。
- 提速方向：大显存（A100/H100 官方基准）、降 n_timesteps、编译 triton/换 eager。

## 六、踩坑账本（本会话实踩，按顺序）

| # | 坑 | 现象/根因 | 解决（最终口径） |
|---|---|---|---|
| 1 | **沙箱 TLS 全断** | curl(schannel)/Invoke-WebRequest 全部 `SEC_E_NO_CREDENTIALS`；TCP 443 通但 TLS 层拿不到凭据 | 全部网络操作用系统 Python urllib（OpenSSL 栈）✅ |
| 2 | **磁盘满** | modelscope 并发下载 3 大文件瞬时峰值吃穿 E 盘 → `No space left on device`，.incomplete 中断 | 腾空间 → 清 0 字节残留 → 重启续传（断点续传有效，redae 先完成） |
| 3 | **flash_attn 缺包** | transformers 加载报 `FlashAttention2 ... doesn't seem to be installed` | 3 处官方源码 `flash_attention_2`→`sdpa`：redae.py L37/L122、fireredtts3_base.py L49（模型类均 `_supports_sdpa=True`，官方可降级） |
| 4 | **torchaudio 无后端** | `Couldn't find appropriate backend to handle uri ... .wav`（torchcodec 豁免后无解码器） | 补装 `soundfile`（torchaudio 2.8 的轻量后端） |
| 5 | **os error 1455** | 同一进程加载 Base+Instruct+redae（~20GB 权重 CPU 中转 + GPU 12GB）→ Windows 页文件耗尽 | **拆分独立进程**：Base 一个脚本、Instruct 一个脚本（Instruct 不需要 Base，符合"一档+redae"最小集） |
| 6 | **官方 core.py 打包 bug** | `ValueError: not enough values to unpack (expected 3, got 2)` | 官方 core.py L384 按 3 值解包 `super().generate_tts`，后端 llm_fireredtts3_instruct.py L392 实际返回 2 值 → 改 2 值解包 |
| 7 | 控制台乱码 | wav 验收/voice plan 打印中文乱码 | GBK 控制台显示问题，文件内容正常（UTF-8 无 BOM 落盘） |

> 另记：modelscope `-m modelscope` 不可用（包无 __main__），用 `modelscope.exe download` 命令；pip 本地 wheel 安装须带 `--index-url aliyun` 让依赖（sympy/nvidia-* 等）可解析，纯 `--no-index` 会失败。

## 七、许可登记（raw LICENSE 原文实测）

| 版本 | 许可 | 备注 |
|---|---|---|
| **TTS3** | **Apache-2.0** | ✅ 已部署 |
| **1S** | **MPL-2.0**（修正 045 待确认项，首次实测） | 未部署；商用注意 copyleft |
| **2** | **Apache-2.0** | 未部署 |

## 八、与规划文档 045 的出入修正

1. 045 §二「1S/2 许可待 raw 读确认」→ **已实测：1S=MPL-2.0、2=Apache-2.0**。
2. 045 §三「推理只需 base 或 instruct 一档 + redae + campp + tokenizer」→ 实测确认加载断言，但**任务要求两档都演示 → 整仓全量 20.78GB**；另因内存峰值，两档不可同进程驻留，须分进程。
3. 045 §四「TTS3 = pip install -r requirements.txt」→ 修正为：torch/torchaudio 走 aliyun cu128 平铺镜像本地 wheel，其余走 aliyun PyPI；torchcodec/faster-whisper/flash_attn/fasttext 豁免（§二）。
4. 新增坑：flash_attn→sdpa、soundfile、os error 1455、core.py 打包 bug（§六）。

## 九、WebUI 结论与建议（待用户决策）

- **官方无 WebUI**：TTS3 仓库 43 文件无 webui/gradio 脚本；README 仅 Python API；1S 仓库同样无。
- 第三方：pyvideotrans 的 gradiowin 渠道声明支持 FireRed3-TTS（未验证）；无官方/成熟社区 WebUI。
- **建议**：如需界面，自建轻量 Gradio WebUI（复用已装 venv 的 transformers/torch 栈，另装 gradio），提供：Base 克隆（上传参考音频+文本）、方言下拉、Instruct 造音色（指令输入）、ICL 克隆；端口独立（如 8005）。**是否执行由用户确认**（未做，不碰 App）。

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-30 | 初版：FireRedTTS3 全流程部署复盘（安装口径/推理入口/验收/性能/6+1 坑账本/许可/045 出入修正/WebUI 结论）。来源：实机执行 + 045 规划 + 043-ref-readmes 存档 |