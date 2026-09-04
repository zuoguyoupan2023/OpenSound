# 045 · 本地部署规划：FireRedTTS（小红书 FireRedTeam，1S / 2 / 3）

> 目的：FireRedTTS 系列**独立本地部署**（先源/路径/出声，最后回 App）。纪律见 043 §一；总清单见 043 §〇 #8。
> 归属实测纠正：**FireRedTeam = 小红书 Super Intelligence 部门下属基础算法实验室**（GitHub org 描述原文，2026-08-30）——不是小米。
> 实测：2026-08-30。官方 README 存档：`043-ref-readmes/FireRedTTS3-README.md`、`FireRedTTS-1S-README.md`。

---

## 一、版本选择（第 0 步：用户定方向）

| 版本 | 官方仓库 | 权重 | 安装特征（README 原文） | 备注 |
|---|---|---|---|---|
| **FireRedTTS-1S（经典）** | `FireRedTeam/FireRedTTS`（919★，分支 `fireredtts-1s`） | HF 有 | conda **python 3.10** + `conda install pytorch==2.3.1 torchvision==0.18.1 torchaudio==2.3.1 pytorch-cuda=11.8(或12.1)` + `pip install -e .` + `pip install -r requirements.txt` | 老牌稳定 |
| FireRedTTS2 | `FireRedTeam/FireRedTTS2`（1430★） | HF 有 | —（同族） | 中档 |
| **FireRedTTS3（官方最新，推荐）** | `FireRedTeam/FireRedTTS3`（232★，main） | **HF + ModelScope 双有** | `pip install -r requirements.txt`；模型首选 **ModelScope**：`modelscope download --model FireRedTeam/FireRedTTS3 --local_dir pretrained_models/`；依赖 CAM++（modelscope `iic/speech_campplus_sv_en_voxceleb_16k`） | 最新；国内镜像最顺 |

> 默认推荐 **TTS3**（代码最新 + ModelScope 整仓镜像 + 讲中文直连 modelscope 快）。要 1S/2 写明即可，同法。

## 二、官方源（2026-08-30 实测）

| 源 | 地址 | 实测 |
|---|---|---|
| 官方仓库 | `github.com/FireRedTeam/FireRedTTS3`（main）；`FireRedTeam/FireRedTTS`（fireredtts-1s）；`FireRedTeam/FireRedTTS2` | ✅ 三者均在；README raw 拉取成功 |
| HF 权重 | `FireRedTeam/FireRedTTS3` 等 | ✅ 存在 |
| **ModelScope 权重** | `FireRedTeam/FireRedTTS3`（**整仓 18 文件，20.78GB**） | ✅ repo/files API 实测 |
| CAM++（依赖） | modelscope `iic/speech_campplus_sv_en_voxceleb_16k` | ✅ README 点名 |
| 许可 | **TTS3：Apache License（raw LICENSE 首行实测）**；1S/2 待 raw 读确认 | ✅ |

## 三、模型体积（已实测，ModelScope 整仓 FireRedTTS3）
- 18 文件共 **20.78GB**：`fireredtts3_base/model.safetensors` 8.48GB + `fireredtts3_instruct/model.safetensors` 8.48GB + `redae/model.safetensors` 3.78GB + `campp/campplus_voxceleb.bin` 29.4MB + `text_tokenizer/`（11.4MB+2.8MB）+ 其余。
- **推理通常只需 base **或** instruct 一档 + redae + campp + text_tokenizer（≈12.4GB fp32 → bf16 ~6.2GB，12GB 显存可行）**；是否整仓 20.78GB 全下，按官方 README 推理入口实测判定（043 纪律 5 + 036 铁律 13：标"可选"必须 grep 零引用）。

## 四、独立部署步骤（顺序执行，每步停下汇报）
1. **源实测收尾**：定版本 → README 细读推理入口/参数；requirements.txt 的 torch 版本（TTS3）；ModelScope/HF 整仓字节清单落表；1S/2 许可 raw 读取登记。
2. **独立环境**：目录（如 `E:\Github\fireredtts3\`）；TTS3 = `pip install -r requirements.txt`（PyPI 镜像 aliyun/tuna）+ CUDA torch 按 requirements（4070 Ti → cu128；镜像平铺探测，坑 O）；1S = conda py3.10 + torch2.3.1（cu121 镜像）。
3. **模型**：TTS3 走 **ModelScope 整仓**（国内快，实测字节校验）；CAM++ 一并预下载；**预下载**（036 坑 F 禁止运行时拉）。
4. **验证**：官方推理脚本出声 + import 探针（防空壳）。
5. **验收**：出声 wav 可播放；汇报 torch/cuda、模型体积清单、耗时。
6. **坑映射（043 §一 8 条）**：同 dots.tts（044 §五.6）。
7. **最后才回 App**：三件套，参考 041。

## 五、风险/待实测登记
- ⚠️ 20.78GB 下载量确认（整仓 vs 最小运行集，按推理入口 grep 判定并登记）；TTS3 推理入口（README 存稿细读后补全命令）；1S/2 许可；TTS3 与 1S 的 torch 差异（2.3.1 vs requirements 版本）两条路线不混。

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-30 | 初版：FireRedTTS 系列独立部署规划（版本三选/官方源/ModelScope 20.78GB 实测/步骤/坑映射/待实测）；归属纠正为小红书 FireRedTeam |