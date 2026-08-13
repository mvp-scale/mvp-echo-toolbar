# Phase 1 adversarial review — bugs introduced by `515f4fc..HEAD`

Scope: `git diff 515f4fc..HEAD -- mvp-echo-toolbar/app` (the 7 landed fixes: 0a, 0b, T1, 1, 5, 3, 3b,
4, 9). Read-only review of the actual files at HEAD, not just the diff hunks. Goal: bugs the change
set introduced, not pre-existing issues.

Commits reviewed:
```
6ad64be Fixes 1, 5: devicechange can't truncate a recording; warm mic must prove it's live
20e3658 Fixes 0a, 0b, T1: orchestrator failures surface; teardown settles in-flight work
5a33e9e Fixes 3, 3b, 4: hotkey live at launch; bounded renderer load; correct dev/prod gate
3515c42 Fix 9: stale WebGPU preference no longer overrides a live GPU probe
f3c915c Phase 0: add typecheck + test harness (no behaviour change)
```

---

## CRITICAL

None found. No crash / data-loss / permanent-hang scenario was constructible against the reachable
call graph.

---

## IMPORTANT

### I1 — Permanent load-failure tray state is erased by the very next hotkey press

`mvp-echo-toolbar/app/main/main-simple.js:479-487`:
```js
if (!engineReady) {
  log(`Global ${shortcutLabel} received before engine ready - ignoring`);
  trayManager.setState('starting');
  return;
}
```

`mvp-echo-toolbar/app/main/main-simple.js:508-521` (the failure path this interacts with):
```js
const loadResult = await waitForFirstLoad(hiddenWindow);
if (!loadResult.ok) {
  ...
  try { trayManager.setState('error'); } catch (_e) { /* ignore */ }
  engineManager.abortInitialization(loadResult.reason);
  return;
}
```

**Concrete scenario:** the hidden renderer fails to load (bad build, corrupted `dist/renderer`, slow
disk past the 15s bound). `waitForFirstLoad` resolves `{ok:false}`, tray flips to `error`,
`abortInitialization()` releases `_readyPromise`, and the `whenReady` callback `return`s — `engineReady`
is now `false` **forever** for this session; nothing ever retries the load or calls
`initializeAndSignalReady()` again. The user, seeing the error icon, presses the hotkey (the natural
thing to do). The handler's `if (!engineReady)` branch unconditionally calls
`trayManager.setState('starting')` — overwriting the `error` icon/tooltip with "Starting up..." even
though startup has permanently failed and nothing is in progress. Every subsequent press repeats this.
The one diagnostic signal fix 4 was built to surface is erased by the first user interaction with it,
and the "Starting up..." tooltip actively misleads the user into thinking it will resolve on its own.

Note `_review/recon/D-startup-sequencing.md:220-227` explicitly floated retrying
(destroy+recreate `hiddenWindow`) "on the next hotkey press" as part of the design — that retry was
never implemented; the shipped handler only resets tray state and returns, so "Starting up..." is a
dead end, not a retry-in-progress indicator.

**Verdict for focus area 5 (startup reorder) otherwise: clean.** `engineReady` is never left false
after a genuinely successful boot; the load-failure path correctly skips engine init;
`abortInitialization()` is safe to call regardless of whether `initializeAndSignalReady()` will ever
run (it only resolves `_readyPromise`, which nothing double-resolves in this flow).

---

### I2 — `micReleasePending` (new in this diff) is never cleared by `cleanup()`/`teardownRawEngine()`

`mvp-echo-toolbar/app/renderer/app/audio/AudioCapture.ts:415-431`:
```js
requestMicRelease(reason: string): void {
  if (this.rawWorklet) {
    this.micReleasePending = true;
    dlog(`[AudioCapture] ${reason} during recording — deferring mic release until stop`);
    return;
  }
  ...
}

applyPendingMicRelease(): void {
  if (!this.micReleasePending) return;
  this.micReleasePending = false;
  ...
}
```

`cleanup()` (`AudioCapture.ts:694-747`) and `teardownRawEngine()` (`AudioCapture.ts:466-477`) both tear
down `rawWorklet`/`rawStream` directly (stopping tracks, nulling refs) but **neither touches
`micReleasePending`**. The field is new in this diff (`git diff` confirms `cleanup()` itself is
untouched by the change set). The only place that clears it is `applyPendingMicRelease()`, called from
exactly one place: `stopRawRecording()` (`AudioCapture.ts:681-686`).

