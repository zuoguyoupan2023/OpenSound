// 音频库前端封装：保存（录音/TTS）、列表、删除、播放（asset protocol）
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { save as dialogSave } from "@tauri-apps/plugin-dialog";

export interface AudioRecord {
  id: string;
  kind: "recording" | "tts";
  file: string;
  created_at: number;
  duration_sec: number;
  engine: string;
  text: string;
  is_clone_sample: boolean;
  /** 来源面板：asr|home|chat|realtime|voice|read（旧记录为空） */
  source?: string;
  /** TTS 参数快照 */
  voice?: string;
  sid?: number;
  speed?: number;
  language?: string;
  /** 流式中途被手动停止，音频为已生成部分 */
  interrupted?: boolean;
}

// 保存时的可选元数据
export interface SaveMeta {
  source?: string;
  voice?: string;
  sid?: number;
  speed?: number;
  language?: string;
  interrupted?: boolean;
}

// 来源角标文案（六类来源 + 旧记录按 kind 回退）
const SOURCE_LABELS: Record<string, string> = {
  asr: "识别",
  home: "工作台",
  chat: "对话",
  realtime: "实时",
  voice: "音色导入",
  read: "朗读",
};

export function sourceLabel(rec: AudioRecord): string {
  if (rec.source && SOURCE_LABELS[rec.source]) return SOURCE_LABELS[rec.source];
  return rec.kind === "recording" ? "识别" : "朗读";
}

// 角标配色类（与 App.css 中 .src-* 对应）
export function sourceClass(rec: AudioRecord): string {
  const known = ["asr", "home", "chat", "realtime", "voice", "read"];
  if (rec.source && known.includes(rec.source)) return `src-${rec.source}`;
  return rec.kind === "recording" ? "src-asr" : "src-read";
}

// ---------- 小工具 ----------
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] ?? "");
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

// ---------- WAV 头解析与时长 ----------
// 解析 WAV 头部关键参数；注意各 TTS 引擎帧均为 24kHz（kokoro/qwen3/cosyvoice），
// 录音为 16kHz——绝不能写死采样率。
function wavHeaderInfo(
  bytes: Uint8Array
): { sampleRate: number; channels: number; bitsPerSample: number } | null {
  if (bytes.length < 44) return null;
  const tag = (o: number) =>
    String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    sampleRate: dv.getUint32(24, true),
    channels: dv.getUint16(22, true),
    bitsPerSample: dv.getUint16(34, true),
  };
}

function durationFromHeaderWithPartial(head: Uint8Array, totalBytesApprox: number): number {
  const h = wavHeaderInfo(head);
  if (!h || !h.sampleRate || !h.channels || !h.bitsPerSample) {
    return Math.max(0, (totalBytesApprox - 44) / 2 / 16000); // 兜底按 16k
  }
  const byteRate = h.sampleRate * h.channels * (h.bitsPerSample / 8);
  return byteRate > 0 ? Math.max(0, (totalBytesApprox - 44) / byteRate) : 0;
}

// 按真实头部计算 Blob WAV 时长（TTS 各引擎为 24k、录音 16k，须读头而非写死）
export async function wavBlobDuration(blob: Blob): Promise<number> {
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  return durationFromHeaderWithPartial(head, blob.size);
}

// base64 只解前缀即可拿到头部（避免整段解码）
function wavDurationFromBase64(b64: string): number {
  const slice = b64.slice(0, 1024);
  const clean = slice.slice(0, slice.length - (slice.length % 4));
  let bin: string;
  try {
    bin = atob(clean);
  } catch {
    return 0;
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return durationFromHeaderWithPartial(bytes, (b64.length * 3) / 4);
}

// ---------- 保存 ----------
async function save(
  kind: "recording" | "tts",
  wavBase64: string,
  durationSec: number,
  engine: string,
  text: string,
  meta?: SaveMeta
): Promise<AudioRecord> {
  return invoke<AudioRecord>("audio_save", {
    kind,
    wavBase64,
    durationSec,
    engine,
    text,
    ...meta,
  });
}

export async function saveRecording(
  wav: Blob,
  engine: string,
  text: string,
  meta?: SaveMeta
): Promise<AudioRecord> {
  const b64 = await blobToBase64(wav);
  const duration = await wavBlobDuration(wav);
  return save("recording", b64, duration, engine, text, meta);
}

// audio 可以是 Blob 或已是 base64 字符串
export async function saveTts(
  audio: Blob | string,
  engine: string,
  text: string,
  meta?: SaveMeta
): Promise<AudioRecord> {
  const isStr = typeof audio === "string";
  const b64 = isStr ? audio : await blobToBase64(audio);
  const duration = isStr ? wavDurationFromBase64(b64) : await wavBlobDuration(audio);
  return save("tts", b64, duration, engine, text, meta);
}

// ---------- 列表 / 删除 ----------
export async function listAudio(): Promise<AudioRecord[]> {
  return invoke<AudioRecord[]>("audio_list");
}

export async function deleteAudio(id: string): Promise<void> {
  await invoke("audio_delete", { id });
}

// ---------- 导出（zip：音频 + 配套文本） ----------
// 弹保存对话框，选好路径后由 Rust 打包 zip 写入
export async function exportAudio(
  rec: AudioRecord,
  defaultName: string
): Promise<boolean> {
  const path = await dialogSave({
    defaultPath: `${defaultName}.zip`,
    filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }],
  });
  if (!path) return false; // 用户取消
  await invoke("audio_export", { id: rec.id, destPath: path });
  return true;
}

