import { useRef, useState, useEffect } from "react";
import type { PanelProps } from "../App";
import { Icon } from "@iconify/react";
import { speakStream, computeStarting, getPersistedSettings, switchEcoEngine, engineDisabledInEco, cloudTtsConfigured, AZURE_TTS_VOICES, TTS_PANEL_TO_ID, TTS_ID_TO_PANEL, type EcoTts } from "../api";
import { createFramePlayer, type FramePlayer, stopAudio, setAudioPlayErrorHandler } from "../audio";
import {
  teeCollect,
  mergeWavFrames,
  saveTts,
  listAudio,
  deleteAudio,
  blobToBase64,
  wavBlobDuration,
  type AudioRecord,
} from "../audioStore";
import { fmtTime, fmtDur, truncate } from "../format";
import { useAudioPlayback } from "../useAudioPlayback";
import { showToast } from "../toast";
import { splitTextBatches, textFingerprint, countTextStats, textCountLabel } from "../textSplit";
import {
  booksList,
  booksGet,
  booksCreate,
  booksSaveSegment,
  booksSynthSystemSegment,
  booksSetNext,
  booksDelete,
  booksExport,
  bookSegUrl,
  bookDone,
  type BookSummary,
} from "../bookStore";
import { listVoices, type CloneVoice } from "../voiceStore";
import { Panel, Button, Select, Spinner, EngineBadge } from "../components/ui";
import {
  listSystemVoices,
  speakSystem,
  stopSystem,
  previewSystemVoice,
  previewSampleText,
  isSpeakingSystem,
  ttsErrorMessage,
  type Voice as SystemVoice,
} from "../systemTts";
import { langLabel } from "../langNames";

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

