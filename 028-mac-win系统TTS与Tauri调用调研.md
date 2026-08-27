# 028 - macOS / Windows 系统内置 TTS 与 Tauri 调用调研

> 调研日期：2026-08-24 · 关联文档：009（云端语音API与系统语音引擎）、011（朗读历史与生成策略方案）
>
> 回答三个问题：
> 1. macOS / Windows 是否有系统内置的 TTS？——**有，且都是离线、免费、免密钥的**。
> 2. 在 Tauri 应用里怎么调用？——**有现成的社区插件 `tauri-plugin-tts`，Win/Mac 几行代码接入**。
> 3. 各条路线的坑和边界在哪？

---

## 0. 结论速览（TL;DR）

| 问题 | 结论 |
| --- | --- |
| 系统有没有内置 TTS | 两家都有。macOS 走 AVFoundation 引擎（`say` 命令同源）；Windows 是 **SAPI5 + WinRT 双体系并存**，离线可用 |
| 中文支持 | 有自带中文语音但音质一般：macOS 自带婷婷（zh_CN）/美佳（zh_TW）/善怡（zh_HK）紧凑版；Windows 自带 Huihui/Kangkang/Yaoyao 等。**增强/自然音色需用户手动下载或联网（Azure），不可依赖** |
| Tauri 里最快接法 | 社区插件 **`tauri-plugin-tts`**（Rust crate + npm 包 `tauri-plugin-tts-api`）：Cargo 加一行、Builder 注册一行、capability 加一个权限，前端 `await speak({ text })` 即可出声 |
| 插件底层 | Rust 的 [`tts`](https://docs.rs/tts/latest/tts/) crate → Windows 用 WinRT、macOS/iOS 用 AVSpeechSynthesizer（10.14+）、Linux 用 speech-dispatcher |
| 主要限制 | 插件单次文本上限 **10000 字节（UTF-8 字节数，不是字符数）**；`speak()` 在"开始朗读"时就 resolve（结束要听 `speech:finish` 事件）；不支持把合成结果导出成音频文件（本项目朗读历史落盘需另走路线 D/E） |

---

## 1. macOS 内置 TTS 能力

### 1.1 能力分层

| 层级 | 名称 | 说明 |
| --- | --- | --- |
| 官方推荐框架 | `AVSpeechSynthesizer` + `AVSpeechUtterance`（AVFoundation，macOS 10.14+） | 支持队列朗读、按词暂停/恢复、代理事件（开始/每句/每个词/结束），还能通过 `write(_:toBufferCallback:)` 把合成音频写入文件 |
| 旧框架 | `NSSpeechSynthesizer`（AppKit） | 老接口，仅兼容场景使用；`tts` crate 在 macOS ≤10.13 上回退到它 |
| 命令行 | `say` | 与上面同一引擎。支持 `-v 指定声音`、`-r 指定语速`、`-f 读文件`，且 **`-o` 直接导出音频文件** |
| 特色能力 | Personal Voice（macOS 14+） | 可调用用户录制的"个人声音"，需要专门 entitlement |

### 1.2 本机实测（macOS 26.4）

- `say -v '?'` 列出 **72 个已装语音**，覆盖几十种语言；
- 中文三件套实测在列：

```
Meijia   zh_TW   # 你好，我叫美佳。
Sinji    zh_HK   # 你好！我叫善怡。
Tingting zh_CN   # 你好！我叫婷婷。
```

- 注意：默认只有**紧凑版**（compact）。设置 → 辅助功能 → 朗读内容 里可手动下载"增强版/高级版"中文语音（数百 MB～GB 级），音质明显更好——**应用不能替用户静默下载，只能引导**。近年版本 `say` 合成质量有明显提升（社区反馈见 [V2EX 讨论](https://global.v2ex.co/t/1187276#reply1)）。

### 1.3 音频导出能力（对"朗读历史"很关键）

本机验证 `say --file-format='?'`：支持导出 AIFF / WAVE / CAF / M4A(AAC) / Opus 等格式：

```bash
say -v Tingting -o /tmp/test.aiff "你好，这是系统自带语音测试。"   # 实测成功，生成 138KB aiff
say -v Tingting -o out.m4a --data-format=aac "文本"
```

代码层等价物是 `AVSpeechSynthesizer.write()`。也就是说 **macOS 上"边读边存档"是原生能力**。

---

## 2. Windows 内置 TTS 能力

### 2.1 两套并存体系（理解一切坑的根源）

| | SAPI5（旧） | WinRT / OneCore（新） |
| --- | --- | --- |
| COM/API | `ISpVoice`（COM）、.NET `System.Speech.Synthesis.SpeechSynthesizer` | `Windows.Media.SpeechSynthesis.SpeechSynthesizer`（WinRT） |
| 典型英文语音 | Microsoft David / Zira / Mark | Microsoft GuyOnline、各语言 OneCore 语音 |
| 典型中文语音 | Microsoft Huihui Desktop | Microsoft Kangkang / Yaoyao / Huihui |
| 语音注册位置 | `HKLM\SOFTWARE\Microsoft\Speech\Voices` | `HKLM\...\Microsoft\Speech_OneCore\Voices` |
| 特点 | 桌面应用老标准，兼容性广 | 现代 API，语音更全，`SynthesizeTextToStreamAsync()` 可合成到内存流再写文件 |

**经典坑**：两套注册表互相看不见——用户通过"设置→时间和语言→语音"新装的语音进的是 OneCore，SAPI（System.Speech）里不会出现；反过来也一样。这是 [StackOverflow 上反复出现的问题](https://stackoverflow.com/questions/40406719)。选型时必须确定用哪一套，或做双查询合并。

**Narrator 自然语音**（如 Aria/Natural）：Windows 11 新增的"自然语音"基本是在线 Azure 服务，离线拿不到；[WebView2 里 getVoices 也取不到 Natural voices](https://github.com/MicrosoftEdge/WebView2Feedback/issues/2660)（官方已关闭该 issue，属预期行为）。**不可作为离线方案依赖。**

### 2.2 快速自测命令（PowerShell）

```powershell
# SAPI5 一行朗读
(New-Object -ComObject SAPI.SpVoice).Speak('你好，这是 Windows 系统语音')

# 列 SAPI5 语音
Add-Type -AssemblyName System.Speech
(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | % { $_.VoiceInfo.Name }
```

---

## 3. Tauri 中调用的五条路线对比

| 路线 | 接入成本 | 平台覆盖 | 可导出音频 | 暂停/恢复 | 主要风险 |
| --- | --- | --- | --- | --- | --- |
| A. Web Speech API（纯前端） | ★ 零后端 | Win ✅ / Mac ⚠️ / Linux ❌ | ❌ | 部分 | Mac 上不可靠，行为随系统漂移 |
| B. **tauri-plugin-tts（推荐起步）** | ★★ 三处小改 | Win/Mac/Linux/移动端 | ❌ | 仅 iOS | 社区个人维护，成熟度一般 |
| C. Rust `tts` crate 自写 command | ★★★ | Win/Mac/Linux | ❌（crate 层面无） | 平台不一 | 自己维护映射与事件 |
| D. 调系统 CLI（`say` / PowerShell） | ★★ | 单平台各写一份 | ✅ mac `say -o` | mac 可 | 进程管理、错误处理繁琐 |
| E. 自写原生插件（objc2 / windows-rs） | ★★★★ | 自定 | ✅ | ✅ | 开发量最大 |

### 3.1 路线 A：Web Speech API（window.speechSynthesis）

- **Windows / WebView2**：Chromium 内核带 speechSynthesis，能用，读的就是系统安装的离线语音；但拿不到 Natural 在线语音（[#2660](https://github.com/MicrosoftEdge/WebView2Feedback/issues/2660)），不同宿主环境 voice 数量可能不一致（[#3155](https://github.com/MicrosoftEdge/WebView2Feedback/issues/3155)）。
- **macOS / WKWebView**：能用但历史上多次翻车——macOS 12.3 出现过 `getVoices()` 返回空列表的系统级回归（WebKit [bug 237584](https://bugs.webkit.org/show_bug.cgi?id=237584)，后修复）；且受自动播放策略影响通常需要用户手势触发。Tauri 论坛上 Linux 下直接 `undefined`（[#12754](https://github.com/orgs/tauri-apps/discussions/12754)、[#8784](https://github.com/orgs/tauri-apps/discussions/8784)）。
- 结论：**可以当零成本兜底试一下，不能当正式方案。**

### 3.2 路线 B：tauri-plugin-tts（本次调研主推）

仓库 [brenogonzaga/tauri-plugin-tts](https://github.com/brenogonzaga/tauri-plugin-tts)，当前版本 0.1.13，MIT，底层委托 OS 合成器：**Windows=WinRT、macOS/iOS=AVSpeechSynthesizer、Linux=speech-dispatcher、Android=TextToSpeech**（经 Rust [`tts` crate v0.26](https://docs.rs/tts/latest/tts/)）。npm 包为 [`tauri-plugin-tts-api`](https://www.npmjs.com/package/tauri-plugin-tts-api)。

接入三步：

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri-plugin-tts = "0.1"
```

```rust
// src-tauri/src/main.rs 或 lib.rs
tauri::Builder::default()
    .plugin(tauri_plugin_tts::init())
    // ...
```

```json
// src-tauri/capabilities/default.json —— 加权限
{ "permissions": ["tts:default"] }
```

```bash
npm install tauri-plugin-tts-api
```

前端用法（README 原样要点）：

```typescript
import { speak, stop, getVoices, previewVoice, onSpeechEvent } from "tauri-plugin-tts-api";

await speak({ text: "你好，世界！", language: "zh-CN", rate: 1.0, pitch: 1.0, volume: 1.0 });
await speak({ text: "排队追加", queueMode: "add" });   // 不打断当前句
await stop();

const voices = await getVoices("zh");                  // locale 前缀过滤
await previewVoice({ voiceId: voices[0].id });

const unlisten = await onSpeechEvent("speech:finish", (e) => console.log(e.id));
```

API 一览：`speak` / `stop` / `getVoices(language?)` / `isSpeaking` / `isInitialized` / `previewVoice` / `pauseSpeaking` / `resumeSpeaking` / `setBackgroundBehavior`（移动端）/ `onSpeechEvent(type, cb)` / `isTtsError(e)`。

README 里明确"不猜就知道"的四条规则：

1. **`voiceId` 优先于 `language`**；只给 language 时用第一个前缀匹配的声音；
2. 语言过滤是 **locale 前缀匹配**（`"zh"` 匹配 `zh-CN`），子串不匹配；
3. **`speak()` 在朗读"开始"时 resolve**，结束要听 `speech:finish` 事件；
4. utterance id 只出现在事件里，返回值不带。

桌面端事件：`speech:start` / `speech:finish` / `speech:cancel`（通过 `app.emit("tts://<event_type>")` 统一分发）。

已知边界（对本项目的影响）：

- 文本上限 **10000 字节**（UTF-8），长文要自己分段；`rate/pitch/volume` 越界会被 clamp 而不是报错；
- 错误以 `{ code, message }` 抛出，`instanceof Error` 无效，要用 `isTtsError()`；
- 权限里 `tts:allow-register-listener` 最容易漏，漏了事件静默不触发；
- 桌面端 `pauseSpeaking()` 仅 iOS 生效，**Win/Mac 无法暂停**（底层差异所致）；
- **没有"合成结果导出为音频文件"的能力**——本项目 011 号文档的朗读历史落盘需求它覆盖不了；
- 个人项目维护、版本号尚在 0.1.x，**建议锁定版本并在 CI 里跑双平台构建**，必要时 fork。

### 3.3 路线 C：直接用 Rust `tts` crate 写自己的 command

不想引第三方插件时，`tts` crate 本身就能在 Tauri command 里用，获得与插件同等的多平台抽象，且能自由设计接口（例如加上分段、事件回调粒度控制）：

```rust
use tauri::{AppHandle, Emitter};
use tts::{Tts, UtteranceId};

#[tauri::command]
async fn sys_speak(app: AppHandle, state: tauri::State<'_, Tts>, text: String) -> Result<(), String> {
    let mut tts = state.inner().lock().map_err(|e| e.to_string())?;
    let id = tts.speak(text, false).map_err(|e| e.to_string())?; // false = 打断当前
    // 结束事件靠轮询 is_speaking() 或自行起线程比对 UtteranceId 后 app.emit(...)
    Ok(())
}
```

> 注意 `Tts` 不是 `Sync`，放进 managed state 需要 `Mutex`；跨平台语速/音调刻度不一致，需要自己做归一化（插件 B 已经做了这件事，这也是它的核心价值之一）。Windows 若想走 SAPI/Tolk 而非 WinRT，启用 crate 的 `tolk` feature。

### 3.4 路线 D：调用系统 CLI（适合"要音频文件"的场景）

- **macOS**：`std::process::Command` 跑 `say`，天然支持导出文件（见 §1.3），一行命令同时完成"播放 + 存档"，最贴合 011 朗读历史方案：

  ```rust
  Command::new("say").args(["-v", "Tingting", "-o", &path, "--data-format=aac", text]).spawn()?;
  ```

- **Windows**：没有官方 CLI，常见做法是起 PowerShell 走 SAPI COM（`New-Object -ComObject SAPI.SpVoice`）或 `System.Speech`；要拿到音频数据则需 WinRT 的 `SynthesizeTextToStreamAsync()`（PowerShell 里调 WinRT 异步 API 很绕，建议放路线 E 的 Rust 侧做）。
- 缺点：进程生命周期管理（停止朗读=杀进程）、并发去重、错误回传都要自己写；Windows 侧体验明显差于 mac。

### 3.5 路线 E：自写原生插件（objc2 / windows-rs）

终极控制力方案：Rust 侧 macOS 用 `objc2-avf-audio`/`objc2-av-foundation` 包 `AVSpeechSynthesizer`（含 `write` 导出），Windows 用 `windows-rs` 调 `Windows.Media.SpeechSynthesis`（含流式导出）。工作量最大，仅在路线 B/D 都满足不了（暂停恢复、逐句进度、音频归档全都要）时再上。

---

## 4. 结合本项目的落地建议

1. **第一步（快速可见）**：接路线 B（`tauri-plugin-tts`），前端加一个"系统朗读"开关和声音下拉（`getVoices("zh")` 过滤），半天内 UI 就能出声、能选声——符合"先让界面能用"的原则。
2. **第二步（朗读历史落盘）**：macOS 用路线 D（`say -o` 导出 m4a/aac 直接入 011 方案的音频库）；Windows 的落盘留待第二步单独调研（WinRT 流导出，倾向路线 E 或 PowerShell + WinRT 封装）。
3. **定位**：系统 TTS 定位为"零成本兜底/无网可用"，正式的高品质中文朗读仍走 009 号文档的云端 API 或本地模型管线；两者在 UI 上并列呈现即可。
4. **风险动作**：锁定 `tauri-plugin-tts = "=0.1.13"` 试运行；若后续需要暂停/导出能力而插件不给力，迁移成本主要在替换前端 import，接口形态相似，可控。

---

## 5. 收费 TTS 价格盘点（含情感控制 · 2026-08 调研口径）

> 统一折算口径：中文 TTS 默认语速约 **240 字/分钟**（有声书档 180–220，新闻播报 280–320），即 **100 万汉字 ≈ 69 小时音频**。"折算/分钟"列均按此估算，实际随语速浮动 ±30%。价格随时变动，采购前务必到各家控制台复核；标 ⚠️ 的为无法从官方页面直接核验的二手口径。

| 服务 | 情感控制（级别） | 计费口径 | 单价 | 折算≈每分钟 | 免费额度 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| **Azure TTS** | L3 SSML `express-as`（style/styledegree/role，晓晓 20+ 风格，情绪不加价） | 字符 | Neural **$16 / 100 万字符** | ≈$0.004 | **F0：50 万字符/月** | 性价比标杆：免费池内情感全功能可用；需自有服务端持 Key |
| **OpenAI gpt-4o-mini-tts** | L4 `instructions` 自由文本导演式 | 文本 token 入 + 音频 token 出 | 官方估 **≈$0.015/分钟**（社区实测 ≈$0.87/小时） | $0.015 | ❌ 无免费层 | 同指令两次合成有波动；输入上限 2000 token |
| **OpenAI tts-1 / tts-1-hd** | L1 韵律参数 | 字符 | **$15 / $30 每百万字符** | ≈$0.004 / $0.007 | ❌ | 无情感接口，纯朗读 |
| **Google Gemini-TTS** | 提示词级语气控制（近 L4） | 音频输出 token | flash **$10/MTok**、pro $20/MTok（实测 ≈$0.91 / $1.81 每小时音频） | ≈$0.015 / $0.03 | 有免费层 ⚠️待核验 | 中文情感颗粒度不如 Azure |
| **ElevenLabs** | L2 内联表演标签（v3 `[laughs]` 等） | 订阅 credits（1 cr≈1 字符）；API 按量 | 订阅 $5/3 万 cr → $1320/1100 万 cr；API v2 约 **$120/百万字符** ⚠️两来源口径有出入 | 订阅折算 ≈$0.06–0.22 | Free 1 万 cr/月（需署名、禁商用） | 质量第一梯队但最贵；商用最低 Starter 档；年付省 ~17% |
| **Fish Audio（S1/S2）** | L2 内联情感标签（详见 §6） | API 按字节；订阅按 credits（600cr≈1 分钟） | API **$15 / 100 万 UTF-8 字节** | ≈$0.01（中文语速折算） | 网页 Free 8 千 cr（API 无免费层） | 见 §6 专项 |
| **火山豆包 TTS** | L3 `emotion` 参数 + 情感音色 | 字符阶梯 | 基础档约 **¥0.02–0.05/千字符**，高音质 ≈×1.5 ⚠️代理渠道口径 | ≈¥0.005–0.012 | 新用户一次性赠送 ⚠️ | 中文口语情感强；默认 QPS 低需提工单扩容 |
| **MiniMax 海螺 T2A v2** | L3 `emotion` 枚举 | 字符（资源包制） | Turbo **¥2/万字符**、HD **¥3.5/万字符**（套餐再省 10–20%） | ≈¥0.008–0.014 | 注册赠送 ⚠️ | RPM 分档 60/200/500 |
| **阿里百炼 CosyVoice-v3-plus** | L4 instruct 自然语言控情绪 + 克隆 | 字符 | **¥2 / 万字符**（北京区，官网确认） | ≈¥0.048 | 新用户 1 万字符（90 天） | v3-flash 为低价档；可退回 001 自托管零边际成本 |
| **科大讯飞 在线合成** | 情感发音人（因音色 L1~L3） | **发音人授权年费**（特殊） | 基础/精品/特色 **2 万元/年**、明星 IP 音库 10 万元/年 | 包年制不折算 | 试用人 15 天、每日 500 次/发音人 | 官方服务说明原文；适合固定音色坐席类业务 |
| **腾讯云 语音合成** | 基础音色为主，情感能力弱 | 万字符后付费 | 官方文档页 JS 渲染无法抓取，**单价待核验** | — | 有月度免费额度 ⚠️待核验 | 以[计费概述](https://cloud.tencent.com/document/product/1073/34112)为准 |

**横向结论**：

1. **免费池里玩情感 → Azure F0 独一份**（express-as 不额外收费，50 万字符/月够 demo 和小产品起步）；
2. **按音频时长算最便宜的付费通道是 gpt-4o-mini-tts（≈$0.9/小时）和 Fish Audio API（中文 ≈$0.65–1.1/小时）**；
3. **中文情感自然度优先 → 豆包 / CosyVoice**（后者还能克隆，且用量大了可切 001 自托管把边际成本归零）；
4. ElevenLabs 综合成本约为上述的 5–10 倍，除非做有声书出海否则不推荐；
5. 讯飞年费制适合"固定几个发音人的坐席类业务"，不适合弹性用量的互联网产品。

---

## 6. Fish Audio 专项调研（回应"支持情感标签 + 按分钟收费"的传闻）

### 6.1 是谁、传闻对不对

- Fish Speech 背后的商业公司 **Fish Audio**，现役模型 **S1 / S2**（001 文档已收录）。开源权重仅 **S1-mini(0.5B)** 且为**非商用协议（CC BY-NC）**——商用只能走它家 API 或订阅。
- **情感标签 ✅ 属实**：S1 起支持自由文本内联语法，`[laugh]` `[whisper]` `[angry]` `[sad]` 等直接写进文本、句中可切换（对应 000 分级的 L2），不限于固定枚举集；S1 曾登顶 TTS-Arena-V2 人类盲测榜。

### 6.2 计费真相："按分钟"只对了一半

两条轨道并存：

| 轨道 | 计量单位 | 价格 | 说明 |
| --- | --- | --- | --- |
| **API 按量** | **UTF-8 字节**（不是字符！） | **$15 / 100 万字节** | 中文每字 3 字节 → $15 ≈ **33.3 万汉字** ≈ **$0.045/千汉字**；官方折算 ≈12 小时音频/$15，即 **$0.75–1.25/小时音频** |
| **订阅制** | credits，**600–625 credits ≈ 1 分钟音频** ← 你听到的"按分钟计时"就是它 | Plus **$11/月 = 25 万 cr ≈ 200 分钟**；Pro $75 ≈ 1620 分钟；Max $749 ≈ 6250 分钟；年付 -33% | Free 档 8000 cr ≈ 7 分钟，**单次生成限 500 字符**、禁商用 |

另有 ASR 转写 $0.36/音频小时；**API 无免费层**（免费额度只在网页版计划里）。

### 6.3 "一分钟到底多少字"

- 这是**语速问题而非厂商问题**：中文 TTS 默认语速普遍 **220–260 字/分钟**（有声书 180–220，播报腔 280–320）。各家"每分钟成本"的差异来自单价，不是字数；
- 用 240 字/分钟反推 Fish 字节价：720 字节/分钟 × $15/百万字节 ≈ **$0.011/分钟 ≈ $0.65/小时**，与官方 "$0.75–1.25/小时" 吻合（差值来自语速与语言构成），两边口径互洽；
- 对本项目：3000 字文章 ≈ 12.5 分钟音频 ≈ Fish **$0.135（约 ¥1）**；同字数在 CosyVoice-v3-plus ≈ ¥6、Azure 付费档 ≈ ¥2.3、豆包约 ¥0.6–1.5 —— **短文朗读场景下 Fish 是最便宜的外部通道之一**，且自带克隆与情感标签。风险点：闭源 API 依赖 + S1-mini 开源权重禁商用。

---

## 7. 阿里云语音模型全景（TTS/克隆 · 2026-08 官方页逐一核实）

> 阿里的问题不是没有好模型，是**命名太乱**：`cosyvoice-v1/v2/v3/v3.5 × plus/flash` 一族，`qwen-tts → qwen3-tts → qwen-audio-tts` 三代另一族，外加老 `sambert`。下表把全部现役型号一次列清（北京区原价，来自各模型官方定价页；国际站另计）。折算按中文 240 字/分钟口径。

### 7.1 商用 API 模型表

| 模型 ID | 定位 | ¥/万字符 | ≈¥/分钟 | 情感控制 | 克隆 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| cosyvoice-v1 | 一代商用版 | 2 | 0.048 | instruct 自然语言（粗） | ✅ | 老版 |
| cosyvoice-v2 | 二代稳定版 | 2 | 0.048 | instruct2 自然语言情绪（L4） | ✅ | 现役常青款 |
| cosyvoice-clone-v1 | 专用克隆 | 2（RPM 300） | 0.048 | — | ✅ 专精通道 | 只为复刻场景 |
| cosyvoice-v3-plus | 三代旗舰 | 2 | 0.048 | 情感表现力增强 + 指令控制 | ✅（5–20s 参考） | |
| cosyvoice-v3-flash | 三代高性价比 | 1 | 0.024 | 同上 | ✅ 新增德西法意俄 | |
| cosyvoice-v3.5-plus | 3.5 旗舰 | 1.5 | 0.036 | ✅ | ✅ | 当前主推旗舰 |
| **cosyvoice-v3.5-flash** | **3.5 性价比档** | **0.8** | **0.019** | ✅ | ✅ | CosyVoice 全系最便宜 |
| sambert | 达摩院老一代 | 1（RPM 1200） | 0.024 | ❌ 仅韵律参数 | ❌ | 官方明示新项目弃用 |
| qwen-tts(-latest) | 千问初代 TTS | 文档页未标价 ⚠️以控制台为准 | — | 方言系统音色；自适应有限 | ✅（复刻音色不支持方言） | 走 dashscope 多模态端点 |
| **qwen3-tts-flash** | 千问3 TTS 主力 | **0.8** | **0.019** | **文本自适应语气调节**（无需指令）；51 种高表现力音色；方言；同音色多语种 | 复刻音色不支持方言 | 快照版 -2025-09-18/-11-27 |
| qwen3-tts-instruct-flash | 指令控制版 | 0.8 | 0.019 | L4 `instruction` 参数自由导演 | — | 2026-01 快照 |
| qwen3-tts-vc | 声音转换 | 0.8 | 0.019 | — | vc=变声 | 2026-01 新增 |
| qwen3-tts-vd | 声音设计 | 0.8 | 0.019 | 文字描述造音色 | vd=设计 | 2026-01 新增 |
| **qwen-audio-3.0-tts-plus** | **富标签情感旗舰** | 1.4 | 0.034 | **L2 内联标签 + L4 instruction 双全**（见 7.2） | ✅ 声音复刻+声音设计 | 仅单向流式模式 |
| **qwen-audio-3.0-tts-flash** | 富标签快速版 | 1 | 0.024 | 同上 | ✅ | 仅单向流式模式 |

通用条件：新用户免费额度 1 万字符（90 天）；除 sambert(1200)/clone-v1(300) 外 RPM 统一 180；输出支持 PCM/WAV/MP3/Opus 至 48kHz。

### 7.2 情感能力：阿里自己的三代演进

1. **CosyVoice instruct**（v2 起）：自然语言一句话控情绪（"用开心的语气说"）——L4 风格但粒度粗；
2. **qwen3-tts-flash**：不给你控制接口，模型自己看文本调语气——省心但不可指定；
3. **qwen-audio-3.0-tts-plus/flash**：终于补上**内联标签**（对标 Fish/ElevenLabs），官方文档原文列出：
   - 控制类（作用于其后文本）：`[sad]` `[amazed]` `[angry]` `[excited]` `[sarcastic]` `[trembling]` `[crying]` `[whispers]` `[asmr]` `[empathetic]` `[shouting]` `[serious]` `[very fast]`… 约 23 种，甚至有 `[like dracula]` 德古拉风格；
   - 富语言类（当前位置插拟声）：`[gasp]` `[sighing]` `[clears throat]` `[giggles]` 等；
   - 限制：**仅这两款型号支持**，且仅单向流式。
4. 另有 `instruction` 参数的自然语言指令控制与 `qwen-voice-enrollment` 声音复刻注册、声音设计音色定制两条配套 API。

### 7.3 开源侧（GitHub 核实）

| 项目 | 仓库/归属 | 协议 | 说明 |
| --- | --- | --- | --- |
| **CosyVoice**（v1 300M / v2 0.5B 权重） | `QwenAudio/CosyVoice`（原 FunAudioLLM 组织，22.9k★，Apache-2.0） | Apache-2.0 可商用 | 多语种生成全栈；**本项目 asr-server 在用的 Fun-CosyVoice3-0.5B 即此系** |
| SenseVoice-Small | 同系生态 | Apache-2.0 | ASR（001 已收录） |
| FunASR / Paraformer | 同系生态 | MIT | ASR 工具链与中文标杆模型 |
| Emilia 预训练数据集 | 同系生态 | CC BY-NC ⚠️禁商用 | 数据集本身别直接商用 |
| Qwen2-Audio / Qwen2.5-Omni / Qwen3-Omni | QwenLM | Apache-2.0 | 音频理解+生成的多模态底座，非专用 TTS，部署重 |

### 7.4 选型只需记三行 + 一个坑

- **纯朗读要便宜**：`qwen3-tts-flash` 或 `cosyvoice-v3.5-flash`（都是 ¥0.8/万字符 ≈ **¥1.15/小时音频**）；
- **要克隆**：`cosyvoice-v3.5`（API），或用量大了直接自托管开源权重把边际成本归零；
- **要句中情感/拟声标签**（对标 Fish Audio）：只有 `qwen-audio-3.0-tts-plus/flash`；
- **坑**：三族模型**调用端点不同且不可混用**——CosyVoice 与 Qwen-Audio-TTS 走 `{WorkspaceId}.cn-beijing.maas.aliyuncs.com` 的 AOQ/WebSocket，Qwen-TTS 走 `dashscope.aliyuncs.com` 多模态端点（官方文档明确警告）；百炼同一文档里甚至出现 MiniMax 端点（平台还代销第三方模型），写封装前先认准端点再动手。

---

## 8. 声音复刻（克隆）能力与收费对比 · 2026-08 核实

> 回答"这些模型能不能克隆我的声音、怎么收费"。标 ⚠️ 的为官方页面 JS 渲染无法抓到数字的二手口径/待核验项。

| 服务 | 能否克隆 | 样本要求 | 收费方式 | 备注/限制 |
| --- | --- | --- | --- | --- |
| **Azure** Custom Neural Voice | ✅（Professional 层，需申请审批） | 数分钟～数小时授权录音 | **训练 $52/计算小时 + 托管 $4.04/模型/小时** + 合成另计（约 $24/百万字符档） | 成本最高、合规最严（声音人授权强制审核）；个人项目基本劝退 |
| **OpenAI** | ❌ | — | — | 无任何克隆 API |
| **Google** Gemini-TTS | ❌ | — | — | Cloud TTS 另有 Custom Voice 但为企业申请制 ⚠️ |
| **ElevenLabs** | ✅ 两档 | 即时克隆 ≥1 分钟；专业克隆(PVC) ≥30 分钟 | IVC 含在 Starter($5/mo)；PVC 需 Creator($22/mo) | 商用权随订阅；质量天花板之一 |
| **Fish Audio** | ✅ 主打卖点 | **10–30 秒**参考音频 | Free 档仅标准克隆+3 个公共声库槽；**Plus($11) 起 10 个私有音色+增强克隆** | S1/S2 克隆位于盲测第一梯队 |
| **火山豆包** | ✅「声音复刻大模型」独立产品线 | 需录制并提交**声音人授权**材料 | ⚠️[官方定价页](https://www.volcengine.com/product/voicecloning)为 JS 渲染，数字未抓到，以控制台为准 | 授权流程正式，适合要合规背书的场景 |
| **MiniMax 海螺** | ✅ 快速克隆 | 短样本 | **套餐直接赠送克隆名额**：¥700/¥7,000/¥70,000 三档分别送 10/30/300 个快速克隆音色 | 克隆本身不再单收钱 |
| **阿里百炼** | ✅ CosyVoice 声音复刻 + `qwen-voice-enrollment` 注册 API | **v3 系列 5–20 秒**参考音频 | 复刻注册不单独计费（合成走各模型字符价）⚠️以控制台为准 | qwen-tts 的复刻音色**不支持方言**；CosyVoice 复刻支持 |
| **科大讯飞** | ✅ 语音复刻（企业通道）/ 讯飞智作（C 端配音） | 授权录音 | ⚠️未抓到公开单价 | 与发音人年费制体系并行 |
| **开源自托管** | ✅ | 3 秒～1 分钟 | **免费** | CosyVoice2/v3(0.5B)、GPT-SoVITS、IndexTTS-2.5、FireRedTTS3、dots.tts（详见 001 §三）；**本项目 asr-server `/clone` 已跑通 Fun-CosyVoice3-0.5B** |

**横向结论**：

1. **云端克隆性价比排序**：Fish / ElevenLabs（订阅内含，体验最好）＞ MiniMax（套餐送名额）≈ 阿里（只收合成费）＞＞ Azure（训练+托管双重天价）；
2. **本项目的现实选择**：本地 Fun-CosyVoice3 已经能用（零边际成本），云端克隆只作为"不想下 9GB 模型"用户的轻量备选；
3. **合规红线**：所有云厂商克隆都要求声音人授权凭证（Azure 审查最严），产品化时必须在 UI 里留存授权记录——这与 001 §八"克隆滥用"风险条款呼应。

---

## 9. 参考链接

- 插件：https://github.com/brenogonzaga/tauri-plugin-tts · https://docs.rs/tauri-plugin-tts · https://www.npmjs.com/package/tauri-plugin-tts-api
- 底层 crate：https://docs.rs/tts/latest/tts/
- Apple：AVSpeechSynthesizer（AVFoundation 文档）、`man say`
- Microsoft：[Windows.Media.SpeechSynthesis](https://learn.microsoft.com/uwp/api/windows.media.speechsynthesis.speechsynthesizer)、System.Speech（SAPI5）
- 坑位实录：
  - SAPI 看不到新装语音：https://stackoverflow.com/questions/40406719
  - WebView2 取不到 Natural voices：https://github.com/MicrosoftEdge/WebView2Feedback/issues/2660
  - WebKit getVoices 空列表回归（macOS 12.3）：https://bugs.webkit.org/show_bug.cgi?id=237584
  - Tauri 下 Web Speech API 讨论：https://github.com/orgs/tauri-apps/discussions/8784 、https://github.com/orgs/tauri-apps/discussions/12754
- §5–§6 价格来源（2026-08 抓取）：
  - Fish Audio 定价与 credits 折算：https://texttolab.com/blog/fish-audio-pricing 、https://tokenmix.ai/blog/fish-audio-tts-api-pricing-voice-cloning-2026
  - OpenAI TTS 实测成本：https://github.com/sanand0/openai-tts-cost
  - Azure TTS 价格口径：https://texttolab.com/blog/azure-text-to-speech-pricing
  - ElevenLabs 订阅明细：https://bigvu.tv/blog/elevenlabs-pricing-2026-plans-credits-commercial-rights-api-costs/
  - MiniMax 语音资源包官方价：https://platform.minimaxi.com/docs/guides/pricing
  - 阿里百炼 cosyvoice-v3-plus 官方价：https://help.aliyun.com/zh/model-studio/cosyvoice-v3-plus
  - 讯飞发音人授权口径：https://shandong.xfyun.cn/doc/tts/online_tts/tts_description.html
  - 火山豆包价格（代理渠道二手口径 ⚠️）：https://www.hsydls.com/Doc/9960.html
- §7 阿里全景来源（官方模型页逐一抓取，北京区原价）：
  - 模型页：cosyvoice-v1 / v2 / v3-plus / v3-flash / v3.5-plus(`cosyvoice-v3-5-plus`) / v3.5-flash(`cosyvoice-v3-5-flash`) / cosyvoice-clone-v1 / sambert / `qwen3-tts-flash` / `qwen3-tts-instruct-flash` / `qwen3-tts-vc` / `qwen3-tts-vd` / `qwen-audio-3-0-tts-plus`(¥1.4) / `qwen-audio-3-0-tts-flash`(¥1)，路径形如 https://help.aliyun.com/zh/model-studio/<slug>
  - 能力与端点说明：实时语音合成指南 https://help.aliyun.com/zh/model-studio/text-to-speech · 非实时语音合成指南 https://help.aliyun.com/zh/model-studio/qwen-tts
  - 开源仓库：https://github.com/QwenAudio/CosyVoice （原 FunAudioLLM，Apache-2.0）
- §8 声音复刻来源（2026-08 抓取）：
  - Azure Custom Voice 训练/托管费（六源核验）：https://costbench.com/software/ai-voice-tools/microsoft-speech/hidden-costs/
  - ElevenLabs 两档克隆与订阅对应关系：https://bigvu.tv/blog/elevenlabs-pricing-2026-plans-credits-commercial-rights-api-costs/
  - Fish Audio 克隆规格：https://tokenmix.ai/blog/fish-audio-tts-api-pricing-voice-cloning-2026
  - 火山声音复刻产品页（JS 渲染 ⚠️）：https://www.volcengine.com/product/voicecloning
  - MiniMax 克隆名额赠送：https://platform.minimaxi.com/docs/guides/pricing
