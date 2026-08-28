export interface ServiceStatus {
  asr_up: boolean;
  qwen3_up: boolean;
  asr_url: string;
  qwen3_url: string;
  child_alive: boolean;
  node_path: string;
}

// /health 返回的详细结构
export interface HealthInfo {
  ok: boolean;
  engines: string[];
  tts: {
    kokoro: string; // ready | missing | not-installed
    kokoroSpeakers: number | null;
    qwen3: string; // reachable | unreachable
    cosyvoice: string; // reachable | missing
  };
  llm: {
    engine: string;
    model: string;
    ollama: string; // reachable | unreachable
  };
  models: ModelInfo[];
  port: number;
}

// /models 返回的模型项（S2/S3：含就绪明细）
export interface MissingFile {
  path: string;
  type: string; // 缺文件 | 大小不符 | 缺目录 | 目录不完整 | 无匹配 | 不可读
  expectBytes?: number;
  actualBytes?: number;
  expectFiles?: number;
}

export interface MissingRuntime {
  kind: string;
  label: string;
}

export interface InstallMeta {
  kind: "script" | "url-multi" | "hint" | "legacy";
  mirrors: string[];
}

export type ModelState =
  | "running"
  | "ready"
  | "partial-files"
  | "missing-runtime"
  | "incomplete"
  | "unknown"; // P1：本地清单占位（服务未启动，无动态状态）

export interface ModelInfo {
  category: string; // tts | asr | llm
  engine: string;
  label: string;
  size: string;
  installed: boolean;
  license?: string;
  state?: ModelState;
  serviceUp?: boolean;
  missingFiles?: MissingFile[];
  missingRuntime?: MissingRuntime[];
  totalMissingBytes?: number;
  install?: InstallMeta | null;
  /** 035：本机有 NVIDIA 显卡、但引擎 venv 的 torch 是 CPU 版 → 可点「升级 GPU 加速」转为 CUDA 版 */
  gpuUpgrade?: boolean;
  /** 036：加速版本标记（torch 为 CUDA 版 / CPU 版），前端徽标区分 GPU/CPU */
  accelTag?: { kind: "cuda" | "cpu"; label: string } | null;
}

// 安装进度（NDJSON）
export interface InstallProgress {
  type: "log" | "done" | "error" | "progress";
  message?: string;
  // progress 专用字段
  file?: string;
  received?: number;
  total?: number;
}

// ---------- /device-profile（000-device-vs-model.md §四：设备画像 → 模型过滤） ----------
// 一个引擎的匹配结果（fits[engine]）：can=可安装；isSlow=可装但慢（⚙️ 黄色徽标，slowNote 标注预期速度）
export interface EngineFit {
  can: boolean;
  isSlow: boolean;
  slowNote: string | null;
  blocks: DeviceBlock[]; // 🚫 缺口明细（4.3 验收②：点击显示）
  diskGB: number | null;
  diskNeed: number | null; // diskGB × 1.2（安装+解压余量）
  memNeedGB: number | null;
  accel: string;
  tierRequired: string;
}

export interface DeviceBlock {
  kind: "disk" | "mem" | "accel" | "tier";
  need: number | null;
  have: number | null;
  message: string; // "还差 5.8GB 磁盘（需 10.8GB）" / "建议 16GB 内存机型"
}

export interface DeviceCannotInstall {
  engine: string;
  reason: string;
  tierRequired: string | null;
}

export interface DeviceProfile {
  os: string; // darwin-arm64
  accel: "metal" | "cuda" | "cpu";
  ramGB: number;
  gpu: { vendor: string | null; vramGB: number | null };
  diskFreeGB: number | null;
  tier: "entry" | "standard" | "high" | "flagship";
  canInstall: string[];
  cannotInstall: DeviceCannotInstall[];
  fits: Record<string, EngineFit>;
  probedAt: string; // 服务启动时探测的缓存时间戳
}

export type PanelId =
  | "home"
  | "read"
  | "asr"
  | "realtime"
  | "chat"
  | "models"
  | "audio"
  | "voices"
  | "settings";
