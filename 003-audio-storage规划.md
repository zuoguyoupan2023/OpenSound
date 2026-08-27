# 003 · 两类音频的本地存放与播放（录音 + TTS 朗读）

> 状态：**P0–P3 编码完成（方案 A asset protocol；导出=zip 打包；克隆样本来源=录音标记）。克隆引擎集成待模型选型确认**。
> 补充：全 App 数据存储位置总览与存储规范已升级到 `011-朗读历史与生成策略方案.md §2.3 / §5.6`（含对话历史 conversations/ 与 localStorage 迁移决策），本文只保留音频库本身的实现记录。
> 关联：`000-voice-tauri-app规划.md`（M2.5 已完成，录音链路已跑通）、`002-voice-research.md`、`GUIDE.md`（接口）、`SPEC.md`（对外规范）。
> 本文解决一个现状缺口：**用户录音、以及 App 内 TTS 朗读的声音，目前都只在内存中（Base64/Blob/帧流），关闭即丢失，无法再次打开播放**。本文为这两类音频设计「本地落盘 + 元数据索引 + 再次打开播放」的方案，并给出分阶段实施计划。

---

## 〇、现状核实（结论）

逐行核实了代码后，确认两类音频**当前都没有持久化落盘**：

| 音频类型 | 产生位置 | 当前流向 | 是否存储 |
|---|---|---|---|
| **用户录音** | `src-tauri/src/recorder.rs` cpal 采集 → 16kHz 单声道 WAV → base64 → `ui/src/audio.ts` 转 Blob | 提交 `/transcribe` 或 `/voice-chat` 后即弃 | ❌ 无 |
| **TTS 朗读（语音工作台）** | `ui/src/panels/HomePanel.tsx`：`/voice-chat` 返回 `audioBase64` → Blob → `playWav` | 只播放，不保存 | ❌ 无 |
| **TTS 朗读（朗读/对话面板）** | `ui/src/panels/ReadPanel.tsx` `ChatPanel.tsx`：`/speak` 帧流 → `createFramePlayer` 逐帧播放 | 只播放，不保存 | ❌ 无 |

现状无「音频库 / 历史」面板，无任何落盘/索引逻辑。

---

## 一、目标

1. **两类音频统一本地持久化**：用户录音、TTS 朗读结果，各自落盘成 WAV 文件 + 一条元数据记录。
2. **再次打开播放**：重启 App 后，能在 UI 里看到历史音频，点开即可播放。
3. **可管理**：播放、删除、（可选）重命名 / 导出 / 分享到文件夹。
4. **不破坏现有链路**：录音、朗读的在线流程保持不变，落盘是"顺手存一份"，不阻塞主流程。

---

## 二、存储位置设计（落盘目录）

沿用现有 Tauri 配置路径的约定（`lib.rs` 里 `app_config_dir()` 已用于 config.json）：

```
~/Library/Application Support/world.opensound.local/
   ├─ config.json                 # 已存在（asr-server 路径）
   └─ audio/
       ├─ recordings/             # 用户录音 16kHz WAV
       │    └─ 2026-08-20_073900_a1b2.wav
       ├─ tts/                    # TTS 朗读结果 WAV
       │    └─ 2026-08-20_074512_c3d4.wav
       └─ index.json              # 音频元数据索引（见 §四）
```

- 位置：`app_data_dir()/audio/`（跨平台由 Tauri 自动定位：macOS `~/Library/Application Support/…`、Windows `%APPDATA%`、Linux `~/.local/share`）。
- 建议 **在"设置"面板提供一个"音频库位置"查看/打开**入口（未来可选自定义路径），首版用默认路径即可。

---

## 三、文件命名与格式

| 项 | 约定 |
|---|---|
| 文件名 | `YYYY-MM-DD_HHMMSS_<8位随机>.wav`（排序友好、不重名、便于按时间浏览） |
| 录音格式 | 16kHz 单声道 16-bit PCM WAV（与现有 recorder 输出完全一致，**直接复用**） |
| TTS 格式 | 各引擎帧流（16kHz WAV 片段）**合并拼接为单文件 WAV**；`/voice-chat` 的 `audioBase64` 直接解码为 WAV |

---

## 四、元数据索引 `index.json`

每条音频一条记录（用 JSON 文件即可，首版不引入 SQLite）：

```json
{
  "version": 1,
  "items": [
    {
      "id": "a1b2c3d4",
      "kind": "recording",            // "recording" | "tts"
      "file": "recordings/2026-08-20_073900_a1b2.wav",
      "created_at": "2026-08-20T07:39:00.000Z",
      "duration_sec": 4.2,
      "engine": "auto",               // recording 的 ASR 引擎；tts 的 TTS 引擎
      "text": "今天天气怎么样？",        // recording=识别文本；tts=朗读文本（可空）
      "note": ""                       // 可选备注
    }
  ]
}
```

- 追加即写回 index.json（文件小，全量重写可接受）。
- `id` 用于删除/播放定位，不依赖文件名。

---

## 五、播放方案（再次打开播放）

前端 `playWav` / `createFramePlayer` 目前只吃 Blob。历史音频播放需把本地文件给到 WebView，两种可选：

| 方案 | 说明 | 取舍 |
|---|---|---|
| **A. Tauri Asset Protocol（推荐）** | 在 `tauri.conf.json` 开启 `app.security.assetProtocol`，前端用 `convertFileSrc(appDataDir + 相对路径)` 得到 `asset://` URL，直接 `new Audio(url)` 播放 | 内存友好、播放原生；需在配置里允许该目录范围，避免任意文件被 WebView 读取 |
| **B. Rust 读文件返回 base64/字节** | 新增 `audio_read_base64(id)` command，把 WAV 读回 base64 → 前端 Blob 播放 | 复刻现有路径、无需改安全配置；大音频在内存中拷贝，稍重 |

