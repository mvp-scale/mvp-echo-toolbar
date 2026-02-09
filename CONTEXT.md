# MVP-Echo Toolbar - Session Context

## Current State (2026-02-08)

**Version**: `v2.2.1` (built, not yet released)
**Build**: Portable exe only (140MB), no installer
**Branch**: `dev` (daily work), `main` (releases via GitHub Actions)

## What Changed in v2.2.1

### 1. Welcome Window (replaces broken tray balloon)
- Frameless, dark-themed 380x330 BrowserWindow with 3 quick-start cards
- Shows app name + version, uses `.welcome-complete` marker (different from old `.first-run-complete`)
- File: `mvp-echo-toolbar/app/main/main-simple.js` (`showWelcomeWindow()` function)

### 2. Configurable Keybind
- `app-config.json` in `%APPDATA%/mvp-echo-toolbar/` with `{ "shortcut": "CommandOrControl+Alt+Z" }`
- `loadAppConfig()` reads/creates config, `shortcutDisplayLabel()` converts for display
- Tray tooltip dynamically shows configured shortcut
- Files: `main-simple.js`, `tray-manager.js`

### 3. Removed Ctrl+Shift+D Debug Shortcut
- Global shortcut removed; Settings > Debug button still opens DevTools via IPC

### 4. Anti-Hallucination Pipeline (client-side)
- **Segment dedup** (`deduplicateSegments()`): Catches decoder loops before text assembly
- **Sentence dedup** (`removeRepetitions()`): Fixed — now normalizes punctuation before comparing
- **Phrase dedup** (`removeTrailingPhraseRepetitions()`): Expanded from 2-5 to 2-15 word phrases
- **Server params**: Added `repetition_penalty=1.15`, tightened `compression_ratio_threshold` to 2.0
- File: `mvp-echo-toolbar/app/stt/whisper-remote.js`

### 5. Model Default Changed
- Default model: `deepdml/faster-whisper-large-v3-turbo-ct2` (was `Systran/faster-whisper-base`)
- Changed in: `whisper-remote.js`, `SettingsPanel.tsx`, `CaptureApp.tsx`
- UI dropdown already had large-v3-turbo as an option; now it's the default for fresh installs

### 6. Build & UI Polish
- `npm run dist` now runs `rm -rf dist` first (clean build, no recursive inclusion)
- Settings scrollbar: 6px wide, blue thumb (primary color at 50% opacity)
- Removed mock transcription fallback in root `app/main/main-simple.js`

### 7. Docker Compose (speaches upgrade — NOT YET WORKING)
- Image changed to `ghcr.io/speaches-ai/speaches:latest-cuda`
- Updated env vars: `WHISPER__TTL=-1`, `VAD_MODEL_TTL=-1`, `ENABLE_UI=false`
- Updated volume path: `/home/ubuntu/.cache/huggingface/hub`
- **Status: 404 on transcription endpoint.** Speaches requires models to be pre-downloaded and has permission issues. The old `fedirz/faster-whisper-server:latest-cuda` image still works but is from Oct 2024.

## NEXT SESSION: Sherpa-ONNX Migration

### Decision Made
Replace faster-whisper-server with sherpa-onnx for both GPU (Docker) and CPU (bundled in Electron) modes. Key reasons:
- Zero telemetry, fully air-gapped, no API keys to NVIDIA
- Parakeet TDT 0.6B model: #1 on HF ASR leaderboard, 6.05% WER, beats Whisper large-v3
- Non-autoregressive TDT architecture = far fewer hallucination loops than Whisper
- Built-in speaker diarization for batch MP3 processing
- npm package exists (`sherpa-onnx` v1.12.23, actively maintained)

### Architecture Target

```
MVP-Echo Toolbar (Electron)
  |
  |-- [Online + GPU] --> sherpa-onnx Docker (3080 Ti, WebSocket/REST)
  |                       Parakeet TDT 0.6B + CUDA
  |
  |-- [Offline/CPU] --> sherpa-onnx-node (bundled native addon)
  |                      Parakeet TDT 0.6B INT8 (~240MB)
  |                      Silero VAD (~2MB)
  |
  |-- [Batch MP3s] --> Same GPU server + diarization
                        Pyannote segmentation + speaker embeddings
```

### Settings UI Changes Needed
- Model/engine dropdown: "Local CPU" option alongside remote URL
- API key: only required for non-LAN remote access (same auth proxy behavior)
- Test Connection: should validate AND download model if needed
- Same Debug button, same everything else

