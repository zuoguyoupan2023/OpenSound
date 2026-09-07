// ========== S6′ CI 体积红线：发布物内出现可安装项即失败 ==========
// 用法：npm run check:dist（或 node scripts/check-dist-artifacts.mjs [dir]）
// 原则（002 §五 5.4 / S6′）：发布物只含必要代码；任何 node_modules / .venv-* / models /
// cache / data / voices / __pycache__ 出现在打包资源里 = 打包边界被突破 → 退出码 1。
// 说明：stage 脚本自身已对 src-tauri/resources/asr-server 做同等自检；本脚本对**最终 bundle
// 产物**复核（防 tauri.conf bundle.resources 之外途径夹带，mac .app 内可完整扫描；
// Windows NSIS/MSI 为压缩包，CI 侧用同样规则在解包/7z 列表后复核）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const scanRoot = path.resolve(process.argv[2] || path.join(root, 'src-tauri', 'target', 'release', 'bundle'));

// 命中即判为可安装项（目录名或文件名的**任意路径段**）
const FORBIDDEN_EXACT = new Set(['node_modules', 'models', 'cache', 'data', 'voices', '__pycache__']);
const FORBIDDEN_PREFIXES = ['.venv-'];

function isForbidden(name) {
  return FORBIDDEN_EXACT.has(name) || FORBIDDEN_PREFIXES.some((p) => name.startsWith(p));
}

function walk(dir, rel, hits) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (isForbidden(e.name)) {
      hits.push(r);
      continue; // 不再深入（报告该目录即可）
    }
    if (e.isDirectory()) walk(abs, r, hits);
  }
}

if (!fs.existsSync(scanRoot)) {
  console.log(`[check:dist] 未找到产物目录：${scanRoot}\n（先执行 npm run build 生成 bundle）`);
  process.exit(0);
}

const hits = [];
walk(scanRoot, '', hits);

if (hits.length > 0) {
  console.error(`[check:dist] ✗ 体积红线被突破：发布物内出现可安装项/模型/缓存（${scanRoot}）`);
  for (const h of hits.slice(0, 50)) console.error('  ' + h);
  if (hits.length > 50) console.error(`  … 等共 ${hits.length} 处`);
  process.exit(1);
}
console.log(`[check:dist] ✅ 红线通过：${scanRoot}\n   无 node_modules / .venv-* / models / cache / data / voices / __pycache__`);
