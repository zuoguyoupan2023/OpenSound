import { useRef, useState, useEffect } from "react";
import type { PanelProps } from "../App";
import { chat, transcribe, speakStream } from "../api";
import { createRecorder, type Recorder, createFramePlayer, stopAudio } from "../audio";
import { saveRecording, teeCollect, mergeWavFrames, saveTts } from "../audioStore";
import { listVoices, type CloneVoice } from "../voiceStore";
import { Panel, Button, Select, Spinner, EngineBadge } from "../components/ui";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

export default function ChatPanel(props: PanelProps) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [engine, setEngine] = useState<string>("llama-cpp");
  const [llmModel, setLlmModel] = useState<string>("llm-qwen3-8b");
  const [ttsEngine, setTtsEngine] = useState<"kokoro" | "qwen3" | "clone">("kokoro");
  const [cloneVoices, setCloneVoices] = useState<CloneVoice[]>([]);
  const [cloneVoiceId, setCloneVoiceId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState("");
  const recRef = useRef<Recorder | null>(null);
  const playerRef = useRef<ReturnType<typeof createFramePlayer> | null>(null);

  const llmReady = props.health?.llm?.model !== "missing";
  // 已安装的 LLM 档位（来自 /models）
  const installedLlmModels = (props.models || []).filter(
    (m) => m.category === "llm" && m.installed
  );

  // 加载克隆音色（供对话朗读选用）
  useEffect(() => {
    listVoices()
      .then((vs) => {
        setCloneVoices(vs);
        if (vs.length) setCloneVoiceId(vs[0].id);
      })
      .catch(() => {});
  }, []);

  const sendText = async (content: string) => {
    if (!content.trim() || busy) return;
    setError("");
    setMessages((m) => [...m, { role: "user", content }]);
    setInput("");
    setBusy(true);
    try {
      const history: { role: "system" | "user" | "assistant"; content: string }[] = [
        { role: "system", content: "你是一个本地语音助手，用简洁的中文回答用户。" },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content },
      ];
      const r = await chat(history, engine, llmModel);
      setMessages((m) => [...m, { role: "assistant", content: r.text }]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const startRec = async () => {
    setError("");
    try {
      const rec = await createRecorder();
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      setError("无法访问麦克风: " + e);
    }
  };

  const stopRec = async () => {
    const rec = recRef.current!;
    setRecording(false);
    setBusy(true);
    try {
      const wav = await rec.stop();
      recRef.current = null;
      const r = await transcribe(wav, "auto");
      saveRecording(wav, "auto", r.text).catch((e) =>
        console.error("保存录音失败:", e)
      );
      await sendText(r.text);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const speakAnswer = async (text: string) => {
    stopAudio();
    setSpeaking(true);
    const player = createFramePlayer();
    playerRef.current = player;
    try {
      const stream = await speakStream({
        text,
        engine: ttsEngine,
        voice: ttsEngine === "clone" ? cloneVoiceId : undefined,
      });
      const { playStream, collected } = teeCollect(stream);
      await player.start(playStream);
      setSpeaking(false);
      // 播放完成后保存朗读结果（不阻塞）
      collected
        .then((frames) => {
          if (frames.length)
            return saveTts(mergeWavFrames(frames), ttsEngine, text);
        })
        .catch((e) => console.error("保存朗读失败:", e));
    } catch (e) {
      setError(String(e));
      setSpeaking(false);
    }
  };

  const stopSpeak = () => {
    playerRef.current?.stop();
    playerRef.current = null;
    stopAudio();
    setSpeaking(false);
  };

  return (
    <Panel
      title="对话面板"
      subtitle="文字或语音 → 本地 LLM → 朗读回答"
      actions={
        speaking ? (
          <Button variant="danger" onClick={stopSpeak}>
            停止朗读
          </Button>
        ) : undefined
      }
    >
      <div className="chat-box">
        {messages.length === 0 && (
          <div className="chat-empty">输入问题，或点击🎙️用语音提问</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="chat-content">{m.content}</div>
            {m.role === "assistant" && (
              <div className="chat-tools">
                <button
                  className="link-btn"
                  onClick={() => speakAnswer(m.content)}
                  disabled={speaking}
                >
                  🔊 朗读
                </button>
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="chat-msg assistant">
            <Spinner /> 思考中…
          </div>
        )}
      </div>

      <div className="chat-input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendText(input);
            }
          }}
          placeholder="输入消息，Enter 发送…"
          rows={3}
          disabled={busy}
        />
        <div className="chat-actions">
          <button
            className={`mic-mini ${recording ? "recording" : ""}`}
            onClick={recording ? stopRec : startRec}
            disabled={busy}
            title="语音提问"
          >
            {recording ? "🔴 结束" : "🎙️"}
          </button>
          <Button onClick={() => sendText(input)} disabled={busy || !input.trim()}>
            发送
          </Button>
        </div>
      </div>

      <div className="chat-opts">
        <Select
          value={engine}
          onChange={setEngine}
          options={[
            { value: "llama-cpp", label: "LLM: llama-cpp" },
            { value: "ollama", label: "LLM: Ollama" },
          ]}
        />
        {engine === "llama-cpp" && (
          <Select
            value={llmModel}
            onChange={setLlmModel}
            options={
              installedLlmModels.length
                ? installedLlmModels.map((m) => ({
                    value: m.engine,
                    label: `模型: ${m.label}`,
                  }))
                : [{ value: "llm-qwen3-8b", label: "模型: Qwen3-8B（未下载）" }]
            }
          />
        )}
        <Select
          value={ttsEngine}
          onChange={setTtsEngine}
          options={[
            { value: "kokoro", label: "朗读: Kokoro" },
            { value: "qwen3", label: "朗读: Qwen3" },
            { value: "clone", label: "朗读: 克隆音色" },
          ]}
        />
        {ttsEngine === "clone" && (
          <Select
            value={cloneVoiceId}
            onChange={setCloneVoiceId}
            options={
              cloneVoices.length
                ? cloneVoices.map((v) => ({ value: v.id, label: `🎨 ${v.name}` }))
                : [{ value: "", label: "（无克隆音色）" }]
            }
          />
        )}
        <EngineBadge label="LLM" ready={llmReady} />
      </div>

      {error && <div className="error-box">⚠️ {error}</div>}
    </Panel>
  );
}
