# STT Engine Abstraction Layer — Architectural Review

## Engine inventory

| Engine | File | Implements port? | Reachable from main? | Remote/local |
|---|---|---|---|---|
| RemoteAdapter | `app/stt/adapters/remote-adapter.js` | Yes — all 7 port methods | Yes — instantiated at `engine-manager.js:33`, wired into IPC (`cloud:*`, `engine:*`) | Remote (user-configured bring-your-own server; no hardcoded vendor endpoint found) |
| LocalSidecarAdapter | `app/stt/adapters/local-sidecar-adapter.js` | Yes — all 7 port methods | Yes — instantiated at `engine-manager.js:36` | Local (spawns `sherpa-onnx-offline.exe` subprocess per call) |
| WebGpuBridgeAdapter | `app/stt/adapters/webgpu-bridge-adapter.js` | Partial — `transcribe()` unconditionally throws by design; the other 6 methods are implemented | Config/health/model-list/switch reachable via IPC; `transcribe()` is dead code from the main process's perspective — actual transcription happens renderer-side via `parakeet.js`/`InferenceOrchestrator`, bypassing this adapter and `processAudio` entirely | Local (on-device GPU, but through the renderer, not main) |
| WhisperRemoteEngine | `app/stt/whisper-remote.js` | **No** — has `testConnection()`/`loadConfig()`/`getConfig()` but no `isAvailable()`, `getHealth()`, `switchModel()`, or `listModels()`; does not conform to the current port at all | **No** — confirmed via repo-wide grep, nothing `require()`s this file except itself | Remote (fully dead code) |
| LocalModelManager | `app/stt/local-model-manager.js` | N/A — not an adapter, a path-resolution helper consumed by LocalSidecarAdapter | Yes, indirectly | n/a |

**Does any code path send audio off-device implicitly? No.** `RemoteAdapter.transcribe()` throws immediately unless `this.isConfigured` (`remote-adapter.js:79-81`), which is only set true after the user explicitly saves an `endpointUrl` via Settings (`configure()` at `remote-adapter.js:367-375`, wired from `SettingsPanel.tsx`). No hardcoded remote endpoint exists anywhere in `app/stt/` or `app/main/` (grepped). `EngineManager.initialize()` only auto-selects the remote adapter if the user already configured and it responds (`engine-manager.js:104-111`), or as a last-resort *inactive* fallback for the Settings UI to configure (`engine-manager.js:123-128`) — it never transcribes without configuration.

---

### [P1] Retry logic re-sends an already-drained FormData stream, breaking the retry it's meant to provide
- **Where:** `app/stt/adapters/remote-adapter.js:104-109`, `app/stt/adapters/remote-adapter.js:410-442`
- **What:** `transcribe()` builds a single `form-data` `FormData` object (backed by `combined-stream`) and passes it as `options.body` into `_fetchWithRetry`. On a 500-504 response, `_fetchWithRetry` calls `fetch(url, options)` again with the **same** `options.body` reference. `combined-stream`'s `resume()` sets `this._released = true` on the first pipe and drains `this._streams` to empty before calling `this.end()` → `_reset()` (`node_modules/combined-stream/lib/combined_stream.js`). On the second `pipe()` (the retry), `resume()` sees `_released` already `true` and skips re-draining — no bytes are written to the retry request body, even though `Content-Length` was computed from the original full payload.
- **Evidence:**
  ```js
  // remote-adapter.js:104-109
  const response = await this._fetchWithRetry(this.endpointUrl, {
    method: 'POST',
    headers: headers,
    body: formData,
    timeout: 120000, // 2 min for large audio
  });
  ```
  ```js
  // remote-adapter.js:410-425 (_fetchWithRetry reuses the same `options` / body on retry)
  async _fetchWithRetry(url, options, retries = this.maxRetries) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, options);
        if (response.status >= 500 && response.status <= 504 && attempt < retries) {
          const delay = Math.pow(2, attempt) * 1000;
          ...
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
  ```
- **Impact:** Any transient 500-504 from the user's configured remote server causes the "retry" to send a body with a declared `Content-Length` but zero actual bytes. The server either errors immediately or the connection hangs until node-fetch's own 120s `timeout` fires. Net effect: a transient server hiccup that the retry logic exists specifically to smooth over instead **doubles latency and still fails**, and the user sees a generic "transcription failed" after ~4 minutes instead of a quick recovered success.
- **Fix:** Don't reuse a stream-backed body across retry attempts — either rebuild the `FormData` (and re-read `fs.readFileSync(audioFilePath)`) inside the retry loop, or read the audio into a `Buffer` once and construct a fresh `FormData` per attempt from that buffer.

