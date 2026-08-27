// ========== TabU 本地语音识别服务（asr-server） ==========
// 在电脑本地跑模型（隐私优先、中文友好），侧边栏通过 HTTP 调用。
// 引擎：
//   ① Whisper（transformers.js node 版 / onnxruntime-node，q8 量化）— 多语言兜底
//   ② SenseVoice（sherpa-onnx 原生，中文/粤/日/韩最优）— 可选，需安装 sherpa-onnx 并下载模型
//
// 启动：cd asr-server && npm install && node asr-server.js [--port 9528]
// 接口：
//   POST /transcribe?engine=whisper|sensevoice   body = WAV/RAW PCM 音频 → { text, engine }
//   POST /speak?engine=kokoro|qwen3             body = JSON { text, sid, speed, voice, language } → 帧流（octet-stream，每帧=4字节大端长度+WAV，逐句流式）
//   GET  /models → { models: [{category, engine, label, size, installed}] }
//   POST /install-model?engine=kokoro|sensevoice|llm|qwen3|whisper → NDJSON 安装进度
//   GET  /health → { ok: true, engines: [...], tts: {...}, models: [...] }
//
// 模型默认从 hf-mirror 下载（国内可达）；可用 --model-size 指定 whisper 大小（tiny/base/small）。

import http from 'node:http';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeviceProfile } from './device-profile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parsePort(process.argv);
const MODEL_SIZE = process.env.ASR_MODEL_SIZE || 'base'; // tiny | base | small | medium（whisper 兜底档位）
const ASR_ENGINE = (process.env.ASR_ENGINE || 'auto').toLowerCase(); // auto | sensevoice | whisper —— 选择默认识别模型
// asr-server 架构版本：2.x = 含 sensevoice-original + VAD + 标点。
// 供 start-all.js 探测时判断 9528 上是否旧进程（旧代码无此字段/不同版本 → 视为残留，终止后重启）。
const SERVER_VERSION = '2.6.0'; // 2.4.0 = S4：cosyvoice-clone 全自举链；2.5.0 = S5：缺失权重自动下载；2.6.0 = S7：安全加固（仅本机回环 + 入站鉴权）
// 安全加固（S7）：入站鉴权 token —— Tauri 宿主注入；为空（手动 npm start 调试）时不校验
const TABU_TOKEN = process.env.TABU_TOKEN || '';
const WHISPER_MODEL = `onnx-community/whisper-${MODEL_SIZE}`;

// 模型缓存目录
const CACHE_DIR = path.join(__dirname, 'models');
mkdirSync(CACHE_DIR, { recursive: true });

const SENSEVOICE_MODEL = path.join(CACHE_DIR, 'sensevoice/model.int8.onnx');
const SENSEVOICE_TOKENS = path.join(CACHE_DIR, 'sensevoice/tokens.txt');
// SenseVoice 原始版（funasr 独立 Python 服务）：/opt/homebrew/bin/python3 sensevoice-server.py --port 8002
const SENSEVOICE_ORIGINAL_URL = (process.env.SENSEVOICE_ORIGINAL_URL || 'http://127.0.0.1:8002').replace(/\/+$/, '');
// 识别后自动加标点（默认开，用 funasr 后端 /punc）；可用 PUNCTUATION=0 关闭，或用请求参数 ?punct=1|0 覆盖
const PUNCTUATION = !['0', 'false', 'no'].includes(String(process.env.PUNCTUATION || '1').toLowerCase());
// 识别前用 VAD 过滤静音（默认开）；可用 VAD=0 关闭，或用请求参数 ?vad=1|0 覆盖
const VAD = !['0', 'false', 'no'].includes(String(process.env.VAD || '1').toLowerCase());

// ---------- TTS ----------
// Qwen3-TTS 转发地址（本地 Python 服务，npm run start-qwen3 启动）；可换 mlx-tts-server / vllm 等 OpenAI 兼容服务
const QWEN3_TTS_URL = (process.env.QWEN3_TTS_URL || 'http://127.0.0.1:8001').replace(/\/+$/, '');
// CosyVoice3 本地克隆服务（cosyvoice-tts-server.py，独立进程 8003）
const COSYVOICE_URL = (process.env.COSYVOICE_URL || 'http://127.0.0.1:8003').replace(/\/+$/, '');
// 克隆音色存储目录（与 cosyvoice-tts-server.py --voice-dir 一致）
const COSYVOICE_VOICE_DIR = path.join(__dirname, 'data', 'clone-voices');
mkdirSync(COSYVOICE_VOICE_DIR, { recursive: true });
const KOKORO_DIR = path.join(CACHE_DIR, 'tts', 'kokoro-multi-lang-v1_0');
const KOKORO = {
  model: path.join(KOKORO_DIR, 'model.onnx'),
  voices: path.join(KOKORO_DIR, 'voices.bin'),
  tokens: path.join(KOKORO_DIR, 'tokens.txt'),
  dataDir: path.join(KOKORO_DIR, 'espeak-ng-data'),
  // ⚠️ 必须是绝对路径：sherpa-onnx 从进程 cwd 解析 lexicon（而非模型目录）
  lexicon: path.join(KOKORO_DIR, 'lexicon-us-en.txt') + ',' + path.join(KOKORO_DIR, 'lexicon-zh.txt')
};
function kokoroReady() {
  return existsSync(KOKORO.model) && existsSync(KOKORO.voices) && existsSync(KOKORO.tokens) && existsSync(KOKORO.dataDir);
}

function parsePort(argv) {
  const i = argv.indexOf('--port');
  return i > -1 ? parseInt(argv[i + 1], 10) : 9528;
}

