// 下载 Kokoro 中英混合 TTS 模型（sherpa-onnx OfflineTts）到 asr-server/models/tts/kokoro-multi-lang-v1_0/
// 用法：cd asr-server && npm run download-kokoro
// 模型：kokoro-multi-lang-v1_0（Apache-2.0，中英混合，53 音色 sid 0-52，输出 24kHz）
// 源：hf-mirror（国内可达，实测 ~3MB/s）逐文件并发下载；GitHub releases tar 作为完全兜底
import { existsSync, mkdirSync, createWriteStream, rmSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, 'models', 'tts', 'kokoro-multi-lang-v1_0');
const TARBALL = path.join(__dirname, 'models', 'tts', 'kokoro-multi-lang-v1_0.tar.bz2');
const HF_REPO = 'csukuangfj/kokoro-multi-lang-v1_0';
const HF_API = 'https://hf-mirror.com/api/models/' + HF_REPO;
const HF_BASE = 'https://hf-mirror.com/' + HF_REPO + '/resolve/main';
const GH_TAR = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2';
const REQUIRED = ['model.onnx', 'voices.bin', 'tokens.txt', 'espeak-ng-data', 'lexicon-us-en.txt', 'lexicon-zh.txt', 'date-zh.fst', 'number-zh.fst'];
// 不需要的文件：README/LICENSE/.gitattributes；dict/ 是 jieba 词库（Kokoro 用 espeak-ng 音素，不需要）
const SKIP = ['.gitattributes', 'LICENSE', 'README.md', 'phone-zh.fst'];

mkdirSync(DIR, { recursive: true });

function log(msg) { console.log('[' + new Date().toLocaleTimeString() + '] ' + msg); }

async function downloadFile(rel, dest) {
  const url = HF_BASE + '/' + rel.split('/').map(encodeURIComponent).join('/');
  // espeak-ng-data 含子目录（lang/ voices/!v/ 等），写入前先确保父目录存在
  mkdirSync(path.dirname(dest), { recursive: true });
  // 429（hf-mirror 限流）等待更久重试；其他错误短退避重试
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(600000) });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + rel);
      await pipeline(res.body, createWriteStream(dest));
      return;
    } catch (e) {
      lastErr = e;
      rmSync(dest, { force: true });
      const wait = /HTTP 429/.test(e.message) ? attempt * 3000 : attempt * 800;
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function fetchFileList() {
  // hf-mirror API 偶发 429 限流：退避重试
  let lastErr;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(HF_API, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('HF API HTTP ' + res.status);
      const data = await res.json();
      return (data.siblings || []).map(f => f.rfilename).filter(f => !SKIP.includes(f) && !f.startsWith('dict/'));
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
  throw lastErr;
}

async function downloadFromHfMirror() {
  log('获取文件清单（hf-mirror ' + HF_REPO + '）…');
  const files = await fetchFileList();
  log('共 ' + files.length + ' 个文件，开始下载（并发 1，hf-mirror 限流严格，慢但稳）');
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

if (existsSync(path.join(DIR, 'model.onnx'))) { done(); process.exit(0); }

// 主路径：hf-mirror 逐文件并发下载
try {
  await downloadFromHfMirror();
  const missing = REQUIRED.filter(f => !existsSync(path.join(DIR, f)));
  if (missing.length) throw new Error('缺少文件: ' + missing.join(', '));
  done();
  process.exit(0);
} catch (e) {
  // ⚠️ 不清空已下载目录：部分文件可能已成功（如 espeak-ng-data），保留以便手动补缺失文件
  log('❌ hf-mirror 下载失败：' + e.message.split('\n')[0]);
  log('   已下载文件保留在 ' + DIR + '，缺失文件可手动下载补上（见下方回退说明）。');
}

// 兜底：GitHub releases tar.bz2（较慢）
log('回退 GitHub releases 下载 tar.bz2 …');
try {
  execSync(`curl -L --fail --connect-timeout 15 --max-time 3600 -C - -o "${TARBALL}" "${GH_TAR}"`, { stdio: 'inherit', maxBuffer: 1024 * 1024 * 10 });
  execSync(`tar xjf "${TARBALL}" -C "${path.dirname(DIR)}"`, { stdio: 'inherit' });
  rmSync(TARBALL, { force: true });
  const missing = REQUIRED.filter(f => !existsSync(path.join(DIR, f)));
  if (missing.length) throw new Error('缺少文件: ' + missing.join(', '));
  done();
  process.exit(0);
} catch (e) {
  // 保留已下载文件（不清空），缺失部分手动补
  rmSync(TARBALL, { force: true });
  const missing = REQUIRED.filter(f => !existsSync(path.join(DIR, f)));
  console.error('所有下载源均失败。当前 ' + DIR + ' 中已有 ' + (REQUIRED.length - missing.length) + '/' + REQUIRED.length + ' 个关键文件。');
  console.error('可手动下载 tar 补全（GitHub 或 HuggingFace）：');
  console.error('  curl -L -o /tmp/kokoro.tar.bz2 "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2"');
  console.error('  # 或 HuggingFace 整个仓库 zip: https://huggingface.co/csukuangfj/kokoro-multi-lang-v1_0/archive/main.zip');
  console.error('  tar xjf /tmp/kokoro.tar.bz2 -C "' + path.dirname(DIR) + '"');
  console.error('  仅缺单文件时：curl -L -o "' + path.join(DIR, 'model.onnx') + '" "https://hf-mirror.com/' + HF_REPO + '/resolve/main/model.onnx"');
  process.exit(1);
}
