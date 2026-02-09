# MVP-Echo Toolbar - Session Context

## Current State (2026-02-09)

**Version**: `v2.2.1` (built, not yet released)
**Build**: Portable exe only (140MB), no installer
**Branch**: `dev` (daily work), `main` (releases via GitHub Actions)

## Repo Structure (IMPORTANT)

This repo contains **two projects** side-by-side:

```
/home/corey/projects/mvp-echo-toolbar/     ← git root (monorepo)
  ├── mvp-echo-toolbar/                     ← PRODUCTION TOOLBAR (v2.2.1) - cloud-only, system tray
  │     ├── app/main/main-simple.js         ← Main process: tray, IPC, popup, welcome window
  │     ├── app/main/tray-manager.js        ← System tray icon, tooltip
  │     ├── app/stt/whisper-remote.js       ← Cloud STT: HTTP POST to faster-whisper-server
  │     ├── app/renderer/app/components/    ← SettingsPanel.tsx, TranscriptionDisplay.tsx, etc.
  │     ├── app/preload/preload.js          ← IPC bridge
  │     └── package.json                    ← v2.2.1
  │
  ├── app/                                  ← ORIGINAL APP (v1.1.0) - local engines, full window
  │     ├── main/main-simple.js             ← Different main process (BrowserWindow, not tray)
  │     ├── stt/engine-manager.js           ← Multi-engine: whisper-native + whisper-engine (Python)
  │     ├── stt/whisper-engine.js           ← Python subprocess STT engine
  │     ├── stt/whisper-native.js           ← Native/standalone exe STT engine
  │     └── renderer/app/App.tsx            ← Full-window UI with OceanVisualizer
  │
  ├── faster-whisper-docker/                ← Docker server config
  │     ├── docker-compose.yml              ← ASR + auth-proxy containers
  │     ├── auth-proxy.py                   ← CORS + API key validation + usage tracking
  │     ├── api-keys.json                   ← API key definitions
  │     └── usage.json                      ← Usage tracking data
  │
  ├── CONTEXT.md                            ← This file
  ├── CLAUDE.md                             ← Claude instructions
  └── package.json                          ← v1.1.0 (root/workspace)
```

**The production toolbar is `mvp-echo-toolbar/mvp-echo-toolbar/`.**
All file references in this document use relative paths from the git root.

## Current Architecture (v2.2.1 Toolbar)

The production toolbar is **cloud-only**. There is no local STT engine. Audio is recorded in-browser (MediaRecorder → WebM), sent via IPC to main process, saved as a temp file, then POSTed as multipart form data to the remote faster-whisper-server.

```
[Electron Renderer] MediaRecorder → WebM ArrayBuffer
        │
        │ IPC: processAudio(audioArray)
        ▼
[Electron Main] main-simple.js
        │  Saves temp .webm file
        │  Calls cloudEngine.transcribe(tempPath)
        ▼
[whisper-remote.js] WhisperRemoteEngine
        │  HTTP POST multipart/form-data to endpoint URL
        │  Includes: model, language, anti-hallucination params
        │  Uses node-fetch + form-data packages
        │  Retry logic for 502/503/504
        │  Browser-like User-Agent with app version
        ▼
[auth-proxy.py] Docker container (port 20300 → 8080)
        │  LAN IPs bypass auth
        │  Remote IPs need Bearer token
        │  Tracks usage (seconds per key)
        ▼
[faster-whisper-server] Docker container (port 8000)
        │  fedirz/faster-whisper-server:latest-cuda
        │  OpenAI-compatible API: POST /v1/audio/transcriptions
        │  GPU: NVIDIA 3080 Ti, CUDA 12.6.3
        │  float16 compute, models loaded permanently (TTL=-1)
        ▼
[Response] verbose_json with segments, duration, language
        │
        │ Back in whisper-remote.js:
        │  1. Filter segments with high no_speech_prob
        │  2. deduplicateSegments() — decoder loop detection
        │  3. removeRepetitions() — sentence dedup
        │  4. removeTrailingPhraseRepetitions() — 2-15 word phrases
        │  5. removeKnownHallucinations() — "Thank you." etc.
        ▼
[Result] { text, language, duration, processingTime, engine, model }
```

### Key Transcription Parameters (sent per-request)
```
temperature=0, vad_filter=true, condition_on_previous_text=false,
hallucination_silence_threshold=2, log_prob_threshold=-0.5,
compression_ratio_threshold=2.0, no_speech_threshold=0.6,
beam_size=5, repetition_penalty=1.15, language=en
```

### Toolbar UI Architecture
- **Hidden window**: Always-running BrowserWindow (show:false) hosts MediaRecorder and Web Audio API
- **Popup window**: 380x300 frameless popup above tray icon, shows transcription + settings
- **Tray icon**: System tray with dynamic tooltip showing shortcut key
- **No main window**: The toolbar is a tray-only app, window-all-closed does NOT quit
- **Settings**: Endpoint URL, API key, model dropdown (7 faster-whisper options), language selector, Test Connection, Debug button

## v2.2.1 Features (completed)

