#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CosyVoice3 本地语音克隆服务（独立进程，供 asr-server 转发调用）。

用法：
  python3 cosyvoice-tts-server.py --port 8003 --model-dir models/cosyvoice/Fun-CosyVoice3-0.5B --voice-dir data/clone-voices

参数：
  --port        监听端口（默认 8003，asr-server 转发目标）
  --model-dir   CosyVoice3 模型目录（默认 models/cosyvoice/Fun-CosyVoice3-0.5B）
  --voice-dir   克隆音色存储目录（默认 data/clone-voices，每个音色一个子目录）
  --device      mps | cpu（默认 mps；Apple 芯片）

接口：
  GET  /health        → { ok, model, sr, voices }
  GET  /voices        → { voices: [{voiceId,name,referenceText,created_at,engine}] }  列出克隆音色
  POST /clone         body=JSON { name, referenceText, wavBase64 } → { voiceId, name, ... }
                        参考录音(16kHz 单声道 wav)以 base64 传入 → 生成/注册一个克隆音色并持久化
  POST /voice/rename  body=JSON { voiceId, name } → { ok }
  POST /voice/delete  body=JSON { voiceId }       → { ok }
  POST /speak         body=JSON { text, voice }   → WAV 二进制（audio/wav）
  POST /speak?stream=1 body=JSON { text, voice }  → 帧流（application/octet-stream）
                        帧协议 = 4 字节大端长度 + 一段 WAV，逐句合成、合成完即 flush（与 asr-server 一致）

说明：
  - 克隆音色 = CosyVoice3 零样本范式：保存参考音频 + 参考提示文本。
    进程启动时对已存音色调 add_zero_shot_spk 重建特征缓存；/speak 用 zero_shot_spk_id 直接合成。
  - MPS 推理非线程安全，用全局 RLock 串行化；流式请求整段持锁。
  - 依赖：.venv-cosyvoice（复用系统 torch），import 自本地 CosyVoice 源码（cosyvoice 包 + third_party/Matcha-TTS）。
