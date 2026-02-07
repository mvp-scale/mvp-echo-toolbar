# Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Electron App                             │
├──────────────────────┬──────────────────────────────────────┤
│   Main Process       │         Renderer Process             │
│   (Node.js)          │         (Chromium)                   │
│                      │                                      │
│   ┌──────────────┐   │   ┌────────────────────────────┐    │
│   │ Engine       │   │   │  React UI                  │    │
│   │ Manager      │◄──┼───│  - RecordingControls       │    │
│   └──────┬───────┘   │   │  - AudioVisualizer         │    │
│          │           │   │  - TranscriptionView       │    │
│   ┌──────▼───────┐   │   │  - StatusBar               │    │
│   │ Native Engine│   │   └────────────────────────────┘    │
│   │ (PyInstaller)│   │                                      │
│   └──────────────┘   │   ┌────────────────────────────┐    │
│          or          │   │  MediaRecorder API         │    │
│   ┌──────────────┐   │   │  (Audio Capture)           │    │
│   │ Python Engine│   │   └────────────────────────────┘    │
│   │ (Subprocess) │   │                                      │
│   └──────────────┘   │                                      │
└──────────────────────┴──────────────────────────────────────┘
```

## Dual-Engine Architecture

### Engine Manager (`app/stt/engine-manager.js`)

Coordinates between two STT engines:

1. **Native Engine** (default)
   - Uses `whisper-standalone.exe` (PyInstaller)
   - No Python installation required
   - Self-contained, works immediately

2. **Python Engine** (optional)
   - Spawns `python/whisper_service.py`
   - Requires system Python 3.11+
   - Better performance, more flexible

### Selection Logic

```
1. Check user preference (engine-config.json)
2. If native preferred → try native engine
3. If native fails → fallback to Python engine
4. If Python fails → show error
```

## Audio Pipeline

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ Microphone  │ →  │ MediaRecorder│ →  │ WebM Blob   │
└─────────────┘    │ API         │    └──────┬──────┘
                   └─────────────┘           │
                                             ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ Transcript  │ ←  │ Whisper     │ ←  │ Temp File   │
│ (JSON)      │    │ Engine      │    │ (.webm)     │
└─────────────┘    └─────────────┘    └─────────────┘
                                             │
                                             ▼
                                       ┌─────────────┐
                                       │ Cleanup     │
                                       │ (delete)    │
                                       └─────────────┘
```

## IPC Communication

### Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `transcribe` | Renderer → Main | Send audio for transcription |
| `transcription-result` | Main → Renderer | Return transcript |
| `get-health` | Renderer → Main | Get GPU/system info |
| `engine-status` | Main → Renderer | Engine state updates |

### Security

- `preload.js` provides secure context bridge
- Renderer cannot access Node.js directly
- All IPC goes through defined channels

## GPU Detection

```javascript
// Uses wmic on Windows
wmic path win32_VideoController get name

// Returns: NVIDIA GeForce RTX 4090, etc.
// Used to determine CUDA availability
```

## Model Management

- Models auto-download via Hugging Face
- Cached in `~/.cache/huggingface/`
- Supported: tiny, base, small
- Default: INT8 quantized for performance

## Component Hierarchy

```
App.tsx
├── RecordingControls     # Start/stop button
│   └── AudioVisualizer   # Real-time levels
├── TranscriptionView     # Display results
├── StatusBar             # System status
├── SetupWizard           # First-run setup
│   └── SetupProgress     # Progress indicator
└── EngineSelector        # Switch engines
```

## Packaging

### Targets

1. **NSIS Installer** - Windows installer with uninstaller
2. **Portable .exe** - Single file, no installation

### Bundle Contents

```
resources/
├── bin/
│   └── whisper-standalone.exe
└── app.asar (frontend bundle)
```

## Implementation Status

### Complete
- Dual-engine STT system
- Audio recording/playback
- Real-time transcription display
- GPU detection
- Windows 11 UI
- NSIS + portable packaging

### Partial
- Model selection UI
- GPU acceleration (CUDA only)
- Error handling

### Not Implemented
- Real-time streaming transcription
- Auto-updater
- Code signing
