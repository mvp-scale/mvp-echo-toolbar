# MVP-Echo Toolbar — Roadmap & Task Tracker

**Version**: `v2.2.1` → targeting `v3.0.0`
**Branch**: `dev`
**Updated**: 2026-02-09

---

## Roadmap: v3.0 — Model Management + UX Overhaul

### Task Table

| # | Task | Depends On | Goal | Confidence | Status | Notes |
|---|------|-----------|------|------------|--------|-------|
| 1 | Welcome Screen Redesign | — | Larger window, version info, recent features, "don't show again" checkbox | :green_circle: Green | UI Approved | Component: `app/renderer/app/components/WelcomeScreen.tsx` (root project). IPC wired: `welcome:get-preference` / `welcome:set-preference`. Preview: `http://localhost:5173/?preview=welcome`. Integration into toolbar pending |
| 2 | Remove Faster-Whisper Model References | — | Replace stale model entries in whisper-native.js, whisper-engine.js, EngineSelector.tsx, CaptureApp.tsx | :green_circle: Green | Not Started | No whisper-remote.js exists; stale refs are in local engine files |
| 3 | Settings Panel: Engine/Model Dropdown | #2, #14 | GPU Server (3 models) + Local CPU (3 models) with status indicators | :green_circle: Green | UI Approved | Component: `mvp-echo-toolbar/app/renderer/app/components/SettingsPanel.tsx`. Preview: `http://localhost:5174/popup.html`. Brand-free labels, API key smart detection, scrollable in 380x300 popup. Integration with engine port pending |
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
| Model labels in UI | Brand-free | "English", "English HD", "Multilingual" (GPU) / "Fast", "Balanced", "Accurate" (CPU). No Parakeet/Whisper names shown. Hex adapter swaps backends silently |
| GPU section header | "Industry's Best, Fastest" | Sets expectation: best available GPU models |
| CPU section header | "Industry's Best, No Internet Required" | Sets expectation: best available CPU models, with tradeoff (slower but offline) |
| Welcome screen UI | Approved 2026-02-09 | `WelcomeScreen.tsx` — preview at `?preview=welcome`. Tray-matching icon, no jargon in What's New |
| Settings panel UI | Approved 2026-02-09 | `SettingsPanel.tsx` in toolbar project — preview at `popup.html`. Scrollable in 380x300, smart API key detection |

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

### GPU Server — Industry's Best, Fastest
User-facing labels are brand-free. Backend model IDs are internal only.

| ID (internal) | Label in UI | Detail | Backend Model | Languages | Download | VRAM |
|---------------|-------------|--------|---------------|-----------|----------|------|
| `gpu-english` | English | Recommended | `parakeet-tdt-0.6b-v2-int8` | English | 460MB | ~500MB |
| `gpu-english-hd` | English HD | Highest accuracy | `parakeet-tdt-1.1b-v2-int8` | English | ~800MB | ~1GB |
| `gpu-multilingual` | Multilingual | 25 languages | `parakeet-tdt-0.6b-v3-int8` | 25 languages | ~465MB | ~500MB |

### Local CPU — Industry's Best, No Internet Required

| ID (internal) | Label in UI | Size | Speed (est.) | Quality |
|---------------|-------------|------|-------------|---------|
| `local-fast` | Fast | 75MB | ~1-2s | Basic — fastest, minimal accuracy |
| `local-balanced` | Balanced | 150MB | ~2-4s | Balanced speed and accuracy |
| `local-accurate` | Accurate | 480MB | ~4-8s | Best accuracy, slower |

No models ship with installer. All downloaded on demand to userData directory.
No brand names (Parakeet, Whisper, etc.) shown in UI — hexagonal adapter means we always show the best the industry has.

---

## Dropdown UX Design (Approved)

Integrated into toolbar popup SettingsPanel (380x300, scrollable).

```
Engine & Model
─────────────────────────────────────────
GPU SERVER — INDUSTRY'S BEST, FASTEST
  ⚡ English            [recommended]  ● loaded
  ⚡ English HD                        ○ available
  ⚡ Multilingual                      ○ available
─────────────────────────────────────────
LOCAL CPU — INDUSTRY'S BEST, NO INTERNET
  💻 Fast (75MB)                       ↓ download
  💻 Balanced (150MB)                  ↓ download
  💻 Accurate (480MB)                  ↓ download

States:  ● loaded  |  ○ available  |  ↓ download  |  ⏳ switching
```

Selecting a GPU model that's "available" → "Switching model (~10s)..." → done.
Selecting a Local model that's "download" → "Download first?" → progress → ready.
API key: auto-detected as optional for local (192.168.x.x), required for remote/HTTPS.

---

## Welcome Screen (Approved)

Component: `app/renderer/app/components/WelcomeScreen.tsx` (root project)
500px wide modal, dark theme, #4285f4 circle + white microphone icon (matches tray icon).

