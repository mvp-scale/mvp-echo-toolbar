# WebGPU Inference Pipeline — Architectural Review

Scope: `app/renderer/app/webgpu/*`, `app/stt/adapters/webgpu-bridge-adapter.js`,
`app/stt/webgpu-model-manager.js`, `app/renderer/test-webgpu.html`, `vite.config.ts`,
plus `node_modules/parakeet.js` (v1.4.4) read to check for library-API misuse and to
verify claims made in code comments.

## Cold-start timeline as implemented

1. `app.whenReady()` (`app/main/main-simple.js:345`) auto-approves `media` and
   `persistent-storage` permission requests (`main-simple.js:354-360`) — fixes the
   previously-known persistent-storage-denied cache-eviction hazard.
2. `createHiddenWindow()` (`main-simple.js:396`, defined `131-185`) creates the
   always-alive capture window and, in production, loads it via
   `hiddenWindow.loadFile(htmlPath)` (`main-simple.js:153`) — **no COOP/COEP response
   headers are set anywhere in the main process** (confirmed by absence — see
   Finding P1-1). This is on the critical path for every subsequent WASM execution.
3. `CaptureApp` mounts in the hidden window (`app/renderer/app/CaptureApp.tsx:34`).
   Its mount `useEffect` (`CaptureApp.tsx:83-124`) calls `loadConfig()`, which reads
   `cloud:get-config` over IPC.
4. **Eager-load trigger:** if the persisted `config.selectedModel` starts with
   `webgpu-` (the common case — WebGPU/"English GPU" is the flagship on-device
   model, restored across restarts by `engine-manager.js:158-161`), `CaptureApp.tsx:95-98`
   unconditionally calls `initWebGpuOrchestrator()` — no user interaction required.
   **[CRITICAL PATH]**
5. `initWebGpuOrchestrator` (`CaptureApp.tsx:50-77`) probes `navigator.gpu.requestAdapter()`
   (line 57, no `powerPreference`, only used to pick the backend string), then calls
   `orchestratorRef.current.initialize(backend, appVersion)` (line 67). **[CRITICAL PATH]**
6. `InferenceOrchestrator.initialize()` (`inference-orchestrator.ts:40-93`) →
   `prepareModelCache()` (`model-cache.ts:71-100`): requests
   `navigator.storage.persist()` and clears IndexedDB only on a genuine model-identity
   change (lines 80-92) — confirmed the app-version re-download hazard is fixed.
   **[CRITICAL PATH]**
7. Worker created (`inference-orchestrator.ts:57-60`, `new Worker(new URL('./inference-worker.ts', import.meta.url), {type:'module'})`)
   and sent `{type:'init', backend}` with a 900,000 ms (15 min) timeout (lines 73-77).
   **[CRITICAL PATH]**
8. Inside the worker, `fromHub('parakeet-tdt-0.6b-v2', {...})` (`inference-worker.ts:54-73`)
   drives parakeet.js's `getParakeetModel()`/`getModelFile()`
   (`node_modules/parakeet.js/src/hub.js:410-489`, `205-273`), which downloads
   encoder/decoder/tokenizer files **sequentially** (`hub.js:457-476`, a plain `for`
   loop with `await` inside, not `Promise.all`) against an IndexedDB cache check
   (`hub.js:224-234`). On a cold cache this is the ~1.2GB download — fully on the
   critical path, with no parallelism and no UI-visible progress (progress messages
   only reach `console.log`, `inference-orchestrator.ts:162-164`). **[CRITICAL PATH]**
9. ONNX Runtime session creation (`parakeet.js:160-239`): encoder gets a WebGPU EP
   with `powerPreference:'high-performance'` (`parakeet.js:178-186`); decoder is
   **forced to WASM** whenever backend starts with `webgpu` (`parakeet.js:222-224`).
   WASM thread count is gated by `SharedArrayBuffer` availability
   (`node_modules/parakeet.js/src/backend.js:67-74`), which is unavailable in the
   packaged app per step 2 → decoder runs single-threaded on every request, not just
   at cold start (see Finding P1-1). **[CRITICAL PATH]**
