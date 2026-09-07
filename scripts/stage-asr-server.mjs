// ========== S6′ stage 脚本：把 asr-server 必要代码子集收集为 .app 内置模板 ==========
// 用法：npm run stage:server（或 node scripts/stage-asr-server.mjs）
// 目标：src-tauri/resources/asr-server/  ← tauri.conf.json bundle.resources 引用，随 .app 分发
// 原则（002-plan S6′ 拍板）：
//   1. 每次打包**现场从仓库生成**，杜绝复用旧 resources（asr-server 历次修复只有重新 stage 才进产物）；
//   2. 只含必要代码（JS/PY + vendor 子集 + engines/*.json + locks + package 双件 + .npmrc），
//      任何可安装项（node_modules/.venv-*/models/cache/data/voices）一律不打包；
//   3. .version 指纹 = asr-server.js 的 SERVER_VERSION（单一来源，打包时三处指纹必然一致）；
//   4. 目标目录每次先整删再生成（幂等、无旧文件残留）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SRC = path.join(root, 'asr-server');
const DEST = path.join(root, 'src-tauri', 'resources', 'asr-server');

// ---------- 排除规则（任意层级） ----------
const SKIP_DIR_NAMES = new Set([
  'node_modules', 'models', 'cache', 'data', 'voices', '__pycache__',
  '.git', '.svn', '.hg', '.DS_Store', 'node_modules.old',
]);
const SKIP_DIR_PREFIXES = ['.venv-']; // .venv-qwen3 / .venv-funasr / .venv-cosyvoice …

function skipDir(name) {
  return SKIP_DIR_NAMES.has(name) || SKIP_DIR_PREFIXES.some((p) => name.startsWith(p));
}

function skipFile(name) {
  if (name === '.DS_Store') return true;
  // test-*.mjs 属开发自测脚本（test-qwen13.mjs），不进产物
  if (name.startsWith('test-') && name.endsWith('.mjs')) return true;
  return false;
}

// ---------- 包含规则（相对 SRC 的 rel 路径） ----------
//   vendor/            → 整树（cosyvoice 源码子集，S4 vendoring）
//   engines/           → 仅 *.json（引擎清单）
//   根级文件           → *.js / *.py / requirements-*.lock / package.json / package-lock.json / .npmrc
function includeFile(rel, name) {
  if (skipFile(name)) return false;
  const parts = rel.split(path.sep);
  const depth = parts.length - 1; // 0 = 根级文件
  const top = parts[0];
  if (top === 'vendor') return true;
  if (top === 'engines') return name.endsWith('.json');
  if (depth === 0) {
    return (
      name.endsWith('.js') ||
      name.endsWith('.py') ||
      /^requirements-.+\.lock$/.test(name) ||
      name === 'package.json' ||
      name === 'package-lock.json' ||
      name === '.npmrc'
    );
  }
  return false;
}

// ---------- 读取 SERVER_VERSION（.version 单一来源） ----------
function readServerVersion() {
  const src = path.join(SRC, 'asr-server.js');
  const js = fs.readFileSync(src, 'utf8');
  const m = js.match(/SERVER_VERSION\s*=\s*'([^']+)'/);
  if (!m) throw new Error(`无法从 ${src} 解析 SERVER_VERSION，.version 指纹无从生成`);
  return m[1].trim();
}

// ---------- 自检：关键文件在 + 可安装项绝不在 ----------
const FORBIDDEN_TOP = ['node_modules', 'models', 'cache', 'data', 'voices', '__pycache__'];
const MUST_HAVE = [
  'start-all.js',
  'asr-server.js',
  'package.json',
  'package-lock.json',
  'vendor/cosyvoice/cosyvoice/cli/cosyvoice.py', // cosyvoice-clone.json 就绪检查点
  'requirements-cosyvoice.lock',
];

function verifyStaged() {
  const problems = [];
  for (const rel of MUST_HAVE) {
    if (!fs.existsSync(path.join(DEST, rel))) problems.push(`缺少必需文件：${rel}`);
  }
  // engines/*.json 至少 1 份
  const engDir = path.join(DEST, 'engines');
  if (!fs.existsSync(engDir) || fs.readdirSync(engDir).filter((f) => f.endsWith('.json')).length === 0) {
    problems.push('engines/*.json 为空');
  }
  for (const name of fs.readdirSync(DEST)) {
    if (FORBIDDEN_TOP.includes(name) || name.startsWith('.venv-')) {
      problems.push(`产物内出现禁止项：${name}`);
    }
  }
  if (problems.length > 0) {
    throw new Error('stage 自检失败：\n  ' + problems.join('\n  '));
  }
}

// ---------- 目录总字节数 ----------
function dirBytes(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirBytes(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

// ---------- 主流程 ----------
const version = readServerVersion();
console.log(`[stage] asr-server → ${path.relative(root, DEST)} (SERVER_VERSION=${version})`);

// 整删重建：幂等、无旧文件残留（resources 目录是生成物，见 .gitignore）
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

let copied = 0;
let bytes = 0;
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(SRC, abs);
    if (e.isDirectory()) {
      if (skipDir(e.name)) {
        console.log(`[stage]  跳过目录  ${rel}/`);
        continue;
      }
      walk(abs);
    } else if (!e.isFile()) {
      // 非普通文件（符号链接/套接字/FIFO 等）：vendor 里的 symlink 均为 examples 数据集指针
      // （如 examples/libritts/cosyvoice2/local → ../cosyvoice/local），运行期用不到，跳过不进产物
      console.log(`[stage]  跳过特殊  ${rel}`);
    } else if (includeFile(rel, e.name)) {
      const dstAbs = path.join(DEST, rel);
      fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
      fs.copyFileSync(abs, dstAbs);
      copied++;
      bytes += e.size || fs.statSync(abs).size;
    }
  }
}
walk(SRC);

// .version 最后写（复制中断/未完成时指纹缺失/不符 → 下次启动自动重物化）
fs.writeFileSync(path.join(DEST, '.version'), version + '\n');

verifyStaged();

// EXPECTED_VERSION 一致性提示（start-all.js 探测旧进程用；.version 以 SERVER_VERSION 为准）
const startAll = fs.readFileSync(path.join(SRC, 'start-all.js'), 'utf8');
const ev = startAll.match(/EXPECTED_VERSION\s*=\s*'([^']+)'/)?.[1]?.trim();
if (ev && ev !== version) {
  console.warn(`[stage] ⚠️ start-all.js EXPECTED_VERSION=${ev} 与 SERVER_VERSION=${version} 不一致（旧进程探测会误判重启），请同步升版`);
}

console.log(`[stage] 完成：${copied} 个文件 / ${(bytes / 1024 / 1024).toFixed(2)} MB（不含可安装项与模型）`);
console.log(`[stage] 自检通过：必需文件齐全，无 node_modules/.venv-*/models/cache/data/voices/__pycache__`);
