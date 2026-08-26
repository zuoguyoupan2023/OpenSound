// ================== device-profile：设备画像 → 模型过滤（000-device-vs-model.md §四） ==================
// 实现 4.1（GET /device-profile 的探测与数据结构）与 4.2（判级 + canInstall 判定规则）。
// 独立可测：probeDevice() 探测硬件；tierOf()/usableMemGB()/engineFit() 为纯函数。
//
// 数据口径（不得猜测，007 纪律）：
//   - 引擎资源需求一律来自 engines/<engine>.json 的 profile 段（已登记字段），
//     未登记 diskGB 时用 checks 列表的字节数求和兜底（真实登记数据，非估算）。
//   - 平台×加速矩阵：macOS=Metal/MPS、Windows=CUDA（002 §六平台表）。
//   - 架构版本：作为 asr-server 的 ESM 子模块（"type":"module"），具名导出。

import { execSync } from 'node:child_process';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// systeminformation 为可选依赖：未安装时降级为 nvidia-smi / 系统命令探测，服务照常启动。
let si = null;
try { si = require('systeminformation'); } catch { /* 可选依赖缺失：走命令兜底 */ }

const TIER_RANK = { entry: 0, standard: 1, high: 2, flagship: 3 };
const TIER_LABEL = { entry: '入门档（≥8GB 内存）', standard: '标准档（≥16GB 内存 / ≥12GB 显存）', high: '高配档（≥24GB 内存 / ≥16GB 显存）', flagship: '旗舰档（≥48GB 统一内存 / ≥24GB×2）' };

