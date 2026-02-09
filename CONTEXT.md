# MVP-Echo Toolbar — Roadmap & Task Tracker

**Version**: `v2.2.1` → `v3.0.0-alpha.5` (in testing)
**Branch**: `dev`
**Updated**: 2026-02-09 (Session 2)

---

## Roadmap: v3.0 — Model Management + UX Overhaul

### Task Table

| # | Task | Depends On | Goal | Confidence | Status | Notes |
|---|------|-----------|------|------------|--------|-------|
| 1 | Welcome Screen Redesign | — | Light theme, squircle icon, tray guidance, version-scoped dismiss, 4 tray state icons | :green_circle: Green | Approved (Session 2) | Light theme (white bg, blue accents). Squircle mic icon (rounded-[16px]). Intro text guides users to notification area / system tray. Tray Icon card shows 4 state icons (ready/recording/processing/done) as colored squircle SVGs. "Don't show again" is version-scoped: stores `dismissedVersion` in `welcome-config.json`, re-shows on new version. Version fetched dynamically via `app:get-version` IPC. Preview: `npx vite --port 5174` from `mvp-echo-toolbar/` → `http://localhost:5174/welcome.html` |
| 2 | Remove Faster-Whisper Model References | — | Replace stale model entries with new brand-free IDs | :green_circle: Green | Complete | All Systran/deepdml refs replaced with `gpu-english` etc. in: `whisper-remote.js`, `CaptureApp.tsx`, `SettingsPanel.tsx` |
| 3 | Settings Panel: Engine/Model Dropdown | #2, #14 | GPU Server (3 models) + Local CPU (3 models) with status indicators | :green_circle: Green | UI Approved | Component: `mvp-echo-toolbar/app/renderer/app/components/SettingsPanel.tsx`. Preview: `http://localhost:5174/popup.html`. Brand-free labels, API key smart detection, scrollable in 380x300 popup. Integration with engine port pending |
| 4 | Server: Hexagonal Architecture (Bridge Refactor) | — | Refactor bridge.py with ModelEngine port + adapter pattern. SubprocessAdapter (new default) + WebSocketAdapter (fallback to current 3-container setup) | :green_circle: Green | Complete | `ports.py` + `adapters/{websocket_adapter.py, subprocess_adapter.py}` created. bridge.py refactored. docker-compose.v2.2.1.yml archived. SubprocessAdapter has sherpa-onnx CLI incompatibility; WebSocketAdapter set as default (proven stable) |
| 5 | Server: Model Switch API | #4 | `POST /v1/models/switch` — port calls adapter to swap model. `GET /v1/models` returns loaded + available | :green_circle: Green | Complete | Built into bridge.py v3.0. API works with both adapters. Not fully tested (SubprocessAdapter blocked by CLI issue) |
| 6 | Server: Idle Timeout / Auto-Unload | #4 | Unload model after 60min idle, reload on next request (~5-10s cold start) | :green_circle: Green | Not Started | Timer reset on every transcription. Configurable via env var. Implemented at port level |
| 7 | Server: Pre-Download All GPU Models | #4 | Download all 3 Parakeet TDT models on first start (~1.7GB total) | :green_circle: Green | Not Started | entrypoint.sh downloads all to shared volume |
| 8 | Toolbar: Model Switch UX | #3, #5, #14 | User picks model → "Switching..." status → ready in 5-10s | :green_circle: Green | Not Started | Engine manager calls switch via RemoteAdapter, polls until ready |
| 9 | Toolbar: Server Status in Settings | #5, #14 | Show loaded model, idle time, model states (loaded/sleeping/available) | :green_circle: Green | Not Started | RemoteAdapter polls `/v1/models` and `/health` |
| 10 | Local CPU Engine (sherpa-onnx sidecar) | #14 | Bundle prebuilt sherpa-onnx CLI binary as sidecar process, communicate via stdio | :green_circle: Green | Not Started | Sidecar approach — no native Node addon, no ASAR issues. Matches existing subprocess pattern |
| 11 | Local CPU: Model Download Manager | #10 | Download Fast/Balanced/Accurate models on demand with progress UI | :yellow_circle: Yellow | Not Started | Store in userData dir. No model ships with installer |
| 12 | Anti-Hallucination Pipeline Review | — | Simplify pipeline for Parakeet TDT (non-autoregressive, less hallucination) | :green_circle: Green | Deferred | Decision: not needed for Parakeet TDT. Can be added as optional adapter-level post-processing hook if future models require it |
| 13 | Keybind Display in UI | — | Show current shortcut in Settings, note about config file for changing | :green_circle: Green | Dropped | Not in approved UI mockups. Users can check GitHub docs if needed |
| 14 | Toolbar: Hexagonal Engine Refactor | #2 | Refactor engine-manager.js with Engine port (transcribe, isAvailable, getHealth) + adapters: RemoteAdapter (HTTP to server), LocalSidecarAdapter (sherpa-onnx CLI subprocess) | :green_circle: Green | Complete | `engine-port.js` (contract), `engine-manager.js` (coordinator), `adapters/{remote-adapter.js, local-sidecar-adapter.js}` created. RemoteAdapter hits new `/v1/models/switch` API. LocalSidecar is stub for Task #10. Auth now required: isAvailable() hits `/v1/models` (authenticated endpoint) |

