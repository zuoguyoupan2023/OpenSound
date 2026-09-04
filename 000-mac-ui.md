Tabu-Local
本地语音工作台


语音工作台


朗读


识别


实时语音


对话


模型管理


音频库


音色管理


设置
服务运行中
停止
模型管理
查看与下载本地模型（类比 ollama pull）
 刷新
本机：
标准档
· Metal 加速
· 内存 16GB
· 磁盘可用 19GB
可装 8/8
CosyVoice3 语音克隆（0.5B · MPS） Apache-2.0 可装 · 慢速
朗读 TTS
cosyvoice-clone
~9.1GB 整仓全量（2026-08-28 起不再维护"必需子集"；ModelScope/HF 整仓 20 文件逐个字节校验下载）
缺环境

受管 venv：数据目录 venvs/.venv-cosyvoice（034 阶段3 uv 自举；installer 缺失时自动创建）
环境项由安装器/引导自动创建或克隆兜底
检测/修复
Kokoro（中英混合 · 53 音色） Apache-2.0 可安装
朗读 TTS
kokoro
~383MB
运行中
 运行中
Qwen2.5-0.5B-Instruct（默认 · 兜底） Apache-2.0 可安装
对话 LLM
llm-0.5b
~469MB
运行中
 运行中
Qwen3-8B Q4_K_M（推荐 · 对话更强） Apache-2.0 可安装
对话 LLM
llm-qwen3-8b
~4.7GB
运行中
 运行中
Qwen3-TTS 0.6B（MPS · 流式） Apache-2.0 可安装
朗读 TTS
qwen3
~2.3GB（python hub 缓存）
缺环境

受管 venv：数据目录 venvs/.venv-qwen3（034 阶段3 uv 自举创建）
环境项由安装器/引导自动创建或克隆兜底
检测/修复
SenseVoice 原始版（funasr · 高精度） Apache-2.0（ModelSense SenseVoiceSmall） 可安装
识别 ASR
sensevoice-original
~2.1GB（900MB 主模型 + VAD + 标点辅助）
缺文件 + 缺环境

punc-cn-en/model.pt
缺文件 · 1.0 GB

受管 venv：数据目录 venvs/.venv-funasr（034 阶段3 uv 自举创建；复用系统 torch/funasr 可 --system-site-packages）
环境项由安装器/引导自动创建或克隆兜底
补齐 · 1.0 GB