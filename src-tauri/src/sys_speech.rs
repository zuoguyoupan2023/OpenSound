// 000-plan-6 阶段1：系统语音识别（macOS SFSpeechRecognizer 兜底）
// Windows 系统识别（Windows.Media.SpeechRecognition）的自由听写是云端服务、离线不可用（见 plan-6 §3.2），不接。
// 输入 = 前端 cpal 录音的 16kHz 单声道 WAV（base64）；经 SFSpeechURLRecognitionRequest 转写。
// 定位：零下载兜底，不做主引擎；允许回落在线（不强制 requiresOnDeviceRecognition）。

#[derive(serde::Serialize)]
pub struct SysTranscribeResult {
    pub text: String,
    /// 运行时实际是否设备端识别（None = 框架未上报）
    pub on_device: Option<bool>,
    pub language: String,
}

/// 枚举本机 SFSpeechRecognizer 支持的识别 locale（macOS 10.15+；取决于系统已装语言）
#[tauri::command]
pub fn sys_supported_locales() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        mac::supported_locales()
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

#[tauri::command]
pub async fn sys_transcribe(
    wav_base64: String,
    language: String,
) -> Result<SysTranscribeResult, String> {
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(move || mac::transcribe(&wav_base64, &language))
            .await
            .map_err(|e| format!("系统识别线程失败: {e}"))?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (wav_base64, language);
        Err(
            "系统识别当前仅 macOS 支持（Windows 系统识别为云端服务，离线不可用；\
             已有 Whisper/SenseVoice 离线引擎覆盖）"
                .into(),
        )
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::SysTranscribeResult;
    use base64::Engine;
    use objc2::AnyThread;
    use block2::RcBlock;
    use objc2_foundation::{NSError, NSLocale, NSURL};
    use objc2_speech::{
        SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
        SFSpeechURLRecognitionRequest,
    };
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
    const TASK_TIMEOUT: Duration = Duration::from_secs(60);

    pub fn supported_locales() -> Vec<String> {
        let mut out: Vec<String> = unsafe { SFSpeechRecognizer::supportedLocales() }
            .iter()
            .map(|l| l.localeIdentifier().to_string())
            .collect();
        out.sort();
        out
    }

    pub fn transcribe(wav_base64: &str, language: &str) -> Result<SysTranscribeResult, String> {
        let wav = base64::engine::general_purpose::STANDARD
            .decode(wav_base64)
            .map_err(|e| format!("解码录音失败: {e}"))?;
        let tmp = std::env::temp_dir().join(format!(
            "opensound-sys-asr-{}.wav",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::write(&tmp, &wav).map_err(|e| format!("写临时音频失败: {e}"))?;
        let out = unsafe { transcribe_file(&tmp, language) };
        let _ = std::fs::remove_file(&tmp);
        out
    }

    unsafe fn wait_authorized() -> Result<(), String> {
        let status = SFSpeechRecognizer::authorizationStatus();
        match status {
            SFSpeechRecognizerAuthorizationStatus::Authorized => return Ok(()),
            SFSpeechRecognizerAuthorizationStatus::Denied
            | SFSpeechRecognizerAuthorizationStatus::Restricted => {
                return Err("语音识别权限被拒绝：请到 系统设置 → 隐私与安全性 → 语音识别 允许 OpenSound"
                    .into())
            }
            _ => {}
        }
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |s: SFSpeechRecognizerAuthorizationStatus| {
            let _ = tx.send(s);
        });
        unsafe { SFSpeechRecognizer::requestAuthorization(&block) };
        let got = rx
            .recv_timeout(AUTH_TIMEOUT)
            .map_err(|_| "语音识别授权等待超时（首次使用请在弹窗中允许）".to_string())?;
        match got {
            SFSpeechRecognizerAuthorizationStatus::Authorized => Ok(()),
            _ => Err(
                "语音识别权限未授权：请到 系统设置 → 隐私与安全性 → 语音识别 允许 OpenSound"
                    .into(),
            ),
        }
    }

    unsafe fn transcribe_file(path: &std::path::Path, language: &str) -> Result<SysTranscribeResult, String> {
        unsafe { wait_authorized()? };

        let path_str = objc2_foundation::NSString::from_str(&path.to_string_lossy());
        let url = NSURL::fileURLWithPath(&path_str);
        let lang = objc2_foundation::NSString::from_str(language);
        let locale = NSLocale::initWithLocaleIdentifier(NSLocale::alloc(), &lang);
        let recognizer = unsafe {
            SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale)
        }
        .ok_or_else(|| format!("系统不支持识别语言 {language}"))?;
        if !unsafe { recognizer.isAvailable() } {
            return Err("系统识别服务当前不可用（isAvailable=false）".into());
        }
        let on_device = Some(unsafe { recognizer.supportsOnDeviceRecognition() });

        let request = unsafe {
            SFSpeechURLRecognitionRequest::initWithURL(
                SFSpeechURLRecognitionRequest::alloc(),
                &url,
            )
        };
        unsafe { request.setShouldReportPartialResults(false) };

        // resultHandler 收到每段结果；isFinal 才结束。用通道 + 截止时间收敛为同步调用。
        let (tx, rx) = mpsc::channel::<Result<(String, bool), String>>();
        let handler = RcBlock::new(
            move |result: *mut objc2_speech::SFSpeechRecognitionResult,
                  err: *mut NSError| {
                if !err.is_null() {
                    let e = unsafe { &*err };
                    let _ = tx.send(Err(format!(
                        "系统识别错误 {}: {}",
                        e.code(),
                        e.localizedDescription().to_string()
                    )));
                    return;
                }
                if result.is_null() {
                    return;
                }
                let r = unsafe { &*result };
                let text = r.bestTranscription().formattedString().to_string();
                let _ = tx.send(Ok((text, r.isFinal())));
            },
        );
        let task = unsafe {
            recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler)
        };

        let deadline = Instant::now() + TASK_TIMEOUT;
        let mut latest = String::new();
        loop {
            let now = Instant::now();
            if now >= deadline {
                unsafe { task.cancel() };
                if latest.is_empty() {
                    return Err("系统识别超时（60s）".into());
                }
                break;
            }
            match rx.recv_timeout(deadline - now) {
                Ok(Ok((text, is_final))) => {
                    latest = text;
                    if is_final {
                        break;
                    }
                }
                Ok(Err(e)) => {
                    unsafe { task.cancel() };
                    return Err(e);
                }
                Err(_) => { /* 通道关闭且无结果 → 走超时逻辑 */ }
            }
        }
        if latest.is_empty() {
            return Err("系统识别没有返回文本（可能没有检测到语音）".into());
        }
        Ok(SysTranscribeResult {
            text: latest,
            on_device,
            language: language.to_string(),
        })
    }
}
