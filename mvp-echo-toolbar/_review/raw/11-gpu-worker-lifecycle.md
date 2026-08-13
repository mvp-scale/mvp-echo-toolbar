# GPU & Worker Resource Lifecycle Audit — MVP-Echo Toolbar (parakeet.js v1.4.4)

Scope: `app/renderer/app/webgpu/*`, `app/renderer/app/CaptureApp.tsx`, `node_modules/parakeet.js/src/*`,
`node_modules/parakeet.js/node_modules/onnxruntime-web` (v1.24.1) and `onnxruntime-common`.
Read-only review; no source modified. `_review/` was not used as evidence — every claim below is
independently re-derived from the files cited.

---

## 1. Resource Ledger

| Resource | Created at | Approx bytes | Released by what | Actually released? |
|---|---|---|---|---|
| Encoder `ort.InferenceSession` (WebGPU EP, forced **fp32** — int8 unsupported on WebGPU) | `parakeet.js:270` `encoderSession = await createSession(encoderUrl, encoderSessionOptions)`; forced fp32 at `hub.js:426-429` | **ESTIMATED**, majority of the ~1.2GB model budget (fp32 = largest component) — not independently measured | `session.release()` exists (`onnxruntime-common inference-session.d.ts:463`) → `wasm-core-impl.ts:534 releaseSession()` → `jsepOnReleaseSession` (frees GPU buffers) + `_OrtReleaseSession` (frees WASM-side session) | **NO** — never called anywhere in `parakeet.js` (`grep -rn "\.release(" src/` → zero matches). Relies entirely on worker teardown. |
| Decoder/Joiner `ort.InferenceSession` (WASM EP always, int8) | `parakeet.js:271` `joinerSession = await createSession(decoderUrl, decoderSessionOptions)`; decoder forced to WASM in hybrid mode at `backend.js:222-224` | **ESTIMATED**, small (int8, decoder+joiner params are a minority of the 0.6B model) | Same `release()` path as above | **NO** — same, unreached |
| GPUDevice acquired internally by onnxruntime-web's WebGPU JSEP backend | `onnxruntime-web/lib/wasm/jsep/backend-webgpu.ts:257` `this.device = await adapter.requestDevice(...)` | n/a (handle) | Pinned to `env.webgpu.device` via `Object.defineProperty(..., {writable:false, configurable:false})` (`backend-webgpu.ts:275-281`) — **one-shot per module instance**, cannot be reassigned in-place | Only via whole-realm teardown (worker termination) — GPU-side reclaim **UNVERIFIED** (see §3) |
| GPU buffer free-list pool (encoder activations/intermediates) | `onnxruntime-web/.../gpu-data-manager.ts:190` `GpuDataManagerImpl`, `freeBuffers: Map<number, GPUBuffer[]>` | Scales with largest T×D intermediate seen; **grows, never shrinks** within a session | `release(id)` at `gpu-data-manager.ts:364` explicitly does **not** destroy — "*Put the pending buffer to freeBuffers list instead of really destroying it for buffer reusing*" (`gpu-data-manager.ts:404-405`). True free only via `dispose()` (`gpu-data-manager.ts:440`) | **NO** — `dispose()` is only reachable from `session.release()`, never called |
| Second, independent `GPUDevice` — the app's own "loss watch" device | `inference-worker.ts:83-84` `adapter.requestDevice()` stored in `lossWatchDevice` | n/a (near-zero, no buffers allocated on it) | `dispose()` in `inference-worker.ts:153-156` calls `lossWatchDevice.destroy()` | Conditionally yes, but **only if the worker-side `dispose()` handler actually runs** — see §3/CLAIM B, generally does not |
| Downloaded model blobs pinned via un-revoked Blob URLs | `hub.js:205-273 getModelFile()` — downloads full response into a `chunks` array, builds one `Blob`, caches to IndexedDB, returns `URL.createObjectURL(blob)` | Same order of magnitude as the encoder/decoder/tokenizer files (~most of 1.2GB) **in addition to** whatever ORT copies internally | `URL.revokeObjectURL()` | **NO** for encoder/decoder/preprocessor/external-data URLs — only `getModelText()` (`hub.js:282-288`, used for the tokenizer text file) revokes its blob URL. The model-weight blob URLs are never revoked. |
| IndexedDB-cached model blob (`parakeet-cache-db`/`file-store`) | `hub.js:178-187 saveFileToDb`, mirrored by `model-cache.ts` (same DB/store names) | ~1.2GB on disk | Browser storage eviction or `clearParakeetStore()` (`model-cache.ts:45-54`, only on model-identity change) | This is disk-backed storage, not renderer RAM — out of scope for a "leak", included for completeness |
| Mel/feature scratch buffers — `JsPreprocessor._paddedBuffer` (Float64) | `mel.js:392` init, grown at `mel.js:454-457` (`if (!this._paddedBuffer \|\| this._paddedBuffer.length < paddedLen)`) | Up to ~77MB for a 10-min (`MAX_RECORDING_S=600`, `CaptureApp.tsx:25`) recording padded buffer | Never explicitly freed; only grows | **NO** shrink path — grows to high-water mark, held for the life of the `JsPreprocessor` (= life of the worker) |
| `IncrementalMelProcessor._rawBuffers[0/1]`, `_featuresBuffer` | `mel.js:659-663` | Same order as above per buffer | `reset()` (`mel.js:670-677`) explicitly says "*We retain the allocated buffers to avoid re-allocation next time*" | **NO** — by design. (Note: in this app's actual call pattern `prefixSamples` is never passed — `inference-worker.ts:125-129` — so this path is effectively dormant; the plain `JsPreprocessor._paddedBuffer` above is the one actually exercised.) |
| Decoder LSTM state tensors, per-step joiner I/O tensors | `parakeet.js:304-394 _runCombinedStep` | Small (few KB per tensor) | Explicit `.dispose()` calls throughout `_runCombinedStep`/`transcribe` (`parakeet.js:328-353`, `691-694`, `734`, `891`, `896/921`, `1014`, `1124`) | **YES** — this per-call tensor hygiene is actually well done; not a leak source |
| `_incrementalCache: Map` (streaming decoder-state cache) | `parakeet.js:109-110` | Bounded, LRU-evicted at `maxIncrementalCacheSize=50` (`parakeet.js:945-951`) | `clearIncrementalCache()`, called every transcription by `inference-worker.ts:118` | **YES**, bounded and actively cleared each call |
| Worker's own JS heap / WASM linear memory (onnxruntime-web WASM runtime) | Implicit, created on `new Worker(...)` (`inference-orchestrator.ts:57-60`) and grown by `WebAssembly.Memory.grow` inside ORT-WASM | Ratchets to high-water mark of largest audio processed this worker lifetime; WASM memory can only grow (`memory.grow`), never shrink — this is a core WebAssembly spec property, not implementation-specific | `Worker.terminate()` | **YES for JS heap & WASM memory** (realm/isolate teardown) — spec/engine behavior, not a session-level API call. **GPU-side companion resources: UNVERIFIED** (see §3). |

---

## 2. Four repeated-cycle scenarios

**(a) Init fails repeatedly.**
Each attempt: `prepareModelCache()` → `new Worker()` → `fromHub()` (network/IndexedDB read, partial session creation) → failure → `InferenceOrchestrator.disposeSync()` (`inference-orchestrator.ts:88-89`) terminates that worker. Per-cycle, whatever GPU allocation the failed attempt made before failing is only as reclaimed as `worker.terminate()` actually reclaims GPU state (UNVERIFIED, §3). Because of **CLAIM A** (confirmed below), the intended 3-strike hard stop never engages — `initFailRef` is unconditionally reset to `0` on every attempt since `initialize()` never rejects. The only throttle left is the 15s cooldown gate at `CaptureApp.tsx:463`, and that gate is only even consulted **on a user keypress** (not a timer), so this is not a silent runaway loop — but it is an **unbounded** number of full worker-spin-up/spin-down cycles if a user (or a scripted retry) keeps pressing the shortcut every >15s. Each cycle is a fresh `Worker` → fresh onnxruntime-web module instance → fresh `GPUDevice` attempt (per the non-configurable `env.webgpu.device` singleton, §1), so if GPU reclaim on terminate is slow/incomplete, this is the scenario most likely to show monotonic VRAM growth.

**(b) `abort()` from the 60s safety timeout, then re-init.**
`CaptureApp.tsx:271-276`: on the 60s safety timeout, `orchestratorRef.current.abort()` → `disposeSync()` (`inference-orchestrator.ts:132-134`) terminates the worker mid-transcription. The entire ~1.2GB resident model (GPU buffers + WASM session + JS-side Blob-pinned download) is discarded via `worker.terminate()`. The next raw-PCM recording attempt needs a **new** worker + **new** `GPUDevice` (the old one cannot be reused/reset in place — it was a non-configurable one-shot property on the terminated module instance anyway). If GPU-side reclaim from the prior terminate() lags the new worker's device acquisition (plausible: Chromium's GPU-process cleanup is an async, cross-process operation, while the new worker can request a device almost immediately), repeated timeouts (e.g. a flaky machine where transcription regularly exceeds 60s) are the clearest path to transient-but-stacking VRAM growth. This matches the user's "unreproducible growth" report better than any of the other three scenarios.

