// 音色管理前端封装
// GUI 先行阶段：本地 localStorage 模拟，便于先做出「音色管理」面板；
// 后端 CosyVoice 接入后，把 createVoice/previewVoiceUrl 换成调用 asr-server /clone 即可。
import { listAudio, audioAssetUrl, type AudioRecord } from "./audioStore";

export interface CloneVoice {
  id: string;
  name: string;
  sourceRecordId: string; // 参考录音样本 id（音频库录音）
  referenceText: string; // 参考提示文本
  created_at: number;
  engine: "cosyvoice" | "mock"; // 当前 mock；接入后端后为 cosyvoice
}

const LS_KEY = "tabu_clone_voices_v1";

let cache: CloneVoice[] | null = null;

function load(): CloneVoice[] {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(LS_KEY) || "[]") as CloneVoice[];
  } catch {
    cache = [];
  }
  return cache!;
}

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cache ?? []));
  } catch (e) {
    console.error("保存音色失败:", e);
  }
}

export function listVoices(): CloneVoice[] {
  return [...load()].sort((a, b) => b.created_at - a.created_at);
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

// 生成克隆音色（GUI 先行：模拟进度；后端接入后改为 POST /clone）
export async function createVoice(opts: {
  name: string;
  sourceRecordId: string;
  referenceText: string;
  onProgress?: (p: { stage: string; pct: number }) => void;
}): Promise<CloneVoice> {
  // TODO: 后端接入后替换为 POST /clone（参考音频 + 提示文本 → 生成/更新克隆音色）
  const stages: [string, number][] = [
    ["准备参考音频…", 20],
    ["载入克隆引擎（CosyVoice）…", 45],
    ["提取音色特征…", 70],
    ["生成克隆音色…", 95],
    ["完成", 100],
  ];
  for (const [stage, pct] of stages) {
    opts.onProgress?.({ stage, pct });
    await new Promise((r) => setTimeout(r, 350));
  }
  const voice: CloneVoice = {
    id: "cv_" + Math.random().toString(36).slice(2, 10),
    name: opts.name || "我的克隆音色",
    sourceRecordId: opts.sourceRecordId,
    referenceText: opts.referenceText,
    created_at: Date.now(),
    engine: "mock",
  };
  load().push(voice);
  persist();
  return voice;
}

export function renameVoice(id: string, name: string): void {
  const v = load().find((x) => x.id === id);
  if (v) {
    v.name = name;
    persist();
  }
}

export function deleteVoice(id: string): void {
  const arr = load();
  const i = arr.findIndex((x) => x.id === id);
  if (i >= 0) {
    arr.splice(i, 1);
    persist();
  }
}

// 试听：当前阶段播放参考样本录音（真实克隆音色需后端接入）
export async function previewVoiceUrl(voice: CloneVoice): Promise<string | null> {
  try {
    const all = await listAudio();
    const rec = all.find((r) => r.id === voice.sourceRecordId);
    if (!rec) return null;
    return await audioAssetUrl(rec);
  } catch {
    return null;
  }
}