// ---------- 工具 ----------
function log(msg) {
  console.log('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

// WAV/RAW → 16kHz 单声道 Float32Array
function decodeToPcm16(buffer) {
  // 判断是否 WAV（RIFF 头）
  if (buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') {
    return decodeWav(buffer);
  }
  // 否则按 16kHz 16-bit PCM 处理
  const n = Math.floor(buffer.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buffer.readInt16LE(i * 2) / 32768;
  return out;
}

function decodeWav(buf) {
  let off = 12; // 跳过 RIFF/WAVE
  let fmt = null;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22)
      };
    } else if (id === 'data') {
      const data = buf.subarray(off + 8, off + 8 + size);
      const samples = fmt.bits === 16
        ? pcm16ToFloat(data, fmt.channels)
        : pcm8ToFloat(data, fmt.channels);
      return resampleTo16kMono(samples, fmt.sampleRate, fmt.channels);
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV 解析失败');
}

function pcm16ToFloat(data, channels) {
  const n = Math.floor(data.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}
function pcm8ToFloat(data, channels) {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = (data[i] - 128) / 128;
  return out;
}
function resampleTo16kMono(samples, rate, channels) {
  // 多声道 → 平均
  let mono = samples;
  if (channels > 1) {
    const n = Math.floor(samples.length / channels);
    mono = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < channels; c++) s += samples[i * channels + c];
      mono[i] = s / channels;
    }
  }
  if (rate === 16000) return mono;
  const ratio = rate / 16000;
  const outLen = Math.max(1, Math.floor(mono.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = mono[Math.min(mono.length - 1, Math.floor(i * ratio))];
  return out;
}

// ---------- Whisper（transformers.js node） ----------
let whisperPipe = null;
async function getWhisper() {
  if (whisperPipe) return whisperPipe;
  log('加载 Whisper(' + MODEL_SIZE + ', q8)…（首次会从 hf-mirror 下载模型，较慢）');
  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowRemoteModels = true;
  env.allowLocalModels = true;
  env.remoteHost = 'https://hf-mirror.com/'; // 国内可达
  env.cacheDir = path.join(CACHE_DIR, 'hf');
  const p = await pipeline('automatic-speech-recognition', WHISPER_MODEL, { dtype: 'q8' });
  whisperPipe = p;
  log('Whisper 就绪');
  return p;
}

// ---------- SenseVoice（sherpa-onnx 原生，可选） ----------
let sensevoiceRec = null;
async function getSenseVoice() {
  if (sensevoiceRec) return sensevoiceRec;
  let sherpa;
  try { sherpa = (await import('sherpa-onnx')).default; } catch (e) {
    throw new Error('未安装 sherpa-onnx，请 cd asr-server && npm i sherpa-onnx');
  }
  if (!existsSync(SENSEVOICE_MODEL)) {
    throw new Error('SenseVoice 模型缺失：' + SENSEVOICE_MODEL + '\n请运行 node asr-server-download.js');
  }
  log('加载 SenseVoice（sherpa-onnx 原生）…');
  const rec = sherpa.createOfflineRecognizer({
    modelConfig: { senseVoice: { model: SENSEVOICE_MODEL }, tokens: SENSEVOICE_TOKENS, numThreads: 2, provider: 'cpu' }
  });
  sensevoiceRec = rec;
  log('SenseVoice 就绪');
  return rec;
}

async function transcribeSenseVoice(pcm16) {
  const rec = await getSenseVoice();
  const stream = rec.createStream();
  stream.acceptWaveform(16000, pcm16);
  rec.decode(stream);
  const res = rec.getResult(stream);
  // 去 SenseVoice 富文本标记 <|zh|> <|NEUTRAL|> 等
  return String(res.text || '').replace(/<\|[^|]*\|>/g, '').replace(/\s+/g, ' ').trim();
}

// ---------- SenseVoice 原始版（funasr 独立 Python 服务，转发） ----------
let svOriginalCache = { t: 0, status: 'unreachable' };
async function checkSenseVoiceOriginal() {
  const now = Date.now();
  if (now - svOriginalCache.t < 30000) return svOriginalCache.status;
  let status = 'unreachable';
  try {
    const r = await fetch(SENSEVOICE_ORIGINAL_URL + '/health', { signal: AbortSignal.timeout(2000) });
    if (r.ok) status = 'reachable';
  } catch (e) { /* unreachable */ }
  svOriginalCache = { t: now, status };
  return status;
}

// Float32Array([-1,1]) → 16kHz 单声道 Int16 raw PCM Buffer（funasr 服务按 int16 解析）
function float32ToPcm16Bytes(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return buf;
}

async function transcribeSenseVoiceOriginal(pcm16) {
  if ((await checkSenseVoiceOriginal()) !== 'reachable') {
    throw new Error('SenseVoice 原始版服务不可达：' + SENSEVOICE_ORIGINAL_URL + '\n请运行 cd asr-server && /opt/homebrew/bin/python3 sensevoice-server.py --port 8002');
  }
  const res = await fetch(SENSEVOICE_ORIGINAL_URL + '/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: float32ToPcm16Bytes(pcm16),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error('SenseVoice 原始版服务错误：' + (d.error || 'HTTP ' + res.status));
  }
  const d = await res.json();
  return String(d.text || '').trim();
}

// ---------- 标点（可选）：转发 funasr /punc 给无标点文本加标点 ----------
async function punctuate(text) {
  if (!text) return text;
  try {
    const res = await fetch(SENSEVOICE_ORIGINAL_URL + '/punc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return text;
    const d = await res.json();
    return String(d.text || text).trim();
  } catch (e) { return text; } // 标点服务不可用时回退原文，不影响识别
}

// ---------- VAD（可选）：转发 funasr /vad 获取语音段，过滤静音 ----------
async function getVadSegments(pcm16) {
  try {
    const res = await fetch(SENSEVOICE_ORIGINAL_URL + '/vad', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: float32ToPcm16Bytes(pcm16),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const d = await res.json();
    return Array.isArray(d.speech) ? d.speech : [];
  } catch (e) { return []; }
}

// 按 VAD 语音段裁剪 pcm16（16k）：只保留有效语音，各段前后各留 padMs 毫秒过渡
function trimPcmByVad(pcm16, segs, padMs = 200) {
  if (!segs || !segs.length) return pcm16;
  const sr = 16000;
  const pad = Math.round((padMs * sr) / 1000);
  const parts = [];
  for (const s of segs) {
    if (!Array.isArray(s) || s.length < 2) continue;
    const a = Math.max(0, Math.round((s[0] / 1000) * sr) - pad);
    const b = Math.min(pcm16.length, Math.round((s[1] / 1000) * sr) + pad);
    for (let i = a; i < b; i++) parts.push(pcm16[i]);
  }
  if (!parts.length) return pcm16;
  return Float32Array.from(parts);
}

// ---------- TTS 工具 ----------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// float32 采样 → WAV Buffer（16-bit PCM 单声道）
function float32ToWav(samples, sampleRate) {
  const n = samples.length;
  const dataSize = n * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(clamp(Math.round(samples[i] * 32768), -32768, 32767), 44 + i * 2);
  return buf;
}

// 写一帧（013-P1 流式协议）：4 字节大端长度 + 一段 WAV 负载；客户端按帧解析
function writeWavFrame(res, wav) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(wav.length, 0);
  res.write(len);
  res.write(wav);
}

// 按句子切块（Kokoro 单次文本长度受限），每块 ≤ maxChars 字（非流式整段合成用）
function splitSentences(text, maxChars = 150) {
  const sentences = String(text).split(/[。！？；….!?;\n]+/).map(s => s.trim()).filter(s => s.length > 0);
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length + 1 > maxChars) { chunks.push(cur); cur = ''; }
    cur += (cur ? '。' : '') + s;
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [String(text).slice(0, maxChars)];
}

// 逐句切分（013-P1 流式用）：不跨句合并，每句独立成帧、首句尽早流出；长句再按 ≤maxChars 截断
function splitSentencesOnly(text, maxChars = 150) {
  const sentences = String(text).split(/[。！？；….!?;\n]+/).map(s => s.trim()).filter(s => s.length > 0);
  const out = [];
  for (const s of sentences) {
    if (s.length <= maxChars) { out.push(s); continue; }
    for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
  }
  return out.length ? out : [String(text).slice(0, maxChars)];
}

function concatFloat32(arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// ---------- TTS 引擎：Kokoro（sherpa-onnx-node 原生绑定，CPU 可跑，中英混合） ----------
// ⚠️ 用原生 sherpa-onnx-node（sherpa-onnx-darwin-arm64），不用 wasm 版 sherpa-onnx：
//   wasm 版加载 Kokoro 325M 模型报 wasm trap（unreachable），原生绑定正常。
let kokoroTts = null;
let kokoroSherpa = null;    // sherpa-onnx-node 模块引用（new GenerationConfig 用）
let kokoroTtsError = null;  // 加载失败缓存，避免每次请求重试
async function getKokoroTts() {
  if (kokoroTts) return kokoroTts;
  if (kokoroTtsError) throw new Error(kokoroTtsError);
  try {
    const { createRequire } = await import('node:module');
    kokoroSherpa = createRequire(import.meta.url)('sherpa-onnx-node');
  } catch (e) {
    kokoroTtsError = '未安装 sherpa-onnx-node，请 cd asr-server && npm i sherpa-onnx-node sherpa-onnx-darwin-arm64';
    throw new Error(kokoroTtsError);
  }
  if (!kokoroReady()) {
    kokoroTtsError = 'Kokoro 模型缺失：' + KOKORO_DIR + '\n请运行 npm run download-kokoro';
    throw new Error(kokoroTtsError);
  }
  log('加载 Kokoro TTS（sherpa-onnx-node 原生）…');
  try {
    kokoroTts = new kokoroSherpa.OfflineTts({
      model: {
        kokoro: {
          model: KOKORO.model,
          voices: KOKORO.voices,
          tokens: KOKORO.tokens,
          dataDir: KOKORO.dataDir,
          lexicon: KOKORO.lexicon,
          lang: ''
        }
      },
      numThreads: 2,
      provider: 'cpu'
    });
  } catch (e) {
    kokoroTtsError = 'Kokoro 模型加载失败：' + e.message;
    throw new Error(kokoroTtsError);
  }
  log('Kokoro TTS 就绪（' + kokoroTts.numSpeakers + ' 个音色，' + kokoroTts.sampleRate + 'Hz）');
  // 预热：首次推理含 onnxruntime 初始化开销，用一句短文本提前跑一次，避免首个用户请求被冷启动拖慢
  try {
    const warmGen = new kokoroSherpa.GenerationConfig({ sid: 18, speed: 1, silenceScale: 0.2 });
    kokoroTts.generate({ text: '你好。', generationConfig: warmGen });
    log('Kokoro TTS 预热完成');
  } catch (e) { /* 预热失败不影响使用 */ }
  return kokoroTts;
}

async function synthesizeKokoro(text, sid, speed) {
  const tts = await getKokoroTts();
  const sidNum = (sid === undefined || sid === null || isNaN(Number(sid)))
    ? 18
    : Math.max(0, Math.min(tts.numSpeakers - 1, Math.floor(Number(sid))));
  const spd = clamp(Number(speed) || 1, 0.5, 2);
  const chunks = splitSentences(text);
  const parts = [];
  for (const chunk of chunks) {
    const gen = new kokoroSherpa.GenerationConfig({ sid: sidNum, speed: spd, silenceScale: 0.2 });
    const r = tts.generate({ text: chunk, generationConfig: gen });
    if (r && r.samples && r.samples.length) parts.push(r.samples);
  }
  if (!parts.length) throw new Error('Kokoro 合成失败：无音频输出');
  return float32ToWav(concatFloat32(parts), tts.sampleRate || 24000);
}

// ---------- TTS 引擎：Qwen3-TTS（转发本地 Python 服务，低延迟） ----------
async function synthesizeQwen3(text, voice, language) {
  const res = await fetch(QWEN3_TTS_URL + '/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: voice || 'Vivian', language: language || 'Auto' }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error('Qwen3-TTS 服务错误：' + (data.error || 'HTTP ' + res.status) + '（请确认已运行 npm run start-qwen3）');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('Qwen3-TTS 服务未返回音频');
  return buf;
}

// Qwen3 可达性探测（缓存 30s，避免 /health 每次阻塞）
let qwen3Cache = { t: 0, status: 'unreachable' };
async function checkQwen3() {
  const now = Date.now();
  if (now - qwen3Cache.t < 30000) return qwen3Cache.status;
  let status = 'unreachable';
  try {
    const r = await fetch(QWEN3_TTS_URL + '/health', { signal: AbortSignal.timeout(2000) });
    if (r.ok) status = 'reachable';
  } catch (e) { /* unreachable */ }
  qwen3Cache = { t: now, status };
  return status;
}

// CosyVoice3 克隆服务可达性探测（缓存 30s）；status: reachable | missing
let cosyvoiceCache = { t: 0, status: 'missing' };
async function checkCosyvoice() {
  const now = Date.now();
  if (now - cosyvoiceCache.t < 30000) return cosyvoiceCache.status;
  let status = 'missing';
  try {
    const r = await fetch(COSYVOICE_URL + '/health', { signal: AbortSignal.timeout(2000) });
    if (r.ok) status = 'reachable';
  } catch (e) { /* missing */ }
  cosyvoiceCache = { t: now, status };
  return status;
}

// 云端 TTS（OpenAI 兼容 /v1/audio/speech）：cfg = { baseUrl, apiKey, model, voice }；返回 mp3/WAV Buffer
async function cloudTtsCall(cfg, text) {
  if (!cfg || !cfg.baseUrl || !cfg.apiKey) throw new Error('云端 TTS 未配置（Base URL / API Key）');
  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  const res = await fetch(base + '/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
    body: JSON.stringify({ model: cfg.model || 'tts-1', input: text, voice: cfg.voice || 'alloy', response_format: 'mp3' }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error('云端 TTS 错误：' + ((d.error && d.error.message) || d.message || ('HTTP ' + res.status)));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('云端 TTS 未返回音频');
  return buf;
}

// 微软 Azure 语音合成 REST（独立协议，SSML）：cfg = { key, region, voice }；返回 MP3 Buffer
function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
async function azureTtsCall(cfg, text) {
  const region = String(cfg && cfg.region || '').replace(/[^a-zA-Z0-9-]/g, '');
  if (!cfg || !cfg.key || !region) throw new Error('Azure TTS 未配置（Subscription Key / Region）');
  const voice = cfg.voice || 'zh-CN-XiaoxiaoNeural';
  const ssml = `<speak version='1.0' xml:lang='zh-CN'><voice name='${xmlEscape(voice)}'>${xmlEscape(text)}</voice></speak>`;
  const res = await fetch('https://' + region + '.tts.speech.microsoft.com/cognitiveservices/v1', {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': cfg.key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'tabu-asr-server'
    },
    body: ssml,
  });
  if (!res.ok) {
    const d = await res.text().catch(() => '');
    throw new Error('Azure TTS 错误：HTTP ' + res.status + (d ? ' · ' + d.slice(0, 200) : ''));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('Azure TTS 未返回音频');
  return buf;
}

// 阿里云 DashScope CosyVoice（独立协议，multimodal-generation）：cfg = { key, model, voice }；返回 MP3 Buffer
async function cosyvoiceTtsCall(cfg, text) {
  if (!cfg || !cfg.key) throw new Error('CosyVoice 未配置（DashScope API Key）');
  const res = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
    body: JSON.stringify({
      model: cfg.model || 'cosyvoice-v1',
      input: { text: String(text) },
      voice: cfg.voice || 'longxiaochun',
      parameters: { format: 'mp3', sample_rate: 48000 },
    }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error('CosyVoice 错误：' + ((d && (d.message || d.code)) || ('HTTP ' + res.status)));
  }
  const data = await res.json().catch(() => ({}));
  const out = data && data.output || {};
  let audio = out.audio || out.audio_url;
  if (!audio) throw new Error('CosyVoice 未返回音频' + (data.message ? '（' + data.message + '）' : ''));
  if (typeof audio === 'string' && /^https?:\/\//i.test(audio)) {
    const a = await fetch(audio);
    if (!a.ok) throw new Error('CosyVoice 音频下载失败：HTTP ' + a.status);
    return Buffer.from(await a.arrayBuffer());
  }
  return Buffer.from(audio, 'base64');
}

// ---------- TTS 引擎注册表（014 §5.2 统一引擎抽象） ----------
// 每个引擎：stream(res, body) 写帧流（013-P1 帧协议，自己写响应头；错误时抛异常，未发头则 500 JSON）；
//           wav(body) 返回整段 WAV Buffer（/voice-chat 全链路用）。
// 新增引擎（MOSS-Nano / IndexTTS2 / 云端 OpenAI 兼容）只需在此注册 stream + wav。
const TTS_ENGINES = {
  kokoro: {
    name: 'kokoro',
    label: 'Kokoro（CPU 轻量兜底）',
    stream: async (res, body) => {
      const tts = await getKokoroTts();
      const sidNum = (body.sid === undefined || body.sid === null || isNaN(Number(body.sid)))
        ? 18
        : Math.max(0, Math.min(tts.numSpeakers - 1, Math.floor(Number(body.sid))));
      const spd = clamp(Number(body.speed) || 1, 0.5, 2);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.flushHeaders(); // 立即推响应头，避免缓存到首帧才发（否则客户端 fetch 会等到首句合成完）
      // 逐句流式：每句一帧，合成完立即 flush，首帧延迟 ≈ 首句合成时间
      const sentences = splitSentencesOnly(body.text);
      for (const chunk of sentences) {
        const gen = new kokoroSherpa.GenerationConfig({ sid: sidNum, speed: spd, silenceScale: 0.2 });
        const r = tts.generate({ text: chunk, generationConfig: gen });
        if (r && r.samples && r.samples.length) {
          writeWavFrame(res, float32ToWav(r.samples, tts.sampleRate || 24000));
        }
      }
      res.end();
    },
    wav: (body) => synthesizeKokoro(body.text, body.sid, body.speed),
  },
  qwen3: {
    name: 'qwen3',
    label: 'Qwen3-TTS（MPS · 流式）',
    stream: async (res, body) => {
      // 013-P2①：转发 qwen3-tts-server.py 的 ?stream=1 帧流，原样透传给客户端（两端协议一致）
      const up = await fetch(QWEN3_TTS_URL + '/speak?stream=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: body.text,
          voice: body.voice || 'Vivian',
          language: body.language || 'Auto',
          roles: body.roles,        // 'auto'|'on'|'off' 多角色朗读（015 §五）
          roleMap: body.roleMap,    // 角色名 → speaker（可选）
        }),
        // 不设硬超时：客户端断开时 fetch 响应体自然被取消
      });
      if (!up.ok) {
        const data = await up.json().catch(() => ({}));
        throw new Error('Qwen3-TTS 服务错误：' + (data.error || 'HTTP ' + up.status) + '（请确认已运行 npm run start-qwen3）');
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.flushHeaders();
      for await (const chunk of up.body) res.write(chunk);
      res.end();
    },
    wav: (body) => synthesizeQwen3(body.text, body.voice, body.language),
  },
  cloud: {
    name: 'cloud',
    label: '🌐 云端 TTS（OpenAI 兼容）',
    stream: async (res, body) => {
      // 逐句调云端 /audio/speech → 帧流：首帧 ≈ 首句云端 TTFB（100-500ms），支持长文本
      const cfg = body.cloud || {};
      if (!cfg.baseUrl || !cfg.apiKey) throw new Error('云端 TTS 未配置（Base URL / API Key）'); // 头未发 → 500 JSON
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.flushHeaders();
      const sentences = splitSentencesOnly(body.text);
      for (const s of sentences) {
        writeWavFrame(res, await cloudTtsCall(cfg, s));
      }
      res.end();
    },
    wav: async (body) => cloudTtsCall(body.cloud || {}, body.text),
  },
  azure: {
    name: 'azure',
    label: '🟦 Azure TTS（独立协议）',
    stream: async (res, body) => {
      // 逐句 SSML 合成 → MP3 帧流（帧协议格式无关，客户端 decodeAudioData 直接解码）
      const cfg = body.azure || {};
      if (!cfg.key || !cfg.region) throw new Error('Azure TTS 未配置（Subscription Key / Region）'); // 头未发 → 500 JSON
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.flushHeaders();
      const sentences = splitSentencesOnly(body.text);
      for (const s of sentences) {
        writeWavFrame(res, await azureTtsCall(cfg, s));
      }
      res.end();
    },
    wav: async (body) => azureTtsCall(body.azure || {}, body.text),
  },
  cosyvoice: {
    name: 'cosyvoice',
    label: '🔵 阿里云 CosyVoice（独立协议）',
    stream: async (res, body) => {
      // 逐句 DashScope multimodal-generation → MP3 帧流
      const cfg = body.cosyvoice || {};
      if (!cfg.key) throw new Error('CosyVoice 未配置（DashScope API Key）'); // 头未发 → 500 JSON
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.flushHeaders();
      const sentences = splitSentencesOnly(body.text);
      for (const s of sentences) {
        writeWavFrame(res, await cosyvoiceTtsCall(cfg, s));
      }
      res.end();
    },
    wav: async (body) => cosyvoiceTtsCall(body.cosyvoice || {}, body.text),
  },
  clone: {
    name: 'clone',
    label: '🎨 克隆音色（CosyVoice3 本地）',
    // body.voice = 克隆音色 id；转发 cosyvoice-tts-server.py(8003)，透传帧流（两端协议一致）
    stream: async (res, body) => {
      if (!body.voice) throw new Error('克隆引擎需要指定音色（voice=克隆音色id）');
      const up = await fetch(COSYVOICE_URL + '/speak?stream=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body.text, voice: body.voice }),
      });
      if (!up.ok) {
        const data = await up.json().catch(() => ({}));
        throw new Error('克隆音色服务错误：' + (data.error || 'HTTP ' + up.status));
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.flushHeaders();
      for await (const chunk of up.body) res.write(chunk);
      res.end();
    },
    wav: async (body) => {
      if (!body.voice) throw new Error('克隆引擎需要指定音色（voice=克隆音色id）');
      const up = await fetch(COSYVOICE_URL + '/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body.text, voice: body.voice }),
        signal: AbortSignal.timeout(120000),
      });
      if (!up.ok) {
        const data = await up.json().catch(() => ({}));
        throw new Error('克隆音色服务错误：' + (data.error || 'HTTP ' + up.status));
      }
      const buf = Buffer.from(await up.arrayBuffer());
      if (!buf.length) throw new Error('克隆音色服务未返回音频');
      return buf;
    },
  },
};


// ---------- LLM：node-llama-cpp 内嵌（单进程自控，引擎可插拔） ----------
// 抽象层 /chat 支持两种引擎：llama-cpp（内嵌默认）/ ollama（转发，后备，需 ollama serve）
const LLM_DIR = path.join(CACHE_DIR, 'llm');
// 默认 LLM 模型（env LLM_MODEL 可覆盖为具体 gguf 文件名/路径）
const LLM_MODEL = process.env.LLM_MODEL || path.join(LLM_DIR, 'qwen2.5-0.5b-instruct-q4_k_m.gguf');
// 可选 LLM 档位注册表（key → 下载信息）；前端模型管理 UI 据此展示/安装
const LLM_MODELS = {
  'llm-0.5b': {
    label: 'Qwen2.5-0.5B-Instruct（默认 · 兜底）',
    size: '~469MB',
    file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf',
    url: 'https://hf-mirror.com/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf',
  },
  'llm-qwen3-8b': {
    label: 'Qwen3-8B Q4_K_M（推荐 · 对话更强）',
    size: '~4.9GB',
    file: 'Qwen3-8B-Q4_K_M.gguf',
    url: 'https://hf-mirror.com/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
  },
};
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');

// 云端 LLM（OpenAI 兼容协议）：DeepSeek / 智谱 GLM，与本地引擎并列可选
// API Key 优先由前端请求传入（用户在设置面板填写），环境变量作兜底
const CLOUD_ENGINES = {
  deepseek: {
    label: 'DeepSeek',
    url: 'https://api.deepseek.com/chat/completions',
    envKey: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-v4-flash',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  zhipu: {
    label: '智谱 GLM',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    envKey: 'ZHIPU_API_KEY',
    defaultModel: 'glm-4.7',
    models: ['glm-4.7', 'glm-4.6'],
  },
};

function llmPathOf(key) { const m = LLM_MODELS[key]; return m ? path.join(LLM_DIR, m.file) : null; }
function llmReady(keyOrPath) {
  const p = keyOrPath && LLM_MODELS[keyOrPath] ? llmPathOf(keyOrPath) : (keyOrPath || LLM_MODEL);
  return existsSync(p);
}
// /chat 的 model 参数 → 具体 gguf 路径（支持注册表 key / 文件名 / 绝对路径）
function resolveLlmPath(model) {
  if (!model) return LLM_MODEL;
  if (LLM_MODELS[model]) return llmPathOf(model);
  if (model.includes('/') || model.includes('\\')) return model; // 绝对/相对路径
  return path.join(LLM_DIR, model); // 按文件名
}

let llmSession = null;
let llmSessionPath = null;
let llmInitPromise = null;
let llmInitError = null;

// 安装新 LLM 模型后调用：清空加载缓存，让下次对话重新加载（无需重启 App/服务）
function llmInvalidate() {
  llmSession = null;
  llmSessionPath = null;
  llmInitPromise = null;
  llmInitError = null;
}

async function getLlamaSession(modelPath) {
  // 若已加载且路径一致则复用；否则换模型重载（同一时间只保留一个活跃模型，省内存）
  if (llmSession && llmSessionPath === modelPath) return llmSession;
  // 模型文件被替换/新装后，之前缓存的失败原因不再成立 → 重置以便重试
  if (llmInitError) {
    const stillMissing = !existsSync(modelPath);
    if (stillMissing) throw new Error(llmInitError);
    llmInitError = null; // 文件已就位，允许重新尝试加载
  }
  if (llmInitPromise) return llmInitPromise;
  llmInitPromise = (async () => {
    if (!existsSync(modelPath)) throw new Error('LLM 模型缺失：' + modelPath + '\n请在模型管理里下载，或把 GGUF 放到 models/llm/');
    const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
    const llama = await getLlama();
    log('加载 LLM：' + path.basename(modelPath) + '（首次加载较慢）…');
    const model = await llama.loadModel({ modelPath });
    const context = await model.createContext({ contextSize: 2048 });
    llmSession = new LlamaChatSession({ contextSequence: context.getSequence() });
    llmSessionPath = modelPath;
    log('LLM 就绪（' + path.basename(modelPath) + '）');
    return llmSession;
  })();
  return llmInitPromise.catch((e) => { llmInitError = e.message; throw e; });
}

async function chatLlamaCpp(messages, opts = {}) {
  const modelPath = resolveLlmPath(opts.model);
  const session = await getLlamaSession(modelPath);
  const system = messages.find(m => m.role === 'system')?.content;
  const userText = messages.filter(m => m.role === 'user').map(m => String(m.content)).join('\n');
  const full = (system ? String(system) + '\n\n' : '') + userText;
  const res = await session.prompt(full, {
    temperature: opts.temperature ?? 0.7,
    topP: opts.top_p ?? 0.9,
    maxTokens: opts.maxTokens ?? 256,
  });
  return String(res || '').trim();
}

async function chatOllama(messages, opts = {}) {
  const res = await fetch(OLLAMA_URL + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: opts.model || 'qwen3', messages, stream: false }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error('Ollama 服务错误：' + (data.error || 'HTTP ' + res.status) + '（请确认 ollama serve 且 ollama pull qwen3）');
  }
  const data = await res.json();
  return String(data.message?.content || '').trim();
}

// 云端引擎通用调用（DeepSeek / 智谱均为 OpenAI 兼容 chat/completions）
async function chatCloud(engine, messages, opts = {}) {
  const conf = CLOUD_ENGINES[engine];
  const apiKey = opts.apiKey || process.env[conf.envKey];
  if (!apiKey) throw new Error(conf.label + ' 未配置 API Key：请在设置面板填写，或设置环境变量 ' + conf.envKey);
  const body = {
    model: opts.model || conf.defaultModel,
    messages,
    temperature: opts.temperature ?? 0.7,
    top_p: opts.top_p ?? 0.9,
    max_tokens: opts.maxTokens ?? 512,
    stream: false,
    // 语音助手场景默认关闭深度思考，降低首字延迟
    thinking: { type: 'disabled' },
  };
  const res = await fetch(conf.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.error?.message || data.message || JSON.stringify(data).slice(0, 200);
    throw new Error(conf.label + ' API 错误：HTTP ' + res.status + ' ' + detail);
  }
  return String(data.choices?.[0]?.message?.content || '').trim();
}

async function llmChat(engine, messages, opts = {}) {
  const e = (engine || 'llama-cpp').toLowerCase();
  if (e === 'llama-cpp') return chatLlamaCpp(messages, opts);
  if (e === 'ollama') return chatOllama(messages, opts);
  if (CLOUD_ENGINES[e]) return chatCloud(e, messages, opts);
  throw new Error('未知 LLM 引擎: ' + e + '（支持 llama-cpp / ollama / deepseek / zhipu）');
}

// Ollama 可达性（缓存 30s）
let ollamaCache = { t: 0, status: 'unreachable' };
async function checkOllama() {
  const now = Date.now();
  if (now - ollamaCache.t < 30000) return ollamaCache.status;
  let status = 'unreachable';
  try {
    const r = await fetch(OLLAMA_URL + '/api/tags', { signal: AbortSignal.timeout(2000) });
    if (r.ok) status = 'reachable';
  } catch (e) { /* unreachable */ }
  ollamaCache = { t: now, status };
  return status;
}

// ---------- 模型清单与安装（014 §5.2：/models + /install-model，服务端按名拉取） ----------
// whisper 由 transformers.js 缓存到 models/hf/onnx-community/whisper-*（S2：与 engines/whisper.json 的 glob 校验同一路径）
function whisperInstalled() {
  const base = path.join(CACHE_DIR, 'hf', 'onnx-community');
  if (!existsSync(base)) return false;
  try { return readdirSync(base).some((n) => n.includes('whisper')); } catch { return false; }
}

const MODEL_ITEMS = [
  { category: 'tts', engine: 'kokoro',     label: 'Kokoro（中英混合 · 53 音色）',   size: '~350MB', installed: () => kokoroReady() },
  { category: 'tts', engine: 'qwen3',      label: 'Qwen3-TTS 0.6B（MPS · 流式）',    size: '~1.2GB', installed: async () => (await checkQwen3()) === 'reachable' },
  { category: 'tts', engine: 'cosyvoice-clone', label: 'CosyVoice3 语音克隆（0.5B · MPS）', size: '~9.1GB', installed: async () => (await checkCosyvoice()) === 'reachable' },
  { category: 'asr', engine: 'sensevoice', label: 'SenseVoice（中文/粤/日/韩最优）', size: '~228MB', installed: () => existsSync(SENSEVOICE_MODEL) },
  { category: 'asr', engine: 'sensevoice-original', label: 'SenseVoice 原始版（funasr · 高精度）', size: '~900MB', installed: async () => (await checkSenseVoiceOriginal()) === 'reachable' },
  { category: 'asr', engine: 'whisper',    label: 'Whisper base（多语兜底）',        size: '~500MB', installed: () => whisperInstalled() },
  { category: 'llm', engine: 'llm-0.5b',   label: 'Qwen2.5-0.5B-Instruct（默认 · 兜底）', size: '~469MB', installed: () => llmReady('llm-0.5b') },
  { category: 'llm', engine: 'llm-qwen3-8b', label: 'Qwen3-8B Q4_K_M（推荐 · 对话更强）', size: '~4.9GB', installed: () => llmReady('llm-qwen3-8b') },
];

async function collectModels() {
  const out = [];
  const byId = new Map(MODEL_ITEMS.map((m) => [m.engine, m]));
  // S2：以 engines/*.json 为主，逐引擎输出就绪明细（state / missingFiles / missingRuntime）
  for (const mf of ENGINE_MANIFESTS) {
    const legacy = byId.get(mf.id);
    const d = await engineReadiness(mf);
    let installed = d.state === 'running' || d.state === 'ready';
    if (legacy) { try { installed = !!(await legacy.installed()); } catch {} }
    out.push({
      category: mf.category || legacy?.category || '',
      engine: mf.id,
      label: mf.label || legacy?.label || mf.id,
      size: mf.sizeHint || legacy?.size || '',
      license: mf.license || '',
      installed,
      state: d.state,
      serviceUp: d.serviceUp,
      missingFiles: d.missingFiles,
      missingRuntime: d.missingRuntime,
      totalMissingBytes: d.totalMissingBytes,
      // S3：安装方式与可选镜像名（UI 据此渲染镜像切换下拉）
      install: mf.install ? {
        kind: mf.install.kind,
        mirrors: mf.install.kind === 'url-multi'
          ? (mf.install.files?.[0]?.mirrors || []).map((x) => x.name)
          : []
      } : null
    });
  }
  // 兜底：MODEL_ITEMS 里没有对应 manifest 的条目按旧格式输出（防漏）
  for (const m of MODEL_ITEMS) {
    if (!ENGINE_MANIFESTS.some((x) => x.id === m.engine)) {
      out.push({ category: m.category, engine: m.engine, label: m.label, size: m.size, installed: !!(await m.installed()) });
    }
  }
  return out;
}

// ---------- S2 引擎清单（engines/*.json）与就绪明细（002-plan §三） ----------
// 每引擎一份 JSON：checks=必需文件/目录逐项核对；runtime=运行时依赖；
// install.kind: script(现有下载脚本) / url-multi(通用多镜像下载) / hint(提示) / legacy(沿用 INSTALLERS)
const ENGINES_DIR = path.join(__dirname, 'engines');
function loadEngineManifests() {
  try {
    return readdirSync(ENGINES_DIR).filter((f) => f.endsWith('.json')).sort()
      .map((f) => {
        const mf = JSON.parse(readFileSync(path.join(ENGINES_DIR, f), 'utf8'));
        return mf;
      });
  } catch (e) {
    console.error('[manifests] 引擎清单加载失败:', e.message);
    return [];
  }
}
const ENGINE_MANIFESTS = loadEngineManifests();
console.log(`[manifests] 已加载 ${ENGINE_MANIFESTS.length} 份引擎清单（engines/*.json）`);

// 000-device-vs-model.md §四：设备画像（4.1）——启动时探测一次并缓存；失败不阻塞服务（路由返回 503）
let DEVICE_PROFILE = null;
try {
  DEVICE_PROFILE = await buildDeviceProfile(ENGINE_MANIFESTS);
  console.log(`[device-profile] ${DEVICE_PROFILE.os} · accel=${DEVICE_PROFILE.accel} · ram=${DEVICE_PROFILE.ramGB}GB · tier=${DEVICE_PROFILE.tier} · 可装 ${DEVICE_PROFILE.canInstall.length}/${ENGINE_MANIFESTS.length}`);
} catch (e) {
  console.error('[device-profile] 设备探测失败（/device-profile 将返回 503）:', e.message);
}

// 最小 glob：仅支持「目录/*」一段通配（够 whisper 场景）
function globExists(pattern) {
  const abs = path.join(__dirname, pattern);
  if (!pattern.includes('*')) return existsSync(abs);
  const sep = abs.lastIndexOf(path.sep, abs.indexOf('*'));
  const baseDir = abs.slice(0, sep);
  const tail = abs.slice(sep + 1);
  const rx = new RegExp('^' + tail.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  try {
    return readdirSync(baseDir).some((n) => rx.test(n) && existsSync(path.join(baseDir, n)));
  } catch { return false; }
}

// 目录内文件计数（含子目录，设上限防呆）
function countFilesDeep(dir, cap = 5000) {
  let n = 0;
  const walk = (d) => {
    if (n >= cap) return;
    let items;
    try { items = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (n >= cap) return;
      if (it.isDirectory()) walk(path.join(d, it.name));
      else n++;
    }
  };
  walk(dir);
  return n;
}

// 单项校验：null=通过；否则返回缺失描述
function checkEntry(c) {
  if (c.type === 'file') {
    const p = path.join(__dirname, c.path);
    if (!existsSync(p)) return { path: c.path, type: '缺文件', expectBytes: c.bytes || 0 };
    if (c.bytes) {
      try {
        const s = statSync(p).size;
        if (s !== c.bytes) return { path: c.path, type: '大小不符', expectBytes: c.bytes, actualBytes: s };
      } catch { return { path: c.path, type: '不可读', expectBytes: c.bytes }; }
    }
    return null;
  }
  if (c.type === 'dir') {
    const p = path.join(__dirname, c.path);
    if (!existsSync(p)) return { path: c.path, type: '缺目录', expectFiles: c.minFiles || 1 };
    if (c.minFiles && countFilesDeep(p) < c.minFiles) return { path: c.path, type: '目录不完整', expectFiles: c.minFiles };
    return null;
  }
  if (c.type === 'glob') return globExists(c.pattern) ? null : { path: c.pattern, type: '无匹配' };
  return null;
}

// 就绪检查：state ∈ running | ready | partial-files | missing-runtime | incomplete
async function engineReadiness(mf) {
  const missingFiles = [];
  const missingRuntime = [];
  for (const c of mf.checks || []) {
    const r = checkEntry(c);
    if (r) missingFiles.push(r);
  }
  for (const r of mf.runtime || []) {
    if (r.kind === 'path') {
      if (!existsSync(path.join(__dirname, r.path))) missingRuntime.push({ kind: '缺失', label: r.label || r.path });
    } else if (r.kind === 'bin') {
      try { execSync(`which ${r.name}`, { stdio: 'ignore' }); } catch { missingRuntime.push({ kind: '缺失', label: r.label || ('命令 ' + r.name) }); }
    }
  }
  // 服务是否在跑：复用 MODEL_ITEMS 的探针（多数即 /health 健康检查）
  const legacy = MODEL_ITEMS.find((x) => x.engine === mf.id);
  let serviceUp = false;
  if (legacy) { try { serviceUp = !!(await legacy.installed()); } catch {} }
  const state = missingRuntime.length
    ? (missingFiles.length ? 'incomplete' : 'missing-runtime')
    : missingFiles.length ? 'partial-files'
      : (serviceUp ? 'running' : 'ready');
  const totalMissingBytes = missingFiles.reduce((a, b) => a + (b.expectBytes || 0), 0);
  return { state, missingFiles, missingRuntime, totalMissingBytes, serviceUp };
}

// 子进程下载器 → NDJSON 流式进度；退出码 0 视为完成
function runDownload(cmd, args) {
  return (ctx) => new Promise((resolve, reject) => {
    ctx.nd({ type: 'log', message: '开始下载…' });
    const p = spawn(cmd, args, { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '').trim();
        buf = buf.slice(idx + 1);
        if (line) ctx.nd({ type: 'log', message: line });
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (e) => reject(new Error('无法启动下载器：' + e.message)));
    p.on('exit', (code) => {
      if (buf.trim()) ctx.nd({ type: 'log', message: buf.trim() });
      if (code === 0) ctx.nd({ type: 'done', message: '安装完成' });
      else reject(new Error('下载失败（退出码 ' + code + '）'));
    });
  });
}

// 当前活动下载进程（S3：供 /install-cancel 终止；.part 保留可续传）
const ACTIVE_DOWNLOAD = { proc: null, cancelled: false };

// S2/S3 通用单文件多镜像下载器（manifest install.kind=url-multi 专用）：
// .part 临时文件 → 完成后原子 rename；curl -C - 断点续传；
// --speed-limit/--speed-time：速度低于阈值持续一段时间视为失败 → 自动换下一个镜像源；
// opts.mirror：把指定镜像排到最前（UI 镜像切换）；
// 进度：每 800ms 读 .part 实际大小，发 NDJSON {type:'progress', received, total}。
function downloadOneFile(fileSpec, ctx, opts = {}) {
  const target = path.join(__dirname, fileSpec.file);
  mkdirSync(path.dirname(target), { recursive: true });
  return new Promise((resolve, reject) => {
    const mirrors = [...(fileSpec.mirrors || [])];
    if (opts.mirror) {
      const mi = mirrors.findIndex((m) => m.name === opts.mirror);
      if (mi > 0) mirrors.unshift(...mirrors.splice(mi, 1));
      else if (mi === -1) ctx.nd({ type: 'log', message: `⚠️ 镜像 ${opts.mirror} 不在清单中，按默认顺序下载` });
    }
    const part = target + '.part';
    const total = fileSpec.bytes || 0;
    let finished = false;
    const timer = setInterval(() => {
      if (finished) return;
      try {
        const s = statSync(part).size;
        ctx.nd({ type: 'progress', file: path.basename(fileSpec.file), received: s, total });
      } catch {}
    }, 800);
    const finish = (fn, arg) => { finished = true; clearInterval(timer); ACTIVE_DOWNLOAD.proc = null; fn(arg); };
    let i = 0;
    const tryMirror = () => {
      if (ACTIVE_DOWNLOAD.cancelled) {
        ACTIVE_DOWNLOAD.cancelled = false;
        return finish(reject, new Error('已取消（保留 .part，可重新安装续传）'));
      }
      if (i >= mirrors.length) {
        return finish(reject, new Error(`所有镜像均失败：${fileSpec.file}（已保留 .part，可重试续传）`));
      }
      const m = mirrors[i++];
      ctx.nd({ type: 'log', message: `下载 ${path.basename(fileSpec.file)} ← ${m.name}${opts.mirror === m.name ? '（指定）' : ''} …` });
      const p = spawn('curl', ['-L', '-C', '-', '--connect-timeout', '15', '--max-time', '14400',
        '--speed-limit', '20480', '--speed-time', '90', // <20KB/s 持续 90s 判失败 → 换源
        '-o', part, m.url], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
      ACTIVE_DOWNLOAD.proc = p;
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '').trim();
          buf = buf.slice(idx + 1);
          if (line) ctx.nd({ type: 'log', message: line });
        }
      };
      p.stdout.on('data', onData);
      p.stderr.on('data', onData);
      p.on('error', (e) => { try { p.kill(); } catch {} finish(reject, new Error('无法启动 curl：' + e.message)); });
      p.on('exit', (code) => {
        if (buf.trim()) ctx.nd({ type: 'log', message: buf.trim() });
        if (ACTIVE_DOWNLOAD.cancelled) {
          ACTIVE_DOWNLOAD.cancelled = false;
          return finish(reject, new Error('已取消（保留 .part，可重新安装续传）'));
        }
        if (code === 0) {
          try { renameSync(part, target); } catch (e) { return finish(reject, new Error('改名失败：' + e.message)); }
          return finish(resolve, target);
        }
        // 失败保留 .part 供断点续传，自动换下一个镜像
        ctx.nd({ type: 'log', message: `镜像 ${m.name} 失败（exit=${code}），尝试下一镜像…` });
        tryMirror();
      });
    };
    tryMirror();
  });
}

// manifest install.kind=url-multi 的安装器工厂（opts.mirror 由 /install-model?mirror= 透传）
function manifestUrlMultiInstaller(mf) {
  return async (ctx, opts = {}) => {
    for (const f of mf.install.files || []) {
      const target = path.join(__dirname, f.file);
      if (existsSync(target)) {
        ctx.nd({ type: 'log', message: `已存在，跳过：${f.file}` });
        continue;
      }
      await downloadOneFile(f, ctx, opts);
      if (f.bytes) {
        const s = statSync(target).size;
        if (s !== f.bytes) ctx.nd({ type: 'log', message: `⚠️ 大小不符（期望 ${f.bytes} / 实际 ${s}），建议删除后重新安装` });
        else ctx.nd({ type: 'log', message: `✓ 字节数校验通过（${s}）` });
      }
    }
    ctx.nd({ type: 'done', message: `安装完成：${mf.id}` });
  };
}

mkdirSync(LLM_DIR, { recursive: true }); // 供 LLM 模型落盘

// S5：CosyVoice3 必需权重的下载规格（bytes 与 engines/cosyvoice-clone.json 的 checks 保持一致）
const CV_MODEL_SUBDIR = 'models/cosyvoice/Fun-CosyVoice3-0.5B';
const CV_WEIGHTS = {
  'llm.pt': { bytes: 2024669519 },
  'flow.pt': { bytes: 1329116148 },
  'hift.pt': { bytes: 83202622 },
  'speech_tokenizer_v3.onnx': { bytes: 969451503 },
  'campplus.onnx': { bytes: 28303423 },
  'cosyvoice3.yaml': { bytes: 6934 },
};
const cvWeightSpec = (name) => ({
  file: `${CV_MODEL_SUBDIR}/${name}`,
  bytes: CV_WEIGHTS[name].bytes,
  mirrors: [
    { name: 'hf-mirror', url: `https://hf-mirror.com/FunAudioLLM/Fun-CosyVoice3-0.5B/resolve/main/${name}` },
    { name: 'huggingface', url: `https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B/resolve/main/${name}` },
  ],
});

// ─────────────────────────────────────────────────────────────
// 【新增模型接入约定 · 必读】（S5 起，本区域顶部常驻）
// 未来在 INSTALLERS 里注册任何新模型/引擎时，都必须做到"开箱即用"：
//   1. 用户点击「安装」→ 自动下载权重文件等全部必要文件，
//      下载完成即启用对应服务，不允许再要求用户手动去外网找文件放置；
//   2. 大流量（约 >1GB）必须走二次确认：安装器首调检测到大流量缺失时
//      抛 BIG_DOWNLOAD_CONFIRM:<大小>:<文件清单> 标记，前端弹确认框，
//      用户同意后带 confirm=1 重试才真正下载（参照下方 cosyvoice-clone 的 S5 实现）；
//   3. 下载一律复用 downloadOneFile：多镜像自动换源 + .part 断点续传 + 可取消；
//   4. 下载完成后逐文件做字节数校验，并把体积/内存需求同步登记到
//      engines/<engine>.json 与文档 000-device-vs-model.md；
//   5. 确有无法自动化的例外（体积超大/合规限制），须在 UI 明示原因并保留手动兜底指引。
// ─────────────────────────────────────────────────────────────
const INSTALLERS = {
  kokoro: runDownload(process.execPath, ['download-kokoro.js']),
  sensevoice: runDownload(process.execPath, ['asr-server-download.js']),
  // 多档位 LLM：S2 起由 engines/llm-*.json 驱动（install.kind=url-multi，多镜像自动换源 + 字节数校验）
  ...Object.fromEntries(
    ENGINE_MANIFESTS.filter((mf) => mf.install && mf.install.kind === 'url-multi')
      .map((mf) => [mf.id, manifestUrlMultiInstaller(mf)])
  ),
  qwen3: (ctx) => ctx.nd({ type: 'done', message: 'Qwen3-TTS 无独立下载脚本：模型在首次启动 qwen3 服务（npm run start-qwen3）时自动下载。' }),
  whisper: (ctx) => ctx.nd({ type: 'done', message: 'Whisper 无独立下载脚本：首次识别时由 transformers.js 自动下载。' }),
  // CosyVoice3 克隆：双依赖检查——① 9GB 模型（005 手动预下载，缺失时不自动下，避免误触大流量）；
  // ② CosyVoice 源码仓库（cosyvoice 包 + Matcha-TTS 子模块，运行时 import 必需），缺失则自动浅克隆补齐。
  // 完成后若 8003 未监听，需托盘「重启服务」拉起（模型加载约数分钟）。
  // S4：CosyVoice3 克隆 —— 全自举链（vendor 优先 → clone 兜底 → venv 自建 → 模型校验）
  // ①② 源码：vendor/cosyvoice（随包分发的裁剪子集，见 VENDOR_COMMIT）；缺失则浅克隆进 vendor（兜底）
  // ③ venv：.venv-cosyvoice/bin/python3 缺失 → 自动 python3 -m venv + pip install -r requirements-cosyvoice.lock
  // ④ 模型：必需权重逐项校验（S4 源码甄别：llm.pt/flow.pt/hift.pt/speech_tokenizer_v3.onnx/campplus.onnx/yaml，
  //    llm.rl.pt/.batch.onnx/fp32.onnx 为非必需，不校验不下载）
  //    S5：缺失权重支持自动下载 —— 走 downloadOneFile 多镜像（hf-mirror→huggingface）+ .part 断点续传；
  //        因属大流量（约 4.4GB），首次调用不带 opts.confirmBigDownload 时仅返回 BIG_DOWNLOAD_CONFIRM 标记，
  //        由前端弹二次确认后带 confirm=1 重试才真正下载。
  'cosyvoice-clone': async (ctx, opts = {}) => {
    const modelDir = path.join(__dirname, 'models', 'cosyvoice', 'Fun-CosyVoice3-0.5B');
    const vendorDir = path.join(__dirname, 'vendor', 'cosyvoice');
    const srcDir = vendorDir;
    const keyFiles = ['llm.pt', 'flow.pt', 'hift.pt', 'speech_tokenizer_v3.onnx', 'campplus.onnx', 'cosyvoice3.yaml'];
    const missing = keyFiles.filter((f) => !existsSync(path.join(modelDir, f)));
    if (missing.length) {
      const totalBytes = missing.reduce((s, f) => s + (CV_WEIGHTS[f]?.bytes || 0), 0);
      const gb = (totalBytes / 1e9).toFixed(1);
      // S5：未确认 → 抛标记给前端做二次确认（不在后端静默吞掉大流量）
      if (!opts.confirmBigDownload) {
        ctx.nd({ type: 'log', message: `检测到缺失必需权重 ${missing.length} 项（合计约 ${gb}GB）` });
        ctx.nd({ type: 'log', message: `等待确认后自动下载；也可按 005 文档手动放置到: ${modelDir}` });
        throw new Error(`BIG_DOWNLOAD_CONFIRM:${gb}GB:${missing.join(',')}`);
      }
      ctx.nd({ type: 'log', message: `已确认大流量下载（约 ${gb}GB），开始拉取缺失权重 ${missing.length} 项…` });
      for (const f of missing) {
        await downloadOneFile(cvWeightSpec(f), ctx, opts);
        const got = statSync(path.join(modelDir, f)).size;
        if (CV_WEIGHTS[f].bytes && got !== CV_WEIGHTS[f].bytes)
          ctx.nd({ type: 'log', message: `⚠️ ${f} 大小不符（期望 ${CV_WEIGHTS[f].bytes} / 实际 ${got}），建议删除该文件后重新安装` });
        else
          ctx.nd({ type: 'log', message: `✓ ${f} 就位（字节数校验通过）` });
      }
    } else {
      ctx.nd({ type: 'log', message: '模型文件完整 ✓（必需项 4.4GB）' });
    }

    // ① 源码：vendor 优先
    if (!existsSync(path.join(srcDir, 'cosyvoice', 'cli', 'cosyvoice.py'))) {
      // ② 兜底：浅克隆进 vendor（含 Matcha-TTS 子模块）
      ctx.nd({ type: 'log', message: 'vendor 源码缺失 → git clone（浅克隆 + 子模块）进 vendor/cosyvoice …' });
      mkdirSync(path.dirname(srcDir), { recursive: true });
      await new Promise((resolve, reject) => {
        const p = spawn('git', ['clone', '--depth', '1', '--recursive', '--shallow-submodules',
          'https://github.com/FunAudioLLM/CosyVoice.git', srcDir],
          { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
        const onData = (chunk) => String(chunk).split('\n').filter(Boolean)
          .forEach((line) => ctx.nd({ type: 'log', message: line }));
        p.stdout.on('data', onData);
        p.stderr.on('data', onData);
        p.on('error', (e) => reject(new Error('无法启动 git：' + e.message)));
        p.on('exit', (code) => code === 0
          ? resolve()
          : reject(new Error(`git clone 失败（退出码 ${code}）；可手动执行: git clone --depth 1 --recursive https://github.com/FunAudioLLM/CosyVoice.git ${srcDir}`)));
      });
      try { execSync('git -C ' + vendorDir + ' rev-parse HEAD > ' + path.join(vendorDir, 'VENDOR_COMMIT') + ' 2>/dev/null'); } catch {}
      // 克隆的是整仓，顺手修剪到运行时最小集（与随包 vendoring 一致）
      try {
        const rmAbs = ['.git', 'third_party/Matcha-TTS/.git', 'third_party/Matcha-TTS/synthesis.ipynb', 'third_party/Matcha-TTS/scripts', 'third_party/Matcha-TTS/data'];
        for (const r of rmAbs) execSync(`rm -rf "${path.join(vendorDir, r)}"`);
      } catch {}
      ctx.nd({ type: 'log', message: '源码就绪 ✓（vendored，见 VENDOR_COMMIT）' });
    } else {
      ctx.nd({ type: 'log', message: 'CosyVoice 源码已存在（vendor/cosyvoice）✓' });
    }

    // ③ venv 自建：缺失才装（含 torch，首次可能几分钟）；031 跨平台：Win 用 Scripts/python.exe
    const IS_WIN = process.platform === 'win32';
    const venvDir = path.join(__dirname, '.venv-cosyvoice');
    const venvPy = IS_WIN
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python3');
    if (!existsSync(venvPy)) {
      ctx.nd({ type: 'log', message: '.venv-cosyvoice 缺失 → 创建并安装锁定依赖（首次约几分钟）…' });
      let sysPy = process.env.PY_SYS;
      if (!sysPy) {
        try {
          sysPy = execSync(IS_WIN ? 'where python3' : 'which python3', { encoding: 'utf8' }).trim().split('\n')[0];
        } catch {}
      }
      if (!sysPy) throw new Error('未找到系统 python3（创建 venv 需要）');
      ctx.nd({ type: 'log', message: `python3 = ${sysPy}` });
      await new Promise((resolve, reject) => {
        const p = spawn(sysPy, ['-m', 'venv', venvDir], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
        const onData = (chunk) => String(chunk).split('\n').filter(Boolean)
          .forEach((line) => ctx.nd({ type: 'log', message: line }));
        p.stdout.on('data', onData); p.stderr.on('data', onData);
        p.on('error', (e) => reject(new Error('无法启动 python3 -m venv：' + e.message)));
        p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`venv 创建失败（退出码 ${code}）`)));
      });
      ctx.nd({ type: 'log', message: 'venv 创建完成，pip 安装依赖…' });
      const venvPip = IS_WIN ? path.join(venvDir, 'Scripts', 'pip.exe') : path.join(venvDir, 'bin', 'pip');
      await new Promise((resolve, reject) => {
        const p = spawn(venvPip, ['install', '-r', path.join(__dirname, 'requirements-cosyvoice.lock')],
          { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
        const onData = (chunk) => String(chunk).split('\n').filter(Boolean)
          .forEach((line) => ctx.nd({ type: 'log', message: line }));
        p.stdout.on('data', onData); p.stderr.on('data', onData);
        p.on('error', (e) => reject(new Error('无法启动 pip：' + e.message)));
        p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`pip install 失败（退出码 ${code}），查看上方日志`)));
      });
      ctx.nd({ type: 'log', message: '依赖安装完成 ✓' });
    } else {
      ctx.nd({ type: 'log', message: '.venv-cosyvoice 已存在 ✓' });
    }

    ctx.nd({ type: 'done', message: '克隆依赖就绪。若「运行中」徽标未变绿：托盘 → 重启服务，等模型加载完成（首次约 1-2 分钟）。' });
  },
};