// 标记/取消该条录音作为克隆音色样本来源
export async function setCloneSample(
  id: string,
  flag: boolean
): Promise<void> {
  await invoke("audio_set_clone_sample", { id, flag });
}

// ---------- 播放（asset protocol） ----------
let dirCache: string | null = null;
export async function getAudioDir(): Promise<string> {
  if (!dirCache) dirCache = await invoke<string>("audio_get_dir");
  return dirCache!;
}

export async function audioAssetUrl(rec: AudioRecord): Promise<string> {
  const dir = await getAudioDir();
  return convertFileSrc(dir + "/" + rec.file);
}

// ---------- TTS 帧流合并为单个 WAV ----------
// /speak 帧流：每帧 = 4 字节大端长度 + 一段完整 WAV。这里收集所有帧字节；
// 流被中断（如用户点停止触发 abort）时，返回已收到的完整帧，供"已截断"入库。
export async function collectFrames(
  stream: ReadableStream<Uint8Array>
): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  // 直接按原始字节流切帧
  let buf = new Uint8Array(0);
  const frames: Uint8Array[] = [];
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const nb = new Uint8Array(buf.length + value.length);
        nb.set(buf, 0);
        nb.set(value, buf.length);
        buf = nb;
      }
      // 切出完整帧
      while (buf.length >= 4) {
        const frameLen =
          ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
        if (buf.length < 4 + frameLen) break;
        frames.push(buf.slice(4, 4 + frameLen));
        buf = buf.slice(4 + frameLen);
      }
    }
  } catch {
    // 中断：保留已收到的完整帧
  }
  void decoder;
  return frames;
}

// 把多段完整 WAV 拼接为单个 WAV（去掉每段自身 44 字节头）。
// 头部参数从首帧读取：kokoro/qwen3/cosyvoice 帧均为 24kHz，录音帧为 16kHz，
// 绝不能写死采样率——此前写死 16k 导致 24k 音频重播变慢变调（听起来"换了个人"）。
// 注意：头部字段全部用绝对偏移写入。更早版本用游标 o 连写字符串，
// 导致 RIFF 尺寸字段被覆盖、块名整体前移 4 字节，生成的文件无法播放。
export function mergeWavFrames(frames: Uint8Array[]): Blob {
  const full = frames.filter((f) => f.length > 44);
  const datas = full.map((f) => f.subarray(44));
  let dataSize = 0;
  for (const d of datas) dataSize += d.length;

  // 从首帧读真实音频格式
  const info = wavHeaderInfo(full[0] ?? new Uint8Array(44));
  const sampleRate = info?.sampleRate || 16000;
  const channels = info?.channels || 1;
  const bits = info?.bitsPerSample || 16;

  const out = new Uint8Array(44 + dataSize);
  const dv = new DataView(out.buffer);
  const ws = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
  };
  ws(0, "RIFF");
  dv.setUint32(4, 36 + dataSize, true);
  ws(8, "WAVE");
  ws(12, "fmt ");
  dv.setUint32(16, 16, true); // fmt 块大小
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * channels * (bits / 8), true); // 字节率
  dv.setUint16(32, channels * (bits / 8), true); // 块对齐
  dv.setUint16(34, bits, true); // 位深
  ws(36, "data");
  dv.setUint32(40, dataSize, true);

  let off = 44;
  for (const d of datas) {
    out.set(d, off);
    off += d.length;
  }
  return new Blob([out], { type: "audio/wav" });
}

// 通用：边流式播放、边收集帧，供保存（利用 stream.tee()）
export function teeCollect(
  stream: ReadableStream<Uint8Array>
): {
  playStream: ReadableStream<Uint8Array>;
  collected: Promise<Uint8Array[]>;
} {
  const [a, b] = stream.tee();
  const collected = collectFrames(b);
  return { playStream: a, collected };
}
