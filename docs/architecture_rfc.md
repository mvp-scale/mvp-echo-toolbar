# MVP-Echo Architecture RFC v1.0

**Status**: Draft  
**Author**: Lead_Architect Agent  
**Date**: December 2024  
**Reviewers**: STT_Engineer, UI_Designer, Windows_Packager, QA_Reviewer  

## Overview

MVP-Echo is a Windows 11 desktop application for real-time voice-to-text transcription using Whisper models via ONNX Runtime. This RFC defines the system architecture, component boundaries, and technical decisions for the project.

## Architecture Goals

1. **Separation of Concerns**: Clear boundaries between audio, AI, and UI components
2. **Non-blocking UI**: Heavy processing isolated from renderer thread  
3. **Fail-safe GPU Detection**: Graceful fallback to CPU without crashes
4. **Maintainable**: Simple, readable, modular code
5. **Windows-First**: Optimized for Windows 11 experience

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        MVP-Echo Application                      │
├─────────────────────────────────────────────────────────────────┤
│                    Electron Main Process                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │     IPC     │  │   Model     │  │   Update    │             │
│  │  Handlers   │  │ Management  │  │   System    │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │     STT     │  │    Audio    │  │    File     │             │
│  │   Engine    │  │ Processing  │  │   System    │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
├─────────────────────────────────────────────────────────────────┤
│                   Electron Renderer Process                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │    React    │  │     UI      │  │    Audio    │             │
│  │    App      │  │ Components  │  │  Capture    │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
└─────────────────────────────────────────────────────────────────┘
```

## Component Design

### 1. Main Process Components

#### 1.1 STT Engine (`app/stt/`)
**Purpose**: ONNX Runtime integration with GPU/CPU providers

```typescript
// app/stt/session.ts
export interface STTSession {
  session: ort.InferenceSession;
  mode: "GPU-DirectML" | "CPU";
  modelSize: "tiny" | "base" | "small";
}

export async function createSession(modelPath: string): Promise<STTSession>
export async function runInference(session: STTSession, audio: Float32Array): Promise<TranscriptionResult>
```

**Key Responsibilities**:
- ONNX Runtime session management
- GPU detection with CPU fallback
- Model loading and cleanup
- Inference execution

#### 1.2 Audio Processing (`app/audio/`)
**Purpose**: Audio format handling and preprocessing

```typescript
// app/audio/wav.ts
export function convertToWav(audioBuffer: ArrayBuffer): ArrayBuffer
export function preprocessAudio(audioData: Float32Array): Float32Array
export function generateMelSpectrogram(audio: Float32Array): Float32Array
```

#### 1.3 IPC Layer (`app/main/ipc.ts`)
**Purpose**: Communication between main and renderer processes

```typescript
// IPC Channels
const IPC_CHANNELS = {
  AUDIO_DATA: 'audio-data',
  TRANSCRIPTION_RESULT: 'transcription-result',
  GPU_STATUS: 'gpu-status',
  MODEL_LOAD: 'model-load',
  SETTINGS_UPDATE: 'settings-update'
} as const;
```

### 2. Renderer Process Components

#### 2.1 React Application (`app/renderer/`)
**Purpose**: UI components using MVP Scale design system

```typescript
// app/renderer/app/App.tsx
export function App() {
  return (
    <ThemeProvider>
      <RecordingControls />
      <AudioVisualizer />
      <TranscriptionView />
      <SettingsPanel />
    </ThemeProvider>
  );
}
```

#### 2.2 Audio Capture (`app/renderer/audio/`)
**Purpose**: MediaRecorder API integration

```typescript
// Renderer process audio capture
export class AudioCapture {
  async startRecording(): Promise<void>
  async stopRecording(): Promise<ArrayBuffer>
  getAudioLevel(): number
}
```

## Data Flow

### Recording & Transcription Flow

```
1. User clicks Record
   ↓
2. Renderer: Start MediaRecorder
   ↓
3. Audio data chunks → IPC → Main Process
   ↓
4. Main: Audio preprocessing (WAV conversion)
   ↓
5. Main: STT inference (GPU/CPU)
   ↓
6. Main: Results → IPC → Renderer
   ↓
7. Renderer: Update UI with transcription
```

### Model Management Flow

```
1. First run: Show model selection dialog
   ↓
2. Download model with progress (SHA256 verify)
   ↓
3. Store in %LOCALAPPDATA%/MVP-Echo/models/
   ↓
4. Load model into ONNX session
   ↓
5. GPU detection → fallback if needed
   ↓
