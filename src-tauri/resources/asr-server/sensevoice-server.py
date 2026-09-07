#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SenseVoice 原始版（funasr）本地 ASR 服务，供 asr-server 转发调用。

与 qwen3-tts-server.py 同款模式：独立 Python 进程 + ThreadedHTTPServer，
asr-server 在 /transcribe、/voice-chat 检测到 engine=sensevoice-original 时转发到此。

用法：
  /opt/homebrew/bin/python3 sensevoice-server.py --port 8002 [--device cpu] [--model <dir>]
  # 依赖：funasr + torch + modelscope（本机 /opt/homebrew/bin/python3 已具备）

接口：
  GET  /health       → { ok, model, engine }
  POST /transcribe   body = RAW PCM16（16kHz 单声道）→ { text, engine }

说明：
  - 模型加载自本地目录 models/sensevoice-original（ModelScope SenseVoiceSmall 原始版 model.pt）。
  - funasr 推理串行化（RLock），避免并发时内部状态交错。
  - 输出富文本标记 <|zh|> <|NEUTRAL|> 等会剥离（与 sherpa 版 asr-server 一致）。
"""

import argparse
import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

GEN_LOCK = threading.RLock()
_model = None
_punc_model = None
_vad_model = None
MODEL_NAME = "sensevoice-original"
_device = "cpu"
# 032/034 P3：模型目录从数据目录派生（env 注入；未设置回退代码目录，兼容手动启动）
_HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get('OPENSOUND_DATA_DIR') or _HERE
# 标点模型目录（funasr punc_ct-transformer，中英）
PUNC_MODEL_DIR = os.path.join(DATA_DIR, 'models', 'punc-cn-en')
# VAD 模型目录（funasr fsmn_vad 语音活动检测）
VAD_MODEL_DIR = os.path.join(DATA_DIR, 'models', 'fsmn-vad')


def load_vad_model(device):
    global _vad_model
    if _vad_model is not None:
        return _vad_model
    from funasr import AutoModel
    _vad_model = AutoModel(
        model=VAD_MODEL_DIR,
        device=device,
        disable_update=True,
        disable_pbar=True,
        disable_log=True,
    )
    return _vad_model


def vad_segments(samples):
    """语音活动检测，返回 [[start_ms, end_ms], ...]。"""
    try:
        m = load_vad_model(_device)
        res = m.generate(input=samples)
        if not res:
            return []
        return res[0].get('value') or []
    except Exception:  # noqa: BLE001
        return []


def _ensure_bpe_alias(model_dir):
    """funasr 本地加载按固定名 bpe.model 补 bpemodel（ModelScope 仓库 bpe 文件名是
    chn_jpn_yue_eng_ko_spectok.bpe.model，且 config.yaml 里 tokenizer_conf.bpemodel: null ——
    缺别名时 SentencepiecesTokenizer 会 sp.load("None") → RuntimeError: NOT_FOUND: "None"，
    8002 直接起不来）。已存在 bpe.model 或目录无 *.bpe.model 时跳过。"""
    target = os.path.join(model_dir, 'bpe.model')
    if os.path.exists(target):
        return
    for f in os.listdir(model_dir):
        if f.endswith('.bpe.model'):
            try:
                import shutil
                shutil.copyfile(os.path.join(model_dir, f), target)
                print(f'[sensevoice-server] 已生成 bpe.model 别名（来源 {f}）', flush=True)
            except Exception as e:  # noqa: BLE001
                print(f'[sensevoice-server] 生成 bpe.model 别名失败: {e}', flush=True)
            return


def load_model(path, device):
    global _model
    if _model is not None:
        return _model
    from funasr import AutoModel
    _ensure_bpe_alias(path)  # 实测必需：SenseVoiceSmall 本地加载 bpemodel 补全
    _model = AutoModel(
        model=path,
        device=device,
        disable_update=True,
        disable_pbar=True,
        disable_log=True,
    )
    return _model


def load_punc_model(device):
    global _punc_model
    if _punc_model is not None:
        return _punc_model
    from funasr import AutoModel
    _punc_model = AutoModel(
        model=PUNC_MODEL_DIR,
        device=device,
        disable_update=True,
        disable_pbar=True,
        disable_log=True,
    )
    return _punc_model


def punctuate_text(text):
    """对无标点文本自动加标点。模型未就绪时原样返回。"""
    if not text:
        return text
    try:
        m = load_punc_model(_device)
        res = m.generate(input=[str(text)])
        return str(res[0]['text']) if res else text
    except Exception:  # noqa: BLE001
        return text


def clean_text(t):
    # 去 SenseVoice 富文本标记 <|zh|> <|NEUTRAL|> <|withitn|> 等
    return re.sub(r'<\|[^|]*\|>', '', str(t or '')).replace('\n', ' ').strip()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
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
            self._send(200, {'ok': _model is not None, 'model': MODEL_NAME, 'engine': 'sensevoice-original'})
        else:
            self._send(404, {'error': 'not found'})

    def do_POST(self):
        path = self.path.split('?')[0]
        if path == '/punc':
            self._handle_punc()
            return
        if path == '/vad':
            self._handle_vad()
            return
        if path != '/transcribe':
            self._send(404, {'error': 'not found'})
            return
        length = int(self.headers.get('Content-Length', 0) or 0)
        raw = self.rfile.read(length)
        if len(raw) < 1600:
            self._send(400, {'error': '音频太短'})
            return
        try:
            with GEN_LOCK:
                samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                res = _model.generate(input=samples, language='auto', use_itn=False)
            text = clean_text(res[0]['text'] if res else '')
            self._send(200, {'text': text, 'engine': 'sensevoice-original'})
        except Exception as e:  # noqa: BLE001
            self._send(500, {'error': str(e)})

    def _handle_punc(self):
        length = int(self.headers.get('Content-Length', 0) or 0)
        try:
            raw = self.rfile.read(length).decode('utf-8')
            body = json.loads(raw or '{}')
            text = str(body.get('text', '') or '')
            if not text:
                self._send(400, {'error': '缺少 text'})
                return
            with GEN_LOCK:
                out = punctuate_text(text)
            self._send(200, {'text': out})
        except Exception as e:  # noqa: BLE001
            self._send(500, {'error': str(e)})

    def _handle_vad(self):
        length = int(self.headers.get('Content-Length', 0) or 0)
        raw = self.rfile.read(length)
        if len(raw) < 1600:
            self._send(400, {'error': '音频太短'})
            return
        try:
            with GEN_LOCK:
                samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                segs = vad_segments(samples)
            self._send(200, {'speech': segs})
        except Exception as e:  # noqa: BLE001
            self._send(500, {'error': str(e)})


def main():
    ap = argparse.ArgumentParser(description='SenseVoice 原始版（funasr）本地 ASR 服务')
    ap.add_argument('--port', type=int, default=8002)
    ap.add_argument('--device', default='cpu', help='cpu | mps')
    ap.add_argument('--model', default=os.path.join(DATA_DIR, 'models', 'sensevoice-original'))
    args = ap.parse_args()
    global _device
    _device = args.device

    load_model(args.model, args.device)
    print(f'[sensevoice-server] 已加载 SenseVoice 原始版 (funasr)，监听 http://127.0.0.1:{args.port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
