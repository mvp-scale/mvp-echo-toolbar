# Session Bridge — start here to continue this work

_Last updated: 2026-06-21. Human-readable handoff so a fresh conversation starts oriented — no need to replay or resume an old session. (Claude also keeps auto-memory for this project that loads automatically; this is the readable companion.)_

## Current state: ✅ SHIPPED v3.0.27 to production
Released through the full proven pipeline — `dev`→`main` (cleaned) + tag `v3.0.27` + GitHub-built exe + public Release.
- Release: https://github.com/mvp-scale/mvp-echo-toolbar/releases/tag/v3.0.27
- `main` and `dev` are both at **3.0.27**. Nothing pending.

## What 3.0.27 fixed — and why the capture code looks the way it does
The GitHub-released build had degraded: **empty transcriptions** + a **~1–2s wait before you could speak**. Diagnosed (multi-agent + adversarial red-team) as a **source-bug cluster, NOT dependency drift** — the released build ran the same `parakeet.js 1.4.4` / `onnxruntime-web 1.24.1` / Electron 28.3.3 as local. Two distinct problems, both in `app/renderer/app/audio/AudioCapture.ts`:

1. **Empty transcriptions = the mic dead-window.** The "talk now" cue fired before the mic was actually delivering audio (old gate: keypress / frame-arrival + `track.muted`), so speech was lost. **Fix:** an **energy-based readiness gate** — the cue fires only once real audio energy is flowing (used on the *cold* path).
2. **~1–2s latency = per-press `getUserMedia` device cold-open** (the mic was re-opened every recording). **Fix:** **warm-mic** — acquire the stream once, keep it warm across recordings (repeat records fire the cue *immediately*), auto-release after an idle timeout.
3. **User control:** a **"Microphone Readiness"** setting — `Keep ready` (warm, instant) / `Release after each use` (mic icon off between uses) — plus a configurable **hold duration (30s–1h)**. Persisted in `app-config.json` via `app-config:get`/`app-config:set` IPC; applied live (on mount + re-read at stop, no restart).

## Key files
- `app/renderer/app/audio/AudioCapture.ts` — capture engine: warm-mic reuse, idle-release, energy readiness gate; `setMicReleaseMode()`, `setIdleReleaseMs()`.
- `app/renderer/app/CaptureApp.tsx` — record start/stop; reads app-config on mount + re-reads at stop.
- `app/renderer/app/components/SettingsPanel.tsx` — the "Microphone Readiness" + "Hold for" UI.
- `app/main/main-simple.js` — `loadAppConfig()` (app-config.json), `app-config:get/set` IPC, `whenReady` startup.

## Build / release
See **CLAUDE.md → "Release Process"** (full 3-step runbook). The one trap: **run `gh auth switch -u mvp-scale` FIRST** — `gh` defaults to a read-only account and returns `403` on workflow dispatch (git push works regardless, via a separate SSH key — don't be fooled).

## Test / diagnose new bugs
- Launch the exe with **`--diag`** (or `MVP_DEBUG=1`). Logs: `%TEMP%\mvp-echo-toolbar-debug.log` (capture/console) and `%TEMP%\mvp-echo-diagnostics.log`; saved WAVs in `%TEMP%\mvp-echo-audio\`.
- Readiness fingerprints in the log: `capture-ready via warm` (warm reuse = instant), `via energy` (cold, gated), `via timeout` (energy never crossed → device very quiet / floor too high).
- Signal sanity (`Raw PCM:` line): healthy speech **rms ≈ 0.03–0.08**; empties cluster **< ~0.02**; a high `peak` with low `rms` = mostly-silence-with-spikes (likely empty — not real voice).

## Known / deferred (NOT fixed in 3.0.27)
- **Long-audio empties (>~3 min).** Transcription is one-shot `model.transcribe()` with **no chunking**; very long recordings can come back empty/truncated. 3.0.27 fixed the SHORT-clip dead-window, *not* this. `parakeet.js` ships `transcribeLongAudio` (sequential, 20s chunk floor) we don't use — wire it in if long dictation matters.
- **Cold first record is still energy-gated** (first word after launch / after the idle release); warm reuse is instant. Pre-warming at startup would fix it but keeps the mic icon lit from launch.
- **CI reproducibility:** `package-lock.json` is gitignored → CI `npm install` is unpinned (drift broke 3.0.23 via `@noble/hashes`; pinned via `overrides`). Commit a lockfile + `npm ci` to fully fix. Deferred.
- **"Always" hold option** (never auto-release) — offered, not added.
- **Local speed/batching:** researched & decided against — parakeet.js decode is hard-wired batch=1 in WASM; no worthwhile local speedup without a library fork. Front-end CMVN is correct (no preprocessing fix needed).

## Full investigation reports (on the dev box, dev-only)
- `mvp-echo-toolbar/STARTUP-REGRESSION-REPORT.md` — the eager-WebGPU-init startup diagnosis.
- `mvp-echo-toolbar/RELEASE-INSTABILITY-GAP-ANALYSIS.md` — the empties/latency/tray gap analysis.
