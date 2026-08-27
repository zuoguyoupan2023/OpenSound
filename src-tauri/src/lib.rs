use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::menu::{Menu, MenuItem};
use tauri::{Emitter, Manager, State};

mod audio_store;
mod conversation_store;
mod realtime;
mod recorder;
use realtime::Realtime;
use recorder::Recorder;

// ---------- 常量 ----------
const ASR_URL: &str = "http://127.0.0.1:9528";
const QWEN3_URL: &str = "http://127.0.0.1:8001";
const SERVER_DIR: &str = "asr-server"; // 相对项目根

// ---------- 运行时自举（032：App 内一键安装 node/依赖，普通用户免终端） ----------
// 便携版 Node 版本：与官方 dist 一致（npmmirror 同步镜像），受管下载到 <app_data>/runtime/node
const RUNTIME_NODE_VERSION: &str = "v24.19.0";
const RUNTIME_NODE_MIN_MAJOR: u32 = 18; // 服务端所需最低主版本
// node 便携包下载源（按序尝试；npmmirror 为中国镜像，与 nodejs.org 目录结构一致）
const NODE_MIRRORS: [&str; 2] = [
    "https://nodejs.org/dist",
    "https://npmmirror.com/mirrors/node",
];
// npm registry（依赖安装用；用户可用 OPENSOUND_NPM_REGISTRY 覆盖）
const NPM_REGISTRY_DEFAULT: &str = "https://registry.npmmirror.com";