**(c) WebGPU `device-lost` then re-init.**
Two sub-cases:
- *Device lost while idle/ready* (not mid-init): the persistent listener (`inference-orchestrator.ts:65-70`) fires, `disposeSync()` terminates cleanly, `modelReady=false`, next shortcut press re-inits normally. No wedge.
- *Device lost while an `initialize()` is in flight* (i.e. during warmup, `inference-worker.ts:98-102`, after the loss-watch device is armed at `inference-worker.ts:81-96`): this is **CLAIM B**, confirmed below — `this.loading` stays `true` for up to 15 minutes (`inference-orchestrator.ts:76`, `900000` ms timeout), and recovery is self-gated off (`CaptureApp.tsx:456 if (!orchestratorRef.current.isLoading())`). During the wedge nothing *new* is created (recovery is disabled), so this scenario is not a multiplying leak by itself, but it does leave one worker's resources in an indeterminate reclaim state for up to 15 minutes, and the app appears completely dead (every shortcut press ignored, no fallback to the cloud/IPC path) for that whole window — a severe correctness bug riding alongside the resource question. If `device-lost` recurs (e.g. a hybrid-GPU laptop with repeated TDR resets), each occurrence can independently wedge another 15-minute window.

**(d) User switches models in Settings mid-session.**
Traced the full path: `SettingsPanel.tsx:352-359 handleSelectModel` → IPC `engine:switch-model` → `engine-manager.js:312-346 switchModel()`. Only when the **new** model starts with `webgpu-` does it `webContents.send('webgpu:init-orchestrator')` (`engine-manager.js:322-326`), which `CaptureApp.tsx:127-137` forwards into `initWebGpuOrchestrator()`.
- **Switching away from WebGPU to local/remote**: confirmed by code — `switchModel()`/`switchAdapter()` in `engine-manager.js` only reassign `this.activeAdapter`; nothing ever calls `orchestratorRef.current.dispose()` in the renderer. The already-loaded ~1.2GB WebGPU worker (GPU buffers + WASM session + un-revoked Blob) **stays fully resident, doing nothing, for the rest of the app session** — this is not a hypothetical, it is the code's actual behavior today.
- **Switching between two WebGPU models**: currently moot — `app/stt/webgpu-model-manager.js:12` defines exactly one `MODEL_ID = 'webgpu-parakeet-0.6b'`, so there is no second model to switch to today. But the mechanism is latently broken: `initWebGpuOrchestrator()` (`CaptureApp.tsx:52`) early-returns whenever `orchestratorRef.current.isReady()` is already true, regardless of *which* model is loaded — there is no model-identity check. If a second `webgpu-*` model is ever added, switching to it while another is loaded would silently keep serving the old model; nothing would dispose+reload.

