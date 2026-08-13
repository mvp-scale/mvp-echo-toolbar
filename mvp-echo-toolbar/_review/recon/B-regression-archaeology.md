# Regression Archaeology — the seven planned fix sites

> **Scope:** read-only. No source file modified, no writing git command run. Every claim below is
> grounded in `git log -L`, `git show`, in-code comments (quoted verbatim), and the repo's own
> incident docs (`STARTUP-REGRESSION-REPORT.md`, `RELEASE-INSTABILITY-GAP-ANALYSIS.md`, `BRIDGE.md`,
> `_review/raw/*.md`, `_review/FIX-PLAN.md`). Commit SHAs verified with `git show`/`git log -L` against
> `dev` HEAD. All seven sites map 1:1 to Fix IDs `0a, 0b, 1, 3, 4, 5, 9` in `_review/FIX-PLAN.md`
> Phase 1 — this file supplies the "what breaks if reverted" half of that plan's DoD, per its own
> open question #2: *"Does any Phase 1 fix risk reinstating a bug that a previous fix deliberately
> introduced this code to prevent?"*

---

## Site 1 — `inference-orchestrator.ts:81-92` — catch in `initialize()` (make it re-throw)

**Origin of current form:** `17fc451` (Mon Jun 1, "Stability hardening for record-start/timeout/crash
failures (3.0.12 soak build)"). Predecessor: `2407e63` (Thu Apr 9, initial WebGPU integration) shipped
the catch as pure log-and-continue:
```
} catch (err) {
  // Don't kill the worker on error — it may be mid-download
  // Just log and let the user retry
  console.error('[InferenceOrchestrator] Init failed:', err);
  this.modelReady = false;
} finally { this.loading = false; }
```
`17fc451` added `disposeSync()` on failure but **kept the swallow** (no re-throw), with a new comment
explaining the intent:
> "Tear the worker down on failure. A half-initialized worker still holds a partial ~1.2GB model in
> memory; reusing it on the next attempt compounds RAM and never recovers... No auto-retry — the
> user/CaptureApp re-triggers init, avoiding a retry storm on an already memory-pressured machine."

**The bug it fixes:** the *original* (2407e63) problem was killing a worker that might still be
mid-download on a transient error, forcing a full ~1.2GB re-download for what could have been a
recoverable blip. `disposeSync()` on failure (17fc451) fixed that by discarding the half-loaded worker
so the next attempt starts clean.

**But the "no re-throw" half never worked as intended — and this is the actual reason to change it.**
Because `initialize()`'s promise never rejects, its only caller, `CaptureApp.tsx:53-76`
(`initWebGpuOrchestrator`), always falls through to its own success path after `await
orchestratorRef.current.initialize(...)`:
```
await orchestratorRef.current.initialize(backend, appVersion);
initFailRef.current = 0;                                  // ALWAYS runs — even after a swallowed failure
console.log('CaptureApp: WebGPU orchestrator ready');
const ipc = ...; if (ipc) ipc.invoke('webgpu:model-ready', true);   // false-positive "ready" signal
```
`CaptureApp.tsx:73-76`'s own `catch` block — which increments `initFailRef` and feeds the 3-strike
backoff guard at `CaptureApp.tsx:461` (`if (initFailRef.current >= 3) { ...not auto-retrying... }`) —
is **unreachable**. `_review/raw/11-gpu-worker-lifecycle.md` independently confirms this as "CLAIM A":
> "the 3-strike init-failure guard (`CaptureApp.tsx:461`) is dead code; `initFailRef` is unconditionally
> reset to 0 on every attempt because `initialize()` never rejects... the main process is falsely told
> the model is ready (`ipc.invoke('webgpu:model-ready', true)`) even after a swallowed failure."

**Regression risk of the planned fix (re-throw): LOW, contingent on one thing.** The only caller
(`CaptureApp.tsx:67`) already wraps the `await` in a try/catch that does the right thing once errors
actually arrive (`grep` confirms `InferenceOrchestrator` has exactly one importer/one call site). Adding
`throw err;` at the end of the catch reconnects two pieces of already-written, currently-dead error
handling (the 3-strike counter and the cooldown gate) — it does not need new call-site code. Re-throwing
does **not** reinstate the pre-17fc451 bug (worker still gets `disposeSync()`'d first, in the same
catch block, before the re-throw) — the half-loaded-worker-reuse bug this catch was written against is
untouched.

**Where it turns MEDIUM: interaction with Site 2.** See the combined adversarial scenario under Site 2 —
re-throwing (Site 1) *and* making `disposeSync()` reject pending requests + clear `loading` (Site 2)
together open a narrow re-entrancy window if both land without a generation/epoch guard.

**Guard to add (Definition of Done):**
- A successful init still resets `initFailRef` to 0 (must not regress the happy path).
- A failed init increments `initFailRef` exactly once per failure, and after 3 the auto-retry gate at
  `CaptureApp.tsx:461` actually halts (currently unverifiable because unreachable — this fix makes it
  reachable and testable for the first time).
- `ipc.invoke('webgpu:model-ready', true)` must never fire when `isReady()` is false.
- The half-loaded-worker-reuse regression (`2407e63`'s original bug) stays fixed: assert `disposeSync()`
  is still called (worker terminated + nulled) on every failure path before the throw.

---

## Site 2 — `inference-orchestrator.ts:136-143` — `disposeSync()` (reject pending requests, clear `loading`)

**Origin:** `2407e63` (Apr 9) — introduced alongside the worker itself, unchanged in shape since:
```javascript
private disposeSync(): void {
  if (this.worker) {
    try { this.worker.postMessage({ type: 'dispose' }); } catch { /* ok */ }
    this.worker.terminate();
    this.worker = null;
  }
  this.modelReady = false;
}
```
It has never touched `this.loading` or the pending `sendMessage()` promise's resolve/reject.

**The bug it fixes today:** none directly — it's the worker-teardown primitive other sites (Site 1's
catch, `abort()`, the `device-lost` listener) call into. The *gap* is what the planned fix targets:
`sendMessage()` (`:145-175`) only settles via a `responseType`/`'error'` message from the worker or its
own `setTimeout(timeoutMs)`. `disposeSync()` terminates the worker without ever satisfying either —
so a pending promise silently hangs until its own timeout: **120,000 ms for `transcribe()`, 900,000 ms
(15 minutes) for `initialize()`**. `_review/raw/08-memory-and-hangs.md` and `_review/raw/11` (CLAIM B,
confirmed) independently derive the same mechanism:
> "a device-lost during init wedges `isLoading()===true` for up to 15 minutes, during which the
> recovery path is fully self-gated off (`CaptureApp.tsx:456 if (!orchestratorRef.current.isLoading())`)
> — the app is unresponsive to the shortcut with no fallback for the entire window."

CaptureApp.tsx itself carries a comment that shows the current design was written *around* this
delayed-rejection behavior rather than fixing it — proof the gap was known, not accidental:
```
// A worker aborted by the 60s timeout rejects later at its own 120s
// timeout — by then this run is stale and may have been replaced by a
// newer recording, so don't stomp its tray state.
```
(`CaptureApp.tsx:408-410`, inside the `performStop` catch block guarded by `isStale()`.)

**Regression risk of the planned fix: MEDIUM — real adversarial scenario found, needs a guard.**

*Scenario A (the 60s-safety-timeout abort path) — LOW risk, verified safe.* `CaptureApp.tsx:271-276`
bumps `requestGenRef.current` (`myGen`/`isStale()` generation counter) **before** calling
`orchestratorRef.current.abort()`. So even with immediate rejection, `isStale()` is already `true` the
moment the rejection lands — identical outcome to today's delayed 120s rejection, just faster. No
regression here.

*Scenario B (device-lost during a live `transcribe()`, or during `initialize()`'s warmup) — this is
where an immediate reject is a net improvement, not a regression*, **provided** the generation counter
is still bumped somewhere in the path. Today, a `device-lost` mid-transcribe leaves the tray stuck on
"processing" for up to 120s before the stale-timeout rejection quietly resolves it. Rejecting
immediately lets the existing `catch`/`finally` in `performStop` recover in under a second instead.

*Scenario C — the actual regression risk, a race between two `initialize()` calls sharing `disposeSync()`
as the only teardown/state-reset primitive.* Walk it through:
1. `initialize()` call **A** starts: `loading=true`, in-flight `sendMessage({type:'init'}, 'ready', 900000)`.
2. `device-lost` fires mid-init (asynchronously, via the persistent listener at `:65-70`, which is
   **not** part of call A's own promise chain). With the Site 2 change, the listener's `disposeSync()`
   synchronously (a) rejects A's pending init promise and (b) sets `loading=false` — both *before* A's
   own `catch`/`finally` (triggered by the rejection) has had a chance to run as a microtask.
3. In that window, `loading===false` and `worker===null`. If a hotkey press (or any other caller)
   checks `!isReady() && !isLoading()` and kicks off a **new** `initialize()` call **B** — `B` sees
   `!this.worker`, spins up a brand-new worker, sets `loading=true` again.
4. Call A's deferred `catch` now runs (it was still on the stack/microtask queue): with **Site 1's
   re-throw also landed**, it calls `disposeSync()` *again* — but `this.worker` is now **B's** fresh
   worker. A's stale cleanup terminates B's live worker. A's `finally` then sets `loading=false`,
   stomping call B's `loading=true` even though B may still be genuinely initializing.
   Net effect: B's worker is torn down out from under it while B still thinks it's loading — a silent,
   self-inflicted worker kill that reproduces the exact "dueling async writes to shared state" class of
   bug this codebase has hit before (cf. the re-entrancy-race guard comment in `CaptureApp.tsx:432-436`).

This scenario requires Site 1 (re-throw) **and** Site 2 (reject+clear-loading) to both land, plus no
generation/epoch tagging on `initialize()` calls — which is exactly the current design (no such tagging
exists on `InferenceOrchestrator` today; `requestGenRef` lives only in `CaptureApp.tsx` and only guards
the transcribe path, not `initialize()`).

**Guard to add (Definition of Done):**
- `disposeSync()` must reject the pending `sendMessage` promise **and** clear `loading` atomically with
  worker teardown — but the resulting `catch`/`finally` in whichever `initialize()` call owned that
  promise must be a no-op on stale state. Concretely: tag each `initialize()` invocation with a local
  generation token (mirroring `CaptureApp`'s `requestGenRef`/`isStale()` pattern) and have the catch/
  finally check "is `this.worker` still the worker *I* created?" before touching `this.worker`/`loading`.
- Assert: `device-lost` during A's init, followed immediately by a new `initialize()` call B, leaves B's
  worker alive and `loading` reflecting B's true state — not clobbered by A's delayed cleanup.
- Assert latency: a `device-lost` (or timeout-abort) during `transcribe()` now resolves the pending
  promise within ~1s, not 120s / 900s.
- The Scenario-A (60s safety-timeout) behavior must stay byte-identical (already safe, but a good
  regression-test anchor since it's the one path already exercised in production).

---

## Site 3 — `AudioCapture.ts:361-371` (`devicechange` listener) + `:380-390` (`releaseMicStream()`) — add a recording-active guard

**Origin:** both introduced together in `e091794` (Sat Jun 20, "Warm-mic capture: reuse stream across
recordings + idle-release (3.0.24)"). Commit message:
> "Keep the mic stream warm between recordings instead of calling getUserMedia on every press...
> Default-device change releases the warm stream to re-acquire."

In-code comment directly above the listener:
> "Register the device-change listener exactly once per instance. On a device change we release the
> warm stream so the next recording re-acquires the (possibly new default) device."

**The bug it fixes:** before warm-mic, every recording called `getUserMedia` fresh, so a stale/removed
default device was never an issue — the OS always handed back the *current* default on each press. Once
the stream started being reused across recordings (`e091794`), a default-device change (headphones
plugged in, Bluetooth reconnect, USB device arrival) could otherwise leave the app recording from a
now-stale/possibly-dead device indefinitely. The `devicechange` listener releases the warm stream so the
**next** `ensureMicStream()` re-acquires the live default. This part of the design is sound and should
be preserved.

**The bug our planned change fixes (currently unguarded, not yet a "fix"):** `releaseMicStream()` is
unconditional — it stops every track on `rawStream` with no check for whether a recording is actually
in progress. If `devicechange` fires *while* `startRawRecording()` has already wired `rawSource →
rawWorklet → rawSink` and audio is flowing, the live mic tracks are killed mid-capture, silently
truncating or emptying the in-progress recording. `_review/raw/03-audio-capture.md` independently
identifies this as the review's own [P0]:
> "The class-level `devicechange` listener... calls `releaseMicStream()` on *any* system audio-device
> change... `releaseMicStream()` unconditionally stops every track on `rawStream`... with no check for
> whether a recording (`rawWorklet`/`rawSource` connected) is currently in progress... the state machine
> actually permits **RECORDING → RELEASED** via `devicechange`, which is not a transition anything else
> in the code expects."

**Regression risk of the planned fix (add recording-active guard): LOW**, this is additive/net-new
protection, not a change to existing protected behavior — provided the guard **defers** the release
(fires it the moment `stopRawRecording()` completes) rather than dropping it outright. If the guard
instead just *drops* the devicechange event while recording, the original 3.0.24 bug (stale device
reused on the *next* recording) partially returns for that one specific press. `AudioCapture.ts` has no
explicit `isRecording` boolean today — recording-in-progress is inferred from `this.rawWorklet`/
`this.rawSource` being set (non-`undefined`) between `startRawRecording()` and `stopRawRecording()`; the
guard should use that (or add an explicit flag) rather than inventing new state.

**Guard to add (Definition of Done):**
- A `devicechange` while a recording is in progress must **not** stop the live mic tracks — either defer
  the release until `stopRawRecording()` runs, or abort the recording with a **distinct** error/cue
  (never a silent empty result — `_review/FIX-PLAN.md`'s own DoD for this fix says the same).
- A `devicechange` while **idle** (the common case, and the one `e091794` was written for) must still
  release the warm stream immediately — this is the behavior the listener exists for; do not regress it.
- `deviceChangeListenerAdded` must remain a one-time-registration guard (unrelated to this fix, but
  don't accidentally re-add the listener on every `ensureMicStream()` call).

---

## Site 4 — `AudioCapture.ts:474-478` — warm-mic `fireCaptureReady('warm')` branch (add mute+energy gate)

**Origin/churn — this exact behavior has changed three times across three releases**, all in direct
response to the same underlying "dead-window empties" bug:

1. `df21b806` (Tue Jun 16, v3.0.21) — introduced the readiness cue with a bare safety-net timer:
   > "Safety net: always emit a 'talk now' cue even if the readiness condition is not met... better a
   > slightly early cue than none."
2. `be4ddaf8` (Sat Jun 20, v3.0.23) — **root-cause fix**, replacing frame-count+`track.muted` with an
   energy gate:
   > "Gate the 'talk now' cue on ~250ms of CONTIGUOUS above-floor RMS, not frame-count + track.muted.
   > track.muted clears before the device's unmute/AGC ramp delivers audio, so the old gate fired the
   > cue into the dead window and the user spoke into nothing (empty result)."
3. `e091794` (Sat Jun 20, v3.0.24) — added the **warm** branch itself (the exact code this site touches):
   ```javascript
   if (wasWarm) {
     // Device was already delivering audio — fire the cue immediately so the
     // user can speak without waiting for the energy gate.
     this.fireCaptureReady('warm');
   } else { ... /* cold path keeps the full energy gate */ }
   ```

**The bug it fixes:** the warm branch exists purely for latency — `e091794`'s commit message: "eliminates
the ~1-2s per-record OS device cold-open." Its implicit assumption is that a stream already flowing
audio (`existingTrack.readyState === 'live'`) is *known-good*, so it skips the energy gate entirely and
fires immediately. `BRIDGE.md` documents this as the shipped, current behavior: "Cold first record is
still energy-gated... warm reuse is instant." `RELEASE-INSTABILITY-GAP-ANALYSIS.md`'s postmortem is the
direct ancestor of the whole gate: "Empty transcriptions = the mic dead-window. The 'talk now' cue fired
before the mic was actually delivering audio... **Fix:** an energy-based readiness gate."

**Regression risk of the planned fix (add mute+energy gate to the warm branch too): the direction is
right, magnitude is the risk.** The warm branch's "stream is live == audio is flowing" assumption is
not actually airtight — `readyState === 'live'` only proves the track object hasn't ended; it says
nothing about whether the device just came back from a mute/AGC transition (e.g., resumed from
`releaseMicStream()`'s idle-release window, or a driver hiccup on a "warm" but recently-quiet device).
So adding *some* gate to the warm path is closing a real gap in the same bug class `be4ddaf8` fixed for
cold starts. **The risk is regressing the very reason this branch exists** — if the gate reuses the
cold path's full parameters (250ms contiguous above-floor RMS + up to 2000ms fallback,
`READY_ENERGY_FLOOR`/`READY_FALLBACK_MS` at `:117-120`), the warm path loses essentially all of its
latency advantage and the 3.0.24 "instant repeat recordings" feature is defeated in practice — the
`_review/FIX-PLAN.md` DoD for this exact fix flags the same tension: "Added latency ≤100ms in the common
case... the warm-mic latency advantage is *mostly* preserved (not reverted to the 2s cold fallback)."

**Guard to add (Definition of Done):**
- Warm path still requires `track.muted === false` (cheap, near-zero latency in the true-warm case).
- Warm path's energy requirement must be **short** relative to the cold path's 250ms/2000ms — e.g. a
  single above-floor frame or a much shorter window (~50-100ms) — not the full cold-path parameters.
  Assert added latency stays in double-digit-to-low-triple-digit ms in the common (genuinely warm) case.
- Cold path (`:478-483`, the `else` branch) must be untouched — this fix must not touch `maybeFireCaptureReady`/`READY_ENERGY_FLOOR`/`READY_FALLBACK_MS` semantics.
- Regression test anchor: replay the exact scenario `be4ddaf8` was written for (mute clears before AGC
  ramp completes) but with `wasWarm === true` — confirm the new gate still catches it, where today's
  code (bare `fireCaptureReady('warm')`, no gate at all) would not.

---

## Site 5 — `main-simple.js:396-438` — startup ordering (register `globalShortcut` before the engine-init await)

**Churn — touched 4 times, the most-edited of the seven sites:** `cf0c8a1` (initial add, Feb 7),
`ba90439` (Feb 9, configurable keybind), `cd6afcb` (Feb 9, cosmetic log-message rename), `e2f6e51`
(Apr 29, v3.0.9 — the restructuring that introduced today's ordering problem).

**Origin of the *current* (undesirable) ordering:** `e2f6e51` ("Persist WebGPU model cache and
auto-resume on launch, bump to 3.0.9"). Before this commit, `whenReady()` was:
`createHiddenWindow(); await engineManager.initialize();` then register the shortcut — **no wait for
`did-finish-load`**. `e2f6e51` inserted the `did-finish-load` await and the `initializeAndSignalReady()`
await **ahead of** `globalShortcut.register()`, to fix a real, different bug — a bootstrap race where
the renderer's `cloud:get-config` IPC call could run before `engineManager.setupIPC()` had registered
its handlers. Commit message:
> "Fix bootstrap race where the renderer's cloud:get-config call ran before EngineManager.setupIPC():
> IPC handlers now register before the hidden window is created and cloud:get-config awaits an
> engine-ready promise resolved at the end of initialize()."

**The bug this ordering (accidentally) reintroduced:** by serializing shortcut registration behind
both awaits, `e2f6e51` made Ctrl+Alt+Z dead for the entire GPU-probe/renderer-load window on every cold
start. `STARTUP-REGRESSION-REPORT.md` (an existing, already-adjudicated multi-agent investigation)
names this exact code as "Finding B" and **already recommends the fix we're about to make**:
> "Serialized `whenReady` chain gating the record hotkey (AMPLIFIER)... `mvp-echo-toolbar/app/main/
> main-simple.js:398-405` (await `did-finish-load`), `:409` (await `initializeAndSignalReady()`), `:415`
> (`globalShortcut.register`)... **Fix:** register `globalShortcut` first, then run `await
> did-finish-load` and `engineManager.initializeAndSignalReady()` as fire-and-forget (`.catch(log)`)."

**Regression risk of the planned fix: LOW for the shortcut itself, MEDIUM if not paired with a "still
starting" state.** Moving `globalShortcut.register()` earlier does **not** reinstate the bootstrap race
`e2f6e51` actually fixed — that fix was "register IPC *handlers* before creating the hidden window"
(`engineManager.setupIPC()` call, already at line 389, **before** `createHiddenWindow()` at 396), which
is orthogonal to *when the shortcut itself* is registered. The shortcut handler just posts an IPC
message to the hidden window (`hiddenWindow.webContents.send('global-shortcut-toggle')`) — it doesn't
touch `cloud:get-config` or the engine-ready promise at all. The real regression risk is behavioral, not
structural: if the shortcut fires **before** the engine/model is actually ready, today's hidden-window
handler has no "not ready yet" branch — a press during the (now-earlier-reachable) warm-up window could
silently no-op or race against an uninitialized `orchestratorRef`. This is exactly `_review/FIX-PLAN.md`
Fix `3`'s own DoD requirement.

**Guard to add (Definition of Done):**
- `globalShortcut.register()` completes before `did-finish-load`/engine-init is awaited (assert via
  registration timestamp < engine-ready timestamp in logs).
- A press during the (now much larger) warm-up window produces a **distinct** "still starting" cue —
  not silence, not a crash, not an attempt to record against a not-yet-created hidden window.
- `engineManager.setupIPC()` must still run before `createHiddenWindow()` (unrelated ordering, but it's
  the actual fix for the bug `e2f6e51` introduced this whole block to solve — don't disturb it).
- `globalShortcut.unregisterAll()` on quit and the 500ms debounce must be unaffected.

---

## Site 6 — `main-simple.js:399-405` — the `did-finish-load` await (add `did-fail-load` + timeout)

**Origin:** `e2f6e51` (Apr 29, v3.0.9), added new (no prior form) as part of the same restructuring as
Site 5:
```javascript
await new Promise((resolve) => {
  if (hiddenWindow.webContents.isLoading()) {
    hiddenWindow.webContents.once('did-finish-load', resolve);
  } else {
    resolve();
  }
});
```

**The bug it fixes:** none — it was written to *create* the ordering guarantee Site 5 now needs to
partially undo (GPU probe must run after the renderer bundle is actually loaded). It has no failure
path: no `did-fail-load` listener, no timeout. `STARTUP-REGRESSION-REPORT.md` and
`_review/raw/01-main-process.md` both flag this as a live, unfixed gap — the report explicitly says the
prior startup diagnosis's causes "still hold and are unfixed." `_review/raw/01` states the impact
directly:
> "If `dist/renderer/index.html` is missing/corrupt or the dev server isn't up... this promise never
> resolves. Engine init and `globalShortcut.register()`... never run. The tray icon exists and *looks*
> functional, but recording is completely dead with zero error surfaced to the user or the log."

Note this is a genuinely *open* incident already (not something a past fix protects against) — there is
no prior "bug this code fixes" to accidentally reinstate here; the risk runs the other way; the fix is
closing a gap that has existed, unaddressed, since the code was written.

**Regression risk of the planned fix (add `did-fail-load` + timeout): LOW.** This is additive — a new
failure branch alongside the existing success branch, not a rewrite of the success path. The only way to
regress is if the timeout is too aggressive and fires on a merely slow (not failed) load, spuriously
tanking a legitimately slow first-run.

**Guard to add (Definition of Done):**
- Success path (`did-finish-load` fires normally) is byte-identical to today — no added latency on the
  common case.
- `did-fail-load` and the timeout both resolve the promise (don't leave it hanging either way) and put
  the tray into a visible `error` state, not a silent one.
- Timeout value must be generous enough not to false-positive on a legitimately slow but successful
  cold load (electron-builder/AV-scan-delayed first launch) — `_review/FIX-PLAN.md`'s own DoD suggests
  ≤15s; pick a number and verify it against an observed real cold-start time before locking it in.

---

## Site 7 — `engine-manager.js:152-193` — `_restoreModelSelection()` (defer to the live availability probe)

**Origin/churn:** `5e72db47` (Thu Feb 12, "Fix model preference not persisting across restarts, remove
HD reference") introduced the whole method, to fix a real prior bug:
> "EngineManager hardcoded selectedModelId to 'local-fast' on every startup, ignoring the saved
> preference in toolbar-endpoint-config.json. Added `_restoreModelSelection()` to read persisted model
> choice during `initialize()` and activate the correct adapter."

`2407e63` (Thu Apr 9) extended it to add the WebGPU-first branch (the exact code this site now touches),
with no further changes since — 2 edits total, not a heavy-churn site by commit count, but see below.

**The bug it fixes:** the original 2026-02-12 bug — a saved model preference (`local-fast`,
`webgpu-*`, a remote model) being silently discarded on every app restart, forcing the user to
re-select it every launch. This must be preserved.

**The bug our planned change fixes (found independently, then confirmed against `_review/raw/06-stt-engines.md`, which reaches the identical conclusion citing the identical lines):** `initialize()`
(`:87-129`) already does the right thing — it probes each adapter's *live* availability in priority
order (webgpu → remote → local-sidecar) and picks the first one that actually works, calling
`_restoreModelSelection()` only as a config-restore step **after** a working adapter is already active.
But `_restoreModelSelection()`'s first branch ignores that live-probe result entirely:
```javascript
const webgpuConfig = this.webgpuAdapter.getConfig();
if (webgpuConfig.activeModelId && webgpuConfig.isConfigured) {
  this.selectedModelId = webgpuConfig.activeModelId;
  this.activeAdapter = this.webgpuAdapter;      // unconditionally overrides whatever initialize() just picked
  this.activeAdapterName = 'webgpu';
  return;
}
```
`WebGpuBridgeAdapter.getConfig()` (`webgpu-bridge-adapter.js:153-158`) defines `isConfigured` as merely
`!!this.activeModelId` — "the user picked this at some point," with **no** GPU probe and **no** check
that the model is actually downloaded. Verified directly:
```javascript
getConfig() {
  return {
    activeModelId: this.activeModelId,
    isConfigured: !!this.activeModelId,   // config only, no async probe
    ...
```
`isAvailable()` (the method `initialize()` actually calls) is the real check — it live-probes GPU
capability (`_probeGpu()`) **and** verifies the model is downloaded on disk. `_restoreModelSelection()`
uses neither. `_review/raw/06-stt-engines.md` reaches the same conclusion independently, down to the
same line numbers:
> "Two independent 'which adapter is active' algorithms exist and silently fight each other.
> `initialize()`'s live-probe selection and `_restoreModelSelection()`'s persisted-config restore both
> mutate `activeAdapter`/`activeAdapterName`/`selectedModelId`, with the second unconditionally
> overriding the first with no re-validation — a structural bug, not a typo."

**Concrete failure this causes today:** WebGPU worked in a prior session (config persisted:
`activeModelId` set, `isConfigured=true`). Between sessions the GPU becomes unavailable, or the
IndexedDB model cache is evicted. `initialize()`'s live probe correctly returns unavailable and falls
through to select local-sidecar or remote. `_restoreModelSelection()` then immediately clobbers that
correct choice back to `activeAdapterName='webgpu'`. `CaptureApp.tsx:454-456` trusts
`cloud:get-config`'s restored `selectedModel`, tries to route to WebGPU, and if the orchestrator isn't
ready in time, **silently ignores the shortcut press** ("WebGPU model not ready") instead of falling
back to the perfectly good adapter `initialize()` had just verified.

**Regression risk of the planned fix (defer to the live probe): LOW, with one thing to preserve.**
The fix is a pure additional constraint (only take the webgpu-preference branch when the live probe
already agrees), not a rewrite of the restore logic for the other adapters. The one thing that must
survive: **a genuinely-working saved WebGPU preference must still be restored across restarts** — that
is the entire reason `_restoreModelSelection()` exists (the 2026-02-12 bug). If the fix is implemented
as "never restore webgpu from `_restoreModelSelection()`" instead of "only restore webgpu when
`webgpuResult.available` was true," it overcorrects and reinstates the original `5e72db47` bug for the
one adapter (WebGPU) most likely to have a working saved preference.

**Guard to add (Definition of Done):**
- When the live probe reports WebGPU unavailable, `_restoreModelSelection()` must **not** force
  `activeAdapterName='webgpu'` — `selectedModelId` must reflect an adapter that actually works (fix `9`'s
  own DoD in `_review/FIX-PLAN.md` states this identically).
- When the live probe reports WebGPU **available** and a saved WebGPU preference exists, it must still
  be restored — regression-test anchor directly against the `5e72db47` bug this method was written to
  fix (saved preference silently discarded on restart).
- The same "defer to live probe" logic should be considered for the `remoteConfig`/`localConfig`
  branches too (they have the analogous but less severe issue — `remoteConfig.isConfigured` and
  `localConfig.activeModelId` are also config-only), though only the WebGPU branch is in scope for this
  pass per the plan.

---

## Repeated-churn sites (more than two edits to the same logical code)

| Site | Edits | Detail |
|---|---|---|
| **Site 5** — `main-simple.js` startup block (`396-438`) | **4** | `cf0c8a1` (create) → `ba90439` (configurable keybind) → `cd6afcb` (log message) → `e2f6e51` (restructure — introduced the ordering problem Site 5 now fixes). The 4th edit is the one that matters; it's also the one an already-existing report (`STARTUP-REGRESSION-REPORT.md`) independently flagged as needing exactly this fix. |
| **Site 4** — `AudioCapture.ts` warm/ready-cue firing logic (`474-478` and its immediate neighborhood) | **3** | `df21b806` (introduce cue+fallback, v3.0.21) → `be4ddaf8` (energy-gate root-cause fix, v3.0.23) → `e091794` (split into warm/cold branches, v3.0.24). This is the single most design-churned area across all seven sites — three releases in a row rewriting the same "how do we know the mic is really live" logic, which is itself a signal (flagged below) that a point fix (Site 4) is a patch on a spot that has needed re-fixing three times already; a real state machine (as `_review/FIX-PLAN.md`'s own open question #4 asks) would likely settle it for good instead of needing a fourth iteration. |

No other site (1, 2, 3, 6, 7) exceeded 2 edits to its specific line range.

## Reverted fixes

**None found.** `git log --oneline --all | grep -i revert` across the full history returns exactly one
hit, `eb5580d "Colab notebook: revert server optimizations, add real benchmarks"` — unrelated to any of
the seven sites (a Colab/benchmark notebook change, not app code). None of the seven sites' git-log -L
histories show a commit undoing a prior commit's change to the same lines; every edit to these ranges
was a forward iteration (new bug found → new fix layered on), not a revert-and-retry.

---

## Summary table

| # | Site | Bug the current code fixes (one line) | Regression risk of planned change |
|---|---|---|---|
| 1 | `inference-orchestrator.ts:81-92` catch → re-throw | Prevents reusing a half-loaded ~1.2GB worker after init failure (was: also silently swallowed the error, making the 3-strike backoff dead code) | **LOW** alone; **MEDIUM** combined with Site 2 (see Scenario C — needs a generation-token guard) |
| 2 | `inference-orchestrator.ts:136-143` `disposeSync()` reject+clear-loading | Terminates the worker cleanly on failure/abort/device-lost (was: left pending `sendMessage` promises hanging up to 120s/15min, self-disabling recovery) | **MEDIUM** — safe for the one exercised path (60s safety-timeout, generation already bumped); needs a generation/epoch guard to avoid a fresh `initialize()` call's worker being torn down by a stale call's delayed cleanup |
| 3 | `AudioCapture.ts:361-371`+`:380-390` recording-active guard | Warm-mic reuse releases the stream on a device swap so the next recording re-acquires the live default (was: does this unconditionally, even mid-recording — silently truncates live capture) | **LOW** — additive guard; must defer (not drop) the release so the idle-device-swap case (the reason this listener exists) still works |
| 4 | `AudioCapture.ts:474-478` warm-branch mute+energy gate | Fires the "talk now" cue instantly on a warm (already-live) stream for latency (was: assumed "live" == "flowing real audio," no gate at all, unlike the cold path) | **LOW-MEDIUM** — direction is correct (closes the same dead-window bug class `be4ddaf8` fixed for cold starts) but must use a much shorter gate than the cold path or it defeats the warm-mic latency win that is the entire point of this branch |
| 5 | `main-simple.js:396-438` register shortcut before engine-init await | Fixed a bootstrap IPC race (renderer's `cloud:get-config` outrunning `setupIPC()`) — unrelated to shortcut timing, but bundled the shortcut registration behind it anyway | **LOW** structurally (doesn't touch the actual IPC-ordering fix at line 389); **MEDIUM** behaviorally unless paired with a "still starting" state for presses during the now-larger warm-up window |
| 6 | `main-simple.js:399-405` add `did-fail-load`+timeout | N/A — this is an open gap, not a protected fix; a failed/hung renderer load currently wedges the whole `whenReady` chain forever with no error surfaced | **LOW** — additive failure path; only risk is an overly aggressive timeout false-positiving on a slow-but-succeeding cold start |
| 7 | `engine-manager.js:152-193` defer to live probe | Fixed saved model preference being discarded every restart (was: forced back to `local-fast` every launch) | **LOW** — must preserve "a genuinely-working saved WebGPU preference is still restored," or the fix overcorrects into reinstating the original 2026-02-12 bug for the WebGPU adapter specifically |
