# MVP-Echo v1.1.0 - Work In Progress

**Date**: 2025-11-24/25
**Goal**: Create two versions of MVP-Echo - Light (cloud) and Standard (local)
**Status**: Light version 80% complete, needs cloud transcription integration

---

## ✅ What's Been Completed

### 1. Cloud STT Infrastructure (100%)

**Created**: `/home/corey/projects/faster-whisper-docker/`

**Docker Setup**:
- ✅ Using `fedirz/faster-whisper-server:latest-cuda` (production-ready)
- ✅ NGINX reverse proxy for CORS support
- ✅ Multi-model support (tiny, base, small, medium, large-v3, 170+ models)
- ✅ Dynamic model loading (downloads on-demand from HuggingFace)
- ✅ GPU acceleration working (RTX 3090 Ti on Unraid)
- ✅ Endpoint: `http://192.168.1.10:20300/v1/audio/transcriptions`

**Files**:
```
faster-whisper-docker/
├── docker-compose.yml       # fedirz + nginx proxy
├── nginx.conf               # CORS configuration
├── sync-to-unraid.sh        # Sync script
├── deploy-to-unraid.sh      # Full deployment
└── README.md                # Documentation
```

**Deployment**:
- Runs on Unraid at 192.168.1.10:20300
- GPU mode active (CPU fallback if needed)
- Models persistent in Docker volume
- Health endpoint: `/health`
- Models list: `/v1/models`

**Performance**:
- CPU mode: ~800-900ms per transcription
- GPU mode: ~100-400ms per transcription (3-8x faster)

---

### 2. UI Design & Testing (100%)

**Created Functional Test Page**: `/home/corey/projects/mvp-echo/html-mockups/v1.1-functional.html`

**Features Validated**:
- ✅ Endpoint configuration UI (URL, API key)
- ✅ Model selector (tiny, base, small, medium, large-v3)
- ✅ Language selector
- ✅ Test Connection button
- ✅ Connection status indicators
- ✅ Real audio recording via browser MediaRecorder
- ✅ Actual transcription from cloud endpoint
- ✅ Model switching works (tested with all 4 models)
- ✅ Footer-based settings panel (expands/collapses)

**Tested**: Successfully transcribed audio using all 4 models via Unraid endpoint.

---

### 3. Directory Structure (100%)

**Created Separated Folders**:

```
mvp-echo/
├── mvp-echo-light/                 ← LIGHT VERSION (in progress)
│   ├── app/
│   │   ├── main/main-simple.js     ✅ Updated for cloud (no local whisper)
│   │   ├── renderer/
│   │   │   ├── index.html          ✅ CSP updated for external endpoints
│   │   │   └── app/
│   │   │       └── App.tsx         ✅ v1.1 UI with cloud settings
│   │   ├── stt/
│   │   │   └── whisper-remote.js   ✅ Created (not integrated yet)
│   │   └── preload/preload.js
│   ├── package.json                ✅ name: mvp-echo-light
│   ├── dist/
│   │   └── MVP-Echo Light 1.1.0.exe  ✅ Built (140MB portable)
│   └── README.md                   ✅ Light documentation
│
├── mvp-echo-standard/              ← STANDARD VERSION (copied, not modified yet)
│   ├── app/                        📋 Has all v1.0.0 code
│   └── package.json                ✅ name: mvp-echo-standard
│
└── faster-whisper-docker/          ✅ Cloud endpoint (deployed on Unraid)
```

---

## 🚧 Current Status: Light Version

### What's Working ✅