// ---------- 硬件探测 ----------
export async function probeDevice() {
  const platform = os.platform();
  const arch = os.arch();
  const ramGB = Math.round(os.totalmem() / 2 ** 30); // GiB 口径（16GiB 显示为 16，贴合文档示例）
  const appleSilicon = platform === 'darwin' && arch === 'arm64';

  let accel = 'cpu';
  let vendor = null;
  let vramGB = null;
  let cpuName = '';
  try { cpuName = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf8' }).trim(); } catch { /* 非 macOS */ }
  if (!cpuName) cpuName = (os.cpus()[0] || {}).model || '';

  if (platform === 'darwin') {
    // 002 §六平台表：macOS = Metal/MPS（Apple Silicon 统一内存；Intel Mac 亦走 Metal，无独立显存概念）
    accel = 'metal';
    vendor = appleSilicon ? 'apple' : null;
  } else {
    // Windows / Linux：优先读 NVIDIA 显存（systeminformation.graphics() 主查，nvidia-smi 兜底）
    let nvVramMB = null;
    try {
      const g = await si?.graphics?.();
      const ctrl = (g?.controllers || []).find((c) => /nvidia/i.test(String(c.vendor || '')));
      if (ctrl) { vendor = 'nvidia'; nvVramMB = ctrl.vram; }
      else if ((g?.controllers || []).length && vendor == null) vendor = g.controllers[0].vendor || null;
    } catch { /* 权限/兼容问题 → nvidia-smi 兜底 */ }
    if (!nvVramMB) {
      try {
        const out = execSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', { encoding: 'utf8' }).trim().split('\n')[0];
        if (out && !isNaN(Number(out))) nvVramMB = Number(out);
      } catch { /* 无 nvidia-smi */ }
    }
    if (nvVramMB) { accel = 'cuda'; vendor = 'nvidia'; vramGB = Math.round(nvVramMB / 1024); }
  }

  const device = {
    os: `${platform}-${arch}`,
    accel,
    ramGB,
    gpu: { vendor, vramGB },
    diskFreeGB: probeDiskFreeGB(),
    appleSilicon,
    cpuName,
  };
  device.tier = tierOf(device);
  return device;
}

// 磁盘剩余（GB）：与 /disk 同款 df 只读探测
function probeDiskFreeGB() {
  try {
    const dir = import.meta.url ? new URL('.', import.meta.url).pathname : process.cwd();
    const out = execSync(`df -k "${dir}"`).toString().trim().split('\n');
    const cols = out[out.length - 1].split(/\s+/);
    return Math.floor((Number(cols[3]) * 1024) / 1e9);
  } catch { return null; }
}

// ---------- 4.2 判定规则（伪代码落地，与 §三表格一一对应） ----------
export function tierOf(d) {
  const ram = d.ramGB || 0;
  const vram = d.gpu?.vramGB ?? 0;
  if (ram >= 48 || vram >= 48) return 'flagship'; // ram>=48 or vram>=24*2
  if (ram >= 24 || vram >= 16) return 'high';
  if (ram >= 16 || vram >= 12) return 'standard';
  return 'entry';
}

// usableMem() = apple ? totalMem*0.75 : vram ?? totalMem*0.6（4.2 伪代码）
export function usableMemGB(d) {
  const total = d.ramGB || 0;
  if (d.appleSilicon) return total * 0.75;
  if (d.gpu?.vramGB) return d.gpu.vramGB;
  return total * 0.6;
}

// 磁盘需求兜底：profile.diskGB 优先；缺失则用 checks 列表字节数求和（真实登记数据）
function engineDiskGB(engine) {
  if (engine.profile?.diskGB != null) return engine.profile.diskGB;
  const bytes = (engine.checks || []).filter((c) => c.bytes).reduce((s, c) => s + c.bytes, 0);
  return bytes > 0 ? bytes / 1e9 : null;
}

// canInstall(engine) = diskFree >= engine.diskGB*1.2 && (memNeed==null || usableMem()>=memNeed)
//                      && (accel=='any' || accel==engine.accel) && tier 满足硬件底线（§三"硬件底线"列）
// 返回 { can, isSlow, slowNote, blocks, ... }；blocks = 🚫 缺口明细（4.3 验收②）
export function engineFit(engine, device) {
  const p = engine.profile || {};
  const diskGB = engineDiskGB(engine);
  const diskNeed = diskGB != null ? diskGB * 1.2 : null; // 安装+解压余量（4.2）
  const memNeed = p.memNeedGB ?? null;
  const accelNeed = p.accel || 'any';
  const tierNeed = p.tierRequired || 'entry';

  const diskOk = diskNeed == null || device.diskFreeGB == null || device.diskFreeGB >= diskNeed;
  const memOk = memNeed == null || usableMemGB(device) >= memNeed;
  const accelOk = accelNeed === 'any' || accelNeed === device.accel;
  const tierOk = TIER_RANK[device.tier] >= TIER_RANK[tierNeed];

  const can = diskOk && memOk && accelOk && tierOk;

  const blocks = [];
  if (!diskOk) blocks.push({
    kind: 'disk', need: diskNeed, have: device.diskFreeGB,
    message: `还差 ${(diskNeed - device.diskFreeGB).toFixed(1)}GB 磁盘（需 ${diskNeed.toFixed(1)}GB）`,
  });
  if (!memOk) blocks.push({
    kind: 'mem', need: memNeed, have: usableMemGB(device),
    message: `建议 ${TIER_LABEL[tierNeed]}（可用内存/显存 ${usableMemGB(device).toFixed(1)}GB < ${memNeed}GB）`,
  });
  if (!accelOk) blocks.push({
    kind: 'accel', need: accelNeed, have: device.accel,
    message: `需 ${accelNeed} 加速（当前 ${device.accel}）`,
  });
  if (!tierOk) blocks.push({
    kind: 'tier', need: tierNeed, have: device.tier,
    message: `建议 ${TIER_LABEL[tierNeed]}机型（当前 ${TIER_LABEL[device.tier]}）`,
  });

  // ⚙️ 可装但慢：能装 + 该加速器上有慢速提示（4.3 验收①黄色徽标）
  const slowNote = can ? (p.slowNote ? p.slowNote[device.accel] || null : null) : null;

  return {
    can,
    isSlow: can && !!slowNote,
    slowNote,
    blocks,
    diskGB,
    diskNeed,
    memNeedGB: memNeed,
    accel: accelNeed,
    tierRequired: tierNeed,
  };
}

// ---------- 4.1 完整设备画像（asr-server 启动时调用一次并缓存） ----------
export async function buildDeviceProfile(manifests) {
  const device = await probeDevice();
  const fits = {};
  const canInstall = [];
  const cannotInstall = [];
  for (const mf of manifests || []) {
    const f = engineFit(mf, device);
    fits[mf.id] = f;
    if (f.can) canInstall.push(mf.id);
    else cannotInstall.push({
      engine: mf.id,
      reason: f.blocks.map((b) => b.message).join('；') || '设备不满足',
      tierRequired: mf.profile?.tierRequired || null,
    });
  }
  return {
    os: device.os,
    accel: device.accel,
    ramGB: device.ramGB,
    gpu: device.gpu,
    diskFreeGB: device.diskFreeGB,
    tier: device.tier,
    canInstall,
    cannotInstall,
    fits, // 每个引擎的匹配详情（UI 徽标与缺口渲染用）
    probedAt: new Date().toISOString(),
  };
}