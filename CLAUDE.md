# CLAUDE.md

## Project Purpose

MVP-Echo is a Windows 11 desktop voice-to-text toolbar using local Whisper models. Privacy-first transcription with no cloud dependencies.

## Core Goals

1. **Local-first**: All transcription runs on-device (CPU or CUDA GPU)
2. **Zero-friction**: Works immediately with native engine, no Python setup required
3. **Privacy**: No telemetry, no cloud, audio never leaves the machine
4. **Windows 11 native**: Designed for Windows 11 with MVP Scale design system

## Tech Stack

- **Desktop**: Electron 28 + React 18 + TypeScript + Vite
- **STT Engine**: Faster-Whisper (Python) with dual-engine architecture
- **Styling**: Tailwind CSS with MVP Scale design system
- **Packaging**: electron-builder (NSIS installer + portable exe)

## Essential Commands

```bash
npm run dev          # Start development (Vite + Electron)
npm run build        # Build frontend
npm run dist         # Package installer + portable exe
```

## Git Workflow

**Branches**: `dev` (daily work) → `main` (clean releases only)

**Daily work**: Commit/push to `dev` normally. No CI runs on dev.

**Release**: Actions → "Release to Main" → enter version (e.g., `v1.1.0`)

**Dev-only files**: Edit `.dev-only` to control what's excluded from `main`.

## Critical Rules

- **Always work on `dev` branch** - main is for releases only
- **Never commit secrets** - no API keys, credentials, or .env files
- **Audio temp files** - always clean up after transcription
- **Dual-engine fallback** - native engine is default, Python engine optional

## Architecture Map

```
app/
  main/       → Electron main process
  renderer/   → React UI (Vite)
  stt/        → Speech-to-text engines
  audio/      → Audio capture utilities
python/       → Whisper service (subprocess)
standalone-whisper/  → PyInstaller build
```

## Reference Documentation

For detailed information, see `.claude/docs/`:
- `project-structure.md` - Complete folder/file explanations
- `development.md` - Setup, commands, workflow details
- `architecture.md` - Technical implementation details

## Path-Specific Rules

See `.claude/rules/` for context-specific guidance:
- `electron.md` - Electron main process patterns
- `react.md` - React/renderer conventions
- `python.md` - Python/Whisper service guidelines
- `stt.md` - STT engine implementation rules
