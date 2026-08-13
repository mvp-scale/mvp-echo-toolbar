# 08 — Memory Growth & Hangs (follow-up pass)

**Why this file exists:** the original 7-agent review was partitioned by *subsystem*. This is a
partition by *failure mode* — "what grows without bound, and what never resolves." Two P0-class
defects fall in the seams between the original domains and were missed by all seven agents.

**Trigger:** user report of the app "hanging or using too much memory — GPU or RAM, not sure why."

**Status:** mechanism confirmed by code reading. Which of the two is firing in the user's case is
**not** confirmed — see "Discriminating evidence" at the end.

---

### [P0] The orchestrator's failure counter can never increment — the "no thrash" guard is dead code

- **Where:** `app/renderer/app/webgpu/inference-orchestrator.ts:81-92` and `app/renderer/app/CaptureApp.tsx:67-76`
- **What:** `InferenceOrchestrator.initialize()` catches init failure, disposes, and **does not
  re-throw**. The promise resolves normally. `CaptureApp.initWebGpuOrchestrator()` therefore treats
  every failed init as a success: it runs `initFailRef.current = 0` and sends
  `webgpu:model-ready(true)`. Its `catch` block is unreachable on init failure.
- **Evidence:**
  ```ts
  // inference-orchestrator.ts:81-92 — swallows, never rethrows
  } catch (err) {
    console.error('[InferenceOrchestrator] Init failed — disposing worker for clean retry:', err);
    this.disposeSync();
  } finally {
    this.loading = false;
  }
  ```
  ```ts
  // CaptureApp.tsx:67-76 — the catch never fires; the counter resets on failure
  await orchestratorRef.current.initialize(backend, appVersion);
  initFailRef.current = 0; // success resets the failure/backoff counter
  console.log('CaptureApp: WebGPU orchestrator ready');
  const ipc = (window as any).electron?.ipcRenderer;
  if (ipc) ipc.invoke('webgpu:model-ready', true);
  } catch (e) {
    initFailRef.current += 1;
  ```
- **Impact:** The give-up guard at `CaptureApp.tsx:461` (`if (initFailRef.current >= 3)`) can never
  fire, because `initFailRef.current` is always `0`. The only surviving bound is the 15s cooldown at
  `:463`. So a persistently-failing init becomes an **unbounded retry loop: a fresh `Worker` +
  a full ~1.2 GB model load attempt every 15 seconds, for the life of the process.**

  Each cycle allocates a new worker thread and drives `fromHub()` toward a ~1.2 GB resident model
  before `disposeSync()` terminates it. Even if `terminate()` reclaims cleanly, the sustained
  allocate/free churn on a memory-pressured machine presents exactly as "using too much memory,"
  and is self-reinforcing when memory pressure is itself what's failing the init.

  The comment at `CaptureApp.tsx:457-459` names precisely this scenario as the thing being
  guarded against — *"so a reload that keeps failing on a memory-constrained machine can't thrash
  (the 'memory tried-and-reused' loop)"*. The guard doesn't work. The loop it was written to
  prevent is the code's actual behavior.

  Secondary: `webgpu:model-ready(true)` on a failed load makes the main process report a loaded
  model that does not exist — compounding `04-P2` (the flag is never set back to `false`).
- **Fix:** `throw err` at the end of `initialize()`'s catch block, after `disposeSync()`. That alone
  restores the 3-strike bound and stops the false `model-ready`. Move the
  `webgpu:model-ready(true)` invoke to only run when `isReady()` is genuinely true.

---

### [P0] A WebGPU device loss during init wedges the app for 15 minutes with no recording possible

- **Where:** `app/renderer/app/webgpu/inference-orchestrator.ts:65-70`, `:73-77`, `:136-143`, `:145-175`
- **What:** The persistent `device-lost` listener calls `disposeSync()`, which terminates the worker
  and nulls `this.worker`. But the in-flight `sendMessage({type:'init'}, 'ready', 900000)` promise is
  **not rejected**. Its resolve path is a `message` handler on a worker that no longer exists, and its
  only other exit is a **900,000 ms (15 minute)** timeout. `this.loading` is cleared in
  `initialize()`'s `finally`, which cannot run until that promise settles.
- **Evidence:**
  ```ts
  // :65-70 — tears down the worker out-of-band...
  this.worker.addEventListener('message', (event: MessageEvent) => {
    if (event.data?.type === 'device-lost') {
      this.disposeSync();
    }
  });
  ```
  ```ts
  // :73-77 — ...while this promise keeps `loading` true for 15 minutes
  await this.sendMessage({ type: 'init', backend }, 'ready', 900000);
  ```
  ```ts
  // :136-143 — disposeSync clears modelReady but NOT loading
  private disposeSync(): void {
    if (this.worker) { ...; this.worker.terminate(); this.worker = null; }
    this.modelReady = false;
  }
  ```
- **Impact:** For 15 minutes: `isLoading()` returns `true` and `isReady()` returns `false`. Every
  hotkey press hits `CaptureApp.tsx:454-456`, logs *"Ignoring shortcut — WebGPU model not ready"*,
  flashes the tray red for 1.5s, and returns. The re-init recovery at `:456` is itself gated on
  `!isLoading()`, so **the recovery path is disabled by the same stuck flag**. There is no fallback
  to the webm/IPC engine. The app is alive, the tray looks normal, and recording is impossible until
  the 15-minute timeout expires or the user restarts.

  This is the most likely explanation for a reported "hang." Hybrid-GPU laptops and driver/TDR resets
  are the documented trigger the loss-watcher exists for — so the recovery mechanism converts a
  recoverable event into a 15-minute outage.
