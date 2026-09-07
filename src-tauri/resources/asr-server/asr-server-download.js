// 下载 SenseVoice 模型（sherpa-onnx，中文最优）到 asr-server/models/sensevoice/
// 用法：cd asr-server && npm run download-sensevoice
//       node asr-server-download.js --mirror <name>   # 指定源（默认 自动 = 官方优先 + 失败/无进展/低速自动切换）
// 下载源原则（2026-08-31 用户拍板，写进 000/AGENTS/043）：
//   huggingface（官方）优先 → hf-mirror 兜底；失败立即换源；无进展 30s / 低速 <100KB/s 持续 60s 自动切换。
import { existsSync, mkdirSync, createWriteStream, rmSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 032 P3：模型落数据目录（env 注入；未设置回退代码目录）
const DIR = path.join(process.env.OPENSOUND_DATA_DIR || __dirname, 'models', 'sensevoice');
mkdirSync(DIR, { recursive: true });

// 期望字节：单一数据源 = engines/sensevoice.json 的 checks（与就绪校验一致，避免硬编码漂移）
// 2026-08-31：存在但大小不符的损坏文件删除重下（此前只看存在 → 中断留坏文件 → 永远"已存在跳过"）
const EXPECTED_BYTES = (() => {
  try {
    const mf = JSON.parse(readFileSync(path.join(__dirname, 'engines', 'sensevoice.json'), 'utf8'));
    const map = {};
    for (const c of mf.checks || []) {
      if (c.type === 'file' && c.bytes) map[path.basename(c.path)] = c.bytes;
    }
    return map;
  } catch { return {}; }
})();

const HF_REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
// 可用源（2026-08-31 结构化）：官方 huggingface 优先，hf-mirror 兜底
const MIRRORS = {
  huggingface: 'https://huggingface.co/' + HF_REPO + '/resolve/main',
  'hf-mirror': 'https://hf-mirror.com/' + HF_REPO + '/resolve/main',
};
// 下载源原则参数：无进展 30s；低速 <100KB/s 持续 60s
const NO_PROGRESS_MS = 30_000;
const SLOW_LIMIT = 100 * 1024;
const SLOW_WINDOW = 60;
const FILES = ['model.int8.onnx', 'tokens.txt'];

// 指定源解析：--mirror <name>；未指定 = 自动（官方优先顺序）
const argMirror = (() => {
  const i = process.argv.indexOf('--mirror');
  return i > 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : '';
})();
function mirrorOrder() {
  if (argMirror) {
    if (MIRRORS[argMirror]) return [argMirror];
    console.log(`⚠️ 未知源 ${argMirror}，回退自动顺序`);
  }
  return Object.keys(MIRRORS); // huggingface → hf-mirror（官方优先）
}

// 带监控的单文件下载：无进展 30s / 低速 <100KB/s 持续 60s → 抛错（上层换源）
async function fetchWithProgress(url, dest, file) {
  const res = await fetch(url, { signal: AbortSignal.timeout(600000) }); // fetch 自动跟随重定向
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + file);
  const reader = res.body.getReader();
  const ws = createWriteStream(dest);
  let received = 0;
  let lastGrowthAt = Date.now();
  let lastReceived = 0;
  const samples = [];
  let aborted = false;
  const abort = (why) => { aborted = true; try { reader.cancel(); } catch {} try { ws.destroy(); } catch {} console.log(`⚠️ ${file} ${why}，切换下一源…`); };
  const timer = setInterval(() => {
    if (aborted) return;
    const now = Date.now();
    samples.push({ t: now, bytes: received });
    while (samples.length && now - samples[0].t > SLOW_WINDOW * 1000) samples.shift();
    if (received > lastReceived) { lastReceived = received; lastGrowthAt = now; }
    else if (now - lastGrowthAt > NO_PROGRESS_MS) { abort(`无进展 ${NO_PROGRESS_MS / 1000}s`); return; }
    if (samples.length >= 2 && now - samples[0].t >= SLOW_WINDOW * 1000) {
      const avg = (received - samples[0].bytes) / SLOW_WINDOW;
      if (avg < SLOW_LIMIT) { abort(`低速 <100KB/s 持续 ${SLOW_WINDOW}s`); return; }
    }
  }, 1000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (aborted) throw new Error('已中止（源不可用）');
      received += value.length;
      if (!ws.write(Buffer.from(value))) await new Promise((r) => ws.once('drain', r));
    }
    ws.end();
  } finally {
    clearInterval(timer);
  }
}

// 2026-09-05 智能换源（同 kokoro 判死逻辑）：本 run 内某源失败一次即判死，后续文件直接走剩余健康源，
// 不再逐文件先白等官方源超时（官方源整体不可达时每个文件都 ~10s 试错）。
const deadSources = new Set();
let deadInfoShown = false;

for (const file of FILES) {
  const dest = path.join(DIR, file);
  if (existsSync(dest)) {
    const expect = EXPECTED_BYTES[file];
    if (expect) {
      try {
        if (statSync(dest).size === expect) { console.log('已存在且完整，跳过:', file); continue; }
        console.log(`⚠️ ${file} 存在但大小不符（期望 ${expect} / 实际 ${statSync(dest).size}），删除重下`);
        rmSync(dest, { force: true });
      } catch { rmSync(dest, { force: true }); }
    } else {
      console.log('已存在，跳过:', file);
      continue;
    }
  }
  const order = mirrorOrder();
  let ok = false;
  const cands = order.filter((name) => !deadSources.has(name));
  if (!cands.length && !deadSources.size) cands.push(order[0]); // 空守卫（正常不会发生）
  for (const name of cands) {
    const url = MIRRORS[name] + '/' + file;
    console.log(`下载 ${file} ← ${name}${argMirror === name ? '（用户指定）' : ''} …`);
    try {
      await fetchWithProgress(url, dest, file);
      ok = true;
      break;
    } catch (e) {
      rmSync(dest, { force: true });
      deadSources.add(name);
      if (!deadInfoShown) {
        deadInfoShown = true;
        console.log(`⚡ 源 ${name} 判死（${e.message.split('\n')[0]}）——本 run 剩余文件自动跳过该源（重新安装恢复官方优先）`);
      } else {
        console.log(`⚠️ 源 ${name} 失败（${e.message.split('\n')[0]}）→ 判死，本 run 不再尝试`);
      }
    }
  }
  if (!ok) throw new Error('全部源失败: ' + file);
  console.log('完成:', file);
}
console.log('✅ SenseVoice 模型就绪：' + DIR);
