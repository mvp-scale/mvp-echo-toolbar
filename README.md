# MVP-Echo

A Windows 11 voice-to-text transcription application using Whisper models via ONNX Runtime.

## 🚀 Quick Start (MVP)

### Prerequisites
- Node.js 18+ 
- Windows 11
- Git

### Run MVP
```powershell
# Clone and setup
git clone [your-repo-url]
cd mvp-echo
npm install

# Start development
npm run dev
# OR
./scripts/dev.ps1
```

This will:
- Start the Vite dev server on http://localhost:5173
- Build and watch the Electron main process
- Launch the MVP-Echo application

## 🎯 MVP Features

✅ **Visual MVP Ready**
- [x] Beautiful MVP Scale UI with electric blue accents
- [x] Recording controls with visual feedback
- [x] Audio level visualization with pulse animation
- [x] Mock transcription for testing workflow
- [x] Responsive design (works when minimized)
- [x] Dark/light theme support

✅ **Core Architecture**
- [x] Electron main/renderer separation
- [x] IPC communication setup
- [x] TypeScript throughout
- [x] Tailwind CSS with MVP Scale design system

🔄 **Next Iterations** (Feature by Feature)
- [ ] Real audio recording with MediaRecorder API
- [ ] ONNX Runtime integration
- [ ] GPU detection and fallback
- [ ] Model management system
- [ ] Export functionality (TXT/MD)
- [ ] Settings panel
- [ ] First-run model download

## 📁 Project Structure

```
mvp-echo/
├── app/
│   ├── main/           # Electron main process
│   ├── renderer/       # React UI
│   ├── audio/          # Audio processing (TODO)
│   ├── stt/           # Speech-to-text engine (TODO)
│   └── models/        # Model management
├── docs/              # Documentation
├── scripts/           # Build scripts
└── styleGuide/        # MVP Scale design system (read-only)
```

## 🎨 Design System

Uses the existing MVP Scale design system from `styleGuide/`:
- Electric blue primary color: `oklch(0.55 0.25 264)`
- Clean whites and grays for light theme
- Dark navy background for dark theme
- Recording pulse animation
- Hover effects with blue border glow

## 🔧 Development

```powershell
# Development mode
npm run dev

# Build for production
npm run build

# Package as Windows app
npm run pack:win

# Run tests
npm test

# Type checking
npm run typecheck
```

## 📋 MVP Test Checklist

- [ ] App launches successfully
- [ ] UI is responsive (try minimizing/restoring)
- [ ] Recording button changes state (Start ↔ Stop)
- [ ] Audio visualizer animates during "recording"
- [ ] Mock transcription appears after ~2 seconds
- [ ] Status bar shows system info
- [ ] Theme matches system preference
- [ ] Electric blue accents visible throughout

## 🚧 Known MVP Limitations

- Audio recording is mocked (no actual MediaRecorder yet)
- Transcription is random text (no real STT engine yet)
- Export buttons are disabled (functionality TODO)
- No settings panel (TODO)
- No model management (TODO)

**This is intentional** - the MVP focuses on visual feedback and architecture validation before adding complex features.

## 🔄 Next Development Phase

1. **Real Audio Recording**: Implement MediaRecorder API in renderer
2. **STT Integration**: Add ONNX Runtime with Whisper models
3. **GPU Detection**: DirectML provider setup with CPU fallback
4. **Model Download**: First-run experience with progress tracking

## 📞 Getting Help

- Check `docs/architecture_rfc.md` for technical details
- Review `docs/DetailedPRD.md` for full feature specifications
- Each agent has detailed docs in `.claude/agents/` folder