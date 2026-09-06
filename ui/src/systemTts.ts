// 000-plan-6 阶段1：系统朗读（tauri-plugin-tts；Win=WinRT / Mac=AVSpeechSynthesizer）
// 边界（见 plan-6 §2）：单次文本上限 10000 UTF-8 字节；桌面端 speak() 开始即 resolve、
// 结束听事件；无法暂停只能 stop。此处封装为 ReadPanel 直接可用的小工具。
import {
  speak,
  stop,
  getVoices,
  previewVoice,
  isSpeaking,
  isTtsError,
  type Voice,
} from "tauri-plugin-tts-api";

export type { Voice };

export async function isSpeakingSystem(): Promise<boolean> {
  return isSpeaking();
}

export async function listSystemVoices(): Promise<Voice[]> {
  return getVoices();
}

// 插件错误是 { code, message } 普通对象（instanceof 无效），统一转可读文案
export function ttsErrorMessage(e: unknown): string {
  if (isTtsError(e)) return `${e.code}: ${e.message}`;
  return String(e);
}

// 按 UTF-8 字节切分到 ≤ limit，优先在句读符号处断开（与 /speak 前端分句同思路）
function chunkText(text: string, limit = 9500): string[] {
  const byteLen = (s: string) => new TextEncoder().encode(s).length;
  if (byteLen(text) <= limit) return [text];
  const chunks: string[] = [];
  let cur = "";
  let curBytes = 0;
  let lastBreak = -1; // cur 中最后一个句读符号之后的下标（可安全断点）
  for (const ch of text) {
    const b = byteLen(ch);
    if (curBytes + b > limit) {
      const cut = lastBreak >= 0 ? lastBreak : cur.length;
      chunks.push(cur.slice(0, cut));
      cur = cur.slice(cut);
      curBytes = byteLen(cur);
      lastBreak = -1;
    }
    cur += ch;
    curBytes += b;
    if ("。！？；\n.!?;".includes(ch)) lastBreak = cur.length;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

// 朗读整段文本：第一段打断当前朗读，其余排队追加；开始即返回（结束由面板轮询 isSpeaking）
export async function speakSystem(
  text: string,
  voiceId: string | null,
  rate: number
): Promise<void> {
  const chunks = chunkText(text);
  const base = { voiceId: voiceId || null, rate: rate || null, pitch: null, volume: null };
  await speak({ text: chunks[0], ...base, language: voiceId ? null : "zh-CN", queueMode: null });
  for (let i = 1; i < chunks.length; i++) {
    await speak({ text: chunks[i], ...base, language: null, queueMode: "add" });
  }
}

export async function stopSystem(): Promise<void> {
  await stop();
}

export async function previewSystemVoice(
  voiceId: string,
  text?: string
): Promise<void> {
  await previewVoice({ voiceId, text: text ?? null });
}
