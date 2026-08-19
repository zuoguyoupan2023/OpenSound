# Tabu-Local 桌面 App（Tauri）

把本地语音服务（ASR / TTS / LLM / 对话）做成一个**点开即用的 Tauri 桌面 App**：既能独立使用，又作为开放端口后端，供浏览器插件(Tabu-AI) / 网站 / 其它 App / CLI 接入。

> 规划文档见 `000-voice-tauri-app规划.md`。当前进度：**M1 + M2 已完成**（Tauri 壳 + 完整 GUI：语音工作台 / 朗读 / 识别 / 对话 / 模型管理 / 设置）；M3 SPEC / M4 CI 为下一步。

## 目录结构

```
Tabu-Voice/
 ├─ src-tauri/        # Rust：窗口、托盘、拉起/守护 asr-server 子进程
 ├─ ui/               # 前端：Vite + React + TS（M2 完整 GUI）
 │  └─ src/
 │     ├─ api.ts          # 后端接口封装（health/speak/transcribe/chat/voice-chat/models/install）
 │     ├─ audio.ts        # 录音(MediaRecorder→16k WAV) + 播放 + 帧流解析
 │     ├─ panels/         # 6 个功能面板
 │     │  ├─ HomePanel.tsx    # 语音工作台：说→想→读 一键闭环
 │     │  ├─ ReadPanel.tsx    # 朗读：粘贴文本/打开文件→选引擎/音色→帧流边播边出
 │     │  ├─ AsrPanel.tsx     # 识别：录音→转文本→复制/导出
 │     │  ├─ ChatPanel.tsx    # 对话：文字或语音→本地 LLM→朗读回答
 │     │  ├─ ModelsPanel.tsx  # 模型管理：下载/安装/进度
 │     │  └─ SettingsPanel.tsx# 设置：端口/Token/运行信息
 │     └─ components/     # 共享 UI 组件
 ├─ asr-server/       # 现有 Node 语音服务（核心引擎，作为子进程被拉起）
 └─ README.md
```

## 快速开始

```bash
# 1. 安装依赖（根 + 前端）
npm install --cache ./.npm-cache

# 2. 开发模式运行（自动拉起 asr-server:9528 + qwen3:8001）
npm run dev
```

首次运行会用 rustup 的 cargo 编译 Rust（确保 `~/.rustup` 可用）。若 cargo 报 `Operation not permitted`，是因全局 cargo/npm 缓存目录被 root 占用：

```bash
# 使用工作区内缓存绕过（已配置 .gitignore 忽略）
export CARGO_HOME="$PWD/.cargo-home"
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
```

## 应用行为

| 行为 | 说明 |
|---|---|
| 启动 | 拉起 `asr-server/start-all.js`（幂等，已运行则跳过）→ asr-server(9528) + qwen3(8001) |
| 健康检查 | 后台每 2s 探测 `/health`，向前端推送状态 |
| 托盘 | 常驻；左键点开窗口，菜单含「显示窗口 / 重启服务 / 退出（停止服务）」 |
| 关窗 | 仅隐藏窗口，不退出服务（后台继续供 Tabu-AI 用） |
| 退出 | 走托盘「退出」会停掉服务子进程再退出；应用进程退出时兜底清理 |

## M2 GUI 功能

| 面板 | 功能 |
|---|---|
| 🎙️ 语音工作台 | 一键「说 → 想 → 读」闭环（`/voice-chat`），选识别/LLM/朗读引擎 |
| 🔊 朗读 | 粘贴文本/打开文件 → 选 Kokoro 音色/语速 或 Qwen3 音色 → 帧流边播边出 |
| 🎧 识别 | 录音（MediaRecorder→16kHz WAV）→ 转文本 → 复制/导出 |
| 💬 对话 | 文字或语音提问 → 本地 LLM → 可朗读回答 |
| 🧠 模型管理 | 模型清单 + 按需下载安装（NDJSON 进度流） |
| ⚙️ 设置 | 服务地址、鉴权 Token（localStorage 持久化）、端口约定说明、运行信息 |

## 端口约定（与现状兼容）

| 端口 | 服务 | 说明 |
|---|---|---|
| 9528 | asr-server 主入口 | ASR / TTS / LLM / voice-chat / models / health |
| 8001 | qwen3-tts | 可选，低延迟朗读 |
| 9527 | bridge（WS） | 终端桥接（扩展侧接入） |

Tabu-AI 的「本地服务」地址默认 `http://127.0.0.1:9528`，端口不变，现有接入无需改动。
