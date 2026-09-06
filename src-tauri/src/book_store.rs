// 长文朗读任务存储（060 P2）：每批一个 WAV 文件 + 任务级索引
// 目录结构（app_data_dir()/books/）：
//   books/
//     tasks.json           任务卡片索引（轻量，启动列表用；新增字段一律 #[serde(default)]）
//     <taskId>/
//       meta.json          源文本 + 批偏移表（每批 start/end 字符区间 + 落盘文件 + 时长）
//       seg_00000.wav …    每批一个 WAV（默认 ~1000 字/批，24kHz 与音频库 tts 一致）
// 约定：
//   - 只保存"整批合成完成"的 WAV（中断的半截不落盘 → 续读时整批重读，避免半截文件）；
//   - 偏移是 JS 侧 String 字符索引（UTF-16），本模块只存不切，续读时前端自己 slice；
//   - id 仅允许字母数字，防路径穿越。
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

/// 任务卡片（books/tasks.json 一条）
#[derive(Serialize, Deserialize, Clone)]
pub struct BookSummary {
    pub id: String,
    pub title: String,
    pub source_name: String,
    pub engine: String,
    pub voice: String,
    #[serde(default)]
    pub sid: i64,
    #[serde(default = "default_speed")]
    pub speed: f64,
    pub language: String,
    /// 每批上限字数（创建时快照）
    pub batch_chars: usize,
    pub total_batches: usize,
    /// 下一个待合成的批下标（0 起；等于 total_batches 表示全部已合成）
    pub next_idx: usize,
    pub total_chars: usize,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 单批状态（books/<id>/meta.json）
#[derive(Serialize, Deserialize, Clone)]
pub struct BookBatch {
    pub start: usize,
    pub end: usize,
    /// 已落盘文件名（空 = 未合成）
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub duration_sec: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct BookMeta {
    pub text: String,
    #[serde(default)]
    pub batches: Vec<BookBatch>,
}

/// 创建任务的批次偏移（来自前端 splitTextBatches）
#[derive(Deserialize)]
pub struct BookBatchOffsets {
    pub start: usize,
    pub end: usize,
}

/// books_get 返回的完整详情
#[derive(Serialize, Clone)]
pub struct BookDetail {
    pub summary: BookSummary,
    pub text: String,
    pub batches: Vec<BookBatch>,
}

#[derive(Serialize, Deserialize, Default)]
struct BookIndex {
    #[serde(default)]
    version: i32,
    #[serde(default)]
    items: Vec<BookSummary>,
}

fn books_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    Ok(base.join("books"))
}

fn index_path(dir: &Path) -> PathBuf {
    dir.join("tasks.json")
}

fn task_dir(dir: &Path, id: &str) -> PathBuf {
    dir.join(id)
}

fn meta_path(task: &Path) -> PathBuf {
    task.join("meta.json")
}

fn seg_path(task: &Path, idx: usize) -> PathBuf {
    task.join(format!("seg_{:05}.wav", idx))
}

fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric())
}

fn read_index(dir: &Path) -> BookIndex {
    match fs::read_to_string(index_path(dir)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => BookIndex::default(),
    }
}

fn write_index(dir: &Path, idx: &BookIndex) -> Result<(), String> {
    let json = serde_json::to_string_pretty(idx).map_err(|e| e.to_string())?;
    fs::write(index_path(dir), json).map_err(|e| format!("写入任务索引失败: {e}"))
}

fn read_meta(task: &Path) -> Result<BookMeta, String> {
    let s = fs::read_to_string(meta_path(task)).map_err(|e| format!("读取任务 meta 失败: {e}"))?;
    serde_json::from_str(&s).map_err(|e| format!("解析任务 meta 失败: {e}"))
}

fn write_meta(task: &Path, meta: &BookMeta) -> Result<(), String> {
    let json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    fs::write(meta_path(task), json).map_err(|e| format!("写入任务 meta 失败: {e}"))
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{}{}", now_millis(), seq)
}

