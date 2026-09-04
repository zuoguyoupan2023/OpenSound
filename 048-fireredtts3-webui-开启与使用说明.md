# FireRedTTS3 本地 WebUI — 开启与使用说明（2026-08-30）

> 官方 FireRedTTS3 **无 WebUI**（README 仅 Python API）。本 WebUI 为本地独立部署的自建轻量界面（Gradio 6.26），复用已验证的推理环境，**与 App 完全独立**。
> 部署复盘见 `047-本地部署复盘-fireredtts3.md`；依赖环境见 `E:\Github\fireredtts3\`。

## 一、前置条件（已就绪，无需再装）

| 项 | 位置/版本 |
|---|---|
| venv | `E:\Github\fireredtts3\.venv`（Python 3.12.3） |
| torch | 2.8.0+cu128（CUDA 12.8，RTX 4070 Ti 12GB） |
| 模型 | `E:\Github\fireredtts3\pretrained_models\`（整仓 20.78GB，已字节校验） |
| WebUI 脚本 | `E:\Github\fireredtts3\webui_fireredtts3.py` |
| gradio | 6.26.0（已装） |
| 端口 | **8005**（独立，不与 App 端口冲突） |

## 二、如何开启

**方式 A：直接命令行（推荐）**
```powershell
E:\Github\fireredtts3\.venv\Scripts\python.exe E:\Github\fireredtts3\webui_fireredtts3.py
```
看到 `Running on local URL: http://127.0.0.1:8005` 即启动成功，浏览器自动打开。

**方式 B：后台启动（不占当前终端）**
```powershell
Start-Process -FilePath "E:\Github\fireredtts3\.venv\Scripts\python.exe" `
  -ArgumentList "-u","E:\Github\fireredtts3\webui_fireredtts3.py" -WindowStyle Hidden
# 验证：Get-NetTCPConnection -LocalPort 8005 -State Listen
# 停止：Get-NetTCPConnection -LocalPort 8005 -State Listen | % { Stop-Process $_.OwningProcess -Force }
```

## 三、界面功能（三个标签页）

### Tab 1「Base 克隆 / 方言」— 零样本克隆 + 24 语种 + 21 中文方言
1. **参考音频**：上传 3–10 秒人声 wav（音色来源）。已预置 IndexTTS 官方示例 `voice_01.wav` 文本。
2. **参考音频对应文本**：必须与音频内容准确对应（影响克隆相似度）。
3. **待合成文本**：要生成的内容。
4. **语言**：下拉选择 24 语种 / 「Auto (自动检测)」/ 「方言 (下方选择)」。
5. **中文方言**：选方言时生效，21 种（ZH_Anhui … ZH_Yunnan），如四川话 `ZH_Sichuan`。
6. 点「开始合成」→ 右侧出结果音频 + 耗时/参数信息。

> 提示：方言/语种合成时，参考音频最好用同语言/方言的录音（README 建议）。

### Tab 2「Instruct 指令造音色」— 自然语言描述生成全新音色（无需参考音频）
1. **音色描述**：如「一个年轻女性的温柔嗓音，语速稍慢，带一点俏皮。」
2. **待合成文本**：要说的内容。
3. 点「开始造音色」→ 模型先输出音色属性规划（CoT），再合成音频；结果框会显示规划文本。

### Tab 3「Instruct ICL 克隆」— Instruct 模型的零样本克隆
1. 上传参考音频 + 对应文本 + 待合成文本 → 点「开始克隆」。

## 四、已知行为与注意

- **首次合成较慢**：Base 加载 ~6-12s；单句推理 2-8 分钟（12GB 显存 + sdpa + 默认 10 步流匹配，实测 RTF≈30）；Instruct ICL 克隆约 30 分钟/11s 音频（含 CoT 文本生成）。
- **显存**：Base 或 Instruct **同一时刻只加载一个**（懒加载），峰值 ~11.8/12.3GB；若同时开两个标签页合成会触发第二次加载（内存峰值，32GB RAM 可承受，但避免并行触发两模型）。
- **音频输出**：24kHz 单声道 wav，保存在 `E:\Github\fireredtts3\out\`（文件名带时间戳）。
- 若提示 `Couldn't find appropriate backend`：venv 已装 soundfile，正常不会出现。
- 若端口 8005 被占用：改脚本 `demo.launch(..., server_port=8005)` 为其它端口。

## 五、效果验证记录（同一环境 CLI 实测）

| 任务 | 输出示例 | 耗时 |
|---|---|---|
| Base 中文克隆 | out/base_clone_zh.wav (9.1s) | 274.7s |
| Base 四川话方言 | out/base_dialect_sichuan.wav (17.1s) | 466.7s |
| Instruct 造音色 | out/instruct_design.wav (2.9s) | 143.7s |
| Instruct ICL 克隆 | out/instruct_icl_zh.wav (11.7s) | 1,890.7s |

## 变更记录
| 日期 | 变更 |
|---|---|
| 2026-08-30 | 初版：自建 Gradio WebUI 开启/使用说明（官方无 WebUI） |