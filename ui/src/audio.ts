// ---------- 录音：MediaRecorder → AudioBuffer → 16kHz 单声道 WAV ----------
// asr-server 期望 16kHz 单声道 PCM/WAV（decodeToPcm16）

export interface Recorder {
  start(): void;
  stop(): Promise<Blob>; // 返回 WAV Blob
  cancel(): void;
  isRecording(): boolean;
}

export async function createRecorder(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  const mediaRecorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  let resolveStop: ((wav: Blob) => void) | null = null;
  let stopPromise: Promise<Blob> | null = null;
  let stopped = false;

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  mediaRecorder.onstop = async () => {
    if (stopped) return;
    stopped = true;
    // 释放麦克风
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
    try {
      const wav = await blobToWav16k(blob);
      resolveStop?.(wav);
    } catch (err) {
      resolveStop?.(Promise.reject(err) as never);
    }
  };

  return {
    start() {
      chunks.length = 0;
      stopped = false;
      stopPromise = new Promise<Blob>((res) => (resolveStop = res));
      mediaRecorder.start();
    },
    stop() {
      if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
      return stopPromise!;
    },
    cancel() {
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
      resolveStop?.(new Blob([]));
      stopPromise = Promise.resolve(new Blob([]));
    },
    isRecording() {
      return mediaRecorder.state === "recording";
    },
  };
}

// 把任意音频 Blob（webm/wav 等）解码并重采样为 16kHz 单声道 WAV
export async function blobToWav16k(blob: Blob): Promise<Blob> {
  const ab = await blob.arrayBuffer();
  const audioCtx = new AudioContext({ sampleRate: 16000 });
  try {
    const audioBuf = await audioCtx.decodeAudioData(ab);
    const sampleRate = audioBuf.sampleRate;
    const ch0 = audioBuf.getChannelData(0);
    // 混合多声道为单声道
    let mono: Float32Array;
    if (audioBuf.numberOfChannels > 1) {
      mono = new Float32Array(audioBuf.length);
      const sum = new Float32Array(audioBuf.length);
      for (let c = 0; c < audioBuf.numberOfChannels; c++) {
        const d = audioBuf.getChannelData(c);
        for (let i = 0; i < d.length; i++) sum[i] += d[i];
      }
      for (let i = 0; i < sum.length; i++) mono[i] = sum[i] / audioBuf.numberOfChannels;
    } else {
      mono = ch0;
    }

    let pcm: Int16Array;
    if (sampleRate === 16000) {
      pcm = floatToPcm16(mono);
    } else {
      // 线性重采样到 16kHz
      const ratio = sampleRate / 16000;
      const outLen = Math.round(mono.length / ratio);
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const src = Math.min(Math.floor(i * ratio), mono.length - 1);
        out[i] = mono[src];
      }
      pcm = floatToPcm16(out);
    }
    return pcmToWavBlob(pcm, 16000);
  } finally {
    audioCtx.close();
  }
}

function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function pcmToWavBlob(pcm: Int16Array, sampleRate: number): Blob {
  const numSamples = pcm.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, numSamples * 2, true);

  const out = new Int16Array(buffer, 44);
  out.set(pcm);
  return new Blob([buffer], { type: "audio/wav" });
}

// ---------- 播放 WAV ----------
let audioEl: HTMLAudioElement | null = null;
export function playWav(blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    stopAudio();
    const url = URL.createObjectURL(blob);
    const el = new Audio(url);
    audioEl = el;
    el.onended = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    el.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    el.play().catch(reject);
  });
}

export function stopAudio() {
  if (audioEl) {
    audioEl.pause();
    audioEl.src = "";
    audioEl = null;
  }
}

// ---------- 帧流播放（/speak 返回：每帧 = 4字节大端长度 + 一段 WAV） ----------
// 逐帧顺序播放；onFrameStart 每帧开始时回调（可选，用于 UI 提示"正在播放第 N 句"）
export interface FramePlayer {
  start(stream: ReadableStream<Uint8Array>): Promise<void>;
  stop(): void;
}

export function createFramePlayer(onFrameStart?: (index: number) => void): FramePlayer {
  let cancelled = false;
  let activeEl: HTMLAudioElement | null = null;

  async function playFrame(blob: Blob): Promise<void> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const el = new Audio(url);
      activeEl = el;
      const cleanup = () => {
        URL.revokeObjectURL(url);
        if (activeEl === el) activeEl = null;
      };
      el.onended = () => {
        cleanup();
        resolve();
      };
      el.onerror = () => {
        cleanup();
        resolve(); // 单帧失败不中断
      };
      el.play().catch(() => {
        cleanup();
        resolve();
      });
    });
  }

  return {
    async start(stream) {
      cancelled = false;
      const r = stream.getReader();
      let buf = new Uint8Array(0);
      let frameIndex = 0;
      // eslint-disable-next-line no-constant-condition
      while (!cancelled) {
        // 需要至少 4 字节来读帧长
        while (buf.length < 4) {
          const { done, value } = await r.read();
          if (done) return;
          const nb = new Uint8Array(buf.length + value.length);
          nb.set(buf, 0);
          nb.set(value, buf.length);
          buf = nb;
        }
        // 读 4 字节大端长度
        const frameLen =
          (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
        // 等够整帧
        while (buf.length < 4 + frameLen) {
          const { done, value } = await r.read();
          if (done) break;
          const nb = new Uint8Array(buf.length + value.length);
          nb.set(buf, 0);
          nb.set(value, buf.length);
          buf = nb;
        }
        if (buf.length < 4 + frameLen) break; // 流结束，剩余不完整
        const frame = buf.slice(4, 4 + frameLen);
        buf = buf.slice(4 + frameLen);
        onFrameStart?.(frameIndex++);
        // 顺序播放这一帧，中途被取消则停止
        if (cancelled) break;
        const blob = new Blob([frame], { type: "audio/wav" });
        await playFrame(blob);
      }
      r.releaseLock();
    },
    stop() {
      cancelled = true;
      if (activeEl) {
        activeEl.pause();
        activeEl.src = "";
        activeEl = null;
      }
    },
  };
}