// 同一时间只允许一个安装任务（避免并发下载互相干扰）
const installLock = { active: false };

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // ===== CORS：允许任何来源访问本地服务 =====
  // 供 Tauri 桌面 App WebView / 浏览器插件 / 网站 / 其它 app 接入（开放端口后端）。
  // 本服务默认绑定 127.0.0.1 仅本机，开放 CORS 不会带来外部网络风险。
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // 预检请求直接放行
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

  // ===== 安全加固：入站鉴权（S7）=====
  // TABU_TOKEN 由 Tauri 宿主注入（config.json ui.token 自动生成，并经 get_ui_settings 同步给前端，
  // 前端 api.ts jfetch 自动带 Authorization: Bearer）。为空（手动 npm start 调试）时不校验。
  // /health 免检：宿主健康轮询不带凭据，且信息面仅版本/引擎状态。
  if (TABU_TOKEN && req.method !== 'OPTIONS' && !(req.method === 'GET' && url.pathname === '/health')) {
    const auth = req.headers['authorization'] || '';
    const got = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (got !== TABU_TOKEN) {
      log('⚠️ 拒绝未授权请求: ' + req.method + ' ' + url.pathname + (auth ? '（token 不符）' : '（缺少 token）'));
      return send(401, { error: 'unauthorized: 缺少或错误的 Bearer token' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    // TTS 状态：kokoro 就绪（含音色数）/ missing（模型未下载）/ not-installed（未装 sherpa-onnx-node）
    let sherpaNodeInstalled = true;
    try {
      const { createRequire } = await import('node:module');
      createRequire(import.meta.url)('sherpa-onnx-node');
    } catch (e) { sherpaNodeInstalled = false; }
    let kokoroStatus = sherpaNodeInstalled ? (kokoroReady() ? 'ready' : 'missing') : 'not-installed';
    let kokoroSpeakers = null;
    if (kokoroStatus === 'ready') {
      try { kokoroSpeakers = (await getKokoroTts()).numSpeakers; }
      catch (e) { kokoroStatus = 'missing'; }
    }
    const qwen3 = await checkQwen3();
    const llmDefaultReady = llmReady(); // 默认 LLM 是否就绪
    const ollamaStatus = await checkOllama();
    return send(200, {
      ok: true,
      version: SERVER_VERSION,
      engines: ['whisper', existsSync(SENSEVOICE_MODEL) ? 'sensevoice' : 'sensevoice(未下载)', 'sensevoice-original'],
      tts: { kokoro: kokoroStatus, kokoroSpeakers, qwen3, cosyvoice: await checkCosyvoice() },
      llm: { engine: 'llama-cpp', model: llmDefaultReady ? path.basename(LLM_MODEL) : 'missing', ollama: ollamaStatus },
      models: await collectModels(), // 014 §5.2：已装模型清单（/models 同款）
      port: PORT
    });
  }

  // 本地 TTS：POST /speak?engine=kokoro|qwen3  body=JSON { text, sid, speed, voice, language }
  // 013-P1：流式返回（Content-Type: application/octet-stream），帧协议 = 4 字节大端长度 + 一段 WAV；
  //   经 TTS_ENGINES 注册表路由（014 §5.2）：kokoro → 逐句多帧；qwen3 → 透传 Python 服务 ?stream=1 帧流（013-P2①）
  if (req.method === 'POST' && url.pathname === '/speak') {
    let body = {};
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
    } catch (e) {
      return send(400, { error: '请求体必须是 JSON' });
    }
    const text = String(body.text || '').trim();
    if (!text) return send(400, { error: '缺少 text' });
    const engine = (url.searchParams.get('engine') || 'kokoro').toLowerCase();
    const eng = TTS_ENGINES[engine];
    if (!eng) return send(400, { error: '未知引擎: ' + engine + '（支持 ' + Object.keys(TTS_ENGINES).join(' / ') + '）' });
    const maxLen = engine === 'qwen3' ? 2000 : 30000;
    if (text.length > maxLen) return send(400, { error: 'text 过长（≤' + maxLen + ' 字），请分段朗读' });
    try {
      await eng.stream(res, { text, sid: body.sid, speed: body.speed, voice: body.voice, language: body.language, cloud: body.cloud, azure: body.azure, cosyvoice: body.cosyvoice });
    } catch (e) {
      log('TTS 错误: ' + e.message);
      if (!res.headersSent) return send(500, { error: e.message });
      try { res.end(); } catch (e2) {}
    }
    return;
  }

  // 克隆音色：POST /clone  body=JSON { name, referenceText, wavBase64 } → 生成/更新一个克隆音色（转发 cosyvoice 服务）
  if (req.method === 'POST' && url.pathname === '/clone') {
    let body = {};
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
    } catch (e) {
      return send(400, { error: '请求体必须是 JSON' });
    }
    try {
      const up = await fetch(COSYVOICE_URL + '/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: body.name, referenceText: body.referenceText, wavBase64: body.wavBase64
        }),
        signal: AbortSignal.timeout(180000),
      });
      const data = await up.json().catch(() => ({}));
      return send(up.ok ? 200 : 500, data);
    } catch (e) {
      log('克隆失败: ' + e.message);
      return send(500, { error: '克隆服务不可用：' + e.message + '（请确认 cosyvoice 服务已启动）' });
    }
  }

  // 克隆音色：GET /voices → { voices: [...] }；POST /voice/rename、/voice/delete → 转发 cosyvoice 服务
  if (req.method === 'GET' && url.pathname === '/voices') {
    try {
      const up = await fetch(COSYVOICE_URL + '/voices', { signal: AbortSignal.timeout(3000) });
      const data = await up.json().catch(() => ({}));
      return send(up.ok ? 200 : 500, data);
    } catch (e) {
      return send(500, { error: '克隆服务不可用：' + e.message });
    }
  }
  // 克隆音色试听：GET /voice-preview?voiceId=xxx → 预生成的 WAV（避免每次现场合成等待）
  if (req.method === 'GET' && url.pathname === '/voice-preview') {
    const vid = url.searchParams.get('voiceId') || '';
    try {
      const up = await fetch(COSYVOICE_URL + '/voice-preview?voiceId=' + encodeURIComponent(vid), { signal: AbortSignal.timeout(5000) });
      if (!up.ok) {
        const data = await up.json().catch(() => ({}));
        return send(404, { error: data.error || '该音色暂无预览音频' });
      }
      const buf = Buffer.from(await up.arrayBuffer());
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.length });
      return res.end(buf);
    } catch (e) {
      return send(500, { error: '克隆服务不可用：' + e.message });
    }
  }
  if ((req.method === 'POST') && (url.pathname === '/voice/rename' || url.pathname === '/voice/delete')) {
    let body = {};
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
    } catch (e) {
      return send(400, { error: '请求体必须是 JSON' });
    }
    try {
      const up = await fetch(COSYVOICE_URL + url.pathname, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      const data = await up.json().catch(() => ({}));
      return send(up.ok ? 200 : 500, data);
    } catch (e) {
      return send(500, { error: '克隆服务不可用：' + e.message });
    }
  }

  // 本地 LLM：POST /chat  body=JSON { messages, engine?, temperature?, top_p?, maxTokens?, model? } → { text, engine }
  if (req.method === 'POST' && url.pathname === '/chat') {
    let body = {};
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
    } catch (e) {
      return send(400, { error: '请求体必须是 JSON' });
    }
    const messages = Array.isArray(body.messages) ? body.messages.filter(m => m && typeof m.content === 'string') : [];
    if (!messages.some(m => m.role === 'user' && String(m.content).trim())) {
      return send(400, { error: '缺少 user 消息' });
    }
    try {
      const text = await llmChat(body.engine, messages, {
        temperature: body.temperature, top_p: body.top_p, maxTokens: body.maxTokens, model: body.model,
        apiKey: body.apiKey
      });
      return send(200, { text, engine: (body.engine || 'llama-cpp').toLowerCase() });
    } catch (e) {
      log('LLM 错误: ' + e.message);
      return send(500, { error: e.message });
    }
  }

  // 全链路：POST /voice-chat  body=WAV 音频；参数走 query → 识别→LLM→朗读 → WAV 二进制
  //   asrEngine=auto|sensevoice|whisper · llmEngine=llama-cpp|ollama · ttsEngine=kokoro|qwen3
  //   prompt=追加指令 · system=系统提示 · voice/sid/language=TTS 参数
  if (req.method === 'POST' && url.pathname === '/voice-chat') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const audio = Buffer.concat(chunks);
    if (audio.length < 100) return send(400, { error: '音频数据过短' });
    const asrEngine = (url.searchParams.get('asrEngine') || 'auto').toLowerCase();
    const llmEngine = (url.searchParams.get('llmEngine') || 'llama-cpp').toLowerCase();
    const ttsEngine = (url.searchParams.get('ttsEngine') || 'kokoro').toLowerCase();
    const prompt = url.searchParams.get('prompt') || '';
    const system = url.searchParams.get('system') || '你是一个本地语音助手，用简洁的中文回答用户。';
    try {
      // ① 识别
      const pcm16 = decodeToPcm16(audio);
      const hasSense = existsSync(SENSEVOICE_MODEL);
      let recognized;
      if (asrEngine === 'sensevoice') recognized = await transcribeSenseVoice(pcm16);
      else if (asrEngine === 'sensevoice-original') recognized = await transcribeSenseVoiceOriginal(pcm16);
      else if (asrEngine === 'whisper') recognized = await whisperTranscribe(pcm16);
      else recognized = hasSense ? await transcribeSenseVoice(pcm16) : await whisperTranscribe(pcm16);
      const wantPunc = PUNCTUATION && url.searchParams.get('punct') !== '0' || url.searchParams.get('punct') === '1';
      if (wantPunc) recognized = await punctuate(recognized);
      // ② LLM
      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: (prompt ? prompt + '\n' : '') + recognized }
      ];
      const answer = await llmChat(llmEngine, messages, {
        model: url.searchParams.get('llmModel') || undefined,
        apiKey: url.searchParams.get('llmApiKey') || undefined
      });
      log('voice-chat 识别:「' + recognized + '」→ LLM:「' + answer + '」');
      // ③ 朗读（qwen3 不可达时自动回退 kokoro，保证全链路始终可用）；经 TTS_ENGINES.wav() 统一（014 §5.2）
      let wav;
      let actualTts = ttsEngine;
      const ttsEng = ttsEngine === 'qwen3' ? TTS_ENGINES.qwen3
        : ttsEngine === 'clone' ? TTS_ENGINES.clone
        : TTS_ENGINES.kokoro;
      try {
        wav = await ttsEng.wav({
          text: answer,
          sid: url.searchParams.get('sid'),
          speed: 1,
          voice: url.searchParams.get('voice') || undefined,
          language: url.searchParams.get('language') || undefined,
        });
      } catch (e) {
        if (ttsEng !== TTS_ENGINES.kokoro) {
          log('voice-chat Qwen3 失败，回退 Kokoro: ' + e.message);
          actualTts = 'kokoro';
          wav = await synthesizeKokoro(answer, url.searchParams.get('sid'), 1);
        } else throw e;
      }
      // ?fmt=json：一次返回 识别文本 + 回答 + base64 音频（供插件显示文本并播放）
      if (url.searchParams.get('fmt') === 'json') {
        return send(200, { recognized, answer, engine: actualTts, audioBase64: wav.toString('base64') });
      }
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
      return res.end(wav);
    } catch (e) {
      log('voice-chat 错误: ' + e.message);
      return send(500, { error: e.message });
    }
  }

  // 模型清单：GET /models → { models: [{ category, engine, label, size, installed }] }（014 §5.2）
  if (req.method === 'GET' && url.pathname === '/models') {
    return send(200, { models: await collectModels() });
  }

  // 取消当前下载（S3）：杀掉活动 curl，.part 保留供续传
  if (req.method === 'POST' && url.pathname === '/install-cancel') {
    if (ACTIVE_DOWNLOAD.proc) {
      try { ACTIVE_DOWNLOAD.proc.kill('SIGTERM'); } catch {}
      return send(200, { ok: true, message: '已发送取消信号' });
    }
    return send(200, { ok: false, message: '当前没有进行中的下载' });
  }

  // 磁盘剩余空间（S3：模型管理面板展示；031 跨平台：statfsSync 替代 df -k，Win/mac 通用）
  if (req.method === 'GET' && url.pathname === '/disk') {
    try {
      const st = statfsSync(__dirname);
      const availBytes = Number(st.bavail) * Number(st.bsize);
      return send(200, { availBytes });
    } catch { return send(200, { availBytes: null }); }
  }

  // 设备画像：GET /device-profile → 设备画像 + 模型匹配（000-device-vs-model.md §四，启动探测一次并缓存）
  if (req.method === 'GET' && url.pathname === '/device-profile') {
    if (!DEVICE_PROFILE) return send(503, { error: '设备探测失败（见服务端日志）' });
    return send(200, DEVICE_PROFILE);
  }

  // 模型安装：POST /install-model?engine=<name>[&mirror=<name>] → NDJSON 流式进度（每行 { type:'log'|'done'|'error', message }）
  if (req.method === 'POST' && url.pathname === '/install-model') {
    const engine = (url.searchParams.get('engine') || '').toLowerCase();
    const mirror = url.searchParams.get('mirror') || undefined;
    // S5：confirm=1 表示用户已在 UI 二次确认大流量下载（目前仅 cosyvoice-clone 使用）
    const confirmBigDownload = ['1', 'true', 'yes'].includes((url.searchParams.get('confirm') || '').toLowerCase());
    const installer = INSTALLERS[engine];
    if (!installer) return send(400, { error: '未知模型: ' + engine + '（支持 ' + Object.keys(INSTALLERS).join(' / ') + '）' });
    if (installLock.active) return send(409, { error: '已有安装任务进行中，请稍后再试' });
    installLock.active = true;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    res.flushHeaders();
    const ctx = { nd: (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch (e) {} } };
    try {
      await installer(ctx, { mirror, confirmBigDownload });
      // LLM 模型下载完成后清空加载缓存，下次对话无需重启即可直接加载新模型
      if (LLM_MODELS[engine]) llmInvalidate();
    } catch (e) {
      ctx.nd({ type: 'error', message: String((e && e.message) || e) });
    } finally {
      installLock.active = false;
      try { res.end(); } catch (e2) {}
    }
    return;
  }

  // VAD：POST /vad  body=RAW PCM16(16k) → { speech: [[start_ms,end_ms],...] }（供前端"录音静音自动停"检测）
  if (req.method === 'POST' && url.pathname === '/vad') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const audio = Buffer.concat(chunks);
    try {
      const pcm16 = decodeToPcm16(audio);
      const segs = await getVadSegments(pcm16);
      return send(200, { speech: segs });
    } catch (e) {
      return send(500, { error: e.message });
    }
  }

  if (req.method !== 'POST' || url.pathname !== '/transcribe') {
    return send(404, { error: 'not found' });
  }

  // 引擎：sensevoice / sensevoice-original / whisper / auto（默认 auto = SenseVoice 优先，中文最优）
  // 默认引擎可由环境变量 ASR_ENGINE 覆盖（如 ASR_ENGINE=whisper 强制 Whisper）
  let engine = (url.searchParams.get('engine') || ASR_ENGINE).toLowerCase();
  const hasSenseVoice = existsSync(SENSEVOICE_MODEL) && existsSync(SENSEVOICE_TOKENS);
  if (engine === 'auto') engine = hasSenseVoice ? 'sensevoice' : 'whisper';
  if (engine === 'sensevoice' && !hasSenseVoice) {
    return send(400, { error: 'SenseVoice 模型未下载，请运行 npm run download-sensevoice（或改用 ?engine=whisper）' });
  }
  if (!['sensevoice', 'sensevoice-original', 'whisper'].includes(engine)) {
    return send(400, { error: '未知引擎: ' + engine + '（支持 sensevoice / sensevoice-original / whisper）' });
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (body.length < 100) return send(400, { error: '音频数据过短' });

  try {
    const pcm16 = decodeToPcm16(body);
    if (pcm16.length < 1600) return send(400, { error: '音频太短' });
    // 诊断：时长与音量（RMS），排查"静音/噪声导致幻觉"
    const dur = pcm16.length / 16000;
    let sum = 0;
    for (let i = 0; i < pcm16.length; i++) sum += pcm16[i] * pcm16[i];
    const rms = Math.sqrt(sum / pcm16.length);
    if (rms < 0.01) log('⚠️ 音频几乎静音: 时长 ' + dur.toFixed(1) + 's, RMS=' + rms.toFixed(4));
    else log('音频正常: 时长 ' + dur.toFixed(1) + 's, RMS=' + rms.toFixed(4));
    // VAD 过滤静音（可选）：识别前只保留有效语音段
    let infer = pcm16;
    const wantVad = VAD && url.searchParams.get('vad') !== '0' || url.searchParams.get('vad') === '1';
    if (wantVad) {
      const segs = await getVadSegments(pcm16);
      const t = trimPcmByVad(pcm16, segs);
      if (t.length >= 1600) infer = t;
    }
    let text;
    if (engine === 'sensevoice') text = await transcribeSenseVoice(infer);
    else if (engine === 'sensevoice-original') text = await transcribeSenseVoiceOriginal(infer);
    else text = await whisperTranscribe(infer);
    const wantPunc = PUNCTUATION && url.searchParams.get('punct') !== '0' || url.searchParams.get('punct') === '1';
    if (wantPunc) text = await punctuate(text);
    send(200, { text, engine, durationSec: Math.round(dur * 10) / 10, rms: Math.round(rms * 10000) / 10000 });
  } catch (e) {
    log('识别错误: ' + e.message);
    send(500, { error: e.message });
  }
});

async function whisperTranscribe(pcm16) {
  const p = await getWhisper();
  const out = await p(pcm16, { return_timestamps: false });
  return String(out && out.text || '').trim();
}

server.listen(PORT, '127.0.0.1', () => log('TabU 本地语音服务已启动: http://127.0.0.1:' + PORT + '（仅本机回环；/transcribe 识别，/speak 朗读）'));