**Concrete scenario:** a `devicechange` fires while `rawWorklet` is live (mid-recording) →
`requestMicRelease('devicechange')` sets `micReleasePending = true` (correct, deferred per Fix 1's own
design). If that recording is then torn down through `cleanup()` instead of through
`stopRawRecording()` — e.g. a synchronous throw from `rawSource.connect(rawWorklet)`/`rawWorklet.connect
(rawSink)` inside `startRawRecording()` after worklet creation, feeding into the `startFn.catch()`
handler at `CaptureApp.tsx:515-523`, or any future caller of `teardownRawEngine()` — the flag is never
flushed. It survives as `true` into the *next*, unrelated recording. That next recording completes
normally through `stopRawRecording()`, which now takes the `if (this.micReleasePending)` branch
(`AudioCapture.ts:681-682`) and force-releases the just-used warm mic stream — silently defeating
`micReleaseMode: 'keep-ready'` for that cycle, with no corresponding real device event.

**Reachability caveat:** the normal recording lifecycle always exits through `stopRawRecording()`, so
this requires an abnormal exit (a start-time exception after worklet creation, or a future
`teardownRawEngine()`/`cleanup()` call site introduced later) — I could not construct a fully realistic
trigger against the *current* call graph (verified no caller invokes `teardownRawEngine()` at all, and
`cleanup()`'s mid-recording callers all run before the worklet exists or after `stopRawRecording()`
already flushed the flag). Rated IMPORTANT rather than CRITICAL for that reason, but it is a genuine,
untested invariant gap introduced alongside the new field — `test/audio-capture.test.mjs` only exercises
the `stopRawRecording()`-mediated flush, never a `cleanup()` bypass. Fix: clear `micReleasePending =
false` in both `cleanup()` and `teardownRawEngine()`.

**Verdict for focus area 3 (deferred mic release) otherwise: clean and test-covered.** The
`rawWorklet`-keyed defer/flush design correctly handles the windows explicitly called out in the task
(between `getUserMedia` resolving and worklet creation there is no `await` for a `devicechange`
macrotask to land in — confirmed by tracing `startRawRecording()`'s tail as one synchronous block with
no yield points).

---

### I3 (lower severity, latent API gap) — `abort()`/`dispose()` during `prepareModelCache()` is silently swallowed

`mvp-echo-toolbar/app/renderer/app/webgpu/inference-orchestrator.ts:78-103` vs. `:173-196`:
```js
this.loading = true;
try {
  await prepareModelCache();          // <-- no worker, no `pending` yet
  if (!this.worker) {
    const created = this.createWorker();   // still runs even if disposeSync() ran meanwhile
    ...
```
```js
private disposeSync(reason?: Error): void {
  const pending = this.pending;
  if (pending) { this.pending = null; pending.reject(...); }   // no-op: pending is null here
  if (this.worker) { ... }                                      // no-op: worker is null here
  this.modelReady = false;
  // `loading` deliberately not cleared
}
```

**Concrete scenario:** `initialize()` is in flight and currently awaiting `prepareModelCache()` (before
a worker exists and before any `sendMessage` has set `this.pending`). A caller invokes `abort()`/
`dispose()` in this window. `disposeSync()` finds `pending === null` and `worker === null`, so it does
nothing — there is nothing to reject or terminate. `loading` stays `true` (owned by `initialize()`'s
`finally`, by design). `prepareModelCache()` is not cancellable, so the original `initialize()` call
resumes when it resolves, creates a worker, sends `init`, and — on success — completes normally,
leaving a live worker and `modelReady = true` despite the abort/dispose request having been made. The
caller's attempt to cancel is silently lost.

**Reachability caveat:** in the current wiring, `dispose()`/`abort()` on `orchestratorRef.current` in
`CaptureApp.tsx` only fires from (a) the 60s safety-timeout in `performStop()`, which only runs after
`stopRawRecording()`/`transcribe()` — i.e. never while an *init* is in the `prepareModelCache()` phase
(transcribe requires `modelReady`, impossible during init) — or (b) the component-unmount cleanups,
which in practice coincide with the whole renderer process being torn down (hidden window
destroy/recreate), so there is no surviving JS context to observe the swallowed abort. I could not
construct a scenario reachable through the app's actual call graph today. Flagging as a latent
correctness gap in `InferenceOrchestrator`'s general contract (worth hardening — e.g. a `cancelled`
flag checked after `prepareModelCache()` resolves — if `abort()` is ever wired to a user-facing "cancel
download" affordance in the future).

