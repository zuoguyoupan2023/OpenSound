// 音色管理前端封装 —— 调用 asr-server(9528) 的克隆 REST 接口（后端 CosyVoice3 真实生成）
import { invoke } from "@tauri-apps/api/core";
import { listAudio, type AudioRecord } from "./audioStore";
import { getBaseUrl, getToken } from "./api";

export interface CloneVoice {
  id: string; // = 后端 voiceId
  name: string;
  sourceRecordId: string; // 参考录音样本 id（音频库录音）
  referenceText: string; // 参考提示文本
  created_at: number;
  engine: "cosyvoice";
}

function authHeaders(init?: RequestInit): RequestInit {
  const token = getToken();
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return { ...init, headers };
}

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

// 把后端 voiceId 映射为前端 CloneVoice
function mapVoice(v: { voiceId: string } & Partial<CloneVoice>): CloneVoice {
  return {
    id: v.voiceId,
    name: v.name || "未命名音色",
    sourceRecordId: v.sourceRecordId || "",
    referenceText: v.referenceText || "",
    created_at: v.created_at || Date.now(),
    engine: "cosyvoice",
  };
}

export async function listVoices(): Promise<CloneVoice[]> {
  const r = await jfetch<{ voices: any[] }>("/voices");
  return (r.voices || []).map(mapVoice);
}

// 新建音色的候选样本：音频库里所有录音（已标记 🎨 作样本的排前面）
export async function listSampleCandidates(): Promise<AudioRecord[]> {
  const all = await listAudio();
  return all
    .filter((r) => r.kind === "recording")
    .sort(
      (a, b) =>
        Number(b.is_clone_sample) - Number(a.is_clone_sample) ||
        b.created_at - a.created_at
    );
}

// 把音频库录音读成 base64（真实参考音频，供 /clone）。
// 用 Tauri 原生命令读文件，避开 WKWebView 里 fetch(asset URL)/FileReader 不支持的问题。
async function recordToBase64(rec: AudioRecord): Promise<string> {
  return invoke<string>("audio_read_base64", { id: rec.id });
}

// 生成克隆音色（真实后端：POST /clone；参考音频 + 提示文本 → CosyVoice 生成）
export async function createVoice(opts: {
  name: string;
  sourceRecordId: string;
  referenceText: string;
  onProgress?: (p: { stage: string; pct: number }) => void;
}): Promise<CloneVoice> {
  const all = await listAudio();
  const rec = all.find((r) => r.id === opts.sourceRecordId);
  if (!rec) throw new Error("找不到参考录音样本（可能已删除）");

  const step = (stage: string, pct: number) => opts.onProgress?.({ stage, pct });
  step("准备参考音频…", 20);
  const wavBase64 = await recordToBase64(rec);

  step("载入克隆引擎（CosyVoice）并提取音色…", 60);
  const v = await jfetch<{
    voiceId: string;
    name: string;
    referenceText: string;
    created_at: number;
  }>("/clone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: opts.name || "我的克隆音色",
      referenceText: opts.referenceText || "",
      wavBase64,
    }),
  });
  step("完成", 100);
  return mapVoice(v);
}

export async function renameVoice(id: string, name: string): Promise<void> {
  await jfetch("/voice/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voiceId: id, name }),
  });
}

export async function deleteVoice(id: string): Promise<void> {
  await jfetch("/voice/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voiceId: id }),
  });
}

// 试听：优先取生成音色时预生成的 preview.wav（直接播放，秒开）。
// 返回标准 WAV 的 blob URL；若该音色无预览音频返回 null（调用方回退到现场合成）。
export async function previewVoiceUrl(voice: CloneVoice): Promise<string | null> {
  try {
    const res = await fetch(
      `${getBaseUrl()}/voice-preview?voiceId=${encodeURIComponent(voice.id)}`,
      authHeaders()
    );
    if (!res.ok) return null; // 无预览 → 回退现场合成
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}
