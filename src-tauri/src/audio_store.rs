// 音频库本地存储：录音 + TTS 朗读结果 落盘 + index.json 元数据索引
// 目录结构（app_data_dir()/audio/）：
//   audio/
//     recordings/   用户录音 16kHz WAV
//     tts/          TTS 朗读结果 WAV
//     index.json    元数据索引
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipWriter};

static SEQ: AtomicU64 = AtomicU64::new(0);

fn default_speed() -> f64 {
    1.0
}

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
    /// 是否被标记为克隆音色样本来源
    #[serde(default)]
    pub is_clone_sample: bool,
    /// 来源面板：asr|home|chat|realtime|voice|read（旧记录为空，前端按 kind 回退显示）
    #[serde(default)]
    pub source: String,
    /// 以下为 TTS 参数快照（供历史展示与将来"按原参数重读"）
    #[serde(default)]
    pub voice: String,
    #[serde(default)]
    pub sid: i64,
    #[serde(default = "default_speed")]
    pub speed: f64,
    #[serde(default)]
    pub language: String,
    /// 流式中途被手动停止，音频为已生成部分
    #[serde(default)]
    pub interrupted: bool,
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

/// 落盘一条音频。kind ∈ {"recording","tts"}；source/voice 等为可选元数据（旧调用可不传）
#[tauri::command]
pub fn audio_save(
    app: tauri::AppHandle,
    kind: String,
    wav_base64: String,
    duration_sec: f64,
    engine: String,
    text: String,
    source: Option<String>,
    voice: Option<String>,
    sid: Option<i64>,
    speed: Option<f64>,
    language: Option<String>,
    interrupted: Option<bool>,
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
        is_clone_sample: false,
        source: source.unwrap_or_default(),
        voice: voice.unwrap_or_default(),
        sid: sid.unwrap_or(0),
        speed: speed.unwrap_or(1.0),
        language: language.unwrap_or_default(),
        interrupted: interrupted.unwrap_or(false),
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

/// 各 TTS 引擎帧流的真实采样率（asr-server.js / qwen3 / cosyvoice 服务端均为 24kHz）
fn engine_sample_rate(engine: &str) -> u32 {
    match engine {
        "kokoro" | "qwen3" | "clone" | "cosyvoice" => 24000,
        _ => 16000,
    }
}

/// 修复旧版 mergeWavFrames 写坏的 WAV 头（幂等）。
/// 坏头特征：偏移 4..8 是 "WAVE" 且 8..12 是 "fmt "（正常文件偏移 4..8 是 RIFF 尺寸字段）。
/// 帧流合并产物为单声道 16-bit PCM；采样率按记录的 engine 取真实值
/// （此前误写 16k 导致 24k 音频重播变慢变调，听起来"换了个人"）。
/// 返回 Some(数据字节数) 表示执行了修复。
fn repair_wav_header_if_broken(path: &Path, engine: &str) -> Option<u32> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = fs::OpenOptions::new().read(true).write(true).open(path) else {
        return None;
    };
    let mut head = [0u8; 44];
    if f.read_exact(&mut head).is_err() {
        return None;
    }
    if &head[4..8] != b"WAVE" || &head[8..12] != b"fmt " {
        return None; // 头正常，不动
    }
    let Ok(meta) = f.metadata() else { return None };
    if meta.len() <= 44 {
        return None;
    }
    let data_size = (meta.len() - 44) as u32;
    let sr = engine_sample_rate(engine);
    let byte_rate = sr * 2; // 单声道 16-bit
    head[4..8].copy_from_slice(&(36 + data_size).to_le_bytes());
    head[8..12].copy_from_slice(b"WAVE");
    head[12..16].copy_from_slice(b"fmt ");
    head[16..20].copy_from_slice(&16u32.to_le_bytes());
    head[20..22].copy_from_slice(&1u16.to_le_bytes());
    head[22..24].copy_from_slice(&1u16.to_le_bytes());
    head[24..28].copy_from_slice(&sr.to_le_bytes());
    head[28..32].copy_from_slice(&byte_rate.to_le_bytes());
    head[32..34].copy_from_slice(&2u16.to_le_bytes());
    head[34..36].copy_from_slice(&16u16.to_le_bytes());
    head[36..40].copy_from_slice(b"data");
    head[40..44].copy_from_slice(&data_size.to_le_bytes());
    if f.seek(SeekFrom::Start(0)).is_err() {
        return None;
    }
    f.write_all(&head).is_ok().then_some(data_size)
}

/// 二次纠正：更早一版修复把 24kHz 的 TTS 文件按 16k 标注（能播放但变慢变调）。
/// 仅处理：头完整正常、声明 16kHz、单声道 16-bit 且引擎属 24k 引擎的 tts 记录。幂等。
fn relabel_mislabeled_tts_rate(path: &Path) -> Option<u32> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = fs::OpenOptions::new().read(true).write(true).open(path) else {
        return None;
    };
    let mut head = [0u8; 44];
    if f.read_exact(&mut head).is_err() {
        return None;
    }
    if &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" || &head[36..40] != b"data" {
        return None;
    }
    let sr = u32::from_le_bytes(head[24..28].try_into().ok()?);
    if sr != 16000 {
        return None; // 已是正确标注（或本就 16k），不动
    }
    let ch = u16::from_le_bytes(head[22..24].try_into().ok()?);
    let bits = u16::from_le_bytes(head[34..36].try_into().ok()?);
    if ch != 1 || bits != 16 {
        return None;
    }
    let data_size = u32::from_le_bytes(head[40..44].try_into().ok()?);
    head[24..28].copy_from_slice(&24000u32.to_le_bytes());
    head[28..32].copy_from_slice(&48000u32.to_le_bytes());
    if f.seek(SeekFrom::Start(0)).is_err() {
        return None;
    }
    f.write_all(&head).is_ok().then_some(data_size)
}

