import { useRef, useState } from "react";
import type { PanelProps } from "../App";
import { Icon } from "@iconify/react";
import { transcribe, computeStarting, getPersistedSettings } from "../api";
import { createRecorder, type Recorder } from "../audio";
import { saveRecording } from "../audioStore";
import { Panel, Button, Select, Spinner, EngineBadge } from "../components/ui";

type State = "idle" | "recording" | "processing" | "done";

export default function AsrPanel(props: PanelProps) {
  const [state, setState] = useState<State>("idle");
  const [engine, setEngine] = useState<string>("auto");
  const [punc, setPunc] = useState<boolean>(false);
  const [vad, setVad] = useState<boolean>(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState<number>(0);
  const recRef = useRef<Recorder | null>(null);

  const hasSense = props.health?.engines?.some((e) => e.includes("sensevoice"));
  // 原始版状态：从 /models 里 sensevoice-original 的 installed 读真实可达性（= funasr 后端 8002 是否在跑）
  const hasOrig = props.models?.some(
    (m) => m.engine === "sensevoice-original" && m.installed
  );

  const toggle = async () => {
    setError("");
    if (state === "recording") {
      setState("processing");
      const rec = recRef.current!;
      const wav = await rec.stop();
      recRef.current = null;
      const t0 = Date.now();
      try {
        const r = await transcribe(wav, engine, punc, vad);
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
            onChange={setEngine}
            options={[
              { value: "auto", label: "自动（SenseVoice 优先）" },
              { value: "sensevoice", label: "SenseVoice 量化版（sherpa · 快）" },
              { value: "sensevoice-original", label: "SenseVoice 原始版（funasr · 高精度）" },
              { value: "whisper", label: "Whisper" },
            ]}
          />
        </label>
        <label className="punc-toggle">
          <input
            type="checkbox"
            checked={punc}
            onChange={(e) => setPunc(e.target.checked)}
          />
          自动加标点
        </label>
        <label className="punc-toggle">
          <input
            type="checkbox"
            checked={vad}
            onChange={(e) => setVad(e.target.checked)}
          />
          自动过滤静音(VAD)
        </label>
      </div>

      <div className="engine-status">
        <EngineBadge
          label="SenseVoice 量化版"
          ready={!!hasSense}
          starting={computeStarting(getPersistedSettings(), props.health).asr}
        />
        <EngineBadge
          label="SenseVoice 原始版"
          ready={!!hasOrig}
          starting={computeStarting(getPersistedSettings(), props.health).sensevoiceOriginal}
        />
        <EngineBadge label="Whisper" ready={true} />
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