1. **Welcome Window** — Frameless 380x330 dark-themed BrowserWindow, 3 quick-start cards, `.welcome-complete` marker
2. **Configurable Keybind** — `app-config.json` in userData, `loadAppConfig()`, dynamic tray tooltip
3. **Anti-Hallucination Pipeline** — 5-stage client-side filtering (see architecture above)
4. **Model Default** — `deepdml/faster-whisper-large-v3-turbo-ct2` (was `Systran/faster-whisper-base`)
5. **Single Instance Lock** — `app.requestSingleInstanceLock()`, second launch focuses existing
6. **Startup Cleanup** — Sweeps orphaned `mvp-echo-audio-*.webm` temp files on launch
7. **Clean Build** — `npm run dist` runs `rm -rf dist` first

## THIS SESSION: Sherpa-ONNX Migration

### Strategy: GPU Docker First, Then Local CPU

**Phase 1 — GPU Docker server (do first)**
Get sherpa-onnx running on the 3080 Ti server, serving Parakeet TDT 0.6B model, and accessible from the toolbar.

**Phase 2 — Local CPU fallback (do second)**
Bundle sherpa-onnx-node in Electron for offline/no-server use.

### Why Sherpa-ONNX

- Zero telemetry, fully air-gapped, no API keys to NVIDIA
- Parakeet TDT 0.6B model: #1 on HF ASR leaderboard, 6.05% WER, beats Whisper large-v3
- Non-autoregressive TDT architecture = far fewer hallucination loops than Whisper
- Built-in speaker diarization for batch MP3 processing
- npm package exists (`sherpa-onnx` v1.12.23, actively maintained)

### Architecture Target

```
MVP-Echo Toolbar (Electron)
  │
  ├── [Online + GPU] → sherpa-onnx Docker (3080 Ti, REST or WebSocket)
  │                      Parakeet TDT 0.6B + CUDA
  │
  ├── [Offline/CPU] → sherpa-onnx-node (bundled native addon)
  │                     Parakeet TDT 0.6B INT8 (~240MB)
  │                     Silero VAD (~2MB)
  │
  └── [Batch MP3s] → Same GPU server + diarization
                       Pyannote segmentation + speaker embeddings
```

### Research Findings (completed)

1. **No built-in HTTP server** — sherpa-onnx only has WebSocket servers natively. No official Docker images exist.
2. **No official Docker images** — `ghcr.io/k2-fsa/sherpa-onnx` does not exist. Must build our own.
3. **Solution: FastAPI wrapper** — A thin Python HTTP server wrapping `sherpa_onnx.OfflineRecognizer`, exposing the same `POST /v1/audio/transcriptions` endpoint as faster-whisper-server. This means auth-proxy.py and whisper-remote.js need zero changes.
4. **Audio conversion** — Server-side via ffmpeg (WebM/MP3/OGG → 16kHz mono WAV). No client changes needed.
5. **GPU Python package**: `pip install sherpa-onnx==1.12.23+cuda12.cudnn9 -f https://k2-fsa.github.io/sherpa/onnx/cuda.html`
6. **Models on HuggingFace**:
   - GPU float32: `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2` (2.5 GB — encoder.onnx + encoder.weights + decoder.onnx + joiner.onnx + tokens.txt)
   - CPU int8: `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` (661 MB — encoder.int8.onnx + decoder.int8.onnx + joiner.int8.onnx + tokens.txt)
   - V3 multilingual (25 languages) also available at same naming convention with `-v3` suffix

### Phase 1: GPU Docker Server (BUILT — ready to deploy)

Files in `sherpa-onnx-docker/`:

| File | Purpose |
|------|---------|
| `server.py` | FastAPI server wrapping sherpa-onnx OfflineRecognizer. OpenAI-compatible endpoint. |
| `Dockerfile` | CUDA 12.6.3 + cuDNN 9 base, sherpa-onnx GPU, ffmpeg, FastAPI. |
| `entrypoint.sh` | Downloads Parakeet TDT 0.6B model on first start if not in volume. |
| `docker-compose.yml` | sherpa-onnx server + auth-proxy (reuses existing auth-proxy.py and api-keys.json). |

**To deploy on GPU server (192.168.1.10):**
```bash
cd sherpa-onnx-docker
docker compose build          # builds sherpa-onnx-server image
docker compose up -d          # starts sherpa-onnx + auth-proxy
# First start downloads ~2.5GB model, subsequent starts are instant
curl http://localhost:20300/health   # → {"status": "ok"}
```

