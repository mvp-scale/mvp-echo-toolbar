# MVP-Echo Toolbar — Roadmap & Task Tracker

**Version**: `v3.0.4`
**Branch**: `dev`
**Updated**: 2026-02-14 (Session 7)
**License**: Apache 2.0

---

## Session 7: 2026-02-14 — Recording Countdown Timer + Transparent Build Process

**Goal**: Prevent server rejection of long recordings (sherpa-onnx 300s default limit) by adding a visual countdown + auto-stop. Establish transparent CI build process for open-source compliance.

**Recording Countdown Timer**:
- 1-minute warning: popup appears at 9:00 (540s) with red countdown that brightens as time runs out
- Warble alert sound (660 Hz sine + 8 Hz LFO vibrato, 1.2s) plays when countdown begins — distinct from completion ding
- Auto-stop at 9:50 (590s) with 10s buffer before 10-min server limit
- Auto-stopped recordings process normally: transcribed, copied to clipboard, completion ding plays
- Popup stays visible during countdown (blur handler guarded with `countdownActive` flag)
- Manual stop during countdown clears everything cleanly
- Browser preview at `localhost:5173/popup.html` auto-simulates 60→0 countdown loop for styling

**Transparent Build Process (Open-Source Compliance)**:
- Large binaries (ffmpeg 163MB, ONNX Runtime 14MB, sherpa-onnx 2.3MB, Parakeet model 126MB) can't be committed to GitHub (100MB limit)
- Solution: hosted as release asset at `build-deps-v0.0.0` (164MB zip, pre-release)
- CI workflow downloads and extracts before `npm run dist` — fully reproducible, auditable build
- This pattern is standard for open-source projects needing large binary deps in CI

**Server Change**:
- Added `--max-utterance-length=600` to sherpa-onnx WebSocket server launch command in `managed_ws_adapter.py`

**Files Created** (Session 7):
- `app/renderer/app/audio/warning-sound.ts` — 6 sound variants (V1-V6), warble (V6) selected as default

**Files Modified** (Session 7):
- `app/renderer/app/CaptureApp.tsx` — countdown interval, `performStop()` helper, timing constants
- `app/renderer/app/PopupApp.tsx` — `CountdownDisplay` component (red with intensity ramp + glow), browser auto-simulation
- `app/preload/preload.js` — `sendCountdownUpdate` + `onCountdownUpdate` IPC channels
- `app/main/main-simple.js` — `countdownActive` flag, `countdown:update` IPC handler, popup blur guard
- `mvp-stt-docker/adapters/managed_ws_adapter.py` — `--max-utterance-length=600`
- `.github/workflows/build-electron-app.yml` — downloads build deps from `build-deps-v0.0.0` release
- `package.json` — version bumped to 3.0.4

**Releases Created**:
- `build-deps-v0.0.0` (pre-release) — build dependency zip (164MB): sherpa-onnx-bin/ + parakeet model
- `v3.0.4` (latest) — MVP-Echo Toolbar 3.0.4.exe (264MB portable)

**Countdown Timing Constants** (in CaptureApp.tsx):
| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_RECORDING_S` | 600s (10 min) | Server limit |
| `COUNTDOWN_START_S` | 540s (9 min) | Show countdown + play warble |
| `AUTO_STOP_S` | 590s (9:50) | Auto-stop recording |

**Countdown IPC Flow**:
```
CaptureApp (hidden window) → sendCountdownUpdate() → ipcMain 'countdown:update'
  → creates/shows popup → forwards 'countdown-update' → PopupApp CountdownDisplay
