#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""IndexTTS-2.5 本地 TTS 服务（供 asr-server 转发调用）。

与 cosyvoice-tts-server.py 同款模式：独立 Python 进程 + ThreadingHTTPServer，
asr-server 在 /speak 检测到 engine=indextts 时转发到此。

用法：
  <venv>/bin/python3 indextts-tts-server.py --port 8004
  依赖：vendor/index-tts（uv sync 安装，Python 3.11）+ checkpoints（IndexTeam/IndexTTS-2.5，~5.5GB）
  辅助模型（w2v-bert-2.0 / MaskGCT codec / CAMPPlus / BigVGAN）首次加载自动下载到
  <model_dir>/hf_cache/（透传 HF_ENDPOINT 可走 hf-mirror）。

接口：
  GET  /health        → { ok, model, engine, loaded }
  POST /speak         body=JSON { text, voice } → WAV 二进制（audio/wav，22.05kHz）
  POST /speak?stream=1 body=JSON { text, voice } → 帧流（application/octet-stream）
                       帧协议 = 4 字节大端长度 + 一段 WAV（单帧=整段，与 asr-server 兼容）

说明：
  - voice = 克隆音色 id（--voice-dir 下 <id>/ref.wav 参考音频）→ 零样本克隆（IndexTTS 官方范式）
  - 语言：默认 ZH（中文优先）；后续可按需扩展 lang 参数
  - 设备自动检测（官方逻辑 CUDA → XPU → MPS → CPU）；MPS 上 use_bf16=False（bf16 MPS 支持有限）
  - 推理串行化（RLock），MPS/CPU 推理非线程安全，与 cosyvoice 一致
"""

import argparse
import io
import json
import os
import struct
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

_HERE = os.path.dirname(os.path.abspath(__file__))
_VENDOR = os.path.join(_HERE, 'vendor', 'index-tts')
sys.path.insert(0, _VENDOR)

GEN_LOCK = threading.RLock()
_tts = None
_engine = "indextts"
_lang = "ZH"
_voice_dir = None


def load_tts(model_dir, device=None, use_bf16=False):
    """加载 IndexTTS2（首次会触发辅助模型下载，较慢）。"""
    global _tts
    if _tts is not None:
        return _tts
    from indextts.infer_v2_5 import IndexTTS2
    cfg = os.path.join(model_dir, 'config.yaml')
    if not os.path.exists(cfg):
        raise RuntimeError(f'缺少模型配置 {cfg}；请先下载 IndexTeam/IndexTTS-2.5 到 {model_dir}')
    _tts = IndexTTS2(cfg_path=cfg, model_dir=model_dir, use_bf16=use_bf16, device=device)
    return _tts


def voice_ref_path(voice_id):
    """克隆音色 id → 参考音频路径（data/clone-voices/<id>/ref.wav，与 cosyvoice 同结构）。"""
    p = os.path.join(_voice_dir, voice_id, 'ref.wav')
    if not os.path.exists(p):
        raise RuntimeError(f'克隆音色不存在或缺少参考音频: {voice_id}（{p}）')
    return p


def synth(text, voice_id):
    """整段合成 → 返回 22.05kHz WAV bytes。"""
    import soundfile as sf  # noqa: PLC0415（index-tts 依赖）
    with GEN_LOCK:
        ref = voice_ref_path(voice_id)
        tmp = os.path.join(tempfile.gettempdir(), 'indextts_out.wav')
        tts = load_tts(_model_dir, device=_device)
        tts.infer(spk_audio_prompt=ref, text=text, lang=_lang, output_path=tmp)
        data, sr = sf.read(tmp, dtype='float32')
    buf = io.BytesIO()
    sf.write(buf, data, sr, format='WAV')
    return buf.getvalue(), sr


def wav_frame(wav: bytes):
    return struct.pack('>I', len(wav)) + wav


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/health'):
            self._send_json(200, {'ok': _tts is not None, 'model': 'IndexTTS-2.5', 'engine': _engine, 'loaded': _tts is not None})
        else:
            self._send_json(404, {'error': 'not found'})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path != '/speak':
            self._send_json(404, {'error': 'not found'})
            return
        length = int(self.headers.get('Content-Length', 0) or 0)
        try:
            body = json.loads(self.rfile.read(length).decode('utf-8') or '{}')
            text = str(body.get('text', '') or '').strip()
            voice = str(body.get('voice', '') or '').strip()
            if not text:
                self._send_json(400, {'error': '缺少 text'})
                return
            if not voice:
                self._send_json(400, {'error': '缺少 voice（克隆音色 id）'})
                return
            wav, sr = synth(text, voice)
            if parse_qs(parsed.query).get('stream', ['0'])[0] == '1':
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.end_headers()
                self.wfile.write(wav_frame(wav))
            else:
                self.send_response(200)
                self.send_header('Content-Type', 'audio/wav')
                self.send_header('Content-Length', str(len(wav)))
                self.end_headers()
                self.wfile.write(wav)
        except Exception as e:  # noqa: BLE001
            self._send_json(500, {'error': str(e)})


def main():
    ap = argparse.ArgumentParser(description='IndexTTS-2.5 本地 TTS 服务')
    ap.add_argument('--port', type=int, default=8004)
    ap.add_argument('--model-dir', default=os.path.join(_HERE, 'models', 'indextts', 'checkpoints'))
    ap.add_argument('--voice-dir', default=os.path.join(_HERE, 'data', 'clone-voices'))
    ap.add_argument('--device', default=None, help='mps | cpu | cuda（默认自动检测）')
    ap.add_argument('--lang', default='ZH', help='ZH | EN | JA | ES | AR（默认 ZH）')
    args = ap.parse_args()

    global _model_dir, _voice_dir, _device, _lang
    _model_dir = args.model_dir
    _voice_dir = args.voice_dir
    _device = args.device
    _lang = args.lang

    print(f'[indextts] 加载 IndexTTS-2.5（model_dir={_model_dir}，首次含辅助模型下载，较慢）…', flush=True)
    load_tts(args.model_dir, device=args.device)
    print(f'[indextts] 已加载，监听 http://127.0.0.1:{args.port}（POST /speak，设备自动检测）', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
