import { useRef, useState, useEffect } from "react";
import type { PanelProps } from "../App";
import { Icon } from "@iconify/react";
import { transcribe, computeStarting, getPersistedSettings, switchEcoEngine, engineDisabledInEco, azureAsrConfigured, AZURE_ASR_LANGS, updateSettings, type EcoAsr } from "../api";
import { langLabel } from "../langNames";
import { createRecorder, type Recorder } from "../audio";
import { saveRecording } from "../audioStore";
import { Panel, Button, Select, Spinner, EngineBadge } from "../components/ui";
import { showToast } from "../toast";

type State = "idle" | "recording" | "processing" | "done";

// 000-plan-6 阶段1：系统识别仅 macOS 接入（Win 系统识别自由听写为云端服务，离线不可用）
const isMac = /Mac/i.test(navigator.userAgent);
// 系统识别语言名（常见 locale；未收录的原样显示代码，运行时以 supportedLocales 枚举为准）
const SYS_LANG_NAMES: Record<string, string> = {
  "zh-CN": "中文（大陆）", "zh-TW": "中文（台湾）", "zh-HK": "中文（香港）",
  "yue-HK": "粤语", "en-US": "英语（美）", "en-GB": "英语（英）", "en-AU": "英语（澳）",
  "en-IN": "英语（印度）", "ja-JP": "日语", "ko-KR": "韩语", "fr-FR": "法语", "fr-CA": "法语（加）",
  "de-DE": "德语", "es-ES": "西班牙语", "es-MX": "西班牙语（墨）", "it-IT": "意大利语",
  "ru-RU": "俄语", "pt-BR": "葡萄牙语（巴西）", "pt-PT": "葡萄牙语", "ar-SA": "阿拉伯语",
  "th-TH": "泰语", "vi-VN": "越南语", "id-ID": "印尼语", "ms-MY": "马来语", "tr-TR": "土耳其语",
  "nl-NL": "荷兰语", "pl-PL": "波兰语", "uk-UA": "乌克兰语", "hi-IN": "印地语", "da-DK": "丹麦语",
  "fi-FI": "芬兰语", "nb-NO": "挪威语", "sv-SE": "瑞典语", "he-IL": "希伯来语", "cs-CZ": "捷克语",
  "el-GR": "希腊语", "hu-HU": "匈牙利语", "ro-RO": "罗马尼亚语", "ca-ES": "加泰罗尼亚语",
};
const sysLangLabel = (code: string) =>
  SYS_LANG_NAMES[code] ? `${SYS_LANG_NAMES[code]}（${code}）` : code;

// 录音 WAV Blob → base64（系统识别经 Tauri 原生命令转写，不走服务端）
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// S11：Whisper 语言选项（20 项常用；'' = 自动检测。服务端白名单 99 码，非法码回退自动检测）
const WHISPER_LANG_OPTIONS = [
  { value: "", label: "自动检测（默认）" },
  { value: "zh", label: "中文 zh" },
  { value: "en", label: "英文 en" },
  { value: "fr", label: "法语 fr" },
  { value: "ja", label: "日语 ja" },
  { value: "ko", label: "韩语 ko" },
  { value: "es", label: "西班牙语 es" },
  { value: "de", label: "德语 de" },
  { value: "ru", label: "俄语 ru" },
  { value: "it", label: "意大利语 it" },
  { value: "pt", label: "葡萄牙语 pt" },
  { value: "ar", label: "阿拉伯语 ar" },
  { value: "th", label: "泰语 th" },
  { value: "vi", label: "越南语 vi" },
  { value: "id", label: "印尼语 id" },
  { value: "tr", label: "土耳其语 tr" },
  { value: "nl", label: "荷兰语 nl" },
  { value: "pl", label: "波兰语 pl" },
  { value: "uk", label: "乌克兰语 uk" },
  { value: "hi", label: "印地语 hi" },
];