10. Device-loss watcher acquired via a **second, independent** `requestAdapter()`/
    `requestDevice()` call with no `powerPreference` (`inference-worker.ts:81-96`) —
    see Finding P2-3 for why this can diverge from the compute adapter in step 9.
11. Warmup transcription: `model.transcribe(silence, 16000)` (`inference-worker.ts:99-102`)
    compiles WebGPU shaders and exercises the single-threaded WASM decoder path from
    step 9. **[CRITICAL PATH]**
12. `self.postMessage({type:'ready'})` (`inference-worker.ts:104`) → orchestrator
    resolves, `modelReady = true` (`inference-orchestrator.ts:79`) → IPC
    `webgpu:model-ready` sent to main (`CaptureApp.tsx:72`) →
    `WebGpuModelManager._ready = true` (`webgpu-model-manager.js:22-25`). **[CRITICAL PATH]**
13. First real transcription is only possible after step 12. Until then, a hotkey
    press is **silently ignored** rather than falling back to the webm/IPC engine
    path (`CaptureApp.tsx:454-473`) — see Finding P1-2. **[CRITICAL PATH]**

**Verdict on eager vs. lazy:** the model load is **eager** whenever a WebGPU model
was previously selected (the persisted, expected steady state for users of the
flagship on-device feature) — it fires unconditionally in the hidden window's mount
effect (`CaptureApp.tsx:95-98`), before any user interaction, immediately after
`app.whenReady()`. It is lazy only on a fresh install / when the user has never
selected a WebGPU model (`engine-manager.js:51` defaults `selectedModelId` to
`'local-fast'`) or explicitly picks it later via Settings
(`CaptureApp.tsx:127-137`, `webgpu:init-orchestrator` IPC).

---

## Findings

### [P1] Production build never establishes cross-origin isolation — WASM decoder runs single-threaded on every transcription
- **Where:** `app/main/main-simple.js:131-185` (no headers set), `vite.config.ts:54-66` (COOP/COEP only on the dev server), `node_modules/parakeet.js/src/backend.js:67-74`
- **What:** `vite.config.ts` sets `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` only for the Vite dev server (`server.headers`). The packaged app loads the hidden window via `hiddenWindow.loadFile(htmlPath)` (`main-simple.js:153`) with no equivalent header injection anywhere in the main process (`grep` for `Cross-Origin`/`COOP`/`COEP`/`onHeadersReceived` across `app/main/main-simple.js` returns nothing). Without cross-origin isolation, `SharedArrayBuffer` is undefined, and parakeet.js's own backend init explicitly falls back to 1 WASM thread when that's the case.
- **Evidence:**
  ```js
  // node_modules/parakeet.js/src/backend.js:67-74
  if (typeof SharedArrayBuffer !== 'undefined') {
    ort.env.wasm.numThreads = numThreads || navigator.hardwareConcurrency || 4;
    ort.env.wasm.simd = true;
  } else {
    console.warn('[Parakeet.js] SharedArrayBuffer not available - using single-threaded WASM');
    ort.env.wasm.numThreads = 1;
  }
  ```
  ```js
  // node_modules/parakeet.js/src/parakeet.js:221-224 — decoder ALWAYS runs on WASM in webgpu mode
  if (backend.startsWith('webgpu')) {
    decoderSessionOptions.executionProviders = ['wasm'];
  }
  ```
- **Impact:** Every single transcription's decoder step (and the entire pipeline when falling back to pure `'wasm'` backend on non-WebGPU machines) runs single-threaded in shipped builds, silently — there is no error or log that flags *why* it's slow, just a permanently degraded RTF. This is present on both cold start (warmup) and every subsequent transcription for the life of the process.
- **Fix:** Inject COOP/COEP response headers for the packaged app too, e.g. via `session.defaultSession.webRequest.onHeadersReceived` in `main-simple.js`, or serve the renderer through a custom protocol/local server that can set them, then verify `crossOriginIsolated === true` in the hidden window at runtime.

