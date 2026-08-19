// 原生麦克风录音（cpal）：采集 → 重采样到 16kHz 单声道 → WAV 二进制
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct RecorderInner {
    samples: Arc<Mutex<Vec<f32>>>,
    running: Arc<AtomicBool>,
    input_rate: u32,
    _stream: Option<cpal::Stream>, // 持有 stream 保持录音存活
}

// cpal::Stream 在 macOS 上不是 Send（含 *mut ()）。
// 安全说明：stream 的创建与 drop 都发生在同一把 Mutex 锁内，所有访问串行化；
// 回调仅访问 samples/running（均为 Send）。跨线程 drop 在 macOS CoreAudio 下可行。
unsafe impl Send for RecorderInner {}

#[derive(Clone)]
pub struct Recorder {
    inner: Arc<Mutex<Option<RecorderInner>>>,
}

#[derive(serde::Serialize)]
pub struct RecordingResult {
    pub wav_base64: String,
    pub duration_sec: f64,
    pub sample_rate: u32,
}

impl Default for Recorder {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
        }
    }
}

impl Recorder {
    pub fn new() -> Self {
        Self::default()
    }

    /// 开始录音。返回 0 表示成功，否则返回错误信息。
    pub fn start(&self) -> Result<(), String> {
        let mut guard = self.inner.lock().unwrap();
        if guard.is_some() {
            return Err("已经在录音中".into());
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

        let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
        let running = Arc::new(AtomicBool::new(true));

        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => {
                let s = samples.clone();
                let r = running.clone();
                device
                    .build_input_stream(
                        &config.into(),
                        move |data: &[f32], _| {
                            if r.load(Ordering::Relaxed) {
                                let mut mono = Vec::with_capacity(data.len() / channels);
                                for ch in data.chunks(channels) {
                                    mono.push(ch.iter().sum::<f32>() / channels as f32);
                                }
                                s.lock().unwrap().extend_from_slice(&mono);
                            }
                        },
                        |err| eprintln!("录音错误: {err}"),
                        None,
                    )
                    .map_err(|e| format!("无法打开输入流: {e}"))?
            }
            cpal::SampleFormat::I16 => {
                let s = samples.clone();
                let r = running.clone();
                device
                    .build_input_stream(
                        &config.into(),
                        move |data: &[i16], _| {
                            if r.load(Ordering::Relaxed) {
                                let mut mono = Vec::with_capacity(data.len() / channels);
                                for ch in data.chunks(channels) {
                                    let sum: i32 = ch.iter().map(|&v| v as i32).sum();
                                    mono.push((sum as f32 / channels as f32) / 32768.0);
                                }
                                s.lock().unwrap().extend_from_slice(&mono);
                            }
                        },
                        |err| eprintln!("录音错误: {err}"),
                        None,
                    )
                    .map_err(|e| format!("无法打开输入流: {e}"))?
            }
            other => return Err(format!("不支持的采样格式: {other:?}")),
        };

        stream.play().map_err(|e| format!("无法开始录音: {e}"))?;

        *guard = Some(RecorderInner {
            samples,
            running,
            input_rate,
            _stream: Some(stream),
        });
        Ok(())
    }

    /// 停止录音并返回 16kHz 单声道 WAV（base64）。
    pub fn stop(&self) -> Result<RecordingResult, String> {
        let mut guard = self.inner.lock().unwrap();
        let inner = guard.take().ok_or("未在录音")?;
        inner.running.store(false, Ordering::Relaxed);
        let samples = inner.samples.lock().unwrap().clone();
        let input_rate = inner.input_rate;
        // stream 在此 drop → 停止录音
        drop(inner);

        let duration = samples.len() as f64 / input_rate as f64;
        let pcm16 = resample_to_16k(&samples, input_rate);
        let wav = pcm_to_wav(&pcm16, 16000);
        let wav_base64 = base64_encode(&wav);
        Ok(RecordingResult {
            wav_base64,
            duration_sec: (duration * 10.0).round() / 10.0,
            sample_rate: 16000,
        })
    }

    pub fn is_recording(&self) -> bool {
        self.inner.lock().unwrap().is_some()
    }
}

fn resample_to_16k(samples: &[f32], input_rate: u32) -> Vec<i16> {
    if samples.is_empty() {
        return Vec::new();
    }
    if input_rate == 16000 {
        samples.iter().map(|&s| f32_to_i16(s)).collect()
    } else {
        let ratio = input_rate as f64 / 16000.0;
        let out_len = (samples.len() as f64 / ratio).round() as usize;
        let mut out = Vec::with_capacity(out_len);
        for i in 0..out_len {
            let src = ((i as f64 * ratio).floor() as usize).min(samples.len() - 1);
            out.push(f32_to_i16(samples[src]));
        }
        out
    }
}

fn f32_to_i16(s: f32) -> i16 {
    let c = s.clamp(-1.0, 1.0);
    let scale = if c < 0.0 { 32768.0 } else { 32767.0 };
    (c * scale) as i16
}

fn pcm_to_wav(pcm: &[i16], sample_rate: u32) -> Vec<u8> {
    let data_size = pcm.len() * 2;
    let mut wav = Vec::with_capacity(44 + data_size);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_size as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data_size as u32).to_le_bytes());
    for &s in pcm {
        wav.extend_from_slice(&s.to_le_bytes());
    }
    wav
}

fn base64_encode(bytes: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        out.push(CHARS[(b0 >> 2) as usize] as char);
        out.push(CHARS[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            CHARS[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            CHARS[(b2 & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}