export default function AsrPanel(props: PanelProps) {
  const [state, setState] = useState<State>("idle");
  const [engine, setEngine] = useState<string>("auto");
  const [whisperLang, setWhisperLang] = useState<string>("");
  const [sysLang, setSysLang] = useState<string>("zh-CN");
  // 运行时枚举本机支持的识别 locale（SFSpeechRecognizer.supportedLocales；空则回退常见清单）
  const [sysLocales, setSysLocales] = useState<string[]>([]);
  // supportsOnDeviceRecognition 运行时结果（true=设备端离线 / false=走苹果服务器）
  const [sysOnDevice, setSysOnDevice] = useState<boolean | null>(null);
  // 000-plan-11 A-1：Azure 云识别语言（持久化到设置；Key/Region 复用 Azure 语音资源）
  const [azureLang, setAzureLang] = useState<string>(getPersistedSettings().azureAsrLanguage || "zh-CN");
  const [punc, setPunc] = useState<boolean>(false);
  const [vad, setVad] = useState<boolean>(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState<number>(0);
  const recRef = useRef<Recorder | null>(null);

  // 032 修复：就绪判定以 /models 状态列（state=ready/running）为准；
  // 不能用 health.engines（含"sensevoice(未下载)"占位）或写死 true，否则未装也显绿勾。
  const svReady = props.models?.some(
    (m) => m.engine === "sensevoice" && (m.state === "ready" || m.state === "running")
  ) ?? false;
  // 原始版状态：从 /models 里 sensevoice-original 的 state 读真实可达性（= funasr 后端 8002 是否在跑）
  const hasOrig = props.models?.some(
    (m) => m.engine === "sensevoice-original" && (m.state === "ready" || m.state === "running")
  ) ?? false;
  const whisperReady = props.models?.some(
    (m) => m.engine === "whisper" && (m.state === "ready" || m.state === "running")
  ) ?? false;

  // 000-plan-3：节能 = ASR 类同时仅启用 1 个模型（sensevoice / whisper / sensevoice-original 选一）。
  // 非启用项标「点选切换」；点选 = 确认后 switchEcoEngine 重启（关旧启新）；auto 在节能下收敛到启用引擎。
  const ecoSettings = getPersistedSettings();
  const ecoActiveAsr = ecoSettings.powerMode === "eco" ? (ecoSettings.ecoAsr as EcoAsr) : null;
  const asrOffLabel = (v: string) =>
    v !== "auto" && ecoActiveAsr && engineDisabledInEco("asr", v, ecoSettings)
      ? "（点选切换并启用）"
      : "";
  const pickAsrEngine: (v: string) => Promise<void> = async (v) => {
    // 系统识别（mac 原生）与云端识别不占本地模型资源，不受节能约束
    if (v === "sys" || v === "azure") {
      setEngine(v);
      return;
    }
    if (ecoSettings.powerMode === "eco") {
      if (!ecoSettings.ecoAsr) {
        setError("节能模式识别类别尚未配置——请到「模型管理」顶部资源表选择启用引擎");
        return;
      }
      if (v !== "auto" && ecoActiveAsr !== v) {
        if (
          !window.confirm(
            `节能模式未启用「${
              v === "sensevoice-original" ? "SenseVoice 原始版" : v === "whisper" ? "Whisper" : "SenseVoice"
            }」。切换将把识别类别改为该引擎（关闭同类别当前引擎并重启服务，冷启动需等待），继续？`
          )
        )
          return;
        try {
          await switchEcoEngine("asr", v);
          showToast("已切换识别引擎，服务重启中…");
          props.refresh();
          setTimeout(() => props.refresh(), 1500);
        } catch (e) {
          setError("切换失败: " + e);
          return;
        }
      }
    }
    setEngine(v);
  };

  // 000-plan-3：节能下当前识别引擎不在启用集（含默认 auto 语义不明确）→ 自动回落启用引擎
  useEffect(() => {
    if (!ecoActiveAsr) return;
    if (engine === "sys" || engine === "azure") return; // 系统/云端识别不参与节能
    if (engine !== ecoActiveAsr) setEngine(ecoActiveAsr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ecoActiveAsr, props.models]);

  useEffect(() => {
    if (!isMac) return;
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string[]>("sys_supported_locales"))
      .then((ls) => {
        if (!ls.length) return;
        const pri = ["zh-CN", "zh-TW", "zh-HK", "yue-HK", "en-US", "en-GB", "es-ES", "fr-FR", "ru-RU", "ar-SA", "ja-JP", "ko-KR"];
        ls.sort((a, b) => {
          const pa = pri.indexOf(a), pb = pri.indexOf(b);
          if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
          return a.localeCompare(b);
        });
        setSysLocales(ls);
      })
      .catch(() => {});
  }, []);

  const toggle = async () => {
    setError("");
    if (state === "recording") {
      setState("processing");
      const rec = recRef.current!;
      const wav = await rec.stop();
      recRef.current = null;
      const t0 = Date.now();
      try {
        if (engine === "azure") {
          // Azure 云识别：本机录音 WAV → asr-server 转发到 Azure STT（自带标点，不走本地 VAD/标点）
          const r = await transcribe(wav, "azure", false, false, "");
          saveRecording(wav, "azure", r.text, { source: "asr" }).catch((e) =>
            console.error("保存录音失败:", e)
          );
          setText(r.text);
          setElapsed(Math.round((Date.now() - t0) / 100) / 10);
          setState("done");
          return;
        }
        if (engine === "sys") {
          // 系统识别：Tauri 原生命令（SFSpeechRecognizer），不经 9528 服务
          const { invoke } = await import("@tauri-apps/api/core");
          const r = (await invoke("sys_transcribe", {
            wavBase64: await blobToBase64(wav),
            language: sysLang,
          })) as { text: string; on_device: boolean | null };
          saveRecording(wav, "sys", r.text, { source: "asr" }).catch((e) =>
            console.error("保存录音失败:", e)
          );
          setSysOnDevice(r.on_device);
          setText(r.text);
          setElapsed(Math.round((Date.now() - t0) / 100) / 10);
          setState("done");
          return;
        }
        const r = await transcribe(wav, engine, punc, vad, engine === "whisper" ? whisperLang : "");
        // 顺手保存录音到音频库（不阻塞）
        saveRecording(wav, engine, r.text, { source: "asr" }).catch((e) =>
          console.error("保存录音失败:", e)
        );
        setText(r.text);
        setElapsed(Math.round((Date.now() - t0) / 100) / 10);
        setState("done");
      } catch (e) {
        setError(String(e));
        setState("idle");
      }
    } else {
      try {
        const rec = await createRecorder();
        recRef.current = rec;
        rec.start();
        setState("recording");
        setText("");
      } catch (e) {
        setError("无法访问麦克风: " + e);
      }
    }
  };

  const cancel = () => {
    recRef.current?.cancel();
    recRef.current = null;
    setState("idle");
  };

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    alert("已复制");
  };

  const exportFile = () => {
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "识别文本.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Panel
      title="识别面板"
      subtitle="录音 → 本地语音识别 → 文本（SenseVoice 中文最优）"
      actions={state === "recording" && (
        <Button variant="danger" onClick={cancel}>
          取消
        </Button>
      )}
    >
      <div className="asr-control">
        <button
          className={`mic-btn ${state === "recording" ? "recording" : ""}`}
          onClick={toggle}
          disabled={state === "processing"}
        >
          {state === "recording" ? (
            <>
              <span className="mic-pulse" /> 点击结束并识别
            </>
          ) : state === "processing" ? (
            <>
              <Spinner /> 识别中…
            </>
          ) : (
            <>
              <Icon icon="lucide:mic" width={16} height={16} /> 开始录音
            </>
          )}
        </button>
        <label>
          识别引擎
          <Select
            value={engine}
            onChange={pickAsrEngine}
            options={[
              { value: "auto", label: "自动（SenseVoice 优先）" },
              { value: "sensevoice", label: `SenseVoice 量化版（sherpa · 快）${asrOffLabel("sensevoice")}` },
              {
                value: "sensevoice-original",
                label: `SenseVoice 原始版（funasr · 高精度）${asrOffLabel("sensevoice-original")}`,
              },
              { value: "whisper", label: `Whisper${asrOffLabel("whisper")}` },
              ...(isMac
                ? [{ value: "sys", label: "系统识别（mac 系统兜底 · 零下载）" }]
                : []),
              { value: "azure", label: "Azure 语音识别（云 · 出网 · 自带标点）" },
            ]}
          />
        </label>
        {engine === "azure" && (
          <label className="whisper-lang">
            Azure 识别语言
            <Select
              value={azureLang}
              onChange={(v) => {
                setAzureLang(v);
                updateSettings({ azureAsrLanguage: v }).catch(() => {});
              }}
              options={AZURE_ASR_LANGS.map((c) => ({ value: c, label: `${langLabel(c)}（${c}）` }))}
            />
            <span className="hint">
              {azureAsrConfigured()
                ? "录音将出网到 Azure 语音服务（Key/Region 与朗读共用，在 设置 → 云端能力 配置）。"
                : "⚠️ 未配置 Azure Key/Region —— 请到 设置 → 云端能力 填写。"}
            </span>
          </label>
        )}
        {engine === "sys" && (
          <label className="whisper-lang">
            系统识别语言
            <Select
              value={sysLang}
              onChange={setSysLang}
              options={(sysLocales.length
                ? sysLocales
                : ["zh-CN", "en-US"]
              ).map((c) => ({ value: c, label: sysLangLabel(c) }))}
            />
            <span className="hint">
              走 macOS 自带 SFSpeechRecognizer（零下载兜底）；精度与多语言不如
              SenseVoice/Whisper。首次使用会请求「语音识别」权限。
              {sysOnDevice === false && " ⚠️ 本语言设备端模型未下载，将联网识别。"}
            </span>
          </label>
        )}
        {engine === "whisper" && (
          <label className="whisper-lang">
            Whisper 语言
            <Select value={whisperLang} onChange={setWhisperLang} options={WHISPER_LANG_OPTIONS} />
            <span className="hint">语言请与所说语言一致（如说法语选「法语 fr」）</span>
          </label>
        )}
        <label className="punc-toggle">
          <input
            type="checkbox"
            checked={punc}
            onChange={(e) => setPunc(e.target.checked)}
            disabled={engine === "sys"}
          />
          自动加标点
        </label>
        <label className="punc-toggle">
          <input
            type="checkbox"
            checked={vad}
            onChange={(e) => setVad(e.target.checked)}
            disabled={engine === "sys"}
          />
          自动过滤静音(VAD)
        </label>
      </div>

      <div className="engine-status">
        <EngineBadge
          label="SenseVoice 量化版"
          ready={svReady}
          starting={computeStarting(getPersistedSettings(), props.health).asr}
        />
        <EngineBadge
          label="SenseVoice 原始版"
          ready={!!hasOrig}
          starting={computeStarting(getPersistedSettings(), props.health).sensevoiceOriginal}
          availableOff={!hasOrig && computeStarting(getPersistedSettings(), props.health).ecoDisabled("sensevoice-original")}
        />
        <EngineBadge label="Whisper" ready={whisperReady} />
        {isMac && <EngineBadge label="系统识别" ready />}
        <EngineBadge label="Azure 云识别" ready={azureAsrConfigured()} />
      </div>

      {error && (
        <div className="error-box">
          <Icon icon="lucide:triangle-alert" width={16} height={16} /> {error}
        </div>
      )}

      {state === "done" && text && (
        <div className="result-box">
          <div className="result-label">
            识别结果{elapsed ? ` · ${elapsed}s` : ""}
          </div>
          <div className="result-text">{text}</div>
          <div className="result-actions">
            <Button variant="ghost" onClick={copy}>
              <Icon icon="lucide:clipboard" width={16} height={16} /> 复制
            </Button>
            <Button variant="ghost" onClick={exportFile}>
              <Icon icon="lucide:save" width={16} height={16} /> 导出
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
