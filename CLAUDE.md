# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MVP-Echo is a Windows 11 desktop application for voice-to-text transcription using Whisper models. Built with Electron + React (TypeScript) + Python-based Faster-Whisper engine with optional CUDA GPU acceleration.

## Tech Stack (Actual Implementation)

- **Desktop Framework**: Electron 28.0.0
- **Frontend**: React 18.2.0 + TypeScript + Vite 5.0.12
- **AI Runtime**: Faster-Whisper (Python) with dual-engine architecture:
  - **Native Engine**: PyInstaller-built standalone executable (whisper-standalone.exe) - works immediately, no Python install needed
  - **Python Engine**: System Python subprocess running faster-whisper - better performance, requires Python setup
  - **GPU Support**: CUDA acceleration via PyTorch (when available), CPU fallback with INT8 quantization
- **Audio Processing**: MediaRecorder API (WebM format), saved to temp files for processing
- **Styling**: Tailwind CSS 3.4.1 with "MVP Scale" design system
- **Packaging**: electron-builder 26.0.12 with NSIS installer and portable exe targets
- **Target Platform**: Windows 11 (primary)
- **Build Automation**: GitHub Actions for compiling standalone executable

## Development Commands

```bash
# Development
npm install                # Install dependencies
npm run dev                # Start Vite (port 5173) + Electron in dev mode
npm run dev:portable       # Dev mode with portable Python environment

# Building
npm run build              # Build Vite frontend (dist/)
npm run build:standalone   # Build whisper-standalone.exe with PyInstaller
npm run prepare            # Alias for build:standalone (runs automatically)

# Packaging
npm run pack               # Package portable .exe (no installer)
npm run dist               # Package NSIS installer + portable .exe

# Utilities
npm run clean              # Clean Python embedded distribution
npm run clean:python       # Clean Python environment
npm test                   # Run tests (not yet implemented)
```

## GitHub Actions Build Process

The project uses GitHub Actions to automatically build the standalone whisper executable:

**Workflow File**: `.github/workflows/build-windows.yml`

**Triggers**:
- **Push to main**: When files in `standalone-whisper/` directory change
- **Pull Requests**: When PRs modify `standalone-whisper/` files
- **Manual Trigger**: Via GitHub UI (workflow_dispatch)

**Build Process**:
1. Sets up Python 3.11 on windows-latest runner
2. Installs dependencies from `standalone-whisper/requirements.txt`
3. Runs PyInstaller with optimized settings:
   - Bundles faster-whisper, torch, ctranslate2, onnxruntime
   - Creates single executable: `whisper-standalone.exe`
   - Optimizes with `--optimize=2` flag
4. Tests the executable with `--version` flag
5. Uploads artifact as `whisper-standalone-windows`
6. (Optional) Creates GitHub release if tag starts with `v`

**To manually trigger the build**:
1. Go to GitHub repository → Actions tab
2. Select "Build Windows Executable" workflow
3. Click "Run workflow" button → select branch → Run
4. Download artifact from workflow run page after completion

## Project Structure (Actual)

```
app/
  main/                      # Electron main process
    main-simple.js           # Main entry point (used in production)
    main.ts                  # Alternative TypeScript entry point
    init-manager.js          # Initialization manager
    python-manager.ts        # Portable Python environment manager
    setup-manager.js         # Setup wizard backend

  renderer/                  # React UI (Vite-powered)
    index.html              # HTML entry point
    app/
      App.tsx               # Full-featured app component
      App-simple.tsx        # Simplified app variant
      main.tsx              # React entry point
      components/           # 9 React components
        AudioVisualizer.tsx
        EngineSelector.tsx
        OceanVisualizer.tsx
        RecordingControls.tsx
        SetupProgress.tsx
        SetupWizard.tsx
        StatusBar.tsx
        TranscriptionView.tsx

  audio/                     # Audio processing utilities
    recorder.ts             # MediaRecorder API wrapper
    wav.ts                  # WAV/PCM format utilities
    bell.mp3                # Audio feedback sound

  stt/                       # Speech-to-text engine (Hybrid Architecture)
    engine-manager.js       # Coordinates between native/Python engines
    whisper-engine.js       # Python subprocess engine
    whisper-native.js       # PyInstaller executable engine
    onnx-whisper.js         # ONNX stub (not actively used)
    pipeline.ts             # Audio processing pipeline
    session.ts              # ONNX session stub
    health.ts               # GPU/CPU detection
    features.ts             # Audio preprocessing
    model-downloader.ts     # Model download manager
    types.ts                # TypeScript type definitions
    mock-implementation.ts  # Mock engine for testing

  preload/
    preload.js              # IPC security bridge

  models/
    manifest.json           # Model metadata (for ONNX - not used)

python/
  whisper_service.py        # Python Whisper service (subprocess)

standalone-whisper/         # PyInstaller build for native engine
  whisper-cli.py           # CLI implementation
  requirements.txt         # Python dependencies
  build.sh / build.ps1     # Build scripts
  README.md                # Build documentation

scripts/                    # Build automation scripts
  build-native-whisper.sh  # Build PyInstaller executable
  prepare-python.ps1       # Python environment setup
  download-models.ps1      # Model downloader
  dev.ps1                  # Development launcher
  (15 total scripts)

.github/
  workflows/
    build-windows.yml      # GitHub Actions CI/CD

dist/                       # Vite build output (gitignored)
whisper-bin/               # Built executables (gitignored)
  whisper-standalone.exe

package.json               # Node.js dependencies and scripts
electron-builder.yml       # Electron packaging configuration
vite.config.ts            # Vite build configuration
tsconfig.json             # TypeScript configuration
tailwind.config.js        # Tailwind CSS configuration
```