// ---------- 应用状态 ----------
#[derive(Default)]
struct AppState {
    child: Mutex<Option<Child>>,
    node_path: Mutex<Option<String>>,
    /// App 自管理的便携版 node（下载解压后缓存；优先于系统 node 使用）
    runtime_node: Mutex<Option<String>>,
    /// 运行时自举进行中（防并发重复安装）
    runtime_installing: Mutex<bool>,
    recorder: Recorder,
    realtime: Realtime,
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

// ---------- 运行时自检结果（032：UI 引导条 / 设置页「环境与运行时」） ----------
#[derive(Serialize, Clone, Default)]
struct RuntimeStatus {
    /// 有可用的 node（系统 PATH 或已下载的便携版）且版本达标
    node_ok: bool,
    /// 正在实际使用的 node 可执行文件路径
    node_path: String,
    /// node 版本号（如 v24.19.0）
    node_version: String,
    /// App 自管理的便携版 node 路径（未下载则为空）
    runtime_node: String,
    /// 系统 node 是否已就绪（PATH/常见位置）
    sys_node_found: bool,
    /// system python 是否可探测（仅信息展示；python 系引擎另由 uv 自举）
    python_found: bool,
    python_version: String,
    /// asr-server 的 node_modules（关键包）是否就绪
    deps_ready: bool,
    /// 用户数据目录（模型/运行时/缓存将收敛于此，032）
    data_dir: String,
    /// 服务代码目录（start-all.js 所在）
    server_dir: String,
}

// 单个安装步骤事件：{ step, message, pct? }；step ∈ node-download | deps | done | error
#[derive(Serialize, Clone)]
struct RuntimeProgress {
    step: String,
    message: String,
    pct: Option<u32>,
}

// ---------- P1：模型清单本地化（engines/*.json 静态目录，不依赖 9528 服务） ----------
#[derive(Serialize, Clone)]
struct CatalogInstall {
    kind: String,
    mirrors: Vec<String>,
}

#[derive(Serialize, Clone)]
struct CatalogModel {
    category: String,
    engine: String,
    label: String,
    size: String,
    license: String,
    install: Option<CatalogInstall>,
}

#[derive(serde::Deserialize)]
struct EngineJson {
    id: String,
    #[serde(default)] category: String,
    #[serde(default)] label: String,
    #[serde(default)] size_hint: String,
    #[serde(default)] license: String,
    #[serde(default)] install: Option<EngineInstallJson>,
}
#[derive(serde::Deserialize)]
struct EngineInstallJson {
    #[serde(default)] kind: String,
    #[serde(default)] files: Vec<EngineFileJson>,
}
#[derive(serde::Deserialize)]
struct EngineFileJson {
    #[serde(default)] mirrors: Vec<EngineMirrorJson>,
}
#[derive(serde::Deserialize)]
struct EngineMirrorJson {
    #[serde(default)] name: String,
}

// 读 asr-server/engines/*.json → 模型可下载清单（与后端 collectModels 的静态字段一致）
#[tauri::command]
fn get_models_catalog(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> Result<Vec<CatalogModel>, String> {
    let dir = server_dir(&app, &state).ok_or("无法定位 asr-server 目录（请在设置中配置）")?;
    let engines_dir = dir.join("engines");
    let mut names: Vec<String> = fs::read_dir(&engines_dir).map_err(|e| format!("读取 engines 目录失败：{e}"))?
        .filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    let mut out = Vec::new();
    for name in names {
        if !name.ends_with(".json") { continue; }
        let raw = fs::read_to_string(engines_dir.join(&name)).map_err(|e| format!("读取 {name} 失败：{e}"))?;
        let Ok(j) = serde_json::from_str::<EngineJson>(&raw) else { continue };
        let install = j.install.map(|i| {
            let kind = i.kind;
            CatalogInstall {
                kind: kind.clone(),
                mirrors: if kind == "url-multi" {
                    i.files.first().map(|f| f.mirrors.iter().map(|m| m.name.clone()).collect()).unwrap_or_default()
                } else { Vec::new() },
            }
        });
        out.push(CatalogModel {
            category: j.category,
            engine: j.id,
            label: j.label,
            size: j.size_hint,
            license: j.license,
            install,
        });
    }
    if out.is_empty() {
        return Err(format!("engines 目录为空或无法解析（{}），模型清单不可用", engines_dir.display()));
    }
    Ok(out)
}

// 本机磁盘剩余（字节）：本地文件系统直查，不依赖 9528（fs2 跨平台：win=GetDiskFreeSpaceEx / unix=statvfs）
#[tauri::command]
fn get_disk_local(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> Result<u64, String> {
    let dir = server_dir(&app, &state).ok_or("无法定位 asr-server 目录")?;
    fs2::available_space(&dir).map_err(|e| format!("磁盘探测失败：{e}"))
}

// ---------- 工具：找 node ----------
fn find_node() -> Option<String> {
    // 031 跨平台：Win 用 node.exe / PATH 分号 / nvm-windows；Unix 用 node / 冒号 / nvm-homebrew
    let is_win = std::env::consts::OS == "windows";
    let exe = if is_win { "node.exe" } else { "node" };
    let sep = if is_win { ';' } else { ':' };
    // 1) 环境变量显式指定
    if let Ok(p) = std::env::var("OPENSOUND_NODE_PATH") {
        if !p.is_empty() {
            return Some(p);
        }
    }
    // 2) PATH 中找（dev 时终端 PATH 有 node）
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(sep) {
            let cand = PathBuf::from(dir).join(exe);
            if cand.is_file() {
                return Some(cand.to_string_lossy().into_owned());
            }
        }
    }
    // 3) nvm 常见位置（Unix: ~/.nvm/versions/node/<v>/bin/node；Win: %APPDATA%\nvm\<v>\node.exe）
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        if !is_win {
            let nvm = PathBuf::from(&home).join(".nvm/versions/node");
            if let Ok(entries) = fs::read_dir(&nvm) {
                for e in entries.flatten() {
                    let cand = e.path().join("bin/node");
                    if cand.is_file() {
                        return Some(cand.to_string_lossy().into_owned());
                    }
                }
            }
        } else {
            let nvm = PathBuf::from(&home).join("AppData").join("Roaming").join("nvm");
            if let Ok(entries) = fs::read_dir(&nvm) {
                for e in entries.flatten() {
                    let cand = e.path().join("node.exe");
                    if cand.is_file() {
                        return Some(cand.to_string_lossy().into_owned());
                    }
                }
            }
        }
    }
    // 4) 常见固定位置
    if is_win {
        for p in [r"C:\Program Files\nodejs\node.exe", r"C:\Program Files (x86)\nodejs\node.exe"] {
            if PathBuf::from(p).is_file() {
                return Some(p.to_string());
            }
        }
    } else {
        for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
            if PathBuf::from(p).is_file() {
                return Some(p.to_string());
            }
        }
    }
    None
}

// ---------- 032 运行时自举：App 内一键安装 node / npm 依赖（普通用户免终端） ----------
// Win 下 node/npm/tar/taskkill 是控制台程序：GUI App spawn 它们而不设 CREATE_NO_WINDOW 会弹黑色命令窗口。
// 统一用 quiet() 包裹所有子进程 Command（Windows 静默；Unix 原样）。
#[cfg(windows)]
use std::os::windows::process::CommandExt;
fn quiet(mut c: Command) -> Command {
    #[cfg(windows)]
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    c
}

fn emit_progress(app: &tauri::AppHandle, step: &str, message: &str, pct: Option<u32>) {
    let _ = app.emit("runtime-progress", RuntimeProgress { step: step.to_string(), message: message.to_string(), pct });
}

