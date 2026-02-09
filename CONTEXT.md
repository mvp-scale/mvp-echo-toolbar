# MVP-Echo Toolbar — Roadmap & Task Tracker

**Version**: `v2.2.1` → targeting `v3.0.0`
**Branch**: `dev`
**Updated**: 2026-02-09

---

## Roadmap: v3.0 — Model Management + UX Overhaul

### Task Table

| # | Task | Depends On | Goal | Confidence | Status | Notes |
|---|------|-----------|------|------------|--------|-------|
| 1 | Welcome Screen Redesign | — | Larger window, version info, recent features, "don't show again" checkbox | :green_circle: Green | Not Started | HTML/CSS in main-simple.js, mockup below |
| 2 | Remove Faster-Whisper Model References | — | Replace stale model entries in whisper-native.js, whisper-engine.js, EngineSelector.tsx, CaptureApp.tsx | :green_circle: Green | Not Started | No whisper-remote.js exists; stale refs are in local engine files |
| 3 | Settings Panel: Engine/Model Dropdown | #2, #14 | GPU Server (3 models) + Local CPU (3 models) with status indicators | :green_circle: Green | Not Started | Show loaded/available/not-downloaded states. Reads from engine port |
| 4 | Server: Hexagonal Architecture (Bridge Refactor) | — | Refactor bridge.py with ModelEngine port + adapter pattern. SubprocessAdapter (new default) + WebSocketAdapter (fallback to current 3-container setup) | :green_circle: Green | Not Started | Archive current docker-compose (`git tag v2.2.1-pre-merge` + copy) before starting. Enables #5, #6, #7 |
| 5 | Server: Model Switch API | #4 | `POST /v1/models/switch` — port calls adapter to swap model. `GET /v1/models` returns loaded + available | :green_circle: Green | Not Started | ~5-10s switch time. API builds against port, adapter-agnostic |
| 6 | Server: Idle Timeout / Auto-Unload | #4 | Unload model after 60min idle, reload on next request (~5-10s cold start) | :green_circle: Green | Not Started | Timer reset on every transcription. Configurable via env var. Implemented at port level |
| 7 | Server: Pre-Download All GPU Models | #4 | Download all 3 Parakeet TDT models on first start (~1.7GB total) | :green_circle: Green | Not Started | entrypoint.sh downloads all to shared volume |
| 8 | Toolbar: Model Switch UX | #3, #5, #14 | User picks model → "Switching..." status → ready in 5-10s | :green_circle: Green | Not Started | Engine manager calls switch via RemoteAdapter, polls until ready |
| 9 | Toolbar: Server Status in Settings | #5, #14 | Show loaded model, idle time, model states (loaded/sleeping/available) | :green_circle: Green | Not Started | RemoteAdapter polls `/v1/models` and `/health` |
| 10 | Local CPU Engine (sherpa-onnx sidecar) | #14 | Bundle prebuilt sherpa-onnx CLI binary as sidecar process, communicate via stdio | :green_circle: Green | Not Started | Sidecar approach — no native Node addon, no ASAR issues. Matches existing subprocess pattern |
| 11 | Local CPU: Model Download Manager | #10 | Download Fast/Balanced/Accurate models on demand with progress UI | :yellow_circle: Yellow | Not Started | Store in userData dir. No model ships with installer |
| 12 | Anti-Hallucination Pipeline Review | — | Simplify pipeline for Parakeet TDT (non-autoregressive, less hallucination) | :green_circle: Green | Not Started | Keep as safety net, remove Whisper-specific patterns |
| 13 | Keybind Display in UI | — | Show current shortcut in Settings, note about config file for changing | :green_circle: Green | Not Started | Read from app-config.json, display read-only |
| 14 | Toolbar: Hexagonal Engine Refactor | #2 | Refactor engine-manager.js with Engine port (transcribe, isAvailable, getHealth) + adapters: RemoteAdapter (HTTP to server), LocalSidecarAdapter (sherpa-onnx CLI subprocess) | :green_circle: Green | Not Started | Replaces whisper-native.js / whisper-engine.js with adapter pattern. No whisper-remote.js — remote is just another adapter |

### Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Docker architecture | Hexagonal (port/adapter) | Future-proof model backends, built-in fallback to current 3-container setup via WebSocketAdapter |
| Local CPU integration | Sidecar process (prebuilt CLI binary) | Avoids Electron native addon ASAR issues, matches existing subprocess pattern, low risk |
| Local CPU model naming | Fast / Balanced / Accurate | Human-readable, conveys speed-vs-quality tradeoff. Replaces tiny/base/small |
| Toolbar engine layer | Hexagonal (port/adapter) | RemoteAdapter + LocalSidecarAdapter behind same interface. No hard-coded whisper-remote.js |
| whisper-remote.js | Never created | File doesn't exist in codebase. Remote server access is handled by RemoteAdapter in engine port |

### Test Strategy

