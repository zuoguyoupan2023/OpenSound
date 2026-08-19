export interface ServiceStatus {
  asr_up: boolean;
  qwen3_up: boolean;
  asr_url: string;
  qwen3_url: string;
  child_alive: boolean;
  node_path: string;
}