## Key Implementation Guidelines

### Dual-Engine Architecture
The application uses a **hybrid approach** with two STT engines:

1. **Native Engine** (`whisper-native.js`):
   - Uses standalone `whisper-standalone.exe` built with PyInstaller
   - Works immediately without Python installation required
   - Self-contained with faster-whisper bundled
   - Stored in `whisper-bin/` directory
   - Default engine for immediate functionality

2. **Python Engine** (`whisper-engine.js`):
   - Spawns `python/whisper_service.py` as subprocess
   - Requires system Python 3.11+ with faster-whisper installed
   - Better performance and flexibility
   - Optional upgrade path from native engine

3. **Engine Manager** (`engine-manager.js`):
   - Coordinates between engines based on availability
   - Saves user preference in `engine-config.json`
   - Handles fallback on failures
   - Provides unified API to renderer process

### GPU Support
- **CUDA Acceleration**: Via PyTorch when NVIDIA GPU available
- **CPU Fallback**: INT8 quantization for performance
- **Detection**: Uses `wmic` on Windows to detect GPU hardware
- **Status Display**: Shows current engine and compute mode in UI
- Note: DirectML NOT implemented (documentation described it, but faster-whisper uses CUDA instead)

### Model Management
- Models downloaded automatically by faster-whisper on first use
- Cached in Hugging Face cache directory (`~/.cache/huggingface/`)
- Supports tiny, base, small Whisper models
- Quantized INT8 models used by default
- Future: Model selection UI planned but not yet implemented

### Audio Pipeline
1. **Capture**: MediaRecorder API in renderer (WebM format)
2. **Transfer**: ArrayBuffer sent via IPC to main process
3. **Storage**: Saved to temporary file in OS temp directory
4. **Processing**: File path passed to active engine
5. **Transcription**: Engine returns JSON with transcript
6. **Cleanup**: Temp files deleted immediately after processing
7. **Display**: Result shown in TranscriptionView component

### IPC Communication
- **Main Process**: Handles all inference via spawned Python processes
- **Renderer Process**: Captures audio, displays results
- **IPC Bridge**: `preload.js` provides secure context bridge
- **Error Handling**: Graceful fallback and user-friendly error messages
- **Non-blocking**: UI remains responsive during processing

### UI Architecture
- **Framework**: React 18.2.0 with functional components and hooks
- **Styling**: Tailwind CSS with "MVP Scale" design system
- **Theme**: Electric blue accents (`oklch(0.55 0.25 264)`)
- **Components**:
  - RecordingControls: Start/Stop recording with visual feedback
  - AudioVisualizer: Real-time audio level display
  - TranscriptionView: Shows transcription results
  - StatusBar: System status and GPU/CPU info
  - SetupWizard: First-run configuration
  - EngineSelector: Switch between native/Python engines
- **Global Shortcuts**: Ctrl+Alt+Z to start/stop recording
- **Export**: TXT and Markdown format support

### Packaging & Distribution
- **Targets**:
  - NSIS installer (installable .exe with uninstaller)
  - Portable .exe (single file, no installation)
- **Size**: Installer ~50-80MB (excluding models)
- **Bundling**:
  - Standalone whisper executable included in `resources/bin/`
  - Frontend bundled in ASAR archive
  - No Python runtime in installer (uses system Python for Python engine)
- **electron-builder**: Configured in `electron-builder.yml`
- **Code Signing**: Not yet implemented (instructions needed)
- **Auto-updater**: Not yet implemented

## Development Workflow