- **Fix:** Track the pending `sendMessage` rejector and call it from `disposeSync()`, so teardown
  fails the in-flight request immediately. Also clear `this.loading` in `disposeSync()`. The same
  defect applies to the 120s `transcribe` timeout (this is the mechanism behind `04-P2`).

---

### [P1] PCM is structured-cloned to the worker, not transferred — and the empty-result retry triples the copy

- **Where:** `app/renderer/app/webgpu/inference-orchestrator.ts:105-109`, `:173`; `app/renderer/app/CaptureApp.tsx:299-311`
- **What:** `postMessage(message)` is called with **no transfer list**, so the `Float32Array` is
  deep-copied into the worker rather than having its buffer transferred. Separately, the
  empty-result retry calls `trimSilence(pcm)` a **second time**, allocating another array while the
  first `trimmed` is still reachable.
- **Evidence:**
  ```ts
  // inference-orchestrator.ts:105-109, 173 — no transferables
  const result = await this.sendMessage(
    { type: 'transcribe', audio: pcm, sampleRate }, 'transcription-result', 120000
  );
  ...
  this.worker.postMessage(message);   // ← no second argument
  ```
  ```tsx
  // CaptureApp.tsx:300-309 — trimSilence runs twice, both results live at once
  const trimmed = trimSilence(pcm);
  let result = await orchestratorRef.current.transcribe(trimmed, sampleRate);
  ...
  result = await orchestratorRef.current.transcribe(trimSilence(pcm), sampleRate);
  ```
  `trimSilence` itself allocates via `audio.slice(...)` (`CaptureApp.tsx:17`).
- **Impact:** At the 600s cap, one recording is `600 × 16000 × 4 B` = **38.4 MB** of Float32 PCM.
  A normal transcription holds `pcm` + `trimmed` + the worker's clone ≈ **115 MB** transient. On the
  empty-result retry path that becomes `pcm` + `trimmed` + second trim + worker clone ≈ **150 MB+**,
  and the retry is triggered precisely by the empty-transcription bug class that `03-P0`/`03-P1`
  show is still live — so the worst memory path is reached by the most common failure.
- **Fix:** Pass a transfer list — `postMessage(message, [pcm.buffer])` — and reuse the already-computed
  `trimmed` for the retry instead of recomputing `trimSilence(pcm)`.

---

### [P2] `dispose()` never runs, so each surviving init cycle leaks an undestroyed `GPUDevice`

- **Where:** `app/renderer/app/webgpu/inference-orchestrator.ts:136-141`, `app/renderer/app/webgpu/inference-worker.ts:81-96`, `:147-158`
- **What:** Already logged as `04-P3` (cosmetic). Its severity changes in light of the P0 above.
  `disposeSync()` posts `{type:'dispose'}` and calls `terminate()` on the next synchronous line, so
  the worker's `dispose()` — the only caller of `lossWatchDevice.destroy()` — effectively never runs.
  Every init that gets *past* `fromHub()` acquires a fresh `GPUDevice` via `adapter.requestDevice()`
  that is never explicitly destroyed.
- **Evidence:**
  ```ts
  // inference-orchestrator.ts:137-141
  try { this.worker.postMessage({ type: 'dispose' }); } catch { /* ok */ }
  this.worker.terminate();
  ```
  ```ts
  // inference-worker.ts:83-84 — a new device per successful model load
  const adapter = await (navigator as any).gpu.requestAdapter();
  lossWatchDevice = adapter ? await adapter.requestDevice() : null;
  ```
- **Impact:** Combined with the unbounded 15s re-init loop, repeated cycles that reach the
  post-`fromHub()` stage each acquire a GPU device with no explicit release. Worker `terminate()`
  should reclaim GPU resources on context teardown, but that is driver- and Chromium-dependent and
  is **UNVERIFIED** here. This is the most plausible mechanism for *GPU* (as opposed to RAM) growth.
  Note the scope limit: an init that fails *during* `fromHub()` never reaches line 83, so this
  accumulates only on cycles that load the model and then fail or get torn down later.
- **Fix:** Await a brief ack (or a ~100ms timeout) before `terminate()`, so `dispose()` actually runs.
  Confirm with `chrome://gpu` / Task Manager GPU-memory readings across forced re-init cycles.

---

## Discriminating evidence — what to collect

All three mechanisms produce "hangs or uses too much memory," but they leave **different log
signatures**. The main-process log is at:

```
%TEMP%\mvp-echo-toolbar-debug.log
```

`clearLog()` runs on every app start (`main-simple.js` startup), so the file **must be copied before
restarting the app**.

| Log line | Confirms |
|---|---|
| Repeated `[InferenceOrchestrator] Init failed — disposing worker for clean retry` | P0 #1 — the dead failure counter. Count them: >3 proves the guard never fired. |
| Repeated `CaptureApp: orchestrator idle — re-initializing` at ~15s spacing | P0 #1 — the unbounded loop is running. |
| `CaptureApp: orchestrator init failed 3× — not auto-retrying` **absent** while the above repeat | P0 #1, conclusively. |
| `[ParakeetWorker] WebGPU device lost: reason=…` followed by ~15 min of `Ignoring shortcut — WebGPU model not ready` | P0 #2 — the 15-minute wedge. |
| `CaptureApp: SAFETY TIMEOUT — processing exceeded 60s` | the transcribe-path variant of P0 #2. |
| `CaptureApp: empty result for real audio — retrying once` | P1 — the tripled-PCM path, and confirms the `03` empty-recording cluster is firing in the field. |

Pair with Task Manager: **RAM climbing in ~1.2 GB sawteeth every ~15s** → P0 #1. **GPU memory
climbing monotonically and never returning** → P2. **Flat memory, dead hotkey** → P0 #2.
