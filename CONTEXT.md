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

### Phase 1 Tasks (GPU Docker)

1. **Research sherpa-onnx server API** — What endpoints does it expose? HTTP REST? WebSocket only? What's the request/response format? This is the critical unknown.

2. **Get Docker container running** — `ghcr.io/k2-fsa/sherpa-onnx:latest` on the 3080 Ti server. Verify GPU access, load Parakeet TDT model. May need to build custom Dockerfile if the official image doesn't have a server mode.

3. **Decide on auth proxy approach** — The current auth-proxy.py is a simple HTTP forwarder. If sherpa-onnx uses WebSocket, the proxy can't just forward POST requests. Options:
   - If sherpa-onnx has an HTTP REST endpoint: keep auth-proxy as-is, just change backend URL
   - If WebSocket only: need to add WebSocket proxying to auth-proxy, or put auth in a different layer
   - If neither: write a thin HTTP wrapper around sherpa-onnx's native API

4. **Audio format conversion** — The toolbar currently sends WebM (from MediaRecorder). Sherpa-onnx likely needs 16-bit PCM WAV at 16kHz mono. Options:
   - Convert server-side (in wrapper/proxy)
   - Convert client-side in Electron main process (ffmpeg or Web Audio API in renderer)
   - Use AudioContext in renderer to capture raw PCM instead of MediaRecorder WebM

5. **Build `sherpa-engine.js`** — New engine class alongside `whisper-remote.js`. Same interface: `transcribe(audioFilePath, options) → { text, language, duration, processingTime, engine }`.

6. **Update Settings UI** — Add engine type selector (Cloud Whisper / Cloud Sherpa / Local CPU). Model dropdown changes based on engine type.

### Phase 2 Tasks (Local CPU — later)

1. **Install sherpa-onnx npm package** in the inner toolbar project
2. **Download Parakeet TDT INT8 model** (~240MB) + Silero VAD (~2MB)
3. **Build local engine class** using sherpa-onnx Node.js API
4. **Configure electron-builder** `asarUnpack` for native module
5. **Add "Local CPU" option** to Settings engine selector
6. **Test offline mode** — toolbar should work with no network

### Critical Research Needed (Start of Next Session)

Before writing any code, the next session should research:

1. **Does sherpa-onnx have a server/service mode?** Check the GitHub repo for HTTP server examples, Docker usage docs, or WebSocket server code. The npm package is for embedded/local use — the Docker story might be different.

2. **What's the actual API contract?** Find example request/response for Parakeet TDT transcription. Is it a single HTTP POST? Streaming WebSocket? gRPC?

3. **Model file locations** — Where to download `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3` (GPU) and `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` (CPU)? Verify they're on HuggingFace.

4. **Docker GPU support** — Does `ghcr.io/k2-fsa/sherpa-onnx:latest` include CUDA? Or do you need `ghcr.io/k2-fsa/sherpa-onnx:cuda`? Check available tags.

### Key Research Links

- sherpa-onnx GitHub: https://github.com/k2-fsa/sherpa-onnx
- sherpa-onnx npm: https://www.npmjs.com/package/sherpa-onnx
- Electron integration issue: https://github.com/k2-fsa/sherpa-onnx/issues/1945
- Parakeet TDT model: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2
- ONNX INT8 model for CPU: search `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` on HuggingFace
- NeMo + diarization Docker gist: https://gist.github.com/lokafinnsw/95727707f542a64efc18040aefe47751
- Docker image: `ghcr.io/k2-fsa/sherpa-onnx:latest`
- CUDA issue tracker: https://github.com/k2-fsa/sherpa-onnx/issues/2138

### Known Risks

- CUDA support has open issues on some GPU/driver combos
- Electron native module path resolution requires `asarUnpack` config for Phase 2
- WebSocket API differs from HTTP POST — may need new engine class and proxy changes
- Audio format: MediaRecorder WebM → needs conversion to PCM WAV 16kHz mono
- CPU mode: expect ~1-3 seconds per short clip (acceptable for voice-to-text)

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
| `faster-whisper-docker/auth-proxy.py` | Auth + CORS + usage tracking proxy |
| `faster-whisper-docker/docker-compose.yml` | speaches (broken) + auth-proxy containers |

## API Keys

| Name | Key | Active |
|------|-----|--------|
| Corey (dev) | `sk-corey-2026` | Yes |
| Alex | `sk-alex-2026` | Yes |
| Guest 1-5 | Various | Yes |
