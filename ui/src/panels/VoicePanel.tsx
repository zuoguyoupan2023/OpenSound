import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelProps } from "../App";
import { Icon } from "@iconify/react";
import {
  listVoices,
  createVoice,
  renameVoice,
  deleteVoice,
  listSampleCandidates,
  previewVoiceUrl,
  audioFileTo16kWav,
  type CloneVoice,
} from "../voiceStore";
import type { AudioRecord } from "../audioStore";
import { saveRecording } from "../audioStore";
import { speakStream, transcribe } from "../api";
import { createFramePlayer, stopAudio, type FramePlayer } from "../audio";
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

// 克隆服务（8003）未就绪时给出可行动的提示，替代吓人的 "fetch failed"。
// 典型场景：刚启动 App，克隆引擎正在加载 9GB 模型 + 生成音色试听缓存（约 1–2 分钟），
// 加载完成前端口不监听，所有请求都会报"克隆服务不可用：fetch failed"。
function friendlyError(e: unknown): string {
  const msg = String(e);
  if (/克隆服务不可用|fetch failed/i.test(msg)) {
    return "克隆引擎未就绪：刚启动 App 约需 1–2 分钟自动加载（模型较大），稍后点「刷新」重试即可；若长时间未就绪，请托盘 → 重启服务。";
  }
  return msg;
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
  const [importing, setImporting] = useState(false);
  const [importedInfo, setImportedInfo] = useState<{
    file: string;
    asr: string | null;
  } | null>(null);
  const playerRef = useRef<FramePlayer | null>(null);
  const elRef = useRef<HTMLAudioElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      setVoices(await listVoices());
    } catch (e) {
      setError(friendlyError(e));
    }
    try {
      setSamples(await listSampleCandidates());
    } catch (e) {
      setError(friendlyError(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    return () => stopPlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopPlay = () => {
    playerRef.current?.stop();
    playerRef.current = null;
    elRef.current?.pause();
    elRef.current = null;
    stopAudio();
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

  // 导入音频文件：转 16k wav → 存入音频库 → ASR 识别文本填入参考提示
  const importAudio = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许重复选择同一文件
    if (!file) return;
    setError("");
    setImporting(true);
    setImportedInfo(null);
    try {
      const { blob } = await audioFileTo16kWav(file);
      const rec = await saveRecording(blob, "import", "", { source: "voice" });
      setSampleId(rec.id);
      setName("我的-" + (file.name.replace(/\.[^.]+$/, "") || "导入").slice(0, 6));
      setSamples(await listSampleCandidates());
      // 走 ASR 识别该音频文本 → 自动填入参考提示（供核对）
      try {
        const r = await transcribe(blob, "auto", true, true);
        setRefText(r.text);
        setImportedInfo({ file: file.name, asr: r.text });
      } catch {
        setImportedInfo({ file: file.name, asr: null });
        setRefText("");
      }
    } catch (err) {
      setError("导入音频失败：" + String(err));
    } finally {
      setImporting(false);
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
      setError(friendlyError(e));
      setGenProgress(null);
    }
  };

  const preview = async (v: CloneVoice) => {
    if (playingId === v.id) {
      stopPlay();
      return;
    }
    stopPlay();
    setError("");
    setPlayingId(v.id);
    // 优先：播放生成音色时预生成的试听音频（标准 WAV，秒开）
    try {
      const url = await previewVoiceUrl(v);
      if (url) {
        const el = new Audio(url);
        elRef.current = el;
        el.onended = () => {
          elRef.current = null;
          URL.revokeObjectURL(url);
          setPlayingId(null);
        };
        el.onerror = () => {
          elRef.current = null;
          URL.revokeObjectURL(url);
          setError("预览音频播放失败");
          setPlayingId(null);
        };
        await el.play();
        return;
      }
    } catch {
      /* 回退现场合成 */
    }
    // 回退：现场用该音色合成试听句（帧流播放）
    const player = createFramePlayer();
    playerRef.current = player;
    try {
      const stream = await speakStream({
        text: "你好，这是克隆音色的试听效果。",
        engine: "clone",
        voice: v.id,
      });
      await player.start(stream);
      setPlayingId(null);
    } catch (e) {
      setError(friendlyError(e));
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
        setError(friendlyError(e));
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
      setError(friendlyError(e));
    }
  };

  const selectedSample = samples.find((s) => s.id === sampleId);

  return (
    <Panel
      title="音色管理"
      subtitle="把录音样本变成可复用的克隆音色，供朗读/对话引擎选用"
      actions={
        <Button variant="ghost" onClick={refresh}>
          <Icon icon="lucide:refresh-cw" width={16} height={16} /> 刷新
        </Button>
      }
    >
      <div className="voice-banner">
        克隆音色由本地 CosyVoice3 引擎生成。新建时从音频库选一段已标记为「
        作样本」的录音，即可生成可复用的克隆音色。
      </div>

      {error && (
        <div className="error-box">
          <Icon icon="lucide:triangle-alert" width={16} height={16} /> {error}
        </div>
      )}

      <div className="voice-toolbar">
        <Button onClick={openCreate} disabled={showCreate}>
          <Icon icon="lucide:plus" width={16} height={16} /> 新建音色
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
                      还没有可用的录音。可先录一段音，或点下方「导入音频文件」。
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
                          {s.is_clone_sample ? "[样本] " : ""}
                          {s.text ? truncate(s.text, 24) : "（无文本）"} ·{" "}
                          {new Date(s.created_at).toLocaleString()}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
                <div className="import-audio-row">
                  <label className="file-btn">
                    {importing ? (
                      <Spinner />
                    ) : (
                      <>
                        <Icon icon="lucide:folder-open" width={16} height={16} />{" "}
                        导入音频文件
                      </>
                    )}
                    <input
                      type="file"
                      accept="audio/*,.wav,.mp3,.m4a,.flac,.aac"
                      hidden
                      disabled={importing}
                      onChange={importAudio}
                    />
                  </label>
                  {importedInfo && (
                    <span className="muted">
                      已导入「{importedInfo.file}」并存入音频库
                    </span>
                  )}
                </div>
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
                {importedInfo?.asr ? (
                  <div className="import-hint">
                    已用 ASR 自动识别出参考文本（见上方输入框）。请核对是否准确——
                    准确的参考文本能让克隆音色质量更高。可直接修改，或点「生成」（跳过核对，用识别结果）。
                  </div>
                ) : selectedSample?.text ? (
                  <span className="muted">（已自动带出该录音的识别文本，可修改）</span>
                ) : (
                  <span className="muted">（准确的参考文本能让克隆音色质量更高）</span>
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
          还没有克隆音色。点「新建音色」，从已标记的录音样本生成一个。
        </div>
      ) : (
        <div className="audio-list">
          {voices.map((v) => (
            <div key={v.id} className="audio-row">
              <div className="audio-info">
                <div className="audio-title">{v.name}</div>
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
                  {playingId === v.id ? (
                    <>
                      <Icon icon="lucide:square" width={16} height={16} /> 停止
                    </>
                  ) : (
                    <>
                      <Icon icon="lucide:play" width={16} height={16} /> 试听
                    </>
                  )}
                </Button>
                <Button variant="ghost" onClick={() => onRename(v)} title="改名">
                  <Icon icon="lucide:pencil" width={16} height={16} />
                </Button>
                <Button variant="danger" onClick={() => onDelete(v)}>
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
