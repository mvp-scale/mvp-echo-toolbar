# CRITICAL: aOa Search Override

**ALWAYS use `aoa grep` instead of Grep/Glob tools.**

`aoa grep` and `aoa egrep` work like Unix grep/egrep but use O(1) indexed search (10-100x faster). Results include `file:func[range]:line` — use [range] to read only relevant code.

See `.aoa/USAGE.md` for details.

---
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

**Dev-only files**: Edit `.dev-only` to control what's excluded from `main`.

**NEVER cherry-pick commits to main** — always use the "Release to Main" workflow.
The workflow handles the dev→main sync correctly by force-pushing a cleaned
version of dev. Manual cherry-picking breaks this flow.

### Release Process

The "Release to Main" workflow (Actions → Run workflow) is fully automatic:
1. Reads the version from `mvp-echo-toolbar/package.json`
2. Checks that the `v{version}` tag doesn't already exist (fails early if it does)
3. Cleans dev-only files, force-pushes to main, creates the tag

**Before releasing**: Bump the version in `mvp-echo-toolbar/package.json`.
Keep the root `package.json` version in sync. If you forget, the workflow
will fail because the tag already exists.

**Version lives in**: `mvp-echo-toolbar/package.json` (canonical).
The workflow reads from this file. The root `package.json` should match.

**No rebuild needed** for notebook-only or docs-only changes. The build
workflow (`build-electron-app.yml`) is a separate manual trigger.

## Critical Rules

- **NEVER commit or push without explicit user approval** - always show the user what changed and wait for them to say "commit" or "check it in". Do not auto-commit after writing code. The user must review changes before anything is committed.
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