### Session 2: 2026-02-09 — Welcome Screen Polish + Version Logic

**Completed**: Task #1 finalized (approved)

**Changes**:
- `WelcomeScreen.tsx` (toolbar): Light theme (semantic Tailwind classes, not hardcoded dark), squircle icon, tray notification area guidance, 4 tray state SVG icons (blue/red/yellow/green), version-scoped "don't show again"
- `welcome-main.tsx`: Fetches version dynamically via `app:get-version` IPC (falls back to `'3.0.0'` in browser)
- `main-simple.js`: Welcome logic now version-scoped (`dismissedVersion` instead of `showOnStartup`). Added `app:get-version` IPC handler
- `preload.js`: Added `getAppVersion()` API

**Design Decisions**:
- Welcome screen is always light theme (white background) regardless of toolbar theme
- Header icon is squircle (rounded-[16px]), not circle — matches modern app icon style
- Tray Icon card shows 4 colored squircle mic SVGs with labels: Ready (#4285f4), Rec (#ea4335), Busy (#fbbc04), Done (#34a853)
- Intro text explicitly tells users about the notification area and to drag icon from overflow
- "Don't show again" stores `{ dismissedVersion: "3.0.0-alpha.5" }` — new app version triggers welcome again automatically

**Next**: Tasks 3 (Settings Panel wiring), 8 (Model Switch UX), 9 (Server Status), 6 (Idle Timeout), 7 (Pre-Download Models), 10 (Local CPU sidecar)

---

### Session 1: 2026-02-09 — Hexagonal Architecture Implementation

**Completed Tasks**: 1, 2, 4, 5, 12 (deferred), 13 (dropped), 14

**Files Created**:
- Toolbar: `engine-port.js`, `engine-manager.js`, `adapters/remote-adapter.js`, `adapters/local-sidecar-adapter.js`, `components/WelcomeScreen.tsx`, `welcome.html`, `welcome-main.tsx`
- Server: `ports.py`, `adapters/{__init__.py, websocket_adapter.py, subprocess_adapter.py}`, `docker-compose.v2.2.1.yml`

**Files Modified**:
- Toolbar: `main-simple.js` (engine wiring, welcome integration, bug fixes), `CaptureApp.tsx` (model defaults), `SettingsPanel.tsx` (API key always required), `package.json` (v3.0.0-alpha.5), `vite.config.ts` (welcome entry)
- Server: `bridge.py` (hexagonal refactor, model switch API), `docker-compose.yml` (websocket default), `Dockerfile.bridge` (CUDA + sherpa-onnx), `entrypoint.sh` (MODEL_DIR), `auth-proxy.py` (API keys always required)

**Build Artifacts**: `MVP-Echo Toolbar 3.0.0-alpha.5.exe` (140MB portable)

**Known Issues**:
- SubprocessAdapter fails with sherpa-onnx CLI (`vocab_size` metadata error) — using WebSocketAdapter as default until resolved
- SubprocessAdapter fix options: remove `--model-type=transducer` flag, or use Python sherpa-onnx bindings instead of CLI

**Bug Fixes**:
- `app/main/main-simple.js` (root project): Fixed 4 undefined `whisperEngine` references (should be `engineManager.pythonEngine`)
- `mvp-echo-toolbar/app/main/main-simple.js`: Replaced inline HTML welcome with React component

**API Keys**:
- File: `mvp-stt-docker/api-keys.json`
- Test key: `SK-QUICKTEST` (easy to type, no auth bypass for local IPs anymore)
- 10 random user keys generated (48-char hex)

**Deployment (Server)**:
```bash
# Push updated files to server
rsync -av --delete --exclude='__pycache__' mvp-stt-docker/ root@192.168.1.10:/mnt/user/appdata/mvp-stt-docker/

# Rebuild and restart
ssh root@192.168.1.10
cd /mnt/user/appdata/mvp-stt-docker
docker compose down
docker compose up -d --build
```

**Ready for Next Session**: Tasks 3 (Settings Panel full wiring), 8 (Model Switch UX), 9 (Server Status), 10 (Local CPU sidecar)

---

### Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Docker architecture | Hexagonal (port/adapter) | Future-proof model backends, built-in fallback to current 3-container setup via WebSocketAdapter |
| Local CPU integration | Sidecar process (prebuilt CLI binary) | Avoids Electron native addon ASAR issues, matches existing subprocess pattern, low risk |
| Local CPU model naming | Fast / Balanced / Accurate | Human-readable, conveys speed-vs-quality tradeoff. Replaces tiny/base/small |
| Toolbar engine layer | Hexagonal (port/adapter) | RemoteAdapter + LocalSidecarAdapter behind same interface. No hard-coded whisper-remote.js |
| whisper-remote.js | Replaced by RemoteAdapter | Old file preserved at `mvp-echo-toolbar/app/stt/whisper-remote.js` (no longer imported). RemoteAdapter is the hexagonal replacement |
| Model labels in UI | Brand-free | "English", "English HD", "Multilingual" (GPU) / "Fast", "Balanced", "Accurate" (CPU). No Parakeet/Whisper names shown. Internal IDs: `gpu-english`, `gpu-english-hd`, `gpu-multilingual`, `local-fast`, `local-balanced`, `local-accurate` |
| Auth enforcement | API keys always required | Private IP bypass removed from auth-proxy.py. All requests (except `/health`) require valid API key. Test connection validates auth against `/v1/models` |
| GPU section header | "Industry's Best, Fastest" | Sets expectation: best available GPU models |
| CPU section header | "Industry's Best, No Internet Required" | Sets expectation: best available CPU models, with tradeoff (slower but offline) |
| Welcome screen UI | Approved 2026-02-09 (Session 2) | Light theme (white bg), squircle icon, tray area guidance, 4 state SVGs. Preview: `localhost:5174/welcome.html` |
| Welcome screen theme | Always light (white) | Professional popup feel. Toolbar popup can be dark, welcome is always light |
| Welcome "don't show" | Version-scoped | Stores `dismissedVersion` in `welcome-config.json`. New app version re-triggers welcome automatically |
| Icon shape | Squircle (rounded-[16px]) | Modern app icon style, matches Windows 11 aesthetic. Same shape in header + tray state icons |
| Tray state icons in welcome | 4 states: Ready/Rec/Busy/Done | Blue #4285f4 / Red #ea4335 / Yellow #fbbc04 / Green #34a853. Matches `tray-manager.js` STATES |
| Settings panel UI | Approved 2026-02-09 | `SettingsPanel.tsx` in toolbar project — preview at `popup.html`. Scrollable in 380x300, smart API key detection |

### Test Strategy

| # | Validation |
|---|-----------|
| 1 | Welcome screen renders light theme at 500px, squircle icon visible, tray guidance in intro text, 4 tray state SVGs render, version matches `package.json`, "don't show again" saves `dismissedVersion`, new app version re-shows welcome |
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

## Welcome Screen (Approved — Session 2)

Component: `mvp-echo-toolbar/app/renderer/app/components/WelcomeScreen.tsx`
Preview: `npx vite --port 5174` from `mvp-echo-toolbar/` → `http://localhost:5174/welcome.html`
500px wide, **light theme** (white bg, blue accents), squircle mic icon.

```
┌──────────────────────────────────────────────────────┐
│          [🎤 blue squircle, white mic]               │
│              MVP-Echo Toolbar                        │
│              v3.0.0-alpha.5                          │
│  ─────────────────────────────────────────────────── │
│  A microphone icon has been added to your            │
│  notification area (system tray). You may need to    │
│  drag it from the overflow into the visible section. │
│  Click it to access settings and models.             │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐     │
│  │ 🎙️ Record │  │ 📋 Copy   │  │ 🔵🔴🟡🟢       │     │
│  │ Ctrl+Alt, │  │ Auto-     │  │ Tray Icon      │     │
│  │ tap Z     │  │ clipboard │  │ Changes color   │     │
│  │           │  │           │  │ with status     │     │
│  └──────────┘  └──────────┘  └────────────────┘     │
│                                                      │
│  What's New:                                         │
│  • Industry-leading GPU transcription — under 1s     │
│  • Switch between English, HD, and Multilingual      │
│  • Offline CPU mode — no internet required           │
│                                                      │
│  ☐ Don't show this again          [ Get Started ]    │
└──────────────────────────────────────────────────────┘
```
- Light theme always (white background, dark text, blue primary)
- Squircle icons (rounded square, not circle)
- Tray state icons are colored squircle SVGs with white mic silhouette
- "Don't show again" = version-scoped (re-shows on new app version)
- Version fetched dynamically from `app.getVersion()` via IPC
- No brand names in What's New

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

### Approved UI Components
| Component | Location | Preview | Status |
|-----------|----------|---------|--------|
| WelcomeScreen | `mvp-echo-toolbar/app/renderer/app/components/WelcomeScreen.tsx` | `npx vite --port 5174` from `mvp-echo-toolbar/` → `http://localhost:5174/welcome.html` | Approved Session 2, wired into main-simple.js |
| SettingsPanel | `mvp-echo-toolbar/app/renderer/app/components/SettingsPanel.tsx` | `npx vite --port 5174` from `mvp-echo-toolbar/` → `http://localhost:5174/popup.html` | UI Approved, engine port integration pending |

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