fn is_24k_engine(engine: &str) -> bool {
    matches!(engine, "kokoro" | "qwen3" | "clone" | "cosyvoice")
}

/// 返回音频库根目录绝对路径（用于 asset URL 与"打开位置"）
#[tauri::command]
pub fn audio_get_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = audio_dir(&app)?;
    fs::create_dir_all(recordings_dir(&dir)).map_err(|e| e.to_string())?;
    fs::create_dir_all(tts_dir(&dir)).map_err(|e| e.to_string())?;
    // 顺手修复历史坏头文件（幂等：正常头直接跳过），并纠正被高估的时长
    let mut idx = read_index(&dir);
    let mut changed = false;
    for rec in idx.items.iter_mut() {
        if rec.kind != "tts" {
            continue;
        }
        if let Some(data_size) = repair_wav_header_if_broken(&dir.join(&rec.file), &rec.engine) {
            rec.duration_sec =
                ((data_size as f64 / engine_sample_rate(&rec.engine) as f64 / 2.0) * 10.0).round()
                    / 10.0;
            changed = true;
        } else if is_24k_engine(&rec.engine) {
            // 二次纠正：被按 16k 错误标注的 24k 文件
            if let Some(data_size) = relabel_mislabeled_tts_rate(&dir.join(&rec.file)) {
                rec.duration_sec = ((data_size as f64 / 48000.0) * 10.0).round() / 10.0;
                changed = true;
            }
        }
    }
    if changed {
        write_index(&dir, &idx)?;
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// 按 id 读取一条音频文件并返回 base64（供克隆后端 /clone 使用；避开 Web 端 fetch asset URL 的限制）
#[tauri::command]
pub fn audio_read_base64(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let dir = audio_dir(&app)?;
    let idx = read_index(&dir);
    let rec = idx
        .items
        .iter()
        .find(|r| r.id == id)
        .ok_or("音频记录不存在")?;
    let abs = dir.join(&rec.file);
    let bytes = fs::read(&abs).map_err(|e| format!("读取音频失败: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// 把一条音频与其配套文本一起导出为 zip（dest_path 为前端保存对话框给出的完整 .zip 路径）
#[tauri::command]
pub fn audio_export(
    app: tauri::AppHandle,
    id: String,
    dest_path: String,
) -> Result<(), String> {
    let dir = audio_dir(&app)?;
    let idx = read_index(&dir);
    let rec = idx
        .items
        .iter()
        .find(|r| r.id == id)
        .ok_or("音频记录不存在")?;

    let wav_abs = dir.join(&rec.file);
    let wav = fs::read(&wav_abs).map_err(|e| format!("读取音频失败: {e}"))?;

    let base = if rec.text.trim().is_empty() {
        format!("{}", rec.id)
    } else {
        // 用文本开头做文件名，去掉非法字符
        let clean: String = rec
            .text
            .chars()
            .take(20)
            .map(|c| if c.is_ascii_alphanumeric() || c.is_ascii_whitespace() { c } else { '-' })
            .collect::<String>()
            .trim()
            .chars()
            .map(|c| if c.is_ascii_whitespace() { '-' } else { c })
            .collect();
        format!("{}-{}", clean, rec.id)
    };
    let kind_label = if rec.kind == "recording" { "录音" } else { "朗读" };

    let out = fs::File::create(&dest_path).map_err(|e| format!("无法创建导出文件: {e}"))?;
    let mut zw = ZipWriter::new(out);
    let opts = FileOptions::default().compression_method(CompressionMethod::Stored);

    zw.start_file(format!("{base}.wav"), opts)
        .map_err(|e| e.to_string())?;
    zw.write_all(&wav).map_err(|e| e.to_string())?;

    let txt = format!(
        "# OpenSound {kind_label}导出\n\n- 类型: {}\n- 引擎: {}\n- 时长: {:.1} 秒\n- 时间: {}\n\n## 文本\n\n{}\n",
        kind_label,
        if rec.engine.is_empty() { "auto" } else { &rec.engine },
        rec.duration_sec,
        rec.created_at,
        if rec.text.trim().is_empty() { "(无文本)" } else { rec.text.trim() }
    );
    zw.start_file(format!("{base}.txt"), opts)
        .map_err(|e| e.to_string())?;
    zw.write_all(txt.as_bytes()).map_err(|e| e.to_string())?;

    zw.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// 标记/取消某条录音作为克隆音色样本来源
#[tauri::command]
pub fn audio_set_clone_sample(app: tauri::AppHandle, id: String, flag: bool) -> Result<(), String> {
    let dir = audio_dir(&app)?;
    let mut idx = read_index(&dir);
    let Some(rec) = idx.items.iter_mut().find(|r| r.id == id) else {
        return Err("音频记录不存在".into());
    };
    rec.is_clone_sample = flag;
    write_index(&dir, &idx)?;
    Ok(())
}