fn node_version(node_exe: &str) -> Option<String> {
    let out = quiet(Command::new(node_exe)).arg("-v").output().ok()?;
    if !out.status.success() { return None; }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

fn node_major_ok(ver: &str) -> bool {
    // "v24.19.0" → 24
    let v = ver.trim_start_matches('v');
    let major = v.split('.').next().and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    major >= RUNTIME_NODE_MIN_MAJOR
}

// asr-server 的 node_modules 关键包是否就绪（sherpa-onnx-node = SenseVoice/Kokoro 原生栈）
fn deps_ready(server_dir: &std::path::Path) -> bool {
    let nm = server_dir.join("node_modules");
    if !nm.is_dir() { return false; }
    for pkg in ["sherpa-onnx-node", "node-llama-cpp", "@huggingface", "systeminformation"] {
        if !nm.join(pkg).is_dir() { return false; }
    }
    true
}

fn npm_cli_js(node_exe: &str) -> std::path::PathBuf {
    // node 同目录 node_modules/npm/bin/npm-cli.js（系统 node 与便携版 node 布局一致）
    let base = PathBuf::from(node_exe).parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
    base.join("node_modules").join("npm").join("bin").join("npm-cli.js")
}

// 解压目录里找 node-v*/ 下的 node 可执行文件
fn find_node_under(dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_dir() { continue; }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.starts_with("node-v") { continue; }
        let cand = if std::env::consts::OS == "windows" { p.join("node.exe") } else { p.join("bin").join("node") };
        if cand.is_file() { return Some(cand); }
    }
    None
}

// 流式下载文件（reqwest），进度经 runtime-progress 事件上报
async fn download_file(url: &str, dest: &std::path::Path, app: &tauri::AppHandle) -> Result<(), String> {
    let resp = reqwest::Client::new().get(url).send().await.map_err(|e| format!("下载失败 {}：{e}", url))?;
    if !resp.status().is_success() { return Err(format!("下载失败 {}：HTTP {}", url, resp.status())); }
    let total = resp.content_length().unwrap_or(0);
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    use futures_util::StreamExt;
    use tokio::io::AsyncWriteExt;
    let mut f = tokio::fs::File::create(dest).await.map_err(|e| format!("无法创建下载文件 {}：{e}", dest.display()))?;
    while let Some(chunk) = stream.next().await {
        let c = chunk.map_err(|e| format!("下载中断：{e}"))?;
        received += c.len() as u64;
        f.write_all(&c).await.map_err(|e| format!("写入失败：{e}"))?;
        let pct = if total > 0 { Some(((received * 100) / total) as u32) } else { None };
        emit_progress(app, "node-download", &format!("下载 node 运行环境 {}/{}", received, total), pct);
    }
    f.flush().await.map_err(|e| format!("写入失败：{e}"))?;
    Ok(())
}

// 解压 zip/tar.gz（Windows 自带 tar.exe 支持 zip；macOS/Linux 系统 tar）
fn unzip_archive(zip: &std::path::Path, dest_dir: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let st = quiet(Command::new("tar")).arg("-xf").arg(zip).arg("-C").arg(dest_dir).status().map_err(|e| format!("解压失败（需要系统 tar）：{e}"))?;
    if !st.success() { return Err(format!("解压失败：tar 退出码 {}", st.code().unwrap_or(-1))); }
    Ok(())
}

// 确保有可用的 node：受管便携版 → 系统 node（版本达标）→ 下载便携版
async fn ensure_node(app: &tauri::AppHandle, state: &Arc<AppState>) -> Result<String, String> {
    // 1) App 已下载的便携版优先（版本可控）
    if let Some(p) = state.runtime_node.lock().unwrap().clone() {
        if std::path::PathBuf::from(&p).is_file() {
            return Ok(p);
        }
    }
    // 2) 系统 node 版本达标 → 直接用
    if let Some(p) = find_node() {
        if let Some(v) = node_version(&p) {
            if node_major_ok(&v) {
                return Ok(p);
            }
            emit_progress(app, "node-download", &format!("系统 node 版本过低（{v}），改用 App 内置便携版…"), None);
        }
    }
    // 3) 下载便携版到 <app_data>/runtime/node
    let data_dir = app.path().app_data_dir().map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    let node_dir = data_dir.join("runtime").join("node");
    fs::create_dir_all(&node_dir).map_err(|e| format!("无法创建运行时目录：{e}"))?;
    let zip_name = if std::env::consts::OS == "windows" {
        format!("node-{}-win-x64.zip", RUNTIME_NODE_VERSION)
    } else {
        format!("node-{}-darwin-arm64.tar.gz", RUNTIME_NODE_VERSION)
    };
    let zip_path = node_dir.join(&zip_name);
    let mut last_err = String::new();
    for base in NODE_MIRRORS {
        let url = format!("{base}/{RUNTIME_NODE_VERSION}/{zip_name}");
        emit_progress(app, "node-download", &format!("从 {base} 下载…"), None);
        match download_file(&url, &zip_path, app).await {
            Ok(()) => { last_err.clear(); break; }
            Err(e) => {
                last_err = format!("{e}");
                emit_progress(app, "node-download", &last_err, None);
                emit_progress(app, "node-download", "切换镜像…", None);
            }
        }
    }
    if !last_err.is_empty() { return Err(last_err); }
    emit_progress(app, "node-download", "解压…", None);
    unzip_archive(&zip_path, &node_dir)?;
    let found = find_node_under(&node_dir).ok_or("解压后未找到 node 可执行文件")?;
    *state.runtime_node.lock().unwrap() = Some(found.to_string_lossy().into_owned());
    emit_progress(app, "node-download", &format!("node 就绪：{}", found.display()), Some(100));
    Ok(found.to_string_lossy().into_owned())
}

