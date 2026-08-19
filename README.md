# Tabu-Local 桌面 App（Tauri）

把本地语音服务（ASR / TTS / LLM / 对话）做成一个**点开即用的 Tauri 桌面 App**：既能独立使用，又作为开放端口后端，供浏览器插件(Tabu-AI) / 网站 / 其它 App / CLI 接入。

> 规划文档见 `000-voice-tauri-app规划.md`。当前进度：**M1 已完成**（Tauri 壳 + 拉起服务 + 托盘 + macOS 本机验证）；M2 GUI / M3 SPEC / M4 CI 为下一步。

## 目录结构

```
Tabu-Voice/
 ├─ src-tauri/        # Rust：窗口、托盘、拉起/守护 asr-server 子进程
 ├─ ui/               # 前端：Vite + React + TS（状态页）
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

## M1 行为说明

| 行为 | 说明 |
|---|---|
| 启动 | 拉起 `asr-server/start-all.js`（幂等，已运行则跳过）→ asr-server(9528) + qwen3(8001) |
| 健康检查 | 后台每 2s 探测 `/health`，向前端推送状态 |
| 托盘 | 常驻；左键点开窗口，菜单含「显示窗口 / 重启服务 / 退出（停止服务）」 |
| 关窗 | 仅隐藏窗口，不退出服务（后台继续供 Tabu-AI 用） |
| 退出 | 走托盘「退出」会停掉服务子进程再退出；应用进程退出时兜底清理 |

## 端口约定（与现状兼容）

| 端口 | 服务 | 说明 |
|---|---|---|
| 9528 | asr-server 主入口 | ASR / TTS / LLM / voice-chat / models / health |
| 8001 | qwen3-tts | 可选，低延迟朗读 |
| 9527 | bridge（WS） | 终端桥接（扩展侧接入） |

Tabu-AI 的「本地服务」地址默认 `http://127.0.0.1:9528`，端口不变，现有接入无需改动。
