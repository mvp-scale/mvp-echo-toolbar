# MVP-Echo Toolbar - Session Context

## Current State (2026-02-08)

**Version**: `v2.1.0` (released to GitHub)
**Build**: Portable exe only (135MB), no installer
**Branch**: `dev` (daily work), `main` (releases via GitHub Actions)

## What Was Just Implemented

### 1. Anti-Hallucination Settings (Whisper transcription quality)

**Problem**: Users getting repetitive "thank you thank you" and phantom words in transcriptions.

**Solution**: Server-side + client-side tuning for faster-whisper Docker.

**Files Changed**:
- `faster-whisper-docker/docker-compose.yml` -- Added env vars:
  - `_UNSTABLE_VAD_FILTER=true` (silence stripping before Whisper)
  - `WHISPER__COMPUTE_TYPE=float16` (better accuracy on GPU)
  - `STT_MODEL_TTL=-1` (keep model loaded)
- `mvp-echo-toolbar/app/stt/whisper-remote.js` -- Added per-request params:
  - `vad_filter=true`, `condition_on_previous_text=false`, `hallucination_silence_threshold=2`, `log_prob_threshold=-0.5`, `beam_size=5`, `language=en`

**Status**: Deployed to production server, working.

### 2. Auth Proxy with Usage Tracking

**Problem**: Need to share server via Cloudflare tunnel with API key auth and track who's using it.

**Solution**: Python auth proxy replaces nginx, validates Bearer tokens, tracks cumulative seconds per user.

**Files Created**:
- `faster-whisper-docker/auth-proxy.py` -- CORS + key validation + usage tracking
- `faster-whisper-docker/api-keys.json` -- Key registry (7 keys: Corey, Alex, Guest 1-5)
- `faster-whisper-docker/usage.json` -- Auto-updated usage stats

**How it works**:
- LAN requests (192.168.x.x, 10.x.x.x, etc.) bypass auth entirely
- Remote requests (via Cloudflare) require `Authorization: Bearer sk-...`
- Logs: `[auth-proxy] Corey (dev) [v2.1.0] +2 seconds  >>>  cumulative: 1 minute 6 seconds`

**Status**: Deployed, auth working, usage tracking working.

### 3. Network Hardening (Cloudflare/WAF compatibility)

**Problem**: Bot Fight Mode blocking app, residential IPs getting challenged, requests failing.

**Solution**:
- Browser-like User-Agent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 MVP-Echo-Toolbar/2.1.0`
- Standard headers: Accept, Accept-Language, Accept-Encoding, Connection, Cache-Control
- Retry logic: 502-504 and network errors auto-retry with exponential backoff (1s, 2s)

**Files Changed**:
- `mvp-echo-toolbar/app/stt/whisper-remote.js` -- Reads version from `package.json`, hardened headers, retry wrapper

**Status**: Deployed in v2.1.0 release.

### 4. Developer Experience Improvements

**API Key Persistence Fix**:
- `whisper-remote.js` `getConfig()` now returns `apiKey`
- `SettingsPanel.tsx` loads and displays saved key as dots on startup

**Debug Improvements**:
- Settings → Debug button opens DevTools for capture window
- Console forwarding from renderer to main process log file
- Diagnostic logging in AudioCapture: mic access, chunk sizes, buffer sizes
- Startup cleanup: fresh log file, sweep orphaned audio temp files

**Build Process**:
- `npm run build:toolbar` from repo root (no cd needed)
- Version auto-flows from `package.json` → User-Agent → auth proxy logs
- Portable exe only, removed NSIS installer

**Files Changed**:
- `mvp-echo-toolbar/app/main/main-simple.js` -- Startup cleanup, debug IPC, first-run balloon
- `mvp-echo-toolbar/app/renderer/app/audio/AudioCapture.ts` -- Diagnostic logging
- `mvp-echo-toolbar/app/renderer/app/CaptureApp.tsx` -- Console forwarding, logging
- `mvp-echo-toolbar/app/renderer/app/components/SettingsPanel.tsx` -- Debug button, API key loading
- `mvp-echo-toolbar/app/preload/preload.js` -- Debug IPC channels
- `package.json` (root) -- `build:toolbar` and `build:light` scripts

**Status**: All committed to dev, v2.1.0 released to GitHub.

## Current Known Issue

**First-run balloon not yet tested.** The code is in place but needs validation on Windows. The balloon should appear 2 seconds after first launch, pointing users to the tray icon location.

## Architecture

```
MVP-Echo Toolbar (Windows Electron app)
    |
    | HTTP POST with Bearer token
    v