// 等待子进程退出（最多 timeout 秒；读线程已接管 stdout/stderr 消费，不会管道死锁）；
// 超时强杀并按失败处理；返回是否成功退出。
fn wait_with_timeout(c: &mut Child, secs: u64) -> Result<bool, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
    loop {
        match c.try_wait() {
            Ok(Some(st)) => return Ok(st.success()),
            Ok(None) => {}
            Err(e) => return Err(format!("等待子进程失败：{e}")),
        }
        if std::time::Instant::now() >= deadline {
            let _ = c.kill();
            let _ = c.wait();
            return Ok(false);
        }
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
}

// npm ci 安装 asr-server 依赖（strout/stderr 行转发为进度事件；npm≥11 拦截原生脚本时自动批准并 rebuild）
fn ensure_npm_deps(app: &tauri::AppHandle, server_dir: &std::path::Path, node_exe: &str) -> Result<(), String> {
    let cli = npm_cli_js(node_exe);
    if !cli.is_file() { return Err(format!("未找到 npm（{}），无法安装依赖", cli.display())); }
    let registry = std::env::var("OPENSOUND_NPM_REGISTRY").unwrap_or_else(|_| NPM_REGISTRY_DEFAULT.to_string());

    let run_npm = |args: &[&str], timeout_secs: u64| -> Result<(), String> {
        let mut child = quiet(Command::new(node_exe)).arg(&cli).args(args).current_dir(server_dir)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().map_err(|e| format!("启动 npm 失败：{e}"))?;
        use std::io::{BufRead, BufReader};
        let out = child.stdout.take().unwrap(); // ChildStdout
        let err = child.stderr.take().unwrap(); // ChildStderr
        // 行转发（stdout/stderr 各起一个读线程，避免管道占满死锁）
        {
            let app2 = app.clone();
            let stream = out; // ChildStdout
            std::thread::spawn(move || {
                for line in BufReader::new(stream).lines() {
                    let Ok(l) = line else { break };
                    let l = l.trim();
                    if l.is_empty() { continue; }
                    emit_progress(&app2, "deps", &l, None);
                }
            });
        }
        {
            let app2 = app.clone();
            let stream = err; // ChildStderr
            std::thread::spawn(move || {
                for line in BufReader::new(stream).lines() {
                    let Ok(l) = line else { break };
                    let l = l.trim();
                    if l.is_empty() { continue; }
                    eprintln!("[npm] {l}");
                    emit_progress(&app2, "deps", &l, None);
                }
            });
        }
        let mut c = child;
        let ok = wait_with_timeout(&mut c, timeout_secs)?;
        if !ok { return Err(format!("npm 命令超时或失败，已终止（{} 秒）", timeout_secs)); }
        Ok(())
    };

    emit_progress(app, "deps", "安装服务端依赖（npm ci，首次需数分钟）…", None);
    run_npm(&["ci", "--registry", &registry, "--replace-registry-host=always", "--loglevel=notice"], 1200)?;
    // npm ≥11 默认拦截未批准的 install 脚本（原生二进制下载），主动批准并触发；
    // rebuild 会从 GitHub 下载 llama/onnxruntime 预编译二进制（国内网络可能极慢/失败）——
    // 这两个仅 LLM 对话与 whisper 需要，失败不阻断：识别/朗读（sherpa 栈）不受影响，模型页会如实显示缺环境。
    emit_progress(app, "deps", "批准并安装原生推理组件（llama / onnxruntime）…", None);
    let _ = run_npm(&["install-scripts", "approve", "node-llama-cpp", "onnxruntime-node", "protobufjs", "sharp"], 180);
    match run_npm(&["rebuild", "node-llama-cpp", "onnxruntime-node", "protobufjs", "sharp"], 480) {
        Ok(()) => emit_progress(app, "deps", "原生推理组件就绪 ✓", None),
        Err(e) => emit_progress(app, "deps", &format!("⚠️ 原生推理组件（LLM/whisper）下载失败可稍后重试：{e}"), None),
    }
    Ok(())
}

// 一键自举：确保 node → 安装依赖 → 拉起服务（command 入口）
#[tauri::command]
async fn install_runtime(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    install_runtime_plain(app, state.inner().clone()).await
}

