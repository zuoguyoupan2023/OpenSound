import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelProps } from "../App";
import {
  listAudio,
  deleteAudio,
  audioAssetUrl,
  getAudioDir,
  exportAudio,
  setCloneSample,
  type AudioRecord,
} from "../audioStore";
import { Panel, Button, Spinner } from "../components/ui";

type Tab = "recording" | "tts";

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDur(sec: number): string {
  if (!sec || sec < 0) return "";
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}m${Math.round(sec % 60)}s`;
}

function truncate(s: string, n = 40): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export default function AudioLibraryPanel(_props: PanelProps) {
  const [tab, setTab] = useState<Tab>("recording");
  const [items, setItems] = useState<AudioRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [dir, setDir] = useState("");
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const elRef = useRef<HTMLAudioElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listAudio();
      setItems(list);
      setDir(await getAudioDir());
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    return () => stopPlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopPlay = () => {
    if (elRef.current) {
      elRef.current.pause();
      elRef.current = null;
    }
    setPlayingId(null);
  };

  const play = async (rec: AudioRecord) => {
    if (playingId === rec.id) {
      stopPlay();
      return;
    }
    stopPlay();
    try {
      const src = await audioAssetUrl(rec);
      const el = new Audio(src);
      elRef.current = el;
      setPlayingId(rec.id);
      el.onended = () => {
        elRef.current = null;
        setPlayingId(null);
      };
      el.onerror = () => {
        elRef.current = null;
        setPlayingId(null);
        setError("播放失败（文件可能已删除）");
      };
      await el.play();
    } catch (e) {
      setPlayingId(null);
      setError(String(e));
    }
  };

  const remove = async (rec: AudioRecord) => {
    if (!window.confirm(`删除这条${rec.kind === "recording" ? "录音" : "朗读音频"}？`))
      return;
    if (playingId === rec.id) stopPlay();
    try {
      await deleteAudio(rec.id);
      setItems((l) => l.filter((x) => x.id !== rec.id));
    } catch (e) {
      setError(String(e));
    }
  };

  const exp = async (rec: AudioRecord) => {
    const base =
      (rec.text ? rec.text.trim() : "").replace(/[\\/:*?"<>|\s]/g, "-").slice(0, 20) ||
      rec.id;
    try {
      const ok = await exportAudio(rec, `${rec.kind === "recording" ? "录音" : "朗读"}-${base}`);
      if (ok) alert("✅ 已导出为 zip（含音频 + 文本）");
    } catch (e) {
      setError(String(e));
    }
  };

  const toggleClone = async (rec: AudioRecord) => {
    const next = !rec.is_clone_sample;
    try {
      await setCloneSample(rec.id, next);
      setItems((l) =>
        l.map((x) => (x.id === rec.id ? { ...x, is_clone_sample: next } : x))
      );
    } catch (e) {
      setError(String(e));
    }
  };

  const shown = items.filter((x) => x.kind === tab);

  return (
    <Panel
      title="音频库"
      subtitle="本地保存的用户录音与 TTS 朗读结果，重启后仍可打开播放"
      actions={
        <Button variant="ghost" onClick={refresh}>
          🔄 刷新
        </Button>
      }
    >
      <div className="audio-tabs">
        <button
          className={`audio-tab ${tab === "recording" ? "active" : ""}`}
          onClick={() => setTab("recording")}
        >
          🎙️ 我的录音（{items.filter((x) => x.kind === "recording").length}）
        </button>
        <button
          className={`audio-tab ${tab === "tts" ? "active" : ""}`}
          onClick={() => setTab("tts")}
        >
          🔊 朗读历史（{items.filter((x) => x.kind === "tts").length}）
        </button>
      </div>

      {dir && (
        <p className="muted audio-dir" title={dir}>
          音频库位置: {dir}
        </p>
      )}

      {error && <div className="error-box">⚠️ {error}</div>}

      {loading ? (
        <div className="empty">
          <Spinner /> 加载中…
        </div>
      ) : shown.length === 0 ? (
        <div className="empty">
          {tab === "recording"
            ? "还没有保存的录音。在「语音工作台 / 识别」里录音一次就会自动保存。"
            : "还没有朗读历史。在「朗读 / 对话」里朗读一次就会自动保存。"}
        </div>
      ) : (
        <div className="audio-list">
          {shown.map((rec) => (
            <div key={rec.id} className="audio-row">
              <div className="audio-info">
                <div className="audio-title">
                  {rec.text ? truncate(rec.text) : "（无文本）"}
                </div>
                <div className="model-meta">
                  <span>{fmtTime(rec.created_at)}</span>
                  {fmtDur(rec.duration_sec) && (
                    <span>⏱ {fmtDur(rec.duration_sec)}</span>
                  )}
                  <span className="model-cat">{rec.engine || "auto"}</span>
                </div>
              </div>
              <div className="audio-actions">
                <Button
                  variant="ghost"
                  onClick={() => play(rec)}
                  disabled={playingId !== null && playingId !== rec.id}
                >
                  {playingId === rec.id ? "⏹ 停止" : "▶️ 播放"}
                </Button>
                {rec.kind === "recording" && (
                  <Button
                    variant="ghost"
                    onClick={() => toggleClone(rec)}
                    title="把这段录音作为克隆音色的参考样本"
                  >
                    {rec.is_clone_sample ? "🎨 样本✓" : "🎨 作样本"}
                  </Button>
                )}
                <Button variant="ghost" onClick={() => exp(rec)} title="导出为 zip（含音频 + 文本）">
                  📦 导出
                </Button>
                <Button variant="danger" onClick={() => remove(rec)}>
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
