# MVP-Echo Toolbar - Session Context

## Current State (2026-02-09)

**Version**: `v2.2.1` (built, not yet released)
**Branch**: `dev` (daily work), `main` (releases via GitHub Actions)
**Sherpa-ONNX migration**: Phase 1 COMPLETE and running on GPU server

## What Happened This Session

Migrated the GPU ASR server from faster-whisper to sherpa-onnx with Parakeet TDT 0.6B. The toolbar itself was NOT modified — the new server is API-compatible.

**Result**: 3.4s audio transcribed in 0.25s (RTF 0.07). Working end-to-end from toolbar through auth proxy to new ASR engine.

## Repo Structure

```
/home/corey/projects/mvp-echo-toolbar/     <- git root
  |
  |-- mvp-echo-toolbar/                     <- PRODUCTION TOOLBAR (v2.2.1)
  |     |-- app/main/main-simple.js         <- Main process: tray, IPC, popup, welcome window
  |     |-- app/main/tray-manager.js        <- System tray icon, tooltip
  |     |-- app/stt/whisper-remote.js       <- Cloud STT client (HTTP POST, anti-hallucination)
  |     |-- app/renderer/app/components/    <- SettingsPanel.tsx, TranscriptionDisplay.tsx
  |     |-- app/preload/preload.js          <- IPC bridge
  |     +-- package.json                    <- v2.2.1
  |
  |-- mvp-stt-docker/                       <- ACTIVE ASR SERVER (sherpa-onnx, deployed)
  |     |-- docker-compose.yml              <- 3 services: mvp-asr, mvp-bridge, mvp-auth
  |     |-- Dockerfile.asr                  <- CUDA 12.6.3 + sherpa-onnx C++ binaries v1.12.23
  |     |-- Dockerfile.bridge               <- Python 3.12 + ffmpeg + websockets
  |     |-- entrypoint-asr.sh               <- Downloads model from HuggingFace, starts WS server
  |     |-- entrypoint.sh                   <- Bridge entrypoint (model download + start)
  |     |-- bridge.py                       <- HTTP POST -> WebSocket translation (OpenAI-compatible)
  |     |-- auth-proxy.py                   <- CORS + API keys + usage tracking
  |     |-- api-keys.json                   <- API key definitions
  |     +-- usage.json                      <- Usage tracking data
  |
  |-- faster-whisper-docker/                <- OLD SERVER (historical reference, not deployed)
  |-- app/                                  <- ORIGINAL APP (v1.1.0, not production)
  |-- CONTEXT.md                            <- This file
  +-- CLAUDE.md                             <- Claude instructions
```

## Current Architecture (WORKING)

```
[Electron Toolbar] whisper-remote.js
      | HTTP POST /v1/audio/transcriptions (multipart form-data, WebM audio)
      v
[mvp-auth] port 20300 -> 8080
      | CORS, API key validation, usage tracking
      | LAN IPs bypass auth, remote needs Bearer token
      v
[mvp-bridge] port 8000
      | Accepts HTTP POST, converts WebM -> WAV (16kHz mono) via ffmpeg
      | Opens WebSocket to mvp-asr, sends float32 audio samples
      | Returns OpenAI-compatible JSON response
      v
[mvp-asr] port 6006 (WebSocket, internal only)
      | sherpa-onnx C++ offline-websocket-server
      | Pre-built binaries from v1.12.23 release (CUDA 12 + cuDNN 9)
      | Parakeet TDT 0.6B INT8 model
      | GPU: NVIDIA 3080 Ti, 12GB VRAM
      v
[Response] JSON: { text, timestamps, tokens, ... }
      | bridge.py extracts text, wraps in OpenAI format:
      | { text, language, duration, segments: [{ text, start, end, no_speech_prob }] }
```

### WebSocket Protocol (mvp-bridge -> mvp-asr)
- Connect to ws://mvp-asr:6006
- Send 8-byte header: sample_rate (int32 LE) + audio_byte_count (int32 LE)
- Send float32 audio samples in 10240-byte chunks
- Receive JSON with `text` field
- Send "Done" text frame to close

### Server Details
- **Server IP**: 192.168.1.10
- **External port**: 20300 (maps to mvp-auth:8080)
- **GPU**: NVIDIA 3080 Ti, CUDA 12.6.3
- **Model**: Parakeet TDT 0.6B v2 INT8 (460MB download, ~661MB extracted)
- **Model source**: HuggingFace `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8`
- **Model download**: Automatic on first start via `huggingface_hub.snapshot_download()`
- **Sherpa-onnx version**: v1.12.23 (pre-built C++ binaries)

### Deploy Commands
```bash
cd mvp-stt-docker
docker compose down -v                        # stop + remove volumes
docker compose up -d --build                   # build + start all 3 services
docker compose logs -f                         # watch logs
curl http://localhost:20300/health             # test
```

## Toolbar Settings UI (NEEDS UPDATE)

The SettingsPanel.tsx currently shows a **model dropdown with 7 faster-whisper models**:
- tiny, base, small, medium, large-v2, large-v3, large-v3-turbo

These are **no longer relevant** — the server now runs a single Parakeet TDT model. The `model` field sent by whisper-remote.js is accepted by the bridge but ignored.

## NEXT SESSION: Open Questions