---

## 3. Precision on what `Worker.terminate()` reclaims

| Layer | Guarantee | Basis |
|---|---|---|
| JS heap | Effectively guaranteed | HTML spec: `terminate()` discards the worker's whole global environment/agent; every conformant engine tears down the isolate/heap for that agent. Not literal "memory freed" spec text, but a necessary consequence of any working worker implementation — no known counterexample. |
| WASM linear memory | Effectively guaranteed | It is just a special `ArrayBuffer` living inside the same JS realm above; realm teardown takes it with it. Separately, `WebAssembly.Memory.grow()` is one-directional by the core WASM spec (no shrink instruction in the profile ORT-WASM uses here), which is *why* it never shrinks **while the worker is alive**, but that's orthogonal to what terminate() reclaims. |
| WebGPU `GPUDevice` + `GPUBuffer`s | **UNVERIFIED** | The WebGPU spec does not mandate synchronous or even prompt reclaim of native GPU allocations tied to a destroyed execution context. In Chromium, GPU resources are owned by an out-of-process GPU process reached via Mojo IPC; cleanup on renderer/worker-context destruction is asynchronous and implementation-specific. Nothing in this codebase or in onnxruntime-web calls `device.destroy()` or the buffers' `.destroy()` explicitly on worker teardown (only the app's own `lossWatchDevice.destroy()` in `inference-worker.ts:154`, which itself likely never runs — see CLAIM B). **Test that would settle it**: run N cycles of `orchestrator.initialize()` → `orchestrator.abort()` in the actual Electron app, and watch Chromium's GPU-process memory (`chrome://gpu`, or the OS-level "Dedicated GPU Memory" counter for the Electron GPU process in Task Manager / `nvidia-smi`) across cycles with a short settle delay between each; growth that fails to return to baseline confirms the leak empirically. |
| ONNX sessions' GPU handles | **UNVERIFIED**, compounded | Same as above, plus the fact that even the *intended* clean path (`session.release()` → `jsepOnReleaseSession` → real buffer destroy per `wasm-core-impl.ts:534-560`) is never invoked in the first place — so even in the best case there is no explicit release, only whatever `terminate()` does implicitly. |

