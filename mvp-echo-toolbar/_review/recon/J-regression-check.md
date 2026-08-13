# Regression Check — did any of the seven fixes reinstate an old bug?

> **Scope:** read-only. `git log -L`, `git show`, `git diff 515f4fc..HEAD -- mvp-echo-toolbar/app`,
> plus `npm test` (17/17 pass) and `npm run typecheck` (clean) run against the working tree as
> empirical checks — no source modified. Commits examined: `f3c915c`, `3515c42`, `5a33e9e`,
> `20e3658`, `6ad64be`, `a747e9d`, `ee7560b` (the seven-fix range on top of `B-regression-archaeology.md`'s
> baseline `515f4fc`).

---

## H1 — REFUTED: moving `globalShortcut.register()` earlier does NOT reintroduce the `setupIPC()` race

The bug `e2f6e51` fixed was `engineManager.setupIPC()` (which registers `cloud:get-config` etc.)
running *after* `createHiddenWindow()`, so the renderer's startup `cloud:get-config` call could
race past unregistered handlers. That ordering is **untouched** by this changeset:

```js
// mvp-echo-toolbar/app/main/main-simple.js (current HEAD, ~386-396)
// Register engine IPC handlers FIRST so the renderer's startup
// cloud:get-config call doesn't race past unregistered handlers.
// Window references are passed as getters and resolved lazily.
engineManager.setupIPC({ ... });

// Create hidden capture window (handlers exist; cloud:get-config will await
// engineManager._readyPromise which resolves at the end of initialize())
createHiddenWindow();
```

`globalShortcut.register()` moved to right after `createHiddenWindow()` — still strictly after
`setupIPC()`. The shortcut handler itself never touches `cloud:get-config` or `_readyPromise`; it
only does `hiddenWindow.webContents.send('global-shortcut-toggle')`, gated by a new `engineReady`
flag (`main-simple.js:~478-486`) that is `false` until `initializeAndSignalReady()` resolves. A
press before the engine is ready is dropped with a log line and `trayManager.setState('starting')`,
not sent to a possibly-unready renderer. `B-regression-archaeology.md`'s own Site 5 analysis called
this "orthogonal" in advance; the diff confirms it.

## H2 — REFUTED: deferred `devicechange` release does not cause stale-device reuse

`requestMicRelease()` (`AudioCapture.ts:~412-422`) only *defers* while `this.rawWorklet` is set
(i.e., mid-recording); it does not drop the release. `stopRawRecording()` (`:~678-689`) applies the
deferred release **unconditionally and immediately** on the very next stop:

```js
// A device change during the recording deferred its release to here, so the
// next recording still cold-acquires the (possibly new default) device —
// which is also what re-arms the full cold readiness gate.
if (this.micReleasePending) {
  this.applyPendingMicRelease();
} else if (this.micReleaseMode === 'release-each') {
  this.releaseMicStream();
} else {
  this.scheduleIdleRelease();
}
```