6. Ready for transcription
```

## Technical Decisions

### 1. Technology Stack
- **Electron**: Desktop framework (latest stable)
- **React + TypeScript**: UI with type safety
- **Vite**: Fast build tool and dev server
- **ONNX Runtime**: AI inference with DirectML
- **Tailwind CSS**: Styling framework
- **shadcn/ui**: Component library (from styleGuide)

### 2. Model Storage Strategy
- **Location**: `%LOCALAPPDATA%/MVP-Echo/models/`
- **Format**: ONNX optimized for Windows DirectML
- **Sizes**: tiny (~40MB), base (~140MB), small (~240MB)
- **Verification**: SHA256 checksums mandatory
- **Download**: Resumable downloads with progress

### 3. GPU Acceleration
```typescript
// Provider priority order
const providers = [
  "DmlExecutionProvider",  // DirectML (GPU)
  "CPUExecutionProvider"   // CPU fallback
];
```

### 4. IPC Communication
- **Pattern**: Request/Response for operations, Events for streaming
- **Channels**: Type-safe channel definitions
- **Error Handling**: Standardized error propagation
- **Security**: Context isolation enabled

## File Structure

```
mvp-echo/
├── app/
│   ├── main/                 # Electron main process
│   │   ├── main.ts          # Entry point
│   │   ├── ipc.ts           # IPC handlers
│   │   └── updater.ts       # Auto-updater
│   ├── renderer/            # React UI
│   │   ├── index.html
│   │   ├── main.tsx
│   │   └── app/
│   │       ├── App.tsx
│   │       ├── components/
│   │       ├── hooks/
│   │       └── styles/
│   ├── audio/               # Audio processing
│   │   ├── recorder.ts
│   │   └── wav.ts
│   ├── stt/                 # STT engine
│   │   ├── session.ts
│   │   ├── pipeline.ts
│   │   ├── features.ts
│   │   └── health.ts
│   └── models/              # Model management
│       └── manifest.json
├── docs/                    # Documentation
├── tests/                   # Test files
├── scripts/                 # Build scripts
├── packaging/               # Icons, assets
├── styleGuide/             # Design system (read-only)
└── .claude/agents/         # Agent documentation
```

## Dependencies

### Production Dependencies
```json
{
  "electron": "^28.0.0",
  "react": "^18.2.0",
  "react-dom": "^18.2.0",
  "onnxruntime-node": "^1.16.0",
  "@radix-ui/react-*": "latest",
  "class-variance-authority": "^0.7.0",
  "tailwindcss": "^3.3.0"
}
```

### Development Dependencies
```json
{
  "electron-builder": "^24.0.0",
  "vite": "^5.0.0",
  "typescript": "^5.0.0",
  "@types/react": "^18.2.0",
  "eslint": "^8.0.0",
  "prettier": "^3.0.0"
}
```

## Security Considerations

1. **Context Isolation**: Enabled in renderer process
2. **Node Integration**: Disabled in renderer
3. **Preload Script**: Secure IPC bridge
4. **Model Verification**: SHA256 checksums required
5. **No Remote Content**: All resources bundled or local
6. **Minimal Permissions**: Only required system access

## Performance Requirements

| Metric | Target | Measurement |
|--------|---------|-------------|
| App Startup | < 3s | Time to ready state |
| Model Load | < 2s | ONNX session creation |
| Recording Start | < 200ms | MediaRecorder to ready |
| GPU Inference | < 1s | 30s audio processing |
| CPU Inference | < 5s | 30s audio processing |
| Memory Usage | < 500MB | Peak during operation |

## Error Handling Strategy

1. **GPU Failures**: Automatic CPU fallback with user notification
2. **Model Loading**: Clear error messages with retry options
3. **Audio Issues**: Device detection and switching support
4. **Network Errors**: Graceful handling with offline mode
5. **File System**: Proper permissions and path validation

## Testing Strategy

1. **Unit Tests**: Critical algorithms and utilities
2. **Integration Tests**: IPC communication and workflow
3. **E2E Tests**: Complete user scenarios
4. **Hardware Tests**: Various GPU configurations
5. **Performance Tests**: Benchmarking on target hardware

## Deployment Architecture

1. **Build**: Electron-builder with NSIS installer
2. **Signing**: Code signing certificate for trust
3. **Distribution**: GitHub releases with update feed
4. **Models**: Separate download, not in installer
5. **Updates**: Electron-updater for automatic updates

## Open Questions

1. **Model Provider**: Host models on GitHub releases or CDN?
2. **Update Frequency**: Automatic daily checks or manual?
3. **Telemetry**: Crash reporting without personal data?
4. **Licensing**: Model usage and distribution rights?

## Next Steps

1. **STT_Engineer**: Implement `app/stt/session.ts` with GPU detection
2. **UI_Designer**: Create React components using styleGuide
3. **Windows_Packager**: Set up electron-builder configuration
4. **QA_Reviewer**: Define test plan and acceptance criteria

## Approval

- [ ] STT_Engineer: Technical feasibility approved
- [ ] UI_Designer: UI architecture and styleGuide integration approved  
- [ ] Windows_Packager: Build and packaging approach approved
- [ ] QA_Reviewer: Testing strategy and quality gates approved

---

**This RFC serves as the foundation for MVP-Echo development. All implementation should align with these architectural decisions.**