---

## 4. Adversarial verdicts

### CLAIM A — **CONFIRMED** (and the actual defect is a notch worse than stated)

`inference-orchestrator.ts:81-92`:
```ts
} catch (err) {
  console.error('[InferenceOrchestrator] Init failed — disposing worker for clean retry:', err);
  this.disposeSync();
} finally {
  this.loading = false;
}
```
No `throw err;` — `initialize()` **always resolves**, never rejects, regardless of what failed inside. Consequently at `CaptureApp.tsx:67-76`:
```ts
await orchestratorRef.current.initialize(backend, appVersion);
initFailRef.current = 0; // success resets the failure/backoff counter
console.log('CaptureApp: WebGPU orchestrator ready');
const ipc = (window as any).electron?.ipcRenderer;
if (ipc) ipc.invoke('webgpu:model-ready', true);
} catch (e) {
  initFailRef.current += 1;
  ...
}
```
the `catch` block is unreachable from an orchestrator init failure. Worse than "never increments": `initFailRef.current = 0` on line 68 runs **unconditionally on every call**, actively resetting any prior count, and `ipc.invoke('webgpu:model-ready', true)` fires a **false-positive** "ready" signal to the main process even when the model failed to load. The 3-strike guard at `CaptureApp.tsx:461` (`if (initFailRef.current >= 3)`) is therefore permanently dead code — `initFailRef.current` can never reach a value >0 via this path. The only real bound on repeated re-init attempts is the 15s cooldown at `CaptureApp.tsx:463`, and it is only consulted per user keypress, not a background timer.

### CLAIM B — **CONFIRMED**

The persistent device-lost listener, `inference-orchestrator.ts:65-70`:
```ts
this.worker.addEventListener('message', (event: MessageEvent) => {
  if (event.data?.type === 'device-lost') {
    console.error('[InferenceOrchestrator] WebGPU device lost — tearing down for clean re-init');
    this.disposeSync();
  }
});
```
runs independently of the `sendMessage()` promise's own listener. `disposeSync()` (`inference-orchestrator.ts:136-143`) terminates the worker and nulls it, but never touches the pending `sendMessage` promise created for the in-flight `{type:'init'}` call. That promise's own handler (`inference-orchestrator.ts:158-165`) only settles on `responseType` (`'ready'`) or `'error'` — a `'device-lost'` message matches neither branch and is silently ignored by it. Once the worker is terminated, it can never post `'ready'` or `'error'`, so the promise can **only** settle via its `setTimeout(..., timeoutMs)` — and for `init` that timeout is `900000` ms (`inference-orchestrator.ts:76`, 15 minutes). Until then, `this.loading` stays `true` (the `finally { this.loading = false; }` at line 90-92 only runs once the promise settles). `CaptureApp.tsx:456`:
```ts
if (!orchestratorRef.current.isLoading()) {
  // ...bounded lazy recovery...
}
```
gates the entire recovery block on `!isLoading()`, so recovery is self-disabled for that whole window. The realistic trigger window is real, not contrived: the loss-watch device is armed at `inference-worker.ts:81-96` (after `fromHub()` returns) and warmup — a genuine GPU compute call — runs right after at `inference-worker.ts:99-101`; a TDR/driver reset during warmup is exactly the kind of event this watcher exists to catch. One nuance flagged as **UNVERIFIED**: if the same device loss also makes `model.transcribe(warmup, ...)` throw, the worker's own `try/catch` in `self.onmessage` (`inference-worker.ts:26-43`) would post `{type:'error', ...}`, which *would* settle the promise properly — whether `'error'` or `'device-lost'` "wins" is a cross-thread timing race not resolvable by static reading. But this does not save the claim: the worker is terminated by `disposeSync()` as soon as `'device-lost'` is *processed* by the persistent listener, and there's no guarantee the WASM-side `transcribe()` throws synchronously/promptly on a lost device rather than hanging on an in-flight GPU submission — so the wedge is a reachable, not merely theoretical, outcome. **Test that would settle the race precisely**: force a device loss during warmup (e.g. via `chrome://gpucrash` or manually calling `device.destroy()` on the internal ORT device from devtools mid-warmup) and log the arrival order of `'error'` vs `'device-lost'` in `InferenceOrchestrator`.

