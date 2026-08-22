// 对话历史前端封装（对应 Rust conversation_store，见 011 §5.5）
import { invoke } from "@tauri-apps/api/core";

export interface ChatMsgRec {
  role: "user" | "assistant";
  content: string;
  ts?: number;
  engine?: string;
  model?: string;
  /** 关联音频库中该轮朗读的记录 id */
  tts_audio_id?: string;
}

export interface ConversationMetaRec {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  engine: string;
  model: string;
  message_count: number;
}

export interface ConversationFull extends ConversationMetaRec {
  messages: ChatMsgRec[];
}

export function conversationList(): Promise<ConversationMetaRec[]> {
  return invoke<ConversationMetaRec[]>("conversation_list");
}

export function conversationGet(id: string): Promise<ConversationFull> {
  return invoke<ConversationFull>("conversation_get", { id });
}

export function conversationSave(c: {
  id: string;
  title: string;
  engine: string;
  model: string;
  messages: ChatMsgRec[];
}): Promise<ConversationMetaRec> {
  return invoke<ConversationMetaRec>("conversation_save", c);
}

export function conversationRename(id: string, title: string): Promise<void> {
  return invoke("conversation_rename", { id, title });
}

export function conversationDelete(id: string): Promise<void> {
  return invoke("conversation_delete", { id });
}

// 新会话 id（仅字母数字，Rust 侧校验）
export function newSessionId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
