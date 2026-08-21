import { useRef, useState } from "react";
import type { PanelProps } from "../App";
import { Icon } from "@iconify/react";
import { voiceChat } from "../api";
import { createRecorder, type Recorder, playWav, stopAudio } from "../audio";
import { saveRecording, saveTts } from "../audioStore";
import { Panel, Button, EngineBadge, Select, Spinner } from "../components/ui";

type Stage = "idle" | "recording" | "processing" | "speaking" | "done";

export default function HomePanel(props: PanelProps) {
  const [stage, setStage] = useState<Stage>("idle");
  const [asrEngine, setAsrEngine] = useState<string>("auto");
  const [llmEngine, setLlmEngine] = useState<string>("llama-cpp");
  const [llmModel, setLlmModel] = useState<string>("llm-qwen3-8b");
  const [ttsEngine, setTtsEngine] = useState<"kokoro" | "qwen3">("kokoro");
  const [result, setResult] = useState<{
    recognized: string;
    answer: string;
    audioBase64: string;
  } | null>(null);
  const [error, setError] = useState<string>("");
  const recRef = useRef<Recorder | null>(null);

  const kokoroReady = props.health?.tts.kokoro === "ready";
  const qwen3Ready = props.health?.tts.qwen3 === "reachable";
  const ttsReady = ttsEngine === "kokoro" ? kokoroReady : qwen3Ready;

  const toggle = async () => {
    setError("");
    if (stage === "recording") {
      // 停止录音并提交全链路
      setStage("processing");
      const rec = recRef.current!;
      const wav = await rec.stop();
      recRef.current = null;
      try {
        const r = await voiceChat(wav, {
          asrEngine,
          llmEngine,
          llmModel,
          ttsEngine,
        });
        // 顺手保存录音 + 朗读结果到音频库（不阻塞）
        saveRecording(wav, asrEngine, r.recognized).catch((e) =>
          console.error("保存录音失败:", e)
        );
        saveTts(r.audioBase64, ttsEngine, r.answer).catch((e) =>
          console.error("保存朗读失败:", e)
        );
        setResult(r);
        setStage("speaking");
        await playWav(base64ToBlob(r.audioBase64));
        setStage("done");
      } catch (e) {
        setError(String(e));
        setStage("done");
      }
    } else {
      // 开始录音
      try {
        const rec = await createRecorder();
        recRef.current = rec;
        rec.start();
        setStage("recording");
      } catch (e) {
        setError("无法访问麦克风: " + e);
      }
    }
  };

  const cancel = () => {
    recRef.current?.cancel();
    recRef.current = null;
    stopAudio();
    setStage("idle");
  };

  return (
    <Panel
      title="语音工作台"
      subtitle="说 → 想 → 读，一键完成本地语音对话闭环"
      actions={
        stage !== "idle" && (
          <Button variant="danger" onClick={cancel}>
            取消
          </Button>
        )
      }
    >
      <div className="home-big">
        <button
          className={`mic-btn ${stage === "recording" ? "recording" : ""}`}
          onClick={toggle}
          disabled={stage === "processing"}
        >
          {stage === "recording" ? (
            <>
              <span className="mic-pulse" /> 点击结束录音
            </>
          ) : stage === "processing" ? (
            <>
              <Spinner /> 识别 + 思考 + 朗读…
            </>
          ) : (
            <>
              <Icon icon="lucide:mic" width={16} height={16} />{" "}
              按住说话（点击开始/结束）
            </>
          )}
        </button>
      </div>

      <div className="field-row">
        <label>
          识别引擎
          <Select
            value={asrEngine}
            onChange={setAsrEngine}
            options={[
              { value: "auto", label: "自动（SenseVoice 优先）" },
              { value: "sensevoice", label: "SenseVoice" },
              { value: "whisper", label: "Whisper" },
            ]}
          />
        </label>
        <label>
          LLM 引擎
          <Select
            value={llmEngine}
            onChange={setLlmEngine}
            options={[
              { value: "llama-cpp", label: "llama-cpp（本地）" },
              { value: "ollama", label: "Ollama（后备）" },
            ]}
          />
        </label>
        {llmEngine === "llama-cpp" && (
          <label>
            LLM 模型
            <Select
              value={llmModel}
              onChange={setLlmModel}
              options={
                (props.models || []).filter(
                  (m) => m.category === "llm" && m.installed
                ).length
                  ? (props.models || [])
                      .filter((m) => m.category === "llm" && m.installed)
                      .map((m) => ({ value: m.engine, label: m.label }))
                  : [{ value: "llm-qwen3-8b", label: "Qwen3-8B（未下载）" }]
              }
            />
          </label>
        )}
        <label>
          朗读引擎
          <Select
            value={ttsEngine}
            onChange={setTtsEngine}
            options={[
              { value: "kokoro", label: "Kokoro（本地）" },
              { value: "qwen3", label: "Qwen3（低延迟）" },
            ]}
          />
        </label>
      </div>

      <div className="engine-status">
        <EngineBadge
          label="ASR"
          ready={!!props.health && (props.health.engines?.length ?? 0) > 0}
        />
        <EngineBadge
          label="LLM"
          ready={!!props.health && props.health.llm?.model !== "missing"}
        />
        <EngineBadge
          label={`朗读·${ttsEngine}`}
          ready={!!props.health && ttsReady}
        />
      </div>

      {error && (
        <div className="error-box">
          <Icon icon="lucide:triangle-alert" width={16} height={16} /> {error}
        </div>
      )}

      {result && (
        <div className="result-box">
          <div className="result-block">
            <div className="result-label">识别到</div>
            <div className="result-text">{result.recognized}</div>
          </div>
          <div className="result-block">
            <div className="result-label">本地回答</div>
            <div className="result-text">{result.answer}</div>
          </div>
          {stage === "done" && (
            <div className="result-replay">
              <Button onClick={() => playWav(base64ToBlob(result.audioBase64))}>
                <Icon icon="lucide:rotate-ccw" width={16} height={16} /> 重新播放
              </Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function base64ToBlob(b64: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "audio/wav" });
}
