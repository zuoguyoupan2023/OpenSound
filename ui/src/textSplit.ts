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
