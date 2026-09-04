import type { HealthInfo, ModelInfo, InstallProgress, DeviceProfile } from "./types";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// 后端基地址（OpenSound 服务，端口约定 9528，与 Tabu-AI 一致）
// 设置统一存放在 config.json 的 ui 节（Rust 侧），启动时载入内存缓存；
// 旧版本（0.x）存 WebView localStorage(opensound_settings)，首次启动自动迁入并清除（011 §5.6 存储规范）；更早的 tabu_settings 一并迁移
// 030 阶段一：服务资源模式（powerMode=全能/节能）
// 000-plan-3：节能 = 每类同时仅启用 1 个模型（无"禁用"）——每类别一个启用选择：
//   TTS 类 ecoTts / ASR 类 ecoAsr（均取 engines/*.json 的引擎 id），LLM 类沿用 llmModel（对话档位）。
//   eco_big 字段保留为旧版兼容（Rust 侧读取时回退推导，新 UI 不再写它）。
export type PowerMode = "full" | "eco";
export type EcoTts = "" | "kokoro" | "qwen3" | "cosyvoice-clone";
export type EcoAsr = "" | "sensevoice" | "sensevoice-original" | "whisper";
/** @deprecated 000-plan-3：旧全局单开语义，仅兼容旧 config；新逻辑用 ecoTts/ecoAsr */
export type EcoBig = "none" | "qwen3" | "cosyvoice" | "sensevoice-original";

interface PersistedSettings {
  baseUrl?: string;
  token?: string;
  deepseekKey?: string;
  zhipuKey?: string;
  powerMode?: PowerMode;
  ecoBig?: EcoBig;
  /** 000-plan-3：用户选择的本地 LLM 档位（llama-cpp），持久化跨重启沿用 */
  llmModel?: string;
  /** 000-plan-3：节能下 TTS 类别当前启用引擎（空=未配置，按"已装最小"建议/自动补） */
  ecoTts?: EcoTts;
  /** 000-plan-3：节能下 ASR 类别当前启用引擎（空=未配置） */
  ecoAsr?: EcoAsr;
}

/** 000-plan-3：引擎类别 → 节能启用选择字段 */
export function ecoCategoryKey(cat: "tts" | "asr"): "ecoTts" | "ecoAsr" {
  return cat === "tts" ? "ecoTts" : "ecoAsr";
}

/** 000-plan-3：节能下某类别当前启用的引擎 id；非节能 / 未配置 → null（全可用 / 未定） */
export function ecoActiveEngine(cat: "tts" | "asr", s: PersistedSettings): string | null {
  if (s.powerMode !== "eco") return null;
  const v = cat === "tts" ? s.ecoTts : s.ecoAsr;
  return v || null;
}

/** 000-plan-3：节能下引擎是否被停用（非该类启用选择）。full / LLM 类恒可用；ecoTts/ecoAsr 未配置 → 该类全部视为停用 */
export function engineDisabledInEco(
  cat: "tts" | "asr",
  engine: string,
  s: PersistedSettings
): boolean {
  if (s.powerMode !== "eco") return false;
  const active = ecoActiveEngine(cat, s);
  return active !== engine;
}

/** 引擎 id → 类别（面板联动/三表共用） */
export const ENGINE_CAT_OF: Record<string, "tts" | "asr" | "llm"> = {
  kokoro: "tts",
  qwen3: "tts",
  "cosyvoice-clone": "tts",
  sensevoice: "asr",
  whisper: "asr",
  "sensevoice-original": "asr",
  "llm-0.5b": "llm",
  "llm-qwen3-8b": "llm",
};

/** 朗读面板值 ↔ 引擎 id（面板用 "clone"，引擎 id 是 "cosyvoice-clone"） */
export const TTS_PANEL_TO_ID: Record<string, string> = {
  kokoro: "kokoro",
  qwen3: "qwen3",
  clone: "cosyvoice-clone",
};
export const TTS_ID_TO_PANEL: Record<string, string> = {
  kokoro: "kokoro",
  qwen3: "qwen3",
  "cosyvoice-clone": "clone",
};

/** 000-plan-3：某类别"已装中主文件最小"的引擎（节能默认建议依据）；无已装 → null */
export function suggestMinEngine(models: ModelInfo[], cat: "tts" | "asr" | "llm"): string | null {
  const list = models.filter((m) => m.category === cat && m.installed);
  if (!list.length) return null;
  const MAX = Number.MAX_SAFE_INTEGER;
  return [...list].sort(
    (a, b) => (a.profile?.diskGB ?? MAX) - (b.profile?.diskGB ?? MAX)
  )[0].engine;
}