> 决策点：**推荐 A**（性能好、支持进度/暂停更自然），B 作为回退。二者可都实现，UI 层共用同一接口。

> 补充：Tauri 2 若启用 assetProtocol，建议限定只开放 `audio/` 目录前缀，遵循最小权限。

---

## 六、Rust 侧接口（新增 `audio_store` 模块 + commands）

新增 `src-tauri/src/audio_store.rs`，暴露以下 Tauri command（命名风格沿用现有 `recorder_*`）：

| command | 作用 |
|---|---|
| `audio_save` | 接收（kind, wav 二进制/base64, duration_sec, engine, text），落盘 + 写 index.json，返回新记录 |
| `audio_list` | 返回 index.json 全部记录（前端渲染历史列表） |
| `audio_read` | 按 id 返回文件数据（base64）或 asset URL，供播放 |
| `audio_delete` | 按 id 删除文件 + 更新 index.json |
| `audio_path` | 返回音频库根目录（设置面板"打开位置"用） |

- 落盘不阻塞主流程：`/voice-chat`、`/speak` 的结果在播放的同时**异步顺手存一份**；失败只记日志，不影响播放/识别。
- 复用 `recorder.rs` 已有的 WAV 头拼接函数（`pcm_to_wav`）；TTS 帧流合并也复用它。

---

## 七、UI 设计（新增「音频库」面板，UI 优先）

新增侧边栏入口 **「音频库」**，两个标签页：

1. **我的录音**：最近在上，显示日期/时长/识别文本，操作：🔊播放、🗑删除、（可选）导出。
2. **朗读历史**：显示日期/时长/朗读文本/引擎，操作：🔊播放、🗑删除、（可选）导出/重命名。

- 顶部：刷新按钮 + 显示"音频库位置"。
- 播放中高亮该条；再次点击停止。
- 空态文案："还没有保存的音频"。

> 按铁律 3/5：先让这个面板**看得见、点得到**。首阶段可先做纯 UI（内存播放），再接入真实落盘。

---

## 八、分阶段实施计划（每阶段完成即停，等你确认再进下一步）

### P0 · 音频库面板 UI 骨架（不落盘，先看见）
- 新增 `ui/src/panels/AudioLibraryPanel.tsx` + 侧边栏入口。
- 用当前会话内存数据展示两条演示/真实记录，可播放/停止/删除（仅内存）。
- 验收：**界面能打开、能看到两类音频、能点播放**。
- **状态：✅ 已完成**（面板含「我的录音 / 朗读历史」两标签，可播放/删除；P0/P1/P2 一次性实现，未拆内存版）。

### P1 · 真实落盘（录音 + TTS 都存下来）
- Rust 新增 `audio_store.rs`（保存/列/读/删/路径 5 个 command）+ `tauri.conf.json` 注册。
- 录音停止后、TTS 朗读/语音工作台拿到结果后，异步落盘 + 写 index.json。
- 前端 `audio_list` 拉到真实历史。
- 验收：**录音一次、朗读一次 → 重启 App → 列表仍在，能播放**。
- **状态：✅ 编码完成**（`audio_save/audio_list/audio_delete/audio_get_dir`；录音在 Asr/Home/Chat 落盘，TTS 帧流经 `teeCollect`+`mergeWavFrames` 在 Read/Home/Chat 落盘）。

### P2 · 播放方案落地 + 打磨
- 接入 asset protocol（方案 A）或 base64 回退（方案 B）播放本地文件。
- 删除真正删文件；加导出/打开位置按钮。
- 验收：**历史音频可再次打开播放、可删除、可导出**。
- **状态：✅ 编码完成**（方案 A：`tauri.conf.json` `assetProtocol.enable`+scope、`protocol-asset` feature、前端 `convertFileSrc` 播放；删除落盘文件；面板显示音频库位置路径。**导出已加**：每条记录「📦 导出」→ 保存对话框选路径 → Rust `zip` 打包 `.wav` + `.txt`(含类型/引擎/时长/时间/文本说明)。录音+识别文本、朗读+原文均可一起导出）。

### P3 · 克隆音色样本来源 + 导出（部分完成）
- 录音可「🎨 作样本」标记为克隆音色参考样本（`is_clone_sample` 存 index.json），供后续克隆引擎使用。
- **克隆引擎已定：CosyVoice 3.0**（见 `004`，模型在 `005` 下载中）。**后端 `/clone` 尚未实现** → 任务已移交 `006-voice-后续规划.md`。

### P3（可选/后续）· 增强
- 自定义音频库路径、录音重命名、批量管理、按文本搜索、语音克隆样本从录音库选取（衔接 000 的克隆路线）。

---

## 九、边界与取舍（明确不做）

- **不做**云同步/加密（首版本机本地存储，符合"所有音频本机完成"定位）。
- **不做**把音频塞进 asr-server 的 HTTP 接口作为公开能力（这是 GUI 侧的本地收藏功能；对外如需，另行规划）。
- 落盘是"顺手保存"，不因保存失败而阻塞在线识别/朗读。
- 存储上限/清理策略（自动清理 N 天前）留到 P3，首版用户手动删。

---

## 十、需要你拍板的决策点

1. **播放方案 A（asset protocol，推荐）还是 B（base64）还是都要？**
2. **首版是否要"导出到文件夹"按钮，还是先只做播放 + 删除？**
3. **录音库要不要也当作"语音克隆音色样本"的来源**（影响 P3，不影响首版）。
4. 音频库**默认路径**是否就用系统应用数据目录（不自定义），先这样跑通？

> 审阅后我按 P0 → P1 → P2 顺序执行，每阶段结束停下等你确认。
