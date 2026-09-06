# 061 统一数据目录：audio / books / conversations 并入数据根下的 library/

> 状态：**已确认并实施（2026-09-07）**。
> 背景：模型等数据统一在**数据根**（默认 `~/Downloads/opensound-download`，可在「设置 → 模型存放目录」修改），而录音/朗读音频（`audio/`）、长文任务（`books/`）、会话（`conversations/`）此前固定钉在系统 app 数据目录（mac `~/Library/Application Support/world.opensound.local/…`，Win `%APPDATA%\world.opensound.local\…`），不随数据根走——三处割裂。本文记录统一方案。

## 1. 统一后的目录结构

```
<数据根>（默认 ~/Downloads/opensound-download，可自定义；与模型同一根）
├─ models/  cache/  venvs/  runtime/  voices/  data/     ← 模型/缓存/运行时（现状，不变）
└─ library/                                              ← 061 新增：用户内容库（独立子文件夹，避免与模型目录混淆）
    ├─ audio/          recordings/*.wav + tts/*.wav + index.json   ← 录音与短朗读（原 app_data_dir/audio）
    ├─ books/          tasks.json + <taskId>/{meta.json,seg_*.wav} ← 长文朗读任务（原 app_data_dir/books）
    └─ conversations/  index.json + <sessionId>.json               ← 对话会话（原 app_data_dir/conversations）
```

要点：
- 三类"朗读/内容"数据全部与 models 同级但**收在独立 `library/` 文件夹**，一眼可分"模型 vs 用户内容"；
- 在设置里改「模型存放目录」（数据根）后，`library/` 整体跟随 → 音频/长文/会话自动一起搬走，与模型同一套逻辑；
- 短朗读仍是单文件 WAV + `index.json`，长文仍是每批一文件 + `tasks.json/meta.json`，**文件内部格式零改动**。

## 2. 实现（代码）

| 改动 | 位置 |
|---|---|
| 数据根函数公开 + `library_root()`（=`数据根/library`） | `src-tauri/src/lib.rs`（`pub(crate) fn data_root` / `library_root`） |
| 首次启动迁移 + asset 动态放行 `migrate_legacy_library`：旧 `app_data_dir/{audio,books,conversations}` 迁到 `library/`（同盘 rename，跨盘复制后清理；新位置非空则跳过，绝不覆盖） | `lib.rs` setup 中调用；旧位置保留判断 |
| 三个存储模块改以 `library/` 为基目录 | `audio_store.rs`、`book_store.rs`、`conversation_store.rs` |
| asset protocol 作用域：静态加 `$DOWNLOAD/opensound-download/library/{audio,books,conversations}`；自定义数据根在启动时 `asset_protocol_scope().allow_directory(…, true)` 动态放行（支持改目录后仍可播放） | `tauri.conf.json` + `lib.rs` |
| 长文朗读历史并入音频库：新增「长文朗读」页签（061） | `ui/src/panels/AudioLibraryPanel.tsx` |

## 3. 长文朗读历史（用户可见入口）

- 朗读面板内：原有「📖 长文朗读任务」卡片（新建 / 继续生成 / 从头播放 / 导出 / 删除，重启后仍在）；
- **音频库面板：新增「长文朗读」页签**（061）——所有长文任务集中列出，可「播放已生成部分 / 导出 / 删除」，未完成可点「朗读面板」跳去继续生成；从此"想听长文随时能找到"。

## 4. 兼容与风险

- 旧 `app_data_dir` 数据仅在**首次启动新版本**时迁移一次；迁移失败会打印日志并保留原位置，不丢数据；
- 已有记录索引（`index.json`/`tasks.json`）里的相对路径不变，随目录整体移动即可；
- Windows 上 `$DOWNLOAD` = `%USERPROFILE%\Downloads`；若用户系统语言不同仍可正常解析（Tauri 特殊目录变量）；
- 用户手工改过数据根到任意路径时，播放由运行时 asset 作用域保证；无需再改配置。

## 5. 相关

- 060 §4.6b（系统音色落盘）、`audio_store.rs`（录音/短朗读）、`book_store.rs`（长文任务）、`conversation_store.rs`。