/// 列出全部长文任务（新的在前）
#[tauri::command]
pub fn books_list(app: tauri::AppHandle) -> Result<Vec<BookSummary>, String> {
    let dir = books_dir(&app)?;
    if !index_path(&dir).exists() {
        return Ok(Vec::new());
    }
    let mut items = read_index(&dir).items;
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(items)
}

/// 返回音频库同款本地目录（books/ 根目录绝对路径，供 asset URL）
#[tauri::command]
pub fn books_get_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = books_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 新建长文朗读任务：写 tasks.json 卡片 + <id>/meta.json（源文本 + 批偏移）
#[tauri::command]
pub fn books_create(
    app: tauri::AppHandle,
    title: String,
    source_name: String,
    text: String,
    engine: String,
    voice: String,
    sid: Option<i64>,
    speed: Option<f64>,
    language: String,
    batch_chars: usize,
    batches: Vec<BookBatchOffsets>,
) -> Result<BookSummary, String> {
    if text.trim().is_empty() {
        return Err("任务文本为空".into());
    }
    if batches.is_empty() {
        return Err("任务批次为空".into());
    }
    if engine.trim().is_empty() {
        return Err("缺少朗读引擎".into());
    }

    let dir = books_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let id = new_id();
    let task = task_dir(&dir, &id);
    fs::create_dir_all(&task).map_err(|e| format!("创建任务目录失败: {e}"))?;

    let meta = BookMeta {
        text: text.clone(),
        batches: batches
            .iter()
            .map(|b| BookBatch {
                start: b.start,
                end: b.end,
                file: String::new(),
                duration_sec: 0.0,
            })
            .collect(),
    };
    write_meta(&task, &meta)?;

    let ts = now_millis();
    let total_chars = batches.iter().map(|b| b.end.saturating_sub(b.start)).sum();
    let summary = BookSummary {
        id: id.clone(),
        title: if title.trim().is_empty() {
            text.chars().take(20).collect()
        } else {
            title
        },
        source_name,
        engine,
        voice,
        sid: sid.unwrap_or(0),
        speed: speed.unwrap_or(1.0),
        language,
        batch_chars: batch_chars.max(1),
        total_batches: batches.len(),
        next_idx: 0,
        total_chars,
        created_at: ts,
        updated_at: ts,
    };

    let mut idx = read_index(&dir);
    idx.version = 1;
    idx.items.push(summary.clone());
    write_index(&dir, &idx)?;
    Ok(summary)
}

/// 读取任务完整详情（源文本 + 批表；批量小/文本长，按需调用）
#[tauri::command]
pub fn books_get(app: tauri::AppHandle, id: String) -> Result<BookDetail, String> {
    if !id_ok(&id) {
        return Err("非法任务 id".into());
    }
    let dir = books_dir(&app)?;
    let task = task_dir(&dir, &id);
    let meta = read_meta(&task)?;
    let summary = read_index(&dir)
        .items
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("任务不存在")?;
    Ok(BookDetail {
        summary,
        text: meta.text,
        batches: meta.batches,
    })
}

/// 保存一批已合成的 WAV 并前移 next_idx（只记录整批完成的；中断的半截不落盘）
#[tauri::command]
pub fn books_save_segment(
    app: tauri::AppHandle,
    id: String,
    idx: usize,
    wav_base64: String,
    duration_sec: f64,
) -> Result<BookSummary, String> {
    if !id_ok(&id) {
        return Err("非法任务 id".into());
    }
    let dir = books_dir(&app)?;
    let task = task_dir(&dir, &id);
    let mut meta = read_meta(&task)?;
    if idx >= meta.batches.len() {
        return Err(format!("批下标越界: {idx} >= {}", meta.batches.len()));
    }
    let wav = base64::engine::general_purpose::STANDARD
        .decode(&wav_base64)
        .map_err(|e| format!("WAV base64 解码失败: {e}"))?;
    if wav.len() < 44 {
        return Err("WAV 数据不完整".into());
    }

    let file = format!("seg_{:05}.wav", idx);
    fs::write(seg_path(&task, idx), &wav).map_err(|e| format!("写入批次音频失败: {e}"))?;
    meta.batches[idx].file = file;
    meta.batches[idx].duration_sec = duration_sec;
    write_meta(&task, &meta)?;

    let mut idx_items = read_index(&dir);
    let item = idx_items
        .items
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or("任务不存在")?;
    item.next_idx = item.next_idx.max(idx + 1);
    item.updated_at = now_millis();
    let out = item.clone();
    write_index(&dir, &idx_items)?;
    Ok(out)
}

