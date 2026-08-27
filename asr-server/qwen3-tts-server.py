#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Qwen3-TTS 本地服务（低延迟轻量 TTS，供 asr-server 转发调用）。

用法：
  pip install -U qwen-tts torch            # 首次安装（torch 已有可省略）
  python3 qwen3-tts-server.py --port 8001  # 启动（默认设备 mps，Apple 芯片）

参数：
  --port       监听端口（默认 8001，asr-server 转发目标）
  --device     mps | cpu（默认 mps；无 GPU/Apple 芯片用 cpu）
  --model      HF 模型名（默认 Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice，轻量低延迟）
  --hf-mirror  国内使用：HF_ENDPOINT=https://hf-mirror.com 拉取模型

接口：
  GET  /health          → { ok, model, sr }
  POST /speak           body=JSON { text, voice, language } → WAV 二进制（audio/wav）
  POST /speak?stream=1  body=JSON { text, voice, language, roles?, roleMap? } → 帧流（application/octet-stream）
                        帧协议 = 4 字节大端长度 + 一段 WAV，逐句合成、合成完即 flush；
                        首帧延迟 ≈ 首句合成时间（013-P2① 流式，把整段 16s 压到首句级）。
      voice    预设音色名（0.6B-CustomVoice 9 个：Vivian/Serena/Uncle_Fu/Dylan/Eric/Ryan/Aiden/Ono_Anna/Sohee）
      language 语言（Chinese/English/Japanese... 默认 Auto）
      roles    'auto' | 'on' | 'off'（多角色朗读，015 §五 / 014 §七 A 路线）
               auto：文本含 ≥2 个「角色名：内容」行则自动多角色；默认 auto。
               多角色时不同角色用不同 Qwen3 预设音色（roleMap 指定，缺省按出现顺序轮转 9 个）。

说明：
  - 官方 qwen-tts 0.1.1 无真流式（non_streaming_mode 仅模拟流式文本输入），
    故「流式」= 服务端逐句 generate_custom_voice + 帧协议（与 asr-server kokoro 一致）。
  - ThreadingHTTPServer 并发请求下 MPS 推理非线程安全，用全局 RLock 串行化；
    流式请求整段持锁，避免多请求逐句交错。