### 1. Model Selection in Toolbar UI
The Settings dropdown lists faster-whisper models that don't exist on the new server. Options:
- **Remove the dropdown** entirely (server has one model, no choice needed)
- **Replace with sherpa-onnx model options** (but only one model is loaded at a time)
- **Show the active model name** as read-only info instead of a dropdown

### 2. Can Models Be Switched Dynamically?
The C++ WebSocket server loads one model at startup via command-line args. To switch models:
- The server process must be restarted with different `--encoder`, `--decoder`, `--joiner`, `--tokens` args
- This means `docker compose down && docker compose up -d` with updated env vars
- **There is no hot-swap** — the C++ binary does not support loading a new model at runtime
- The bridge and auth proxy don't need to restart, only mvp-asr

### 3. How to Get New/Different Models?
Models are downloaded from HuggingFace by the entrypoint-asr.sh script. To use a different model:
1. Change `MODEL_DIR` and `HF_REPO` env vars in docker-compose.yml
2. Run `docker compose down && docker compose up -d` (entrypoint downloads if missing)
3. The model persists in the `mvp-models` Docker volume

**Available Parakeet TDT models** (all by csukuangfj on HuggingFace, last updated Aug 16, 2025):

| Model | Languages | Size | HF Repo |
|-------|-----------|------|---------|
| v2 int8 (CURRENT) | English | 460MB | `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` |
| v2 fp16 | English | 1.07GB | GitHub release only (no HF tarball) |
| v3 int8 | 25 European languages | ~465MB | `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` |

**To check for newer models**: Search HuggingFace for `csukuangfj/sherpa-onnx-nemo-parakeet-tdt` — the maintainer publishes new versions there. Also check sherpa-onnx releases at https://github.com/k2-fsa/sherpa-onnx/releases for binary updates.

### 4. Anti-Hallucination Pipeline Relevance
The 5-stage anti-hallucination pipeline in whisper-remote.js was built for Whisper's autoregressive decoder issues. Parakeet TDT uses a non-autoregressive architecture that doesn't hallucinate the same way. The pipeline still runs but should rarely trigger. Consider:
- Keeping it (harmless, catches edge cases)
- Simplifying it (remove Whisper-specific patterns like "Thank you." filtering)
- Making it configurable per engine

### 5. Phase 2: Local CPU Fallback (Not Started)
Bundle sherpa-onnx-node in Electron for offline use:
1. Install `sherpa-onnx` npm package in toolbar project
2. Download Parakeet TDT INT8 model (~661MB)
3. Build local engine class
4. Configure electron-builder `asarUnpack` for native module
5. Add "Local CPU" option to Settings
6. Test offline mode

## Key Files

### Production Toolbar
| File | Purpose |
|------|---------|
| `mvp-echo-toolbar/app/main/main-simple.js` | Main process: tray, IPC, popup, welcome, keybind |
| `mvp-echo-toolbar/app/stt/whisper-remote.js` | Cloud STT: HTTP POST + retry + anti-hallucination |
| `mvp-echo-toolbar/app/main/tray-manager.js` | System tray icon with dynamic tooltip |
| `mvp-echo-toolbar/app/renderer/app/components/SettingsPanel.tsx` | Settings UI (endpoint, key, model dropdown, language) |
| `mvp-echo-toolbar/package.json` | v2.2.1 |

### Docker Server (mvp-stt-docker/)
| File | Purpose |
|------|---------|
| `docker-compose.yml` | 3 services: mvp-asr, mvp-bridge, mvp-auth |
| `Dockerfile.asr` | CUDA 12.6.3 + sherpa-onnx v1.12.23 C++ binaries |
| `Dockerfile.bridge` | Python 3.12 + ffmpeg + websockets + huggingface-hub |
| `entrypoint-asr.sh` | Model download from HuggingFace + start WebSocket server |
| `bridge.py` | HTTP-to-WebSocket bridge (OpenAI-compatible endpoint) |
| `auth-proxy.py` | CORS + API keys + usage tracking (MVP-branded, [mvp-auth] logs) |

## Key Links
- sherpa-onnx GitHub: https://github.com/k2-fsa/sherpa-onnx
- sherpa-onnx releases: https://github.com/k2-fsa/sherpa-onnx/releases
- Current model: https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8
- V3 multilingual: https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8
- sherpa-onnx npm (for Phase 2): https://www.npmjs.com/package/sherpa-onnx
- NVIDIA Parakeet TDT original: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2

## Lessons Learned This Session

1. **No official sherpa-onnx Docker image exists** — `ghcr.io/k2-fsa/sherpa-onnx:latest` returns "denied". Must build from pre-built binary tarballs.
2. **Python API parameter names differ from documentation** — `sampling_rate` not `sample_rate`, `encoder_filename` not `encoder`. The `from_transducer()` factory method works but the `vocab_size` metadata warning causes crashes. Using the C++ binary is more reliable.
3. **The C++ WebSocket server works** — Uses a binary protocol (8-byte header + float32 samples). Returns JSON with `text` field. Needs an HTTP bridge for the existing toolbar to talk to it.
4. **Model download**: GitHub release tarballs only have int8 and fp16 variants (no fp32 tarball). HuggingFace `snapshot_download()` is the most reliable download method — handles retries and checksums.
5. **Don't commit without review** — Added rule to CLAUDE.md.

## API Keys

| Name | Key | Active |
|------|-----|--------|
| Corey (dev) | `sk-corey-2026` | Yes |
| Alex | `sk-alex-2026` | Yes |
| Guest 1-5 | Various | Yes |
