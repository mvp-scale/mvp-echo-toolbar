# Project Structure

## Root Directory

```
mvp-echo-toolbar/
├── app/                    # Main application code
├── python/                 # Python Whisper service
├── standalone-whisper/     # PyInstaller build for native engine
├── scripts/                # Build and utility scripts
├── docs/                   # User-facing documentation
├── html-mockups/           # UI prototypes (dev-only)
├── .claude/                # Claude Code configuration
├── .github/                # GitHub Actions workflows
├── package.json            # Node.js dependencies
├── electron-builder.yml    # Packaging configuration
├── vite.config.ts          # Vite build config
└── tailwind.config.js      # Tailwind CSS config
```

## app/ - Application Code

```
app/
├── main/                   # Electron main process
│   ├── main-simple.js      # Main entry point (production)
│   ├── main.ts             # TypeScript entry (dev)
│   ├── init-manager.js     # Initialization orchestrator
│   ├── python-manager.ts   # Python environment manager
│   ├── setup-manager.js    # Setup wizard backend
│   └── preload.ts          # Preload script
│
├── renderer/               # React UI (Vite-powered)
│   ├── index.html          # HTML entry point
│   └── app/
│       ├── App.tsx         # Root component
│       ├── main.tsx        # React entry point
│       ├── components/     # React components
│       │   ├── RecordingControls.tsx
│       │   ├── AudioVisualizer.tsx
│       │   ├── TranscriptionView.tsx
│       │   ├── StatusBar.tsx
│       │   ├── SetupWizard.tsx
│       │   ├── SetupProgress.tsx
│       │   ├── EngineSelector.tsx
│       │   └── OceanVisualizer.tsx
│       └── styles/
│           └── globals.css
│
├── stt/                    # Speech-to-text engines
│   ├── engine-manager.js   # Coordinates native/Python engines
│   ├── whisper-native.js   # PyInstaller executable engine
│   ├── whisper-engine.js   # Python subprocess engine
│   ├── health.ts           # GPU/CPU detection
│   ├── model-downloader.ts # Model download manager
│   └── types.ts            # TypeScript definitions
│
├── audio/                  # Audio processing
│   ├── recorder.ts         # MediaRecorder wrapper
│   ├── wav.ts              # WAV/PCM utilities
│   └── bell.mp3            # Audio feedback
│
└── preload/
    └── preload.js          # IPC security bridge
```

## python/ - Whisper Service

```
python/
└── whisper_service.py      # Python subprocess for transcription
                            # Used by whisper-engine.js
                            # Requires system Python 3.11+
```

## standalone-whisper/ - Native Engine Build

```
standalone-whisper/
├── whisper-cli.py          # CLI implementation
├── requirements.txt        # Python dependencies
├── build.ps1 / build.sh    # Build scripts
├── venv/                   # Python venv (gitignored)
├── build/                  # PyInstaller build (gitignored)
└── dist/                   # Output executables (gitignored)
```

## scripts/ - Build Automation

```
scripts/
├── build-standalone.ps1    # Build whisper-standalone.exe
├── prepare-python.ps1      # Setup Python environment
├── download-models.ps1     # Download Whisper models
├── dev.ps1                 # Development launcher
└── (other utility scripts)
```

## .github/workflows/ - CI/CD

```
.github/workflows/
├── clean-release.yml       # Release to Main workflow
├── build-windows.yml       # Build standalone whisper
└── build-electron-app.yml  # Build Electron app
```

## Generated Directories (gitignored)

- `dist/` - Vite build output
- `node_modules/` - Node.js dependencies
- `whisper-bin/` - Built whisper executables
- `standalone-whisper/venv/` - Python virtual environment
- `standalone-whisper/build/` - PyInstaller build artifacts
- `standalone-whisper/dist/` - PyInstaller output
