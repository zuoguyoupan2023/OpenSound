// ---------- Realtime 实时语音（独立模块，与录音/播放隔离） ----------
// 职责：接管 Rust cpal 实时采集 → 周期拉增量 16k PCM → 用 asr-server /vad 检测语音段 →
//      按"句间停顿 ≥ gapMs"自动切句 → 每句单独送 /transcribe 识别 → 回调给 UI。
// 不触碰 audio.ts 的录音/播放逻辑，也不与 AsrPanel 的开关混在一起。
import { invoke } from "@tauri-apps/api/core";
import { getBaseUrl, getToken } from "./api";
import { pcmToWavBlob } from "./audio";

export interface RealtimeCallbacks {
  /** 追加一句识别结果 */
  onSegment: (text: string, index: number) => void;
  /** 当前"正在聆听"状态或电平变化（可选） */
  onListening?: (state: { listening: boolean; level: number }) => void;
  /** 出错 */
  onError?: (msg: string) => void;
}

const SR = 16000;
const READ_INTERVAL_MS = 250; // 拉取增量的周期
const VAD_CHECK_MIN_MS = 900; // 距上次 VAD 检查至少累积这么久才再查
const SENTENCE_GAP_MS = 600; // 句间停顿超过此值视为一句结束
const MIN_SEGMENT_MS = 250; // 少于该时长的片段不单独提交（太短无意义）

export class RealtimeSession {
  private buf: Float32Array = new Float32Array(0); // 累积的全部 16k 样本
  private cursor = 0; // Rust 侧游标
  private committedEnd = 0; // buf 中已提交句子的截止样本数
  private segmentCount = 0;
  private lastVadCheck = 0; // 距上次 VAD 检查的样本数
  private running = false;
  private paused = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private engine = "auto";
  private cb: RealtimeCallbacks;
  /** 静音自动结束：静音超过该毫秒即自动停止（0 表示关闭） */
  private autoStopMs = 0;
  private lastVoiceSample = 0; // 最近一次检测到语音的样本位置（buf 内）
  /** 自动停止触发回调（让面板回到 done 态） */
  private onAutoStop: (() => void) | null = null;

  constructor(engine: string, cb: RealtimeCallbacks) {
    this.engine = engine;
    this.cb = cb;
  }

  get isRunning() {
    return this.running;
  }
  get isPaused() {
    return this.paused;
  }

  setAutoStop(ms: number) {
    this.autoStopMs = ms;
  }
  setAutoStopHandler(fn: () => void) {
    this.onAutoStop = fn;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.buf = new Float32Array(0);
    this.cursor = 0;
    this.committedEnd = 0;
    this.segmentCount = 0;
    this.lastVadCheck = 0;
    this.lastVoiceSample = 0;
    this.paused = false;
    await invoke("realtime_start");
    this.running = true;
    this.timer = setInterval(() => void this.tick(), READ_INTERVAL_MS);
  }

  /** 暂停/继续（Rust 侧回调丢弃新样本；已识别句子保留） */
  async togglePause(): Promise<boolean> {
    if (!this.running) return this.paused;
    if (this.paused) {
      await invoke("realtime_resume");
      this.paused = false;
    } else {
      await invoke("realtime_pause");
      this.paused = true;
      // 暂停期间再收一次尾，把已说完的句子提交
      await this.commitPending(true);
    }
    return this.paused;
  }