/// 手动推进 next_idx（跳过空白批/保留进度用；只前进不回退，封顶 total_batches）
#[tauri::command]
pub fn books_set_next(app: tauri::AppHandle, id: String, next: usize) -> Result<BookSummary, String> {
    if !id_ok(&id) {
        return Err("非法任务 id".into());
    }
    let dir = books_dir(&app)?;
    let mut idx = read_index(&dir);
    let item = idx
        .items
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or("任务不存在")?;
    item.next_idx = item.next_idx.max(next.min(item.total_batches));
    item.updated_at = now_millis();
    let out = item.clone();
    write_index(&dir, &idx)?;
    Ok(out)
}

/// 删除一个长文任务（删目录 + 索引）
#[tauri::command]
pub fn books_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !id_ok(&id) {
        return Err("非法任务 id".into());
    }
    let dir = books_dir(&app)?;
    let task = task_dir(&dir, &id);
    let _ = fs::remove_dir_all(&task); // 目录缺失不报错
    let mut idx = read_index(&dir);
    idx.items.retain(|s| s.id != id);
    write_index(&dir, &idx)
}

/// 导出任务为 zip（全部 seg_*.wav + 源文本 .txt，与音频库导出同风格）
#[tauri::command]
pub fn books_export(app: tauri::AppHandle, id: String, dest_path: String) -> Result<(), String> {
    if !id_ok(&id) {
        return Err("非法任务 id".into());
    }
    let dir = books_dir(&app)?;
    let task = task_dir(&dir, &id);
    let meta = read_meta(&task)?;
    let summary = read_index(&dir)
        .items
        .into_iter()
        .find(|s| s.id == id)
        .ok_or("任务不存在")?;

    let base: String = if summary.title.trim().is_empty() {
        summary.id.clone()
    } else {
        let clean: String = summary
            .title
            .chars()
            .take(20)
            .map(|c| if c.is_ascii_alphanumeric() || c.is_ascii_whitespace() { c } else { '-' })
            .collect::<String>()
            .trim()
            .chars()
            .map(|c| if c.is_ascii_whitespace() { '-' } else { c })
            .collect();
        if clean.is_empty() { summary.id.clone() } else { format!("{}-{}", clean, summary.id) }
    };

    let out = fs::File::create(&dest_path).map_err(|e| format!("无法创建导出文件: {e}"))?;
    let mut zw = ZipWriter::new(out);
    let opts = FileOptions::default().compression_method(CompressionMethod::Stored);

    for (idx, b) in meta.batches.iter().enumerate() {
        if b.file.is_empty() {
            continue;
        }
        zw.start_file(b.file.clone(), opts).map_err(|e| e.to_string())?;
        let bytes =
            fs::read(seg_path(&task, idx)).map_err(|e| format!("读取批次音频失败: {e}"))?;
        zw.write_all(&bytes).map_err(|e| e.to_string())?;
    }

    let total_done = meta.batches.iter().filter(|b| !b.file.is_empty()).count();
    let txt = format!(
        "# OpenSound 长文朗读任务导出\n\n- 标题: {}\n- 来源: {}\n- 引擎: {}\n- 批次: {}/{}（每批 ≤{} 字）\n- 时间: {}\n\n## 原文\n\n{}\n",
        summary.title,
        if summary.source_name.is_empty() { "-" } else { &summary.source_name },
        summary.engine,
        total_done,
        summary.total_batches,
        summary.batch_chars,
        summary.created_at,
        meta.text
    );
    zw.start_file(format!("{base}.txt"), opts).map_err(|e| e.to_string())?;
    zw.write_all(txt.as_bytes()).map_err(|e| e.to_string())?;

    zw.finish().map_err(|e| e.to_string())?;
    Ok(())
}
