# 000 · 设备端语音合成（TTS）跨项目通用参考

> 性质：**跨项目通用技术参考**——任何网站、PWA、原生 App 项目均可直接引用，不绑定具体业务。
> 初版：2026-08-24　·　来源：字谈项目 028 调研 + 真机实测沉淀
> 维护约定：在任何项目中发现新的平台行为或坑，回写本文档对应章节，保持"一份资料全局生效"。

---

## 目录

1. [核心概念：TTS 三层结构](#一核心概念tts-的三层结构)
2. [网页端标准通道 speechSynthesis](#二网页端标准通道-speechsynthesis)
3. [平台能力矩阵](#三平台能力矩阵2026-实测口径)
4. [原生 App API](#四原生-app-的-tts-apiapp-化路线)
5. [云端 TTS 对比](#五云端-tts-对比本地不够好时的升级路线)
6. [情绪与语气控制调研](#六情绪与语气控制expressive-tts-调研)
7. [工程最佳实践 Checklist](#七工程最佳实践-checklist)
8. [选型决策树](#八选型决策树)
9. [兼容性速查](#九兼容性速查)

---

## 一、核心概念：TTS 的三层结构

```
你的代码 ──调用──▶ 合成引擎（谁在发声）──输出──▶ 扬声器
```

最重要的一个认知：**无论什么平台，「文本转语音」的实际执行者永远是某个合成引擎，而引擎不属于你**：

| 层 | 你能控制的 | 你不能控制的 |
| --- | --- | --- |
| 调用层 | 选哪个声音、语速、音调、何时播放 | 音色本身的质量 |
| 引擎层 | ——（用户设备决定） | 引擎是否在线合成 |
| 输出层 | 播放/停止/队列 | 系统音频焦点策略 |

推论：
1. **朗读质量的上限不在你的代码里**，而在"用户设备上装了什么引擎和声音包"；
2. 你的职责是：**把选择权透明地交给用户 + 引导他获得更好的声音**；
3. 永远不要硬编码"最佳声音"的名字——同一台设备的不同浏览器、同浏览器的不同版本，声音清单都可能不同。

---

## 二、网页端标准通道 speechSynthesis

Web Speech API 的 `speechSynthesis` 是**唯一**的网页标准 TTS 通道（Chrome / Safari / Edge / Firefox 桌面与移动全支持）。它本质是个**转发器**：把文本转交给底层引擎，自己不做合成。

### 2.1 最小可用代码

```js
function speak(text, { lang = 'zh-CN', voiceURI = '', rate = 1, pitch = 1 } = {}) {
  if (!('speechSynthesis' in window)) return false;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = window.speechSynthesis.getVoices().find(x => x.voiceURI === voiceURI);
  if (v) { u.voice = v; u.lang = v.lang; } else u.lang = lang;
  u.rate = rate; u.pitch = pitch;
  u.onend = u.onerror = () => { /* 收尾 */ };
  window.speechSynthesis.speak(u);
  return true;
}
```

### 2.2 已知坑与对策（实战沉淀，逐条验证过）

| # | 坑 | 现象 | 对策 |
| --- | --- | --- | --- |
| 1 | **voices 异步就绪** | 页面加载时 `getVoices()` 返回 `[]`，尤其 Android Chrome | 监听 `onvoiceschanged` 重渲染 + 「踢一脚」技巧：静音 speak 一次（`volume=0` 的空格 utterance）逼引擎加载清单 |
| 2 | **iOS 手势限制** | 非用户点击触发的首次 speak 静默失败 | 保证首次播放由 click/touchend 处理器发起 |
| 3 | **长文本截断** | 单条 utterance 读到几十秒后戛然而止（Chrome 系明显） | 按 标点分句，逐句入队：上一句 `onend` 里 speak 下一句；每句控制在 100 字内 |
| 4 | **cancel 后立即 speak 丢音** | 部分 Android 引擎 `cancel()` 未完成就 `speak()` 会无声 | `cancel()` 后延时 ~80ms 再 speak，或在 `onend` 回调里衔接 |
| 5 | **utterance 对象不可复用** | 第二次 speak 同一对象直接 onerror | 每次新建 |
| 6 | **后台/锁屏停读** | 切后台可能中断 | 系统策略，网页无解；App 化后用音频会话解决 |
| 7 | **rate/pitch 参数被无视** | 部分安卓引擎只认默认值 | UI 上不做"保证生效"的承诺，仅作请求 |
| 8 | **voice.name 不唯一** | 同名声音多条（不同语言包） | 持久化用户选择时存 **`voiceURI`**（唯一），展示时才用 name |
| 9 | **元数据缺失条目** | 个别引擎枚举出 name/lang 为空串的声音（Edge 在线声实测存在） | 显示层兜底：`未命名声音 #N`；分组归「未知」组 |

### 2.3 前端布局教训（通用）

- **行内小按钮严禁复用"整宽按钮"样式类**。若全局按钮类是 `width:100%`（为表单保存键设计），把它放进 flex 行会：按钮拉成超宽、兄弟元素（名称文字）被压成零宽"消失"、溢出的按钮直接不可见。
- 症状特征："某段文字看不见但元素存在""按钮异常巨大"。排查顺序：先查该元素的 class 是否命中了 `width:100%` 类型的全局规则，再怀疑数据。
- 正确做法：行内操作用独立的紧凑按钮样式（固定内容宽、`flex:0 0 auto`）。

---

## 三、平台能力矩阵（2026 实测口径）

| 平台 | 网页支持 | 底层引擎 | 中文质量天花板 | 高质量声音获取（用户操作） |
| --- | --- | --- | --- | --- |
| **Windows**（Chrome/Firefox） | ✅ | SAPI5 / OneCore | ★★☆ 机械感 | 设置 → 时间和语言 → 语音 → 添加中文语音 |
| **Windows + Edge** ⭐ | ✅ | **微软在线神经声音** | ★★★★★ | 无需安装：`getVoices()` 自带 300+ 条 `Microsoft … Online (Natural)`，JS 直接可选（联网、微软限额） |
| **macOS** | ✅ | AVSpeechSynthesis | ★★★☆→★★★★ | 设置 → 辅助功能 → 朗读内容 → 系统声音 → 下载「增强/豪华」版（免费，数百 MB） |
| **iPhone** | ✅ | 同 Mac 体系 | ★★★☆→★★★★ | 设置 → 辅助功能 → 朗读内容 → 声音 → 下载增强/豪华版 |
| **iPad** | ✅ 与 iPhone 完全同源 | 同上 | 同上 | 同上 |
| **Android 手机/平板** | ✅ | **用户所选 TTS 引擎 App**（Google TTS / 三星 / 讯飞…） | 取决于引擎 | 设置 → 系统 → 语言和输入 → 文字转语音输出 → 换引擎/下载语音包 |
| **鸿蒙 NEXT 手机/平板** | ⚠️ ArkWeb 待实测 | 系统语音引擎 | 待实测 | 原生侧有 Core Speech Kit（见 §四） |

关键特例说明：

1. **Edge 在线自然声是"网页 JS 能免费摸到的最好声音"**：不需要 Key、不需要付费、标准接口直接选用。代价：仅限 Edge 用户、需联网、微软保留限额权利。产品策略上值得在指引文案中主动提示。
2. **iOS 全系第三方浏览器（Chrome/Edge iOS）= WebKit 内核**，声音清单与 Safari 完全一致，不存在"Chrome iOS 更好"的可能。
3. **Android 的浏览器不带任何声音**——一切取决于用户装的 TTS 引擎。产品能做的最有效优化是「引导换引擎/下语音包」的平台定制文案。

---

## 四、原生 App 的 TTS API（App 化路线）

三平台都有成熟的**免费、本地、离线**系统 API，质量不低于网页通道：

### 4.1 iOS / iPadOS / macOS — AVSpeechSynthesizer (AVFoundation)

```swift
let synth = AVSpeechSynthesizer()
let u = AVSpeechUtterance(string: "你好，世界")
u.voice = AVSpeechSynthesisVoice(language: "zh-CN")
u.rate = AVSpeechUtteranceDefaultSpeechRate
synth.speak(u)
```

- 可枚举 `AVSpeechSynthesisVoice.speechVoices()`，含用户下载的增强/豪华版；
- 支持 `willSpeakRangeOfSpeechString` 逐字高亮（适合跟读/字幕场景）；
- iOS 17+ 支持「个人声音」（用户录制自己的音色）供辅助功能使用；
- 配合 `AVAudioSession` 可实现后台连续朗读。

### 4.2 Android — android.speech.tts.TextToSpeech

```kotlin
val tts = TextToSpeech(context) { status ->
    if (status == TextToSpeech.SUCCESS) {
        tts.language = Locale.SIMPLIFIED_CHINESE
        tts.speak("你好，世界", TextToSpeech.QUEUE_FLUSH, null, "uttr-1")
    }
}
```

- 可列出设备全部引擎并引导切换（`engines`、系统设置页 intent）；
- `onDone`/`onError` 回调驱动句队列；
- 注意无 GMS 设备上 Google TTS 缺失，需探测并提示安装其他引擎。

### 4.3 鸿蒙 NEXT — Core Speech Kit（ArkTS）

```ts
import { textToSpeech } from '@kit.CoreSpeechKit';
// 创建 TextToSpeechEngine，传入 { text, extra } 即可合成播放
```

- 华为官方端侧合成，免费；中文效果为华为设备上的最优解；
- 仅鸿蒙原生应用可用（网页侧见 §三 的待实测项）。

### 4.4 共性结论

App 化之后 TTS 反而更简单：**三平台免费本地 API 全覆盖**，云端 TTS 只作为"超高质量需求"的可选增强，不是必需品。

---

## 五、云端 TTS 对比（本地不够好时的升级路线）

| 服务商 | 免费额度 | 质量 | 备注 |
| --- | --- | --- | --- |
| **Azure TTS F0** | **50 万字符/月（neural）** | ★★★★★ | 与 F0 语音识别共享资源体系；晓晓/云希等；接入需自有服务端持 Key 代理，客户端绝不放 Key；express-as 情绪标签同池可用（见 §六） |
| 火山引擎豆包 TTS | 每应用一次性赠送额度 | ★★★★★（中文情感强） | 需签名代理 |
| **阿里云 ISI TTS** | 商用版无免费额度；试用版 3 个月内并发≤2 不限量 | ★★★★☆ | 计费暗坑：按「千次调用」非字符——单请求 ≤100 字符=1 次、101–200=2 次、201–300=3 次，**一个汉字算 2 字符**、单请求上限 300 字符（中文实际 ≤150 字/条）、SSML 标签不计费。国际站 $1.40/千次起，日用量阶梯降至 $0.70 |
| **阿里云百炼 CosyVoice** | 新用户 1 万字符（90 天有效） | ★★★★☆~★★★★★ | 大模型 TTS：3 秒声音复刻 + 自然语言指令控制语气（L4）；v2/3/3-plus/flash 多档；ISI 版 CosyVoice 无免费额度 |
| OpenAI TTS | 无免费层 | ★★★★☆ | 成本高，不建议默认通道 |
| 讯飞在线合成 | 少量试用 | ★★★★☆ | 国内合规友好 |
| Fish Audio（S1/S2） | 网页版 8 千 credits | ★★★★☆+ | API 无免费层；详见下方价格速查与 OpenSound 028 §6 |

### 5.1 收费 TTS 价格速查（2026-08 口径，完整调研同步自 OpenSound `028-mac-win系统TTS与Tauri调用调研.md` §5–§7）

> 折算按中文 240 字/分钟（≈100 万汉字 ≈ 69 小时音频）；⚠️ 为二手口径，采购前以官网控制台为准。
> 声音复刻/克隆能力与收费对比见 028 §8；ASR/STT 全景（含本表同源的国际价格核验）见 `029-asr-stt全景调研.md`。

| 服务 | 单价 | ≈每分钟 | 情感控制 | 免费额度 |
| --- | --- | --- | --- | --- |
| Azure Neural | $16/百万字符 | ≈$0.004 | L3 express-as 不加价 | F0 50 万字符/月 |
| OpenAI gpt-4o-mini-tts | 官方 ≈$0.015/min | $0.015 | L4 instructions | ❌ |
| Google Gemini-TTS | flash $10/MTok 音频出 | ≈$0.015 | 提示词级 | 有 ⚠️ |
| ElevenLabs | 订阅 $5–1320/月；API v2 约 $120/百万字符 ⚠️ | ≈$0.06–0.22 | L2 内联表演标签 | Free 1 万 cr/月禁商用 |
| Fish Audio | API $15/百万 UTF-8 字节；订阅 600cr≈1 分钟 | ≈$0.01 | L2 内联情感标签 | 仅网页版 8 千 cr |
| 火山豆包 | 约 ¥0.02–0.05/千字符 ⚠️ | ≈¥0.005–0.012 | L3 emotion 参数 | 新用户一次性赠送 |
| MiniMax 海螺 | Turbo ¥2、HD ¥3.5/万字符 | ≈¥0.008–0.014 | L3 emotion 枚举 | 注册赠送 ⚠️ |
| 阿里百炼（全系见 028 §7） | qwen3-tts-flash / cosyvoice-v3.5-flash **¥0.8**～v3-plus ¥2 /万字符 | ¥0.019–0.048 | instruct(L4)；qwen-audio-3.0-tts 另有 L2 内联标签 | 新用户 1 万字符 |
| 科大讯飞 | 发音人授权 **2 万元/年**（明星 IP 10 万/年） | 包年制 | 因音色 L1~L3 | 试用人 500 次/天 |
| 腾讯云 | ⚠️官方文档 JS 渲染未能核验 | — | 弱 | 有月度免费额度 ⚠️ |

阿里专项要点（详见 028 §7）：商用 API 三族并存——CosyVoice（克隆主力）、qwen3-tts（朗读性价比 ¥0.8/万字符）、qwen-audio-3.0-tts（唯一支持 `[sad]` `[gasp]` 式内联标签）；开源侧 CosyVoice 全家 Apache-2.0（仓库已迁至 `QwenAudio/CosyVoice`）。

阿里云 ASR 同口径补充（ISI，2026-08 官方文档）：实时语音识别国际站 $1.40/h 起（日累计 ≥5000h 降至 $0.70），国内站资源包约 100 元/30h（≈3.33 元/h）起、量大至 1.8 元/h；一句话识别按千次调用计费（$1.40/千次起）；录音文件识别 $1.00/h 起。商用版**没有任何免费额度**——「免费」是试用版规则（4 服务各 3 个月：实时/一句话/TTS 并发≤2 不限量，录音文件每日 2h）；从商用版降回试用版会导致并发归零、服务不可用。自学习平台（热词定制模型，上限 10 个）与 MRCP Server 免费。

> 阿里云 ASR 对位关系：「一句话识别」≈ 腾讯云一句话识别（字谈现用通道），服务端代理架构完全同构，可作多供应商冗余。

接入架构（与语音识别代理同构）：

```
浏览器/App ──POST 文本──▶ 自家代理(持Key) ──▶ 云厂商
        ◀──audio/mpeg 流────┘
配额：按用户/设备计数（KV/DB），超额回落本地引擎
```

上线前必须重新核实免费额度口径（厂商政策随时调整，本文数字为 2026-08 口径）。

---

## 六、情绪与语气控制（Expressive TTS）调研

> 回答一个问题：**哪些 TTS 能表达情绪/语气？用什么标签或参数控制？** 2026-08 调研口径。

### 6.1 能力分级框架（横向比较用）

| 级别 | 名称 | 含义 | 典型代表 |
| --- | --- | --- | --- |
| L0 | 纯文本 | 给什么读什么，无任何控制 | 早期车载 TTS |
| L1 | 韵律参数 | 只能调语速/音调/音量 | `speechSynthesis` 的 rate/pitch、AVSpeech、Android TextToSpeech |
| L2 | 内联表演标签 | 在文本里插入 `[laughs]` `[whispers]` 式标记 | ElevenLabs v3 audio tags |
| L3 | 显式情绪枚举 | 用参数指定情绪名（happy/sad/angry…）与强度 | Azure `express-as`、火山豆包 `emotion` |
| L4 | 自然语言指令 | 用一句话描述想要的语气，模型自由发挥 | OpenAI `instructions` |

**关键结论先行：浏览器标准通道（speechSynthesis）最高只能到 L1——所有 L2 以上的情绪能力都必须走云端 API 或原生 SDK 的私有扩展。**

### 6.2 云端服务对照表

| 服务 | 控制方式 | 级别 | 情绪种类（示例） | 中文效果 | 免费额度可用 |
| --- | --- | --- | --- | --- | --- |
| **Azure Neural TTS** | SSML `<mstts:express-as style="…" styledegree="…" role="…">` | **L3+**（最强） | 晓晓支持 20+：cheerful / sad / angry / fearful / disgruntled / serious / affectionate / gentle / calm / lyrical / envious…；`styledegree` 0.01–2 连续调强度；`role` 可模仿女孩/男孩/年长者 | ★★★★★ 中文风格库最全 | ✅ F0 同池（50 万字符/月） |
| **火山引擎豆包 TTS** | 请求参数 `emotion` + `enable_emotion` + `emotion_scale`；部分音色自带情感倾向 | L3 | happy / sad / angry / excited / surprise / neutral / sing-chat 等 | ★★★★★ 口语化、情感自然 | 一次性赠送额度内可用 |
| **OpenAI gpt-4o-mini-tts** | 请求参数 `instructions`（自由文本描述语气） | **L4** | 无枚举限制："用兴奋但压低声音的语气说" 均可；缺点是同指令两次合成效果有波动 | ★★★★☆ 自然但中文情感颗粒度不如 Azure 细 | ❌ 无免费层 |
| **ElevenLabs v3 (alpha)** | 文本内联音频标签：`[laughs] [whispers] [sad] [angry] [excited]`… | **L2**（最细粒度的"表演"） | 数十种表演标签，可嵌在句子中间切换 | 多语种支持广但中文表现一般 | 试用额度有限 |
| MiniMax 海螺 TTS | `emotion` 枚举参数 | L3 | happy/sad/angry/fearful/hate… | ★★★★☆ | 有试用额度 |
| 科大讯飞 | 情感发音人（音色自带情感）+ 韵律参数 | L1~L3（因音色而异） | 以官方音色列表为准 | ★★★★☆ | 少量试用 |

### 6.3 本地引擎现状（全部止步 L1）

| 引擎 | 情绪能力 | 说明 |
| --- | --- | --- |
| Apple AVSpeechSynthesizer | 无情绪 API | 只有 rate/pitch/volume；无法指定"生气地读" |
| Android TextToSpeech | 标准接口无 | 个别厂商引擎有私有扩展但不通用，不可依赖 |
| 鸿蒙 Core Speech Kit textToSpeech | 公开文档暂无情绪标签 | 以最新官方文档为准 |
| Edge 在线 Natural 声（网页通道） | 无接口 | 微软的 express-as 只在自家 SDK/API 开放，`speechSynthesis` 标准接口不透传 SSML |

**推论：产品若需要"带情绪的朗读"，唯一现实路径是云 API；本地引擎只能用 L1 参数近似模拟。**

### 6.4 控制方式代码样例

**Azure SSML（L3，中文情绪首选）：**

```xml
<speak version="1.0"
       xmlns="http://www.w3.org/2001/10/synthesis"
       xmlns:mstts="https://www.w3.org/2001/mstts"
       xml:lang="zh-CN">
  <voice name="zh-CN-XiaoxiaoNeural">
    <mstts:express-as style="cheerful" styledegree="1.5">
      太好了！我们真的做到了！
    </mstts:express-as>
    <break time="300ms"/>
    <mstts:express-as style="gentle">
      别怕，我在这里。
    </mstts:express-as>
  </voice>
</speak>
```

辅助标记：`<prosody rate="+10%" pitch="+5%">`（韵律）、`<emphasis>`（重音）、`<break time="500ms"/>`（停顿）。

**OpenAI instructions（L4）：**

```json
{
  "model": "gpt-4o-mini-tts",
  "voice": "nova",
  "instructions": "用兴奋但刻意压低的声音说话，像看球赛绝杀时怕吵醒家人",
  "input": "进了进了！绝杀！"
}
```

**ElevenLabs v3 内联标签（L2）：**

```
[whispers] 别出声……它就在门外。
[laughs] 你看看你自己的脸！
[angry] 我说过多少次了，进门先换鞋！
```

**本地引擎的 L1 近似模拟（零成本兜底）：**

```js
// 疑问句 → 音调略升；感叹句 → 语速略快；悲伤段 → 放慢降调
const isQ = /[?？]$/.test(sentence), isEx = /[!！]$/.test(sentence);
u.pitch = isQ ? 1.3 : sad ? 0.8 : 1;
u.rate  = isEx ? 1.15 : sad ? 0.85 : 1;
```

### 6.5 选型建议

1. **要中文情绪最全、可控最精细 → Azure express-as**（且 F0 免费池就能用，与 §五 复用同一代理架构）；
2. **要"一句话导演式"控制、快速原型 → OpenAI instructions**；
3. **要有声书级"表演"（句中笑/哭/耳语）→ ElevenLabs v3**（注意 alpha 状态与成本）；
4. **国内合规优先 → 豆包 emotion / 讯飞**；
5. **任何场景都建议保留 L1 本地兜底**：云不可用时降级为韵律模拟，功能不断档。

> 适用场景提示（来自听障沟通产品的实践）：文字聊天天然丢失语气信息，"带情绪朗读"对听障用户理解对方意图有实际价值；医疗、客服等场景也常需要区分安抚/警告语气。

---

## 七、工程最佳实践 Checklist

落地一个"让人放心"的朗读功能，逐项对照：

**功能层**
- [ ] 声音偏好持久化存 `voiceURI`，启动时校验该 URI 是否仍在清单中（卸载的语言包要能优雅回落）
- [ ] 提供「自动选择」模式：按目标语言从偏好名序列（如 xiaoxiao → tingting → huihui…）智能挑选
- [ ] 长文本按标点分句队列播放（§二.2 #3）
- [ ] 播放中有可见的停止入口；页面卸载时 `cancel()` 清场

**透明层（强烈建议——这是把"黑箱"变"白箱"的关键）**
- [ ] 「声音体检」面板：`getVoices()` 全量清单
- [ ] 每行标注 `本地/在线`（`voice.localService`）——告诉用户合成发生在哪、断网是否可用
- [ ] 逐个试听按钮（点谁读谁，示例句按声音语言自动选择）
- [ ] 按语言分组折叠展示；当前语言的组默认展开；语言码→名称用 `Intl.DisplayNames`（勿手写映射表，覆盖不全且无法双语）
- [ ] 悬停/长按可见原始元数据（name/lang/voiceURI/localService），便于远程排障

**引导层**
- [ ] 按平台 UA 定制"如何获得更好声音"的指引（Edge 特例 / 苹果增强声 / 安卓换引擎，见 §三 表格）
- [ ] 清单为空时给出诊断提示而非空白（不支持 API / 引擎未装 / 需刷新）

**兼容层**
- [ ] `'speechSynthesis' in window` 探测，不支持则隐藏功能而非报错
- [ ] `Intl.DisplayNames` 用 try-catch 包裹并提供裸码回退

---

## 八、选型决策树

```
需要 TTS？
├─ 网页/PWA
│   ├─ 默认走 speechSynthesis（免费、离线、零依赖）
│   ├─ 目标用户大量是 Edge？→ 提示选用 Online (Natural) 在线声（质量跃升，零成本）
│   └─ 本地声音质量不足且预算允许？→ 云 TTS（Azure F0 先试，§五）
└─ 原生 App
    ├─ iOS/macOS → AVSpeechSynthesizer
    ├─ Android → TextToSpeech（探测引擎，无 GMS 设备给替代指引）
    ├─ 鸿蒙 NEXT → Core Speech Kit textToSpeech
    └─ 超高质量需求 → 系统 API 为主 + 云 TTS 可选增强
```

---

## 九、兼容性速查

| API / 能力 | 最低版本要求（约） |
| --- | --- |
| `speechSynthesis` | Chrome 33 / Safari 7 / Firefox 49 / Edge 14 / Android WebView 37+（实际体验随引擎） |
| `voiceschanged` 事件 | Chrome 33+ / Safari 9.1+（Android Chrome 行为特殊，需 §二.2 #1 技巧） |
| `Intl.DisplayNames`（语言码→名称） | Chrome 81 / Safari 14 / Firefox 85 / Node 13+（2020 年后设备全覆盖） |
| Edge 在线 Natural 声音出现在 `getVoices()` | Edge 108+ |
| AVSpeechSynthesizer 个人声音 | iOS 17+ |
| 鸿蒙 Core Speech Kit | HarmonyOS NEXT |

---

## 十、变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-08-24 | 初版：自字谈 028 调研 + Edge/桌面实测沉淀（声音体检面板实战：pvbtn 挤压坑、 voices 元数据缺失、Intl.DisplayNames 方案、两清单合一） |
| 2026-08-24 | 新增 §六「情绪与语气控制」：L0–L4 分级框架 + Azure/豆包/OpenAI/ElevenLabs/MiniMax 对照表 + 本地引擎 L1 现状 + 三种控制方式代码样例；原 §六～九顺延为 §七～十 |
| 2026-08-25 | §五 补入阿里云双线（ISI TTS 计费暗坑与试用版规则、百炼 CosyVoice 免费额度）+ ASR 价格同口径补充；数据源 help.aliyun.com ISI 定价文档原文抓取 |
| 2026-08-26 | §五 补入收费价格速查（§5.1，同步自 OpenSound 028 §5–§7）：Azure/OpenAI/Gemini/ElevenLabs/Fish Audio/豆包/MiniMax/百炼/讯飞/腾讯云 单价与情感档位对照，主表补 Fish Audio 行。阿里全系模型全景（CosyVoice v1~v3.5、qwen3-tts / qwen-audio-tts 三族、开源清单、qwen-audio 内联情感标签）详见 028 §7 |
| 2026-08-26 | §五 增加两条指针：声音复刻对比 → 028 §8（Azure 训练$52/h+托管$4.04/model/h、Fish 10–30s、MiniMax 送名额、阿里 5–20s 复刻等）；ASR/STT 全景 → OpenSound `029-asr-stt全景调研.md` |
