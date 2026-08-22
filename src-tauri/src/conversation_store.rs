// 对话历史本地存储：会话列表 index + 单会话消息文件（见 011 §5.5）
// 目录结构（app_data_dir()/conversations/）：
//   conversations/
//     index.json          # 会话列表元数据（updated_at 倒序展示）
//     <session_id>.json   # 单个会话的消息全文
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMsg {
    /// "user" | "assistant"
    pub role: String,
    pub content: String,
    /// 消息时间（unix 毫秒）
    #[serde(default)]
    pub ts: i64,
    /// 该轮使用的 LLM 引擎/模型（仅 assistant 侧记录）
    #[serde(default)]
    pub engine: String,
    #[serde(default)]
    pub model: String,
    /// 关联音频库中该轮朗读的记录 id（为将来"点击消息重听"铺路）
    #[serde(default)]
    pub tts_audio_id: String,
}

/// 完整会话（落盘在 <id>.json）
#[derive(Serialize, Deserialize, Clone)]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub engine: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub messages: Vec<ChatMsg>,
}

/// 会话列表条目（index.json，不含消息正文）
#[derive(Serialize, Deserialize, Clone)]
pub struct ConversationMeta {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub engine: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub message_count: usize,
}

#[derive(Serialize, Deserialize, Default)]
struct ConvIndex {
    #[serde(default)]
    version: i32,
    #[serde(default)]
    items: Vec<ConversationMeta>,
}

fn conv_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    Ok(base.join("conversations"))
}

fn index_path(dir: &PathBuf) -> PathBuf {
    dir.join("index.json")
}

fn session_path(dir: &PathBuf, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

fn read_index(dir: &PathBuf) -> ConvIndex {
    match fs::read_to_string(index_path(dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => ConvIndex::default(),
    }
}

fn write_index(dir: &PathBuf, idx: &ConvIndex) -> Result<(), String> {
    let json = serde_json::to_string_pretty(idx).map_err(|e| e.to_string())?;
    fs::write(index_path(dir), json).map_err(|e| format!("写入会话索引失败: {e}"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 会话列表（updated_at 倒序）。目录不存在时返回空列表。
#[tauri::command]
pub fn conversation_list(app: tauri::AppHandle) -> Result<Vec<ConversationMeta>, String> {
    let dir = conv_dir(&app)?;
    if !index_path(&dir).exists() {
        return Ok(Vec::new());
    }
    let mut items = read_index(&dir).items;
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(items)
}

/// 读取单个会话全文
#[tauri::command]
pub fn conversation_get(app: tauri::AppHandle, id: String) -> Result<Conversation, String> {
    let dir = conv_dir(&app)?;
    // id 只允许字母数字，防路径穿越
    if !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("非法会话 id".into());
    }
    let s = fs::read_to_string(session_path(&dir, &id))
        .map_err(|_| "会话不存在".to_string())?;
    serde_json::from_str::<Conversation>(&s).map_err(|e| format!("会话文件损坏: {e}"))
}

/// 保存（新增或整体覆盖）一个会话。前端每轮对话后调用，异步不阻塞。
#[tauri::command]
pub fn conversation_save(
    app: tauri::AppHandle,
    id: String,
    title: String,
    engine: String,
    model: String,
    messages: Vec<ChatMsg>,
) -> Result<ConversationMeta, String> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("非法会话 id".into());
    }
    let dir = conv_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut idx = read_index(&dir);
    let now = now_ms();
    let created = idx
        .items
        .iter()
        .find(|m| m.id == id)
        .map(|m| m.created_at)
        .unwrap_or(now);

    let meta = ConversationMeta {
        id: id.clone(),
        title: if title.trim().is_empty() {
            "未命名会话".into()
        } else {
            title.trim().to_string()
        },
        created_at: created,
        updated_at: now,
        engine,
        model,
        message_count: messages.len(),
    };

    let conv = Conversation {
        id: id.clone(),
        title: meta.title.clone(),
        created_at: created,
        updated_at: now,
        engine: meta.engine.clone(),
        model: meta.model.clone(),
        messages,
    };
    fs::write(
        session_path(&dir, &id),
        serde_json::to_string_pretty(&conv).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("写入会话失败: {e}"))?;

    idx.version = 1;
    idx.items.retain(|m| m.id != id);
    idx.items.push(meta.clone());
    write_index(&dir, &idx)?;

    Ok(meta)
}

/// 重命名会话
#[tauri::command]
pub fn conversation_rename(
    app: tauri::AppHandle,
    id: String,
    title: String,
) -> Result<(), String> {
    let dir = conv_dir(&app)?;
    let new_title = {
        let mut idx = read_index(&dir);
        let Some(m) = idx.items.iter_mut().find(|m| m.id == id) else {
            return Err("会话不存在".into());
        };
        m.title = title.trim().to_string();
        m.title.clone()
    };
    {
        let idx = read_index(&dir);
        write_index(&dir, &idx)?;
    }

    // 同步 <id>.json 内的标题
    let p = session_path(&dir, &id);
    if let Ok(s) = fs::read_to_string(&p) {
        if let Ok(mut conv) = serde_json::from_str::<Conversation>(&s) {
            conv.title = new_title;
            if let Ok(json) = serde_json::to_string_pretty(&conv) {
                let _ = fs::write(&p, json);
            }
        }
    }
    Ok(())
}

/// 删除会话（删文件 + 更新索引；不存在视为已删）
#[tauri::command]
pub fn conversation_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = conv_dir(&app)?;
    let mut idx = read_index(&dir);
    idx.items.retain(|m| m.id != id);
    write_index(&dir, &idx)?;
    let _ = fs::remove_file(session_path(&dir, &id));
    Ok(())
}