**UI & Configuration**:
- ✅ Footer shows "v1.1.0 Light • ☁️ Cloud • model: base"
- ✅ ⚙️ Settings button opens cloud configuration panel
- ✅ Endpoint URL input (with default: http://192.168.1.10:20300...)
- ✅ API Key input
- ✅ Model selector dropdown (tiny, base, small, medium, large-v3)
- ✅ Language selector
- ✅ Test Connection button UI
- ✅ Connection status indicators (Testing... / Connected ✓ / Not configured)
- ✅ CSP allows external endpoints
- ✅ No init:check errors
- ✅ No whisperEngine errors

### What's NOT Working Yet ❌

**Critical Missing**:
- ❌ **Test Connection doesn't actually work** (CSP still blocking? Need to verify)
- ❌ **Recording doesn't use cloud endpoint** (still tries local whisper)
- ❌ **No cloud transcription integration** (whisper-remote.js created but not wired)
- ❌ **Main process doesn't have cloud engine** (needs IPC handlers)

**Latest Build Issues**:
```
Console errors on Windows:
1. CSP still refusing connection (despite connect-src *)
2. "Failed to fetch" when clicking Test Connection
```

---

## 🔧 What Needs to Be Done Next

### Priority 1: Fix CSP & Test Connection

**Problem**: CSP still blocking despite `connect-src *`

**Solutions to try**:
1. Remove CSP entirely for Light version (it's for cloud, needs external access)
2. Or use more permissive CSP: `connect-src * data: blob:`
3. Check if meta tag is being overridden somewhere

**File**: `mvp-echo-light/app/renderer/index.html:5`

---

### Priority 2: Integrate Cloud Transcription

**File**: `mvp-echo-light/app/main/main-simple.js`

**Needs**:
1. Load `whisper-remote.js`
2. Create IPC handler for cloud transcription
3. Update `engine:process-audio` to use cloud endpoint

**Implementation**:
```javascript
// In main-simple.js
const WhisperRemoteEngine = require('../stt/whisper-remote.js');
const cloudEngine = new WhisperRemoteEngine();

ipcMain.handle('engine:process-audio', async (event, audioPath) => {
  try {
    const result = await cloudEngine.transcribe(audioPath, {
      model: cloudEngine.selectedModel,
      language: cloudEngine.language
    });
    return result;
  } catch (error) {
    throw error;
  }
});

// Add cloud configuration IPC handlers
ipcMain.handle('cloud:configure', async (event, config) => {
  return await cloudEngine.configure(config.endpointUrl, config.apiKey, config.model);
});

ipcMain.handle('cloud:test-connection', async () => {
  return await cloudEngine.testConnection();
});

ipcMain.handle('cloud:get-config', () => {
  return cloudEngine.getConfig();
});
```

---

### Priority 3: Wire Test Connection Button

**File**: `mvp-echo-light/app/renderer/app/App.tsx`

**Update `handleTestConnection` function** (around line 269):
```typescript
const handleTestConnection = useCallback(async () => {
  if (!endpointUrl) {
    alert('Please enter an endpoint URL first!');
    return;
  }

  setConnectionStatus('testing');

  try {
    // Use IPC to test from main process (avoids CSP)
    const result = await (window as any).electronAPI.invoke('cloud:test-connection');

    if (result.success) {
      setConnectionStatus('connected');
      setCurrentModelDisplay(selectedModel.split('/').pop() || 'base');
      alert(`Connected! ${result.modelCount} models available`);
    } else {
      alert('Connection failed: ' + result.error);
      setConnectionStatus('disconnected');
    }
  } catch (error: any) {
    alert('Connection failed: ' + error.message);
    setConnectionStatus('disconnected');
  }
}, [endpointUrl, selectedModel]);
```

**Also add config save on change**:
```typescript
// Save config when values change
useEffect(() => {
  if (isElectron) {
    (window as any).electronAPI.invoke('cloud:configure', {
      endpointUrl,
      apiKey,
      model: selectedModel,
      language: selectedLanguage
    });
  }
}, [endpointUrl, apiKey, selectedModel, selectedLanguage]);
```

---

### Priority 4: Update Preload Bridge

**File**: `mvp-echo-light/app/preload/preload.js`

**Add to validChannels** (around line 35):
```javascript
const validChannels = [
  // Existing channels...
  'engine:status', 'engine:switch', 'engine:upgrade', 'engine:process-audio',
  // New cloud channels
  'cloud:configure', 'cloud:test-connection', 'cloud:get-config'
];
```

---

## 📋 Testing Checklist (Once Above is Done)

### Light Version Test Plan:

1. **Launch**
   - [ ] App opens without errors
   - [ ] Footer shows "v1.1.0 Light"
   - [ ] No console errors

2. **Configuration**
   - [ ] Click ⚙️ Settings - panel expands
   - [ ] Enter endpoint URL
   - [ ] Select model (tiny, base, small)
   - [ ] Click Test Connection
   - [ ] Shows "Connected ✓"

3. **Recording**
   - [ ] Click microphone button
   - [ ] Record 2-3 seconds of speech
   - [ ] Click to stop
   - [ ] Audio sent to cloud
   - [ ] Transcription appears
   - [ ] Footer shows processing time

4. **Model Switching**
   - [ ] Change model to "tiny"
   - [ ] Record again - faster response
   - [ ] Change to "small"
   - [ ] Record again - better quality
   - [ ] Footer shows correct model name

5. **Persistence**
   - [ ] Close app
   - [ ] Reopen app
   - [ ] Settings remembered

---

## 🎯 Standard Version (Not Started)

### Plan for Standard:
1. Copy `mvp-echo-light/` as base
2. Keep `whisper-native.js` and `whisper-engine.js`
3. Add compute mode selector (Auto/GPU/CPU)
4. Add system detection UI
5. Include `whisper-bin/whisper-standalone.exe`
6. Build with electron-builder (will be ~250MB)

**NOT STARTED YET** - Focus on completing Light first

---

## 🐛 Known Issues & Solutions

### Issue 1: CSP Still Blocking (CURRENT)
**Symptom**: "Refused to connect" despite `connect-src *`

**Possible causes**:
1. Meta tag syntax issue
2. CSP being set elsewhere (Electron's session.defaultSession.webRequest)
3. Build caching old HTML

**Next debug steps**:
1. Remove CSP entirely from index.html
2. Check if main process sets CSP
3. Use main process (IPC) for HTTP requests instead of renderer

---

### Issue 2: Large File Sizes
**Light portable**: 140-275MB (should be ~50MB)

**Cause**: Bundling unnecessary code (local whisper engines, Python manager)

**Solution**: Clean up Light version to remove:
- `app/stt/whisper-native.js`
- `app/stt/whisper-engine.js`
- Python manager references
- Unused components

---

### Issue 3: Build Process
**Current**: Must rebuild fully each time
**Takes**: ~2-3 minutes per build

**Optimization**:
- Use `npm run build` then just copy to `dist/win-unpacked` for quick tests
- Only run full `npm run pack` for final builds

---

## 📁 Important File Locations

### Cloud Endpoint (Unraid):
```
/mnt/user/appdata/faster-whisper-docker/
├── docker-compose.yml
├── nginx.conf
└── api.py (if using custom build)
```

### Light Version:
```
/home/corey/projects/mvp-echo/mvp-echo-light/
├── app/renderer/app/App.tsx           # Main UI (v1.1 footer added)
├── app/main/main-simple.js            # Main process (needs cloud IPC)
├── app/stt/whisper-remote.js          # Cloud engine (created, not integrated)
├── app/renderer/index.html            # CSP configuration
├── app/preload/preload.js             # IPC bridge (needs cloud channels)
└── dist/MVP-Echo Light 1.1.0.exe      # Latest build
```

### Test Page:
```
/home/corey/projects/mvp-echo/html-mockups/v1.1-functional.html
```

**Purpose**: Proven working reference for cloud integration
**Use**: Copy logic from this to React app

---

## 🎯 Immediate Next Steps (In Order)

### Step 1: Fix CSP (15 minutes)
Try removing CSP entirely or use IPC for Test Connection

### Step 2: Add Cloud IPC Handlers (30 minutes)
Update main-simple.js with cloud:* handlers

### Step 3: Wire Test Connection to IPC (15 minutes)
Update App.tsx to use IPC instead of direct fetch

### Step 4: Integrate Cloud Transcription (45 minutes)
Make recording use cloud endpoint instead of local whisper

### Step 5: Test End-to-End (30 minutes)
Full workflow test on Windows

### Step 6: Polish & Cleanup (30 minutes)
Remove unused code, optimize size

**Total estimated**: 2-3 hours to complete functional Light version

---

## 🔑 Key Commands

### Build Light Version:
```bash
cd /home/corey/projects/mvp-echo/mvp-echo-light
npm run build                    # Build frontend only
npm run pack                     # Build portable exe
npm run dist                     # Build installer + portable
```

### Deploy Cloud Endpoint:
```bash
cd /home/corey/projects/faster-whisper-docker
./sync-to-unraid.sh             # Copy files
./deploy-to-unraid.sh           # Full deploy + restart
```

### Test Cloud Endpoint:
```bash
curl http://192.168.1.10:20300/health
curl http://192.168.1.10:20300/v1/models
```

### View Endpoint Logs:
```bash
ssh root@192.168.1.10
docker-compose logs -f
```

---

## 📊 Code References

### Working Cloud Integration (Reference):
**File**: `html-mockups/v1.1-functional.html`

**Key sections to port to React**:
- Line 268-304: `handleTestConnection` function
- Line 230-305: `sendToEndpoint` function with FormData
- Line 155-163: Model selector dropdown
- Line 139-149: Endpoint configuration inputs

### Current React App:
**File**: `mvp-echo-light/app/renderer/app/App.tsx`

**Sections modified**:
- Line 143-145: Cloud state management added
- Line 180-185: Cloud configuration state
- Line 269-304: Test Connection handler (needs IPC)
- Line 538-542: Footer updated to v1.1.0
- Line 575-585: Settings button added
- Line 607-677: Cloud settings panel

---

## 🔍 Debug Info

### Latest Build:
- **File**: `/home/corey/projects/mvp-echo/mvp-echo-light/dist/MVP-Echo Light 1.1.0.exe`
- **Size**: 140MB (still too large, needs cleanup)
- **Built**: 2025-11-25 17:33:47
- **Errors Fixed**: whisperEngine undefined, init:check missing
- **Remaining Issues**: CSP blocking, cloud transcription not integrated

### Console Errors on Windows:
```
1. CSP: "Refused to connect to 'http://192.168.1.10:20300/health'"
   → Despite connect-src *
   → Try removing CSP or use IPC

2. "Failed to fetch" on Test Connection
   → Related to CSP issue
```

---

## 💡 Architecture Decisions Made

### Light vs Standard Separation:
- ✅ **Decided**: Option A - Separate directories
- ✅ **Structure**: `mvp-echo-light/` and `mvp-echo-standard/`
- ✅ **Naming**: Clear product names in executables

### Cloud Endpoint:
- ✅ **Decided**: Use fedirz/faster-whisper-server (production-ready)
- ✅ **GPU**: Required for performance
- ✅ **Models**: All models available, user selects in UI
- ❌ **Rejected**: LinuxServer image (wasn't responding)
- ❌ **Rejected**: Custom build with Wine (cuDNN issues)

### UI Design:
- ✅ **Decided**: Single unified UI for both versions
- ✅ **Settings**: Footer-based expandable panel
- ✅ **Differences**: Only footer text changes (Light vs Standard)

---

## 🚀 Future Work (After Light is Complete)

### Standard Version:
1. Add GPU/CPU detection
2. Add compute mode selector (Auto/GPU/CPU)
3. Include `whisper-bin/whisper-standalone.exe`
4. Add system detection display
5. Optional cloud mode (can switch to remote)

### Both Versions:
1. Add custom icons (Light = cloud, Standard = power)
2. Code signing
3. Auto-updater
4. Comprehensive testing
5. GitHub Actions builds

---

## 📞 Quick Resume Context

**Where we left off**:
- Built MVP-Echo Light 1.1.0.exe successfully
- UI shows v1.1.0 features (footer, settings panel)
- **BLOCKER**: Test Connection fails due to CSP
- **BLOCKER**: Recording doesn't use cloud (needs integration)

**Next immediate task**:
Fix CSP issue so Test Connection works, then integrate cloud transcription.

**Endpoint is ready**: http://192.168.1.10:20300 (GPU, all models working)

---

## 🛠️ Quick Fixes to Try

### Fix 1: Remove CSP Entirely
```html
<!-- mvp-echo-light/app/renderer/index.html -->
<!-- DELETE or comment out the CSP meta tag entirely -->
```

### Fix 2: Use IPC for HTTP Requests
Move all fetch() calls to main process to bypass CSP completely.

### Fix 3: Test Connection via IPC
```typescript
// In App.tsx handleTestConnection:
const result = await window.electronAPI.invoke('cloud:test-connection');
```

---

**End of WIP Document**
