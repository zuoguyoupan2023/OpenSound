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
  | "incomplete";

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
