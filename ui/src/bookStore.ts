// 长文朗读任务（books/）前端封装（060 P2）：任务列表/创建/详情/批次落盘/删除/导出/播放 asset URL
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { save as dialogSave } from "@tauri-apps/plugin-dialog";

export interface BookBatch {
  start: number;
  end: number;
  /** 已落盘文件名（空 = 未合成） */
  file: string;
  duration_sec: number;
}

export interface BookSummary {
  id: string;
  title: string;
  source_name: string;
  engine: string;
  voice: string;
  sid: number;
  speed: number;
  language: string;
  batch_chars: number;
  total_batches: number;
  /** 下一个待合成的批下标；等于 total_batches = 全部已合成 */
  next_idx: number;
  total_chars: number;
  created_at: number;
  updated_at: number;
}

export interface BookDetail {
  summary: BookSummary;
  text: string;
  batches: BookBatch[];
}

/** 创建时的批次偏移（来自 textSplit.splitTextBatches） */
export interface BookBatchOffsets {
  start: number;
  end: number;
}

export interface BookCreateParams {
  title?: string;
  sourceName?: string;
  text: string;
  engine: string;
  voice?: string;
  sid?: number;
  speed?: number;
  language?: string;
  batchChars: number;
  batches: BookBatchOffsets[];
}

export async function booksList(): Promise<BookSummary[]> {
  return invoke<BookSummary[]>("books_list");
}

export async function booksGetDir(): Promise<string> {
  return invoke<string>("books_get_dir");
}

export async function booksCreate(
  p: BookCreateParams
): Promise<BookSummary> {
  return invoke<BookSummary>("books_create", {
    title: p.title ?? "",
    sourceName: p.sourceName ?? "",
    text: p.text,
    engine: p.engine,
    voice: p.voice ?? "",
    sid: p.sid,
    speed: p.speed ?? 1,
    language: p.language ?? "",
    batchChars: p.batchChars,
    batches: p.batches,
  });
}

export async function booksGet(id: string): Promise<BookDetail> {
  return invoke<BookDetail>("books_get", { id });
}

/** 保存一批已合成的 WAV（每批一个文件；只存整批完成的） */
export async function booksSaveSegment(
  id: string,
  idx: number,
  wavBase64: string,
  durationSec: number
): Promise<BookSummary> {
  return invoke<BookSummary>("books_save_segment", {
    id,
    idx,
    wavBase64,
    durationSec,
  });
}

/** 手动推进进度（跳过空白批等场景；只前进不回退） */
export async function booksSetNext(id: string, next: number): Promise<BookSummary> {
  return invoke<BookSummary>("books_set_next", { id, next });
}

export async function booksDelete(id: string): Promise<void> {
  await invoke("books_delete", { id });
}

export async function booksExport(id: string, defaultName: string): Promise<boolean> {
  const path = await dialogSave({
    defaultPath: `${defaultName}.zip`,
    filters: [{ name: "ZIP 压缩包", extensions: ["zip"] }],
  });
  if (!path) return false;
  await invoke("books_export", { id, destPath: path });
  return true;
}

let dirCache: string | null = null;
/** 任务已合成批次的播放 URL（asset protocol；目录缓存在 Rust 侧创建） */
export async function bookSegUrl(summary: BookSummary, idx: number): Promise<string | null> {
  const dir = dirCache ?? (dirCache = await booksGetDir());
  const file = `seg_${String(idx).padStart(5, "0")}.wav`;
  return convertFileSrc(dir + "/" + summary.id + "/" + file);
}

/** 任务是否全部批次已合成 */
export function bookDone(s: BookSummary): boolean {
  return s.next_idx >= s.total_batches;
}
