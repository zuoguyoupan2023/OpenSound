import type { HealthInfo, ModelInfo, InstallProgress, DeviceProfile } from "./types";
import { invoke } from "@tauri-apps/api/core";

// 后端基地址（Tabu-Local 服务，端口约定 9528，与 Tabu-AI 一致）
// 设置统一存放在 config.json 的 ui 节（Rust 侧），启动时载入内存缓存；
// 旧版本存 WebView localStorage(tabu_settings)，首次启动自动迁入并清除（011 §5.6 存储规范）
interface PersistedSettings {
  baseUrl?: string;
  token?: string;
  deepseekKey?: string;
  zhipuKey?: string;
}

const LS_KEY = "tabu_settings";
const DEFAULT_BASE_URL = "http://127.0.0.1:9528";

let settingsCache: PersistedSettings | null = null;

function inTauri(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.userAgent.includes("Tauri")
  );
}

function readLegacyLocalStorage(): PersistedSettings {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
}

function legacyHasValue(s: PersistedSettings): boolean {
  return Boolean(s.baseUrl || s.token || s.deepseekKey || s.zhipuKey);
}

// 应用启动时调用一次：读 config.json → 内存缓存；为空且有旧 localStorage 数据则一键迁移
export async function initSettings(): Promise<void> {
  if (!inTauri()) {
    settingsCache = readLegacyLocalStorage();
    return;
  }
  try {
    const ui = await invoke<{
      base_url: string;
      token: string;
      deepseek_key: string;
      zhipu_key: string;
    }>("get_ui_settings");
    let s: PersistedSettings = {
      baseUrl: ui.base_url || "",
      token: ui.token || "",
      deepseekKey: ui.deepseek_key || "",
      zhipuKey: ui.zhipu_key || "",
    };
    const legacy = readLegacyLocalStorage();
    const emptyInConfig =
      !s.baseUrl && !s.token && !s.deepseekKey && !s.zhipuKey;
    if (emptyInConfig && legacyHasValue(legacy)) {
      await invoke("set_ui_settings", {
        baseUrl: legacy.baseUrl ?? "",
        token: legacy.token ?? "",
        deepseekKey: legacy.deepseekKey ?? "",
        zhipuKey: legacy.zhipuKey ?? "",
      });
      s = { ...legacy };
      try {
        localStorage.removeItem(LS_KEY);
      } catch {
        /* ignore */
      }
      console.info("已把 localStorage 旧设置迁移到 config.json");
    }
    settingsCache = s;
  } catch (e) {
    console.error("读取设置失败，回退 localStorage:", e);
    settingsCache = readLegacyLocalStorage();
  }
}

function currentSettings(): PersistedSettings {
  if (settingsCache) return settingsCache;
  return inTauri() ? {} : readLegacyLocalStorage();
}

export function getBaseUrl(): string {
  return currentSettings().baseUrl || DEFAULT_BASE_URL;
}

export function getToken(): string {
  return currentSettings().token || "";
}

export function getPersistedSettings(): PersistedSettings {
  return currentSettings();
}

// 云端 LLM 的 API Key（仅存本机 config.json）
export function getCloudApiKey(engine: string): string {
  const s = currentSettings();
  if (engine === "deepseek") return s.deepseekKey || "";
  if (engine === "zhipu") return s.zhipuKey || "";
  return "";
}

// 局部更新设置：先更内存缓存再持久化到 config.json（未传的字段不动）
export async function updateSettings(
  partial: Partial<PersistedSettings>
): Promise<void> {
  settingsCache = { ...(settingsCache ?? {}), ...partial };
  if (!inTauri()) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(settingsCache));
    } catch {
      /* ignore */
    }
    return;
  }
  await invoke("set_ui_settings", {
    baseUrl: partial.baseUrl,
    token: partial.token,
    deepseekKey: partial.deepseekKey,
    zhipuKey: partial.zhipuKey,
  });
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

// 设备画像（000-device-vs-model.md §四：4.1 接口，服务启动时探测一次并缓存）
export async function getDeviceProfile(): Promise<DeviceProfile> {
  return jfetch<DeviceProfile>("/device-profile");
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
// signal 用于「停止」时中断底层请求，避免服务端继续白算、前端继续收流
export async function speakStream(
  params: SpeakParams,
  signal?: AbortSignal
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
      signal,
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

// ---------- 模型安装（NDJSON 进度流；S3：支持镜像切换与取消） ----------
export async function installModel(
  engine: string,
  onProgress: (p: InstallProgress) => void,
  opts?: { mirror?: string; signal?: AbortSignal; confirmBigDownload?: boolean }
): Promise<void> {
  const q = new URLSearchParams({ engine });
  if (opts?.mirror) q.set("mirror", opts.mirror);
  if (opts?.confirmBigDownload) q.set("confirm", "1"); // S5：大流量下载的二次确认回执
  const res = await fetch(
    `${getBaseUrl()}/install-model?${q.toString()}`,
    authHeaders({ method: "POST", signal: opts?.signal })
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

// 取消当前下载（服务端杀 curl，.part 保留供续传）
export async function cancelInstall(): Promise<void> {
  await jfetch("/install-cancel", { method: "POST" });
}

// 磁盘剩余空间
export async function getDisk(): Promise<{ availBytes: number | null }> {
  return jfetch<{ availBytes: number | null }>("/disk");
}