`applyPendingMicRelease()` calls `releaseMicStream()`, which sets `this.rawStream = undefined`.
The next `ensureMicStream()` call therefore has no warm stream to reuse and cold-acquires via
`getUserMedia()` again (`AudioCapture.ts:322-353`), picking up whatever the OS's current default
device is at that moment — not a stale/unplugged one. So the "next recording reuses a stream for a
device the user has physically unplugged" half of H2 is directly contradicted by the code, and is
covered by a new regression test (`test/audio-capture.test.mjs`, "a deferred release is applied once
the recording stops").

It is true that a recording *in progress* now continues on the same (old) track through to its own
`stopRawRecording()` rather than being killed instantly — but that is the fix's explicit goal, not
a regression: today's *prior* behavior (kill on any `devicechange`, including irrelevant ones like
an unrelated Bluetooth device connecting) was the actual truncation bug (see `B`'s Site 3). If the
in-use device is physically unplugged, its `MediaStreamTrack` ends on its own (OS/browser-driven,
independent of this code) whether or not `releaseMicStream()` is also called — so no new failure
mode is introduced there either. One residual (pre-existing, not introduced by this diff) narrow
window: inside `stopRawRecording()`, `this.rawWorklet` is cleared at line 617 before the `await
offlineCtx.startRendering()` resampling step at line 664; a `devicechange` landing in that async gap
would take the immediate-release branch of `requestMicRelease()` instead of being deferred a second
time, then get double-processed by the deferred-release check at line 681 (harmless — `releaseMicStream()`
is idempotent, and `micReleasePending` would just be `false`). This is not new: the old code was
unconditional and had no such windowing concept at all, so it isn't a regression relative to `515f4fc`.

## H3 — REFUTED (deliberate, bounded, tested trade-off — not the reinstated complaint)

The warm path no longer fires `fireCaptureReady('warm')` with zero gating; it now runs the same
`maybeFireCaptureReady()` energy gate as cold, just with much shorter parameters
(`READY_SECONDS_WARM = 0.05` vs cold's `0.25`; `READY_FALLBACK_WARM_MS = 150` vs cold's `2000`).
This does add latency versus the literal 0ms of the prior warm path — the commit message states it
plainly ("Costs ~50-70ms against today's (incorrect) 0ms") — but the feature `e091794` was built to
fix was the **~1-2s OS device cold-open** (`getUserMedia()` round-trip), which is untouched: the
stream is still reused, not re-acquired. A bounded ~50-150ms energy-gate delay is a different order
of magnitude from the complaint the warm-mic feature addressed, and it is explicitly test-asserted
to stay bounded:

```js
// test/audio-capture.test.mjs
assert.ok(warm <= 16000 * 0.1, 'warm gate should cost no more than ~100ms');
```

This matches `B-regression-archaeology.md`'s own Site 4 DoD ("Added latency ≤100ms in the common
case... warm-mic latency advantage is *mostly* preserved"). Verdict: REFUTED as literally stated
("reintroduces perceptible latency... the exact user complaint") — the complaint it reintroduces, if
any, is orders of magnitude smaller than the one the feature solved, and it closes a real hole
(dead-window empties on a warm-but-not-actually-live stream) in the same bug class `be4ddaf8` fixed
for cold starts.

## H4 — REFUTED: the load-failure early return leaves the app in a *better* state than before

Before this changeset, a hung/failed renderer load caused `whenReady()` to await forever — nothing
after the `did-finish-load` await (shortcut registration, the "Engine ready" log) ever ran; the app
just sat with a healthy-looking tray and a completely dead hotkey, per `STARTUP-REGRESSION-REPORT.md`
Finding B (confirmed in `B`'s Site 6). So none of that downstream code ran "unconditionally" in the
old version either — it was already gated behind the same unbounded await.

In the new version, the early `return` on `!loadResult.ok` (`main-simple.js:~509-520`) runs only
*after* the shortcut is already registered (moved earlier — see H1) and only skips
`engineManager.initializeAndSignalReady()` / the `engineReady = true` / `trayManager.setState('ready')`
lines. In exchange it now:
- sets `trayManager.setState('error')` (visible failure, vs. silent "Ready"-looking hang before),
- calls `engineManager.abortInitialization(loadResult.reason)`, which resolves `_readyPromise` so
  IPC handlers awaiting it (`cloud:get-config` etc.) unblock instead of hanging forever — so the
  popup/Settings can still open and show an error.

Nothing that used to run unconditionally is now conditional; a previously-unconditional-but-unreachable-
on-failure path became a real, bounded failure branch. Strictly an improvement.

## H5 — REFUTED: no caller in the main process sees a new rejection

This hypothesis conflates two same-named-but-unrelated constructs:
`InferenceOrchestrator.initialize()` (renderer, `app/renderer/app/webgpu/inference-orchestrator.ts`)
and `EngineManager.initializeAndSignalReady()` / `_readyPromise` (main process,
`app/stt/engine-manager.js`). They run in different processes and have no call relationship — the
renderer never calls into the main-process `EngineManager`, and the main process never awaits the
renderer's `InferenceOrchestrator.initialize()`.

`InferenceOrchestrator.initialize()`'s only caller is `CaptureApp.tsx`'s `initWebGpuOrchestrator()`
(`CaptureApp.tsx:~50-84`), which is invoked fire-and-forget (never awaited by anything else) from a
mount-time `useEffect` and from the `webgpu:init-orchestrator` IPC listener. Its `try { await
orchestratorRef.current.initialize(...) } catch (e) { ... }` fully contains the new rethrow locally —
the `catch` block only increments `initFailRef` and logs; it never rethrows further or invokes any
IPC that could propagate a rejection back to main. The one IPC call it makes on success
(`ipc.invoke('webgpu:model-ready', true)`, now additionally gated on `isReady()`) is not on the
failure path at all.

Separately, `EngineManager.initializeAndSignalReady()`'s own `try { return await this.initialize(); }
finally { this._resolveReady(); }` is unchanged in structure by this diff, and `initialize()`'s only
async calls that could throw (`webgpuAdapter.isAvailable()`, `_restoreModelSelection()`) are
unaffected — `_restoreModelSelection()` still has its own internal `try/catch` that swallows and logs
rather than propagating (`engine-manager.js`, `_restoreModelSelection()`'s outer `try { ... } catch
(error) { log(...) }`). So `_readyPromise` still resolves unconditionally exactly as before. No
regression found on either side of the hypothesis.

## H6 — REFUTED: the four collapsed call sites are semantically identical to today's single call

Verified by direct comparison of `git show 3515c42:mvp-echo-toolbar/app/stt/engine-manager.js`
against the pre-fix version (`515f4fc`). In both versions, `this.activeAdapter` /
`this.activeAdapterName` are set identically in each of the four branches (webgpu-available,
remote-available, local-sidecar-available, none-available/fallback-to-remote-for-configuration)
*before* `_restoreModelSelection()` runs — the only change is that the call is now deferred to a
single site after the if/else-if/else chain instead of one call inlined at the end of each branch
with an early `return`. Since `_restoreModelSelection()`'s behavior only depends on
`this.activeAdapter`/`activeAdapterName`/the adapters' persisted configs (not on *which branch* got
it there), and those fields are set to the same values at the same logical point either way, the
collapse changes nothing beyond what the fix intentionally adds (the new `gpuUsable` /
`probeGpuCapability()` gate, which is in-scope for Fix 9 and not part of H6's claim). The fallback
("no adapter available yet; remote selected for configuration") branch — the one most likely to be
overlooked in a collapse — is preserved verbatim as the final `else` arm. Confirmed by the 5 new
tests in `test/engine-selection.test.js`, all passing.

---

## Deleted comments / guards — inventory and disposition

Full `-`-line scan of `git diff 515f4fc..HEAD -- mvp-echo-toolbar/app`, cross-checked against what
replaced each:

| Deleted | What it protected | Still protected? |
|---|---|---|
| `main-simple.js`: bare `await new Promise(...did-finish-load...)` with no failure path | Nothing — this was itself the *unprotected* gap `STARTUP-REGRESSION-REPORT.md` flagged | Yes — replaced by `waitForFirstLoad()` with `did-fail-load` handling + 15s timeout (net new protection) |
| `AudioCapture.ts` devicechange: `dlog(...); this.releaseMicStream();` (unconditional) | Nothing — this *was* the P0 bug (Site 3) | Yes — replaced by `requestMicRelease()` which defers correctly (verified under H2) |
| `AudioCapture.ts`: `if (!wasWarm) this.maybeFireCaptureReady(...)` (gate skipped when warm) | Nothing — this asymmetry *was* the P1 bug (Site 4) | Yes — gate now applies to both paths (verified under H3) |
| `AudioCapture.ts`: `if (wasWarm) { fireCaptureReady('warm') } else { setTimeout(...) }` | Nothing protective — the warm branch was the ungated one | Yes — unified into a single gated path with warm/cold-specific thresholds |
| `inference-orchestrator.ts` catch: swallow + `this.modelReady = false` (no rethrow) | Nothing protective on its own — `disposeSync()` in the same catch (from `17fc451`) still runs, unchanged, before the new `throw err;` | Yes — the half-loaded-worker-reuse protection (`17fc451`'s actual fix) is untouched; only the swallow is removed |
| `inference-orchestrator.ts`: `if (this.loading) throw new Error('Already loading')` | Re-entrancy guard against concurrent `initialize()` calls | Yes — same guard, now a typed `AlreadyLoadingError` so callers can distinguish it from a real failure |
| `inference-orchestrator.ts` device-lost listener: no active-worker check | Nothing — this absence was a live gap (a superseded worker's late event could kill its replacement) | Yes — new `if (this.worker !== created) return;` closes it (net new protection) |
| `webgpu-bridge-adapter.js`: `if (!this._gpuCapability) { this._gpuCapability = await this._probeGpu(); }` (caches every result, including "hidden window not ready") | Nothing protective — this was itself a latent bug: a transient "hidden window not up yet" probe got cached as a **permanent** negative for the rest of the session | Improved — indeterminate results (`indeterminate: true`) are no longer cached; only determinate ones are |
| `engine-manager.js`: four inline `_restoreModelSelection()` calls, each followed by `return` | Nothing lost — see H6, confirmed semantically identical | Preserved, now a single call site |
| `engine-manager.js`: comment "Check WebGPU adapter's saved model first (config only, no async probe)" | Documentation, not a guard | Correctly removed — it became false once this fix added the async `probeGpuCapability()` call; the replacement comment block documents the new behavior accurately |

**No deleted comment, guard, or defensive branch was found whose protection is not either (a) still
present in equivalent or strengthened form, or (b) was itself the bug being fixed (i.e., removing it
was the point).**

## Empirical checks

- `npm test` (`node --test test/`): **17/17 pass**, 5 suites — including the new
  `Fix 0a`/`Fix 0b` orchestrator suite, the `Fix 1`/`Fix 5` AudioCapture suite, and the engine-selection
  suite covering Fix 9's cold-boot regression guard.
- `npm run typecheck` (`tsc --noEmit`): clean, no errors.

## Bottom line

All six hypotheses (H1-H6) are **REFUTED**. Each of the seven fix sites either preserves the original
protection it's adjacent to (verified against the specific commit that introduced that protection —
`e2f6e51`, `2407e63`, `17fc451`, `e091794`, `be4ddaf8`, `5e72db47`, `cf0c8a1`) or strictly improves on
a documented gap (`STARTUP-REGRESSION-REPORT.md` Finding B, the indeterminate-GPU-probe permanent-cache
bug, the superseded-worker device-lost race). No deleted comment or guard represents a lost protection
that isn't either replicated or was itself the target bug. The one genuine, openly-acknowledged
trade-off is Fix 5's warm-path latency (H3): real, small (~50-150ms bounded, test-asserted), and
explicitly disclosed in the commit message and DoD — not a silent regression.
