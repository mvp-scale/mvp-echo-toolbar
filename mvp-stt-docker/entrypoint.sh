#!/bin/bash
# MVP-Bridge entrypoint: download model from HuggingFace if not present, then start bridge

MODEL_DIR="${MODEL_DIR:-/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8}"
HF_REPO="${HF_REPO:-csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8}"

if [ ! -f "$MODEL_DIR/tokens.txt" ]; then
    echo "[mvp-bridge] Model not found at $MODEL_DIR, downloading from HuggingFace ($HF_REPO)..."
    mkdir -p "$MODEL_DIR"

    python -c "
from huggingface_hub import snapshot_download
import os
snapshot_download(
    repo_id='${HF_REPO}',
    local_dir='${MODEL_DIR}',
    token=os.environ.get('HF_TOKEN') or None,
)
print('[mvp-bridge] Model download complete')
"

    if [ $? -ne 0 ]; then
        echo "[mvp-bridge] ERROR: Model download failed"
        exit 1
    fi
else
    echo "[mvp-bridge] Model found at $MODEL_DIR"
fi

exec python bridge.py