"""

import argparse
import array
import base64
import io
import json
import os
import re
import struct
import sys
import threading
import time
import uuid
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# 指向本地 CosyVoice 源码（cosyvoice 包 + third_party/Matcha-TTS 子模块）
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, 'CosyVoice'))
sys.path.insert(0, os.path.join(_HERE, 'CosyVoice', 'third_party', 'Matcha-TTS'))

GEN_LOCK = threading.RLock()   # 串行化 MPS 推理；流式请求整段持锁
MODEL = None
MODEL_NAME = ''
VOICE_DIR = ''


def split_sentences(text, max_chars=120):
    """逐句切分（与 asr-server 帧协议一致）；超长句按 max_chars 截断。"""
    out = []
    for s in re.split(r'[。！？；….!?;\n]+', text):
        s = s.strip()
        if not s:
            continue
        if len(s) <= max_chars:
            out.append(s)
            continue
        for i in range(0, len(s), max_chars):
            out.append(s[i:i + max_chars])
    return out if out else [text[:max_chars]]


def normalize_reference(text):
    """CosyVoice3 要求参考提示文本含 <|endofprompt|> 标记，缺则自动加前缀。"""
    marker = '<|endofprompt|>'
    text = text or ''
    if marker not in text:
        text = 'You are a helpful assistant.' + marker + text
    return text


def load_model(model_dir, device):
    import torch
    from cosyvoice.cli.cosyvoice import AutoModel
    if device not in ('mps', 'cpu'):
        device = 'mps' if torch.backends.mps.is_available() else 'cpu'
    print(f'[cosyvoice] 加载模型 {model_dir} (device={device})… 首次加载较慢')
    t0 = time.time()
    model = AutoModel(model_dir=model_dir)
    print(f'[cosyvoice] 模型就绪（加载 {time.time() - t0:.0f}s，sample_rate={model.sample_rate}）')
    return model


# ---------- 克隆音色管理 ----------
def _cfg_path(vid):
    return os.path.join(VOICE_DIR, vid, 'config.json')


def read_voices():
    out = []
    if not os.path.isdir(VOICE_DIR):
        return out
    for vid in sorted(os.listdir(VOICE_DIR)):
        cfg = _cfg_path(vid)
        if os.path.isfile(cfg):
            try:
                d = json.load(open(cfg, encoding='utf-8'))
                d['voiceId'] = vid
                out.append(d)
            except Exception as e:
                print(f'[cosyvoice] 读取音色 {vid} 失败: {e}')
    return out


def register_voice(vid):
    """把已存的参考音频+文本重建为音色特征缓存（进程启动/新建时调用）。"""
    cfg = json.load(open(_cfg_path(vid), encoding='utf-8'))
    ref = os.path.join(VOICE_DIR, vid, 'ref.wav')
    with GEN_LOCK:
        MODEL.add_zero_shot_spk(cfg.get('referenceText', ''), ref, vid)
    return True


def create_voice(name, reference_text, wav_base64):
    vid = 'cv_' + uuid.uuid4().hex[:10]
    d = os.path.join(VOICE_DIR, vid)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, 'ref.wav'), 'wb') as f:
        f.write(base64.b64decode(wav_base64))
    cfg = {
        'name': name or '我的克隆音色',
        'referenceText': normalize_reference(reference_text),
        'created_at': int(time.time() * 1000),
        'engine': 'cosyvoice',
    }
    with open(_cfg_path(vid), 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False)
    register_voice(vid)
    # 预生成一段预设试听音频，供前端"试听"直接播放（避免每次现场合成等待）
    _gen_preview(vid)
    return {'voiceId': vid, **cfg}


# 预设试听文本
PREVIEW_TEXT = '你好，这是克隆音色的试听效果。'


def _gen_preview(vid):
    """用该音色合成预设试听句，存为 preview.wav；失败不影响音色本身。"""
    try:
        wavs = [w for s in split_sentences(PREVIEW_TEXT) if (w := synth_segment(s, vid))]
        preview = b''.join(wavs)
        if preview:
            with open(os.path.join(VOICE_DIR, vid, 'preview.wav'), 'wb') as f:
                f.write(preview)
    except Exception as e:
        print(f'[cosyvoice] 生成预览音频失败（音色 {vid}）: {e}')


def rename_voice(vid, name):
    cfg = json.load(open(_cfg_path(vid), encoding='utf-8'))
    cfg['name'] = name
    with open(_cfg_path(vid), 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False)


def delete_voice(vid):
    import shutil
    with GEN_LOCK:
        MODEL.frontend.spk2info.pop(vid, None)
    shutil.rmtree(os.path.join(VOICE_DIR, vid), ignore_errors=True)


# ---------- 合成 ----------
def tensor_to_wav(tensor, sr):
    samples = tensor.detach().cpu().squeeze(0).tolist()
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        arr = array.array('h', (max(-32768, min(32767, int(s * 32767))) for s in samples))
        w.writeframes(arr.tobytes())
    return buf.getvalue()


def synth_segment(text, vid):
    """单句克隆合成，返回 WAV bytes（持锁）。"""
    with GEN_LOCK:
        result = None
        for out in MODEL.inference_zero_shot(text, '', '', zero_shot_spk_id=vid, stream=False, text_frontend=False):
            result = out
        if result is None:
            return None
        return tensor_to_wav(result['tts_speech'], MODEL.sample_rate)


def frame_wav(wav):
    return struct.pack('>I', len(wav)) + wav


def warmup():
    """启动预热：首次推理含 MPS 内核初始化，预热掉避免拖慢首个用户请求。"""
    try:
        t0 = time.time()
        vid = read_voices()[0]['voiceId'] if read_voices() else None
        if vid:
            synth_segment('你好。', vid)
        else:
            print('[cosyvoice] 无克隆音色，跳过预热（创建音色后首个请求会较慢）')
        print(f'[cosyvoice] 预热完成（{(time.time() - t0) * 1000:.0f}ms）')
    except Exception as e:
        print(f'[cosyvoice] 预热失败（不影响使用）: {e}')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if args and 'POST' in fmt:
            print(f'[cosyvoice] {args[0]}')

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

    def _stream_speak(self, text, vid):
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.end_headers()
        self.wfile.flush()
        t0 = time.time()
        n_frames = 0
        for seg in split_sentences(text):
            wav = synth_segment(seg, vid)
            if not wav:
                continue
            self.wfile.write(frame_wav(wav))
            self.wfile.flush()
            n_frames += 1
        print(f'[cosyvoice] 克隆合成 {len(split_sentences(text))} 段 → {n_frames} 帧 · {(time.time() - t0) * 1000:.0f}ms')

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == '/health':
            self._send_json(200, {'ok': True, 'model': MODEL_NAME, 'sr': MODEL.sample_rate, 'voices': len(read_voices())})
        elif path == '/voices':
            self._send_json(200, {'voices': read_voices()})
        elif path == '/voice-preview':
            vid = parse_qs(parsed.query).get('voiceId', [''])[0]
            p = os.path.join(VOICE_DIR, vid, 'preview.wav')
            if not vid or not os.path.isfile(p):
                return self._send_json(404, {'error': '该音色暂无预览音频（请重新生成）'})
            data = open(p, 'rb').read()
            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self._send_json(404, {'error': 'not found'})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            payload = self._read_body()
            if path == '/clone':
                name = str(payload.get('name') or '').strip()
                ref_text = str(payload.get('referenceText') or '').strip()
                b64 = str(payload.get('wavBase64') or '')
                if not b64:
                    return self._send_json(400, {'error': '缺少 wavBase64（参考录音）'})
                v = create_voice(name, ref_text, b64)
                print(f'[cosyvoice] 新建克隆音色 {v["voiceId"]}「{v["name"]}」')
                return self._send_json(200, v)

            elif path == '/voice/rename':
                vid = str(payload.get('voiceId') or '')
                name = str(payload.get('name') or '').strip()
                if not vid or not name or not os.path.isfile(_cfg_path(vid)):
                    return self._send_json(404, {'error': '音色不存在'})
                rename_voice(vid, name)
                return self._send_json(200, {'ok': True})

            elif path == '/voice/delete':
                vid = str(payload.get('voiceId') or '')
                if not vid or not os.path.isfile(_cfg_path(vid)):
                    return self._send_json(404, {'error': '音色不存在'})
                delete_voice(vid)
                print(f'[cosyvoice] 删除克隆音色 {vid}')
                return self._send_json(200, {'ok': True})

            elif path == '/speak':
                text = str(payload.get('text') or '').strip()
                vid = str(payload.get('voice') or '').strip()
                if not text:
                    return self._send_json(400, {'error': '缺少 text'})
                if not vid or not os.path.isfile(_cfg_path(vid)):
                    return self._send_json(400, {'error': '克隆音色不存在（voice=' + vid + '）'})
                stream = parse_qs(parsed.query).get('stream', ['0'])[0] == '1'
                if stream:
                    self._stream_speak(text, vid)
                else:
                    wavs = [w for s in split_sentences(text) if (w := synth_segment(s, vid))]
                    audio = b''.join(wavs)
                    self.send_response(200)
                    self.send_header('Content-Type', 'audio/wav')
                    self.send_header('Content-Length', str(len(audio)))
                    self.end_headers()
                    self.wfile.write(audio)
                return

            else:
                return self._send_json(404, {'error': 'not found'})
        except Exception as e:
            print(f'[cosyvoice] 错误: {e}')
            self._send_json(500, {'error': str(e)})


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='CosyVoice3 本地语音克隆服务')
    ap.add_argument('--port', type=int, default=8003)
    ap.add_argument('--model-dir', default=os.path.join(_HERE, 'models', 'cosyvoice', 'Fun-CosyVoice3-0.5B'))
    ap.add_argument('--voice-dir', default=os.path.join(_HERE, 'data', 'clone-voices'))
    ap.add_argument('--device', default='mps', help='mps | cpu')
    args = ap.parse_args()

    VOICE_DIR = args.voice_dir
    os.makedirs(VOICE_DIR, exist_ok=True)

    MODEL = load_model(args.model_dir, args.device)
    MODEL_NAME = args.model_dir

    # 进程启动时重建所有已存音色的特征缓存（含参考音频重采样/提特征，音色少可接受）
    for v in read_voices():
        try:
            register_voice(v['voiceId'])
            _gen_preview(v['voiceId'])  # 为旧音色补齐预生成试听音频
            print(f'[cosyvoice] 已加载克隆音色 {v["voiceId"]}「{v["name"]}」')
        except Exception as e:
            print(f'[cosyvoice] 加载音色 {v["voiceId"]} 失败: {e}')

    warmup()
    srv = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'[cosyvoice] 服务已启动: http://127.0.0.1:{args.port}（/clone /voices /speak）')
    srv.serve_forever()
