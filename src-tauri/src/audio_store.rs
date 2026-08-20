// 音频库本地存储：录音 + TTS 朗读结果 落盘 + index.json 元数据索引
// 目录结构（app_data_dir()/audio/）：
//   audio/
//     recordings/   用户录音 16kHz WAV
//     tts/          TTS 朗读结果 WAV
//     index.json    元数据索引
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::Manager;

static SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Deserialize, Clone)]
pub struct AudioRecord {
    pub id: String,
    /// "recording" | "tts"
    pub kind: String,
    /// 相对 audio 根目录的文件路径，如 recordings/xxx.wav
    pub file: String,
    /// 创建时间（unix 毫秒）
    pub created_at: i64,
    pub duration_sec: f64,
    pub engine: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Index {
    #[serde(default)]
    version: i32,
    #[serde(default)]
    items: Vec<AudioRecord>,
}

fn audio_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    Ok(base.join("audio"))
}

fn recordings_dir(dir: &Path) -> PathBuf {
    dir.join("recordings")
}

fn tts_dir(dir: &Path) -> PathBuf {
    dir.join("tts")
}

fn index_path(dir: &Path) -> PathBuf {
    dir.join("index.json")
}

fn read_index(dir: &Path) -> Index {
    match fs::read_to_string(index_path(dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Index::default(),
    }
}

fn write_index(dir: &Path, idx: &Index) -> Result<(), String> {
    let json = serde_json::to_string_pretty(idx).map_err(|e| e.to_string())?;
    fs::write(index_path(dir), json).map_err(|e| format!("写入索引失败: {e}"))
}

fn new_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{millis}{seq}")
}

/// 落盘一条音频。kind ∈ {"recording","tts"}
#[tauri::command]
pub fn audio_save(
    app: tauri::AppHandle,
    kind: String,
    wav_base64: String,
    duration_sec: f64,
    engine: String,
    text: String,
) -> Result<AudioRecord, String> {
    if kind != "recording" && kind != "tts" {
        return Err(format!("未知音频类型: {kind}"));
    }
    let wav = base64::engine::general_purpose::STANDARD
        .decode(&wav_base64)
        .map_err(|e| format!("WAV base64 解码失败: {e}"))?;
    if wav.len() < 44 {
        return Err("WAV 数据不完整".into());
    }

    let dir = audio_dir(&app)?;
    fs::create_dir_all(recordings_dir(&dir)).map_err(|e| e.to_string())?;
    fs::create_dir_all(tts_dir(&dir)).map_err(|e| e.to_string())?;

    let id = new_id();
    let sub = if kind == "recording" { "recordings" } else { "tts" };
    let rel = format!("{sub}/{id}.wav");
    let abs = dir.join(&rel);
    fs::write(&abs, &wav).map_err(|e| format!("写入音频文件失败: {e}"))?;

    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let rec = AudioRecord {
        id,
        kind,
        file: rel,
        created_at,
        duration_sec,
        engine,
        text,
    };

    let mut idx = read_index(&dir);
    idx.version = 1;
    idx.items.push(rec.clone());
    write_index(&dir, &idx)?;

    Ok(rec)
}

/// 返回全部音频记录（新的在前）
#[tauri::command]
pub fn audio_list(app: tauri::AppHandle) -> Result<Vec<AudioRecord>, String> {
    let dir = audio_dir(&app)?;
    if !index_path(&dir).exists() {
        return Ok(Vec::new());
    }
    let mut items = read_index(&dir).items;
    // 新的在前（created_at 倒序）
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(items)
}

/// 按 id 删除一条记录（删文件 + 更新索引）
#[tauri::command]
pub fn audio_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = audio_dir(&app)?;
    let mut idx = read_index(&dir);
    let Some(pos) = idx.items.iter().position(|r| r.id == id) else {
        return Ok(()); // 不存在则视为已删
    };
    let rec = idx.items.remove(pos);
    let abs = dir.join(&rec.file);
    let _ = fs::remove_file(&abs); // 文件缺失不报错
    write_index(&dir, &idx)?;
    Ok(())
}

/// 返回音频库根目录绝对路径（用于 asset URL 与"打开位置"）
#[tauri::command]
pub fn audio_get_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = audio_dir(&app)?;
    fs::create_dir_all(recordings_dir(&dir)).map_err(|e| e.to_string())?;
    fs::create_dir_all(tts_dir(&dir)).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}
