#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""IndexTTS-2.5 首次推理测试（临时脚本，接入服务后可删）。"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, 'vendor', 'index-tts'))

from indextts.infer_v2_5 import IndexTTS2  # noqa: E402

def main():
    model_dir = os.path.join(_HERE, 'models', 'indextts', 'checkpoints')
    print('[test] 加载 IndexTTS-2.5（MPS 自动检测，bf16 半精度省内存，首次加载较慢）…', flush=True)
    # use_bf16=True：模型半精度加载（内存约减半）；fp32 在 16GB 机器上会 OOM 被杀
    tts = IndexTTS2(cfg_path=os.path.join(model_dir, 'config.yaml'), model_dir=model_dir, use_bf16=True)
    print('[test] 模型加载完成，开始合成…', flush=True)
    ref = os.path.join(_HERE, 'data', 'clone-voices', 'cv_ce22a63759', 'ref.wav')
    out = '/tmp/indextts_test.wav'
    tts.infer(spk_audio_prompt=ref, text='你好，我是 IndexTTS 克隆音色测试。', lang='ZH', output_path=out)
    print('[test] OK，输出', out, flush=True)

if __name__ == '__main__':
    main()
