// 朗读文本分批（060 P1）：先把文本按句标点/换行切成"单位"，再按 ≤maxChars 分组成批。
// - 边界尽量落在句子/换行之后，避免在句中截断；
// - 保留每个批次在原文中的字符区间（start/end），供进度显示与断点续读定位；
// - 单句（无标点的超长单位）超过上限时按 maxChars 硬切（与服务端 150 字兜底逻辑一致）。
// 服务端 /speak 本身还会再按句切分 ≤150 字的帧；本模块只决定"一次请求送多少字"。

export interface TextBatch {
  start: number;
  end: number;
  text: string;
}

interface Unit {
  start: number;
  end: number;
}

export function splitTextBatches(full: string, maxChars: number): TextBatch[] {
  if (!full.trim()) return [];
  const m = Math.max(1, Math.floor(maxChars));

  // 句标点/换行视为自然边界（含标点本身，保证原文可无损拼回）
  const units: Unit[] = [];
  const seps = /[。！？；…!?;\n]+/g;
  let cur = 0;
  let mm: RegExpExecArray | null;
  while ((mm = seps.exec(full))) {
    const uEnd = mm.index + mm[0].length;
    if (uEnd > cur) units.push({ start: cur, end: uEnd });
    cur = uEnd;
  }
  if (cur < full.length) units.push({ start: cur, end: full.length });

  const batches: TextBatch[] = [];
  let i = 0;
  while (i < units.length) {
    const u = units[i];
    const uLen = u.end - u.start;

    // 单个自然段（无标点可切）就超过上限 → 先清掉已累积批次，再硬切成多批
    if (uLen > m) {
      let s = u.start;
      while (u.end - s > m) {
        batches.push({ start: s, end: s + m, text: full.slice(s, s + m) });
        s += m;
      }
      if (u.end > s) {
        batches.push({ start: s, end: u.end, text: full.slice(s, u.end) });
      }
      i++;
      continue;
    }

    // 贪心累积多个自然单位，直到再加一个就超上限
    let j = i;
    let len = 0;
    while (j < units.length) {
      const uj = units[j];
      const l = uj.end - uj.start;
      if (l > m) break; // 下一个单位超限，留待外层处理
      if (len + l > m) break;
      len += l;
      j++;
    }
    if (j === i) j = i + 1; // 防御：单单位 ≤ m 时至少进一个

    const start = units[i].start;
    const end = units[j - 1].end;
    batches.push({ start, end, text: full.slice(start, end) });
    i = j;
  }
  return batches;
}

/** 文本指纹：长度 + 首 30 字符，用于"断点只在文本未变时可用"的轻量校验 */
export function textFingerprint(text: string): string {
  const head = text.slice(0, 30).replace(/\s+/g, " ");
  return `${text.length}:${head}`;
}

// ---------- 字数统计（060：中文按字、英文按词，分开计，可混合） ----------

export interface TextCounts {
  /** 中文字符数（汉字 + 中文标点等 CJK 单字符） */
  cjk: number;
  /** 英文/数字等连续字母数字词数（含撇号如 don't） */
  words: number;
  /** 计量单位合计 = cjk + words（朗读进度按它算） */
  total: number;
}

function isCjkCode(cp: number): boolean {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // 基本区
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意
    (cp >= 0x20000 && cp <= 0x2a6df) || // 扩展 B
    (cp >= 0x2a700 && cp <= 0x2ebef) || // 扩展 C–F
    (cp >= 0x3000 && cp <= 0x303f) || // 中文标点/符号（。，、；：？！…）
    cp === 0xff01 || cp === 0xff0c || cp === 0xff1b || cp === 0xff1a || cp === 0xff1f || // 全角 !,：；
    (cp >= 0xff5f && cp <= 0xff60) // 全角括号
  );
}

const WORD_RE = /[A-Za-z0-9]+(?:['’][A-Za-z0-9]+)*/g;

export function countTextStats(text: string): TextCounts {
  let cjk = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCjkCode(cp)) cjk++;
  }
  const words = (text.match(WORD_RE) || []).length;
  return { cjk, words, total: cjk + words };
}

/** 展示文案：如「中文 12 字 · 英文 3 词（合计 15）」 */
export function textCountLabel(c: TextCounts): string {
  const parts: string[] = [];
  if (c.cjk) parts.push(`中文 ${c.cjk} 字`);
  if (c.words) parts.push(`英文 ${c.words} 词`);
  if (!parts.length) return "0 字";
  return `${parts.join(" · ")}（合计 ${c.total}）`;
}