  async stop(): Promise<string> {
    if (!this.running) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return "";
    }
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // 停采后把剩余全部拉进来，并提交末尾未处理语音
    try {
      const r = await invoke<any>("realtime_stop");
      this.append(r.samples);
    } catch (e) {
      this.cb.onError?.("停止实时采集失败: " + e);
    }
    // 提交剩余语音
    await this.commitPending(true);
    return "";
  }

  async cancel(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      await invoke("realtime_stop");
    } catch {
      /* ignore */
    }
  }

  /** 完整录音（整段 16k 音频）为 WAV Blob，供保存到音频库 */
  getFullAudioWav(): Blob {
    return pcmToWavBlob(this.toInt16(this.buf), SR);
  }

  private async tick() {
    if (!this.running) return;
    try {
      const r = await invoke<any>("realtime_read", { cursor: this.cursor });
      this.cursor = r.cursor;
      this.append(r.samples);
      this.cb.onListening?.({ listening: true, level: this.level() });
      // 只在自上次 VAD 后累积了足够新音频时才切句（省本地请求）
      if (
        this.buf.length - this.lastVadCheck >=
        Math.round((SR * VAD_CHECK_MIN_MS) / 1000)
      ) {
        this.lastVadCheck = this.buf.length;
        await this.commitPending(false);
      }
      // 静音自动结束：距最后语音段的静音超过阈值 → 自动停止
      if (this.autoStopMs > 0) {
        const silenceMs = ((this.buf.length - this.lastVoiceSample) / SR) * 1000;
        if (silenceMs >= this.autoStopMs && this.lastVoiceSample > 0) {
          this.onAutoStop?.();
          return;
        }
      }
    } catch (e) {
      // 采集可能已被中断
      this.cb.onError?.("实时采集读取失败: " + e);
    }
  }

  private append(samples: number[] | Float32Array) {
    if (!samples || !samples.length) return;
    const add = Float32Array.from(samples as number[]);
    const nb = new Float32Array(this.buf.length + add.length);
    nb.set(this.buf, 0);
    nb.set(add, this.buf.length);
    this.buf = nb;
  }

  /** 简单 RMS 电平，供 UI 显示音量 */
  private level(): number {
    const n = this.buf.length;
    if (n < 1) return 0;
    const from = Math.max(0, n - SR); // 只看最近 1s
    let sum = 0;
    for (let i = from; i < n; i++) {
      const v = this.buf[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / (n - from));
    return Math.min(1, rms * 5);
  }

  private async commitPending(force: boolean) {
    if (this.buf.length - this.committedEnd < SR * 0.1) return; // 不到 100ms 不处理
    let segs: [number, number][] = [];
    try {
      segs = await this.detectVad();
    } catch {
      return; // VAD 服务暂不可用则不切句
    }
    if (!segs.length) return;
    // 记录最近一次检测到语音的位置（最后一个语音段末尾）
    const lastSeg = segs[segs.length - 1];
    if (lastSeg && lastSeg.length >= 2) {
      this.lastVoiceSample = Math.round((lastSeg[1] / 1000) * SR);
    }

    let commitTo = this.committedEnd; // 样本数（buf 内坐标）
    for (const [sMs, eMs] of segs) {
      const s = Math.round((sMs / 1000) * SR);
      const e = Math.round((eMs / 1000) * SR);
      if (e <= this.committedEnd) continue;
      if (s < this.committedEnd) continue; // 与该句重叠/已被提交
      // 此段之后距当前末尾是否有足够停顿（或 force 直接收尾）
      const gap = this.buf.length - e;
      const gapMs = (gap / SR) * 1000;
      const durMs = eMs - sMs;
      if ((force && durMs >= MIN_SEGMENT_MS) || gapMs >= SENTENCE_GAP_MS) {
        commitTo = e;
      } else {
        break; // 后面的段都还没说完，保持现状等下一轮
      }
    }

    if (commitTo > this.committedEnd + Math.round((SR * MIN_SEGMENT_MS) / 1000)) {
      const segment = this.buf.slice(this.committedEnd, commitTo);
      this.committedEnd = commitTo;
      const text = await this.transcribeSegment(segment);
      if (text) {
        this.segmentCount++;
        this.cb.onSegment(text, this.segmentCount);
      }
    }
  }

  private async detectVad(): Promise<[number, number][]> {
    const raw = this.toInt16Bytes(this.buf.slice(this.committedEnd));
    if (raw.length < 32) return [];
    const res = await fetch(`${getBaseUrl()}/vad`, this.auth({
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: raw as BodyInit,
    }));
    if (!res.ok) return [];
    const d = await res.json();
    return Array.isArray(d.speech) ? d.speech : [];
  }

  private async transcribeSegment(f32: Float32Array): Promise<string> {
    const wav = pcmToWavBlob(this.toInt16(f32), SR);
    const q = `/transcribe?engine=${encodeURIComponent(this.engine)}&punct=0&vad=0`;
    const res = await fetch(`${getBaseUrl()}${q}`, this.auth({
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
    }));
    if (!res.ok) return "";
    const d = await res.json();
    return String(d.text || "").trim();
  }

  private toInt16(f32: Float32Array): Int16Array {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  private toInt16Bytes(f32: Float32Array): Uint8Array {
    const pcm = this.toInt16(f32);
    const out = new Uint8Array(pcm.length * 2);
    for (let i = 0; i < pcm.length; i++) {
      out[i * 2] = pcm[i] & 0xff;
      out[i * 2 + 1] = (pcm[i] >> 8) & 0xff;
    }
    return out;
  }

  private auth(init: RequestInit): RequestInit {
    const token = getToken();
    const headers: Record<string, string> = {
      ...((init.headers as Record<string, string>) || {}),
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return { ...init, headers };
  }
}

export function createRealtimeSession(engine: string, cb: RealtimeCallbacks): RealtimeSession {
  return new RealtimeSession(engine, cb);
}