Cloudflare Tunnel (mvp-echo.ctgs.link)
    |
    v
auth-proxy (Docker, validates keys, tracks usage)
    |
    v
faster-whisper-server (Docker, GPU, Whisper models)
```

## Key Files

| File | Purpose |
|------|---------|
| `mvp-echo-toolbar/app/main/main-simple.js` | Main process, IPC handlers, tray lifecycle |
| `mvp-echo-toolbar/app/stt/whisper-remote.js` | Cloud STT client with retry/headers |
| `mvp-echo-toolbar/app/renderer/app/CaptureApp.tsx` | Hidden window, handles Ctrl+Alt+Z recording |
| `faster-whisper-docker/auth-proxy.py` | Auth + usage tracking + CORS |
| `faster-whisper-docker/docker-compose.yml` | Whisper server + auth proxy containers |
| `faster-whisper-docker/api-keys.json` | User API keys (edit to add/revoke) |
| `faster-whisper-docker/usage.json` | Auto-updated cumulative usage per key |

## Build & Deploy Workflow

**Dev work:**
```bash
npm run build:toolbar    # Build portable exe from repo root
```

**Release to production:**
1. Commit to `dev` and push
2. GitHub Actions → "Release to Main" → enter version (e.g., `v2.1.0`)
3. GitHub Actions → "Build MVP-Echo Toolbar Windows App" (auto-triggers or manual)
4. Download artifact and create GitHub release with `gh release create`

**Docker updates:**
```bash
scp faster-whisper-docker/{docker-compose.yml,auth-proxy.py,api-keys.json} root@192.168.1.10:/mnt/user/appdata/faster-whisper-docker/
ssh root@192.168.1.10 "cd /mnt/user/appdata/faster-whisper-docker && docker-compose down && docker-compose up -d"
```

## Testing Checklist

**Local testing:**
- Run exe, check tray icon appears
- Press Ctrl+Alt+Z, speak, check transcription in popup
- Settings → Debug → verify DevTools opens with console logs
- Check temp folder for orphaned files (should be clean)

**Network testing:**
- `curl https://mvp-echo.ctgs.link/health` (should return JSON)
- Check auth proxy logs: `docker-compose logs -f auth-proxy`
- Verify user agent shows in Cloudflare Security → Events

**First-run balloon:**
- Delete `%APPDATA%/mvp-echo-toolbar/.first-run-complete` and restart app
- Should see balloon notification after 2 seconds pointing to tray

## API Keys

| Name | Key | Active |
|------|-----|--------|
| Corey (dev) | `sk-corey-2026` | Yes |
| Alex | `sk-alex-2026` | Yes |
| Guest 1-5 | Various | Yes |

LAN access (192.168.x.x) requires no key. Remote access via Cloudflare requires key.

## Cloudflare Configuration Notes

**Bot Fight Mode** was blocking non-browser user agents. Solution: hardened User-Agent string in app. May still need to disable Bot Fight Mode if issues persist.

**Custom Rules**:
- WHITELIST (skip for certain URLs)
- Block Non US (country filter)
- Bot Stopper (verified bot category)
- ThreatBlock (threat score filter)

**IP reputation**: Residential IPs can have poor scores from previous tenants. If user gets challenged, check Security → Events for their IP and either whitelist or create a rule to skip based on `Authorization header contains sk-`.

## Next Steps / Open Questions

- Test first-run balloon on Windows
- Monitor auth proxy logs for version tags (should show `[v2.1.0]`)
- Verify cleanup works (no orphaned temp files)
- Consider removing `Ctrl+Shift+D` global shortcut since Debug button exists