```
┌──────────────────────────────────────────────────────┐
│            [🎤 blue circle, white mic]               │
│              MVP-Echo Toolbar                        │
│                   v3.0.0                             │
│  ─────────────────────────────────────────────────── │
│  Voice-to-text at your fingertips. Press the         │
│  shortcut, speak, and your words are copied.         │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ 🎙️ Record │  │ 📋 Copy   │  │ ⚙️ Config │           │
│  │ Ctrl+Alt, │  │ Auto-     │  │ Click    │           │
│  │ tap Z     │  │ clipboard │  │ tray icon│           │
│  └──────────┘  └──────────┘  └──────────┘           │
│                                                      │
│  What's New:                                         │
│  • Industry-leading GPU transcription — under 1s     │
│  • Switch between English, HD, and Multilingual      │
│  • Offline CPU mode — no internet required           │
│                                                      │
│  ☐ Don't show this again          [ Get Started ]    │
└──────────────────────────────────────────────────────┘
```
No brand names in What's New. Checkbox is user's choice, never forced.

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

## Smoke Test Strategy

MVP-level validation. Not production test suites — just "does it work" checks.

### Server (run after any Docker change)
```bash
# smoke-test.sh
echo "1. Health check"
curl -s http://localhost:8000/health | jq .

echo "2. List models"
curl -s http://localhost:8000/v1/models | jq .

echo "3. Transcribe test audio"
curl -s -X POST -F "audio=@test.wav" http://localhost:8000/v1/transcribe | jq .

echo "4. Switch model"
curl -s -X POST http://localhost:8000/v1/models/switch \
  -H "Content-Type: application/json" \
  -d '{"model_id":"parakeet-1.1b-en"}' | jq .
```

### Toolbar (manual checklist, once per build)
1. Launch toolbar — does it connect to server?
2. Record 5 seconds of speech — does text appear?
3. Open settings — does dropdown show correct models and states?
4. Switch model — does status cycle through switching → ready?
5. Disconnect server — does it fall back to local (if downloaded)?

### Extra care: Task #11 (Download Manager)
Retry + checksum verification on model downloads. Half-downloaded or corrupt models are the #1 support issue risk for a couple thousand users.

---

## Project Structure (Critical)

The repo root contains **multiple projects**. Do not confuse them.

```
mvp-echo-toolbar/                  ← git repo root
├── app/                           ← ROOT PROJECT (mvp-echo "lite", older)
├── mvp-echo-toolbar/              ← THE ACTUAL TOOLBAR (this is the one to edit)
│   ├── app/main/main-simple.js    ← Electron main process
│   ├── app/renderer/app/PopupApp.tsx       ← Toolbar popup (380x300)
│   ├── app/renderer/app/components/        ← SettingsPanel.tsx (APPROVED)
│   ├── app/renderer/popup.html             ← Popup entry point
│   ├── app/stt/whisper-remote.js           ← Current remote engine
│   ├── vite.config.ts                      ← Toolbar Vite config (port 5174)
│   └── package.json                        ← name: "mvp-echo-toolbar"
├── mvp-echo-light/                ← Light variant (not active)
├── mvp-echo-standard/             ← Standard variant (not active)
├── mvp-echo-studio/               ← Studio (separate effort, GPU server)
├── mvp-stt-docker/                ← Docker server configs
├── CONTEXT.md                     ← This file
├── CLAUDE.md                      ← Project instructions
└── package.json                   ← name: "mvp-echo" (root/lite)
```

### Approved UI Components (built, not yet integrated)
| Component | Location | Preview |
|-----------|----------|---------|
| WelcomeScreen | `app/renderer/app/components/WelcomeScreen.tsx` (root) | `npm run dev` from root → `http://localhost:5173/?preview=welcome` |
| SettingsPanel | `mvp-echo-toolbar/app/renderer/app/components/SettingsPanel.tsx` | `npx vite --port 5174` from `mvp-echo-toolbar/` → `http://localhost:5174/popup.html` |

### Browser Preview Notes
- `mvp-echo-toolbar/app/renderer/app/popup-main.tsx` wraps PopupApp in a 380x300 container for browser preview
- SettingsPanel IPC calls are guarded with `?.` for browser compatibility
- Root project has `browser-mock.ts` with `getWelcomePreference`/`setWelcomePreference` mocks

---

## Server Details
- **IP**: 192.168.1.10
- **Toolbar port**: 20300 (mvp-auth → mvp-bridge → mvp-asr)
- **Studio port**: 20301 (mvp-scribe, NeMo container)
- **GPU**: NVIDIA RTX 3090 Ti, 24GB VRAM (Tower) / 3080 Ti, 12GB (original)
- **sherpa-onnx**: v1.12.23 C++ binaries