// 普通异步入口（setup 自动自举 / command 共用；state 传 Arc 避免借用冲突）
async fn install_runtime_plain(app: tauri::AppHandle, state: Arc<AppState>) -> Result<(), String> {
    {
        let mut g = state.runtime_installing.lock().unwrap();
        if *g { return Err("运行环境安装正在进行中，请稍候…".to_string()); }
        *g = true;
    }
    let result = install_runtime_inner(&app, &state).await;
    *state.runtime_installing.lock().unwrap() = false;
    result
}

async fn install_runtime_inner(app: &tauri::AppHandle, state: &Arc<AppState>) -> Result<(), String> {
    emit_progress(app, "done", "开始检测运行环境…", None);
    let dir = server_dir(app, state).ok_or("无法定位 asr-server 目录（请在设置中配置）")?;
    let node = ensure_node(app, state).await?;
    // 缓存的 node 也同时给 start_service 用（避免系统 node 缺失时服务起不来）
    *state.node_path.lock().unwrap() = Some(node.clone());
    if deps_ready(&dir) {
        emit_progress(app, "deps", "服务端依赖已就绪，跳过安装", None);
    } else {
        emit_progress(app, "deps", "服务端依赖缺失，开始安装…", None);
        let dir2 = dir.clone();
        let app2 = app.clone();
        let node2 = node.clone();
        // npm ci 是长任务（网络），放到 blocking 线程避免阻塞 UI
        tokio::task::spawn_blocking(move || ensure_npm_deps(&app2, &dir2, &node2))
            .await
            .map_err(|e| format!("安装任务异常：{e}"))??;
    }
    emit_progress(app, "done", "依赖就绪，启动服务…", None);
    start_service(app, state)?;
    emit_progress(app, "done", "完成", Some(100));
    Ok(())
}

