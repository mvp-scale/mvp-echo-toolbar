# MVP-Echo Studio: Parakeet TDT + Pyannote diarization + React UI
#
# Multi-stage build:
#   Stage 1: Build frontend (Node 20)
#   Stage 2: NVIDIA NeMo container (tested NeMo + PyTorch + CUDA) + extras

# ── Stage 1: Frontend build ──
FROM node:20-slim AS frontend-build

WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 2: NeMo base (includes NeMo, PyTorch, CUDA, lhotse, etc.) ──
# 25.04 includes TDT timestamp fixes and consistent ASR output format.
FROM nvcr.io/nvidia/nemo:25.04

ENV PYTHONUNBUFFERED=1

# Persist model downloads to the mounted volume
ENV HF_HOME=/models/huggingface
ENV TORCH_HOME=/models/torch
ENV NEMO_CACHE_DIR=/models/nemo

# Install only what the NeMo container doesn't already have
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Fix pip metadata for torch packages installed from local wheels.
# The NeMo container installed them from /opt/transfer/*.whl files that were
# deleted after install. Removing direct_url.json lets pip treat them as
# normal installed packages during dependency resolution.
RUN for d in /usr/local/lib/python3.12/dist-packages/torch*.dist-info; do \
        rm -f "$d/direct_url.json"; \
    done

# Pin torch ecosystem versions so pip won't replace them.
# pyannote-audio → pytorch-metric-learning → torchvision, and pip would
# otherwise replace the container's NVIDIA-built torch/torchvision/torchaudio
# with incompatible PyPI wheels (missing compiled C++ ops like nms).
RUN for pkg in torch torchvision torchaudio numpy; do \
        v=$(python3 -c "import importlib.metadata; print(importlib.metadata.version('$pkg').split('+')[0])" 2>/dev/null) \
        && echo "$pkg==$v" >> /tmp/torch-pins.txt \
        || true; \
    done && echo '--- Pinned torch packages ---' && cat /tmp/torch-pins.txt

# Install pyannote-audio WITHOUT dependency resolution to avoid torch conflicts.
# Pin to 3.3.2 — version 4.x has exact torch==2.8.0 pin incompatible with NeMo.
RUN pip install --no-cache-dir --no-deps pyannote-audio==3.3.2

# torchaudio is not in the NeMo container but pyannote.audio needs it.
# Pin to 2.7.0 to match the container's torch 2.7.0a0 ABI.
# Install with --no-deps to avoid torch version resolution conflicts.
RUN pip install --no-cache-dir --no-deps torchaudio==2.7.0

# Install remaining deps with torch pinned so pip can't replace them.
COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir \
        -c /tmp/torch-pins.txt \
        -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt /tmp/torch-pins.txt

# Copy backend code
WORKDIR /app
COPY backend/ /app/

# Copy built frontend
COPY --from=frontend-build /build/dist /app/static

# Copy entrypoint
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV PORT=8001
EXPOSE 8001

ENTRYPOINT ["/app/entrypoint.sh"]
