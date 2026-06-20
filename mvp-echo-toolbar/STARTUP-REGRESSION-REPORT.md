# Root-Cause Report: MVP-Echo Toolbar Sluggish Startup

> **Method:** multi-agent investigation (2 recon agents → 5 performance/architecture hypothesis lenses → **two independent red teams** per finding → solution-architect synthesis). 15 findings were adjudicated. Every load-bearing claim is grounded in a real `file:line` and a verified commit SHA. Red Team A audited evidence integrity; Red Team B attacked mechanism and whether each finding is a genuine *regression* (vs. pre-existing code).
>
> **Generated:** 2026-06-19 · branch `dev` · HEAD `6b56300` (v3.0.23)

---

## 1. Bottom line

The startup slowdown is a real, recent regression on the cold-start path, and it is **storage/IO + serialization bound — not GPU math** (which is why an RTX 3090 doesn't help). The single most defensible root cause is **eager auto-init of the WebGPU orchestrator on every launch**, introduced in `e2f6e51` (3.0.9): when a `webgpu-*` model was previously selected, mount now spawns a worker and loads the ~1.2 GB parakeet model from IndexedDB + warmup on every launch — work that **never happened at launch before**. The strong amplifier is the **serialized `whenReady` chain** in the main process (`e2f6e51`): the global record hotkey is not registered until the renderer's `did-finish-load` and a cross-process GPU probe both complete.

Critically, the recon's *headline* claim — that `35f0d42`'s `navigator.storage.persist()` became a "1.2 GB durability commit" — was **refuted by both mechanism skeptics and is almost certainly wrong**. Do not anchor the fix on it.

## 2. Confirmed root cause(s)

### A. Eager auto-init of the WebGPU orchestrator on every launch (PRIMARY)
**Finding:** `renderer-onmount-auto-init-orchestrator` / `eager-autoinit-model-load-on-launch`

- **Mechanism:** On mount, `loadConfig()` reads the saved model and, if it starts with `webgpu-`, calls `initWebGpuOrchestrator()`, which runs `orchestrator.initialize()` → worker spawn → `fromHub('parakeet-tdt-0.6b-v2')` loading the ~1.2 GB model from the IndexedDB blob cache + a `lossWatchDevice` acquisition + a warmup `model.transcribe()`.
- **Evidence (verified by reading the files):**
  - `mvp-echo-toolbar/app/renderer/app/CaptureApp.tsx:95-98` — `if (selectedModelRef.current.startsWith('webgpu-')) { ... initWebGpuOrchestrator(); }` (commit `e2f6e51`).
  - The pre-image (deleted in `e2f6e51`) literally read: `// Load saved config on mount — do NOT auto-init WebGPU orchestrator // (download only happens when user explicitly clicks download in settings)`.
  - `mvp-echo-toolbar/app/renderer/app/webgpu/inference-worker.ts:54` `fromHub(...)`, `:81-96` second `requestAdapter()/requestDevice()`, `:98-101` warmup transcribe (worker logic from `2407e63`, loaded eagerly by `e2f6e51`).
  - `git log -S "Restored WebGPU model"` → only `e2f6e51`.
- **Before → after:** Before `e2f6e51`, no model load, no worker spawn, no IndexedDB read at launch — the model loaded only when the user explicitly selected/downloaded it. After, every cold start with a remembered `webgpu-*` model eagerly loads the full model.
- **Why it bites a 3090:** The dominant cost is deserializing ~1.2 GB out of IndexedDB and uploading force-fp32 encoder weights to the GPU — storage-read + memory-bandwidth + PCIe-upload bound, not compute. The 3090 only makes the small warmup shader-compile fast.
- **Red-team scores:** Team A 0.85–0.88 (evidence clean, real regression). Team B 0.74 and 0.5 — confirms it is a genuine new regression but correctly flags one overstatement: the call at `CaptureApp.tsx:97` is **fire-and-forget (unawaited)** and the heavy work runs **in a Web Worker, off the UI thread**, so it does *not* hard-block the record hotkey. It injects heavy unprompted IO/CPU/GPU-upload contention and delays first-usable local transcription.

### B. Serialized `whenReady` chain gating the record hotkey (AMPLIFIER)
**Finding:** `main-didfinishload-gate` / `renderer-loadconfig-blocks-on-ready-promise`

- **Mechanism:** `app.whenReady()` runs `createHiddenWindow()`, then **awaits** the renderer's `did-finish-load`, then **awaits** `engineManager.initializeAndSignalReady()` (which does an `executeJavaScript` GPU-adapter probe in the renderer), and **only then** registers the global record shortcut.
- **Evidence (verified by reading the files):**
  - `mvp-echo-toolbar/app/main/main-simple.js:398-405` (await `did-finish-load`), `:409` (await `initializeAndSignalReady()`), `:415` (`globalShortcut.register`). Commit `e2f6e51`.
  - `mvp-echo-toolbar/app/stt/engine-manager.js:94` awaits `webgpuAdapter.isAvailable()` → `_probeGpu()` `executeJavaScript`; `:135-141` resolves `_readyPromise` only after `initialize()`. The `cloud:get-config` handler awaits `_readyPromise`, so the renderer's `loadConfig()` (and thus the auto-init in A) is serialized behind the main-process probe.
- **Before → after:** At `e2f6e51^`, `whenReady` did `createHiddenWindow(); await engineManager.initialize();` then registered the shortcut — **without** first awaiting `did-finish-load`. After `e2f6e51`, hotkey registration sits behind the full renderer bundle load + a main↔renderer GPU-probe round-trip.
- **Why it bites a 3090:** Bundle parse/evaluate + an IPC round-trip are fixed wall-clock costs independent of GPU throughput.
- **Red-team scores:** Team A 0.74 (evidence clean, real regression). Team B 0.25 — argues the *delta* over the parent is modest because the parent already required the renderer loaded to run the probe, and on a 3090 the probe/IPC is tens-to-low-hundreds of ms. Honest read: **real but secondary** — an amplifier, not the dominant cost.

## 3. Plausible but unconfirmed

- **`dep-2` unpinned-lockfile dependency drift.** `package-lock.json` is untracked (`git ls-files package-lock.json` is empty), so CI/build does a fresh unpinned `npm install`. `parakeet.js` is `^1.4.4` — a fresh install could resolve a newer 1.4.x/1.5.x with a heavier WASM/init. **What's missing:** no committed lockfile to diff and no byte-diff of the shipped bundle, so this is theoretical. Worth excluding only if the timer experiment (§6) shows model-load/WASM-init time grew across builds at the *same* code commit.
- **Magnitude of the eager-init cost itself.** We have proven the work now happens at launch; we have **not** measured how many seconds it costs on the 3090 (IndexedDB read + GPU upload). The fix is justified regardless (unprompted heavy work on launch), but the *attribution of the user's perceived sluggishness* needs the §6 timing to be airtight.

## 4. Refuted / ruled out

- **`persist-grant-makes-storage-persist-block` / `main-persistent-storage-grant` (the recon's headline).** **Refuted.** `navigator.storage.persist()` flips a per-origin eviction-exemption flag (O(1) metadata write); it does **not** rewrite/re-fsync the 1.2 GB blob. It also short-circuits on `await navigator.storage.persisted()` (`model-cache.ts:24`), so persist() runs **at most once ever** (first launch), not every launch. Cannot explain a recurring slowdown. (Team A cut to 0.35, Team B to 0.05–0.08.)
- **`prepare-cache-now-unconditional`.** **Refuted as a regression.** `appVersion` comes from `api.getAppVersion()` which returns a truthy string on every normal launch, so the old `if (appVersion)` guard was already satisfied — `prepareModelCache()` already ran every launch since `e2f6e51`. Dropping the guard is a no-op on the normal path. (Team B 0.12.)
- **`clear-store-on-key-migration-onetime`.** **Ruled out.** The `clear()` only fires on a `model:`-prefixed key change; legacy app-version keys migrate silently, and `MODEL_CACHE_VERSION` hasn't changed since it was introduced — so it is unreachable on any current 3.0.23 cold start. (Both teams ~0.05.)
- **`appversion-keyed-cache-wipe-forced-full-redownload`.** **Self-refuting at HEAD.** This per-update wipe+re-download existed only in the `e2f6e51..35f0d42` window and was **fixed** by `35f0d42`. HEAD reuses the cached blob. (Team B 0.10.)
- **`warmup-and-worker-9ad6438-not-startup-regressions`.** Confirmed NOT a regression — warmup is a single 1s-silence transcribe unchanged since `2407e63`; `9ad6438` only throttled download logging (reduces work). (Both teams 0.90.)
- **`main-diag-handlers-not-regression` / `diag-console-gate-not-a-regression`.** Confirmed NOT a regression — `DIAG_ENABLED` is off by default, handlers short-circuit, and `e56c3db` actually *reduced* per-call `console.log` IPC. (Both teams ~0.90.)
- **`dep-1-noble-hashes-pin` (`6b56300`).** Ruled out — build-time-only `overrides` for a packaging transitive dep; not imported in app source, never loaded at runtime. (Both teams ~0.96.)
- **`dep-3-no-recent-vite-bundle-config-change`.** Ruled out — `vite.config.ts` last touched in `17fc451` and that change was only a dev-server port bump; WebGPU/worker/optimizeDeps config unchanged since April. (Both teams ~0.88.)

## 5. Recommended fixes (ranked, minimal-risk)

1. **Stop eager-loading the model on every launch — make it lazy or idle-deferred.** *(PRIMARY — fixes finding A.)*
   `mvp-echo-toolbar/app/renderer/app/CaptureApp.tsx:95-98`: remove the on-mount `initWebGpuOrchestrator()` call, OR defer it off the critical path. Best options, lowest risk first:
   - Defer behind `requestIdleCallback` / a short `setTimeout` so mount and first paint complete before the worker spawns; or
   - Make it truly lazy: kick off `initWebGpuOrchestrator()` on the **first record keypress** (the audio path is already lazy there), keeping a "warming…" UI state.
   This restores the pre-`e2f6e51` behavior (no unprompted ~1.2 GB load at launch) while preserving the "don't re-select the model" convenience.

2. **De-serialize the `whenReady` chain so the record hotkey registers immediately.** *(AMPLIFIER — fixes finding B.)*
   `mvp-echo-toolbar/app/main/main-simple.js:398-415`: register `globalShortcut` **first**, then run `await did-finish-load` and `engineManager.initializeAndSignalReady()` as fire-and-forget (`.catch(log)`). The shortcut just posts `global-shortcut-toggle` to the hidden window; gating it on the GPU probe is unnecessary. Also drop the `_readyPromise` await in the `cloud:get-config` handler (`engine-manager.js`) so the renderer's `loadConfig()` isn't chained behind the main-process probe.

3. **Remove redundant GPU-adapter acquisitions.** Cold start currently calls `requestAdapter()` three times: `_probeGpu` (`webgpu-bridge-adapter.js`), `CaptureApp.tsx:57`, and `inference-worker.ts:83`. Cache/share one result. Low impact individually, but free latency once #1/#2 are done.

4. **Commit a `package-lock.json`** so builds are reproducible and dependency drift can be ruled out as a future regression vector (see §3).

## 6. How to verify (cheapest experiments on the 3090 box)

1. **Timer probe (decisive, ~10 min).** Wrap the launch path with `performance.now()` checkpoints and log each delta:
   - `inference-orchestrator.initialize()` total, split into: `prepareModelCache()`, worker spawn, `fromHub()` (model load), `lossWatchDevice` acquire, warmup transcribe.
   - In `main-simple.js`: time `did-finish-load`, `initializeAndSignalReady()`, and the moment `globalShortcut.register` returns.
   Run twice (warm IndexedDB). **Expectation if finding A is correct:** `fromHub()` dominates (multi-second) and it begins at mount with no user action.

2. **A/B the fix cheaply.** Temporarily comment out the auto-init at `CaptureApp.tsx:95-98` and relaunch. If "ready/usable" perception improves sharply, finding A is confirmed as the dominant cost.

3. **Disprove the storage red herring directly.** Log `t0=performance.now()` around `navigator.storage.persist()` in `model-cache.ts:25`. Expectation: single-digit ms, and it only runs on the very first post-update launch (`persisted()` returns true thereafter). This confirms the refutation in §4.

4. **Bisect anchor.** If you want a clean before/after, check out `e2f6e51^` and time launch-to-hotkey-ready vs HEAD — this is the last-known-good point per the timeline.

> **Honest caveat:** the evidence cleanly proves *what* changed and *when* (eager model-load-on-launch in `e2f6e51` + the serialized `whenReady`), but **no one has yet measured the actual seconds on the 3090**. The fixes are safe and justified regardless, but run experiment #1 before declaring the magnitude attribution closed.