/** 000-plan-3：按当前已装给每类算"最小已装"默认选择（仅补空位由调用方决定写不写） */
export async function applyEcoDefaults(
  models: ModelInfo[]
): Promise<Partial<PersistedSettings>> {
  const upd: Partial<PersistedSettings> = {};
  const t = suggestMinEngine(models, "tts");
  if (t) upd.ecoTts = t as EcoTts;
  const a = suggestMinEngine(models, "asr");
  if (a) upd.ecoAsr = a as EcoAsr;
  const l = suggestMinEngine(models, "llm");
  if (l) upd.llmModel = l;
  return upd;
}

const LS_KEY = "opensound_settings";
const LEGACY_LS_KEY = "tabu_settings"; // 更早版本（0.x 时代）的 key，首次启动迁入 config.json 后清除
const DEFAULT_BASE_URL = "http://127.0.0.1:9528";

let settingsCache: PersistedSettings | null = null;

function inTauri(): boolean {
  // 必须用官方 isTauri()（检测 window.isTauri / __TAURI_INTERNALS__），
  // 不能靠 userAgent 字符串：Tauri v2 默认 WebView UA 不含 "Tauri"，
  // 会导致 token/settings 走错分支（S7 鉴权上线后所有请求 401 的根因）。
  return isTauri();
}

