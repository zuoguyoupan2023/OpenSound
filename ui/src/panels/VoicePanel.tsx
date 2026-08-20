import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelProps } from "../App";
import {
  listVoices,
  createVoice,
  renameVoice,
  deleteVoice,
  listSampleCandidates,
  previewVoiceUrl,
  type CloneVoice,
} from "../voiceStore";
import type { AudioRecord } from "../audioStore";
import { Panel, Button, Spinner } from "../components/ui";

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function truncate(s: string, n = 40): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export default function VoicePanel(_props: PanelProps) {
  const [voices, setVoices] = useState<CloneVoice[]>([]);
  const [samples, setSamples] = useState<AudioRecord[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [sampleId, setSampleId] = useState("");
  const [refText, setRefText] = useState("");
  const [genProgress, setGenProgress] = useState<{
    stage: string;
    pct: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const elRef = useRef<HTMLAudioElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      setVoices(await listVoices());
    } catch (e) {
      setError(String(e));
    }
    try {
      setSamples(await listSampleCandidates());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    return () => stopPlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopPlay = () => {
    elRef.current?.pause();
    elRef.current = null;
    setPlayingId(null);
  };

  const openCreate = () => {
    setShowCreate(true);
    setGenProgress(null);
    setError("");
    // 默认选第一个候选样本，并自动带出它的识别文本作参考提示
    if (samples.length) {
      const s = samples[0];
      setSampleId(s.id);
      setRefText(s.text || "");
      setName(s.text ? "我的-" + s.text.trim().slice(0, 6) : "我的克隆音色");
    }
  };

  const gen = async () => {
    if (!sampleId) {
      setError("请选择一段参考录音样本");
      return;
    }
    setError("");
    setGenProgress({ stage: "开始…", pct: 0 });
    try {
      await createVoice({
        name: name.trim() || "我的克隆音色",
        sourceRecordId: sampleId,
        referenceText: refText.trim(),
        onProgress: setGenProgress,
      });
      setVoices(await listVoices());
      setShowCreate(false);
      setGenProgress(null);
    } catch (e) {
      setError(String(e));
      setGenProgress(null);
    }
  };

  const preview = async (v: CloneVoice) => {
    if (playingId === v.id) {
      stopPlay();
      return;
    }
    stopPlay();
    try {
      const src = await previewVoiceUrl(v);
      if (!src) {
        setError("找不到参考样本音频（可能已删除）");
        return;
      }
      const el = new Audio(src);
      elRef.current = el;
      setPlayingId(v.id);
      el.onended = () => {
        elRef.current = null;
        setPlayingId(null);
      };
      await el.play();
    } catch (e) {
      setError(String(e));
      setPlayingId(null);
    }
  };

  const onRename = async (v: CloneVoice) => {
    const next = window.prompt("给音色改名：", v.name);
    if (next && next.trim()) {
      try {
        await renameVoice(v.id, next.trim());
        setVoices(await listVoices());
      } catch (e) {
        setError(String(e));
      }
    }
  };

  const onDelete = async (v: CloneVoice) => {
    if (!window.confirm(`删除克隆音色「${v.name}」？`)) return;
    if (playingId === v.id) stopPlay();
    try {
      await deleteVoice(v.id);
      setVoices(await listVoices());
    } catch (e) {
      setError(String(e));
    }
  };

  const selectedSample = samples.find((s) => s.id === sampleId);

  return (
    <Panel
      title="音色管理"
      subtitle="把录音样本变成可复用的克隆音色，供朗读/对话引擎选用"
      actions={
        <Button variant="ghost" onClick={refresh}>
          🔄 刷新
        </Button>
      }
    >
      <div className="voice-banner">
        🎨 克隆音色由本地 CosyVoice3 引擎生成。新建时从音频库选一段已标记为「🎨
        作样本」的录音，即可生成可复用的克隆音色。
      </div>

      {error && <div className="error-box">⚠️ {error}</div>}

      <div className="voice-toolbar">
        <Button onClick={openCreate} disabled={showCreate}>
          🆕 新建音色
        </Button>
      </div>

      {showCreate && (
        <div className="voice-create">
          <div className="voice-create-title">新建克隆音色</div>
          {genProgress ? (
            <div className="gen-progress">
              <Spinner /> {genProgress.stage}
              <div className="gen-bar">
                <div className="gen-bar-fill" style={{ width: `${genProgress.pct}%` }} />
              </div>
            </div>
          ) : (
            <>
              <div className="field-row">
                <label>
                  音色名称
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如：我的声音"
                  />
                </label>
              </div>

              <div className="field-row">
                <label>
                  参考录音样本（建议 3–10s、清晰单人声）
                  {samples.length === 0 ? (
                    <span className="muted">
                      还没有可用的录音。先去「音频库」把一段录音标记为「🎨 作样本」，或先录一段音。
                    </span>
                  ) : (
                    <select
                      value={sampleId}
                      onChange={(e) => {
                        const id = e.target.value;
                        setSampleId(id);
                        const s = samples.find((x) => x.id === id);
                        if (s && s.text) setRefText(s.text);
                      }}
                    >
                      {samples.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.is_clone_sample ? "🎨 " : ""}
                          {s.text ? truncate(s.text, 24) : "（无文本）"} ·{" "}
                          {new Date(s.created_at).toLocaleString()}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              </div>

              <div className="field-row">
                <label>
                  参考提示文本
                  <textarea
                    rows={3}
                    value={refText}
                    onChange={(e) => setRefText(e.target.value)}
                    placeholder="用一句话描述这段录音，克隆时作为参考提示"
                  />
                </label>
                {selectedSample?.text && (
                  <span className="muted">（已自动带出该录音的识别文本，可修改）</span>
                )}
              </div>

              <div className="voice-create-actions">
                <Button onClick={gen} disabled={samples.length === 0}>
                  生成
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setShowCreate(false);
                    setGenProgress(null);
                  }}
                >
                  取消
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {voices.length === 0 ? (
        <div className="empty">
          还没有克隆音色。点「🆕 新建音色」，从已标记的录音样本生成一个。
        </div>
      ) : (
        <div className="audio-list">
          {voices.map((v) => (
            <div key={v.id} className="audio-row">
              <div className="audio-info">
                <div className="audio-title">🎨 {v.name}</div>
                <div className="model-meta">
                  <span>{fmtTime(v.created_at)}</span>
                  <span className="model-cat">CosyVoice3 克隆</span>
                  {v.referenceText && <span>{truncate(v.referenceText, 24)}</span>}
                </div>
              </div>
              <div className="audio-actions">
                <Button
                  variant="ghost"
                  onClick={() => preview(v)}
                  title="试听该克隆音色（用此音色合成一句）"
                  disabled={playingId !== null && playingId !== v.id}
                >
                  {playingId === v.id ? "⏹ 停止" : "▶️ 试听"}
                </Button>
                <Button variant="ghost" onClick={() => onRename(v)} title="改名">
                  ✏️
                </Button>
                <Button variant="danger" onClick={() => onDelete(v)}>
                  🗑
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
