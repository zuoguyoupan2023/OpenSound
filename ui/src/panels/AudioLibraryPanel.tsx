import { useCallback, useEffect, useRef, useState } from "react";
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
import { showToast } from "../toast";
import {
  booksList,
  booksDelete,
  booksExport,
  bookSegUrl,
  bookDone,
  type BookSummary,
} from "../bookStore";
import { Panel, Button, Spinner } from "../components/ui";

type Tab = "recording" | "tts" | "books";

export default function AudioLibraryPanel(props: PanelProps) {
  const [tab, setTab] = useState<Tab>("recording");
  const [items, setItems] = useState<AudioRecord[]>([]);
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [dir, setDir] = useState("");
  const [error, setError] = useState("");
  // 单实例播放：同一时刻只播一条（与朗读面板历史区块共用）
  const { playingId, togglePlay, stopPlay } = useAudioPlayback((m) =>
    setError(m)
  );
  // 长文任务播放状态（061：并入音频库 = 长文朗读历史入口）
  const [bookBusyId, setBookBusyId] = useState<string | null>(null);
  const [bookPlayIdx, setBookPlayIdx] = useState(-1);
  const bookStopRef = useRef(false);
  const bookAudioRef = useRef<HTMLAudioElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listAudio();
      setItems(list);
      setDir(await getAudioDir());
      setError("");
      try {
        setBooks(await booksList());
      } catch (e) {
        console.error("加载长文任务失败:", e);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    return () => {
      stopPlay();
      bookStopRef.current = true;
      if (bookAudioRef.current) {
        bookAudioRef.current.pause();
        bookAudioRef.current = null;
      }
    };
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

  // ---------- 061 长文朗读任务（并入音频库 = 长文历史入口） ----------
  const playBookSeg = (id: string, idx: number): Promise<void> => {
    setBookPlayIdx(idx);
    return (async () => {
      const url = await bookSegUrl(id, idx);
      if (!url) return;
      await new Promise<void>((resolve) => {
        const a = new Audio(url);
        bookAudioRef.current = a;
        const done = () => {
          if (bookAudioRef.current === a) bookAudioRef.current = null;
          resolve();
        };
        a.onended = done;
        a.onerror = () => {
          console.error("播放长文批次失败:", idx);
          done();
        };
        a.onpause = done; // 点「停止」pause → 结束当前帧
        a.play().catch(() => done());
      });
    })();
  };

  // 播放任务中已合成的批次（0..next_idx-1；全部生成完即整本）
  const playBook = async (s: BookSummary) => {
    stopPlay();
    if (bookBusyId) return;
    setBookBusyId(s.id);
    setBookPlayIdx(-1);
    bookStopRef.current = false;
    try {
      const count = Math.min(s.next_idx, s.total_batches);
      for (let i = 0; i < count; i++) {
        if (bookStopRef.current) break;
        await playBookSeg(s.id, i);
      }
      if (bookStopRef.current) showToast("已停止播放");
    } finally {
      if (bookAudioRef.current) {
        bookAudioRef.current.pause();
        bookAudioRef.current = null;
      }
      setBookBusyId(null);
      setBookPlayIdx(-1);
    }
  };

  const stopBookPlay = () => {
    bookStopRef.current = true;
    if (bookAudioRef.current) {
      bookAudioRef.current.pause();
      bookAudioRef.current = null;
    }
  };

  const removeBook = async (s: BookSummary) => {
    if (!window.confirm(`删除长文任务「${truncate(s.title, 24)}」及其全部音频？`))
      return;
    if (bookBusyId === s.id) stopBookPlay();
    try {
      await booksDelete(s.id);
      setBooks((l) => l.filter((x) => x.id !== s.id));
    } catch (e) {
      setError(String(e));
    }
  };

  const expBook = async (s: BookSummary) => {
    try {
      const ok = await booksExport(s.id, s.title || s.id);
      if (ok) showToast("已导出 zip（批次音频 + 源文本）");
    } catch (e) {
      setError(String(e));
    }
  };

  const renderBooks = () =>
    books.length === 0 ? (
      <div className="empty">
        还没有长文任务。到「朗读面板」打开/粘贴长文 → 点「从当前文本新建任务并朗读」，之后就能在这里随时找到、播放与导出。
      </div>
    ) : (
      <div className="audio-list">
        {books.map((s) => {
          const busy = bookBusyId === s.id;
          const done = bookDone(s);
          const ready = Math.min(s.next_idx, s.total_batches);
          return (
            <div key={s.id} className="audio-row">
              <div className="audio-info">
                <div className="audio-title">
                  <span className="src-badge src-book">长文</span>
                  {done && <span className="src-badge src-ok">已生成</span>}
                  {busy && <span className="src-badge src-cut">播放中</span>}
                  {s.title ? truncate(s.title, 44) : s.id}
                </div>
                <div className="model-meta">
                  <span>{fmtTime(s.created_at)}</span>
                  <span className="model-cat">{s.engine || "auto"}</span>
                  <span>
                    {done
                      ? `全部 ${s.total_batches} 批`
                      : `已生成 ${ready}/${s.total_batches} 批`}
                    {busy && bookPlayIdx >= 0 ? ` · 第 ${bookPlayIdx + 1} 批…` : ""}
                  </span>
                  {voiceDesc({ voice: s.voice, sid: s.sid, speed: s.speed }) && (
                    <span>{voiceDesc({ voice: s.voice, sid: s.sid, speed: s.speed })}</span>
                  )}
                </div>
              </div>
              <div className="audio-actions">
                {busy ? (
                  <Button variant="danger" onClick={stopBookPlay}>
                    <Icon icon="lucide:square" width={16} height={16} /> 停止
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={() => playBook(s)}
                    disabled={!!bookBusyId || ready === 0}
                    title={ready === 0 ? "还没有已生成的批次" : "播放已生成的部分"}
                  >
                    <Icon icon="lucide:play" width={16} height={16} />{" "}
                    {done ? "播放" : `播放已生成(${ready})`}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  onClick={() => props.goPanel?.("read")}
                  disabled={!!bookBusyId}
                  title="去朗读面板新建 / 继续生成"
                >
                  <Icon icon="lucide:book-open" width={16} height={16} /> 朗读面板
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => expBook(s)}
                  disabled={!!bookBusyId || ready === 0}
                  title="导出 zip（批次音频 + 源文本）"
                >
                  <Icon icon="lucide:package" width={16} height={16} /> 导出
                </Button>
                <Button variant="danger" onClick={() => removeBook(s)} disabled={!!bookBusyId}>
                  <Icon icon="lucide:trash-2" width={16} height={16} />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    );

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
        <button
          className={`audio-tab ${tab === "books" ? "active" : ""}`}
          onClick={() => setTab("books")}
        >
          <Icon icon="lucide:book" width={16} height={16} /> 长文朗读（
          {books.length}）
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
      ) : tab === "books" ? (
        renderBooks()
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
