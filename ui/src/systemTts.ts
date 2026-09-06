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

// 各语言本地化试听文本（插件默认样本是英文，对非英语音色不合适）
const PREVIEW_TEXT: Record<string, string> = {
  zh: "你好，这是系统朗读试听，希望你喜欢这个声音。",
  cmn: "你好，这是系统朗读试听，希望你喜欢这个声音。",
  yue: "你好，而家试试用呢把声读出嚟，希望你钟意。",
  en: "Hello, this is a voice preview. Hope you like it.",
  ja: "こんにちは、これは音声のプレビューです。",
  ko: "안녕하세요, 음성 미리 듣기입니다.",
  fr: "Bonjour, ceci est un aperçu de la voix.",
  de: "Hallo, das ist eine Sprachvorschau.",
  es: "Hola, esta es una vista previa de la voz.",
  pt: "Olá, esta é uma prévia da voz.",
  it: "Ciao, questa è un'anteprima della voce.",
  ru: "Привет, это предварительное прослушивание голоса.",
  ar: "مرحبا، هذه معاينة صوتية.",
  hi: "नमस्ते, यह आवाज़ का पूर्वावलोकन है।",
  th: "สวัสดี นี่คือตัวอย่างเสียง",
  vi: "Xin chào, đây là bản xem trước giọng nói.",
  id: "Halo, ini pratinjau suara.",
  ms: "Halo, ini pratonton suara.",
  tr: "Merhaba, bu bir ses önizlemesidir.",
  nl: "Hallo, dit is een stemvoorbeeld.",
  pl: "Cześć, to jest podgląd głosu.",
};
export function previewSampleText(language?: string): string {
  const primary = (language || "").split("-")[0].toLowerCase();
  return PREVIEW_TEXT[primary] || "你好，这是语音试听。Hello, this is a voice preview.";
}
