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

// 16kHz 单声道 16-bit WAV 的近似时长（秒）
export function wavDurationSec(blob: Blob): number {
  return Math.max(0, (blob.size - 44) / 2 / 16000);
}

function wavDurationFromBase64(b64: string): number {
  const bytes = (b64.length * 3) / 4 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  return Math.max(0, (bytes - 44) / 2 / 16000);
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
  return save("recording", b64, wavDurationSec(wav), engine, text, meta);
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
  const duration = isStr ? wavDurationFromBase64(b64) : wavDurationSec(audio);
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

// 把多段完整 WAV 拼接为单个 16kHz 单声道 WAV（去掉每段自身 44 字节头）
export function mergeWavFrames(frames: Uint8Array[]): Blob {
  const datas = frames.filter((f) => f.length > 44).map((f) => f.subarray(44));
  let dataSize = 0;
  for (const d of datas) dataSize += d.length;

  const out = new Uint8Array(44 + dataSize);
  const dv = new DataView(out.buffer);
  let o = 0;
  const ws = (s: string) => {
    for (let i = 0; i < s.length; i++) out[o++] = s.charCodeAt(i);
  };
  ws("RIFF");
  dv.setUint32(4, 36 + dataSize, true);
  ws("WAVE");
  ws("fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, 16000, true);
  dv.setUint32(28, 32000, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  ws("data");
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