"""

import argparse
import array
import io
import json
import os
import re
import struct
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# 生成参数参考：
#   model = Qwen3TTSModel.from_pretrained(model_name, device_map=device, dtype=torch.bfloat16)
#   wavs, sr = model.generate_custom_voice(text, language=lang, speaker=voice)  # 返回 float32 list + 24000
# 0.6B 不支持 instruct（忽略即可）。

GEN_LOCK = threading.RLock()  # 串行化推理：MPS 并发不安全；流式请求整段持锁


def split_sentences_only(text, max_chars=150):
    """逐句切分（013-P1 流式）：不跨句合并，每句独立成帧、首句尽早流出；超长句按 max_chars 截断。
    与 asr-server.js splitSentencesOnly 一致。"""
    sentences = re.split(r'[。！？；….!?;\n]+', text)
    out = []
    for s in sentences:
        s = s.strip()
        if not s:
            continue
        if len(s) <= max_chars:
            out.append(s)
            continue
        for i in range(0, len(s), max_chars):
            out.append(s[i:i + max_chars])
    return out if out else [text[:max_chars]]


# ---------- 多角色朗读（015 §五 / 014 §七 A 路线）：Qwen3 9 预设 speaker 按角色拼装 ----------
# 文本含「角色名：内容」行（每行一个角色）时，不同角色用不同 Qwen3 预设音色，拼成对话流。
QWEN3_SPEAKERS = ['Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono_Anna', 'Sohee']
ROLE_LINE_RE = re.compile(r'^([^：:]{1,12})[：:]\s*(.*)$')
# 排除列表/说明类标签，避免把「第一步：/注意：/Note:」当角色
NON_ROLE_PAT = re.compile(
    r'^(第[一二三四五六七八九十0-9]+[步点条项个]|步骤|注意|提示|说明|备注|总结|答案|解析|示例|note|more|warning|info|tips|example|answer)$',
    re.IGNORECASE)


def parse_role_lines(text):
    """按行切分：识别「角色名：内容」→ (role, content)；无角色行 → (None, line)。"""
    segments = []
    for raw in text.split('\n'):
        line = raw.strip()
        if not line:
            continue
        m = ROLE_LINE_RE.match(line)
        if m and m.group(2).strip() and not NON_ROLE_PAT.match(m.group(1).strip()):
            segments.append((m.group(1).strip(), m.group(2).strip()))
        else:
            segments.append((None, line))
    return segments


def is_multi_role(segments):
    """≥2 个不同角色名 → 判定为对话，启用多角色。"""
    return len({r for r, _ in segments if r is not None}) >= 2


def assign_role_speakers(segments, role_map=None):
    """角色名 → Qwen3 speaker：优先显式 role_map，否则按首次出现顺序轮转 9 个预设音色。"""
    role_map = role_map or {}
    mapping = {}
    idx = 0
    for role, _ in segments:
        if role is None or role in mapping:
            continue
        mapping[role] = role_map.get(role) or QWEN3_SPEAKERS[idx % len(QWEN3_SPEAKERS)]
        idx += 1
    return mapping


def load_model(model_name, device, hf_mirror):
    if hf_mirror:
        os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
    try:
        import torch
    except ImportError:
        raise RuntimeError('缺少 torch：pip install torch')
    try:
        from qwen_tts import Qwen3TTSModel
    except ImportError:
        raise RuntimeError('缺少 qwen-tts：pip install -U qwen-tts')
    if device not in ('cuda', 'mps', 'cpu'):
        # 031 跨平台：自动检测 cuda → mps → cpu（Windows=N卡走 cuda，Mac 走 mps）
        device = 'cuda' if torch.cuda.is_available() else ('mps' if torch.backends.mps.is_available() else 'cpu')
    print(f'[qwen3-tts] 加载模型 {model_name} (device={device})… 首次会下载，较慢')
    model = Qwen3TTSModel.from_pretrained(model_name, device_map=device, dtype=torch.bfloat16)
    print('[qwen3-tts] 模型就绪')
    return model


def warmup(model):
    """启动预热：首次推理含 MPS 内核初始化（实测 ~4-6s），预热掉避免拖慢第一个用户请求（与 kokoro 同理）。"""
    try:
        t0 = time.time()
        synth_wav(model, '你好。', 'Vivian', 'Auto')
        print(f'[qwen3-tts] 预热完成（{(time.time() - t0) * 1000:.0f}ms）')
    except Exception as e:
        print(f'[qwen3-tts] 预热失败（不影响使用）: {e}')


def synth_wav(model, text, voice, language):
    with GEN_LOCK:  # MPS 推理非线程安全，串行化
        wavs, sr = model.generate_custom_voice(
            text=text,
            language=language or 'Auto',
            speaker=voice or 'Vivian',
        )
    return _wav_from_samples(wavs, sr)


def _wav_from_samples(wavs, sr):
    """float32 采样 list → 16-bit PCM WAV（generate 在锁内完成，编码为纯 CPU 工作放锁外）。"""
    # wavs 为 float32 采样 list（单声道），写入 16-bit PCM WAV
    samples = wavs[0] if isinstance(wavs, (list, tuple)) else wavs
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        arr = array.array('h', (max(-32768, min(32767, int(s * 32767))) for s in samples))
        w.writeframes(arr.tobytes())
    return buf.getvalue()


def frame_wav(wav):
    """写一帧（与 asr-server 流式协议一致）：4 字节大端长度 + 一段 WAV。"""
    return struct.pack('>I', len(wav)) + wav


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 静默访问日志，保留错误
        if args and 'POST' in fmt:
            print(f'[qwen3-tts] {args[0]}')

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length).decode('utf-8') or '{}'
        return json.loads(raw)

    def _stream_speak(self, text, voice, language, roles_mode='auto', role_map=None):
        """逐句合成 + 帧协议流式：首帧 ≈ 首句合成时间；HTTP/1.0 无 Content-Length → 连接关闭即 EOF。
        roles_mode: 'auto'（≥2 角色自动启用多角色）| 'on' | 'off'；多角色 = 每段用对应角色 speaker 合成。"""
        default_voice = voice or 'Vivian'
        segments = parse_role_lines(text)
        use_roles = roles_mode == 'on' or (roles_mode == 'auto' and is_multi_role(segments))
        mapping = {}
        items = []
        if use_roles:
            mapping = assign_role_speakers(segments, role_map)
            for role, content in segments:
                spk = mapping.get(role, default_voice) if role else default_voice
                for s in split_sentences_only(content):
                    items.append((s, spk))
        else:
            for s in split_sentences_only(text):
                items.append((s, default_voice))
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.end_headers()
        self.wfile.flush()
        t0 = time.time()
        first_ms = -1
        n_frames = 0
        with GEN_LOCK:  # 整段持锁：避免多请求逐句交错、且覆盖 MPS 并发安全
            for s, spk in items:
                wav = synth_wav(MODEL, s, spk, language)
                if not wav:
                    continue
                self.wfile.write(frame_wav(wav))
                self.wfile.flush()
                n_frames += 1
                if first_ms < 0:
                    first_ms = (time.time() - t0) * 1000
        tag = '多角色' if use_roles else ''
        extra = f' · 角色 {list(mapping.items())}' if use_roles else ''
        print(f'[qwen3-tts] {tag}流式 {len(items)} 段 → {n_frames} 帧 · 首帧 {first_ms:.0f}ms · 总 {(time.time() - t0) * 1000:.0f}ms{extra}')

    def do_GET(self):
        if self.path.split('?')[0] == '/health':
            self._send_json(200, {'ok': True, 'model': MODEL_NAME, 'sr': 24000})
        else:
            self._send_json(404, {'error': 'not found'})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != '/speak':
            self._send_json(404, {'error': 'not found'})
            return
        try:
            payload = self._read_body()
            text = str(payload.get('text') or '').strip()
            if not text:
                self._send_json(400, {'error': '缺少 text'})
                return
            stream = parse_qs(parsed.query).get('stream', ['0'])[0] == '1'
            voice, language = payload.get('voice'), payload.get('language')
            roles_mode = str(payload.get('roles') or 'auto')  # 'auto' | 'on' | 'off'（多角色朗读）
            role_map = payload.get('roleMap') if isinstance(payload.get('roleMap'), dict) else {}
            if stream:
                self._stream_speak(text, voice, language, roles_mode, role_map)
            else:
                audio = synth_wav(MODEL, text, voice, language)
                self.send_response(200)
                self.send_header('Content-Type', 'audio/wav')
                self.send_header('Content-Length', str(len(audio)))
                self.end_headers()
                self.wfile.write(audio)
        except Exception as e:
            print(f'[qwen3-tts] 错误: {e}')
            self._send_json(500, {'error': str(e)})


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='Qwen3-TTS 本地服务')
    ap.add_argument('--port', type=int, default=8001)
    ap.add_argument('--device', default=None, help='cuda | mps | cpu（默认自动检测）')
    ap.add_argument('--model', default='Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice')
    ap.add_argument('--hf-mirror', action='store_true', help='使用 hf-mirror 下载模型')
    args = ap.parse_args()

    MODEL = load_model(args.model, args.device, args.hf_mirror)
    MODEL_NAME = args.model
    warmup(MODEL)
    srv = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'[qwen3-tts] 服务已启动: http://127.0.0.1:{args.port}（POST /speak → WAV；?stream=1 → 帧流）')
    srv.serve_forever()
