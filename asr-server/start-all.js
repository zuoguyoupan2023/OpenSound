// ========== 一键启动：asr-server(9528) + qwen3-tts(8001) ==========
// 用法：npm run all
// 幂等：已运行的服务自动跳过（分别探测 /health）；全部已运行则直接退出。
// 两个子进程均继承本终端 stdio，Ctrl+C 会一起退出。
//
// 可选环境变量：
//   TABU_SKIP_QWEN3=1        只启动 asr-server，不拉 qwen3-tts（省内存/时间）
//   HF_ENDPOINT=...          qwen3 模型下载/校验源（默认 hf-mirror.com 国内镜像）
//   HF_HUB_OFFLINE=1         强制离线（qwen3 模型已缓存时，可彻底避免联网）
//   ASR_ENGINE=sensevoice|whisper   只针对 asr-server 的默认识别模型（传给 asr-server.js）
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY = path.join(__dirname, '.venv-qwen3', 'bin', 'python3');
// CosyVoice3 克隆服务用 .venv-cosyvoice（复用系统 torch + 本地 CosyVoice 源码）
const PY_COSYVOICE = path.join(__dirname, '.venv-cosyvoice', 'bin', 'python3');
// SenseVoice 原始版（funasr）用系统 python（/opt/homebrew/bin/python3 已装 funasr/torch/modelscope）
const PY_SYS = (process.env.PY_SYS || '/opt/homebrew/bin/python3');
const ASR_URL = (process.env.ASR_SERVER_URL || 'http://127.0.0.1:9528').replace(/\/+$/, '');
const QWEN3_URL = (process.env.QWEN3_TTS_URL || 'http://127.0.0.1:8001').replace(/\/+$/, '');
const SENSE_ORIGINAL_URL = (process.env.SENSEVOICE_ORIGINAL_URL || 'http://127.0.0.1:8002').replace(/\/+$/, '');
const COSYVOICE_URL = (process.env.COSYVOICE_URL || 'http://127.0.0.1:8003').replace(/\/+$/, '');
const SKIP_QWEN3 = ['1', 'true', 'yes'].includes(String(process.env.TABU_SKIP_QWEN3 || '').toLowerCase());
// 默认启动 cosyvoice 克隆服务（加载 ~9GB 模型较慢、占 ~4GB 内存）；设 TABU_SKIP_COSYVOICE=1 可跳过
const SKIP_COSYVOICE = ['1', 'true', 'yes'].includes(String(process.env.TABU_SKIP_COSYVOICE || '').toLowerCase());
// 默认启动 funasr 原始版（让 UI 两个版本都可用）；设 TABU_SKIP_SENSEVOICE_ORIGINAL=1 可跳过（省 900MB 内存/加载时间）
const SKIP_SENSE_ORIGINAL = ['1', 'true', 'yes'].includes(String(process.env.TABU_SKIP_SENSEVOICE_ORIGINAL || '').toLowerCase());
// 期望的 asr-server 架构版本（须与 asr-server.js 的 SERVER_VERSION 一致）：
// 若 9528 上的服务 version 与之不符 → 判定为旧进程残留 → 终止后重启。
const EXPECTED_VERSION = '2.1.0';

function run(cmd, args, name, env = {}) {
  const p = spawn(cmd, args, { stdio: 'inherit', cwd: __dirname, env: { ...process.env, ...env } });
  p.on('exit', (code) => console.log(`[start-all] ${name} 退出 (code=${code})`));
  return p;
}