### Implementation Steps (for next session)
1. **Validate Docker GPU server** — get sherpa-onnx container running on 3080 Ti with Parakeet TDT model
2. **Understand the API shape** — sherpa-onnx uses WebSocket or its own REST format, NOT OpenAI's `/v1/audio/transcriptions` multipart form
3. **Build `sherpa-engine.js`** — new engine class alongside existing `whisper-remote.js`
4. **Bundle sherpa-onnx-node** — CPU fallback, ~260MB added to exe, requires `asarUnpack` for native module
5. **Update Settings UI** — add Local CPU option, engine selection
6. **Audio format** — sherpa-onnx may need WAV (mono 16-bit 16kHz), toolbar currently sends WebM

### Key Research Links
- sherpa-onnx GitHub: https://github.com/k2-fsa/sherpa-onnx
- sherpa-onnx npm: https://www.npmjs.com/package/sherpa-onnx
- Electron integration: https://github.com/k2-fsa/sherpa-onnx/issues/1945
- Parakeet TDT model: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2
- ONNX INT8 model for CPU: search `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` on HuggingFace
- NeMo + diarization Docker gist: https://gist.github.com/lokafinnsw/95727707f542a64efc18040aefe47751
- Docker image: `ghcr.io/k2-fsa/sherpa-onnx:latest`

### Known Risks
- CUDA support has open issues on some GPU/driver combos (https://github.com/k2-fsa/sherpa-onnx/issues/2138)
- Electron native module path resolution requires `asarUnpack` config
- WebSocket API differs from HTTP POST — client needs new engine class
- CPU mode: expect ~1-3 seconds per short clip (not sub-100ms)

## Architecture

```
MVP-Echo Toolbar (Windows Electron app)
    |
    | HTTP POST with Bearer token (current)
    | WebSocket (planned for sherpa-onnx)
    v
Cloudflare Tunnel (mvp-echo.ctgs.link)
    |
    v
auth-proxy (Docker, validates keys, tracks usage)
    |
    v
ASR Server (Docker, GPU)
  - Current: fedirz/faster-whisper-server (Oct 2024, working)
  - Target: sherpa-onnx with Parakeet TDT 0.6B
```

## Key Files

| File | Purpose |
|------|---------|
| `mvp-echo-toolbar/app/main/main-simple.js` | Main process, IPC, tray, welcome window, keybind config |
| `mvp-echo-toolbar/app/stt/whisper-remote.js` | Cloud STT client with retry/headers/anti-hallucination |
| `mvp-echo-toolbar/app/main/tray-manager.js` | System tray icon, dynamic tooltip |
| `mvp-echo-toolbar/app/renderer/app/CaptureApp.tsx` | Hidden capture window, handles shortcut recording |
| `mvp-echo-toolbar/app/renderer/app/components/SettingsPanel.tsx` | Settings UI (endpoint, key, model, language) |
| `mvp-echo-toolbar/app/renderer/app/styles/globals.css` | Global styles including scrollbar |
| `mvp-echo-toolbar/package.json` | v2.2.1, build scripts with clean step |
| `faster-whisper-docker/auth-proxy.py` | Auth + usage tracking + CORS proxy |
| `faster-whisper-docker/docker-compose.yml` | ASR server + auth proxy containers |

## Docker Server Details

**Current working server**: `fedirz/faster-whisper-server:latest-cuda` (Oct 2024)
- Port: 20300 (external) → 8080 (auth proxy) → 8000 (whisper)
- Server IP: 192.168.1.10
- GPU: NVIDIA 3080 Ti (12GB VRAM)
- CUDA: 12.6.3

**Auth proxy behavior**:
- LAN (192.168.x.x, 10.x.x.x) → no key needed
- Remote (Cloudflare tunnel) → Bearer token required
- Usage tracking: cumulative seconds per key in usage.json

## API Keys

| Name | Key | Active |
|------|-----|--------|
| Corey (dev) | `sk-corey-2026` | Yes |
| Alex | `sk-alex-2026` | Yes |
| Guest 1-5 | Various | Yes |

## Testing Checklist

**Toolbar (v2.2.1):**
- Launch exe, welcome window should appear (dark, 3 cards, Got it button)
- Second launch: no welcome window
- Ctrl+Alt+Z: record/stop, transcription appears in popup
- Ctrl+Shift+D: should do nothing (removed)
- Settings > Debug: DevTools should open
- Settings scrollbar: visible blue bar on right
- Tray tooltip: "MVP-Echo - Ready (Ctrl+Alt+Z)"
- Edit `app-config.json` shortcut, restart: new shortcut should work

**Docker (current — faster-whisper):**
- `curl http://192.168.1.10:20300/health` → OK
- Transcription works with large-v3-turbo model (auto-downloads on first use)
- Auth proxy logs show version tag `[v2.2.1]`