#[tauri::command]
fn check_runtime(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> RuntimeStatus {
    let sys_node = find_node();
    let sys_node_found = sys_node.is_some();
    let runtime_node = state.runtime_node.lock().unwrap().clone();
    let mut node_path = String::new();
    let mut node_version_str = String::new();
    let mut node_ok = false;
    for cand in [runtime_node.as_deref(), sys_node.as_deref()].into_iter().flatten() {
        if let Some(v) = node_version(cand) {
            node_path = cand.to_string();
            node_version_str = v.clone();
            node_ok = node_major_ok(&v);
            break;
        }
    }
    // python 仅作信息展示（python 系引擎的自举后续由 uv 完成）
    let mut python_found = false;
    let mut python_version = String::new();
    for cmd in ["python", "python3"] {
        if let Ok(out) = quiet(Command::new(cmd)).arg("--version").output() {
            if out.status.success() {
                let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !v.is_empty() { python_found = true; python_version = v; break; }
            }
        }
    }
    let data_dir = app.path().app_data_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let server_dir_str = server_dir(&app, &state).map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let deps = server_dir(&app, &state).map(|d| deps_ready(&d)).unwrap_or(false);
    RuntimeStatus {
        node_ok,
        node_path,
        node_version: node_version_str,
        runtime_node: runtime_node.unwrap_or_default(),
        sys_node_found,
        python_found,
        python_version,
        deps_ready: deps,
        data_dir,
        server_dir: server_dir_str,
    }
}

// ---------- 配置读写（asr-server 路径持久化） ----------
fn config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    Some(dir.join("config.json"))
}

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct UiSettings {
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    deepseek_key: String,
    #[serde(default)]
    zhipu_key: String,
    // 030 阶段一：服务资源模式
    // power_mode = "full"（全能，全部拉起）| "eco"（节能，只留最小集 + eco_big）
    // eco_big    = "none" | "qwen3" | "cosyvoice" | "sensevoice-original"（节能下启用的大模型，单开）
    #[serde(default)]
    power_mode: String,
    #[serde(default)]
    eco_big: String,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct PersistedConfig {
    server_path: Option<String>,
    /// 032 P3：用户数据目录（模型/缓存/音色/运行时），默认 app_data_dir；可自定义
    #[serde(default)]
    data_dir: Option<String>,
    /// GUI 设置（服务地址/鉴权/云端 API Key）。此前存 WebView localStorage，
    /// 现统一迁入 config.json（见 011 §5.6 存储规范）。
    #[serde(default)]
    ui: UiSettings,
}

/// 数据根目录：配置优先，否则默认 app_data_dir（Win: %APPDATA%\world.opensound.local）
fn data_root(app: &tauri::AppHandle) -> PathBuf {
    if let Some(p) = load_config(app).data_dir {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."))
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

// ---------- 旧标识符（com.tabu.local）配置迁移 ----------
// identifier 从 com.tabu.local 升级到 world.opensound.local 后，app_config_dir 变化：
// 首次启动时若新 config.json 不存在，自动把旧目录下的 server_path 与 ui 设置
// （token / 资源模式 / 云端 Key 等）原样迁入新目录，用户无感、旧 token 持续有效。
fn legacy_config_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    let cands: Vec<PathBuf> = if std::env::consts::OS == "windows" {
        vec![PathBuf::from(std::env::var_os("APPDATA")?).join("com.tabu.local").join("config.json")]
    } else {
        vec![
            // macOS：~/Library/Application Support/com.tabu.local/config.json
            PathBuf::from(&home).join("Library").join("Application Support").join("com.tabu.local").join("config.json"),
            // Linux：~/.config/com.tabu.local/config.json
            PathBuf::from(&home).join(".config").join("com.tabu.local").join("config.json"),
        ]
    };
    cands.into_iter().find(|p| p.is_file())
}

fn migrate_legacy_config(app: &tauri::AppHandle) {
    let new_path = match config_path(app) {
        Some(p) => p,
        None => return, // 定位不到配置目录，跳过迁移
    };
    if new_path.exists() {
        return; // 新配置已初始化（非首次启动），不动
    }
    let Some(old_path) = legacy_config_path() else { return };
    let Ok(s) = fs::read_to_string(old_path) else { return };
    if let Some(dir) = new_path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    match fs::write(&new_path, &s) {
        Ok(()) => eprintln!("[opensound] 已迁移旧配置: com.tabu.local → world.opensound.local"),
        Err(e) => eprintln!("[opensound] 迁移旧配置失败: {e}"),
    }
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

// ---------- 032 P3 数据目录（模型存放目录）：读写 + 旧模型迁移 ----------
#[tauri::command]
fn get_data_root(app: tauri::AppHandle) -> String {
    data_root(&app).to_string_lossy().into_owned()
}

#[tauri::command]
fn set_data_root(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let mut cfg = load_config(&app);
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        cfg.data_dir = None; // 清空 = 回到默认 app_data_dir
    } else {
        let dir = std::path::PathBuf::from(&trimmed);
        fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录：{e}"))?;
        cfg.data_dir = Some(trimmed);
    }
    save_config(&app, &cfg)
}

// 把历史落盘在 asr-server/models 的模型迁移到数据目录 models（同盘 rename 优先，跨盘复制后删除）
#[tauri::command]
fn migrate_models_to_data(app: tauri::AppHandle, state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let server = server_dir(&app, &state).ok_or("无法定位 asr-server 目录")?;
    let src = server.join("models");
    if !src.is_dir() { return Ok("无旧模型目录可迁移（asr-server/models 不存在）".to_string()); }
    let entries: Vec<_> = fs::read_dir(&src).map_err(|e| e.to_string())?.filter_map(|e| e.ok()).collect();
    if entries.is_empty() { return Ok("旧模型目录为空，无需迁移".to_string()); }
    let dst = data_root(&app).join("models");
    fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
    let mut moved = 0;
    let mut failed = Vec::new();
    for e in entries {
        let name = e.file_name();
        let from = e.path();
        let to = dst.join(&name);
        if to.exists() { continue; }
        match fs::rename(&from, &to) {
            Ok(()) => moved += 1,
            Err(_) => match copy_dir_recursive(&from, &to) {
                Ok(()) => { let _ = fs::remove_dir_all(&from).or_else(|_| fs::remove_file(&from)); moved += 1; }
                Err(err) => failed.push(format!("{}（{}）", name.to_string_lossy(), err)),
            },
        }
    }
    if failed.is_empty() {
        Ok(format!("已迁移 {} 项到 {}", moved, dst.display()))
    } else {
        Ok(format!("迁移 {moved} 项；失败 {} 项：{}", failed.len(), failed.join("；")))
    }
}

fn copy_dir_recursive(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let e = entry.map_err(|e| e.to_string())?;
        let from_p = e.path();
        let to_p = to.join(e.file_name());
        if from_p.is_dir() { copy_dir_recursive(&from_p, &to_p)?; }
        else { fs::copy(&from_p, &to_p).map_err(|e| format!("{}：{e}", from_p.display()))?; }
    }
    Ok(())
}

// ---------- GUI 设置读写（config.json 的 ui 节；只覆盖传入的字段） ----------
#[tauri::command]
fn get_ui_settings(app: tauri::AppHandle) -> Result<UiSettings, String> {
    Ok(load_config(&app).ui)
}

#[tauri::command]
fn set_ui_settings(
    app: tauri::AppHandle,
    base_url: Option<String>,
    token: Option<String>,
    deepseek_key: Option<String>,
    zhipu_key: Option<String>,
    power_mode: Option<String>,
    eco_big: Option<String>,
) -> Result<(), String> {
    let mut cfg = load_config(&app);
    if let Some(v) = base_url { cfg.ui.base_url = v; }
    if let Some(v) = token { cfg.ui.token = v; }
    if let Some(v) = deepseek_key { cfg.ui.deepseek_key = v; }
    if let Some(v) = zhipu_key { cfg.ui.zhipu_key = v; }
    if let Some(v) = power_mode { cfg.ui.power_mode = v; }
    if let Some(v) = eco_big { cfg.ui.eco_big = v; }
    save_config(&app, &cfg)
}

/// 返回应用数据目录绝对路径（不打开；设置面板展示用）
#[tauri::command]
fn get_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 在系统文件管理器中打开应用数据目录（音频库/对话历史/config.json 都在这里）
#[tauri::command]
fn open_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开失败: {e}"))?;
    }
    Ok(dir.to_string_lossy().into_owned())
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
    // 3) 回退：从可执行文件所在目录向上逐级查找包含 asr-server 的项目根（开发模式）。
    //    深度 16：App Bundle（OpenSound.app/Contents/MacOS）到仓库根需要 8~9 级，
    //    旧值 8 在 bundle 运行时恰好差一级找不到 asr-server，导致服务静默起不来（改名后首次出现的"全部启动中"）。
    let mut dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    for _ in 0..16 {
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

// ---------- 安全：生成入站鉴权 token（128bit hex） ----------
// 首选 /dev/urandom 定长读取（macOS/Linux）；打开失败（如 Windows）退回 纳秒时钟⊕pid 的 SplitMix64 折叠。
fn gen_token() -> String {
    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{:02x}", x)).collect()
    }
    let mut buf = [0u8; 16];
    let ok = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut buf))
        .is_ok();
    if ok {
        return hex(&buf);
    }
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut x = t ^ (std::process::id() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let mut out = String::new();
    for _ in 0..4 {
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        out.push_str(&hex(&x.to_le_bytes()));
    }
    out
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

    // 安全加固②：入站鉴权 token —— config.json ui.token 为空时自动生成一次并持久化；
    // 同一 token 经 get_ui_settings 交给前端（api.ts jfetch 自动带 Bearer），并以 OPENSOUND_TOKEN 注入子进程校验。
    // 030 阶段一：资源模式 → OPENSOUND_SKIP_*（节能=默认关全部大模型服务，只留 9528 最小集：
    //   sherpa SenseVoice ASR + kokoro TTS + llm-0.5b 对话；eco_big=节能下用户启用的大模型，单开；全能=全开）
    let (token, skip_qwen3, skip_cosy, skip_sense_orig) = {
        let mut cfg = load_config(app);
        if cfg.ui.token.is_empty() {
            cfg.ui.token = gen_token();
            save_config(app, &cfg)?;
        }
        let skip = match (cfg.ui.power_mode.as_str(), cfg.ui.eco_big.as_str()) {
            ("eco", "qwen3") => (false, true, true),
            ("eco", "cosyvoice") => (true, false, true),
            ("eco", "sensevoice-original") => (true, true, false),
            // LLM 8B 在 9528 进程内（llama-cpp 按需加载），只需关闭三个 Python 大服务
            ("eco", "llm-qwen3-8b") => (true, true, true),
            ("eco", _) => (true, true, true), // 节能默认：大模型全关，只留最小集
            _ => (false, false, false),       // 全能默认：全部拉起
        };
        (cfg.ui.token, skip.0, skip.1, skip.2)
    };

    // 子进程日志落盘（此前 Stdio::null() 会丢弃全部输出，子服务崩溃时无从排查）
    let log_path = match app.path().app_log_dir() {
        Ok(d) => d.join("asr-server.log"),
        Err(e) => return Err(format!("无法定位日志目录: {e}")),
    };
    if let Some(parent) = log_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let open_log = || {
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|e| format!("无法打开日志文件 {}: {e}", log_path.display()))
    };
    let mut header = open_log()?;
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = writeln!(header, "\n[opensound] === 启动 asr-server (unix_ts={ts}) ===");

    let child = quiet(Command::new(&node))
        .arg(&entry)
        .current_dir(&dir)
        .env("ASR_ENGINE", "auto")
        .env("OPENSOUND_TOKEN", &token)
        // 032 P3：数据目录注入 —— 服务端所有模型/缓存/音色落盘均从该目录派生（代码目录只读）
        .env("OPENSOUND_DATA_DIR", data_root(app).to_string_lossy().into_owned())
        .env("OPENSOUND_SKIP_QWEN3", if skip_qwen3 { "1" } else { "" })
        .env("OPENSOUND_SKIP_COSYVOICE", if skip_cosy { "1" } else { "" })
        .env("OPENSOUND_SKIP_SENSEVOICE_ORIGINAL", if skip_sense_orig { "1" } else { "" })
        .stdout(Stdio::from(open_log()?))
        .stderr(Stdio::from(open_log()?))
        .spawn()
        .map_err(|e| format!("启动服务失败: {e}"))?;

    *state.child.lock().unwrap() = Some(child);
    println!("[opensound] 已启动 asr-server (node={node}, log={})", log_path.display());
    Ok(())
}

