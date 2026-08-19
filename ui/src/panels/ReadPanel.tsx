import { useRef, useState } from "react";
import type { PanelProps } from "../App";
import { speakStream } from "../api";
import { createFramePlayer, type FramePlayer, stopAudio } from "../audio";
import { Panel, Button, Select, Spinner, EngineBadge } from "../components/ui";

const KOKORO_VOICES = [
  { sid: 18, label: "18（中文女声）" },
  { sid: 20, label: "20（中文女声）" },
  { sid: 21, label: "21（中文女声）" },
  { sid: 48, label: "48（中文）" },
  { sid: 49, label: "49（中文）" },
  { sid: 50, label: "50（中文）" },
  { sid: 51, label: "51（中文）" },
  { sid: 52, label: "52（中文）" },
];

const QWEN3_VOICES = ["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"];

type Speaking = "idle" | "speaking" | "done";

export default function ReadPanel(props: PanelProps) {
  const [text, setText] = useState("");
  const [engine, setEngine] = useState<"kokoro" | "qwen3">("kokoro");
  const [sid, setSid] = useState<number>(18);
  const [speed, setSpeed] = useState<number>(1);
  const [voice, setVoice] = useState<string>("Vivian");
  const [language, setLanguage] = useState<string>("Auto");
  const [state, setState] = useState<Speaking>("idle");
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const playerRef = useRef<FramePlayer | null>(null);

  const kokoroReady = props.health?.tts.kokoro === "ready";
  const qwen3Ready = props.health?.tts.qwen3 === "reachable";

  const loadFile = async (file: File) => {
    const t = await file.text();
    setText(t);
    setFileName(file.name);
  };

  const speak = async () => {
    if (!text.trim()) {
      setError("请输入或选择要朗读的文本");
      return;
    }
    setError("");
    stopAudio();
    setState("speaking");
    const player = createFramePlayer((i) => console.log("播放第", i + 1, "句"));
    playerRef.current = player;
    try {
      const stream = await speakStream({
        text,
        engine,
        sid,
        speed,
        voice,
        language,
      });
      await player.start(stream);
      setState("done");
    } catch (e) {
      setError(String(e));
      setState("idle");
    }
  };

  const stop = () => {
    playerRef.current?.stop();
    playerRef.current = null;
    stopAudio();
    setState("idle");
  };

  return (
    <Panel
      title="朗读面板"
      subtitle="粘贴文本或打开文件，选择引擎与音色，本地合成语音"
      actions={
        state === "speaking" && (
          <Button variant="danger" onClick={stop}>
            停止
          </Button>
        )
      }
    >
      <div className="toolbar">
        <Select
          value={engine}
          onChange={setEngine}
          options={[
            { value: "kokoro", label: "Kokoro（本地，53 音色）" },
            { value: "qwen3", label: "Qwen3（低延迟）" },
          ]}
        />
        {engine === "kokoro" && (
          <>
            <Select
              value={String(sid)}
              onChange={(v) => setSid(Number(v))}
              options={KOKORO_VOICES.map((v) => ({
                value: String(v.sid),
                label: v.label,
              }))}
            />
            <label className="inline-field">
              语速
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.1}
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              />
              <span>{speed.toFixed(1)}x</span>
            </label>
          </>
        )}
        {engine === "qwen3" && (
          <>
            <Select
              value={voice}
              onChange={setVoice}
              options={QWEN3_VOICES.map((v) => ({ value: v, label: v }))}
            />
            <Select
              value={language}
              onChange={setLanguage}
              options={[
                { value: "Auto", label: "自动" },
                { value: "zh", label: "中文" },
                { value: "en", label: "英文" },
              ]}
            />
          </>
        )}
      </div>

      <div className="read-input">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="在这里粘贴要朗读的文本…"
          rows={8}
        />
        <div className="read-tools">
          <label className="file-btn">
            📂 打开文件
            <input
              type="file"
              accept=".txt,.md"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) loadFile(f);
              }}
            />
          </label>
          {fileName && <span className="muted">已载入: {fileName}</span>}
          <Button onClick={speak} disabled={state === "speaking"}>
            {state === "speaking" ? <Spinner /> : "🔊 朗读"}
          </Button>
        </div>
      </div>

      <div className="engine-status">
        <EngineBadge label="Kokoro" ready={kokoroReady} />
        <EngineBadge label="Qwen3" ready={qwen3Ready} />
      </div>

      {error && <div className="error-box">⚠️ {error}</div>}
    </Panel>
  );
}