---

### [P1] Stale persisted WebGPU preference silently overrides the just-computed "best available adapter"
- **Where:** `app/stt/engine-manager.js:87-129` (`initialize`), `app/stt/engine-manager.js:152-193` (`_restoreModelSelection`), `app/stt/adapters/webgpu-bridge-adapter.js:153-158` (`getConfig`)
- **What:** `initialize()` correctly probes each adapter's live availability and picks the first one that's really usable (webgpu → remote → local). It then unconditionally calls `_restoreModelSelection()`, which — regardless of which adapter `initialize()` just selected — re-forces `activeAdapter`/`activeAdapterName` to WebGPU if `webgpuConfig.activeModelId && webgpuConfig.isConfigured` is true. But `WebGpuBridgeAdapter.getConfig()`'s `isConfigured` is just `!!activeModelId` — it does **not** check whether the model is actually downloaded or whether the GPU is actually present, i.e. it does not use the same live probe `isAvailable()` uses. The code comment even flags this: "config only, no async probe".
- **Evidence:**
  ```js
  // engine-manager.js:152-163
  _restoreModelSelection() {
    try {
      const remoteConfig = this.remoteAdapter.getConfig();
      // Check WebGPU adapter's saved model first (config only, no async probe)
      const webgpuConfig = this.webgpuAdapter.getConfig();
      if (webgpuConfig.activeModelId && webgpuConfig.isConfigured) {
        this.selectedModelId = webgpuConfig.activeModelId;
        this.activeAdapter = this.webgpuAdapter;
        this.activeAdapterName = 'webgpu';
  ```
  ```js
  // webgpu-bridge-adapter.js:153-158 — isConfigured never checks download/GPU state
  getConfig() {
    return {
      activeModelId: this.activeModelId,
      isConfigured: !!this.activeModelId,
    };
  }
  ```
- **Impact:** Scenario: WebGPU worked in a prior session (config persisted), then the GPU becomes unavailable or the ~1.2GB IndexedDB model cache is evicted before the next launch. `initialize()`'s live `webgpuAdapter.isAvailable()` check correctly returns false and the code falls through to select a working adapter (e.g. local-sidecar). `_restoreModelSelection()` then immediately clobbers that correct choice, forcing `activeAdapterName='webgpu'` and `selectedModelId` back to a `webgpu-*` value. The renderer (`CaptureApp.tsx:95-98`) trusts `cloud:get-config`'s `selectedModel` to decide routing and will auto-init the WebGPU orchestrator; if it isn't ready in time, `CaptureApp.tsx:454-456` **silently ignores the user's shortcut press** ("WebGPU model not ready") instead of using the perfectly good local/remote adapter that was just verified available.
- **Fix:** Only let `_restoreModelSelection()` win when it agrees with (or re-validates against) the live availability result from `initialize()`, e.g. skip the WebGPU-preference branch entirely when `webgpuResult.available` was false, rather than restoring blind from disk.

---

### [P1] LocalSidecarAdapter spawns a fresh subprocess (full model load) on every transcription
- **Where:** `app/stt/adapters/local-sidecar-adapter.js:44-77`
- **What:** `transcribe()` calls `spawn(binaryPath, args, ...)` fresh for every single request; `sherpa-onnx-offline.exe` is a one-shot CLI that loads the ONNX model from disk and exits after processing one file. There is no persistent/warm process for the local engine.
- **Evidence:**
  ```js
  // local-sidecar-adapter.js:44-77
  async transcribe(audioFilePath, _options = {}) {
    const binaryPath = this.modelManager.getBinaryPath();
    ...
    return new Promise((resolve, reject) => {
      const args = [
        '--nemo-ctc-model=' + modelFile,
        '--tokens=' + tokensFile,
        '--num-threads=4',
        audioFilePath,
      ];
      ...
      const child = spawn(binaryPath, args, { env, cwd: binDir, windowsHide: true, timeout: 120000 });
  ```
- **Impact:** Every local-CPU transcription pays full model-load latency in addition to inference time — directly contradicts the project's own STT convention ("Keep models loaded between transcriptions... Avoid reloading model on each request", `.claude/rules/stt.md`). On a low-end CPU this can dominate perceived latency for short recordings.
- **Fix:** If `sherpa-onnx` supports a long-running server/daemon mode, switch to spawning once and streaming requests to it; otherwise keep a warm subprocess pool, or document/accept the tradeoff explicitly (currently it looks like an oversight, not a decision — nothing in the code or comments acknowledges it).

---

