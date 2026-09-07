# OpenSound 桌面 App（Tauri）

把本地语音服务（ASR / TTS / LLM / 对话 / 克隆）做成一个**点开即用的桌面 App**：既能独立使用，又作为开放端口后端（`9528`），供浏览器插件 / 网站 / 其它 App / CLI 接入。本地推理、隐私优先；云端能力（DeepSeek/智谱/Azure/Fish 等）按需启用。

> 状态（2026-09-08）：**单产物自包含 .app（S6′）阶段 1–2 已实测通过**——asr-server 代码内嵌进 App，运行时零依赖仓库代码。规划与细节：`002-plan`（自举/分发/S6′）、`000-plan-14`（自动更新 / 系统要求 / Fish S2.1）、`001-跨平台适配`、`000-summary`（总览与踩坑）。

## 用户「三步上手」（普通用户视角，全程在 App 内点按钮）

1. **下载 `OpenSound.app`**（release 一个文件；mac = Apple silicon + macOS 14+，Windows = 11 x64——见下方系统要求）。
2. **双击运行**：首启自动把内置的本地服务代码物化到 App 数据目录（`~/Library/Application Support/world.opensound.local/server`，Win 为 `%APPDATA%\…\server`）；按顶部引导条依次点「**安装 Node**」（npm ci 一次）→ 需要 Qwen3/原始版/CosyVoice 时再点「**安装 Python 基础**」。
3. **模型管理页逐个引擎下载**（模型放数据根 `<下载>/opensound-download/models`，默认可从 hf 官方/镜像自动切换）→ 识别 / 朗读 / 对话 / 克隆即可用。

> 升级 = 换新版 `.app`：内置代码版本指纹（`.version`）不符时自动**整目录重建**服务物化目录（模型与受管 venv 在数据根，不受影响）。

## 系统要求（摘要，完整见 `000-plan-14 §三`）

| | macOS | Windows |
|---|---|---|
| 系统 | Apple silicon（M1 起）；macOS 14+（torch/MPS 要求） | x64；主推 Windows 11（Win10 已 EOL，尽力支持） |
| 内存 | 8GB 可跑轻量档；**推荐 16GB**（python 系引擎） | 同左（无 N 卡自动 CPU 版，有 N 卡可选 CUDA 档） |
| 磁盘 | 按档位 10–40GB 余量；首启需联网（依赖/模型经镜像下载） | 同左（WebView2 由安装器兜底） |

## 开发者

```bash
npm install --cache ./.npm-cache   # 根依赖（含 @tauri-apps/cli）
npm run dev                        # tauri dev：调试开发，服务直接指向仓库 asr-server
npm run build                      # stage 内置模板 + ui 构建 + tauri build → 单产物 .app/.exe
npm run check:dist                 # CI 体积红线：发布物出现 node_modules/.venv-*/models 即失败
```

- 首次 cargo 编译若报 `Operation not permitted`（全局缓存被 root 占用）：
  `export CARGO_HOME="$PWD/.cargo-home"` 后重试（`.cargo-home` 已 gitignore）。
- 服务端代码独立开发：`cd asr-server && npm ci && npm run all`（9528 + python 子服务）。**每次进 .app 的改动**都要 `npm run build` 重新生成内置模板（勿复用旧 `src-tauri/resources/asr-server`，它已 gitignore）。

## 目录结构

```
OpenSound/
 ├─ src-tauri/           # Rust：窗口/托盘/拉起服务；S6′ 物化分支（bundle 内置模板 → app 数据目录 server/）
 │  ├─ resources/asr-server/   # 【生成物·勿提交】stage 脚本现场从 asr-server/ 收集
 │  └─ tauri.conf.json         # bundle.resources 引用上述目录
 ├─ scripts/             # stage-asr-server.mjs（收集内置模板 + .version）、check-dist-artifacts.mjs（体积红线）
 ├─ ui/                  # React+Vite 前端（9 面板）
 ├─ asr-server/          # Node 语音服务（9528 主入口 + 8001/8002/8003 python 子服务；engines/*.json 引擎清单）
 └─ 数据根（运行时用户数据，不在仓库）
     ~/Downloads/opensound-download/{models,venvs,runtime,voices,library}
```

## 应用行为 & 端口

- 启动 = 物化/复用 App 数据目录 `server/` → 拉起 `start-all.js`（幂等）→ 9528 asr-server + python 子服务按资源模式拉起；关窗仅隐藏、托盘退出才停服务。
- 端口：`9528` asr-server 主入口（ASR/TTS/LLM/chat/models/health）· `8001` Qwen3-TTS · `8002` SenseVoice 原始版 · `8003` CosyVoice 克隆。插件默认接 `http://127.0.0.1:9528`。

## 相关文档

| 文档 | 内容 |
|---|---|
| `000-summary` | 项目总览 / 已实现清单 / 踩坑记录（§七） |
| `002-plan` | 本地服务自举与分发、S6′ 单产物自包含方案 |
| `000-plan-14` | App 自动更新调研 / macOS·Windows 系统要求 / Fish S2.1-Pro 本地部署 |
| `001-跨平台适配` | Win/Mac 差异、产品阶段视图与 Win 验证指引 |
| `SPEC.md` / `GUIDE.md` | 开放后端接口 / 使用说明 |
