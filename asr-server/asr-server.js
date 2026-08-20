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
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parsePort(process.argv);
const MODEL_SIZE = process.env.ASR_MODEL_SIZE || 'base'; // tiny | base | small | medium（whisper 兜底档位）
const ASR_ENGINE = (process.env.ASR_ENGINE || 'auto').toLowerCase(); // auto | sensevoice | whisper —— 选择默认识别模型
// asr-server 架构版本：2.x = 含 sensevoice-original + VAD + 标点。
// 供 start-all.js 探测时判断 9528 上是否旧进程（旧代码无此字段/不同版本 → 视为残留，终止后重启）。
const SERVER_VERSION = '2.2.0';
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

async function getLlamaSession(modelPath) {
  // 若已加载且路径一致则复用；否则换模型重载（同一时间只保留一个活跃模型，省内存）
  if (llmSession && llmSessionPath === modelPath) return llmSession;
  if (llmInitError) throw new Error(llmInitError);
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

async function llmChat(engine, messages, opts = {}) {
  const e = (engine || 'llama-cpp').toLowerCase();
  if (e === 'llama-cpp') return chatLlamaCpp(messages, opts);
  if (e === 'ollama') return chatOllama(messages, opts);
  throw new Error('未知 LLM 引擎: ' + e + '（支持 llama-cpp / ollama）');
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
// whisper 由 transformers.js 缓存到 models/hf/，检查目录里是否有对应模型
function whisperInstalled() {
  const hfDir = path.join(CACHE_DIR, 'hf');
  if (!existsSync(hfDir)) return false;
  try { return readdirSync(hfDir).some((n) => n.includes('whisper')); } catch { return false; }
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
  for (const m of MODEL_ITEMS) {
    out.push({ category: m.category, engine: m.engine, label: m.label, size: m.size, installed: !!(await m.installed()) });
  }
  return out;
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

mkdirSync(LLM_DIR, { recursive: true }); // 供 LLM 模型落盘

const INSTALLERS = {
  kokoro: runDownload(process.execPath, ['download-kokoro.js']),
  sensevoice: runDownload(process.execPath, ['asr-server-download.js']),
  // 多档位 LLM 模型：按 LLM_MODELS 注册表动态生成下载器
  ...Object.fromEntries(
    Object.entries(LLM_MODELS).map(([key, m]) => [
      key,
      runDownload('curl', ['-L', '-C', '-', '--connect-timeout', '15', '--max-time', '14400', '-o', path.join(LLM_DIR, m.file), m.url]),
    ])
  ),
  qwen3: (ctx) => ctx.nd({ type: 'done', message: 'Qwen3-TTS 无独立下载脚本：模型在首次启动 qwen3 服务（npm run start-qwen3）时自动下载。' }),
  whisper: (ctx) => ctx.nd({ type: 'done', message: 'Whisper 无独立下载脚本：首次识别时由 transformers.js 自动下载。' }),
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
    const llmReady = llmReady(); // 默认 LLM 是否就绪
    const ollamaStatus = await checkOllama();
    return send(200, {
      ok: true,
      version: SERVER_VERSION,
      engines: ['whisper', existsSync(SENSEVOICE_MODEL) ? 'sensevoice' : 'sensevoice(未下载)', 'sensevoice-original'],
      tts: { kokoro: kokoroStatus, kokoroSpeakers, qwen3, cosyvoice: await checkCosyvoice() },
      llm: { engine: 'llama-cpp', model: llmReady ? path.basename(LLM_MODEL) : 'missing', ollama: ollamaStatus },
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
        temperature: body.temperature, top_p: body.top_p, maxTokens: body.maxTokens, model: body.model
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
      const answer = await llmChat(llmEngine, messages, { model: url.searchParams.get('llmModel') || undefined });
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

  // 模型安装：POST /install-model?engine=<name> → NDJSON 流式进度（每行 { type:'log'|'done'|'error', message }）
  if (req.method === 'POST' && url.pathname === '/install-model') {
    const engine = (url.searchParams.get('engine') || '').toLowerCase();
    const installer = INSTALLERS[engine];
    if (!installer) return send(400, { error: '未知模型: ' + engine + '（支持 ' + Object.keys(INSTALLERS).join(' / ') + '）' });
    if (installLock.active) return send(409, { error: '已有安装任务进行中，请稍后再试' });
    installLock.active = true;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    res.flushHeaders();
    const ctx = { nd: (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch (e) {} } };
    try {
      await installer(ctx);
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

server.listen(PORT, () => log('TabU 本地语音服务已启动: http://127.0.0.1:' + PORT + '（/transcribe 识别，/speak 朗读）'));
