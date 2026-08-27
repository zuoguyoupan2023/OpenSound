// 下载 SenseVoice 模型（sherpa-onnx，中文最优）到 asr-server/models/sensevoice/
// 用法：cd asr-server && npm run download-sensevoice
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 032 P3：模型落数据目录（env 注入；未设置回退代码目录）
const DIR = path.join(process.env.OPENSOUND_DATA_DIR || __dirname, 'models', 'sensevoice');
mkdirSync(DIR, { recursive: true });

const BASE = 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main';
const FILES = ['model.int8.onnx', 'tokens.txt'];

async function download(url, dest) {
  const res = await fetch(url); // fetch 自动跟随重定向
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
  await pipeline(res.body, createWriteStream(dest));
}

for (const file of FILES) {
  const dest = path.join(DIR, file);
  if (existsSync(dest)) { console.log('已存在，跳过:', file); continue; }
  console.log('下载', file, '…');
  await download(BASE + '/' + file, dest);
  console.log('完成:', file);
}
console.log('✅ SenseVoice 模型就绪：' + DIR);
