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

// /models 返回的模型项
export interface ModelInfo {
  category: string; // tts | asr | llm
  engine: string; // kokoro | qwen3 | sensevoice | whisper | llm
  label: string;
  size: string;
  installed: boolean;
}

// 安装进度（NDJSON）
export interface InstallProgress {
  type: "log" | "done" | "error";
  message: string;
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