### [P2] `switchModel()`'s remote branch commits `activeAdapter` before the switch is confirmed, unlike the other two branches
- **Where:** `app/stt/engine-manager.js:312-346`
- **What:** For `webgpu-*` and `local-*` models, the code `await`s the adapter's own `switchModel()` **before** reassigning `this.activeAdapter`/`this.activeAdapterName` — so a failure leaves the manager pointed at whatever was working before. The `else` (remote) branch does the opposite: it reassigns `this.activeAdapter = this.remoteAdapter` and `this.activeAdapterName = 'remote'` **first**, then awaits `this.remoteAdapter.switchModel(modelId)`, which can throw (e.g. endpoint not configured, network error).
- **Evidence:**
  ```js
  // engine-manager.js:314-319 (local/webgpu: await THEN commit — safe on failure)
  if (modelId.startsWith('webgpu-')) {
    await this.webgpuAdapter.switchModel(modelId);
    this.activeAdapter = this.webgpuAdapter;
    this.activeAdapterName = 'webgpu';
  ```
  ```js
  // engine-manager.js:334-339 (remote: commit THEN await — unsafe on failure)
  } else {
    // Switch to remote adapter + delegate model switch to server
    this.activeAdapter = this.remoteAdapter;
    this.activeAdapterName = 'remote';
    await this.remoteAdapter.switchModel(modelId);
    this.selectedModelId = modelId;
  ```
- **Impact:** If a user tries to switch to a remote/gpu model and the switch fails (server unreachable, bad model id), `switchModel()` returns `{success:false, error}` as expected — but `activeAdapter` has already been silently changed to `remoteAdapter`. The previously-active, working adapter (e.g. local-sidecar) is now deactivated even though the requested switch failed. The next recording attempt is routed to a remote adapter that may not even be configured, producing a confusing failure instead of falling back to the working engine that was live moments earlier.
- **Fix:** Mirror the local/webgpu ordering — `await this.remoteAdapter.switchModel(modelId)` first, and only reassign `activeAdapter`/`activeAdapterName`/`selectedModelId` after it resolves successfully.

---

### [P2] `getStatus()` treats an "error" health state as "available"
- **Where:** `app/stt/engine-manager.js:352-361`
- **What:** `getStatus()`'s `available` flag is computed as `health.state !== 'unavailable'`. `RemoteAdapter.getHealth()` can legitimately return `state: 'error'` (e.g. `remote-adapter.js:229-231` when the `/health` endpoint responds non-OK) or `state: 'degraded'`. Both of those are reported as `available: true` to the renderer/status bar.
- **Evidence:**
  ```js
  // engine-manager.js:352-361
  async getStatus() {
    const health = await this.activeAdapter.getHealth();
    const config = this.activeAdapter.getConfig();
    return {
      adapter: this.activeAdapterName,
      available: health.state !== 'unavailable',
      health: health,
      config: config,
    };
  }
  ```
- **Impact:** The status bar (per `.claude/rules/stt.md`, StatusBar is supposed to reflect health) can show the active engine as "available" while its own health object says `error`/`degraded`, giving the user false confidence right before a transcription attempt fails.
- **Fix:** `available` should be `health.state === 'loaded'` (or explicitly exclude both `'unavailable'` and `'error'`), not just exclude `'unavailable'`.

---

### [P2] No abort/cancel path for an in-flight transcription
- **Where:** `app/stt/engine-manager.js:209-277` (`processAudio`), `app/stt/adapters/remote-adapter.js:78-149` (`transcribe`), `app/stt/adapters/local-sidecar-adapter.js:44-113` (`transcribe`)
- **What:** `AbortController` is only used for `RemoteAdapter.isAvailable()`/`getHealth()` (10s timeouts, `remote-adapter.js:168-169`, `215-216`). Neither `RemoteAdapter.transcribe()`, `LocalSidecarAdapter.transcribe()`, nor `EngineManager.processAudio()` expose any cancellation mechanism — they only carry fixed upper-bound timeouts (120s fetch timeout, 120s subprocess timeout). There is no IPC channel to cancel an in-flight `processAudio` call.
- **Evidence:**
  ```js
  // local-sidecar-adapter.js:72-77 — no cancel handle returned/stored anywhere
  const child = spawn(binaryPath, args, {
    env,
    cwd: binDir,
    windowsHide: true,
    timeout: 120000,
  });
  ```