fn stop_service(state: &Arc<AppState>) {
    let mut guard = state.child.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let pid = child.id();
        // 031 生命周期：不能只 kill start-all（会留孤儿子进程占端口）。
        // Unix 发 SIGTERM → start-all 的信号 handler 会先杀全部子服务再退出；
        // Windows 用 taskkill /T 树杀。
        #[cfg(unix)]
        let _ = std::process::Command::new("kill").arg("-TERM").arg(pid.to_string()).status();
        #[cfg(windows)]
        let _ = quiet(std::process::Command::new("taskkill"))
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
        // 等 start-all 清理完子进程（最多 5 秒），超时兜底强杀
        for _ in 0..10 {
            if child.try_wait().ok().flatten().is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
    println!("[opensound] 服务已停止");
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

// ---------- 实时语音（Realtime，cpal 实时流 + 前端 VAD 切句） ----------
#[tauri::command]
fn realtime_start(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.realtime.start()
}

#[tauri::command]
fn realtime_read(state: State<'_, Arc<AppState>>, cursor: usize) -> Result<realtime::RealtimeRead, String> {
    state.realtime.read(cursor)
}

#[tauri::command]
fn realtime_stop(state: State<'_, Arc<AppState>>) -> Result<realtime::RealtimeRead, String> {
    state.realtime.stop()
}

#[tauri::command]
fn realtime_is_recording(state: State<'_, Arc<AppState>>) -> bool {
    state.realtime.is_recording()
}

#[tauri::command]
fn realtime_pause(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.realtime.pause()
}

#[tauri::command]
fn realtime_resume(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.realtime.resume()
}

#[tauri::command]
fn realtime_is_paused(state: State<'_, Arc<AppState>>) -> bool {
    state.realtime.is_paused()
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
        .tooltip("OpenSound 语音服务")
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
            // 首次启动：从旧标识符（com.tabu.local）迁移配置（identifier 升级后配置目录变化）
            migrate_legacy_config(&handle);
            // 加载 asr-server 路径配置到 state
            *state.server_path.lock().unwrap() = load_config(&handle).server_path;
            // 032 运行时预检（P2 拍板：启动只检测、不自动安装）：
            // 环境就绪（node + 依赖）→ 直接启动服务；不完整 → 不装任何东西，
            // 等用户在 UI 引导条点「一键安装」才执行（install_runtime）。
            let ready = {
                let sys_node = find_node().is_some();
                let deps = server_dir(&handle, &state).map(|d| deps_ready(&d)).unwrap_or(false);
                sys_node && deps
            };
            if ready {
                match start_service(&handle, &state) {
                    Ok(()) => {}
                    Err(e) => {
                        eprintln!("[opensound] 启动服务失败: {e}");
                        let _ = handle.emit("runtime-progress", RuntimeProgress {
                            step: "error".to_string(),
                            message: format!("服务启动失败：{e}"),
                            pct: None,
                        });
                    }
                }
            } else {
                eprintln!("[opensound] 运行环境不完整（node/依赖缺一），等待用户在界面点击「一键安装」");
            }
            setup_tray(&handle)?;

            // 健康轮询后台任务
            tauri::async_runtime::spawn(async move {
                poll_health(handle, state2).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // 031 生命周期：关闭窗口 = 退出 app 并停止全部服务（RunEvent::Exit → stop_service 杀服务树），
            // 避免"关闭再打开秒绿/孤儿进程占端口"。需要常驻托盘的用户可改回 hide。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_service_status,
            start_service_cmd,
            stop_service_cmd,
            quit_app,
            check_runtime,
            install_runtime,
            get_models_catalog,
            get_disk_local,
            recorder_start,
            recorder_stop,
            recorder_is_recording,
            realtime_start,
            realtime_read,
            realtime_stop,
            realtime_is_recording,
            realtime_pause,
            realtime_resume,
            realtime_is_paused,
            get_server_path,
            set_server_path,
            get_data_root,
            set_data_root,
            migrate_models_to_data,
            get_ui_settings,
            set_ui_settings,
            get_data_dir,
            open_data_dir,
            audio_store::audio_save,
            audio_store::audio_list,
            audio_store::audio_delete,
            audio_store::audio_get_dir,
            audio_store::audio_export,
            audio_store::audio_set_clone_sample,
            audio_store::audio_read_base64,
            conversation_store::conversation_list,
            conversation_store::conversation_get,
            conversation_store::conversation_save,
            conversation_store::conversation_rename,
            conversation_store::conversation_delete
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