### [P1] Eager WebGPU load blocks the record hotkey with zero progress feedback, up to 15 minutes on first use
- **Where:** `app/renderer/app/CaptureApp.tsx:95-98`, `CaptureApp.tsx:454-473`, `app/renderer/app/webgpu/inference-orchestrator.ts:76, 162-164`
- **What:** When a WebGPU model is the persisted selection (the expected steady state), `initWebGpuOrchestrator()` fires unconditionally at hidden-window mount (step 4/5 of the timeline) with a 15-minute (`900000`ms) init timeout. While it's loading, pressing the record hotkey does not fall back to the webm/IPC engine path — it's ignored outright, with only a 1.5s tray-color flash as feedback. Download progress is computed (`inference-worker.ts:63-72`) but only reaches `console.log`; it never reaches the tray or any user-visible surface.
- **Evidence:**
  ```ts
  // CaptureApp.tsx:454-458
  if (selectedModelRef.current.startsWith('webgpu-') && !orchestratorRef.current.isReady()) {
    console.log('CaptureApp: Ignoring shortcut — WebGPU model not ready');
    if (!orchestratorRef.current.isLoading()) {
      // Bounded recovery: re-init at most once per 15s and give up after 3
  ```
  ```ts
  // inference-orchestrator.ts:162-164 — progress never leaves the console
  else if (data.type === 'download-progress') {
    console.log(`[Download] ${data.file}: ${(data.loaded/1024/1024).toFixed(1)}/${(data.total/1024/1024).toFixed(1)} MB (${data.pct}%)`);
  }
  ```
- **Impact:** On first WebGPU use (or after a cache wipe from a real model-version bump), a user who presses the hotkey during the ~1.2GB download+warmup gets no feedback beyond a brief tray-error flash, for up to 15 minutes, with no fallback engine — this is exactly the "long unexplained wait, no progress %" friction called out in scope.
- **Fix:** Forward `download-progress` (and load/warmup phase) over IPC to update the tray tooltip or a lightweight overlay with a percentage; consider falling back to the webm/IPC engine path for the first recording while WebGPU warms up in the background, instead of ignoring the keypress.

### [P1] Sequential (non-parallel) model file downloads on the critical cold-start path
- **Where:** `node_modules/parakeet.js/src/hub.js:457-476` (invoked from `app/renderer/app/webgpu/inference-worker.ts:54-73`)
- **What:** `getParakeetModel()` downloads the encoder, decoder, and tokenizer files one at a time in a `for...of` loop with `await` inside, not `Promise.all`. Our code (`inference-worker.ts`) calls `fromHub()` directly with no override or parallel-prefetch workaround.
- **Evidence:**
  ```js
  // node_modules/parakeet.js/src/hub.js:457-476
  for (const file of requiredFiles) {
    try {
      results.urls[file.key] = await getModelFile(repoId, file.name, { ...options, progress });
    } catch (err) { ... }
  }
  ```
- **Impact:** Multi-hundred-MB encoder/decoder files download strictly one after another instead of overlapping, needlessly extending the already-long first-run download that's fully on the critical path to first use.
- **Fix:** This is library-owned code; either request parallel downloads upstream in parakeet.js, or in our own `inference-worker.ts` pre-warm the cache by calling the lower-level `getModelFile` for each required file via `Promise.all` before calling `fromHub()`, so `fromHub()`'s subsequent sequential loop hits a warm cache for every file but the first.

### [P2] Main-process WebGPU "ready" state can go permanently stale after a device-lost or abort teardown
- **Where:** `app/renderer/app/CaptureApp.tsx:72`, `app/stt/webgpu-model-manager.js:18-25`, `app/stt/adapters/webgpu-bridge-adapter.js:79-95, 99-122`
- **What:** `webgpu:model-ready` is invoked with `true` in exactly one place, right after a successful `initialize()`, and is **never** invoked with `false` anywhere in the codebase. `InferenceOrchestrator.disposeSync()` (called on device-lost, 60s-timeout abort, init failure, or unmount) tears the worker down in the renderer but never notifies main process to flip `WebGpuModelManager._ready` back to `false`.
- **Evidence:**
  ```ts
  // CaptureApp.tsx:71-72 — the only call site, always `true`
  const ipc = (window as any).electron?.ipcRenderer;
  if (ipc) ipc.invoke('webgpu:model-ready', true);
  ```
  ```js
  // webgpu-model-manager.js:15-30
  class WebGpuModelManager {
    constructor() { this._ready = false; }
    setReady(ready) { this._ready = ready; log(`WebGpuModelManager: ready=${ready}`); }
    isModelDownloaded() { return this._ready; }
  ```