```

---

## Session 6: 2026-02-12 — Open-Source Licensing + v3.0.3 Release

**Goal**: Prepare repository for open-source community with proper licensing.

**Changes**:
- Switched from MIT to Apache 2.0 license
- Added NOTICE file with project description and attribution
- Added THIRD-PARTY-NOTICES with dependency attributions
- Fixed `package.json` license field from `MIT` to `Apache-2.0`
- Released v3.0.3

---

## Session 5: 2026-02-11 — Local CPU Integration + UI Finalization

**Goal**: Ship v3.0.2 with pre-baked Fast (110m) local CPU model and finalized settings UI.

**UI Changes Finalized**:
- SettingsPanel redesigned: 2 GPU models (English 99% / Multilingual 97%), 1 local CPU model (English 80%)
- Quality/Speed/Rating columns added (99% <300ms ⭐⭐⭐⭐⭐, 97% <500ms ⭐⭐⭐⭐, 80% <2s ⭐⭐½)
- Rating dots changed from yellow to blue for visibility
- GPU section header: "Hosted GPU — Industry's Best, Fastest"
- Default model: English (isDefault flag in GPU_MODEL_MAP)
- State indicators: green dot (loaded), orange pulse (switching), hollow (available)
- Endpoint URL and API key hide when local CPU selected

**Critical Finding: Renderer-Based Audio Processing Not Viable**

Attempted two approaches for WebM→WAV conversion in the renderer, both crashed Electron's hidden window on Windows with `ACCESS_VIOLATION` exit code `-1073741819`:

1. **AudioContext.decodeAudioData()** after recording → crash within 1-2s
2. **ScriptProcessorNode** during recording → crash within 200ms of starting

Exit code `0xC0000005` = native crash in Chromium's audio subsystem. Not fixable with try-catch or code changes.

**Solution: ffmpeg in Main Process**

- Renderer sends WebM over IPC (works, confirmed stable)
- Main process writes WebM to temp file
- If local adapter active: spawn `ffmpeg.exe -i input.webm -ar 16000 -ac 1 output.wav`
- Pass WAV to sherpa-onnx
- Clean up both temp files

**Build Size Impact**:
- ffmpeg LGPL static build: 163 MB
- Total installer: 228 MB → 391 MB (Electron + model + sherpa + ffmpeg)
- Well under 2 GB NSIS limit

**Files Created** (Session 5):
- `app/main/logger.js` — centralized logging for main process (all logs go to debug file)
- `app/renderer/app/audio/webm-to-wav.ts` — deleted (not viable)

**Files Modified** (Session 5, ready for build):
- `app/main/main-simple.js` — uses centralized logger, crash detection, 30s tray timeout
- `app/stt/engine-manager.js` — ffmpeg conversion for local path, centralized logging
- `app/stt/adapters/{remote-adapter.js, local-sidecar-adapter.js}` — centralized logging
- `app/stt/local-model-manager.js` — simplified to single pre-baked model, centralized logging
- `app/renderer/app/audio/AudioCapture.ts` — reverted to MediaRecorder-only (no ScriptProcessor crash)
- `app/renderer/app/CaptureApp.tsx` — reverted to send WebM only
- `app/renderer/app/components/SettingsPanel.tsx` — UI finalized, GPU_MODEL_MAP includes full display props
- `package.json` — v3.0.2, extraResources includes Fast model only
- `sherpa-onnx-bin/ffmpeg.exe` — added (163 MB, LGPL build, will be code-signed)

**Next Build Will Include**:
1. Centralized logging (all engine logs visible in debug file)
2. ffmpeg WebM→WAV conversion for local CPU path
3. GPU model stats display correctly (quality/speed/rating)
4. Default to English on fresh install
5. Blue rating dots (visible on dark background)
6. Renderer crash detection + tray safety timeout

**Test Plan for v3.0.2**:
1. Fresh install (clear AppData Roaming)
2. Verify defaults to GPU English
3. GPU English + Multilingual transcriptions
4. Switch to Local CPU, verify transcription works
5. Verify all logs appear in `%TEMP%\mvp-echo-toolbar-debug.log`
6. Check installer size (~391 MB expected)

---

## Roadmap: v3.0 — Model Management + UX Overhaul

### Task Table

| # | Task | Depends On | Goal | Confidence | Status | Notes |
|---|------|-----------|------|------------|--------|-------|
| 1 | Welcome Screen Redesign | — | Light theme, squircle icon, tray guidance, version-scoped dismiss, 4 tray state icons | :green_circle: Green | Approved (Session 2) | Light theme (white bg, blue accents). Squircle mic icon (rounded-[16px]). Intro text guides users to notification area / system tray. Tray Icon card shows 4 state icons (ready/recording/processing/done) as colored squircle SVGs. "Don't show again" is version-scoped: stores `dismissedVersion` in `welcome-config.json`, re-shows on new version. Version fetched dynamically via `app:get-version` IPC. Preview: `npx vite --port 5174` from `mvp-echo-toolbar/` → `http://localhost:5174/welcome.html` |
| 2 | Remove Faster-Whisper Model References | — | Replace stale model entries with new brand-free IDs | :green_circle: Green | Complete | All Systran/deepdml refs replaced with `gpu-english` etc. in: `whisper-remote.js`, `CaptureApp.tsx`, `SettingsPanel.tsx` |
| 3 | Settings Panel: Engine/Model Dropdown | #2, #14 | GPU Server (2 models) + Local CPU (3 models) with status indicators | :green_circle: Green | UI Approved | Component: `mvp-echo-toolbar/app/renderer/app/components/SettingsPanel.tsx`. Preview: `http://localhost:5174/popup.html`. Brand-free labels, API key smart detection, scrollable in 380x300 popup. English HD removed (1.1b model doesn't exist). Integration with engine port pending |
| 4 | Server: Hexagonal Architecture (Bridge Refactor) | — | Refactor bridge.py with ModelEngine port + adapter pattern. ManagedWebSocketAdapter (default) + SubprocessAdapter + WebSocketAdapter (legacy) | :green_circle: Green | Complete | `ports.py` + 3 adapters created. ManagedWebSocketAdapter is production default: manages C++ WebSocket server as subprocess inside bridge container, enabling model switching. SubprocessAdapter has CLI incompatibility. WebSocketAdapter (legacy, single-model) behind `profiles: ["legacy"]` in compose |
| 5 | Server: Model Switch API | #4 | `POST /v1/models/switch` — port calls adapter to swap model. `GET /v1/models` returns loaded + available | :green_circle: Green | Complete | Built into bridge.py v3.0. Confirmed working with ManagedWebSocketAdapter: kills subprocess, restarts with new model, ready in ~5s. Tested on production server (Session 3) |
| 6 | Server: Idle Timeout / Auto-Unload | #4 | Unload model after 60min idle, reload on next request (~5-10s cold start) | :green_circle: Green | Not Started | Timer reset on every transcription. Configurable via env var. Implemented at port level |
| 7 | Server: Pre-Download All GPU Models | #4 | Download all 2 Parakeet TDT models on first start (~1.3GB total) | :green_circle: Green | Complete | entrypoint.sh downloads both models to shared volume. 1.1b removed (no sherpa-onnx conversion on HuggingFace). Verified on production server: 631MB + 641MB |
| 8 | Toolbar: Model Switch UX | #3, #5, #14 | User picks model → "Switching..." status → ready in 5-10s | :green_circle: Green | Not Started | Engine manager calls switch via RemoteAdapter, polls until ready |
| 9 | Toolbar: Server Status in Settings | #5, #14 | Show loaded model, idle time, model states (loaded/sleeping/available) | :green_circle: Green | Not Started | RemoteAdapter polls `/v1/models` and `/health` |
| 10 | Local CPU Engine (sherpa-onnx sidecar) | #14 | Bundle prebuilt sherpa-onnx CLI binary + Fast model pre-baked in installer | :green_circle: Green | In Progress | Sidecar approach validated (Session 4). Binary works, Fast model transcribes accurately. Requires WebM→WAV conversion (ffmpeg or AudioContext). Ship Fast model pre-baked (~126 MB), no download step needed |
| 11 | Local CPU: Model Download Manager | #10 | Download Balanced model on demand with progress UI | :yellow_circle: Yellow | Descoped | Only Balanced (624 MB) would need download. Fast ships pre-baked. Accurate (1.1b) is broken — ONNX runtime incompatibility |
| 12 | Anti-Hallucination Pipeline Review | — | Simplify pipeline for Parakeet TDT (non-autoregressive, less hallucination) | :green_circle: Green | Deferred | Decision: not needed for Parakeet TDT. Can be added as optional adapter-level post-processing hook if future models require it |
| 13 | Keybind Display in UI | — | Show current shortcut in Settings, note about config file for changing | :green_circle: Green | Dropped | Not in approved UI mockups. Users can check GitHub docs if needed |
| 14 | Toolbar: Hexagonal Engine Refactor | #2 | Refactor engine-manager.js with Engine port (transcribe, isAvailable, getHealth) + adapters: RemoteAdapter (HTTP to server), LocalSidecarAdapter (sherpa-onnx CLI subprocess) | :green_circle: Green | Complete | `engine-port.js` (contract), `engine-manager.js` (coordinator), `adapters/{remote-adapter.js, local-sidecar-adapter.js}` created. RemoteAdapter hits new `/v1/models/switch` API. LocalSidecar is stub for Task #10. Auth now required: isAvailable() hits `/v1/models` (authenticated endpoint) |

