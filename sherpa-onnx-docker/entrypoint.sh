#!/bin/bash
# Entrypoint: download model if not present in volume, then start server

MODEL_DIR="${MODEL_DIR:-/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2}"
MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2.tar.bz2"

if [ ! -f "$MODEL_DIR/tokens.txt" ]; then
    echo "[entrypoint] Model not found at $MODEL_DIR, downloading..."
    mkdir -p /models
    curl -L "$MODEL_URL" | tar xjf - -C /models/
    echo "[entrypoint] Model download complete"
else
    echo "[entrypoint] Model found at $MODEL_DIR"
fi

exec python server.py
