import { useCallback, useEffect, useState } from "react";
import type { PanelProps } from "../App";
import { Icon } from "@iconify/react";
import {
  listAudio,
  deleteAudio,
  getAudioDir,
  exportAudio,
  setCloneSample,
  sourceLabel,
  sourceClass,
  type AudioRecord,
} from "../audioStore";
import { fmtTime, fmtDur, truncate, voiceDesc } from "../format";
import { useAudioPlayback } from "../useAudioPlayback";
import { Panel, Button, Spinner } from "../components/ui";

type Tab = "recording" | "tts";

export default function AudioLibraryPanel(_props: PanelProps) {
  const [tab, setTab] = useState<Tab>("recording");
  const [items, setItems] = useState<AudioRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [dir, setDir] = useState("");
  const [error, setError] = useState("");
  // 单实例播放：同一时刻只播一条（与朗读面板历史区块共用）
  const { playingId, togglePlay, stopPlay } = useAudioPlayback((m) =>
    setError(m)
  );

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

  const play = async (rec: AudioRecord) => {
    try {
      await togglePlay(rec);
    } catch (e) {
      setError(
        e instanceof Error && e.message ? e.message : "播放失败（文件可能已删除）"
      );
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
      if (ok) alert("已导出为 zip（含音频 + 文本）");
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
          <Icon icon="lucide:refresh-cw" width={16} height={16} /> 刷新
        </Button>
      }
    >
      <div className="audio-tabs">
        <button
          className={`audio-tab ${tab === "recording" ? "active" : ""}`}
          onClick={() => setTab("recording")}
        >
          <Icon icon="lucide:mic" width={16} height={16} /> 我的录音（
          {items.filter((x) => x.kind === "recording").length}）
        </button>
        <button
          className={`audio-tab ${tab === "tts" ? "active" : ""}`}
          onClick={() => setTab("tts")}
        >
          <Icon icon="lucide:volume-2" width={16} height={16} /> 朗读历史（
          {items.filter((x) => x.kind === "tts").length}）
        </button>
      </div>

      {dir && (
        <p className="muted audio-dir" title={dir}>
          音频库位置: {dir}
        </p>
      )}

      {error && (
        <div className="error-box">
          <Icon icon="lucide:triangle-alert" width={16} height={16} /> {error}
        </div>
      )}

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
                  <span
                    className={`src-badge ${sourceClass(rec)}`}
                    title={`来源：${sourceLabel(rec)}`}
                  >
                    {sourceLabel(rec)}
                  </span>
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
                  {voiceDesc(rec) && <span>{voiceDesc(rec)}</span>}
                </div>
              </div>
              <div className="audio-actions">
                <Button
                  variant="ghost"
                  onClick={() => play(rec)}
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
                {rec.kind === "recording" && (
                  <Button
                    variant="ghost"
                    onClick={() => toggleClone(rec)}
                    title="把这段录音作为克隆音色的参考样本"
                  >
                    {rec.is_clone_sample ? (
                      <>
                        <Icon icon="lucide:check" width={16} height={16} /> 样本
                      </>
                    ) : (
                      "作样本"
                    )}
                  </Button>
                )}
                <Button variant="ghost" onClick={() => exp(rec)} title="导出为 zip（含音频 + 文本）">
                  <Icon icon="lucide:package" width={16} height={16} /> 导出
                </Button>
                <Button variant="danger" onClick={() => remove(rec)}>
                  <Icon icon="lucide:trash-2" width={16} height={16} />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