### Session 3: 2026-02-10 — Managed WebSocket Adapter + 1.1b Removal

**Completed**: Task #5 (verified), #7 (verified), new ManagedWebSocketAdapter, 1.1b model cleanup

**Problem**: The WebSocket adapter connected to a separate `mvp-asr` container running the C++ server, but that server only loads one model at startup with no API for switching. The 1.1b "English HD" model doesn't exist as a sherpa-onnx conversion on HuggingFace.

**Solution**: Created `ManagedWebSocketAdapter` that runs the C++ WebSocket server as a subprocess *inside* the bridge container. Model switching = kill subprocess, restart with new model paths.

**Files Created**:
- `mvp-stt-docker/adapters/managed_ws_adapter.py` — new adapter combining subprocess model scanning + WebSocket transcription protocol
- `mvp-stt-docker/README.md` — stack documentation with architecture, files, adapters, history
- `mvp-stt-docker/SHERPA-ONNX-GPU-GUIDE.md` — guide for running sherpa-onnx on GPU in Docker

**Files Modified**:
- `mvp-stt-docker/bridge.py` — added `managed-websocket` to adapter factory, removed 1.1b from MODEL_METADATA
- `mvp-stt-docker/adapters/__init__.py` — added ManagedWebSocketAdapter export
- `mvp-stt-docker/adapters/subprocess_adapter.py` — removed 1.1b from KNOWN_MODELS
- `mvp-stt-docker/docker-compose.yml` — `ADAPTER_TYPE=managed-websocket`, `mvp-asr` behind `profiles: ["legacy"]`
- `mvp-stt-docker/entrypoint.sh` — removed 1.1b from MODELS array
- `app/renderer/app/components/SettingsPanel.tsx` — removed English HD from mock models
- `app/renderer/app/components/WelcomeScreen.tsx` — "English and Multilingual" (was "English, HD, and Multilingual")

