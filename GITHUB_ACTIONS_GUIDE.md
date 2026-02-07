# GitHub Actions Build Guide

## ✅ You're Ready to Build!

Your MVP-Echo project is now configured to build Windows executables via GitHub Actions.

---

## What GitHub Actions Will Build

| Artifact | Description | Size |
|----------|-------------|------|
| **MVP-Echo-Setup-1.0.0.exe** | NSIS Installer | ~80-120MB |
| **MVP-Echo-Portable-1.0.0.exe** | Portable executable | ~80-120MB |

Both include:
- ✅ Electron runtime
- ✅ React UI (compiled)
- ✅ All app code
- ✅ Python Whisper integration
- ❌ **NOT** included: Whisper models (downloaded on first use ~39MB)

---

## How to Trigger a Build

### Method 1: Manual Trigger (Easiest)

1. Go to your GitHub repository
2. Click **Actions** tab
3. Select **"Build MVP-Echo Windows App"** workflow
4. Click **"Run workflow"** button
5. Select branch: `main`
6. Click **"Run workflow"**

### Method 2: Automatic on Push

Pushes to `main` branch automatically trigger a build:
```bash
git add .
git commit -m "Ready for release"
git push origin main
```

### Method 3: Create a Release Tag

```bash
git tag v1.0.0
git push origin v1.0.0
```
This creates a GitHub Release with the executables attached.

---

## Downloading the Build

### After Workflow Completes (~10-15 minutes)

1. Go to **Actions** tab
2. Click on your workflow run
3. Scroll to **Artifacts** section at the bottom
4. Download:
   - `MVP-Echo-Windows-Installer` (NSIS setup.exe)
   - `MVP-Echo-Windows-Portable` (portable .exe)

---

## What the Workflow Does

```
1. Checkout code from GitHub
   ↓
2. Install Node.js 18
   ↓
3. Install npm dependencies (npm ci)
   ↓
4. Build Vite frontend (npm run build)
   ↓
5. Install Python 3.11
   ↓
6. Install faster-whisper (pip install)
   ↓
7. Build Electron app (npm run dist)
   ├─→ NSIS Installer (.exe with uninstaller)
   └─→ Portable executable (.exe single file)
   ↓
8. Upload artifacts to GitHub
```

---

## Testing the Built Executable

### On Windows:

**NSIS Installer:**
```
1. Download MVP-Echo-Setup-1.0.0.exe
2. Run it
3. Follow installation wizard
4. Launch from Start Menu
5. First run will download Whisper model (~39MB)
```

**Portable:**
```
1. Download MVP-Echo-Portable-1.0.0.exe
2. Double-click to run
3. No installation needed
4. First run will download Whisper model (~39MB)
```

---

## Build Configuration

### Current Settings

- **Target**: Windows x64
- **Code Signing**: Disabled (CSC_IDENTITY_AUTO_DISCOVERY=false)
- **Packaging**: electron-builder
- **Formats**: NSIS installer + Portable exe
- **Auto-publish**: Disabled

### To Enable Code Signing (Optional)

Add to GitHub repository secrets:
- `CSC_LINK`: Path or base64 of certificate
- `CSC_KEY_PASSWORD`: Certificate password

Then update workflow to enable signing.

---

## Troubleshooting

### Build Fails at "npm ci"

- **Issue**: Missing or corrupted package-lock.json
- **Fix**: Commit a fresh package-lock.json from your local machine

### Build Fails at "electron-builder"

- **Issue**: Missing files or configuration error
- **Check**: electron-builder.yml configuration
- **Review**: Build logs in GitHub Actions

### Executable Won't Run

- **Issue**: Windows SmartScreen warning
- **Reason**: Unsigned executable
- **Fix**: Click "More info" → "Run anyway"
- **Long-term**: Get a code signing certificate

### Can't Download Artifacts

- **Issue**: Artifacts expire after 90 days
- **Fix**: Re-run the workflow or create a new build

---

## Current Workflow Files

| File | Purpose |
|------|---------|
| `.github/workflows/build-electron-app.yml` | Builds full Electron app |
| `.github/workflows/build-windows.yml` | Builds whisper-standalone.exe only |

---

## Next Steps After Build

1. ✅ **Download** the artifacts
2. ✅ **Test** on Windows 11
3. ✅ **Verify** Whisper transcription works
4. ✅ **Share** with users or testers
5. 🔄 **Iterate** based on feedback

---

## Ready to Build?

You can trigger a build right now:
```bash
# Commit your changes
git add .
git commit -m "Ready for Windows build via GitHub Actions"
git push origin main

# Then go to GitHub → Actions → wait for build
```

Or manually trigger from GitHub Actions UI! 🚀