---

## 5. Findings by severity

**HIGH**
1. `ort.InferenceSession.release()` — the only clean GPU+WASM release path (confirmed to exist and to actually free buffers, `onnxruntime-web wasm-core-impl.ts:534-560` → `jsepOnReleaseSession` + `_OrtReleaseSession`) — is **never called** anywhere in `parakeet.js`. All release is implicit, via whole-worker termination, and the GPU portion of that is UNVERIFIED (§3).
2. Switching from a WebGPU model to a local/remote engine in Settings never disposes the orchestrator (`engine-manager.js:312-346` never reaches `orchestratorRef.current.dispose()`). The ~1.2GB GPU+WASM-resident worker stays alive, idle, for the rest of the app session — confirmed by code, not speculative.
3. CLAIM A confirmed: the 3-strike init-failure guard (`CaptureApp.tsx:461`) is dead code; `initFailRef` is unconditionally reset to 0 on every attempt because `initialize()` never rejects (`inference-orchestrator.ts:81-92`), and the main process is falsely told the model is ready (`ipc.invoke('webgpu:model-ready', true)`) even after a swallowed failure.
4. CLAIM B confirmed: a device-lost during init wedges `isLoading()===true` for up to 15 minutes, during which the recovery path is fully self-gated off (`CaptureApp.tsx:456`) — the app is unresponsive to the shortcut with no fallback for the entire window.
5. onnxruntime-web's WebGPU `GpuDataManager` free-list (`gpu-data-manager.ts:190-405`) deliberately retains "released" intermediate GPU buffers for reuse rather than destroying them; true release only happens via `dispose()`, which is unreachable (finding 1). Combined with parakeet.js's own grow-only JS buffers (`mel.js` `_paddedBuffer`), both VRAM and JS heap ratchet to the largest-audio high-water mark and **stay there for the life of one worker** — which, absent an error/model-switch, is the entire app session.

**MEDIUM**
6. Model-weight Blob URLs from `hub.js:getModelFile()` (encoder/decoder/preprocessor/external-data) are never revoked via `URL.revokeObjectURL()` — only the tokenizer text file's blob URL is (`hub.js:286`, inside `getModelText`). This pins an extra ~encoder+decoder-file-sized `Blob` in the worker's JS heap on top of whatever onnxruntime-web copies internally, for the life of the worker.
7. The worker-side `dispose()` handler (`inference-worker.ts:147-158`) is very unlikely to ever execute: `disposeSync()` (`inference-orchestrator.ts:137-141`) calls `worker.postMessage({type:'dispose'})` then `worker.terminate()` on the very next synchronous line with no yield point in between — even the modest cleanup it does (null `model`, destroy `lossWatchDevice`) is effectively dead code in practice.
8. Repeated-init-failure thrash (scenario a) is bounded to at most one attempt per 15s per keypress, but is not bounded in *count* since the 3-strike stop is dead (finding 3) — a persistent user can drive an indefinite number of full worker/GPU-device spin-up-then-terminate cycles.
9. `env.webgpu.device` is set via a non-configurable `Object.defineProperty` (`backend-webgpu.ts:275-281`) — one `GPUDevice` per onnxruntime-web module instance, no in-place recovery possible. This is *why* the app's design always terminates the whole worker to recover from a device problem; it also means there is no cheaper recovery available even if the swallowed-error / dead-guard bugs above were fixed.

**LOW / INFO**
10. WASM linear memory growth is monotonic by WASM spec (no shrink), so any single long recording within an otherwise-normal session permanently raises that worker's memory footprint until the next dispose/re-init — which, given findings 2–4, may not happen for a long time in ordinary use.
11. Per-call tensor hygiene inside `parakeet.js`'s decode loop (`_runCombinedStep`, `transcribe`) is actually solid — logits/state tensors are consistently disposed, and `_incrementalCache` is bounded and cleared every call (`inference-worker.ts:118`). The leak surface here is architectural (session/device-level), not the per-token decode hot path.
