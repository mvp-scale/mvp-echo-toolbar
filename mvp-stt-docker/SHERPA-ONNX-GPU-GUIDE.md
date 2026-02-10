# Running sherpa-onnx on GPU (CUDA) in Docker

A practical guide based on the MVP-Echo production setup. This runs sherpa-onnx's
pre-built C++ binaries with CUDA GPU acceleration inside Docker, using NVIDIA's
official CUDA runtime images.

## Why this is hard to find

Most sherpa-onnx documentation focuses on the Python bindings or building from
source. Running the **pre-built C++ binaries** on GPU inside Docker requires
matching specific version combinations of CUDA, cuDNN, and the sherpa-onnx
release. This guide documents a working combination.

## Working version combination

| Component | Version | Notes |
|-----------|---------|-------|
| Docker base image | `nvidia/cuda:12.6.3-cudnn-runtime-ubuntu22.04` | Must be a `-cudnn-runtime` variant |
| sherpa-onnx release | `v1.12.23` | Pre-built GPU binary from GitHub releases |
| sherpa-onnx tarball | `sherpa-onnx-v1.12.23-cuda-12.x-cudnn-9.x-linux-x64-gpu.tar.bz2` | CUDA 12 + cuDNN 9 |
| NVIDIA Container Toolkit | Latest | Required on the Docker host |
| GPU driver | 550+ | Host driver must support CUDA 12.x |

The key insight: you do **not** build sherpa-onnx from source. The project
publishes pre-built tarballs on every GitHub release with all shared libraries
included.

## Dockerfile

```dockerfile
FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    bzip2 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Download pre-built sherpa-onnx GPU binaries (~234MB compressed)
RUN curl -fSL -o /tmp/sherpa.tar.bz2 \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.12.23/sherpa-onnx-v1.12.23-cuda-12.x-cudnn-9.x-linux-x64-gpu.tar.bz2" \
    && mkdir -p /opt/sherpa-onnx \
    && tar xjf /tmp/sherpa.tar.bz2 -C /opt/sherpa-onnx --strip-components=1 \
    && rm /tmp/sherpa.tar.bz2

ENV PATH="/opt/sherpa-onnx/bin:${PATH}"
ENV LD_LIBRARY_PATH="/opt/sherpa-onnx/lib:${LD_LIBRARY_PATH}"
```

After this, the following binaries are available:
- `sherpa-onnx-offline` -- CLI transcription (one-shot, process per file)
- `sherpa-onnx-offline-websocket-server` -- persistent WebSocket server (model stays in GPU memory)

## docker-compose.yml (GPU access)

```yaml
services:
  my-asr:
    build: .
    environment:
      - NVIDIA_VISIBLE_DEVICES=all
      - NVIDIA_DRIVER_CAPABILITIES=compute,utility
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

Both `NVIDIA_VISIBLE_DEVICES` and the `deploy.resources` block are needed.
The environment variables tell the NVIDIA runtime which GPUs to expose.
The deploy block tells Docker Compose to actually use the NVIDIA runtime.

## Models

Models come from HuggingFace, published by `csukuangfj` (a sherpa-onnx maintainer).
Search for repos named `sherpa-onnx-nemo-parakeet-tdt-*`.

A model directory contains:
```
encoder.int8.onnx    # ~200-600MB depending on model size
decoder.int8.onnx    # ~1-5MB
joiner.int8.onnx     # ~5-15MB
tokens.txt           # vocabulary file
```

Download example using huggingface-hub:
```python
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id="csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    local_dir="/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
)
```

## Running the WebSocket server

```bash
sherpa-onnx-offline-websocket-server \
    --port=6006 \
    --provider=cuda \
    --encoder=/models/encoder.int8.onnx \
    --decoder=/models/decoder.int8.onnx \
    --joiner=/models/joiner.int8.onnx \
    --tokens=/models/tokens.txt \
    --num-threads=4
```

Key flags:
- `--provider=cuda` -- this is what enables GPU. Use `cpu` for CPU-only fallback.
- `--num-threads=4` -- CPU threads for non-GPU operations.

The server loads the model into GPU memory once on startup (~426MB VRAM for
the 0.6b int8 models) and keeps it resident. Subsequent transcriptions are fast
because there's no model loading overhead.

## Running the CLI tool

For one-shot transcription (no persistent server):

```bash
sherpa-onnx-offline \
    --provider=cuda \
    --encoder=/models/encoder.int8.onnx \
    --decoder=/models/decoder.int8.onnx \
    --joiner=/models/joiner.int8.onnx \
    --tokens=/models/tokens.txt \
    --model-type=transducer \
    --num-threads=4 \
    /path/to/audio.wav
```

This loads the model fresh each time, so it's slower for repeated use.
The WebSocket server is preferred for production.

## WebSocket protocol

The C++ WebSocket server uses a binary protocol:

1. **Connect** to `ws://host:port`
2. **Send header**: 8 bytes -- `sample_rate` (int32 LE) + `audio_byte_count` (int32 LE)
3. **Send audio**: float32 PCM samples, chunked (e.g., 10KB chunks)
4. **Receive**: transcription result (JSON with `"text"` field, or plain text)
5. **Send**: `"Done"` string to signal end of session

Python example:
```python
import struct
import websockets

async def transcribe(samples, sample_rate):
    async with websockets.connect("ws://localhost:6006") as ws:
        header = struct.pack("<ii", sample_rate, len(samples) * 4)
        buf = header + samples.tobytes()

        chunk_size = 10240
        for start in range(0, len(buf), chunk_size):
            await ws.send(buf[start:start + chunk_size])

        result = await ws.recv()
        await ws.send("Done")
        return result
```

## Common pitfalls

1. **Wrong base image**: Must use a `-cudnn-runtime` CUDA image, not just `-runtime`.
   sherpa-onnx's ONNX Runtime dependency requires cuDNN shared libraries at runtime.

2. **Missing libgomp1**: The pre-built binaries link against OpenMP. Install `libgomp1`
   or you'll get a cryptic shared library error at startup.

3. **`--provider=cuda` omitted**: Defaults to CPU. Easy to miss.

4. **CUDA version mismatch**: The tarball filename specifies its CUDA version
   (`cuda-12.x-cudnn-9.x`). The base Docker image must match. Don't use a
   CUDA 11 image with CUDA 12 binaries.

5. **No NVIDIA Container Toolkit on host**: `docker run --gpus all` won't work
   without it. Install via: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html

## GPU memory usage

| Model | VRAM |
|-------|------|
| parakeet-tdt-0.6b-v2-int8 (English) | ~426 MiB |
| parakeet-tdt-0.6b-v3-int8 (Multilingual) | ~426 MiB |

Only one model is loaded at a time. Model switching requires restarting
the server process (the managed-websocket adapter handles this automatically).

## Performance

With a 0.6b int8 model on a consumer GPU (e.g., RTX 3060/4060):
- Model load: ~3-5 seconds (first transcription only)
- Transcription: sub-1-second for typical voice clips (5-30s audio)
- Real-time factor: ~0.02-0.05x (50-100x faster than real-time)
