// 下载 Kokoro 中英混合 TTS 模型（sherpa-onnx OfflineTts）到 asr-server/models/tts/kokoro-multi-lang-v1_0/
// 用法：cd asr-server && npm run download-kokoro
//       node download-kokoro.js --mirror <name>   # 指定源（默认 自动 = 官方优先 + 失败/无进展/低速自动切换）
// 模型：kokoro-multi-lang-v1_0（Apache-2.0，中英混合，53 音色 sid 0-52，输出 24kHz）
// 下载源原则（2026-08-31 用户拍板，写进 000/AGENTS/043）：
//   huggingface（官方）优先 → hf-mirror 兜底 → GitHub releases tar 整体兜底；
//   连接 15s 无响应 / 无进展 30s / 低速 <100KB/s 持续 60s → 自动切换下一源；失败立即换源。
import { existsSync, mkdirSync, createWriteStream, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 032 P3：模型落数据目录（env 注入；未设置回退代码目录）
const _DATA = process.env.OPENSOUND_DATA_DIR || __dirname;
const DIR = path.join(_DATA, 'models', 'tts', 'kokoro-multi-lang-v1_0');
const TARBALL = path.join(_DATA, 'models', 'tts', 'kokoro-multi-lang-v1_0.tar.bz2');
const HF_REPO = 'csukuangfj/kokoro-multi-lang-v1_0';
const HF_API = 'https://hf-mirror.com/api/models/' + HF_REPO;
// 可用源（2026-08-31 结构化）：官方 huggingface 优先，hf-mirror 兜底
const MIRRORS = {
  huggingface: 'https://huggingface.co/' + HF_REPO + '/resolve/main',
  'hf-mirror': 'https://hf-mirror.com/' + HF_REPO + '/resolve/main',
};
const GH_TAR = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2';
// 下载源原则参数：连接超时 15s；无进展 30s；低速 <100KB/s 持续 60s
const CONNECT_TIMEOUT = 15_000;
const NO_PROGRESS_MS = 30_000;
const SLOW_LIMIT = 100 * 1024;   // <100KB/s
const SLOW_WINDOW = 60;          // 持续 60s
// 033 修复：REQUIRED 必须覆盖就绪清单（engines/kokoro.json）全部项——曾漏掉 phone-zh.fst 与 dict/，
// 导致"完成短路"永远触发、这两项永不下载、模型页永远显示缺文件。
const REQUIRED = ['model.onnx', 'voices.bin', 'tokens.txt', 'espeak-ng-data', 'lexicon-us-en.txt', 'lexicon-zh.txt', 'date-zh.fst', 'number-zh.fst', 'phone-zh.fst', 'dict'];
// 032 修复：期望字节数（与 engines/kokoro.json checks 一致）——下载中断会留"存在但损坏"文件，
// 只查存在会被跳过（导致 sherpa 加载崩溃）；校验后损坏文件删掉重下。
const EXPECTED = { 'model.onnx': 325630829, 'voices.bin': 27678720, 'tokens.txt': 687, 'lexicon-zh.txt': 2364621, 'date-zh.fst': 59154 };
function sizeOk(rel) {
  const p = path.join(DIR, rel);
  if (!existsSync(p)) return false;
  const bytes = EXPECTED[path.basename(rel)];
  if (bytes == null) return true; // 无期望字节的（子文件/目录）只查存在
  try { return statSync(p).size === bytes; } catch { return false; }
}
// 032 修复：phone-zh.fst 与 dict/ 是就绪清单（engines/kokoro.json）明确要求的，必须下载；
// 此前被 SKIP/过滤掉 → 永远"缺文件/缺目录"、永远点补齐 → 死循环。
// 不需要的文件：仓库根 README/LICENSE/.gitattributes。
const SKIP = ['.gitattributes', 'LICENSE', 'README.md'];

mkdirSync(DIR, { recursive: true });

function log(msg) { console.log('[' + new Date().toLocaleTimeString() + '] ' + msg); }

// 指定源解析：--mirror <name>；未指定 = 自动（官方优先顺序）
const argMirror = (() => {
  const i = process.argv.indexOf('--mirror');
  return i > 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : '';
})();
function mirrorOrder() {
  if (argMirror) {
    if (MIRRORS[argMirror]) return [argMirror];
    log(`⚠️ 未知源 ${argMirror}，回退自动顺序`);
  }
  return Object.keys(MIRRORS); // huggingface → hf-mirror（官方优先）
}
function mirrorUrl(name, rel) {
  return MIRRORS[name] + '/' + rel.split('/').map(encodeURIComponent).join('/');
}

// 带监控的单文件下载：连接 15s / 无进展 30s / 低速 <100KB/s 持续 60s → 抛错（上层换源）
async function fetchWithProgress(url, dest, rel) {
  const res = await fetch(url, { signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + rel);
  const reader = res.body.getReader();
  const ws = createWriteStream(dest);
  let received = 0;
  let lastGrowthAt = Date.now();
  let lastReceived = 0;
  const samples = [];
  let aborted = false;
  const abort = (why) => { aborted = true; try { reader.cancel(); } catch {} try { ws.destroy(); } catch {} log(`⚠️ ${rel} ${why}，切换下一源…`); };
  const timer = setInterval(() => {
    if (aborted) return;
    const now = Date.now();
    samples.push({ t: now, bytes: received });
    while (samples.length && now - samples[0].t > SLOW_WINDOW * 1000) samples.shift();
    if (received > lastReceived) { lastReceived = received; lastGrowthAt = now; }
    else if (now - lastGrowthAt > NO_PROGRESS_MS) { abort(`无进展 ${NO_PROGRESS_MS / 1000}s（${(received / 1024).toFixed(0)}KB 停滞）`); return; }
    if (samples.length >= 2 && now - samples[0].t >= SLOW_WINDOW * 1000) {
      const avg = (received - samples[0].bytes) / (SLOW_WINDOW);
      if (avg < SLOW_LIMIT) { abort(`低速 <100KB/s 持续 ${SLOW_WINDOW}s（实际 ${(avg / 1024).toFixed(0)}KB/s）`); return; }
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

async function downloadFile(rel, dest) {
  // 032：已存在但大小不符 → 视为损坏，删掉重下（此前会跳过 → 永远修不好）
  if (existsSync(dest)) {
    const bytes = EXPECTED[path.basename(rel)];
    if (bytes != null) {
      try {
        if (statSync(dest).size === bytes) { console.log('已存在且完整，跳过:', rel); return; }
        console.log('⚠️ ' + path.basename(rel) + ' 大小不符（' + statSync(dest).size + '≠' + bytes + '），删除重下');
        rmSync(dest, { force: true });
      } catch { rmSync(dest, { force: true }); }
    } else {
      console.log('已存在，跳过:', rel);
      return;
    }
  }
  // 多源顺序下载（官方优先 → hf-mirror）：失败/无进展/低速自动切换；429 退避重试
  const order = mirrorOrder();
  const lastErr = [];
  for (let attempt = 0; attempt < 2; attempt++) { // 整体两轮（429 限流退避后重试一轮）
    for (const name of order) {
      mkdirSync(path.dirname(dest), { recursive: true });
      const url = mirrorUrl(name, rel);
      try {
        log(`下载 ${rel} ← ${name}${argMirror === name ? '（用户指定）' : ''} …`);
        await fetchWithProgress(url, dest, rel);
        return; // 成功
      } catch (e) {
        lastErr.push(name + ': ' + e.message.split('\n')[0]);
        rmSync(dest, { force: true });
        log(`⚠️ 源 ${name} 失败（${e.message.split('\n')[0]}），切换下一源…`);
        if (/HTTP 429/.test(e.message)) await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      }
    }
  }
  throw new Error('全部源失败: ' + rel + '（' + lastErr.join('；') + '）');
}

async function fetchFileList() {
  // hf-mirror API 偶发 429 限流：退避重试
  let lastErr;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(HF_API, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('HF API HTTP ' + res.status);
      const data = await res.json();
      return (data.siblings || []).map(f => f.rfilename).filter(f => !SKIP.includes(f));
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
  throw lastErr;
}

async function downloadFromHf() {
  log('获取文件清单（hf-mirror API ' + HF_REPO + '）…');
  const files = await fetchFileList();
  const order = mirrorOrder().join(' → ');
  log(`共 ${files.length} 个文件，源顺序：${order}（自动切换：失败立即换 / 无进展 30s / 低速 60s）`);
  const CONCURRENCY = 1;
  const queue = [...files];
  let done = 0;
  const failed = [];
  async function worker() {
    while (queue.length) {
      const rel = queue.shift();
      const dest = path.join(DIR, rel);
      try {
        await downloadFile(rel, dest);
      } catch (e) {
        rmSync(dest, { force: true });
        failed.push(rel + '（' + e.message.split('\n')[0] + '）');
      }
      done++;
      process.stdout.write('\r完成 ' + done + '/' + files.length + (failed.length ? '，跳过 ' + failed.length : ''));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()));
  process.stdout.write('\n');
  if (failed.length) {
    log('⚠️ ' + failed.length + ' 个文件下载失败（跳过）：\n  ' + failed.slice(0, 10).join('\n  '));
  }
}

function done() {
  console.log('✅ Kokoro 模型就绪：' + DIR);
  console.log('   npm start 后 POST /speak?engine=kokoro 即可本地朗读（默认音色 sid 18，中文可试 48-52）');
}

if (REQUIRED.every(sizeOk)) { done(); process.exit(0); }

// 主路径：多源顺序下载（官方优先 → hf-mirror），自动切换
try {
  await downloadFromHf();
  const missing = REQUIRED.filter(f => !sizeOk(f));
  if (missing.length) throw new Error('缺少文件: ' + missing.join(', '));
  done();
  process.exit(0);
} catch (e) {
  // ⚠️ 不清空已下载目录：部分文件可能已成功（如 espeak-ng-data），保留以便手动补缺失文件
  log('❌ 多源下载失败：' + e.message.split('\n')[0]);
  log('   已下载文件保留在 ' + DIR + '，缺失文件可手动下载补上（见下方回退说明）。');
}

// 兜底：GitHub releases tar.bz2（较慢）
log('回退 GitHub releases 下载 tar.bz2 …');
try {
  execSync(`curl -L --fail --connect-timeout 15 --max-time 3600 -C - -o "${TARBALL}" "${GH_TAR}"`, { stdio: 'inherit', maxBuffer: 1024 * 1024 * 10 });
  execSync(`tar xjf "${TARBALL}" -C "${path.dirname(DIR)}"`, { stdio: 'inherit' });
  rmSync(TARBALL, { force: true });
  const missing = REQUIRED.filter(f => !sizeOk(f));
  if (missing.length) throw new Error('缺少文件: ' + missing.join(', '));
  done();
  process.exit(0);
} catch (e) {
  // 保留已下载文件（不清空），缺失部分手动补
  rmSync(TARBALL, { force: true });
  const missing = REQUIRED.filter(f => !sizeOk(f));
  console.error('所有下载源均失败。当前 ' + DIR + ' 中已有 ' + (REQUIRED.length - missing.length) + '/' + REQUIRED.length + ' 个关键文件。');
  console.error('可手动下载 tar 补全（GitHub 或 HuggingFace）：');
  console.error('  curl -L -o /tmp/kokoro.tar.bz2 "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2"');
  console.error('  # 或 HuggingFace 整个仓库 zip: https://huggingface.co/csukuangfj/kokoro-multi-lang-v1_0/archive/main.zip');
  console.error('  tar xjf /tmp/kokoro.tar.bz2 -C "' + path.dirname(DIR) + '"');
  console.error('  仅缺单文件时：curl -L -o "' + path.join(DIR, 'model.onnx') + '" "https://hf-mirror.com/' + HF_REPO + '/resolve/main/model.onnx"');
  process.exit(1);
}
