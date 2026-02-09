#!/bin/bash
# MVP-ASR entrypoint: download model from HuggingFace if needed, then start WebSocket server

MODEL_DIR="${MODEL_DIR:-/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8}"
HF_REPO="${HF_REPO:-csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8}"

if [ ! -f "$MODEL_DIR/tokens.txt" ]; then
    echo "[mvp-asr] Model not found at $MODEL_DIR, downloading from HuggingFace ($HF_REPO)..."
    mkdir -p "$MODEL_DIR"

    # Use pip-installed huggingface-hub to download
    pip install --quiet huggingface-hub 2>/dev/null

    python3 -c "
from huggingface_hub import snapshot_download
import os
snapshot_download(
    repo_id=os.environ['HF_REPO'],
    local_dir=os.environ['MODEL_DIR'],
    token=os.environ.get('HF_TOKEN') or None,
)
print('[mvp-asr] Model download complete')
"

    if [ $? -ne 0 ]; then
        echo "[mvp-asr] ERROR: Model download failed"
        exit 1
    fi
else
    echo "[mvp-asr] Model found at $MODEL_DIR"
fi

echo "[mvp-asr] Starting WebSocket server on port ${WS_PORT:-6006}..."
exec sherpa-onnx-offline-websocket-server \
    --port="${WS_PORT:-6006}" \
    --provider=cuda \
    --encoder="$MODEL_DIR/encoder.int8.onnx" \
    --decoder="$MODEL_DIR/decoder.int8.onnx" \
    --joiner="$MODEL_DIR/joiner.int8.onnx" \
    --tokens="$MODEL_DIR/tokens.txt" \
    --num-threads="${NUM_THREADS:-4}"