- **Impact:** After the very first successful load, `getHealth()`/`isAvailable()` in the main process report `state: 'loaded'` / `available: true` forever, even if the renderer's orchestrator has since been torn down by a device-lost event or a 60s safety-timeout abort. Any main-process logic or diagnostics that trust this state (health reporting, future gating logic) will be wrong.
- **Fix:** Send `webgpu:model-ready(false)` from `InferenceOrchestrator.disposeSync()` (or from `CaptureApp`'s `device-lost`/abort handling) whenever the worker is torn down, mirroring the `true` path.

### [P2] Mid-transcription device loss isn't fail-fast — user sees "processing" for up to 60s instead of an immediate error
- **Where:** `app/renderer/app/webgpu/inference-orchestrator.ts:61-70`, `app/renderer/app/CaptureApp.tsx:271-276`
- **What:** The persistent `device-lost` listener in `InferenceOrchestrator` only tears down the worker (`disposeSync()`); it does not reject the in-flight `sendMessage()` promise for a `transcribe` call that may be awaiting a response from the now-terminated worker. That promise sits until its own timeout, or — in practice — until `CaptureApp`'s independent 60s safety timeout fires and resets state (this part is itself correctly guarded against by `isStale()`, so no incorrect UI stomp happens, but the reset is not immediate).
- **Evidence:**
  ```ts
  // inference-orchestrator.ts:65-70
  this.worker.addEventListener('message', (event: MessageEvent) => {
    if (event.data?.type === 'device-lost') {
      console.error('[InferenceOrchestrator] WebGPU device lost — tearing down for clean re-init');
      this.disposeSync();
    }
  });
  ```
- **Impact:** A driver/TDR reset mid-transcription leaves the user staring at "processing" for up to 60 seconds (the width of `CaptureApp`'s safety timeout) before the tray flips to an error state, instead of failing within a second or two of the actual device loss.
- **Fix:** Have the `device-lost` handler also reject any pending `sendMessage()` promise (e.g. via a shared `AbortController`/rejection hook) so an in-flight `transcribe()` call fails immediately instead of waiting out an unrelated timeout.

### [P2] Device-loss watcher requests a different GPU adapter/device than the one actually used for inference
- **Where:** `app/renderer/app/webgpu/inference-worker.ts:81-96`, contrast `node_modules/parakeet.js/src/parakeet.js:178-186, 187-194`
- **What:** parakeet.js explicitly requests `powerPreference: 'high-performance'` for the real compute WebGPU execution provider. Our own loss-watch device (acquired separately, purely to observe `.lost`) is requested with default `powerPreference` (unset).
- **Evidence:**
  ```ts
  // inference-worker.ts:82-84
  const adapter = await (navigator as any).gpu.requestAdapter();
  lossWatchDevice = adapter ? await adapter.requestDevice() : null;
  ```
  ```js
  // parakeet.js:178-186
  baseSessionOptions.executionProviders = [
    { name: 'webgpu', deviceType: 'gpu', powerPreference: 'high-performance' },
    'wasm'
  ];
  ```
- **Impact:** On a hybrid-GPU laptop, Chromium's default (unset) `powerPreference` adapter selection can resolve to a different physical GPU than the one explicitly requested as `high-performance`. The code's own comment claims "a true hardware/driver reset invalidates the whole adapter, so this device's loss is a reliable proxy" — that assumption only holds if both requests resolve to the same adapter, which is UNVERIFIED and not guaranteed by the code as written. A worst case is a silent hang: the real inference device is lost, but the mismatched watch device never fires `.lost`, so the app never self-recovers.
- **Fix:** Request the loss-watch device with the same `powerPreference: 'high-performance'` used by parakeet.js's compute session, to maximize the chance both resolve to the same physical adapter.

### [P2] `WebGpuModelManager.isModelDownloaded(modelId)` ignores its `modelId` argument
- **Where:** `app/stt/webgpu-model-manager.js:27-30`, called from `app/stt/adapters/webgpu-bridge-adapter.js:81`
- **What:** `isModelDownloaded()` takes no parameter and returns a single global `_ready` boolean regardless of what's passed in; the caller passes `this.activeModelId` as if per-model state were tracked.
- **Evidence:**
  ```js
  // webgpu-model-manager.js:27-30
  /** @returns {boolean} Whether the model is loaded and ready for inference. */
  isModelDownloaded() {
    return this._ready;
  }
  ```
  ```js
  // webgpu-bridge-adapter.js:81
  const hasModel = this.activeModelId && this.modelManager.isModelDownloaded(this.activeModelId);
  ```
- **Impact:** Harmless today (there is exactly one WebGPU model, `webgpu-parakeet-0.6b`), but this is a latent bug: the moment a second WebGPU model is introduced, `isAvailable()` would report readiness for the wrong model since state isn't actually keyed by ID.
- **Fix:** Either track `_ready` per model ID (a `Map<string, boolean>`) or rename/document the parameter as currently unused, to avoid a false sense of per-model tracking.

### [P2] No integrity check on cached model blobs
- **Where:** `node_modules/parakeet.js/src/hub.js:161-273` (cache read/write), `app/renderer/app/webgpu/model-cache.ts:1-100` (our own version-key layer on top)
- **What:** `getModelFile()` caches whatever bytes were downloaded with no checksum or expected-size verification, keyed only by `hf-${repoId}-${revision}-${subfolder}-${filename}`. Our `model-cache.ts` layer only tracks a *model-identity* version string (`MODEL_CACHE_VERSION`, line 19) for wholesale cache invalidation — it does not validate individual cached blobs either.
- **Evidence:**
  ```js
  // hub.js:261-270 — blob is cached unconditionally once the read loop completes
  const blob = new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' });
  if (typeof indexedDB !== 'undefined') {
    try { await saveFileToDb(cacheKey, blob); ... }
  ```
- **Impact:** A truncated-but-"successful" fetch (e.g. a proxy or captive portal that closes the stream early but the reader reports `done: true`) would be cached and silently reused on every subsequent launch, producing a corrupt/incomplete model load until the model version key is bumped or the user manually clears storage.
- **Fix:** Verify `blob.size` against the `content-length` header before caching (`hub.js` would need this — it is library-owned), or wrap `getModelFile`'s result in our own worker-side size check before treating `init` as successful.

### [P2] `estimatedVram` heuristic conflates a WebGPU buffer-size limit with total VRAM
- **Where:** `app/renderer/app/webgpu/gpu-detector.ts:38-48`
- **What:** `estimatedVram` is derived purely from `adapter.limits.maxBufferSize`, a WebGPU API cap on single-buffer allocations, not a measurement of total device VRAM.
- **Evidence:**
  ```ts
  // gpu-detector.ts:38-48
  const maxBuffer = adapter.limits.maxBufferSize;
  return {
    ...
    estimatedVram: maxBuffer > 2_000_000_000 ? 'high'
      : maxBuffer > 500_000_000 ? 'medium'
      : 'low',
  };
  ```
- **Impact:** Per this file's own header comment, the result is "used by the SettingsPanel ... to gate the model download option" (SettingsPanel itself is outside this review's scope — the specific gating logic is UNVERIFIED here). If gating logic trusts this value, a GPU with a generous buffer limit but little actual VRAM could be misclassified as capable of the model, or vice versa.
- **Fix:** If VRAM-based gating matters, prefer `navigator.gpu` adapter info / OS-level VRAM queries where available, or clearly relabel this as a buffer-size capability check rather than a VRAM estimate.

### [P3] Worker `dispose()` cleanup message races its own `terminate()` call and typically never runs
- **Where:** `app/renderer/app/webgpu/inference-orchestrator.ts:136-143`
- **What:** `disposeSync()` posts `{type:'dispose'}` and calls `worker.terminate()` on the very next line, synchronously, with no wait for the message to be processed. `Worker.terminate()` halts the worker immediately; the worker-side `dispose()` handler (which destroys `lossWatchDevice` and clears model caches) is very unlikely to run before the thread is killed.
- **Evidence:**
  ```ts
  // inference-orchestrator.ts:137-141
  if (this.worker) {
    try { this.worker.postMessage({ type: 'dispose' }); } catch { /* ok */ }
    this.worker.terminate();
    this.worker = null;
  }
  ```
- **Impact:** Low — `Worker.terminate()` tears down the whole thread and its GPU-object bindings regardless, so this is mostly a dead/misleading code path rather than a resource leak, but it means the explicit `lossWatchDevice.destroy()` call (`inference-worker.ts:154`) essentially never executes.
- **Fix:** Either drop the `postMessage({type:'dispose'})` call (it's not doing useful work) or await a brief ack/timeout before terminating if graceful GPU-resource teardown is actually desired.

### [P3] `requestAdapterInfo()` is a deprecated WebGPU API — forward-compat risk only
- **Where:** `app/renderer/app/webgpu/gpu-detector.ts:37`, `app/stt/adapters/webgpu-bridge-adapter.js:195`
- **What:** `GPUAdapter.requestAdapterInfo()` is deprecated in the WebGPU spec in favor of the synchronous `GPUAdapter.info` property.
- **Evidence:**
  ```ts
  // gpu-detector.ts:37
  const info = await adapter.requestAdapterInfo();
  ```
- **Impact:** UNVERIFIED whether Electron 28's bundled Chromium (~M120) already warns on this call or would break on a future Electron upgrade — would need to be checked against Electron's actual Chromium version and the spec's removal timeline. Flagged as a forward-compatibility risk, not a currently-reproducible defect.
- **Fix:** When bumping Electron, prefer `adapter.info` if available, falling back to `requestAdapterInfo()` for older versions.

---

## Architecture assessment

- **No explicit GPU/session release API exists in parakeet.js** — `ParakeetModel` exposes no `dispose()`/`release()` method for encoder/decoder ONNX sessions (only `resetMelCache()`/`clearIncrementalCache()`, both of which are legitimately used at `inference-worker.ts:117-118, 149-150`). Our code's only recourse for freeing GPU memory is nulling the reference and terminating the worker thread — this is adequate but entirely dependent on worker-thread teardown semantics rather than an explicit, verifiable release.
- **No idle-based model unload.** By design (per project rule to keep the model warm between transcriptions) the ~1.2GB+ model and its GPU buffers stay resident for the entire app lifetime once loaded, with no unload path even after long idle periods or under OS memory pressure. This is intentional, but there's no ceiling — a memory-constrained machine that later comes under pressure from other apps has no way for MVP-Echo to release its footprint short of a full restart.
- **The eager-load path and the "ignore keypress while loading" path compound each other.** Because WebGPU init is eager for the common case (previously-selected model) and there's no fallback engine while it loads, the worst-case first-launch experience is a long, silent, unrecoverable-by-the-user wait window — the two P1 findings above are really one structural problem (no progress surfacing + no graceful degradation) manifesting in two places.
- **Cross-process state is push-only, one-directional, and incomplete.** `webgpu:model-ready` communicates "became ready" from renderer to main but has no corresponding "became unready" signal, so any main-process consumer of engine health can't be trusted once the renderer has torn down and recovered independently (Finding P2-1).
- **The library's own performance ceiling (sequential downloads, per-request batch=1 decode) is invisible to this codebase** — nothing here works around, documents, or surfaces those constraints to the user; they are simply inherited.
- **Diagnostic/telemetry surfaces (download progress, health state) stop at `console.log` or a single boolean** rather than being wired into the tray/UI, meaning the richest failure information the pipeline already computes (per-file byte progress, GPU adapter details) never reaches the person who needs it during a multi-minute cold start.