**Deployment**:
```bash
rsync -av --delete --exclude='__pycache__' mvp-stt-docker/ root@192.168.1.10:/mnt/user/appdata/mvp-stt-docker/
ssh root@192.168.1.10 "cd /mnt/user/appdata/mvp-stt-docker && docker compose down && docker compose up -d --build --no-cache"
```

**Verified on server**:
- Model switching works (English <-> Multilingual)
- `mvp-asr` no longer starts by default (was consuming 426MB VRAM unnecessarily)
- 1.1b empty directory removed from Docker volume

**Next**: Tasks 3 (Settings Panel wiring to live data), 6 (Idle Timeout), 8 (Model Switch UX), 9 (Server Status), 10 (Local CPU sidecar)

---

### Session 4: 2026-02-11 — Local CPU Model Validation

**Goal**: Validate whether sherpa-onnx local CPU models are worth integrating into the toolbar.

**Test Setup**: Built `mvp-sherpa-demo/` — Node.js server + HTML page for isolated model testing. Downloaded native Linux sherpa-onnx binary (v1.12.23) for testing. Used ffmpeg to convert test audio (51.2s M4A recording) to 16kHz mono WAV.

**Results** (on Linux dev machine, 4 threads):

| Model | File | Size | Time | RTF | Punctuation | Capitalization | Quality |
|-------|------|------|------|-----|-------------|----------------|---------|
| **Fast (110m)** | `parakeet-tdt_ctc-110m-en-int8` | 126 MB | **1.35s** | 0.026 | Yes | Yes | Good — got "Corey", proper sentences |
| **Balanced (0.6b)** | `parakeet-ctc-0.6b-en-int8` | 624 MB | **3.38s** | 0.066 | No | No | Decent — missed "Corey" → "coy", no punctuation |
| **Accurate (1.1b)** | `parakeet-tdt_ctc-1.1b-en-int8` | 1.1 GB | **BROKEN** | — | — | — | ONNX runtime error: node name mismatch in self_attn layer |

