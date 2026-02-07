# Development Guide

## Prerequisites

- Node.js 18+
- Git
- (Optional) Python 3.11+ for Python engine
- (Optional) NVIDIA GPU + CUDA for GPU acceleration

## First-Time Setup

```bash
# Clone repository
git clone git@github-mvp:mvp-scale/mvp-echo-toolbar.git
cd mvp-echo-toolbar

# Install dependencies
npm install

# Start development
npm run dev
```

## Development Commands

### Core Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server + Electron |
| `npm run build` | Build frontend (dist/) |
| `npm run pack` | Package portable .exe |
| `npm run dist` | Package NSIS installer + portable |

### Build Commands

| Command | Description |
|---------|-------------|
| `npm run build:standalone` | Build whisper-standalone.exe |
| `npm run prepare` | Alias for build:standalone |
| `npm run clean` | Clean build artifacts |
| `npm run clean:python` | Clean Python environment |

## Development Workflow

### Making Changes

1. **Frontend (React)**: Edit `app/renderer/` - Vite hot-reloads
2. **Main Process**: Edit `app/main/` - Restart Electron
3. **STT Engines**: Edit `app/stt/` - Restart Electron
4. **Python Service**: Edit `python/whisper_service.py` - Restart

### Testing Changes

```bash
# Run dev mode
npm run dev

# Test recording via UI
# Check console for transcription output
```

## Git Workflow

### Daily Development (on `dev` branch)

```bash
# Check current branch
git branch

# Make changes, commit, push
git add -A
git commit -m "your message"
git push
```

### Release to Production

1. Go to GitHub → Actions → "Release to Main"
2. Click "Run workflow"
3. Enter version tag (e.g., `v1.1.0`)
4. Click "Run workflow"

### Versioning Convention

- `v1.0.1` - Patch: bug fixes
- `v1.1.0` - Minor: new features
- `v2.0.0` - Major: breaking changes

## SSH Configuration

This repo uses dedicated SSH keys:

```bash
# SSH alias for mvp-scale account
Host github-mvp
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_mvp

# Clone/push using alias
git clone git@github-mvp:mvp-scale/mvp-echo-toolbar.git
```

## Environment Files

| File | Purpose | Tracked |
|------|---------|---------|
| `.env` | Environment variables | No |
| `.dev-only` | Files excluded from main | Yes |
| `CLAUDE.local.md` | Personal Claude preferences | No |

## Common Issues

### Electron won't start
- Check Node.js version (18+)
- Run `npm install` again
- Delete `node_modules` and reinstall

### Whisper engine fails
- Check if whisper-standalone.exe exists in `whisper-bin/`
- Run `npm run build:standalone` to rebuild

### Audio recording fails
- Check microphone permissions
- Ensure MediaRecorder API is supported