- **Impact:** `CaptureApp.tsx` itself relies on giving up locally after ~60s and treating any later response as "stale" (per its own comments), rather than actually cancelling the backend work — the underlying HTTP request or subprocess keeps running/holding resources for up to the full 120s regardless of what the UI shows the user.
- **Fix:** Thread an `AbortController`/cancellation token through `EngineManager.processAudio()` into each adapter's `transcribe()`, and expose an IPC channel (e.g. `processAudio:cancel`) that the renderer's 60s safety valve can call instead of just locally ignoring the result.

---

### [P2] UNVERIFIED: spawned child processes are not tracked or killed on app quit
- **Where:** `app/stt/engine-manager.js:602-647` (`_convertWebmToWav`, ffmpeg), `app/stt/adapters/local-sidecar-adapter.js:58-112` (sherpa-onnx), `app/main/main-simple.js:446-453` (`will-quit`/`before-quit`)
- **What:** Both the ffmpeg conversion child and the sherpa-onnx transcription child are created as local variables inside their respective functions (`const child = spawn(...)`) and never stored on `this` or any registry the app can reach at shutdown. `main-simple.js`'s `will-quit`/`before-quit` handlers only unregister the global shortcut and destroy the tray — they never reference `engineManager` or any spawned child process.
- **Evidence:**
  ```js
  // main-simple.js:446-453 — no child-process cleanup
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('before-quit', () => {
    trayManager.destroy();
    log('MVP-Echo Toolbar: Shutting down');
  });
  ```
- **Impact:** If the user quits the app while a local-CPU transcription or WebM→WAV conversion is in flight, the spawned `.exe` may keep running/holding the model files open after the Electron process exits. **UNVERIFIED** — confirming actual behavior requires a runtime test on Windows (quit mid-transcription, check Task Manager for an orphaned `sherpa-onnx-offline.exe`/`ffmpeg.exe`); Node's default (non-detached) `spawn()` does not guarantee child termination when the parent exits, especially on Windows.
- **Fix:** Track active child-process handles on `EngineManager`/`LocalSidecarAdapter` and `child.kill()` them from `before-quit`; consider `windowsHide`+process-group kill (`taskkill /pid ... /t /f` on Windows) since `child.kill()` alone doesn't reliably kill a full Windows process tree.

---

### [P3] Dead code: `whisper-remote.js` / `WhisperRemoteEngine` — 447 lines, fully unreferenced, and doesn't conform to the current port
- **Where:** `app/stt/whisper-remote.js:1-447`
- **What:** Repo-wide grep for `require(...whisper-remote...)` and `WhisperRemoteEngine` turns up no references anywhere except the file itself and one comment in `remote-adapter.js` acknowledging it as the predecessor ("maintaining backward compatibility with the previous whisper-remote.js config file"). `main-simple.js` only instantiates `EngineManager`, which only instantiates `RemoteAdapter`/`LocalSidecarAdapter`/`WebGpuBridgeAdapter`. This class also does not implement the current Engine Port at all — it has `testConnection()` instead of `isAvailable()`/`getHealth()`, and no `switchModel()`/`listModels()`.
- **Evidence:**
  ```js
  // whisper-remote.js:24-35 — no isAvailable/getHealth/switchModel/listModels
  class WhisperRemoteEngine {
    constructor() {
      this.endpointUrl = null;
      this.apiKey = null;
      this.selectedModel = 'gpu-english';
      ...
      this.loadConfig();
    }
  ```
- **Impact:** Dead weight and a maintenance trap — it duplicates (and re-introduces) the same FormData-retry-reuse bug described above (`whisper-remote.js:208-213`, `fetchWithRetry` at `51-76`), so anyone tempted to resurrect it inherits that bug too. It also contains a Whisper-specific hallucination-filtering pipeline (`removeRepetitions`, `removeTrailingPhraseRepetitions`, `removeKnownHallucinations`, `deduplicateSegments`) that the live `RemoteAdapter` does not have — a comment in the dead file (`whisper-remote.js:191`, "legacy — ignored by Parakeet TDT server") suggests this was intentionally dropped when the backend moved from Whisper to Parakeet TDT, but that rationale lives only in a dead file's comment, not anywhere near the live code.
- **Fix:** Delete `whisper-remote.js`, or if the hallucination-filtering rationale needs to be preserved for a future Whisper-backed server, move that one comment/decision into `remote-adapter.js` and delete the rest.

---

