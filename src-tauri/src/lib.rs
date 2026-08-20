use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::menu::{Menu, MenuItem};
use tauri::{Emitter, Manager, State};

mod audio_store;
mod recorder;
use recorder::Recorder;

// ---------- 常量 ----------
const ASR_URL: &str = "http://127.0.0.1:9528";
const QWEN3_URL: &str = "http://127.0.0.1:8001";
const SERVER_DIR: &str = "asr-server"; // 相对项目根

// ---------- 应用状态 ----------
#[derive(Default)]
struct AppState {
    child: Mutex<Option<Child>>,
    node_path: Mutex<Option<String>>,
    recorder: Recorder,
    server_path: Mutex<Option<String>>, // 用户配置的 asr-server 目录
}

#[derive(Serialize, Clone, Default)]
struct ServiceStatus {
    asr_up: bool,
    qwen3_up: bool,
    asr_url: String,
    qwen3_url: String,
    child_alive: bool,
    node_path: String,
}

// ---------- 工具：找 node ----------
fn find_node() -> Option<String> {
    // 1) 环境变量显式指定
    if let Ok(p) = std::env::var("TABU_NODE_PATH") {
        if !p.is_empty() {
            return Some(p);
        }
    }
    // 2) PATH 中找（dev 时终端 PATH 有 node）
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            let cand = PathBuf::from(dir).join("node");
            if cand.is_file() {
                return Some(cand.to_string_lossy().into_owned());
            }
        }
    }
    // 3) nvm 常见位置
    if let Ok(home) = std::env::var("HOME") {
        let nvm = PathBuf::from(&home).join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(&nvm) {
            for e in entries.flatten() {
                let cand = e.path().join("bin/node");
                if cand.is_file() {
                    return Some(cand.to_string_lossy().into_owned());
                }
            }
        }
    }
    // 4) Homebrew 常见位置
    for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
        if PathBuf::from(p).is_file() {
            return Some(p.to_string());
        }
    }
    None
}

// ---------- 配置读写（asr-server 路径持久化） ----------
fn config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("config.json"))
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct PersistedConfig {
    server_path: Option<String>,
}

fn load_config(app: &tauri::AppHandle) -> PersistedConfig {
    if let Some(p) = config_path(app) {
        if let Ok(s) = fs::read_to_string(p) {
            if let Ok(c) = serde_json::from_str::<PersistedConfig>(&s) {
                return c;
            }
        }
    }
    PersistedConfig::default()
}

fn save_config(app: &tauri::AppHandle, cfg: &PersistedConfig) -> Result<(), String> {
    let p = config_path(app).ok_or("无法定位配置目录")?;
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let json = serde_json::to_string(cfg).map_err(|e| e.to_string())?;
    fs::write(&p, json).map_err(|e| format!("写入配置失败: {e}"))
}

#[tauri::command]
fn get_server_path(app: tauri::AppHandle) -> String {
    load_config(&app).server_path.unwrap_or_default()
}

#[tauri::command]
fn set_server_path(app: tauri::AppHandle, state: State<'_, Arc<AppState>>, path: String) -> Result<(), String> {
    let mut cfg = load_config(&app);
    let trimmed = path.trim().to_string();
    cfg.server_path = if trimmed.is_empty() { None } else { Some(trimmed.clone()) };
    save_config(&app, &cfg)?;
    *state.server_path.lock().unwrap() = if trimmed.is_empty() { None } else { Some(trimmed.clone()) };
    Ok(())
}

