# OpenSound · 本地语音工作台（桌面 App）

把本地语音服务（识别 ASR / 朗读 TTS / 对话 LLM / 语音克隆）做成一个**点开即用的桌面 App**：
既能独立使用，也作为开放端口后端（`9528`），供浏览器插件 / 网站 / 其它 App / 脚本接入。
本地推理、隐私优先；云端能力（DeepSeek / 智谱 / Azure / Fish 等）按需启用。

> 状态：Win 全链路（Node/Python 自举 → 引擎安装 → 识别 / 朗读 / 对话 / 克隆）已在本机验证可用；
> macOS 从零验收进行中。升级 = 换新版 App：内置版本指纹不符时自动重建本地服务代码目录（模型与受管环境在数据根，不受影响）。

## 用户「三步上手」

1. **下载并运行**：macOS = Apple silicon + macOS 14+；Windows = x64，主推 Windows 11（Win10 已停止支持，尽力兼容）。
2. **双击运行**：按顶部引导条点「**安装 Node**」（只需一次）→ 需要 Qwen3 / SenseVoice 原始版 / CosyVoice 时再点「**安装 Python 基础**」。
3. **模型管理页逐个下载引擎**（权重放数据根 `<下载>/opensound-download/models`，官方源/镜像自动切换）→ 识别 / 朗读 / 对话 / 克隆即可用。

> 建议内存 16GB（python 系引擎）；无 N 卡自动装 CPU 版，有 N 卡可选 CUDA 档；磁盘按所选引擎预留 10–40GB；首启需联网下载依赖/模型。

## 应用行为 & 端口

- 启动 = 就绪本地服务 → `9528` 主入口（ASR/TTS/LLM/chat/models/health）+ python 子服务按资源模式拉起；关窗仅隐藏、托盘退出才停服务。
- 端口：`9528` asr-server 主入口 · `8001` Qwen3-TTS · `8002` SenseVoice 原始版 · `8003` CosyVoice 克隆。第三方默认接 `http://127.0.0.1:9528`。

## 开发者

```bash
npm install --cache ./.npm-cache   # 根依赖
npm run dev                        # tauri dev：调试，服务直接指向仓库 asr-server
npm run build                      # 生成内置服务模板 + 前端 + tauri build → 单产物 .app/.exe
```

- 服务端独立开发：`cd asr-server && npm ci && npm run all`。**每次改动 asr-server 都要 `npm run build`** 重新生成内置模板（`src-tauri/resources/asr-server` 为生成物）。
- 接口与用法：见 `SPEC.md` / `GUIDE.md`。
