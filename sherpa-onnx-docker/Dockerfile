# Sherpa-ONNX ASR Server with Parakeet TDT 0.6B (CUDA 12 + cuDNN 9)
#
# Build:  docker build -t sherpa-onnx-server .
# Run:    docker run --gpus all -p 8000:8000 -v sherpa-models:/models sherpa-onnx-server
#
# Model is downloaded on first start (~2.5GB) and persisted in the volume.

FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install Python, ffmpeg, curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-dev \
    ffmpeg \
    curl \
    bzip2 \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3 /usr/bin/python

# Install sherpa-onnx with CUDA 12 + cuDNN 9 support
RUN pip3 install --no-cache-dir \
    "sherpa-onnx==1.12.23+cuda12.cudnn9" \
    -f https://k2-fsa.github.io/sherpa/onnx/cuda.html

RUN pip3 install --no-cache-dir \
    fastapi \
    "uvicorn[standard]" \
    python-multipart \
    soundfile \
    numpy

# Copy server and entrypoint
COPY server.py /app/server.py
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
WORKDIR /app

# Runtime config
ENV MODEL_DIR=/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2
ENV PROVIDER=cuda
ENV NUM_THREADS=4
ENV LISTEN_PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=120s \
    CMD curl -f http://localhost:8000/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
