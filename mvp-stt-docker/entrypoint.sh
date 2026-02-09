#!/bin/bash
# MVP-Bridge entrypoint: download model from HuggingFace if not present, then start bridge
#
# Supports both adapter modes. For subprocess mode, ensures the default model
# is available on disk before starting the bridge.

MODEL_DIR="${MODEL_DIR:-/models}"
DEFAULT_MODEL="${DEFAULT_MODEL:-parakeet-tdt-0.6b-v2-int8}"
HF_REPO="${HF_REPO:-csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8}"

# Derive the expected model subdirectory
# Models from HuggingFace land in: $MODEL_DIR/sherpa-onnx-nemo-$DEFAULT_MODEL/
MODEL_SUBDIR="$MODEL_DIR/sherpa-onnx-nemo-$DEFAULT_MODEL"

if [ ! -f "$MODEL_SUBDIR/tokens.txt" ]; then
    echo "[mvp-bridge] Model not found at $MODEL_SUBDIR, downloading from HuggingFace ($HF_REPO)..."
    mkdir -p "$MODEL_SUBDIR"

    python3 -c "
from huggingface_hub import snapshot_download
import os
snapshot_download(
    repo_id='${HF_REPO}',
    local_dir='${MODEL_SUBDIR}',
    token=os.environ.get('HF_TOKEN') or None,
)
print('[mvp-bridge] Model download complete')
"

    if [ $? -ne 0 ]; then
        echo "[mvp-bridge] ERROR: Model download failed"
        exit 1
    fi
else
    echo "[mvp-bridge] Model found at $MODEL_SUBDIR"
fi

exec python3 bridge.py
