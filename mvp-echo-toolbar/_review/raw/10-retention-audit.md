# 10 — Retention & Leak Audit ("what is still reachable, and how fast does it grow")

**Frame:** the hidden capture window (`CaptureApp.tsx`) is created once at `app.whenReady()`
(`app/main/main-simple.js:396`) and is **never closed** for the life of the app — only destroyed
and fully recreated on two specific recovery paths (`capture:request-reload`,
`main-simple.js:522-533`; renderer crash respawn, `main-simple.js:172-184`, capped at
`MAX_RENDERER_CRASHES=3`, reset on a clean load). Everything below is scoped to: what accumulates
in that window's JS heap / on disk across many recordings and hours of uptime, not what a single
recording allocates and frees.

**Method:** every file under `app/` was read in full (not sampled). `node_modules/parakeet.js` was
read for its retention surface (encoder/decoder session lifecycle, blob-URL/cache handling,
incremental-decode buffers). Prior review files in `_review/` were used for orientation only; every
claim below was independently re-derived from source and cites its own line numbers. Where a finding
corroborates something in `_review/raw/08-memory-and-hangs.md`, that is noted, but the evidence here
was gathered independently, and in one case (parakeet.js's session-release surface) the finding
**extends** 08's characterization — see F5.

---

## (a) Listener / timer inventory

| What | file:line | Registered on | Removed where | Can re-register? |
|---|---|---|---|---|
| `ipcRenderer.on('global-shortcut-toggle')` | `CaptureApp.tsx:428` (preload impl: `preload.js:19-23`) | CaptureApp mount effect (deps `[]`) | `CaptureApp.tsx:536-538` on unmount | Only if the hidden window is destroyed+recreated; preload wrapper calls `removeAllListeners` before `.on`, so no stacking even on double-call |
| `navigator.mediaDevices` `devicechange` (diag) | `CaptureApp.tsx:181` | CaptureApp mount effect | `CaptureApp.tsx:534` on unmount | Same as above — paired add/remove |
| `navigator.mediaDevices` `devicechange` (release warm mic) | `AudioCapture.ts:364-367` | First cold `ensureMicStream()` call, guarded by `deviceChangeListenerAdded` (`:361-362`) | **Never removed** | Guard prevents re-registration within one `AudioCapture` instance; a new instance only appears on full window recreate |
| `track.onmute` / `.onunmute` / `.onended` | `AudioCapture.ts:352-354` | Every cold mic acquisition | Implicitly replaced (property assignment, not `addEventListener`) each new track | Re-registers every cold acquisition by design — cannot stack (setter semantics) |
| `AudioWorkletNode.port.onmessage` | `AudioCapture.ts:457-468` | Every `startRawRecording()` (new node each time) | `:558` (stop) / `:676` (cleanup) — old node explicitly disconnected first | Re-registers every recording; no stacking, old node torn down before new one created |
| `worker.addEventListener('message', deviceLostHandler)` | `inference-orchestrator.ts:65-70` | Once per **new** `Worker` instance (`if (!this.worker)`) | Dies with `worker.terminate()` | Fires once per init cycle that creates a fresh worker — bounded to 1 live listener |
| `worker.addEventListener('message', handler)` (per `sendMessage`) | `inference-orchestrator.ts:172` | Every `sendMessage()` call (init, transcribe) | `cleanup()` at `:167-170`, invoked only on resolve/reject/timeout | Re-registers every call; if `disposeSync()` fires mid-flight the removal is **delayed until that call's own timeout** (120s transcribe / 900s init) — see F4 |
| Countdown `setInterval` | `CaptureApp.tsx:199-229` | Every recording start | `clearCountdown()` (`:187-190`), unmount (`:539-541`), `beforeunload` (`:549-551`) | Re-registers every recording; `clearCountdown()` always runs first — single active interval |
| `safetyTimeout` (60s) | `CaptureApp.tsx:271-276` | Every `performStop()` | `finally` at `:416` | Re-registers every stop; always cleared |
| `startWatchdog` (25s) | `CaptureApp.tsx:498-503` | Every recording start | `.finally()` at `:517` | Re-registers every start; always cleared |
| `doneTimeout` (3s, tray) | `tray-manager.js:107-111` | Every `setState('done')` | Top of `setState()` (`:96-99`), `destroy()` (`:123-125`) | Re-registers every completed transcription; single active timer |
| `idleReleaseTimer` (30s–1h, configurable) | `AudioCapture.ts:401-405` | Every `stopRawRecording()` in `keep-ready` mode | `:397-400`, `:381-384`, `:434-437`, `:632` | Re-registers every stop; single active timer, always cleared first |
| `captureReadyTimer` (2s fallback) | `AudioCapture.ts:482` | Every cold `startRawRecording()` | `:523`, `:557`, `:631` | Re-registers per cold start; single active timer |
| `pollRef` (2s, WebGPU model-status) | `SettingsPanel.tsx:367-386` | Every WebGPU model-select | `:372`/`:382` on completion/timeout, `:127` on unmount | Re-registers per model switch; hard-capped at 150×2s=5min even if leaked |
| `animationId` (`requestAnimationFrame`, legacy meter) | `AudioCapture.ts:194` | Every legacy (webm) `startRecording()` | `cleanup()` `:634-637`; also self-stops when `mediaRecorder.state !== 'recording'` (`:193`) | Re-registers per legacy recording |
| Copy-feedback `setTimeout` (1.5s) | `TranscriptionDisplay.tsx:16` | Every click-to-copy | **Never cleared** | Re-registers every click — see F6 (trivial) |

## (b) Growth inventory

| What grows | file:line | Grows per | Bound |
|---|---|---|---|
| `%TEMP%\mvp-echo-audio\rec-*.wav` diagnostic files | `main-simple.js:506-517` | 1 file per recording (diag mode only) | **None** — no cap, no eviction, not covered by the startup orphan sweep. See F1. |
| `%TEMP%\mvp-echo-diagnostics.log` | `main-simple.js:493-501` | 1 line per recording (diag mode only) | **None within a session** — only reset at next launch (`:55`). See F2. |
| `%TEMP%\mvp-echo-toolbar-debug.log` | `logger.js:5-33` | 1 line per `log()` call (every IPC handler + every forwarded renderer `console.error`/`console.warn`, unconditionally) | **Bounded** — explicit 5 MB cap, trims to newest half (`logger.js:6,17-28`). Listed for contrast, not a defect. |
| Blob-URL-referenced model Blobs (encoder/decoder `.onnx`) | `node_modules/parakeet.js/src/hub.js:229,272,459,481` | 1 set (~2-4 blobs) per orchestrator `initialize()` call | **None in library code** — never `revokeObjectURL`'d; reclaimed only via `Worker.terminate()` realm teardown. See F5. |
| `encoderSession` / `joinerSession` (ONNX Runtime Web) | `parakeet.js:63-64,227-275` | 1 pair per successful model load | **None** — no `session.release()` anywhere in parakeet.js. See F5. |
| `sendMessage()` pending closure holding the transcribe PCM `Float32Array` (≤38.4 MB @ 600s cap) | `inference-orchestrator.ts:145-175` | 1 instance, only while a call is in flight during an abort/device-loss | **Self-bounded** to that call's own timeout (120s transcribe / 900s init); not cumulative — only one recording is ever in flight at a time. See F4. |
| `IncrementalMelProcessor._rawBuffers` (double buffer) | `node_modules/parakeet.js/src/mel.js:646-677` | High-water-mark: grows to the largest single recording's frame count, then is reused, never shrunk | **Bounded** at 2× `MAX_RECORDING_S` (600s) worth of mel frames (~tens of MB) — capped by the app's own 600s recording limit, does not grow further with more recordings. See F7. |
| `ParakeetModel._incrementalCache` | `parakeet.js:109-110,945-956` | Per unique `cacheKey` passed to `transcribe()` | **Bounded** — LRU, cap 50 entries (`maxIncrementalCacheSize`). Not exercised by this app (no `cacheKey` passed at `inference-worker.ts:125`). |
| `recCountRef` / `requestGenRef` counters | `CaptureApp.tsx:45,48` | +1 per recording | Technically unbounded (plain number) but immaterial — ~9 quadrillion recordings to matter |

---

### [F1 — P1] Diagnostic audio directory grows forever, no cap, no sweep

- **Where:** `app/main/main-simple.js:506-517`, `app/stt/engine-manager.js:539-565`, `app/main/main-simple.js:40-49`
- **What:** `diag:save-audio` writes one WAV file per recording to `%TEMP%\mvp-echo-audio\` whenever
  diagnostics are on (`--diag` or `MVP_DEBUG=1`). No file count/size cap and no eviction exist for
  this directory. The app's two temp-file sweeps do **not** cover it: the startup sweep in
  `main-simple.js` only matches files whose name starts with `mvp-echo-audio-` (note the trailing
  dash) **and** ends in `.webm`; the diag directory is named `mvp-echo-audio` (no dash, no extension
  match) and its files are named `rec-NNN-....wav`. `engine-manager.js`'s
  `_cleanupOrphanedTempFiles()` has the same `mvp-echo-audio-` prefix filter and only looks at files
  directly in `os.tmpdir()`, not inside the subdirectory.
- **Evidence:**
  ```js
  // main-simple.js:506-517
  const diagAudioDir = path.join(os.tmpdir(), 'mvp-echo-audio');
  ipcMain.handle('diag:save-audio', async (_event, name, buf) => {
    if (!DIAG_ENABLED) return { success: false };
    try {
      if (!fs.existsSync(diagAudioDir)) fs.mkdirSync(diagAudioDir, { recursive: true });
      const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
      fs.writeFileSync(path.join(diagAudioDir, safe), Buffer.from(...));
  ```
  ```js
  // main-simple.js:43 — startup sweep pattern that does NOT match the dir above
  const orphans = fs.readdirSync(tmpDir).filter(f => f.startsWith('mvp-echo-audio-') && f.endsWith('.webm'));
  ```
  Caller: `saveDiagAudio()` in `diag.ts:82-86`, invoked once per recording from
  `CaptureApp.tsx:324`.
- **Growth rate:** 1 file per recording, diagnostics-mode only. Each file is the full pre-trim
  captured PCM as 16-bit WAV (~32 KB/s), so a few seconds of speech is a few hundred KB; a
  near-600s recording is ~19 MB. Never cleaned, including across restarts (nothing sweeps this
  directory at any point in the codebase).
- **Fix:** either cap total directory size / file count with LRU eviction, or sweep files older
  than N hours at startup (mirroring the existing `.webm` orphan sweep pattern, but pointed at the
  actual directory/pattern used).

### [F2 — P2] Diagnostics text log has no in-session cap, unlike the main debug log

- **Where:** `app/main/main-simple.js:493-501` vs `app/main/logger.js:5-33`
- **What:** `diag:record` appends one line per recording to `mvp-echo-diagnostics.log` via
  `fs.appendFileSync` with no size check. Contrast with the main debug log (`logger.js`), which
  explicitly caps at 5 MB and trims to the newest half when exceeded — a pattern the diagnostics
  log does not share. The diagnostics log is only reset at the *next app launch*
  (`main-simple.js:55`), not within a running session.
- **Evidence:**
  ```js
  // main-simple.js:493-501 — no cap, unlike logger.js
  ipcMain.handle('diag:record', async (_event, line) => {
    if (!DIAG_ENABLED) return { success: false };
    try {
      fs.appendFileSync(diagPath, `[${new Date().toISOString()}] ${line}\n`);
  ```
  ```js
  // logger.js:5-6, 21-28 — the pattern that IS bounded, for contrast
  const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB ceiling within a session
  if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_LOG_BYTES) {
    const data = fs.readFileSync(logPath, 'utf8');
    fs.writeFileSync(logPath, data.slice(-Math.floor(MAX_LOG_BYTES / 2)));
  }
  ```
- **Growth rate:** ~200-400 bytes per recording line, diagnostics-mode only. Over an 8-hour, ~100
  recording session this is tens of KB — small in absolute terms, but genuinely unbounded within
  the session by construction (no cap exists), unlike its sibling log file.
- **Fix:** apply the same trim-to-half-at-N-MB pattern already implemented in `logger.js`.

### [F3 — Ruled out, stated for the record] No unbounded in-memory transcript history

- **Where:** `app/stt/engine-manager.js:59-63,242-249,505-514`; `app/renderer/app/PopupApp.tsx:71-96`
- **What:** `lastTranscription`/`lastTranscriptionMeta` on `EngineManager` and the `transcription`
  React state in `PopupApp` are single fields that are **overwritten**, not appended to, on every
  new result. There is no growing array of past transcriptions anywhere in the renderer or main
  process. Explicitly checked because the audit brief calls this out as a common pattern; not
  present here.

### [F4 — P2] Aborting mid-transcribe retains the PCM buffer + listener for up to 120s (self-resolving, not cumulative)

- **Where:** `inference-orchestrator.ts:73-77,100-109,132-134,136-143,145-175`; `CaptureApp.tsx:271-276`
- **What:** `abort()` (called from the 60s safety timeout at `CaptureApp.tsx:274`) and the
  `device-lost` handler both call `disposeSync()`, which terminates the worker and nulls
  `this.worker` — but does **not** reject the in-flight `sendMessage()` promise for a
  transcribe-in-progress. That promise's only remaining exit is its own timeout
  (120s for transcribe, 900s for init, set at `:108` and `:76`). Until it fires, the `Promise`
  executor's closure — which references `message` (`{ type: 'transcribe', audio: pcm, sampleRate }`)
  — stays reachable, and so does `CaptureApp.performStop()`'s own suspended async frame (holding
  `pcm`/`trimmed`), since its `await orchestratorRef.current.transcribe(...)` at `:302` is still
  pending.
  ```ts
  // inference-orchestrator.ts:136-143 — terminates but never rejects the pending promise
  private disposeSync(): void {
    if (this.worker) {
      try { this.worker.postMessage({ type: 'dispose' }); } catch { /* ok */ }
      this.worker.terminate();
      this.worker = null;
    }
    this.modelReady = false;
  }
  ```
  ```ts
  // inference-orchestrator.ts:153-156 — the ONLY way this settles after a mid-flight terminate
  const timeout = setTimeout(() => {
    cleanup();
    reject(new Error(`Worker timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  ```
- **Growth rate:** Bounded to a single in-flight instance (the app's own `isProcessingRef`/
  `isStartingRef` guards ensure only one recording cycle is ever active), self-clears after ≤120s
  (transcribe) or ≤900s (init). Not cumulative across cycles — but it is a real, repeatable
  per-abort retention window of a large buffer (up to 38.4 MB at the 600s cap) that a flaky-mic or
  repeated-timeout user session would re-trigger every cycle.
- **Fix:** track the pending `sendMessage`'s `reject` and call it from `disposeSync()` so teardown
  fails the in-flight call immediately instead of waiting out its timeout.

### [F5 — P1] parakeet.js has no explicit teardown for ONNX sessions or model blob URLs — cleanup depends entirely on unverified Worker-realm teardown

- **Where:** `node_modules/parakeet.js/src/hub.js:205-273,420-488`; `node_modules/parakeet.js/src/parakeet.js:61-113,227-275`; `app/renderer/app/webgpu/inference-worker.ts:147-158`; `app/renderer/app/webgpu/inference-orchestrator.ts:136-141`
- **What:** Two related gaps in the library, both confirmed by reading the full source:
  1. `getModelFile()` creates a Blob + `URL.createObjectURL(blob)` for every downloaded/cached model
     file (encoder, decoder — each up to several hundred MB) and **returns the URL without ever
     revoking it**. Contrast: the sibling `getModelText()` function (used for the small
     tokenizer/vocab file) explicitly calls `URL.revokeObjectURL(blobUrl)` right after use
     (`hub.js:286`) — the binary-file path has no equivalent.
     ```js
     // hub.js:229, 272 — both return paths create a blob URL; neither is ever revoked
     return URL.createObjectURL(cachedBlob);
     ...
     return URL.createObjectURL(blob);
     ```
     Confirmed via `grep -n "revokeObjectURL" node_modules/parakeet.js/src/*.js` — the only hit is
     `hub.js:286` (the text-file path).
  2. `ParakeetModel` never calls `.release()` on `encoderSession`/`joinerSession` (the ONNX Runtime
     Web `InferenceSession` objects that hold the actual model weights/compute buffers, WebGPU or
     WASM-backed). There is no `dispose()`/`destroy()` method on `ParakeetModel` at all — only
     `resetMelCache()` and `clearIncrementalCache()` (`parakeet.js:501-513`), neither of which
     touches the sessions. `grep -rn "\.release("` across the package returns zero matches.
  3. On the app side, `inference-worker.ts`'s own `dispose()` (which at least destroys the
     loss-watch GPU device) is asked to run via `postMessage({type:'dispose'})`, but
     `inference-orchestrator.ts`'s `disposeSync()` calls `worker.terminate()` on the very next
     synchronous line with no `await`/ack — so the posted message frequently never gets processed
     before the worker's event loop is torn down:
     ```ts
     // inference-orchestrator.ts:137-140
     try { this.worker.postMessage({ type: 'dispose' }); } catch { /* ok */ }
     this.worker.terminate();
     this.worker = null;
     ```
  Net effect: **the only thing that ever reclaims the model's runtime memory (WASM heap and/or
  WebGPU buffers behind the encoder+joiner sessions, plus the un-revoked blob-referenced Blobs) is
  the browser's own cleanup of a terminated Worker's global realm.** Nothing in application code
  or the library explicitly releases any of it.
- **Growth rate / severity calibration:** Each `initialize()` cycle *does* call `disposeSync()`
  (which calls `terminate()`) before the app allows the next cycle to start — `initialize()` only
  creates a new `Worker` when `!this.worker` (`inference-orchestrator.ts:56`), and `this.worker` is
  always nulled by `disposeSync()` on the failure path (`:88-89`). So at most **one** worker realm
  is ever alive at a time; this is not literally "N workers accumulating." The risk is entirely
  about whether `Worker.terminate()` **promptly and completely** reclaims WASM/WebGPU resources
  from the just-discarded realm — this is Chromium/driver-internal behavior and **UNVERIFIED** from
  source (the existing `_review/raw/08-memory-and-hangs.md` P2 flags the same uncertainty, but only
  for the loss-watch `GPUDevice`; this finding extends it to the entire encoder+joiner sessions —
  i.e., essentially the whole ~1.2 GB loaded model — since neither the library nor the app releases
  them explicitly). This matters most in combination with `inference-orchestrator.ts:81-92`'s
  failure path, independently confirmed while reading this file: the `catch` block there swallows
  the init error and calls `disposeSync()` but never re-throws, so
  `CaptureApp.tsx:74`'s `initFailRef.current += 1` (in its own `catch`) is unreachable, meaning the
  3-strikes give-up guard at `CaptureApp.tsx:461` can never trip and the app will keep retrying
  every 15s indefinitely on a persistently-failing init. If terminate()'s realm teardown is not
  instantaneous/complete, that retry cadence is exactly what would surface it as gradual RAM/GPU
  growth.
- **Fix:** two independent, additive fixes — (1) in `parakeet.js`, add a `model.dispose()` that
  calls `encoderSession.release()`/`joinerSession.release()` and revokes the stored blob URLs, and
  call it from `inference-worker.ts`'s `dispose()`; (2) fix the orchestrator to `await` a brief ack
  (or short timeout) for the posted `dispose` message before calling `terminate()`, so the
  worker-side cleanup actually gets a chance to run instead of racing teardown.

### [F6 — P3] `TranscriptionDisplay`'s copy-feedback timer has no unmount cleanup

- **Where:** `app/renderer/app/components/TranscriptionDisplay.tsx:12-17`
- **What:** `handleClick` sets a bare `setTimeout(() => setCopied(false), 1500)` with no stored
  handle and no cleanup on unmount.
  ```tsx
  const handleClick = useCallback(() => {
    if (!text) return;
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text, onCopy]);
  ```
- **Growth rate:** One 1.5s timer per click; trivial. Worst case is a `setState` on an unmounted
  component (React dev-mode warning), not a real leak — the popup window persists across
  show/hide, so `TranscriptionDisplay` rarely actually unmounts mid-timer.
- **Fix:** track the handle in a ref and clear it in a `useEffect` cleanup, if this component is
  ever made to unmount more aggressively.

### [F7 — P3, informational] `IncrementalMelProcessor`'s raw-mel buffers are a high-water-mark, not a leak

- **Where:** `node_modules/parakeet.js/src/mel.js:646-677`
- **What:** `IncrementalMelProcessor._rawBuffers` (a double buffer) grows to fit the largest audio
  window ever passed to `process()`, and `reset()` (called by `resetMelCache()` before every
  transcribe, per `inference-worker.ts:117`) deliberately does **not** shrink it back:
  ```js
  // mel.js:657-661, 675-676
  // Double buffering for raw mel to allow safe reuse while copying from cache
  // _rawBuffers[0] and [1] will grow as needed.
  this._rawBuffers = [null, null];
  ...
  // We retain the allocated buffers to avoid re-allocation next time
  ```
- **Growth rate:** One-time step function per model-instance lifetime, capped by the app's own
  600s (`MAX_RECORDING_S`, `CaptureApp.tsx:25`) recording limit — roughly tens of MB at the
  worst case (600s × ~100 mel-frames/s × 128 mels × 4 bytes × 2 buffers). Does **not** grow further
  with additional recordings once the high-water mark is hit; this is a deliberate reuse
  optimization in the library, not a defect. Listed because it explains an observable symptom
  ("memory doesn't come back down after one long recording, for the life of the loaded model").

### [F8 — Ruled out] Everything else checked and found correctly bounded

Confirmed by direct reading, listed to show the negative space was actually checked, not assumed:

- `AudioCapture`'s persistent raw engine (`AudioContext`, keep-alive node, sink) is a deliberate
  singleton, rebuilt only on real teardown (`AudioCapture.ts:36-43,233-284`) — not re-created per
  recording.
- All `AudioCapture`/`CaptureApp` timers (idle-release, capture-ready, countdown, safety, watchdog)
  have exactly one active instance each, cleared on every exit path including error/abort paths —
  verified per call site, tabulated in (a) above.
- `SettingsPanel`'s model-status poll is both unmount-cleared (`:127`) and hard-capped at 150
  iterations / 5 minutes (`:364-386`), even though `SettingsPanel` itself mounts/unmounts on every
  Settings-panel open/close.
- `logger.js`'s main debug log is explicitly capped at 5 MB with a trim-to-half policy
  (`logger.js:6,17-28`) — despite receiving a `log()` call for essentially every IPC handler and
  every forwarded renderer `console.error`/`console.warn`.
- `engine-manager.js`'s legacy (non-WebGPU) temp WebM/WAV files are cleaned up in a `finally` block
  on every call (`:272-276`) plus a 5-minute-old orphan sweep at startup (`:539-565`).
- `ParakeetModel._incrementalCache` is an LRU capped at 50 entries (`parakeet.js:109-110,945-956`),
  and is not even exercised by this app's one-shot `transcribe()` call pattern (no `cacheKey` is
  passed at `inference-worker.ts:125`).
- parakeet.js's module-level caches (`repoFileCache` in `hub.js:15`, `MEL_FILTERBANK_CACHE`/
  `FFT_TWIDDLE_CACHE` in `mel.js:41-42`) are bounded in practice because this app only ever uses one
  model/config combination — at most 1-2 entries each.
- `StatefulStreamingTranscriber`, `transcribeLongAudio`, `FrameAlignedMerger`, `LCSPTFAMerger`, and
  `MelFeatureCache` (the classes in `parakeet.js` with unbounded-looking `_totalWords`/
  `_totalTokenIds`/`confirmedTokens` arrays) are **never imported or used anywhere in `app/`** —
  confirmed via `grep -rn` across the whole `app/` tree returning zero hits. This app only calls
  the one-shot `model.transcribe()` path (`parakeet.js:600-1156`), which was read in full and
  disposes its per-call ONNX tensors (`input`, `lenTensor`, `enc`, decoder states) immediately
  after use (`:691-695,733-734,891-921`).
- Ephemeral per-recording `AudioContext`s (`start-sound.ts`, `completion-sound.ts`,
  `warning-sound.ts`) are each created fresh and closed via `oscillator.onended = () =>
  ctx.close()` on the happy path — verified in all three files. This relies on `onended` always
  firing (no timeout-based fallback close), which is a low-confidence latent risk but not
  independently demonstrable as a defect from source.
- `preload.js`'s wrapped IPC listener methods (`onGlobalShortcutToggle`, `onCountdownUpdate`,
  `onTranscriptionUpdated`, `onWebgpuInitOrchestrator`) all call `ipcRenderer.removeAllListeners()`
  before `.on()`, so even a caller that forgets to unsubscribe cannot stack duplicate listeners
  (`preload.js:19-23,29-33,39-43,68-72`).
- `tray-manager.js`'s icon cache is bounded to the 5 fixed tray states (`:26,32-45`).
- `whisper-remote.js` is dead code — not imported anywhere in `app/` (confirmed via `grep -rn
  "whisper-remote" app/`, only a comment reference in `remote-adapter.js:13` mentions it) — excluded
  from the retention picture because it never executes.

---

## Answer: what grows without bound over an 8-hour session, and how fast?

**With diagnostics off (default):** nothing found grows without bound. Every timer has exactly one
live instance, every cache is either LRU-capped or bounded by the fixed set of models/configs this
app actually uses, the main debug log is explicitly capped at 5 MB, and per-recording temp files are
cleaned up in `finally` blocks plus a startup sweep. The one real per-cycle churn pattern (F5 — model
sessions/blob URLs with no explicit release) exists but is bounded to one live Worker realm at a
time; its severity is conditional on unverified browser-internal reclaim behavior, not a
demonstrable steady leak from source alone.

**With diagnostics on (`--diag` or `MVP_DEBUG=1`):** the diagnostic WAV directory
(`%TEMP%\mvp-echo-audio\`, F1) grows by exactly one file per recording, **forever, uncapped, never
swept, surviving restarts** — the only unambiguous, unconditional, unbounded-growth finding in this
audit. At ~100 recordings over 8 hours this is on the order of tens of MB to low hundreds of MB of
disk (worst case ~1.9 GB if every recording ran the full 600s cap); it does not free itself without
manual deletion. The diagnostics text log (F2) grows alongside it but far more slowly (tens of KB
over the same session) and is also uncapped within a session, unlike its sibling debug log which
does have a cap.

The most severe *conditional* risk is F5/F4 (RAM/GPU, not disk): if the already-independently-
confirmed dead-retry-counter bug in `inference-orchestrator.ts:81-92`/`CaptureApp.tsx:68,74` allows
the WebGPU init to retry indefinitely on a persistently-failing machine, and if `Worker.terminate()`
does not promptly/completely reclaim the terminated realm's WASM/WebGPU buffers (parakeet.js gives
it no other way to be reclaimed — no `session.release()`, no blob-URL revocation), that combination
would present as gradual RAM/GPU growth in ~15s increments. This chain is real in its individual,
source-confirmed parts; whether it manifests as actual growth depends on browser-internal behavior
this audit cannot verify from source.
