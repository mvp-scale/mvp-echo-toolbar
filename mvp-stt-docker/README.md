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
mvp-bridge (:8000)    FastAPI bridge with pluggable STT adapters
  |
  v
sherpa-onnx            C++ WebSocket server (managed subprocess, GPU)
```

## Services

| Service | Purpose |
|---------|---------|
| **mvp-bridge** | HTTP API server. Runs the managed-websocket adapter which spawns `sherpa-onnx-offline-websocket-server` as a subprocess. Handles model switching by restarting the subprocess with new model paths. |
| **mvp-auth** | Reverse proxy that adds API key auth, CORS headers, and usage tracking. |
| **mvp-asr** *(legacy)* | Standalone C++ WebSocket server in its own container. Single-model, no switching. Behind `profiles: ["legacy"]` -- not started by default. |

## Files

| File | Description |
|------|-------------|
| `docker-compose.yml` | Current stack definition (v3.0 hexagonal architecture) |
| `docker-compose.v2.2.1.yml` | Archived v2.2.1 compose (pre-hexagonal, bridge had no adapters). Remove before release to main. |
| `Dockerfile.bridge` | Bridge container: Python + FastAPI + ffmpeg + sherpa-onnx binary |
| `Dockerfile.asr` | Legacy standalone C++ server container. Only needed with `--profile legacy`. Remove before release to main. |
| `bridge.py` | FastAPI app -- adapter factory, audio conversion, OpenAI-compatible endpoints |
| `ports.py` | `ModelEngine` ABC -- the interface all adapters implement |
| `auth-proxy.py` | Auth proxy server |
| `entrypoint.sh` | Bridge container entrypoint -- downloads models from HuggingFace on first run |
| `entrypoint-asr.sh` | Legacy ASR container entrypoint |

## Adapters

| Adapter | Env `ADAPTER_TYPE` | Description |
|---------|-------------------|-------------|
| **ManagedWebSocketAdapter** | `managed-websocket` | Default. Spawns C++ WebSocket server as subprocess inside bridge container. Supports model switching. |
| WebSocketAdapter | `websocket` | Relays to external `mvp-asr` container. Single model, no switching. |
| SubprocessAdapter | `subprocess` | Runs `sherpa-onnx-offline` CLI per transcription. No persistent GPU memory. |

## Models

Stored in Docker volume `mvp-models` at `/models/`:

| Model ID | Label | Notes |
|----------|-------|-------|
| `parakeet-tdt-0.6b-v2-int8` | English | Default model, loaded on startup |
| `parakeet-tdt-0.6b-v3-int8` | Multilingual | 25 languages |

Models auto-download from HuggingFace on first container start.

## Usage

```bash
# Start the stack
docker compose up -d --build

# Rebuild after code changes
docker compose up -d --build --no-cache

# Check health
curl http://localhost:20300/health

# List models
curl -H "Authorization: Bearer <key>" http://localhost:20300/v1/models

# Switch model
curl -X POST -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"model_id":"parakeet-tdt-0.6b-v3-int8"}' \
  http://localhost:20300/v1/models/switch
```

## History

- **v2.2.1**: Three containers (mvp-asr + mvp-bridge + mvp-auth). Bridge was a simple HTTP-to-WebSocket relay with no adapter abstraction. Single model only.
- **v3.0**: Hexagonal architecture. Bridge has pluggable adapters (`ModelEngine` port). Added subprocess adapter and model directory scanning.
- **v3.0 + managed-websocket**: Bridge manages the C++ WebSocket server as a subprocess, enabling model switching without a separate container. Legacy mvp-asr moved behind a compose profile. Removed 1.1b model (no sherpa-onnx conversion exists on HuggingFace).
