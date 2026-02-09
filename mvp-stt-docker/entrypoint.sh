#!/bin/bash
# MVP-Bridge entrypoint: download all models from HuggingFace if not present, then start bridge
#
# Downloads all supported Parakeet TDT models on first run.
# The default model is loaded by bridge.py at startup; others are available for switching.

MODEL_DIR="${MODEL_DIR:-/models}"
DEFAULT_MODEL="${DEFAULT_MODEL:-parakeet-tdt-0.6b-v2-int8}"

# All supported models: id -> HuggingFace repo
declare -A MODELS
MODELS=(
    ["parakeet-tdt-0.6b-v2-int8"]="csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
    ["parakeet-tdt-1.1b-v2-int8"]="csukuangfj/sherpa-onnx-nemo-parakeet-tdt-1.1b-v2-int8"
    ["parakeet-tdt-0.6b-v3-int8"]="csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
)

download_model() {
    local model_id="$1"
    local hf_repo="$2"
    local model_subdir="$MODEL_DIR/sherpa-onnx-nemo-$model_id"

    if [ -f "$model_subdir/tokens.txt" ]; then
        echo "[mvp-bridge] Model found: $model_id"
        return 0
    fi

    echo "[mvp-bridge] Downloading $model_id from HuggingFace ($hf_repo)..."
    mkdir -p "$model_subdir"

    python3 -c "
from huggingface_hub import snapshot_download
import os
snapshot_download(
    repo_id='${hf_repo}',
    local_dir='${model_subdir}',
    token=os.environ.get('HF_TOKEN') or None,
)
print('[mvp-bridge] Download complete: ${model_id}')
"

    if [ $? -ne 0 ]; then
        echo "[mvp-bridge] WARNING: Failed to download $model_id (non-fatal, continuing)"
        return 1
    fi
    return 0
}

# Download default model first (required)
default_repo="${MODELS[$DEFAULT_MODEL]}"
if [ -n "$default_repo" ]; then
    download_model "$DEFAULT_MODEL" "$default_repo"
    if [ $? -ne 0 ]; then
        echo "[mvp-bridge] ERROR: Default model download failed"
        exit 1
    fi
fi

# Download remaining models (best-effort, non-blocking failures)
for model_id in "${!MODELS[@]}"; do
    if [ "$model_id" != "$DEFAULT_MODEL" ]; then
        download_model "$model_id" "${MODELS[$model_id]}"
    fi
done

exec python3 bridge.py