async function up(url) {
  try {
    const r = await fetch(url + '/health', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

// 探测 + 读取版本指纹（用于识别旧 asr-server）
async function probe(url) {
  try {
    const r = await fetch(url + '/health', { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { up: false, version: null };
    const d = await r.json();
    return { up: true, version: d.version || null };
  } catch { return { up: false, version: null }; }
}

// 返回占用某端口(仅 TCP 监听)的进程 PID 列表（macOS/Linux 用 lsof；跨平台可换 netstat）
function portPids(port) {
  try {
    const out = execSync(`lsof -ti tcp:${port}`).toString().trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch { return []; }
}
function killPids(pids) {
  for (const p of pids) {
    try { process.kill(Number(p), 'SIGTERM'); } catch {}
  }
}

// asr-server(9528)：若端口被旧版本占用，终止残留进程后重启
let asrState = await probe(ASR_URL);
if (asrState.up && asrState.version !== EXPECTED_VERSION) {
  const pids = portPids(9528);
  console.log(`[start-all] 9528 上是旧版 asr-server（v=${asrState.version}，期望 v${EXPECTED_VERSION}）→ 终止残留进程后重启`);
  killPids(pids);
  await new Promise(r => setTimeout(r, 800)); // 等端口释放
  asrState = { up: false, version: null };
}

let started = 0;
if (asrState.up) {
  console.log(`[start-all] asr-server 已在运行（${ASR_URL}, v${asrState.version}），跳过`);
} else {
  console.log('[start-all] 启动 asr-server…');
  // ASR_ENGINE 透传给 asr-server.js，用于选择默认识别模型（sensevoice/whisper）
  run(process.execPath, [path.join(__dirname, 'asr-server.js')], 'asr-server', {
    ASR_ENGINE: process.env.ASR_ENGINE || 'auto'
  });
  started++;
}

const [qwen3Up, svOriginalUp, cosyvoiceUp] = await Promise.all([
  SKIP_QWEN3 ? false : up(QWEN3_URL),
  SKIP_SENSE_ORIGINAL ? false : up(SENSE_ORIGINAL_URL),
  SKIP_COSYVOICE ? false : up(COSYVOICE_URL),
]);

if (SKIP_QWEN3) {
  console.log('[start-all] TABU_SKIP_QWEN3=1，跳过 qwen3-tts');
} else if (qwen3Up) {
  console.log(`[start-all] qwen3-tts 已在运行（${QWEN3_URL}），跳过`);
} else {
  console.log('[start-all] 启动 qwen3-tts（首次会下载/加载模型，较慢）…');
  // qwen3 默认走 hf-mirror（模型已缓存则直接加载，仅信息校验走镜像，避免 huggingface.co 超时）
  // 用户若已设 HF_ENDPOINT / HF_HUB_OFFLINE 会自动透传覆盖
  run(PY, ['qwen3-tts-server.py', '--port', '8001'], 'qwen3-tts', {
    HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com'
  });
  started++;
}

if (SKIP_SENSE_ORIGINAL) {
  console.log('[start-all] TABU_SKIP_SENSEVOICE_ORIGINAL=1，跳过 SenseVoice 原始版(funasr)');
} else if (svOriginalUp) {
  console.log(`[start-all] sensevoice-original 已在运行（${SENSE_ORIGINAL_URL}），跳过`);
} else {
  console.log('[start-all] 启动 sensevoice-original（funasr 原始版，加载 ~900MB 模型，较慢）…');
  run(PY_SYS, ['sensevoice-server.py', '--port', '8002'], 'sensevoice-original');
  started++;
}

if (SKIP_COSYVOICE) {
  console.log('[start-all] TABU_SKIP_COSYVOICE=1，跳过 CosyVoice3 克隆服务');
} else if (cosyvoiceUp) {
  console.log(`[start-all] cosyvoice 已在运行（${COSYVOICE_URL}），跳过`);
} else {
  console.log('[start-all] 启动 cosyvoice-tts-server（加载 ~9GB 模型，首次较慢）…');
  run(PY_COSYVOICE, ['cosyvoice-tts-server.py', '--port', '8003'], 'cosyvoice-tts', {
    NUMBA_CACHE_DIR: process.env.NUMBA_CACHE_DIR || '/tmp/numba_cache',
    MPLCONFIGDIR: process.env.MPLCONFIGDIR || '/tmp/mpl',
  });
  started++;
}

if (!started) {
  console.log('[start-all] asr-server 与 qwen3-tts 均已运行，无需启动。');
}
