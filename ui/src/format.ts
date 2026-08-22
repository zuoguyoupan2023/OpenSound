// 共用格式化小工具（音频库 / 朗读历史等处复用）

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDur(sec: number): string {
  if (!sec || sec < 0) return "";
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}m${Math.round(sec % 60)}s`;
}

export function truncate(s: string, n = 40): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// TTS 参数快照的展示文案（音色 / 语速），无则返回空串
export function voiceDesc(rec: { voice?: string; sid?: number; speed?: number }): string {
  const v = rec.voice || (rec.sid ?? 0) > 0 ? rec.voice || `sid ${rec.sid}` : "";
  const sp = rec.speed && rec.speed !== 1 ? `${rec.speed.toFixed(1)}x` : "";
  return [v, sp].filter(Boolean).join(" · ");
}
