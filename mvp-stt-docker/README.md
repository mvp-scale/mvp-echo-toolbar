# MVP STT Docker Stack

GPU-accelerated speech-to-text using sherpa-onnx, served behind an OpenAI-compatible HTTP API.

## Architecture

```
Client (toolbar)
  |
  v
mvp-auth (:20300)     Auth proxy (CORS, API keys, usage tracking)
  |
  v
mvp-bridge (:8000)    FastAPI bridge + managed sherpa-onnx subprocess (GPU)
```

Two containers. `mvp-bridge` manages the C++ sherpa-onnx WebSocket server
as an internal subprocess — no separate ASR container needed.

## Prerequisites

- Docker + Docker Compose v2
- NVIDIA GPU with driver 550+
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

Verify GPU access before deploying:

```bash
docker run --rm --gpus all nvidia/cuda:12.6.3-cudnn-runtime-ubuntu22.04 nvidia-smi
```

If this fails, fix the NVIDIA runtime first (see Troubleshooting below).

## Quick Deploy

```bash
# First time (builds images, downloads models ~1GB, starts stack)
docker compose up -d --build

# Verify
curl http://localhost:20300/health
```

Models auto-download from HuggingFace on first start. The default model
(`parakeet-tdt-0.6b-v2-int8`) loads into GPU memory automatically.

## Redeploy After Code Changes

```bash
docker compose up -d --build
```

For a fully clean rebuild (new base layers):

```bash
docker compose down && docker compose build --no-cache && docker compose up -d
```

## Clean Restart

If the stack is in a bad state (GPU errors, stuck containers):

```bash
# Stop and remove containers
docker compose down

# Verify NVIDIA runtime is working
docker run --rm --gpus all nvidia/cuda:12.6.3-cudnn-runtime-ubuntu22.04 nvidia-smi

# Start fresh
docker compose up -d --build
```

Models persist in the `mvp-models` Docker volume across restarts.
To force re-download models:

```bash
docker volume rm mvp-stt-docker_mvp-models
docker compose up -d --build
```

## Configuration

Environment variables in `docker-compose.yml` (`mvp-bridge` service):

| Variable | Default | Description |
|---|---|---|
| `DEFAULT_MODEL` | `parakeet-tdt-0.6b-v2-int8` | Model loaded on startup |
| `SHERPA_PROVIDER` | `cuda` | `cuda` for GPU, `cpu` for CPU-only |
| `SHERPA_NUM_THREADS` | `4` | CPU threads for non-GPU ops |
| `SHERPA_MAX_UTTERANCE` | `600` | Max audio length in seconds (10 min) |

## API

All endpoints require `Authorization: Bearer <key>` (except `/health`).
Keys are configured in `api-keys.json`.

```bash
# Health check (no auth)
curl http://localhost:20300/health

# List models
curl -H "Authorization: Bearer <key>" http://localhost:20300/v1/models

# Switch model
curl -X POST -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"model_id":"parakeet-tdt-0.6b-v3-int8"}' \
  http://localhost:20300/v1/models/switch

# Transcribe
curl -X POST -H "Authorization: Bearer <key>" \
  -F "file=@audio.wav" \
  http://localhost:20300/v1/audio/transcriptions
```

## Models

| Model ID | Language | VRAM |
|---|---|---|
| `parakeet-tdt-0.6b-v2-int8` | English | ~426 MiB |
| `parakeet-tdt-0.6b-v3-int8` | Multilingual (25 langs) | ~426 MiB |

One model loaded at a time. Switching takes ~3-5 seconds.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | Stack definition (2 services) |
| `Dockerfile.bridge` | Bridge container: Python + FastAPI + ffmpeg + sherpa-onnx GPU binaries |
| `bridge.py` | FastAPI app: adapter factory, audio conversion, OpenAI-compatible endpoints |
| `ports.py` | `ModelEngine` ABC interface for adapter plugins |
| `adapters/` | Adapter implementations (managed-websocket, subprocess, websocket) |
| `auth-proxy.py` | Auth proxy: API keys, CORS, usage tracking |
| `entrypoint.sh` | Bridge entrypoint: downloads models from HuggingFace on first run |
| `api-keys.json` | API key configuration |
| `usage.json` | Usage tracking data (auto-generated) |

## Troubleshooting

### NVIDIA runtime not available

Symptoms: containers exit immediately, `nvidia` runtime errors in `docker logs`.

```bash
# Check if NVIDIA Container Toolkit is installed and running
sudo systemctl status nvidia-container-toolkit-cdi-generator
nvidia-ctk --version

# Restart the Docker daemon (reloads GPU runtime)
sudo systemctl restart docker

# Verify GPU passthrough works
docker run --rm --gpus all nvidia/cuda:12.6.3-cudnn-runtime-ubuntu22.04 nvidia-smi
```

If `nvidia-smi` works on the host but not inside Docker, reinstall the toolkit:

```bash
# Ubuntu/Debian
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

### Containers restarting in a loop

`restart: unless-stopped` will keep retrying with exponential backoff.
Check what's failing:

```bash
docker compose logs --tail=50 mvp-bridge
docker compose logs --tail=50 mvp-auth
```

### Model download stuck or failed

```bash
# Check entrypoint logs
docker compose logs mvp-bridge | head -30

# Nuclear option: remove volume and re-download
docker compose down
docker volume rm mvp-stt-docker_mvp-models
docker compose up -d --build
```
