#!/bin/bash
# MVP-Echo Studio entrypoint: GPU check + start uvicorn

echo "[echo-studio] Starting MVP-Echo Studio..."

# Check GPU
if command -v nvidia-smi &>/dev/null; then
    echo "[echo-studio] GPU detected:"
    nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader
else
    echo "[echo-studio] WARNING: nvidia-smi not found, running on CPU"
fi

# Check CUDA from Python
python3 -c "
import torch
if torch.cuda.is_available():
    print(f'[echo-studio] CUDA available: {torch.cuda.get_device_name(0)}')
    print(f'[echo-studio] VRAM: {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB')
else:
    print('[echo-studio] WARNING: CUDA not available to PyTorch')
"

# Check HF token
if [ -n "$HF_TOKEN" ]; then
    echo "[echo-studio] HuggingFace token configured (diarization enabled)"
else
    echo "[echo-studio] WARNING: No HF_TOKEN set, speaker diarization will be disabled"
fi

echo "[echo-studio] Starting uvicorn on port ${PORT:-8001}..."
exec python3 -m uvicorn main:app --host 0.0.0.0 --port "${PORT:-8001}" --workers 1