function readLegacyLocalStorage(): PersistedSettings {
  try {
    return JSON.parse(localStorage.getItem(LEGACY_LS_KEY) || "{}");
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
      power_mode: string;
      eco_big: string;
      llm_model: string;
      eco_tts: string;
      eco_asr: string;
    }>("get_ui_settings");
    let s: PersistedSettings = {
      baseUrl: ui.base_url || "",
      token: ui.token || "",
      deepseekKey: ui.deepseek_key || "",
      zhipuKey: ui.zhipu_key || "",
      powerMode: ui.power_mode === "eco" ? "eco" : "full",
      ecoBig: (ui.eco_big as EcoBig) || "none",
      llmModel: ui.llm_model || "",
      // 000-plan-3：ecoTts/ecoAsr 空时按旧 eco_big 回退（Rust 侧 get 原样返回、effective_eco 亦回退，双保险）
      ecoTts:
        (ui.eco_tts as EcoTts) ||
        (ui.power_mode === "eco" && ui.eco_big === "qwen3"
          ? "qwen3"
          : ui.power_mode === "eco" && ui.eco_big === "cosyvoice"
            ? "cosyvoice-clone"
            : ""),
      ecoAsr:
        (ui.eco_asr as EcoAsr) ||
        (ui.power_mode === "eco" && ui.eco_big === "sensevoice-original"
          ? "sensevoice-original"
          : ""),
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
        localStorage.removeItem(LEGACY_LS_KEY);
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
    powerMode: partial.powerMode,
    ecoBig: partial.ecoBig,
    llmModel: partial.llmModel,
    ecoTts: partial.ecoTts,
    ecoAsr: partial.ecoAsr,
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

// ---------- 032 P3 数据目录（模型存放目录） ----------
// 生效中的数据根目录（模型/缓存/音色落盘处；默认 app_data_dir，可自定义）
export async function getDataRoot(): Promise<string> {
  return invoke<string>("get_data_root");
}
export async function setDataRoot(path: string): Promise<void> {
  await invoke("set_data_root", { path });
}
// 把历史落在服务代码目录的 asr-server/models 迁移到数据目录 models/
export async function migrateModelsToData(): Promise<string> {
  return invoke<string>("migrate_models_to_data");
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

// ---------- P1 模型清单本地化（不依赖 9528 服务） ----------
export interface CatalogModel {
  category: string;
  engine: string;
  label: string;
  size: string;
  license: string;
  install?: { kind: "script" | "url-multi" | "hint" | "legacy"; mirrors: string[] } | null;
}

// 本地读 asr-server/engines/*.json → 可下载清单（服务离线也能显示）
export async function getModelsCatalog(): Promise<CatalogModel[]> {
  return invoke<CatalogModel[]>("get_models_catalog");
}

// 本机磁盘剩余（本地探测，不依赖 9528）
export async function getDiskLocal(): Promise<number> {
  return invoke<number>("get_disk_local");
}

// 设备画像（000-device-vs-model.md §四：4.1 接口，服务启动时探测一次并缓存）
export async function getDeviceProfile(): Promise<DeviceProfile> {
  return jfetch<DeviceProfile>("/device-profile");
}

// ---------- 识别 ASR ----------
// body 为 WAV/RAW PCM 16kHz 单声道；punct=true 时服务端识别后自动加标点；vad=true 时识别前过滤静音；
// lang 仅 whisper 生效（S11：'' = 自动检测；指定如 'zh'/'fr' 则按该语言识别，非法码服务端回退自动检测）
export async function transcribe(
  wav: Blob,
  engine: string = "auto",
  punct: boolean = true,
  vad: boolean = true,
  lang: string = ""
): Promise<{ text: string; engine: string }> {
  const q = `/transcribe?engine=${encodeURIComponent(engine)}&punct=${punct ? "1" : "0"}&vad=${vad ? "1" : "0"}${
    lang ? `&lang=${encodeURIComponent(lang)}` : ""
  }`;
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
      let parsed: InstallProgress;
      try {
        parsed = JSON.parse(line) as InstallProgress;
      } catch {
        continue; // skip bad line
      }
      // 关键修复（035 遗留根因）：服务端把安装器抛出的错误（如 BIG_DOWNLOAD_CONFIRM 二次确认标记）
      // 写成 type:"error" 的 NDJSON 行、HTTP 仍 200。原实现把错误行当普通进度丢给 onProgress、
      // 流正常结束 → 前端 catch 永不触发 → bigConfirm 永远不设置 → 确认行永远不出现（"晃一下"）。
      // 这里把 error 行转成抛出，前端 install() 的 catch 才能统一处理（识别二次确认 / 展示错误日志）。
      if (parsed.type === "error") {
        throw new Error(parsed.message || "安装失败");
      }
      onProgress(parsed);
    }
  }
}

// 取消当前下载（服务端杀 curl，.part 保留供续传）
export async function cancelInstall(): Promise<void> {
  await jfetch("/install-cancel", { method: "POST" });
}

// ---------- 阶段1：单引擎卸载（Rust 侧：先停服务 → 删模型文件 + venv + .part） ----------
export interface UninstallItem {
  path: string; // 展示路径（数据根内相对路径）
  kind: string; // file | dir
  bytes: number; // 删除前实际占用
  deleted: boolean;
  error?: string | null;
}
export interface UninstallPreview {
  engine: string;
  label: string;
  size_hint: string;
  est_bytes: number; // 现存目标合计（含 venv 与 .part）
  targets: UninstallItem[];
}
export interface UninstallResult {
  engine: string;
  freed_bytes: number;
  items: UninstallItem[];
  was_running: boolean; // 卸载前服务是否在运行
  restarted: boolean; // 已自动重启（其它引擎恢复可用）
  nothing_left: boolean; // 卸载后无任何其它引擎文件 → 不重启（空壳无意义）
  restart_error?: string | null; // 自动重启失败原因（如有）
}

// 预览：只统计将删除的文件/目录大小，不停服务、不删除（确认框显示"将释放多少"）
export async function uninstallPreview(engine: string): Promise<UninstallPreview> {
  return invoke<UninstallPreview>("uninstall_preview", { engine });
}

// 卸载：Rust 先停服务（释放文件锁）→ 删除模型文件 + 受管 venv + .part 残留 → 返回释放字节
export async function uninstallModel(engine: string): Promise<UninstallResult> {
  return invoke<UninstallResult>("uninstall_model", { engine });
}

// ---------- 阶段2：全局清理四档（cache/models/envs/all，设置页「环境与运行时」区块） ----------
export type ClearScope = "cache" | "models" | "envs" | "all";

export interface ClearDataItem {
  path: string;
  kind: string; // dir | file
  bytes: number;
  error?: string | null;
}
export interface ClearDataResult {
  scope: ClearScope;
  freed_bytes: number;
  items: ClearDataItem[];
  was_running: boolean; // 清理前服务在运行（已停止）
  restart_hint: string;
}

// 预览：统计将释放空间（不停服务、不删除）
export async function clearDataPreview(scope: ClearScope): Promise<number> {
  return invoke<number>("clear_data_preview", { scope });
}

// 清理：先停服务 → 删目标目录 → 不自动重启（提示见 restart_hint）
export async function clearData(scope: ClearScope): Promise<ClearDataResult> {
  return invoke<ClearDataResult>("clear_data", { scope });
}

// 磁盘剩余空间
export async function getDisk(): Promise<{ availBytes: number | null }> {
  return jfetch<{ availBytes: number | null }>("/disk");
}

// ---------- 032 运行时自举（App 内一键安装 node/依赖；字段随 Rust check_runtime 同步） ----------
export interface RuntimeStatus {
  node_ok: boolean;
  node_path: string;
  node_version: string;
  runtime_node: string;
  sys_node_found: boolean;
  python_found: boolean;
  python_version: string;
  deps_ready: boolean;
  // 034 阶段3：受管 python——全局基础（uv + CPython）独立按钮；引擎 venv 归模型页卡片
  uv_ready: boolean;
  py311_ready: boolean;
  python_ready: boolean;
  qwen3_venv: boolean;
  funasr_venv: boolean;
  cosy_venv: boolean;
  data_dir: string;
  server_dir: string;
}

// 安装步骤事件：{ step: node-download | deps | py | done | error, message, pct? }
export interface RuntimeProgress {
  step: string;
  message: string;
  pct?: number | null;
}

export async function checkRuntime(): Promise<RuntimeStatus> {
  return invoke<RuntimeStatus>("check_runtime");
}

// 触发 App 内一键自举（node 缺失时自动下载便携版 + npm ci 装依赖 + 拉起服务）；
// 进度通过 listenRuntimeProgress 事件流接收
export async function installRuntime(): Promise<void> {
  await invoke("install_runtime");
}

// 034 阶段3：受管 Python 基础（uv + CPython 3.11）——独立按钮，只装这一层（引擎 venv 在模型页装）
export async function installPythonBase(): Promise<void> {
  await invoke("install_python");
}

export async function listenRuntimeProgress(
  cb: (p: RuntimeProgress) => void
): Promise<UnlistenFn> {
  return listen<RuntimeProgress>("runtime-progress", (e) => cb(e.payload));
}

// ---------- 启动中状态判定（000-plan-3：节能 = 每类同时仅启用 1 个模型；Python 大模型按类启用起停） ----------
export interface StartingMap {
  asr: boolean; // 9528 整体（最小集在 9528 内，进程未就绪 = 整体启动中）
  kokoro: boolean;
  qwen3: boolean;
  cosyvoice: boolean;
  sensevoiceOriginal: boolean;
  /** 该大模型是否在"应启动集合"（全能=true；节能=TTS/ASR 类别按 ecoTts/ecoAsr 是否等于该引擎） */
  shouldStart: (key: string) => boolean;
  /** 节能模式下未启用的大模型（可用但未开，UI 显示黄"可切换使用"） */
  ecoDisabled: (key: string) => boolean;
}

export function computeStarting(
  settings: { powerMode?: PowerMode; ecoBig?: EcoBig; ecoTts?: EcoTts; ecoAsr?: EcoAsr },
  health: HealthInfo | null
): StartingMap {
  const eco = settings.powerMode === "eco";
  // 000-plan-3：每类启用引擎；旧 eco_big 做前端兼容回退（Rust 侧同样回退映射，双保险）
  const ecoTts =
    settings.ecoTts ||
    (eco && settings.ecoBig === "qwen3"
      ? "qwen3"
      : eco && settings.ecoBig === "cosyvoice"
        ? "cosyvoice-clone"
        : "");
  const ecoAsr =
    settings.ecoAsr || (eco && settings.ecoBig === "sensevoice-original" ? "sensevoice-original" : "");
  const shouldStart = (s: string) => {
    if (!eco) return true; // 全能全开
    if (s === "qwen3") return ecoTts === "qwen3";
    if (s === "cosyvoice") return ecoTts === "cosyvoice-clone";
    if (s === "sensevoice-original") return ecoAsr === "sensevoice-original";
    return true; // 9528 内轻量/LLM：无独立进程，恒可用
  };
  // 032 修复：冷启动（启动中…）的前提是「模型文件+环境已就绪（state=ready/running），只差服务进程」；
  // 未下载/缺环境的引擎显示「未就绪」，不再无限转圈、误导以为在自动装模型。
  const fileReady = (engine: string) =>
    health?.models?.some((m) => m.engine === engine && (m.state === "ready" || m.state === "running")) ?? false;
  return {
    asr: health == null,
    kokoro: health == null,
    qwen3: shouldStart("qwen3") && health?.tts.qwen3 !== "reachable" && fileReady("qwen3"),
    cosyvoice:
      shouldStart("cosyvoice") && health?.tts.cosyvoice !== "reachable" && fileReady("cosyvoice-clone"),
    sensevoiceOriginal:
      shouldStart("sensevoice-original") &&
      fileReady("sensevoice-original") &&
      !health?.models?.some((m) => m.engine === "sensevoice-original" && m.installed),
    shouldStart,
    ecoDisabled: (s) => eco && !shouldStart(s),
  };
}

// 节能模式下从模型/引擎选择处切换类别启用引擎：更新 ecoTts/ecoAsr → 重启服务（关闭旧引擎进程、启动新选引擎）
export async function switchEcoEngine(
  cat: "tts" | "asr",
  engine: string,
  powerMode: PowerMode = "eco"
): Promise<void> {
  const key = ecoCategoryKey(cat);
  await updateSettings({ powerMode, [key]: engine } as Partial<PersistedSettings>);
  await invoke("start_service_cmd");
}

/** @deprecated 000-plan-3：改用 switchEcoEngine(cat, engine) */
export async function switchEcoBig(key: EcoBig, powerMode: PowerMode = "eco"): Promise<void> {
  await updateSettings({ powerMode, ecoBig: key });
  await invoke("start_service_cmd");
}