---

## MINOR

### M1 — `initialize()`'s return value doesn't reflect `_restoreModelSelection()`'s override (pre-existing, unchanged by the collapse)

`mvp-echo-toolbar/app/stt/engine-manager.js:96-132`: `result` is captured from the initial
webgpu/remote/local-sidecar probe and returned as-is after `await this._restoreModelSelection()`, even
though that call can reassign `this.activeAdapter`/`this.activeAdapterName`/`this.selectedModelId` to
something different. Confirmed via `git show 515f4fc:...engine-manager.js` that this was **also** true
before the diff (each branch called `this._restoreModelSelection()` — then synchronous, not awaited —
immediately before its own `return`, so the returned `result` never reflected the restore either). The
only functional consumer is a log line in `main-simple.js:526`
(`log('EngineManager initialized: ' + JSON.stringify(engineStatus))`), so this has no behavioural
impact — noted only because focus area 6 explicitly asked whether the collapse preserved return-value
semantics. It does (unchanged, for better or worse).

**Verdict for focus area 6 (engine selection) otherwise: clean.** The single `_restoreModelSelection()`
call site is now correctly `await`ed (previously fire-and-forget, though harmless then since the
function was synchronous); no other caller invokes it. `gpuUsable` is computed correctly whichever of
the two webgpu-preference routes (`webgpuConfig.activeModelId` vs. `remoteConfig.selectedModel`
prefixed `webgpu-`) is the only one present — traced both single-route cases and the both-present /
conflicting case by hand against `engine-manager.js:171-241`.

### M2 — persistent `device-lost` listener is never removed from superseded workers

`mvp-echo-toolbar/app/renderer/app/webgpu/inference-orchestrator.ts:94-102`. Every worker gets its own
`addEventListener('message', ...)` for `device-lost`; there is no matching `removeEventListener` when
that worker is superseded/terminated. Harmless in practice — the identity guard (`if (this.worker !==
created) return;`) neutralizes stale events, and a terminated `Worker` object with a dangling listener
is still eligible for GC once dereferenced. Not a leak, just noted for completeness.

---

## Per-focus-area verdicts

1. **Rethrow (0a) — unhandled rejections / 3-strike interaction:** CLEAN. Exactly one real call site
   (`CaptureApp.tsx:67`), reached only through `initWebGpuOrchestrator()`, which wraps the call in
   try/catch on all three invocation sites (mount auto-init, `webgpu:init-orchestrator` IPC, hotkey
   re-init). `AlreadyLoadingError`'s early return correctly skips the strike counter *and* the ready
   IPC in the losing side of the mount-vs-IPC race — verified the *winning* concurrent call
   independently fires both, so nothing is dropped.
2. **`loading` ownership split (0b):** CLEAN for every path reachable through the app's current call
   graph — `disposeSync()`'s synchronous `pending.reject()` unwinds `initialize()`'s `await` in the
   same microtask chain, so `finally` always runs promptly (this is a *fix* for the previous 15-minute
   wedge, not a new one). `transcribe()`'s `pending` and `initialize()`'s `pending` can never coexist
   (the single-slot invariant is protected by `transcribe()` requiring `modelReady`, which is false for
   the whole duration of an init). See I3 for the one latent (unreachable-today) gap: dispose during
   the pre-worker `prepareModelCache()` window is a silent no-op, not a stuck-`loading` bug.
3. **Deferred mic release (1):** CLEAN for the `rawWorklet`-keyed defer/flush core logic, which is
   test-covered. See I2 for the one real gap: `cleanup()`/`teardownRawEngine()` don't clear the new
   `micReleasePending` flag.
4. **Warm gate (5):** CLEAN. Fallback timer is unconditionally armed at the end of
   `startRawRecording()` (both warm and cold) and cleared in all three exit paths
   (`stopRawRecording()`, `cleanup()`, `fireCaptureReady()` itself). `captureReadyFired`/
   `captureReadySamples` are unconditionally reset at the top of every `startRawRecording()` call
   regardless of prior state — no stale-counter instant-fire scenario found.
5. **Startup reorder (3/4):** Bug found — see I1. Otherwise clean: `engineReady` is reliably set after
   a real successful boot; `abortInitialization()` is safe to call standalone.
6. **Engine selection (9):** CLEAN — see M1 for the one non-bug nuance requested by the prompt.

---

## Not modified

Read-only review; no source files were changed. This file is the only artifact written.