| # | Validation |
|---|-----------|
| 1 | Welcome screen renders at correct size, "don't show again" persists across restarts, version displays correctly |
| 2 | No references to `Systran/faster-whisper-*` or `deepdml/faster-whisper-*` remain in codebase |
| 3 | Dropdown shows correct engine/model list, states reflect server reality via engine port |
| 4 | bridge.py starts with SubprocessAdapter, transcription works end-to-end. Switch to WebSocketAdapter, same test passes against 3-container setup |
| 5 | `curl POST /v1/models/switch` changes model, subsequent transcriptions use new model |
| 6 | After 60min idle, ASR process stopped (check with `ps`). Next request triggers reload, returns result |
| 7 | All 3 models present in volume after first start. `GET /v1/models` lists all |
| 8 | Pick model in toolbar → status shows "Switching..." → status shows "Ready" with new model name |
| 9 | Settings shows "Parakeet 0.6B English (loaded, idle 5m)" or "sleeping" accurately |
| 10 | Toolbar transcribes audio with no network connection using local sherpa-onnx sidecar |
| 11 | Download button shows progress, model appears in dropdown after download, works immediately |
| 12 | Short silence-only audio returns empty string (not "Thank you."). Normal speech unaffected |
| 13 | Current keybind shown in Settings. Matches what actually works |
| 14 | engine-manager.js selects RemoteAdapter when server URL configured, falls back to LocalSidecarAdapter when offline. Both implement same Engine port interface |

---

## Architecture: Current vs Target

### Current (v2.2.1)
```
Toolbar (Windows)                          Server (Docker, 192.168.1.10)
┌─────────────────────┐                   ┌──────────────────────────────────┐
│ engine-manager.js   │                   │ 3 containers:                    │
│  ├─ whisper-native  │                   │  mvp-auth (:20300)               │
│  └─ whisper-engine  │                   │    → mvp-bridge (:8000)          │
│                     │  HTTP POST        │      → WS → mvp-asr (:6006)     │
│ Hard-coded engines, │ ──────────────→   │              sherpa-onnx C++     │
│ no adapter pattern  │                   │              1 model, always on  │
└─────────────────────┘                   └──────────────────────────────────┘
```
Tight coupling on both sides. No model switching. No idle management.

### Target (v3.0) — Hexagonal on Both Sides
```
Toolbar (Windows)                          Server (Docker, 192.168.1.10)
┌─────────────────────┐                   ┌──────────────────────────────────┐
│ engine-manager.js   │                   │ 2 containers:                    │
│  Engine Port:       │                   │  mvp-auth (:20300)               │
│  transcribe()       │                   │    → mvp-bridge (:8000)          │
│  isAvailable()      │  HTTP POST        │       ModelEngine Port:          │
│  getHealth()        │ ──────────────→   │       transcribe()               │
│                     │                   │       load_model()               │
│  ├─ RemoteAdapter   │  (API contract)   │       unload_model()             │
│  │   HTTP to server │ ←─────────────    │       get_status()               │
│  │                  │                   │       list_available()            │
│  └─ LocalSidecar    │                   │                                  │
│      sherpa-onnx    │                   │       ├─ SubprocessAdapter       │
│      CLI binary     │                   │       │   (sherpa-onnx child)    │
│      (offline)      │                   │       └─ WebSocketAdapter        │
│                     │                   │           (fallback to mvp-asr)  │
└─────────────────────┘                   └──────────────────────────────────┘
```
Clean port/adapter on both sides. API contract in the middle is the only coupling point.
Neither side is bound to a specific model engine implementation.

---

## Available Models

### GPU Server (Parakeet TDT via sherpa-onnx)

| ID | Label in Dropdown | Params | Languages | Download | VRAM | HF Repo |
|----|-------------------|--------|-----------|----------|------|---------|
| `parakeet-0.6b-en` | Parakeet English (recommended) | 600M | English | 460MB | ~500MB | `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8` |
| `parakeet-1.1b-en` | Parakeet English HD | 1.1B | English | ~800MB | ~1GB | `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-1.1b-v2-int8` |
| `parakeet-0.6b-multi` | Parakeet Multilingual (25 langs) | 600M | 25 languages | ~465MB | ~500MB | `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` |

### Local CPU (sherpa-onnx sidecar, offline)

| ID | Label in Dropdown | Size | Speed (est.) | Quality |
|----|-------------------|------|-------------|---------|
| `local-fast` | Local: Fast | 75MB | ~1-2s | Basic — fastest, minimal accuracy |
| `local-balanced` | Local: Balanced | 150MB | ~2-4s | Balanced speed and accuracy |
| `local-accurate` | Local: Accurate | 480MB | ~4-8s | Best accuracy, slower |

No models ship with installer. All downloaded on demand to userData directory.

---

## Dropdown UX Design

```
┌─────────────────────────────────────────────────────┐
│ Engine & Model                                    ▼ │
├─────────────────────────────────────────────────────┤
│ GPU SERVER                                          │
│  ⚡ Parakeet English (recommended)      ● loaded    │
│  ⚡ Parakeet English HD                 ○ available  │
│  ⚡ Parakeet Multilingual (25 langs)    ○ available  │
├─────────────────────────────────────────────────────┤
│ LOCAL CPU (offline, no internet required)            │
│  💻 Fast (75MB)                        ↓ download   │
│  💻 Balanced (150MB)                   ↓ download   │
│  💻 Accurate (480MB)                   ↓ download   │
└─────────────────────────────────────────────────────┘

States:  ● loaded  |  ○ available  |  ↓ download  |  ⏳ switching
```

