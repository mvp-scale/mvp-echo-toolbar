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

Binary assets (sherpa-onnx binaries, model files, ffmpeg) are too large for GitHub (>100 MB each) and are excluded from git via `.gitignore`. Builds run locally where these files exist on disk.

1. Build locally: `cd mvp-echo-toolbar && npm run dist`
2. Go to GitHub → Actions → "Release to Main"
3. Click "Run workflow", enter version tag (e.g., `v3.0.2`)
4. After workflow completes, go to Releases → edit the new tag
5. Upload the portable exe from `mvp-echo-toolbar/dist/` as a release asset

Or via CLI:
```bash
# Push code to dev
git push origin dev

# Trigger release (cleans dev → main, strips .dev-only files)
gh workflow run "Release to Main" -f version=v3.0.2

# Delete old release if re-releasing same version
gh release delete v3.0.2 --yes
git push origin --delete v3.0.2

# Re-run workflow, then upload exe
gh workflow run "Release to Main" -f version=v3.0.2
gh release create v3.0.2 "mvp-echo-toolbar/dist/MVP-Echo Toolbar 3.0.2.exe" \
  --title "MVP-Echo Toolbar v3.0.2" --notes "Release notes here"
```

### Build-Time Binary Assets (not in git)

These must exist on disk in `mvp-echo-toolbar/` for `npm run dist` to succeed:

| Directory | Contents | Size |
|-----------|----------|------|
| `sherpa-onnx-bin/` | `MVP-Echo CPU Engine (sherpa-onnx).exe`, DLLs, `ffmpeg.exe` | ~182 MB |
| `sherpa_onnx_models/sherpa-onnx-nemo-parakeet-tdt_ctc-110m-en-int8/` | `model.int8.onnx`, `tokens.txt` | ~126 MB |

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
