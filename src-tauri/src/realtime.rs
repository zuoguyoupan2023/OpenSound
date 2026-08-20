// 实时语音采集（cpal 实时流，供 Realtime 面板边录边用 VAD 切句识别）。
// 与 recorder.rs（一次性录音）完全隔离：这里只负责"持续累积 + 按游标增量取 16k 单声道 f32"，
// 不涉及 WAV/base64/识别。VAD 切句与逐句识别都在前端 realtime.ts 完成。
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

struct RealtimeInner {
    /// 16k 单声道 f32 样本，回调累积
    pcm: Arc<Mutex<Vec<f32>>>,
    /// 已通过 rt_read 交付给前端的样本数（游标），避免重复传输
    delivered: Arc<Mutex<usize>>,
    running: Arc<AtomicBool>,
    /// 暂停标记：为 true 时回调丢弃新样本（供前端"暂停/继续"）
    paused: Arc<AtomicBool>,
    input_rate: u32,
    _stream: Option<cpal::Stream>, // 持有 stream 保持采集存活
}

// cpal::Stream 在 macOS 上不是 Send；回调只访问 pcm/running（均为 Send），
// stream 的创建与 drop 都在同一把锁内，访问串行化。参考 recorder.rs 同样处理。
unsafe impl Send for RealtimeInner {}

#[derive(Clone, Default)]
pub struct Realtime {
    inner: Arc<Mutex<Option<RealtimeInner>>>,
}

#[derive(serde::Serialize)]
pub struct RealtimeRead {
    /// 本次新增的 16k 单声道 f32 样本
    pub samples: Vec<f32>,
    /// 交付后的新游标（供下次 rt_read 传入）
    pub cursor: usize,
    /// 当前已采集的原始采样率（用于展示/诊断）
    pub input_rate: u32,
    /// 当前已采集的总时长（秒）
    pub duration_sec: f64,
}

impl Realtime {
    /// 开始实时采集。返回 Ok(()) 或错误信息。
    pub fn start(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().unwrap();
        if guard.is_some() {
            return Err("实时采集已在运行".into());
        }

        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "未找到麦克风输入设备".to_string())?;
        let config = device
            .default_input_config()
            .map_err(|e| format!("无法获取输入配置: {e}"))?;

        let input_rate = config.sample_rate().0;
        let channels = config.channels() as usize;

        let pcm = Arc::new(Mutex::new(Vec::<f32>::new()));
        let delivered = Arc::new(Mutex::new(0usize));
        let running = Arc::new(AtomicBool::new(true));
        let paused = Arc::new(AtomicBool::new(false));

        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => {
                let p = pcm.clone();
                let r = running.clone();
                let pa = paused.clone();
                device
                    .build_input_stream(
                        &config.into(),
                        move |data: &[f32], _| {
                            if r.load(Ordering::Relaxed) && !pa.load(Ordering::Relaxed) {
                                let mut mono = Vec::with_capacity(data.len() / channels);
                                for ch in data.chunks(channels) {
                                    mono.push(ch.iter().sum::<f32>() / channels as f32);
                                }
                                p.lock().unwrap().extend_from_slice(&mono);
                            }
                        },
                        |err| eprintln!("实时采集错误: {err}"),
                        None,
                    )
                    .map_err(|e| format!("无法打开输入流: {e}"))?
            }
            cpal::SampleFormat::I16 => {
                let p = pcm.clone();
                let r = running.clone();
                let pa = paused.clone();
                device
                    .build_input_stream(
                        &config.into(),
                        move |data: &[i16], _| {
                            if r.load(Ordering::Relaxed) && !pa.load(Ordering::Relaxed) {
                                let mut mono = Vec::with_capacity(data.len() / channels);
                                for ch in data.chunks(channels) {
                                    let sum: i32 = ch.iter().map(|&v| v as i32).sum();
                                    mono.push((sum as f32 / channels as f32) / 32768.0);
                                }
                                p.lock().unwrap().extend_from_slice(&mono);
                            }
                        },
                        |err| eprintln!("实时采集错误: {err}"),
                        None,
                    )
                    .map_err(|e| format!("无法打开输入流: {e}"))?
            }
            other => return Err(format!("不支持的采样格式: {other:?}")),
        };

        stream.play().map_err(|e| format!("无法开始采集: {e}"))?;

        *guard = Some(RealtimeInner {
            pcm,
            delivered,
            running,
            paused,
            input_rate,
            _stream: Some(stream),
        });
        Ok(())
    }

    /// 取 cursor 之后的增量 16k f32 样本；若未在采集则返回错误。
    pub fn read(&self, cursor: usize) -> Result<RealtimeRead, String> {
        let guard = self.inner.lock().unwrap();
        let inner = guard.as_ref().ok_or("实时采集未在运行")?;
        let pcm = inner.pcm.lock().unwrap();
        let total = pcm.len();
        let start = cursor.min(total);
        let raw = &pcm[start..];
        let input_rate = inner.input_rate;
        // 从原始段重采样到 16k（线性插值，逐点独立、无跨块状态）
        let samples = resample_to_16k(raw, input_rate);
        let duration = total as f64 / input_rate as f64;
        drop(pcm);
        // 更新已交付游标
        *inner.delivered.lock().unwrap() = total;
        Ok(RealtimeRead {
            samples,
            cursor: total,
            input_rate,
            duration_sec: (duration * 100.0).round() / 100.0,
        })
    }

    /// 停止采集并返回从最后一次交付之后的剩余 16k f32 样本。
    pub fn stop(&self) -> Result<RealtimeRead, String> {
        let mut guard = self.inner.lock().unwrap();
        let inner = guard.take().ok_or("实时采集未在运行")?;
        inner.running.store(false, Ordering::Relaxed);
        let pcm = inner.pcm.lock().unwrap().clone();
        let delivered = *inner.delivered.lock().unwrap();
        let input_rate = inner.input_rate;
        let total = pcm.len();
        drop(inner); // stream drop → 停止采集

        let start = delivered.min(total);
        let raw = &pcm[start..];
        let samples = resample_to_16k(raw, input_rate);
        Ok(RealtimeRead {
            samples,
            cursor: total,
            input_rate,
            duration_sec: (total as f64 / input_rate as f64 * 100.0).round() / 100.0,
        })
    }

    pub fn is_recording(&self) -> bool {
        self.inner.lock().unwrap().is_some()
    }

    /// 暂停采集（回调丢弃新样本；已有样本保留）。
    pub fn pause(&self) -> Result<(), String> {
        let guard = self.inner.lock().unwrap();
        let inner = guard.as_ref().ok_or("实时采集未在运行")?;
        inner.paused.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// 恢复采集。
    pub fn resume(&self) -> Result<(), String> {
        let guard = self.inner.lock().unwrap();
        let inner = guard.as_ref().ok_or("实时采集未在运行")?;
        inner.paused.store(false, Ordering::Relaxed);
        Ok(())
    }

    /// 是否处于暂停态（用于 UI 回显）。
    pub fn is_paused(&self) -> bool {
        self.inner
            .lock()
            .unwrap()
            .as_ref()
            .map(|i| i.paused.load(Ordering::Relaxed))
            .unwrap_or(false)
    }
}

fn resample_to_16k(samples: &[f32], input_rate: u32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }
    if input_rate == 16000 {
        return samples.to_vec();
    }
    let ratio = input_rate as f64 / 16000.0;
    let out_len = (samples.len() as f64 / ratio).round().max(1.0) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = ((i as f64 * ratio).floor() as usize).min(samples.len() - 1);
        out.push(samples[src]);
    }
    out
}
