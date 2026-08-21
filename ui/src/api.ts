import type { HealthInfo, ModelInfo, InstallProgress } from "./types";

// 后端基地址（Tabu-Local 服务，端口约定 9528，与 Tabu-AI 一致）
// 可从 localStorage 覆盖（设置面板），默认 9528
const LS_KEY = "tabu_settings";
interface PersistedSettings {
  baseUrl?: string;
  token?: string;
  deepseekKey?: string;
  zhipuKey?: string;
}

function readSettings(): PersistedSettings {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
}

export function getBaseUrl(): string {
  return readSettings().baseUrl || "http://127.0.0.1:9528";
}

export function getToken(): string {
  return readSettings().token || "";
}

export function saveSettings(next: PersistedSettings) {
  localStorage.setItem(LS_KEY, JSON.stringify(next));
}

export function getPersistedSettings(): PersistedSettings {
  return readSettings();
}

// 云端 LLM 的 API Key（用户在设置面板填写，仅存本机 localStorage）
export function getCloudApiKey(engine: string): string {
  const s = readSettings();
  if (engine === "deepseek") return s.deepseekKey || "";
  if (engine === "zhipu") return s.zhipuKey || "";
  return "";
}

function authHeaders(init?: RequestInit): RequestInit {
  const token = getToken();
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return { ...init, headers };
}

// ---------- 通用 ----------
async function jfetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(getBaseUrl() + path, authHeaders(init));
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function getHealth(): Promise<HealthInfo> {
  return jfetch<HealthInfo>("/health");
}

export async function getModels(): Promise<ModelInfo[]> {
  const r = await jfetch<{ models: ModelInfo[] }>("/models");
  return r.models;
}

// ---------- 识别 ASR ----------
// body 为 WAV/RAW PCM 16kHz 单声道；punct=true 时服务端识别后自动加标点；vad=true 时识别前过滤静音
export async function transcribe(
  wav: Blob,
  engine: string = "auto",
  punct: boolean = true,
  vad: boolean = true
): Promise<{ text: string; engine: string }> {
  const q = `/transcribe?engine=${encodeURIComponent(engine)}&punct=${punct ? "1" : "0"}&vad=${vad ? "1" : "0"}`;
  const res = await fetch(
    `${getBaseUrl()}${q}`,
    authHeaders({
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
    })
  );
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as { text: string; engine: string };
}

// ---------- 朗读 TTS ----------
export interface SpeakParams {
  text: string;
  engine: "kokoro" | "qwen3" | "clone";
  sid?: number;
  speed?: number;
  voice?: string;
  language?: string;
}

// 返回可解析的帧流：每帧 = 4字节大端长度 + 一段 WAV
export async function speakStream(
  params: SpeakParams
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(
    `${getBaseUrl()}/speak?engine=${encodeURIComponent(params.engine)}`,
    authHeaders({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: params.text,
        sid: params.sid,
        speed: params.speed ?? 1,
        voice: params.voice,
        language: params.language,
      }),
    })
  );
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.body;
}

// ---------- 对话 LLM ----------
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chat(
  messages: ChatMessage[],
  engine: string = "llama-cpp",
  model?: string,
  apiKey?: string
): Promise<{ text: string; engine: string }> {
  return jfetch<{ text: string; engine: string }>("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, engine, model, apiKey }),
  });
}

// ---------- 全链路：语音 → 识别 → LLM → 朗读 ----------
export interface VoiceChatOptions {
  asrEngine?: string;
  llmEngine?: string;
  llmModel?: string;
  llmApiKey?: string;
  ttsEngine?: "kokoro" | "qwen3" | "clone";
  prompt?: string;
  system?: string;
  sid?: number;
  voice?: string;
  language?: string;
}

export async function voiceChat(
  wav: Blob,
  opts: VoiceChatOptions = {}
): Promise<{ recognized: string; answer: string; audioBase64: string }> {
  const q = new URLSearchParams({
    asrEngine: opts.asrEngine || "auto",
    llmEngine: opts.llmEngine || "llama-cpp",
    ttsEngine: opts.ttsEngine || "kokoro",
    fmt: "json",
  });
  if (opts.prompt) q.set("prompt", opts.prompt);
  if (opts.system) q.set("system", opts.system);
  if (opts.llmModel) q.set("llmModel", opts.llmModel);
  if (opts.llmApiKey) q.set("llmApiKey", opts.llmApiKey);
  if (opts.sid !== undefined) q.set("sid", String(opts.sid));
  if (opts.voice) q.set("voice", opts.voice);
  if (opts.language) q.set("language", opts.language);

  const res = await fetch(
    `${getBaseUrl()}/voice-chat?${q.toString()}`,
    authHeaders({
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
    })
  );
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as {
    recognized: string;
    answer: string;
    audioBase64: string;
  };
}

// ---------- 模型安装（NDJSON 进度流） ----------
export async function installModel(
  engine: string,
  onProgress: (p: InstallProgress) => void
): Promise<void> {
  const res = await fetch(
    `${getBaseUrl()}/install-model?engine=${encodeURIComponent(engine)}`,
    authHeaders({ method: "POST" })
  );
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        onProgress(JSON.parse(line) as InstallProgress);
      } catch {
        /* skip bad line */
      }
    }
  }
}