**Key Findings**:
1. **Fast (110m) is the clear winner** — fastest, has punctuation + capitalization, best name recognition
2. **Balanced (0.6b) is worse** — 2.5x slower, no punctuation/caps, worse on proper nouns
3. **Accurate (1.1b) is broken** — `Ort::Exception` during initialization, incompatible with sherpa-onnx v1.12.23 ONNX runtime
4. **sherpa-onnx only accepts WAV** — toolbar records WebM (MediaRecorder API). Integration requires WebM→WAV conversion via ffmpeg or browser AudioContext before passing to sherpa-onnx
5. **Audio format is the only remaining integration blocker** — the model loads, transcribes accurately, and is fast enough for short utterances

**Decision**: Ship only the **Fast (110m) model pre-baked** in the toolbar installer (~126 MB added to build size). No download step — it's already there when the user installs. Remove Balanced and Accurate from the UI. When user selects "Local CPU", it just works.

**Integration TODO** (for next session):
1. Add WebM→WAV conversion in `processAudio` pipeline (ffmpeg bundled, or AudioContext decode in renderer)
2. `local-sidecar-adapter.js` — already written and working (Session 4), just needs the audio format fix
3. `local-model-manager.js` — simplify to just locate the pre-baked Fast model (no download logic needed)
4. `SettingsPanel.tsx` — remove Balanced/Accurate rows, Fast shows as "available" (no download badge since it's pre-baked)
5. `package.json` build config — bundle only `sherpa-onnx-bin/` (~18 MB) + Fast model (~126 MB). Total build size increase: ~144 MB
6. `electron-builder.yml` or `package.json` `extraResources` — add the two directories

**Files Created** (Session 4, in toolbar project):
- `mvp-echo-toolbar/app/stt/adapters/local-sidecar-adapter.js` — full Engine Port implementation, spawns sherpa-onnx-offline.exe
- `mvp-echo-toolbar/app/stt/local-model-manager.js` — model registry + path resolution (needs simplification for pre-baked approach)
- `mvp-echo-toolbar/mvp-sherpa-demo/server.js` — isolated test server (not for production)
- `mvp-echo-toolbar/mvp-sherpa-demo/index.html` — test UI (not for production)

**Files Modified** (Session 4, rolled back — re-apply in next session):
- `engine-manager.js` — added `local:download-model` IPC handler (change to simpler activation since pre-baked)
- `preload.js` — added `local:download-model`, `local:cancel-download` to valid channels + `on`/`removeListener` for progress events
- `SettingsPanel.tsx` — updated sizes, wired download, hid endpoint/apikey when local active
- `package.json` — added `extraResources` for models + binary

**Assets on disk** (not committed — hosted at GitHub release `build-deps-v0.0.0`):
- `mvp-echo-toolbar/sherpa-onnx-bin/` — Windows binaries (181 MB): `MVP-Echo CPU Engine (sherpa-onnx).exe`, `ffmpeg.exe`, `onnxruntime.dll`, `onnxruntime_providers_shared.dll`, `sherpa-onnx-c-api.dll`, `cargs.dll`
- `sherpa_onnx_models/sherpa-onnx-nemo-parakeet-tdt_ctc-110m-en-int8/` — Fast model (126 MB): `model.int8.onnx`, `tokens.txt`
- CI downloads these automatically from `build-deps-v0.0.0` release during build

**Build Notes**:
- electron-builder portable target uses NSIS internally — fails with `mmap` error on payloads >2 GB. Keep total under 2 GB or use zip of `win-unpacked/`
- `package.json` `"build"` section overrides `electron-builder.yml` when both exist. Put all config in `package.json`
- The root project `package.json` is NOT the toolbar — always edit `mvp-echo-toolbar/package.json`
- **CI build deps**: Large binaries (ffmpeg, onnxruntime, sherpa-onnx, model) are hosted at GitHub release `build-deps-v0.0.0`. The build workflow downloads them before packaging. To update deps: create a new zip, upload to a new release tag (e.g., `build-deps-v0.0.1`), update workflow reference
- **Build artifact**: v3.0.4 = 264 MB portable exe (Electron + sherpa-onnx-bin + Parakeet 110m model)
- **Node version**: CI uses Node 18. Some deps warn about wanting Node 20+ (`@electron/rebuild`, `minimatch`) but build succeeds. Consider bumping to Node 20 when convenient

---

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
| Model labels in UI | Brand-free | "English", "Multilingual" (GPU) / "Fast", "Balanced", "Accurate" (CPU). No Parakeet/Whisper names shown. Internal IDs: `gpu-english`, `gpu-multilingual`, `local-fast`, `local-balanced`, `local-accurate` |
| Auth enforcement | API keys always required | Private IP bypass removed from auth-proxy.py. All requests (except `/health`) require valid API key. Test connection validates auth against `/v1/models` |
| GPU section header | "Industry's Best, Fastest" | Sets expectation: best available GPU models |
| CPU section header | "Industry's Best, No Internet Required" | Sets expectation: best available CPU models, with tradeoff (slower but offline) |
| Welcome screen UI | Approved 2026-02-09 (Session 2) | Light theme (white bg), squircle icon, tray area guidance, 4 state SVGs. Preview: `localhost:5174/welcome.html` |
| Welcome screen theme | Always light (white) | Professional popup feel. Toolbar popup can be dark, welcome is always light |
| Welcome "don't show" | Version-scoped | Stores `dismissedVersion` in `welcome-config.json`. New app version re-triggers welcome automatically |
| Icon shape | Squircle (rounded-[16px]) | Modern app icon style, matches Windows 11 aesthetic. Same shape in header + tray state icons |
| Tray state icons in welcome | 4 states: Ready/Rec/Busy/Done | Blue #4285f4 / Red #ea4335 / Yellow #fbbc04 / Green #34a853. Matches `tray-manager.js` STATES |
| Settings panel UI | Approved 2026-02-09 | `SettingsPanel.tsx` in toolbar project — preview at `popup.html`. Scrollable in 380x300, smart API key detection |
| Default adapter | ManagedWebSocketAdapter | Runs C++ WebSocket server as subprocess inside bridge container. Model stays in GPU memory, switching by restart. Eliminates need for separate mvp-asr container |
| 1.1b model removal | Removed | `parakeet-tdt-1.1b-v2-int8` doesn't exist as a sherpa-onnx conversion on HuggingFace. Removed from all configs, UI, and model lists. 2 GPU models remain (English 0.6b-v2, Multilingual 0.6b-v3) |
| mvp-asr container | Behind legacy profile | `profiles: ["legacy"]` in docker-compose.yml. Only starts with `--profile legacy`. Saves 426MB VRAM |
| Local CPU: ship only Fast | Pre-bake Fast (110m) model | Tested all 3: Fast wins on speed (1.35s), quality (punctuation, caps, names), and size (126 MB). Balanced is 2.5x slower with worse output. Accurate is broken (ONNX runtime error). No download UI needed — just works |
| Local CPU: audio format | WebM→WAV conversion required | sherpa-onnx only accepts WAV (RIFF). Toolbar records WebM. Must convert before passing to sherpa-onnx. Options: bundle ffmpeg (~40 MB) or use AudioContext in renderer to decode + write WAV header in main process |
| Local CPU: build config | Use package.json "build" section | `electron-builder.yml` is ignored when `package.json` has a `"build"` key. All extraResources go in `package.json`. NSIS portable fails >2 GB — keep build lean |
| Recording countdown | 1-minute red countdown at 9:00, auto-stop at 9:50 | Simple and urgent — no amber/orange phase, just red brightening. Popup force-shows and stays visible during countdown |
| Warning sound | Warble (V6): 660 Hz sine + 8 Hz LFO vibrato | Tested 6 variants. Warble is distinct from completion ding (880 Hz sine), attention-getting without being annoying. 1.2s duration |
| Server max utterance | 600s (10 min) | `--max-utterance-length=600` added to sherpa-onnx launch. Default was 300s which caused HTTP 500 on long recordings |
| License | Apache 2.0 | Switched from MIT (Session 6). NOTICE file added for attribution |
| Build deps hosting | GitHub release assets | Large binaries (>100MB) can't be committed. Hosted at `build-deps-v0.0.0` pre-release. CI downloads during build. Standard open-source pattern, transparent and auditable |
| Build transparency | Release-hosted deps + public CI | Required for open-source certification. All deps are publicly downloadable, build workflow is in repo, no private artifacts |

### Test Strategy

| # | Validation |
|---|-----------|
| 1 | Welcome screen renders light theme at 500px, squircle icon visible, tray guidance in intro text, 4 tray state SVGs render, version matches `package.json`, "don't show again" saves `dismissedVersion`, new app version re-shows welcome |
| 2 | No references to `Systran/faster-whisper-*` or `deepdml/faster-whisper-*` remain in codebase |
| 3 | Dropdown shows correct engine/model list, states reflect server reality via engine port |
| 4 | bridge.py starts with SubprocessAdapter, transcription works end-to-end. Switch to WebSocketAdapter, same test passes against 3-container setup |
| 5 | `curl POST /v1/models/switch` changes model, subsequent transcriptions use new model |
| 6 | After 60min idle, ASR process stopped (check with `ps`). Next request triggers reload, returns result |
| 7 | Both models present in volume after first start. `GET /v1/models` lists both (English + Multilingual) |
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
│      sherpa-onnx    │                   │  ├─ ManagedWebSocketAdapter     │
│      CLI binary     │                   │  │   (default: C++ WS server    │
│      (offline)      │                   │  │    as subprocess, GPU,        │
│                     │                   │  │    model switching)           │
│                     │                   │  ├─ SubprocessAdapter            │
│                     │                   │  │   (sherpa-onnx CLI per file)  │
│                     │                   │  └─ WebSocketAdapter (legacy)    │
│                     │                   │      (separate mvp-asr container)│
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
| `gpu-english` | English | Recommended | `parakeet-tdt-0.6b-v2-int8` | English | 631MB | ~426MB |
| `gpu-multilingual` | Multilingual | 25 languages | `parakeet-tdt-0.6b-v3-int8` | 25 languages | 641MB | ~426MB |

### Local CPU — Industry's Best, No Internet Required

| ID (internal) | Label in UI | Size | Speed (tested) | Quality | Status |
|---------------|-------------|------|---------------|---------|--------|
| `local-fast` | Fast | 126 MB | **1.35s / 51s audio** (RTF 0.026) | Good — punctuation, capitalization, proper nouns | **Pre-baked in installer** |
| `local-balanced` | Balanced | 624 MB | 3.38s / 51s audio (RTF 0.066) | Decent — no punctuation/caps, worse on names | Available but not shipped |
| `local-accurate` | Accurate | 1.1 GB | BROKEN | ONNX runtime incompatibility with sherpa-onnx v1.12.23 | **Removed** |

**Strategy change (Session 4)**: Fast model ships pre-baked in installer (~126 MB). No download step needed. Balanced available as future option. Accurate removed entirely.
No brand names (Parakeet, Whisper, etc.) shown in UI — hexagonal adapter means we always show the best the industry has.

**CLI invocation** (same for all models):
```
sherpa-onnx-offline.exe --nemo-ctc-model=model.int8.onnx --tokens=tokens.txt --num-threads=4 audio.wav
```
**Requires WAV input** (16kHz mono 16-bit PCM). Toolbar records WebM — conversion needed in pipeline.

---

## Dropdown UX Design (Approved)

Integrated into toolbar popup SettingsPanel (380x300, scrollable).

```
Engine & Model
─────────────────────────────────────────
GPU SERVER — INDUSTRY'S BEST, FASTEST
  ⚡ English            [recommended]  ● loaded
  ⚡ Multilingual                      ○ available
─────────────────────────────────────────
LOCAL CPU — INDUSTRY'S BEST, NO INTERNET
  💻 Fast (126 MB)                     ○ available

States:  ● loaded  |  ○ available  |  ⏳ switching
```

Selecting a GPU model that's "available" → "Switching model (~10s)..." → done.
Selecting Local CPU Fast → switches to local adapter, instant (pre-baked, no download).
When local model active: endpoint URL, API key, and connection status are hidden (not needed).
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
│  • Switch between English and Multilingual            │
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
| `app/renderer/app/PopupApp.tsx` | Popup layout + countdown display | CountdownDisplay component, browser simulation |
| `app/renderer/app/CaptureApp.tsx` | Hidden capture window + countdown timer | Countdown interval, auto-stop, warning sound |
| `app/renderer/app/audio/warning-sound.ts` | Warning sound variants | Warble (V6) is default, 5 other variants available |
| `app/renderer/app/audio/completion-sound.ts` | Completion ding (880 Hz sine) | Plays after transcription copied to clipboard |
| `app/stt/engine-manager.js` | Engine orchestrator | #14: refactor to Engine port with adapter selection |
| `app/stt/whisper-native.js` | Local subprocess engine | #14: replace with LocalSidecarAdapter |
| `app/stt/whisper-engine.js` | Python subprocess engine | #14: remove (deprecated with Faster-Whisper) |
| `app/stt/adapters/remote-adapter.js` | NEW: HTTP client to server | #14: implements Engine port for remote server |
| `app/stt/adapters/local-sidecar-adapter.js` | NEW: sherpa-onnx CLI subprocess | #14: implements Engine port for local CPU |

### Docker Server (mvp-stt-docker/)
| File | Purpose | Status |
|------|---------|--------|
| `docker-compose.yml` | Service definitions (managed-websocket default, mvp-asr behind legacy profile) | Current |
| `docker-compose.v2.2.1.yml` | Archived v2.2.1 compose (pre-hexagonal). Remove before release to main | Archive |
| `bridge.py` | HTTP API + ModelEngine port + adapter factory | Current |
| `ports.py` | ModelEngine ABC (5 methods) | Current |
| `adapters/managed_ws_adapter.py` | Default: manages C++ WS server subprocess, model switching | Current |
| `adapters/subprocess_adapter.py` | sherpa-onnx CLI per file (has CLI incompatibility) | Fallback |
| `adapters/websocket_adapter.py` | Relays to separate mvp-asr container (legacy, no switching) | Legacy |
| `entrypoint.sh` | Bridge entrypoint: downloads 2 models from HuggingFace | Current |
| `entrypoint-asr.sh` | Legacy ASR container entrypoint | Legacy |
| `auth-proxy.py` | Auth middleware | Current |
| `README.md` | Stack documentation | Current |
| `SHERPA-ONNX-GPU-GUIDE.md` | Guide for running sherpa-onnx on GPU in Docker | Reference |

### CI/CD (.github/workflows/)
| File | Purpose | Status |
|------|---------|--------|
| `build-electron-app.yml` | Build Windows portable exe (manual trigger) | Current — downloads deps from `build-deps-v0.0.0` release |
| `clean-release.yml` | Release to Main: merges dev→main, strips `.dev-only` files, tags version | Current |
| `build-windows.yml` | Build standalone-whisper exe (legacy, triggers on main push to standalone-whisper/) | Legacy |

### GitHub Releases
| Tag | Type | Purpose |
|-----|------|---------|
| `v3.0.4` | Latest | Current production release (264MB portable exe) |
| `build-deps-v0.0.0` | Pre-release | Build dependencies: sherpa-onnx-bin/ + Parakeet model (164MB zip) |
| `v3.0.3` | Release | Open-source licensing (Apache 2.0) |
| `v3.0.2` | Release | Local CPU integration + UI finalization |

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
  -d '{"model_id":"parakeet-tdt-0.6b-v3-int8"}' | jq .
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
- **Toolbar port**: 20300 (mvp-auth → mvp-bridge w/ managed WS subprocess)
- **Studio port**: 20301 (mvp-scribe, NeMo container)
- **GPU**: NVIDIA RTX 3090 Ti, 24GB VRAM (Tower) / 3080 Ti, 12GB (original)
- **sherpa-onnx**: v1.12.23 C++ binaries