// 060 P1：每批上限字数（本地持久化，默认 1000，可选 200–5000）
const BATCH_CHARS_OPTIONS = [200, 500, 1000, 2000, 5000];
const LS_READ_PREFS = "os_read_prefs";
const DEFAULT_BATCH_CHARS = 1000;
function loadReadBatchChars(): number {
  try {
    const raw = localStorage.getItem(LS_READ_PREFS);
    const v = raw ? Number(JSON.parse(raw)?.batchChars) : NaN;
    if (Number.isFinite(v) && BATCH_CHARS_OPTIONS.includes(v)) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_BATCH_CHARS;
}
function saveReadBatchChars(v: number) {
  try {
    localStorage.setItem(LS_READ_PREFS, JSON.stringify({ batchChars: v }));
  } catch {
    /* ignore */
  }
}

export default function ReadPanel(props: PanelProps) {
  const [text, setText] = useState("");
  const [engine, setEngine] = useState<"kokoro" | "qwen3" | "clone" | "system" | "azure" | "cloud">("kokoro");
  const [azureVoice, setAzureVoice] = useState<string>("zh-CN-XiaoxiaoNeural");
  const [cloudVoice, setCloudVoice] = useState<string>("alloy");
  // 000-plan-6 阶段1：系统朗读（系统音色）
  const [sysVoices, setSysVoices] = useState<SystemVoice[]>([]);
  const [sysLang, setSysLang] = useState<string>("zh");
  const [sysVoiceId, setSysVoiceId] = useState<string>("");
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
  // 060 P1：每批上限字数（默认 1000，200–5000）；多批进度（含已计量单位）；断点续读偏移（仅同文本有效）
  const [batchChars, setBatchChars] = useState<number>(loadReadBatchChars());
  const [batchInfo, setBatchInfo] = useState<{
    done: number;
    total: number;
    doneUnits: number;
    totalUnits: number;
  } | null>(null);
  const [resumeAt, setResumeAt] = useState<{ offset: number; fp: string } | null>(null);
  const playerRef = useRef<FramePlayer | null>(null);
  // 朗读中断控制：停止时 abort 底层流，服务端不再继续合成
  const speakAbortRef = useRef<AbortController | null>(null);
  const speakStoppedRef = useRef(false);
  // 060 P2：长文朗读任务（books/）状态
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [bookBusyId, setBookBusyId] = useState<string | null>(null); // 正在生成/播放的任务 id
  const [bookCreating, setBookCreating] = useState(false);
  const [bookPlayIdx, setBookPlayIdx] = useState(-1); // 正在处理/播放的批下标（展示用）
  const bookStopRef = useRef(false);
  const bookAbortRef = useRef<AbortController | null>(null);
  const bookPlayerRef = useRef<FramePlayer | null>(null);
  const bookAudioRef = useRef<HTMLAudioElement | null>(null);
  // 历史条目播放（与音频库同款单实例逻辑）
  const { playingId, togglePlay, stopPlay } = useAudioPlayback((m) =>
    setError(m)
  );

  const kokoroReady = props.health?.tts.kokoro === "ready";
  const qwen3Ready = props.health?.tts.qwen3 === "reachable";
  const cloneReady = props.health?.tts.cosyvoice === "reachable";

  // 000-plan-3：节能 = TTS 类同时仅启用 1 个模型。当前引擎非启用项 → 选项标「点选切换」；
  // 点选任何非启用引擎 = 确认后切换类别启用并重启服务（关旧启新）；eco 未配置时提示去模型页资源表。
  const ecoSettings = getPersistedSettings();
  const ecoActiveTts = ecoSettings.powerMode === "eco" ? (ecoSettings.ecoTts as EcoTts) : null;
  const ttsOffLabel = (v: "kokoro" | "qwen3" | "clone") =>
    ecoActiveTts && engineDisabledInEco("tts", TTS_PANEL_TO_ID[v], ecoSettings)
      ? "（点选切换并启用）"
      : "";
  const pickEngine: (v: string) => Promise<void> = async (v) => {
    // 系统朗读（原生引擎）与云端引擎（不占本地模型资源）不受节能模式约束
    if (v === "system" || v === "azure" || v === "cloud") {
      setEngine(v as typeof engine);
      return;
    }
    const id = TTS_PANEL_TO_ID[v];
    if (ecoSettings.powerMode === "eco" && ecoActiveTts && ecoActiveTts !== id) {
      const name = v === "clone" ? "CosyVoice 克隆" : v === "qwen3" ? "Qwen3 TTS" : "Kokoro";
      if (
        !window.confirm(
          `节能模式未启用「${name}」。切换将把朗读类别改为「${name}」（关闭同类别当前引擎并重启服务，冷启动需等待），继续？`
        )
      )
        return;
      try {
        await switchEcoEngine("tts", id);
        showToast(`已切换启用「${name}」，服务重启中…`);
        props.refresh();
        setTimeout(() => props.refresh(), 1500);
      } catch (e) {
        showToast("切换失败: " + e);
        return;
      }
    } else if (ecoSettings.powerMode === "eco" && !ecoSettings.ecoTts) {
      showToast("节能模式朗读类别尚未配置——请到「模型管理」顶部资源表选择启用引擎");
      return;
    }
    setEngine(v as typeof engine);
  };

  // 000-plan-3：节能下当前朗读引擎不在启用集（如切到节能前停在 qwen3）→ 自动回落启用引擎
  const ecoActivePanel = ecoActiveTts ? (TTS_ID_TO_PANEL[ecoActiveTts] as typeof engine) : null;
  useEffect(() => {
    if (!ecoActivePanel) return;
    if (engine === "system" || engine === "azure" || engine === "cloud") return; // 系统/云端引擎不参与节能
    if (engine !== ecoActivePanel) setEngine(ecoActivePanel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ecoActiveTts, props.models]);

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
    // 播放失败（如 WebView 自动播放拦截）不再静默：直接显示在面板上
    setAudioPlayErrorHandler((msg) => setError(msg));
    return () => {
      stopPlay();
      setAudioPlayErrorHandler(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 进入「系统朗读」时枚举系统音色（默认选中第一个中文音色）
  useEffect(() => {
    if (engine !== "system" || sysVoices.length) return;
    listSystemVoices()
      .then((vs) => {
        setSysVoices(vs);
        const zh = vs.find((v) => v.language?.toLowerCase().startsWith("zh"));
        if (zh) setSysVoiceId(zh.id);
      })
      .catch((e) => setError("获取系统音色失败: " + ttsErrorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, sysVoices.length]);

  // 060 P2：载入长文任务列表；离开面板时兜底停止书朗读/生成
  useEffect(() => {
    booksList()
      .then(setBooks)
      .catch((e) => console.error("载入长文任务失败:", e));
    return () => {
      bookStopRef.current = true;
      bookAbortRef.current?.abort();
      bookAbortRef.current = null;
      if (bookAudioRef.current) {
        bookAudioRef.current.pause();
        bookAudioRef.current = null;
      }
    };
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
    setState("speaking");
    speakStoppedRef.current = false;
    // 060 Stage 2.5：系统朗读长文模式 —— 走系统原生 TTS（不入音频库：OS 只出声、拿不到音频字节），
    // 按批字数逐块顺序朗读：一次只 speakSystem 一块、轮询读完再下一块 → 文本级批进度 + 停止后续读
    if (engine === "system") {
      const batches = splitTextBatches(text, batchChars);
      if (!batches.length) {
        setState("idle");
        return;
      }
      const fp = textFingerprint(text);
      let startIdx = 0;
      if (resumeAt && resumeAt.fp === fp && resumeAt.offset > 0) {
        const idx = batches.findIndex((b) => b.end > resumeAt!.offset);
        if (idx >= 0) startIdx = idx;
      }
      const total = batches.length;
      const batchUnits = batches.map((b) => countTextStats(b.text).total);
      const pref: number[] = [0];
      for (const c of batchUnits) pref.push(pref[pref.length - 1] + c);
      const totalUnits = pref[total] || 1;
      if (startIdx > 0) {
        showToast(`检测到断点：从第 ${startIdx + 1} / ${total} 批继续（想从头读请先点「从头开始」）`);
      }
      console.info(
        `[朗读-系统] 共 ${total} 批 · 从批 ${startIdx + 1} 开始 · 文本 ${pref[total]} 计量单位`,
        `批字数=${batchChars}`
      );
      let interruptedBatchStart = -1;
      try {
        for (let bi = startIdx; bi < total; bi++) {
          if (speakStoppedRef.current) break;
          interruptedBatchStart = batches[bi].start;
          if (total > 1)
            setBatchInfo({ done: bi, total, doneUnits: pref[bi], totalUnits });
          await speakSystem(batches[bi].text, sysVoiceId || null, speed);
          // speak() 开始即 resolve，轮询直到这一块说完（或被停止）
          while (!speakStoppedRef.current && (await isSpeakingSystem())) {
            await new Promise((r) => setTimeout(r, 300));
          }
          if (speakStoppedRef.current) break;
          if (total > 1)
            setBatchInfo({ done: bi + 1, total, doneUnits: pref[bi + 1], totalUnits });
        }
      } catch (e) {
        if (!speakStoppedRef.current) setError(ttsErrorMessage(e));
      }
      const interrupted = speakStoppedRef.current;
      if (interrupted && interruptedBatchStart >= 0) {
        setResumeAt({ offset: interruptedBatchStart, fp });
      } else if (!interrupted) {
        setResumeAt(null);
      }
      if (total > 1) setBatchInfo(null);
      setState(interrupted ? "idle" : "done");
      return;
    }
    stopAudio();
    const player = createFramePlayer((i) => console.log("播放第", i + 1, "句"));
    playerRef.current = player;
    // 060 P1：文本按句边界切成 ≤ effChars 的批次逐批朗读（qwen3 单请求上限 2000 字，自动再压低）
    const effChars = engine === "qwen3" ? Math.min(batchChars, 2000) : batchChars;
    const batches = splitTextBatches(text, effChars);
    if (!batches.length) {
      setState("idle");
      return;
    }
    const fp = textFingerprint(text);
    // 断点续读：文本未变且上次中断过 → 从中断批次的开头继续（该批前半截已入「已截断」记录）
    let startIdx = 0;
    if (resumeAt && resumeAt.fp === fp && resumeAt.offset > 0) {
      const idx = batches.findIndex((b) => b.end > resumeAt!.offset);
      if (idx >= 0) startIdx = idx;
    }
    const total = batches.length;
    // 060：进度按"计量单位"算（中文按字、英文按词），每批预先统计便于累计
    const batchUnits = batches.map((b) => countTextStats(b.text).total);
    const pref: number[] = [0];
    for (const c of batchUnits) pref.push(pref[pref.length - 1] + c);
    const totalUnits = pref[total] || 1;
    if (startIdx > 0) {
      showToast(`检测到断点：从第 ${startIdx + 1} / ${total} 批继续（想从头读请先点「从头开始」）`);
    }
    console.info(
      `[朗读-${engine}] 共 ${total} 批 · 从批 ${startIdx + 1} 开始 · 文本 ${pref[total]} 计量单位（中文${countTextStats(text).cjk} 字 / 英文 ${countTextStats(text).words} 词）`,
      `批字数=${batchChars}`
    );
    const meta = {
      source: "read" as const,
      voice:
        engine === "clone"
          ? cloneVoiceId
          : engine === "qwen3"
          ? voice
          : engine === "azure"
          ? azureVoice
          : engine === "cloud"
          ? cloudVoice
          : undefined,
      sid: engine === "kokoro" ? sid : undefined,
      speed: engine === "kokoro" ? speed : undefined,
      language: engine === "qwen3" ? language : undefined,
    };
    const speakVoice = () =>
      engine === "clone"
        ? cloneVoiceId
        : engine === "azure"
        ? azureVoice
        : engine === "cloud"
        ? cloudVoice
        : voice;

    // 逐批：每批一个 /speak 流 → 顺序播放 → 收集帧；帧全部攒到 frameArrays，读完统一合并落盘
    const frameArrays: Uint8Array[] = [];
    let interruptedBatchStart = -1; // 中断时正在读的批次起点（原文偏移），供断点续读
    let pendingCp: Promise<Uint8Array[]> | null = null;
    let fatal: unknown = null;
    try {
      for (let bi = startIdx; bi < total; bi++) {
        if (speakStoppedRef.current) break;
        interruptedBatchStart = batches[bi].start;
        if (total > 1)
          setBatchInfo({ done: bi, total, doneUnits: pref[bi], totalUnits });
        const batchAc = new AbortController();
        speakAbortRef.current = batchAc;
        try {
          const stream = await speakStream(
            {
              text: batches[bi].text,
              engine,
              sid,
              speed,
              voice: speakVoice(),
              language,
            },
            batchAc.signal
          );
          const { playStream, collected } = teeCollect(stream);
          pendingCp = collected
            .then((frames) => {
              if (frames.length) frameArrays.push(...frames);
              return frames;
            })
            .catch(() => [] as Uint8Array[]);
          await player.start(playStream); // 中断时 abort → 此处抛错，帧收集 promise 走 catch 保留已收部分
          await pendingCp;
          pendingCp = null;
        } finally {
          if (speakAbortRef.current === batchAc) speakAbortRef.current = null;
        }
        if (speakStoppedRef.current) break;
        if (total > 1)
          setBatchInfo({ done: bi + 1, total, doneUnits: pref[bi + 1], totalUnits });
      }
    } catch (e) {
      // 主动停止不算错误；其它错误记录并继续走收尾（已收帧仍保存）
      if (!speakStoppedRef.current) fatal = e;
    }
    // 收尾：等最后一批（可能被中断）的帧收集完成，避免漏掉已到达的部分帧
    if (pendingCp) {
      try {
        await pendingCp;
      } catch {
        /* ignore */
      }
      pendingCp = null;
    }
    const interrupted = speakStoppedRef.current;
    if (interrupted && interruptedBatchStart >= 0) {
      setResumeAt({ offset: interruptedBatchStart, fp });
    } else if (!interrupted) {
      setResumeAt(null);
    }
    if (total > 1) setBatchInfo(null);
    setState(interrupted ? "idle" : fatal ? "idle" : "done");
    if (fatal) setError(String(fatal));
    if (frameArrays.length) {
      // 续读从批次 startIdx 开始 → 记录文本只存实际读到的后半段，与音频开头对齐
      const recText = startIdx > 0 ? text.slice(batches[startIdx].start) : text;
      const rec = await saveTts(mergeWavFrames(frameArrays), engine, recText, {
        ...meta,
        interrupted: interrupted || undefined,
      }).catch((e) => {
        console.error("保存朗读失败:", e);
        return null;
      });
      if (rec) {
        setHistory((h) => [rec, ...h].slice(0, 20));
        showToast(
          interrupted || fatal
            ? "已保存已生成部分（已截断）"
            : "已存入朗读历史"
        );
      }
    }
  };

  const stop = () => {
    // 先标记停止，再中断流、停播放器；已生成的句子会以「已截断」入库
    speakStoppedRef.current = true;
    if (engine === "system") {
      stopSystem().catch((e) => console.error("停止系统朗读失败:", e));
      setState("idle");
      return;
    }
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

  // ===== 060 P2：长文朗读任务（books/） =====
  const refreshBooks = async () => {
    try {
      setBooks(await booksList());
    } catch (e) {
      console.error("刷新长文任务失败:", e);
    }
  };

  // 与 speak() 一致：按当前引擎给出朗读参数（快照进任务，续读时按它生成）
  const pickBookVoice = () =>
    engine === "clone"
      ? cloneVoiceId
      : engine === "azure"
      ? azureVoice
      : engine === "cloud"
      ? cloudVoice
      : voice;

  // 从当前文本 + 当前引擎/音色参数新建任务并自动开始生成
  const createBookTask = async () => {
    if (!text.trim()) {
      setError("请先粘贴文本或打开文件，再创建长文任务");
      return;
    }
    if (engine === "system" && !sysVoiceId) {
      setError("请先在引擎区选择一个系统音色（如中文音色），再创建长文任务");
      return;
    }
    setError("");
    setBookCreating(true);
    try {
      const effChars = engine === "qwen3" ? Math.min(batchChars, 2000) : batchChars;
      const batches = splitTextBatches(text, effChars);
      if (!batches.length) {
        setError("文本为空，无法创建任务");
        return;
      }
      const title = fileName || text.replace(/\s+/g, " ").slice(0, 24).trim() || "长文任务";
      const sum = await booksCreate({
        title,
        sourceName: fileName,
        text,
        engine,
        voice: engine === "system" ? sysVoiceId : pickBookVoice(),
        sid: engine === "kokoro" ? sid : undefined,
        speed: engine === "kokoro" || engine === "system" ? speed : 1,
        language,
        batchChars: effChars,
        batches: batches.map((b) => ({ start: b.start, end: b.end })),
      });
      await refreshBooks();
      showToast(`已创建长文任务（${batches.length} 批），开始自动朗读…`);
      void generateBook(sum.id);
    } catch (e) {
      setError("创建长文任务失败: " + String(e));
    } finally {
      setBookCreating(false);
    }
  };

  // 按任务记录的参数组 /speak 参数（续读也用同一份快照）
  const bookSpeakParams = (s: BookSummary, chunk: string) => ({
    text: chunk,
    engine: s.engine as "kokoro" | "qwen3" | "clone" | "azure" | "cloud",
    sid: s.engine === "kokoro" ? s.sid : undefined,
    speed: s.engine === "kokoro" ? s.speed : undefined,
    voice: s.engine === "kokoro" ? undefined : s.voice || undefined,
    language: s.language || undefined,
  });

  // 逐批合成未完成的批次：合成一帧帧播放 → 整批完成后存 seg_xxxxx.wav 并前移进度
  const generateBook = async (id: string) => {
    if (bookBusyId) return;
    setBookBusyId(id);
    setBookPlayIdx(-1);
    bookStopRef.current = false;
    const player = createFramePlayer();
    bookPlayerRef.current = player;
    try {
      const d = await booksGet(id);
      const total = d.batches.length;
      let idx = Math.max(0, Math.min(d.summary.next_idx, total));
      while (idx < total && !bookStopRef.current) {
        const b = d.batches[idx];
        const chunk = d.text.slice(b.start, b.end);
        if (!chunk.trim()) {
          // 空白批没有可朗读内容：跳过并把进度同步推进（避免任务永远"未完成"）
          idx++;
          try {
            await booksSetNext(id, idx);
          } catch {
            /* ignore */
          }
          continue;
        }
        setBookPlayIdx(idx);
        if (d.summary.engine === "system") {
          // 系统音色长文任务（Stage 2.6）：Rust 侧 say+afconvert 合成并直接落盘该批
          const ac = new AbortController();
          bookAbortRef.current = ac;
          try {
            await booksSynthSystemSegment(
              id,
              idx,
              chunk,
              d.summary.voice,
              d.summary.speed
            );
          } finally {
            if (bookAbortRef.current === ac) bookAbortRef.current = null;
          }
          if (bookStopRef.current) break;
          // 播放刚合成的这一批，保持"边生成边听"的节奏
          await playBookSegById(id, idx);
          if (bookStopRef.current) break;
          idx++;
          setBookPlayIdx(-1);
          if (!bookStopRef.current) void refreshBooks();
          continue;
        }
        const ac = new AbortController();
        bookAbortRef.current = ac;
        let frames: Uint8Array[] = [];
        try {
          const stream = await speakStream(bookSpeakParams(d.summary, chunk), ac.signal);
          const { playStream, collected } = teeCollect(stream);
          const cp = collected.catch(() => [] as Uint8Array[]);
          await player.start(playStream);
          if (bookStopRef.current) break;
          frames = await cp;
        } finally {
          if (bookAbortRef.current === ac) bookAbortRef.current = null;
        }
        if (bookStopRef.current) break;
        if (!frames.length) throw new Error("该批未生成音频（引擎不可用？）");
        // 只保存整批完成的音频；中断的半截不落盘 → 续读时整批重读
        const wav = mergeWavFrames(frames);
        const dur = await wavBlobDuration(wav);
        await booksSaveSegment(id, idx, await blobToBase64(wav), dur);
        idx++;
        setBookPlayIdx(-1);
        if (!bookStopRef.current) void refreshBooks();
      }
      if (bookStopRef.current) {
        showToast("已暂停 —— 已完成批次已分文件保存，可稍后「继续生成」");
      } else {
        showToast("长文任务已全部生成完成，可从头播放");
      }
    } catch (e) {
      if (!bookStopRef.current) setError("长文朗读失败: " + String(e));
    } finally {
      player.stop();
      bookPlayerRef.current = null;
      bookAbortRef.current = null;
      setBookBusyId(null);
      setBookPlayIdx(-1);
      void refreshBooks();
    }
  };

  // 播放任务的单个批次文件（asset URL），供从头播放与系统任务边生成边听复用
  const playBookSegById = (id: string, idx: number): Promise<void> => {
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

  // 从头播放已全部合成的任务（纯文件播放，不重新合成）
  const playBook = async (sum: BookSummary) => {
    if (bookBusyId) return;
    setBookBusyId(sum.id);
    setBookPlayIdx(-1);
    bookStopRef.current = false;
    try {
      for (let i = 0; i < sum.total_batches; i++) {
        if (bookStopRef.current) break;
        await playBookSegById(sum.id, i);
      }
      if (!bookStopRef.current) showToast("播放结束");
    } finally {
      if (bookAudioRef.current) {
        bookAudioRef.current.pause();
        bookAudioRef.current = null;
      }
      setBookBusyId(null);
      setBookPlayIdx(-1);
    }
  };

  const stopBook = () => {
    bookStopRef.current = true;
    bookAbortRef.current?.abort();
    bookAbortRef.current = null;
    bookPlayerRef.current?.stop();
    bookPlayerRef.current = null;
    if (bookAudioRef.current) {
      bookAudioRef.current.pause();
      bookAudioRef.current = null;
    }
  };

  const removeBook = async (s: BookSummary) => {
    if (!window.confirm(`删除长文任务「${truncate(s.title, 24)}」及其全部音频？`)) return;
    if (bookBusyId === s.id) stopBook();
    try {
      await booksDelete(s.id);
      await refreshBooks();
    } catch (e) {
      setError("删除长文任务失败: " + String(e));
    }
  };

  const exportBook = async (s: BookSummary) => {
    try {
      const ok = await booksExport(s.id, s.title || s.id);
      if (ok) showToast("已导出 zip（批次音频 + 源文本）");
    } catch (e) {
      setError("导出长文任务失败: " + String(e));
    }
  };

  // 060 P1/P2.5：断点提示（仅当文本未变时展示；系统朗读同样支持续读）
  const effCharsNow =
    engine === "qwen3" ? Math.min(batchChars, 2000) : batchChars;
  const resumeVisible =
    state === "idle" &&
    !!resumeAt &&
    resumeAt.fp === textFingerprint(text);
  const resumeBatchNo = (() => {
    if (!resumeVisible || !resumeAt) return -1;
    const bs = splitTextBatches(text, effCharsNow);
    return bs.findIndex((b) => b.end > resumeAt.offset);
  })();

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
          onChange={pickEngine}
          options={[
            { value: "kokoro", label: `Kokoro（本地，53 音色）${ttsOffLabel("kokoro")}` },
            {
              value: "qwen3",
              label: `Qwen3（低延迟）${ttsOffLabel("qwen3")}`,
            },
            {
              value: "clone",
              label: `克隆音色（CosyVoice）${ttsOffLabel("clone")}`,
            },
            { value: "system", label: "系统朗读（系统音色 · 离线秒开）" },
            { value: "azure", label: "Azure TTS（云 · 出网）" },
            { value: "cloud", label: "OpenAI 兼容（云 · 出网）" },
          ]}
        />
        {(engine === "azure" || engine === "cloud") && (
          <Select
            value={engine === "azure" ? azureVoice : cloudVoice}
            onChange={engine === "azure" ? setAzureVoice : setCloudVoice}
            options={
              engine === "azure"
                ? AZURE_TTS_VOICES.map((v) => ({ value: v.value, label: v.label }))
                : ["alloy", "echo", "fable", "onyx", "nova", "shimmer"].map((v) => ({
                    value: v,
                    label: v,
                  }))
            }
          />
        )}
        {(engine === "azure" || engine === "cloud") && (
          <span className="hint">
            {engine === "azure"
              ? cloudTtsConfigured("azure")
                ? "音频将出网到 Azure 语音服务（Key/Region 在 设置 → 云端能力 配置）。"
                : "⚠️ 未配置 Azure Key/Region —— 请到 设置 → 云端能力 填写。"
              : cloudTtsConfigured("cloud")
              ? "音频将出网到你配置的 OpenAI 兼容端点（Base URL/Key 在 设置 → 云端能力）。"
              : "⚠️ 未配置 Base URL/API Key —— 请到 设置 → 云端能力 填写。"}
          </span>
        )}
        {engine === "system" && (() => {
          const isMac = /Mac/i.test(navigator.userAgent);
          const isWin = /Win/i.test(navigator.userAgent);
          // 按语言主子标签分组（zh / yue / en / ja…），组名取 langNames 中文名
          const groups = new Map<string, number>();
          for (const v of sysVoices) {
            const g = v.language?.split("-")[0].toLowerCase() || "other";
            groups.set(g, (groups.get(g) || 0) + 1);
          }
          const groupOrder = (a: string, b: string) => {
            const pri = ["zh", "cmn", "yue", "en", "es", "fr", "ru", "ar", "ja", "ko"];
            const pa = pri.indexOf(a), pb = pri.indexOf(b);
            if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
            return a.localeCompare(b);
          };
          const sysLangOptions = [
            ...[...groups.keys()].sort(groupOrder).map((g) => ({
              value: g,
              label: `${langLabel(g)}（${groups.get(g)} 个）`,
            })),
            { value: "all", label: `全部音色（${sysVoices.length} 个）` },
          ];
          const filtered = sysVoices.filter(
            (v) =>
              sysLang === "all" ||
              v.language?.split("-")[0].toLowerCase() === sysLang
          );
          return (
            <>
              <Select
                value={sysLang}
                onChange={setSysLang}
                options={sysLangOptions}
              />
              <Select
                value={sysVoiceId}
                onChange={setSysVoiceId}
                options={
                  filtered.length
                    ? filtered.map((v) => ({
                        value: v.id,
                        label: `${v.name}（${v.language}）`,
                      }))
                    : [{ value: "", label: "（未枚举到系统音色）" }]
                }
              />
              <Button
                variant="ghost"
                disabled={!sysVoiceId || state === "speaking"}
                onClick={() => {
                  const v = sysVoices.find((x) => x.id === sysVoiceId);
                  previewSystemVoice(sysVoiceId, previewSampleText(v?.language)).catch(
                    (e) => setError(ttsErrorMessage(e))
                  );
                }}
              >
                <Icon icon="lucide:ear" width={14} height={14} /> 试听
              </Button>
              <span className="hint">
                {isMac
                  ? "紧凑版音色不完整：到 系统设置 → 辅助功能 → 阅读与朗读 → 系统声音，点最右侧 ⓘ 免费下载更多/增强版音色（下载后回到本面板即可看到）。"
                  : isWin
                  ? "到 设置 → 时间和语言 → 语音 → 管理语音 / 添加语音，可添加更多语言语音包（下载后重新打开本面板可见）。"
                  : "使用系统自带朗读引擎与音色。"}
              </span>
            </>
          );
        })()}
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
            {/* 030：选音色旁直达「音色管理」，管理克隆音色与克隆引擎 */}
            <Button variant="ghost" onClick={() => props.goPanel?.("voices")}>
              <Icon icon="lucide:mic-vocal" width={14} height={14} /> 克隆音色
            </Button>
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
        <div className="read-count">
          {text.trim() ? `正文：${textCountLabel(countTextStats(text))}` : ""}
        </div>
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
          <Button
            onClick={speak}
            disabled={state === "speaking" || !!bookBusyId}
          >
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

      {/* 060 P1/P2.5：每批上限字数设置 + 多批进度 + 断点续读提示（系统朗读也走逐块长文模式） */}
      <div className="toolbar">
        <label className="inline-field">
          每批 ≤
          <Select
            value={String(batchChars)}
            onChange={(v) => {
              const n = Number(v);
              setBatchChars(n);
              saveReadBatchChars(n);
            }}
            options={BATCH_CHARS_OPTIONS.map((o) => ({
              value: String(o),
              label: String(o),
            }))}
            disabled={state === "speaking" || !!bookBusyId}
          />
          字
        </label>
        {state === "speaking" && batchInfo && (
          <span className="hint">
            正在朗读第 {batchInfo.done + 1} / {batchInfo.total} 批
            {batchInfo.totalUnits > 0 &&
              ` · 已读约 ${Math.min(100, Math.floor((batchInfo.doneUnits / batchInfo.totalUnits) * 100))}%（${batchInfo.doneUnits}/${batchInfo.totalUnits} 字词）`}
            （每批 ≤ {effCharsNow} 字）…
          </span>
        )}
        {resumeVisible && resumeBatchNo >= 0 && (
          <span className="hint">
            上次读到第 {resumeBatchNo + 1} 批时中断——点「朗读」将从该批继续
            <Button
              variant="ghost"
              className="batch-resume-reset"
              onClick={() => setResumeAt(null)}
            >
              从头开始
            </Button>
          </span>
        )}
      </div>

      <div className="engine-status">
        <EngineBadge label="系统朗读" ready />
        <EngineBadge label="Azure 云" ready={cloudTtsConfigured("azure")} />
        <EngineBadge label="OpenAI 兼容云" ready={cloudTtsConfigured("cloud")} />
        <EngineBadge
          label="Kokoro"
          ready={kokoroReady}
          starting={computeStarting(getPersistedSettings(), props.health).kokoro}
        />
        <EngineBadge
          label="Qwen3"
          ready={qwen3Ready}
          starting={computeStarting(getPersistedSettings(), props.health).qwen3}
          availableOff={!qwen3Ready && computeStarting(getPersistedSettings(), props.health).ecoDisabled("qwen3")}
        />
        <EngineBadge
          label="克隆音色"
          ready={cloneReady}
          starting={computeStarting(getPersistedSettings(), props.health).cosyvoice}
          availableOff={!cloneReady && computeStarting(getPersistedSettings(), props.health).ecoDisabled("cosyvoice")}
        />
      </div>

      {/* 060 P2：长文朗读任务（分文件保存 · 可续读） */}
      <div className="read-history">
        <div className="read-history-head">
          <span className="install-head">📖 长文朗读任务（每批一个文件 · 可暂停续读）</span>
        </div>
        <div className="read-tools book-tools">
          <Button
            onClick={createBookTask}
            disabled={
              bookCreating ||
              !!bookBusyId ||
              state === "speaking" ||
              !text.trim()
            }
          >
            {bookCreating ? (
              <Spinner />
            ) : (
              <Icon icon="lucide:book-plus" width={16} height={16} />
            )}
            从当前文本新建任务并朗读
          </Button>
          <span className="hint">
            长文按每批 ≤{batchChars} 字拆批、整批完成才存一个 WAV；可随时暂停，「继续生成」从断点续，完整生成后可「从头播放」。系统音色（macOS）也已支持合成落盘。
          </span>
        </div>
        {books.length === 0 ? (
          <div className="empty">
            还没有长文任务。粘贴长文本或打开 .txt/.md 文件后点上方按钮即可创建。
          </div>
        ) : (
          <div className="audio-list">
            {books.map((s) => {
              const busy = bookBusyId === s.id;
              const done = bookDone(s);
              return (
                <div key={s.id} className="audio-row">
                  <div className="audio-info">
                    <div className="audio-title">
                      <span className="src-badge src-book">长文</span>
                      {done && <span className="src-badge src-ok">已生成</span>}
                      {busy && <span className="src-badge src-cut">处理中</span>}
                      {s.title ? truncate(s.title, 44) : s.id}
                    </div>
                    <div className="model-meta">
                      <span>{fmtTime(s.created_at)}</span>
                      <span className="model-cat">{s.engine || "auto"}</span>
                      <span>
                        {done
                          ? `全部 ${s.total_batches} 批`
                          : `已到 ${s.next_idx}/${s.total_batches} 批`}
                        {busy && bookPlayIdx >= 0
                          ? ` · 正在处理第 ${bookPlayIdx + 1} 批…`
                          : ""}
                      </span>
                    </div>
                  </div>
                  <div className="audio-actions">
                    {busy ? (
                      <Button variant="danger" onClick={stopBook}>
                        <Icon icon="lucide:square" width={16} height={16} /> 停止
                      </Button>
                    ) : done ? (
                      <Button
                        variant="ghost"
                        onClick={() => playBook(s)}
                        disabled={!!bookBusyId || state === "speaking"}
                      >
                        <Icon icon="lucide:play" width={16} height={16} /> 从头播放
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        onClick={() => generateBook(s.id)}
                        disabled={!!bookBusyId || state === "speaking"}
                      >
                        <Icon icon="lucide:play" width={16} height={16} /> 继续生成
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      onClick={() => exportBook(s)}
                      disabled={!!bookBusyId}
                      title="导出 zip（批次音频 + 源文本）"
                    >
                      <Icon icon="lucide:download" width={16} height={16} />
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => removeBook(s)}
                      disabled={!!bookBusyId}
                    >
                      <Icon icon="lucide:trash-2" width={16} height={16} />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
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
                    disabled={
                      (playingId !== null && playingId !== rec.id) || !!bookBusyId
                    }
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