### [P3] `engine-port.js` documents `isAvailable()` as returning a boolean; every real adapter returns an object
- **Where:** `app/stt/engine-port.js:78-80`, contrasted with `app/stt/adapters/remote-adapter.js:163-200`, `app/stt/adapters/local-sidecar-adapter.js:146-156`, `app/stt/adapters/webgpu-bridge-adapter.js:79-95`
- **What:** The port's authoritative doc says `isAvailable() @returns {Promise<boolean>}`. Every actual adapter returns `{available: boolean, error?: string}`. All call sites correctly use `.available`, so this isn't currently causing a runtime bug — but it's stale/wrong documentation for what's explicitly described as "the authoritative documentation" for the contract (`engine-port.js:6`). Live evidence that this ambiguity has already caused defensive/dead code: `engine-manager.js:115` checks `localResult.available || localResult === true`, i.e. someone hedged against the possibility that `isAvailable()` might return a raw boolean per the (wrong) doc.
- **Evidence:**
  ```js
  // engine-port.js:78-80
  * │  async isAvailable()                                                │
  * │    Check whether this adapter's backend is reachable / ready.       │
  * │    @returns {Promise<boolean>}                                      │
  ```
  ```js
  // engine-manager.js:114-115 — defensive code hedging against the doc's claimed boolean shape
  const localResult = await this.localSidecarAdapter.isAvailable();
  if (localResult.available || localResult === true) {
  ```
- **Impact:** Low runtime risk today (nothing relies on the boolean shape), but it's exactly the kind of drift that causes a real bug the next time someone adds an adapter by reading the port doc literally.
- **Fix:** Update the JSDoc typedef to `@returns {Promise<{available: boolean, error?: string}>}` and remove the dead `=== true` branch at `engine-manager.js:115`.

---

### [P3] Remote API key persisted in plaintext JSON on disk
- **Where:** `app/stt/adapters/remote-adapter.js:466-479` (`_saveConfig`), `app/stt/adapters/remote-adapter.js:56-61` (constructor/`configPath`)
- **What:** `apiKey` is written unencrypted to `toolbar-endpoint-config.json` in the Electron `userData` directory, and returned verbatim to the renderer on every `cloud:get-config` call.
- **Evidence:**
  ```js
  // remote-adapter.js:466-479
  _saveConfig() {
    try {
      const config = {
        endpointUrl: this.endpointUrl,
        apiKey: this.apiKey,
        selectedModel: this.selectedModel,
        language: this.language,
      };
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
  ```
- **Impact:** Low severity for a bring-your-own-key local desktop app (matches typical Electron config-file patterns), but any other local process/user account with filesystem read access to `userData` can read the key in plaintext.
- **Fix:** Consider Electron's `safeStorage` API to encrypt the `apiKey` field at rest, matching what a "privacy-first" positioning implies for any secret material, even self-hosted ones.

---

## Architecture assessment

- **The port is documentation-only and has already drifted from the adapters it documents.** `isAvailable()`'s claimed `Promise<boolean>` vs. actual `{available, error}` shape (finding above) shows there's no automated conformance check — nothing would catch a new adapter that actually followed the written contract literally.
- **Two independent "which adapter is active" algorithms exist and silently fight each other.** `initialize()`'s live-probe selection and `_restoreModelSelection()`'s persisted-config restore both mutate `activeAdapter`/`activeAdapterName`/`selectedModelId`, with the second unconditionally overriding the first with no re-validation — a structural bug, not a typo (the code's own comment flags the gap and doesn't close it).
- **State-mutation ordering is inconsistent across near-identical branches.** `switchModel()`'s three branches (webgpu/local/remote) each commit adapter state at a different point relative to the awaited call, so error-path behavior silently diverges per branch with no shared "attempt, then commit" helper.
- **WebGPU — the flagship, best-quality engine — has no real `transcribe()` in the abstraction the review targets.** The port's `transcribe()` for `WebGpuBridgeAdapter` exists purely to throw; the actual transcription logic lives entirely in the renderer (`parakeet.js`/`InferenceOrchestrator`) via a separate IPC surface (`webgpu:*`) that bypasses `processAudio`/`EngineManager.processAudio` entirely. The hexagonal abstraction doesn't actually cover the highest-value engine's real data path — it only covers config/health/model-list plumbing for it.
- **A generic retry helper was applied without accounting for body reusability.** `_fetchWithRetry` is shared between a JSON-body call (`switchModel`, safe to replay) and a FormData-stream-body call (`transcribe`, not safe to replay) — the abstraction that was supposed to centralize resilience logic instead silently breaks one of its two callers.
- **Duplication over reuse.** `whisper-remote.js` is a complete, never-imported second implementation of the remote engine with its own copy of the same retry bug, and three adapters each hand-roll near-identical `_loadConfig`/`_saveConfig` JSON read/write logic rather than sharing a small config-persistence helper — evidence of copy-paste growth rather than a maintained shared base.