1. **Setup**: `npm install` to install Node.js dependencies
2. **Development**: `npm run dev` starts Vite dev server + Electron
3. **Test Recording**: Use UI to test audio capture and transcription
4. **Build Native Engine**: `npm run build:standalone` creates whisper-standalone.exe
5. **Package**: `npm run pack` creates portable .exe or `npm run dist` for installer
6. **Test Distribution**: Test packaged app on fresh Windows 11 VM

### First-Time Setup
- Install Node.js 18+
- Clone repository
- Run `npm install`
- (Optional) Build standalone whisper: `npm run build:standalone`
- (Optional) Install Python 3.11+ and faster-whisper for Python engine

### Making Changes
- **Frontend Changes**: Edit files in `app/renderer/`, Vite hot-reloads automatically
- **Main Process Changes**: Edit `app/main/`, restart Electron (Ctrl+C, `npm run dev` again)
- **STT Engine Changes**: Edit `app/stt/`, restart Electron
- **Python Service Changes**: Edit `python/whisper_service.py`, rebuild if using native engine

## Current Implementation Status

### ✅ Implemented
- Electron + React architecture with TypeScript
- Dual-engine STT system (Native PyInstaller + Python subprocess)
- Audio recording with MediaRecorder API
- Real-time transcription display
- GPU detection (NVIDIA/AMD/Intel via wmic)
- Windows 11 themed UI with MVP Scale design
- Export to TXT and Markdown
- Global keyboard shortcuts (Ctrl+Alt+Z)
- NSIS installer and portable .exe packaging
- GitHub Actions build automation for standalone executable

### 🔄 Partially Implemented
- Model selection (downloads automatically, no UI picker yet)
- GPU acceleration (CUDA only, not DirectML)
- Error handling (basic implementation, needs improvement)

### ❌ Not Implemented (vs Original Documentation)
- ONNX Runtime with DirectML (used faster-whisper instead)
- First-run model download UI with progress
- Code signing for installer
- Auto-updater functionality
- Comprehensive test suite
- Real-time streaming transcription (currently processes complete recording)

## Testing Requirements

### Current State
- **Unit Tests**: Not implemented (`npm test` shows "No tests yet")
- **Integration Tests**: Not implemented
- **Manual Testing**: Active development approach

### Recommended Testing
- Manual testing on Windows 11 with NVIDIA GPU
- Manual testing on Windows 11 without GPU (CPU mode)
- Test both Native and Python engines
- Test portable .exe on fresh Windows 11 VM
- Test NSIS installer with installation/uninstallation
- Performance testing with different model sizes (tiny, base, small)

## Important Notes

- **Architecture Divergence**: The actual implementation uses Python-based faster-whisper, NOT ONNX Runtime with DirectML as described in setup.md. This was a pragmatic decision for faster development.
- **No Telemetry**: No analytics or telemetry implemented
- **Minimal Logging**: Console logs only, no persistent log files
- **Scope Management**: Focus on core transcription functionality, avoid feature creep
- **Code Quality**: TypeScript strict mode enabled, Tailwind for consistent styling
- **Windows 11 First**: Primary target is Windows 11, though may work on Windows 10
- **Model Storage**: Models cached by Hugging Face library, not in app directory
- **Temp Files**: Audio temp files cleaned up after each transcription

## GitHub Actions CI/CD

The project uses GitHub Actions to automate building the standalone whisper executable:

### Workflow: `build-windows.yml`
- **Location**: `.github/workflows/build-windows.yml`
- **Purpose**: Builds `whisper-standalone.exe` using PyInstaller on Windows
- **Triggers**:
  - Push to main (when `standalone-whisper/` files change)
  - Pull requests (when `standalone-whisper/` files change)
  - Manual dispatch (via GitHub UI)

### Output
- **Artifact Name**: `whisper-standalone-windows`
- **File**: `whisper-standalone.exe` (~150-200MB single executable)
- **Location**: Downloaded from GitHub Actions artifacts

### Manual Build Locally
```bash
cd standalone-whisper
pip install -r requirements.txt
# On Windows:
.\build.ps1
# On Linux/Mac:
bash build.sh
```

## Dependencies

### Node.js Dependencies (package.json)
- **Runtime**: react, react-dom
- **Dev**: electron, vite, typescript, tailwindcss, electron-builder, concurrently

### Python Dependencies (standalone-whisper/requirements.txt)
- faster-whisper >= 1.0.0
- ctranslate2 >= 4.0
- torch >= 2.0.0
- huggingface_hub, tokenizers
- onnxruntime >= 1.14 (CPU version)
- av >= 11
- pyinstaller >= 6.0.0