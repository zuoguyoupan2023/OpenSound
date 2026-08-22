import { useRef, useState, useEffect } from "react";
import type { PanelProps } from "../App";
import { Icon } from "@iconify/react";
import { speakStream } from "../api";
import { createFramePlayer, type FramePlayer, stopAudio } from "../audio";
import {
  teeCollect,
  mergeWavFrames,
  saveTts,
  listAudio,
  deleteAudio,
  type AudioRecord,
} from "../audioStore";
import { fmtTime, fmtDur, truncate } from "../format";
import { useAudioPlayback } from "../useAudioPlayback";
import { showToast } from "../toast";
import { listVoices, type CloneVoice } from "../voiceStore";
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
  const [engine, setEngine] = useState<"kokoro" | "qwen3" | "clone">("kokoro");
  const [sid, setSid] = useState<number>(18);
  const [speed, setSpeed] = useState<number>(1);
  const [voice, setVoice] = useState<string>("Vivian");
  const [language, setLanguage] = useState<string>("Auto");
  const [cloneVoices, setCloneVoices] = useState<CloneVoice[]>([]);
  const [cloneVoiceId, setCloneVoiceId] = useState<string>("");
  const [state, setState] = useState<Speaking>("idle");
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [history, setHistory] = useState<AudioRecord[]>([]);
  const playerRef = useRef<FramePlayer | null>(null);
  // 朗读中断控制：停止时 abort 底层流，服务端不再继续合成
  const speakAbortRef = useRef<AbortController | null>(null);
  const speakStoppedRef = useRef(false);
  // 历史条目播放（与音频库同款单实例逻辑）
  const { playingId, togglePlay, stopPlay } = useAudioPlayback((m) =>
    setError(m)
  );

  const kokoroReady = props.health?.tts.kokoro === "ready";
  const qwen3Ready = props.health?.tts.qwen3 === "reachable";
  const cloneReady = props.health?.tts.cosyvoice === "reachable";

  // 加载克隆音色列表（供朗读引擎选用）
  useEffect(() => {
    listVoices()
      .then((vs) => {
        setCloneVoices(vs);
        if (vs.length) setCloneVoiceId(vs[0].id);
      })
      .catch(() => {});
  }, []);

  // 载入最近朗读历史（音频库 kind=tts，最近 20 条），离开面板时停止播放
  useEffect(() => {
    listAudio()
      .then((all) =>
        setHistory(all.filter((r) => r.kind === "tts").slice(0, 20))
      )
      .catch((e) => console.error("载入朗读历史失败:", e));
    return () => stopPlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    speakStoppedRef.current = false;
    const player = createFramePlayer((i) => console.log("播放第", i + 1, "句"));
    playerRef.current = player;
    const ac = new AbortController();
    speakAbortRef.current = ac;
    try {
      const stream = await speakStream(
        {
          text,
          engine,
          sid,
          speed,
          voice: engine === "clone" ? cloneVoiceId : voice,
          language,
        },
        ac.signal
      );
      const { playStream, collected } = teeCollect(stream);
      // 落盘与播放解耦：流读完（含被中断）即保存，不再等播放完成
      collected
        .then(async (frames) => {
          if (!frames.length) return;
          const rec = await saveTts(mergeWavFrames(frames), engine, text, {
            source: "read",
            voice:
              engine === "clone"
                ? cloneVoiceId
                : engine === "qwen3"
                ? voice
                : undefined,
            sid: engine === "kokoro" ? sid : undefined,
            speed: engine === "kokoro" ? speed : undefined,
            language: engine === "qwen3" ? language : undefined,
            interrupted: speakStoppedRef.current || undefined,
          }).catch((e) => console.error("保存朗读失败:", e));
          if (rec) {
            setHistory((h) => [rec, ...h].slice(0, 20));
            showToast(
              speakStoppedRef.current
                ? "已保存已生成部分（已截断）"
                : "已存入朗读历史"
            );
          }
        })
        .catch((e) => console.error("收集朗读帧失败:", e));
      await player.start(playStream);
      setState("done");
    } catch (e) {
      // 主动停止不算错误
      if (!speakStoppedRef.current) {
        setError(String(e));
        setState("idle");
      }
    }
  };

  const stop = () => {
    // 先标记停止，再中断流、停播放器；已生成的句子会以「已截断」入库
    speakStoppedRef.current = true;
    speakAbortRef.current?.abort();
    speakAbortRef.current = null;
    playerRef.current?.stop();
    playerRef.current = null;
    stopAudio();
    setState("idle");
  };

  const removeHistory = async (rec: AudioRecord) => {
    if (!window.confirm("删除这条朗读记录？")) return;
    if (playingId === rec.id) stopPlay();
    try {
      await deleteAudio(rec.id);
      setHistory((h) => h.filter((x) => x.id !== rec.id));
    } catch (e) {
      setError(String(e));
    }
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
            { value: "clone", label: "克隆音色（CosyVoice）" },
          ]}
        />
        {engine === "clone" && (
          <>
            <Select
              value={cloneVoiceId}
              onChange={setCloneVoiceId}
              options={
                cloneVoices.length
                  ? cloneVoices.map((v) => ({ value: v.id, label: v.name }))
                  : [{ value: "", label: "（无克隆音色，请先到「音色管理」新建）" }]
              }
            />
            {!cloneReady && <span className="muted">（克隆服务未就绪）</span>}
          </>
        )}
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
            <Icon icon="lucide:folder-open" width={16} height={16} /> 打开文件
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
            {state === "speaking" ? (
              <Spinner />
            ) : (
              <>
                <Icon icon="lucide:volume-2" width={16} height={16} /> 朗读
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="engine-status">
        <EngineBadge label="Kokoro" ready={kokoroReady} />
        <EngineBadge label="Qwen3" ready={qwen3Ready} />
        <EngineBadge label="克隆音色" ready={cloneReady} />
      </div>

      <div className="read-history">
        <div className="read-history-head">
          <span className="install-head">朗读历史（最近 {history.length} 条）</span>
          <Button variant="ghost" onClick={() => props.goPanel?.("audio")}>
            <Icon icon="lucide:music" width={16} height={16} /> 在音频库中查看
          </Button>
        </div>
        {history.length === 0 ? (
          <div className="empty">
            还没有朗读记录。点击上方「朗读」，完成后自动存到这里和音频库。
          </div>
        ) : (
          <div className="audio-list">
            {history.map((rec) => (
              <div key={rec.id} className="audio-row">
                <div className="audio-info">
                  <div className="audio-title">
                    <span className="src-badge src-read">朗读</span>
                    {rec.interrupted && (
                      <span className="src-badge src-cut">已截断</span>
                    )}
                    {rec.text ? truncate(rec.text) : "（无文本）"}
                  </div>
                  <div className="model-meta">
                    <span>{fmtTime(rec.created_at)}</span>
                    {fmtDur(rec.duration_sec) && (
                      <span>{fmtDur(rec.duration_sec)}</span>
                    )}
                    <span className="model-cat">{rec.engine || "auto"}</span>
                  </div>
                </div>
                <div className="audio-actions">
                  <Button
                    variant="ghost"
                    onClick={() => togglePlay(rec).catch((e) => setError(String(e)))}
                    disabled={playingId !== null && playingId !== rec.id}
                  >
                    {playingId === rec.id ? (
                      <>
                        <Icon icon="lucide:square" width={16} height={16} /> 停止
                      </>
                    ) : (
                      <>
                        <Icon icon="lucide:play" width={16} height={16} /> 播放
                      </>
                    )}
                  </Button>
                  <Button variant="danger" onClick={() => removeHistory(rec)}>
                    <Icon icon="lucide:trash-2" width={16} height={16} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="error-box">
          <Icon icon="lucide:triangle-alert" width={16} height={16} /> {error}
        </div>
      )}
    </Panel>
  );
}
