import { useEffect, useRef, useState } from "react";
import type { PanelProps } from "../App";
import {
  createRealtimeSession,
  type RealtimeSession,
} from "../realtime";
import { saveRecording } from "../audioStore";
import { Panel, Button, Select, Spinner } from "../components/ui";

type Stage = "idle" | "listening" | "paused" | "processing" | "done";

interface Segment {
  index: number;
  text: string;
}

export default function RealtimePanel(_props: PanelProps) {
  const [stage, setStage] = useState<Stage>("idle");
  const [engine, setEngine] = useState<string>("auto");
  const [autoStop, setAutoStop] = useState<string>("0");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [error, setError] = useState<string>("");
  const [level, setLevel] = useState<number>(0);
  const [elapsed, setElapsed] = useState<number>(0);
  const [total, setTotal] = useState<number>(0);
  const [saved, setSaved] = useState<boolean>(false);
  const sessRef = useRef<RealtimeSession | null>(null);
  const t0Ref = useRef<number>(0);

  // 清理：卸载时确保停止采集
  useEffect(() => {
    return () => {
      sessRef.current?.cancel();
      sessRef.current = null;
    };
  }, []);

  // 自动停止：由 session 触发，回到收尾逻辑
  const finishStop = async (sess: RealtimeSession) => {
    setStage("processing");
    t0Ref.current = Date.now();
    try {
      await sess.stop();
      setElapsed(Math.round((Date.now() - t0Ref.current) / 100) / 10);
      setStage("done");
    } catch (e) {
      setError(String(e));
      setStage("done");
    }
  };

  const toggle = async () => {
    setError("");
    if (stage === "listening" || stage === "paused") {
      // 停止并收尾（保留 sessRef 供停止后"保存录音到音频库"使用）
      const sess = sessRef.current!;
      await finishStop(sess);
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
      const ms = Number(autoStop) * 1000;
      if (ms > 0) {
        sess.setAutoStop(ms);
        sess.setAutoStopHandler(() => {
          // 保留 sessRef 供停止后保存使用
          const cur = sessRef.current;
          if (cur) void finishStop(cur);
        });
      }
      sessRef.current = sess;
      setSegments([]);
      setTotal(0);
      setLevel(0);
      setSaved(false);
      try {
        await sess.start();
        setStage("listening");
      } catch (e) {
        setError("无法开始实时语音: " + e);
        setStage("idle");
      }
    }
  };

  const togglePause = async () => {
    const sess = sessRef.current;
    if (!sess) return;
    try {
      const paused = await sess.togglePause();
      setStage(paused ? "paused" : "listening");
    } catch (e) {
      setError("暂停/继续失败: " + e);
    }
  };

  const cancel = () => {
    sessRef.current?.cancel();
    sessRef.current = null;
    setStage("idle");
  };

  const saveToLibrary = async () => {
    const sess = sessRef.current;
    if (!sess) return;
    try {
      const wav = sess.getFullAudioWav();
      const text = segments.map((s) => s.text).join("");
      await saveRecording(wav, "realtime", text);
      setSaved(true);
    } catch (e) {
      setError("保存录音失败: " + e);
    }
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

  const listening = stage === "listening" || stage === "paused";

  return (
    <Panel
      title="实时语音"
      subtitle="边说边识别：说话停顿自动切句（VAD），无需手动结束"
      actions={
        stage === "listening" || stage === "paused" ? (
          <Button variant="danger" onClick={cancel}>
            取消
          </Button>
        ) : undefined
      }
    >
      <div className="home-big">
        <button
          className={`mic-btn ${listening ? "recording" : ""}`}
          onClick={toggle}
          disabled={stage === "processing"}
        >
          {listening ? (
            <>
              <span className="mic-pulse" />{" "}
              {stage === "paused" ? "已暂停，点击继续聆听" : "正在聆听，点击停止"}
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

      {listening && (
        <div className="realtime-controls">
          <Button variant="ghost" onClick={togglePause}>
            {stage === "paused" ? "▶️ 继续" : "⏸️ 暂停"}
          </Button>
        </div>
      )}

      {listening && (
        <div className="realtime-status">
          <span className="realtime-live-dot" />
          {stage === "paused"
            ? "已暂停 · 已识别 " + total + " 句"
            : "实时聆听中 · 已识别 " + total + " 句"}
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
        <label>
          静音自动停止
          <Select
            value={autoStop}
            onChange={setAutoStop}
            disabled={stage === "listening"}
            options={[
              { value: "0", label: "关闭（手动停止）" },
              { value: "2", label: "静音 2 秒自动停止" },
              { value: "3", label: "静音 3 秒自动停止" },
              { value: "5", label: "静音 5 秒自动停止" },
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
            {stage === "done" && sessRef.current && (
              <Button variant="ghost" onClick={saveToLibrary}>
                {saved ? "✅ 已保存" : "💿 保存录音到音频库"}
              </Button>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