**API compatibility**: The server accepts the exact same multipart form-data POST that faster-whisper-server does. Same endpoint path (`/v1/audio/transcriptions`), same field names (`file`, `model`, `language`, `response_format`), same response shape (`text`, `duration`, `language`, `segments`). The whisper-remote.js anti-hallucination params are accepted and silently ignored (Parakeet TDT doesn't hallucinate like Whisper).

**To switch from faster-whisper to sherpa-onnx:**
1. Stop faster-whisper: `cd faster-whisper-docker && docker compose down`
2. Start sherpa-onnx: `cd sherpa-onnx-docker && docker compose up -d`
3. No toolbar changes needed — same port (20300), same API shape

### Phase 1 Remaining Tasks

- **Deploy and test on 3080 Ti server** — Build image, verify GPU detection, test with real audio
- **Validate response format** — Ensure whisper-remote.js parses the response correctly (especially `segments` for anti-hallucination pipeline)
- **Performance benchmark** — Compare RTF (real-time factor) vs faster-whisper with large-v3-turbo

### Phase 2 Tasks (Local CPU — later)

1. **Install sherpa-onnx npm package** in the inner toolbar project
2. **Download Parakeet TDT INT8 model** (~661 MB) + Silero VAD (~2MB)
3. **Build local engine class** using sherpa-onnx Node.js API
4. **Configure electron-builder** `asarUnpack` for native module
5. **Add "Local CPU" option** to Settings engine selector
6. **Test offline mode** — toolbar should work with no network

### Key Links

- sherpa-onnx GitHub: https://github.com/k2-fsa/sherpa-onnx
- GPU model (float32): https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2
- CPU model (int8): https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8
- V3 multilingual: https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3
- sherpa-onnx npm: https://www.npmjs.com/package/sherpa-onnx
- Electron integration: https://github.com/k2-fsa/sherpa-onnx/issues/1945
- CUDA wheels: https://k2-fsa.github.io/sherpa/onnx/cuda.html
- Community reference (FastAPI): https://github.com/ruzhila/voiceapi
- Community reference (Node.js): https://github.com/hfyydd/sherpa-onnx-server

### Known Risks

- CUDA support has open issues on some GPU/driver combos (https://github.com/k2-fsa/sherpa-onnx/issues/2138)
- Electron native module path resolution requires `asarUnpack` config for Phase 2
- CPU mode: expect ~1-3 seconds per short clip (acceptable for voice-to-text)
- Model download is ~2.5GB on first start — need patience or pre-seed the volume

## Docker Server Details

**Current working server**: `fedirz/faster-whisper-server:latest-cuda` (Oct 2024)
- Port: 20300 (external) → 8080 (auth proxy) → 8000 (whisper)
- Server IP: 192.168.1.10
- GPU: NVIDIA 3080 Ti (12GB VRAM)
- CUDA: 12.6.3

**Speaches upgrade attempt**: `ghcr.io/speaches-ai/speaches:latest-cuda` — abandoned, 404 on transcription endpoint. Moving to sherpa-onnx instead.

**Auth proxy** (`auth-proxy.py`):
- Pure Python stdlib HTTP proxy (no pip dependencies)
- LAN (192.168.x.x, 10.x.x.x, 172.16.x.x) → no key needed
- Remote (Cloudflare tunnel at mvp-echo.ctgs.link) → Bearer token required
- Usage tracking: cumulative seconds per key in `usage.json`
- Reads `api-keys.json` on every request (live edit)
- Logs include app version from User-Agent header

## Key Files (Production Toolbar)

| File | Purpose |
|------|---------|
| `mvp-echo-toolbar/app/main/main-simple.js` | Main process: tray, IPC, popup, welcome window, keybind, single-instance |
| `mvp-echo-toolbar/app/stt/whisper-remote.js` | Cloud STT: HTTP POST + retry + anti-hallucination pipeline |
| `mvp-echo-toolbar/app/main/tray-manager.js` | System tray icon with dynamic tooltip |
| `mvp-echo-toolbar/app/renderer/app/components/SettingsPanel.tsx` | Settings: endpoint, key, model dropdown, language, test connection, debug |
| `mvp-echo-toolbar/app/renderer/app/components/TranscriptionDisplay.tsx` | Transcription text display in popup |
| `mvp-echo-toolbar/package.json` | v2.2.1, deps: node-fetch, form-data, react, electron |

## Key Files (Docker Servers)

| File | Purpose |
|------|---------|
| `sherpa-onnx-docker/server.py` | FastAPI server wrapping sherpa-onnx with Parakeet TDT (OpenAI-compatible) |
| `sherpa-onnx-docker/Dockerfile` | CUDA 12.6.3 image with sherpa-onnx GPU, ffmpeg, FastAPI |
| `sherpa-onnx-docker/entrypoint.sh` | Downloads model on first start, then runs server |
| `sherpa-onnx-docker/docker-compose.yml` | sherpa-onnx + auth-proxy (port 20300) |
| `faster-whisper-docker/auth-proxy.py` | Auth + CORS + usage tracking proxy (shared by both servers) |
| `faster-whisper-docker/docker-compose.yml` | Old faster-whisper server (speaches, broken) + auth-proxy |
| `faster-whisper-docker/api-keys.json` | API key definitions (shared) |
| `faster-whisper-docker/usage.json` | Usage tracking data (shared) |

## API Keys

| Name | Key | Active |
|------|-----|--------|
| Corey (dev) | `sk-corey-2026` | Yes |
| Alex | `sk-alex-2026` | Yes |
| Guest 1-5 | Various | Yes |
