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
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY = path.join(__dirname, '.venv-qwen3', 'bin', 'python3');
const ASR_URL = (process.env.ASR_SERVER_URL || 'http://127.0.0.1:9528').replace(/\/+$/, '');
const QWEN3_URL = (process.env.QWEN3_TTS_URL || 'http://127.0.0.1:8001').replace(/\/+$/, '');
const SKIP_QWEN3 = ['1', 'true', 'yes'].includes(String(process.env.TABU_SKIP_QWEN3 || '').toLowerCase());

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

const [asrUp, qwen3Up] = await Promise.all([up(ASR_URL), SKIP_QWEN3 ? false : up(QWEN3_URL)]);
let started = 0;

if (asrUp) {
  console.log(`[start-all] asr-server 已在运行（${ASR_URL}），跳过`);
} else {
  console.log('[start-all] 启动 asr-server…');
  // ASR_ENGINE 透传给 asr-server.js，用于选择默认识别模型（sensevoice/whisper）
  run(process.execPath, [path.join(__dirname, 'asr-server.js')], 'asr-server', {
    ASR_ENGINE: process.env.ASR_ENGINE || 'auto'
  });
  started++;
}

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

if (!started) {
  console.log('[start-all] asr-server 与 qwen3-tts 均已运行，无需启动。');
}
