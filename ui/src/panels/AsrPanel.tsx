import { useRef, useState } from "react";
import type { PanelProps } from "../App";
import { transcribe } from "../api";
import { createRecorder, type Recorder } from "../audio";
import { saveRecording } from "../audioStore";
import { Panel, Button, Select, Spinner, EngineBadge } from "../components/ui";

type State = "idle" | "recording" | "processing" | "done";

export default function AsrPanel(props: PanelProps) {
  const [state, setState] = useState<State>("idle");
  const [engine, setEngine] = useState<string>("auto");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState<number>(0);
  const recRef = useRef<Recorder | null>(null);

  const hasSense = props.health?.engines?.some((e) => e.includes("sensevoice"));

  const toggle = async () => {
    setError("");
    if (state === "recording") {
      setState("processing");
      const rec = recRef.current!;
      const wav = await rec.stop();
      recRef.current = null;
      const t0 = Date.now();
      try {
        const r = await transcribe(wav, engine);
        // 顺手保存录音到音频库（不阻塞）
        saveRecording(wav, engine, r.text).catch((e) =>
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
            <>🎙️ 开始录音</>
          )}
        </button>
        <label>
          识别引擎
          <Select
            value={engine}
            onChange={setEngine}
            options={[
              { value: "auto", label: "自动（SenseVoice 优先）" },
              { value: "sensevoice", label: "SenseVoice" },
              { value: "whisper", label: "Whisper" },
            ]}
          />
        </label>
      </div>

      <div className="engine-status">
        <EngineBadge label="SenseVoice" ready={!!hasSense} />
        <EngineBadge label="Whisper" ready={true} />
      </div>

      {error && <div className="error-box">⚠️ {error}</div>}

      {state === "done" && text && (
        <div className="result-box">
          <div className="result-label">
            识别结果{elapsed ? ` · ${elapsed}s` : ""}
          </div>
          <div className="result-text">{text}</div>
          <div className="result-actions">
            <Button variant="ghost" onClick={copy}>
              📋 复制
            </Button>
            <Button variant="ghost" onClick={exportFile}>
              💾 导出
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
