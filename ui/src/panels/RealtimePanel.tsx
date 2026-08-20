import { useEffect, useRef, useState } from "react";
import type { PanelProps } from "../App";
import {
  createRealtimeSession,
  type RealtimeSession,
} from "../realtime";
import { Panel, Button, Select, Spinner } from "../components/ui";

type Stage = "idle" | "listening" | "processing" | "done";

interface Segment {
  index: number;
  text: string;
}

export default function RealtimePanel(_props: PanelProps) {
  const [stage, setStage] = useState<Stage>("idle");
  const [engine, setEngine] = useState<string>("auto");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [error, setError] = useState<string>("");
  const [level, setLevel] = useState<number>(0);
  const [elapsed, setElapsed] = useState<number>(0);
  const [total, setTotal] = useState<number>(0);
  const sessRef = useRef<RealtimeSession | null>(null);
  const t0Ref = useRef<number>(0);

  // 清理：卸载时确保停止采集
  useEffect(() => {
    return () => {
      sessRef.current?.cancel();
      sessRef.current = null;
    };
  }, []);

  const toggle = async () => {
    setError("");
    if (stage === "listening") {
      // 停止并收尾
      setStage("processing");
      const sess = sessRef.current!;
      sessRef.current = null;
      t0Ref.current = Date.now();
      try {
        await sess.stop();
        setElapsed(Math.round((Date.now() - t0Ref.current) / 100) / 10);
        setStage("done");
      } catch (e) {
        setError(String(e));
        setStage("done");
      }
    } else {
      // 开始实时聆听
      const sess = createRealtimeSession(engine, {
        onSegment: (text, index) => {
          setSegments((prev) => [...prev, { index, text }]);
          setTotal((n) => n + 1);
        },
        onListening: ({ level: lv }) => setLevel(lv),
        onError: (msg) => setError(msg),
      });
      sessRef.current = sess;
      setSegments([]);
      setTotal(0);
      setLevel(0);
      try {
        await sess.start();
        setStage("listening");
      } catch (e) {
        setError("无法开始实时语音: " + e);
        setStage("idle");
      }
    }
  };

  const cancel = () => {
    sessRef.current?.cancel();
    sessRef.current = null;
    setStage("idle");
  };

  const copyAll = async () => {
    const text = segments.map((s) => s.text).join("\n");
    await navigator.clipboard.writeText(text);
    alert("已复制全部识别文本");
  };

  const exportAll = () => {
    const text = segments.map((s) => s.text).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "实时识别文本.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Panel
      title="实时语音"
      subtitle="边说边识别：说话停顿自动切句（VAD），无需手动结束"
      actions={
        stage !== "idle" && stage !== "processing" && (
          <Button variant="danger" onClick={cancel}>
            取消
          </Button>
        )
      }
    >
      <div className="home-big">
        <button
          className={`mic-btn ${stage === "listening" ? "recording" : ""}`}
          onClick={toggle}
          disabled={stage === "processing"}
        >
          {stage === "listening" ? (
            <>
              <span className="mic-pulse" /> 正在聆听，点击停止
            </>
          ) : stage === "processing" ? (
            <>
              <Spinner /> 收尾中…
            </>
          ) : (
            <>🎙️ 开始实时语音</>
          )}
        </button>
      </div>

      {stage === "listening" && (
        <div className="realtime-status">
          <span className="realtime-live-dot" />
          实时聆听中 · 已识别 {total} 句
          <span className="realtime-level">
            <span
              className="realtime-level-bar"
              style={{ width: `${Math.round(level * 100)}%` }}
            />
          </span>
        </div>
      )}

      <div className="field-row">
        <label>
          识别引擎
          <Select
            value={engine}
            onChange={setEngine}
            disabled={stage === "listening"}
            options={[
              { value: "auto", label: "自动（SenseVoice 优先）" },
              { value: "sensevoice", label: "SenseVoice" },
              { value: "whisper", label: "Whisper" },
            ]}
          />
        </label>
      </div>

      {error && <div className="error-box">⚠️ {error}</div>}

      {segments.length > 0 && (
        <div className="result-box">
          <div className="result-label">
            识别结果（{total} 句）
            {elapsed ? ` · 收尾耗时 ${elapsed}s` : ""}
          </div>
          <div className="result-text realtime-text">
            {segments.map((s) => (
              <div key={s.index} className="realtime-segment">
                <span className="realtime-seg-no">{s.index}.</span> {s.text}
              </div>
            ))}
          </div>
          <div className="result-actions">
            <Button variant="ghost" onClick={copyAll}>
              📋 复制全部
            </Button>
            <Button variant="ghost" onClick={exportAll}>
              💾 导出
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