// ---------- 定位 asr-server 目录 ----------
fn server_dir(app: &tauri::AppHandle, state: &Arc<AppState>) -> Option<PathBuf> {
    // 1) 用户配置的路径优先
    if let Some(p) = state.server_path.lock().unwrap().clone() {
        let cand = PathBuf::from(&p);
        if cand.join("start-all.js").is_file() {
            return Some(cand);
        }
    }
    // 2) 配置文件中读取（如果 state 还没加载）
    if let Some(p) = load_config(app).server_path {
        let cand = PathBuf::from(&p);
        if cand.join("start-all.js").is_file() {
            return Some(cand);
        }
    }
    // 3) 回退：从可执行文件所在目录向上逐级查找包含 asr-server 的项目根（开发模式）
    let mut dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for _ in 0..8 {
        let cand = dir.join(SERVER_DIR);
        if cand.is_dir() {
            return Some(cand);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

// ---------- 拉起 / 停止服务 ----------
fn start_service(app: &tauri::AppHandle, state: &Arc<AppState>) -> Result<(), String> {
    // 先停旧的
    stop_service(state);

    let dir = server_dir(app, state).ok_or("无法定位 asr-server 目录（请在设置中配置 asr-server 路径）")?;
    let node = {
        let mut guard = state.node_path.lock().unwrap();
        if guard.is_none() {
            *guard = find_node();
        }
        guard.clone().ok_or("未找到 node 可执行文件")?
    };
    let entry = dir.join("start-all.js");

    let child = Command::new(&node)
        .arg(&entry)
        .current_dir(&dir)
        .env("ASR_ENGINE", "auto")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动服务失败: {e}"))?;

    *state.child.lock().unwrap() = Some(child);
    println!("[tabu-local] 已启动 asr-server (node={node})");
    Ok(())
}

fn stop_service(state: &Arc<AppState>) {
    let mut guard = state.child.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    println!("[tabu-local] 服务已停止");
}

// ---------- 子进程存活判断 ----------
fn child_alive(state: &Arc<AppState>) -> bool {
    let mut guard = state.child.lock().unwrap();
    match guard.as_mut() {
        Some(c) => c.try_wait().unwrap_or(None).is_none(),
        None => false,
    }
}

// ---------- 健康检查 ----------
async fn health_up(url: &str) -> bool {
    match reqwest::Client::new()
        .get(format!("{url}/health"))
        .timeout(Duration::from_millis(1500))
        .send()
        .await
    {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
}

#[tauri::command]
async fn get_service_status(state: State<'_, Arc<AppState>>) -> Result<ServiceStatus, String> {
    let child_alive = child_alive(&state);
    let (asr_up, qwen3_up) = tokio::join!(health_up(ASR_URL), health_up(QWEN3_URL));
    Ok(ServiceStatus {
        asr_up,
        qwen3_up,
        asr_url: ASR_URL.to_string(),
        qwen3_url: QWEN3_URL.to_string(),
        child_alive,
        node_path: state.node_path.lock().unwrap().clone().unwrap_or_default(),
    })
}

#[tauri::command]
fn start_service_cmd(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    start_service(&app, &state)
}

#[tauri::command]
fn stop_service_cmd(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    stop_service(&state);
    Ok(())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    stop_service(&state);
    app.exit(0);
    Ok(())
}

// ---------- 录音（原生麦克风，cpal） ----------
#[tauri::command]
fn recorder_start(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.recorder.start()
}

#[tauri::command]
fn recorder_stop(state: State<'_, Arc<AppState>>) -> Result<recorder::RecordingResult, String> {
    state.recorder.stop()
}

#[tauri::command]
fn recorder_is_recording(state: State<'_, Arc<AppState>>) -> bool {
    state.recorder.is_recording()
}

// ---------- 启动时健康轮询，前端通过事件订阅 ----------
async fn poll_health(app: tauri::AppHandle, state: Arc<AppState>) {
    loop {
        let s = {
            let child_alive = child_alive(&state);
            let (asr_up, qwen3_up) = tokio::join!(health_up(ASR_URL), health_up(QWEN3_URL));
            ServiceStatus {
                asr_up,
                qwen3_up,
                asr_url: ASR_URL.to_string(),
                qwen3_url: QWEN3_URL.to_string(),
                child_alive,
                node_path: state.node_path.lock().unwrap().clone().unwrap_or_default(),
            }
        };
        let _ = app.emit("service-status", &s);
        tokio::time::sleep(Duration::from_millis(2000)).await;
    }
}

// ---------- 托盘 ----------
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启服务", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出（停止服务）", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &restart, &quit])?;

    let _tray = TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("Tabu-Local 语音服务")
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "restart" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.emit("restart-service", ());
                }
            }
            "quit" => {
                let st = app.state::<Arc<AppState>>();
                stop_service(&st);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

// ---------- 入口 ----------
pub fn run() {
    let state = Arc::new(AppState::default());

    tauri::Builder::default()
        .manage(state.clone())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            let state2 = state.clone();
            // 加载 asr-server 路径配置到 state
            *state.server_path.lock().unwrap() = load_config(&handle).server_path;
            // 启动服务（直接使用已捕获的 Arc，避免 setup 阶段 state 查询）
            match start_service(&handle, &state) {
                Ok(()) => {}
                Err(e) => eprintln!("[tabu-local] 启动服务失败: {e}"),
            }
            setup_tray(&handle)?;

            // 健康轮询后台任务
            tauri::async_runtime::spawn(async move {
                poll_health(handle, state2).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭窗口 → 隐藏，不退出（托盘常驻，服务继续）
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_service_status,
            start_service_cmd,
            stop_service_cmd,
            quit_app,
            recorder_start,
            recorder_stop,
            recorder_is_recording,
            get_server_path,
            set_server_path,
            audio_store::audio_save,
            audio_store::audio_list,
            audio_store::audio_delete,
            audio_store::audio_get_dir,
            audio_store::audio_export,
            audio_store::audio_set_clone_sample,
            audio_store::audio_read_base64
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 兜底：应用真正退出时停掉服务子进程，避免孤儿进程
            if let tauri::RunEvent::Exit = event {
                let st = app_handle.state::<Arc<AppState>>();
                stop_service(&*st);
            }
        });
}