Selecting a GPU model that's "available" → "Switching model (~10s)..." → done.
Selecting a Local model that's "download" → "Download first?" → progress → ready.

---

## Welcome Screen Mockup

Target: 500x400px centered window, dark theme, dismissable.

```
┌──────────────────────────────────────────────────────┐
│                                                      │
│              🎤  MVP-Echo Toolbar                     │
│                   v3.0.0                             │
│                                                      │
│  ─────────────────────────────────────────────────── │
│                                                      │
│  Voice-to-text at your fingertips.                   │
│  Press Ctrl+Alt+Z to record, tap Z again to stop.   │
│  Text is copied to your clipboard automatically.     │
│                                                      │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐       │
│  │  🎙️ Record  │ │  📋 Copy    │ │  ⚙️ Config  │       │
│  │            │ │            │ │            │       │
│  │ Hold       │ │ Text auto- │ │ Click tray │       │
│  │ Ctrl+Alt,  │ │ copied to  │ │ icon to    │       │
│  │ tap Z to   │ │ clipboard  │ │ open       │       │
│  │ toggle     │ │ on finish  │ │ settings   │       │
│  └────────────┘ └────────────┘ └────────────┘       │
│                                                      │
│  What's New:                                         │
│  • GPU server with Parakeet TDT (sub-1s speed)      │
│  • Model switching (English, HD, Multilingual)       │
│  • Local CPU mode (no internet required)             │
│                                                      │
│                              ┌──────────────────┐   │
│  ☐ Don't show this again     │   Get Started    │   │
│                              └──────────────────┘   │
└──────────────────────────────────────────────────────┘
```

---

## Key Files

### Toolbar (mvp-echo-toolbar/)
| File | Purpose | Changes Needed |
|------|---------|----------------|
| `app/main/main-simple.js` | Main process, welcome window, IPC, keybinds | #1: welcome redesign |
| `app/renderer/app/components/SettingsPanel.tsx` | Settings UI | #3, #8, #9, #13 |
| `app/renderer/app/components/EngineSelector.tsx` | Engine selection UI | #2: remove Faster-Whisper refs, #3: new dropdown |
| `app/renderer/app/PopupApp.tsx` | Popup layout | Minor: accommodate new settings |
| `app/renderer/app/CaptureApp.tsx` | Hidden capture window | #2: remove default model ref |
| `app/stt/engine-manager.js` | Engine orchestrator | #14: refactor to Engine port with adapter selection |
| `app/stt/whisper-native.js` | Local subprocess engine | #14: replace with LocalSidecarAdapter |
| `app/stt/whisper-engine.js` | Python subprocess engine | #14: remove (deprecated with Faster-Whisper) |
| `app/stt/adapters/remote-adapter.js` | NEW: HTTP client to server | #14: implements Engine port for remote server |
| `app/stt/adapters/local-sidecar-adapter.js` | NEW: sherpa-onnx CLI subprocess | #14: implements Engine port for local CPU |

### Docker Server (mvp-stt-docker/)
| File | Purpose | Changes Needed |
|------|---------|----------------|
| `docker-compose.yml` | Service definitions | #4: merge bridge+ASR services |
| `docker-compose.v2.2.1.yml` | NEW: Archived working config | #4: copy before merge for easy comparison |
| `bridge.py` | HTTP API + ModelEngine port | #4: port/adapter refactor, #5: switch API, #6: idle timer |
| `adapters/subprocess_adapter.py` | NEW: manages sherpa-onnx child process | #4: default adapter |
| `adapters/websocket_adapter.py` | NEW: connects to separate ASR container | #4: fallback adapter (preserves current behavior) |
| `entrypoint-asr.sh` | Model download + start | #7: download all models |
| `auth-proxy.py` | Auth middleware | No changes needed |

### MVP-Echo Studio (mvp-echo-studio/) — Separate Effort
| Status | Detail |
|--------|--------|
| Transcription | Working (Parakeet TDT on NeMo, sub-20s for 17min audio) |
| Diarization | Blocked: torchaudio ABI mismatch, testing `torchaudio==2.7.0` on GPU server |
| Frontend | Built and serving, untested with real diarized data |
| Location | Being iterated on GPU server (192.168.1.10), will merge back to dev |

---

## Server Details
- **IP**: 192.168.1.10
- **Toolbar port**: 20300 (mvp-auth → mvp-bridge → mvp-asr)
- **Studio port**: 20301 (mvp-scribe, NeMo container)
- **GPU**: NVIDIA RTX 3090 Ti, 24GB VRAM (Tower) / 3080 Ti, 12GB (original)
- **sherpa-onnx**: v1.12.23 C++ binaries
