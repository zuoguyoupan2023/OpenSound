# 005 · CosyVoice 3.0 模型下载清单（手动预下载）

> 目的：004 §阶段 A 的克隆后端需要 CosyVoice 3.0（`Fun-CosyVoice3-0.5B`）模型。本文给出**需手动下载的文件与命令**，让你提前把 ~9GB 下好，避免编码完成后卡在下载。模型下好后告诉我，我再继续写后端（`cosyvoice-tts-server.py` + asr-server 接入）。
> 衔接：004-voice-clone规划.md（克隆引擎=CosyVoice 3.0）。
> **2026-08-26 更新（S5）**：模型管理页现已支持**自动下载缺失的必需权重**——点「安装」会先弹二次确认（约 4.4GB，hf-mirror→huggingface 多镜像、.part 断点续传）。本文的手动方案保留，作为自动下载失败时的兜底路径。

---

## 〇、先看：磁盘是否够（⚠️ 关键）

| 项 | 值 |
|---|---|
| 当前空闲 | **约 5.1GB**（`df /` 实测） |
| 全量下载需 | **约 9.1GB** |
| 最小运行集需 | **约 7GB**（见 §二） |

> **结论：当前空闲不够。** 全量/最小下载前请先清理磁盘到 **≥9.5GB**（推荐全量）。若无法腾出，也可用 §二 的「最小集」（约 5GB，**风险是仍可能超出** 5.1GB，建议至少腾到 7GB）。

---

## 一、模型来源与存放位置

- **HF 仓库**：`FunAudioLLM/Fun-CosyVoice3-0.5B`
- **下载镜像**：`hf-mirror.com`（国内直连，已验证可用）
- **存放目录（后端预期路径，勿改）**：
  ```
  asr-server/models/cosyvoice/Fun-CosyVoice3-0.5B/
  ```

---

## 二、下载命令

在**仓库根目录**执行。二选一：

### 方案 A · 全量（推荐，~9.1GB）

```bash
DEST=asr-server/models/cosyvoice/Fun-CosyVoice3-0.5B
HF_ENDPOINT=https://hf-mirror.com hf download FunAudioLLM/Fun-CosyVoice3-0.5B --local-dir "$DEST"
```

### 方案 B · 最小运行集（~5GB，跳过可选 onnx 加速与 rl 冗余）

```bash
DEST=asr-server/models/cosyvoice/Fun-CosyVoice3-0.5B
HF_ENDPOINT=https://hf-mirror.com hf download FunAudioLLM/Fun-CosyVoice3-0.5B --local-dir "$DEST" \
  --include \
    "llm.pt" "llm.rl.pt" "flow.pt" "hift.pt" \
    "speech_tokenizer_v3.onnx" "campplus.onnx" \
    "cosyvoice3.yaml" "config.json" "configuration.json" \
    "CosyVoice-BlankEN/*" "README.md"
```

> 说明：`hf` 命令本机已装（huggingface_hub 0.34）。断点续传、多线程，重跑即可补齐；中途中断重跑同一条命令即可续传。

---

## 三、文件清单与大小（全量）

| 文件 | 大小 | 作用 / 是否必需 |
|---|---|---|
| `llm.pt` | 1.9GB | LLM 主干 · **必需** |
| `llm.rl.pt` | 1.9GB | RL 微调 LLM 变体 · 常需 |
| `flow.pt` | 1.2GB | flow 声学模型 · **必需** |
| `flow.decoder.estimator.fp32.onnx` | 1.2GB | flow 解码器 onnx 加速 · 可选（无则用 flow.pt） |
| `speech_tokenizer_v3.onnx` | 924MB | 语音 tokenizer · **必需** |
| `speech_tokenizer_v3.batch.onnx` | 924MB | 批量版 · 可选 |
| `CosyVoice-BlankEN/model.safetensors` | 942MB | 英文 blank 音色 · 建议留 |
| `hift.pt` | 79MB | HiFT 声码器 · **必需** |
| `campplus.onnx` | 27MB | 说话人编码器（克隆用）· **必需** |
| `cosyvoice3.yaml` / `config.json` / `configuration.json` | 小 | 模型配置 · **必需** |

**合计 ≈ 9.1GB**。

---

## 四、下载后校验

```bash
# 应看到关键权重齐全
ls -lh asr-server/models/cosyvoice/Fun-CosyVoice3-0.5B/llm.pt \
        asr-server/models/cosyvoice/Fun-CosyVoice3-0.5B/flow.pt \
        asr-server/models/cosyvoice/Fun-CosyVoice3-0.5B/hift.pt \
        asr-server/models/cosyvoice/Fun-CosyVoice3-0.5B/speech_tokenizer_v3.onnx \
        asr-server/models/cosyvoice/Fun-CosyVoice3-0.5B/campplus.onnx
```

---

## 五、还需要什么（我编码阶段处理，不必你下）

1. **CosyVoice 源码仓库**（`cosyvoice` python 包 + `third_party/Matcha-TTS` 子模块）——后端 `cosyvoice-tts-server.py` 依赖它 import。
2. **Python 虚拟环境**（`.venv-cosyvoice`，复用系统 torch，仿 `.venv-qwen3`）。
3. 以上两点在**模型下好、你确认后**我继续搭建，避免边下边改。

---

## 下一步

模型下载完成后告诉我，我按 004 §阶段 A 继续：写 `cosyvoice-tts-server.py`、asr-server 接入 `/clone`、Rust 注入音频目录、GUI 从模拟切到真实后端。
