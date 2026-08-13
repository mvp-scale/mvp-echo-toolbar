# I — Test quality audit: are these tests honest, or do they just pass?

Scope: `test/engine-selection.test.js` (5), `test/orchestrator.test.mjs` (5),
`test/audio-capture.test.mjs` (7) — 17 tests total, added alongside 7 bug fixes by the
same process that wrote the fixes. All mutations below were applied to a scratch copy
at `/tmp/mvp-echo-mutate` (full copy of `app/`, `test/`, `testkit/`, symlinked
`node_modules`), run with `npm test`, then reverted and diffed clean against the repo.
**No repo file was modified.**

Baseline: `npm --prefix mvp-echo-toolbar test` → 17/17 pass, before and after every
mutation experiment (confirmed by `diff` against the real source after each revert).

## Mutation table

| # | Mutation | Caught? | By which test |
|---|---|---|---|
| 1 | Revert `initialize()`'s `throw err` (delete rethrow) | **YES** | `Fix 0a > initialize() rejects when the worker reports an init error`; also `Fix 0b > device-lost during init rejects the pending init promptly` (indirectly, via its `isLoading()`/`isReady()` checks) |
| 2 | `disposeSync()` clears `this.loading = false` unconditionally | **NO — GAP** | none; all 17 tests still pass |
| 3 | Delete the `if (this.worker !== created) return;` supersession guard | **NO — GAP** | none; all 17 tests still pass (the test written for exactly this, "a superseded worker cannot terminate its replacement," is vacuous — see below) |
| 4 | `probeGpuCapability()` returns `'unavailable'` instead of `'unknown'` for indeterminate | **NO — GAP** | none; the real `webgpu-bridge-adapter.js` is never `require`d by any test file |
| 5 | Revert `requestMicRelease` to call `releaseMicStream()` unconditionally | **YES** | `Fix 1 > defers the mic release while a recording is in progress`; `Fix 1 > a deferred release is applied once the recording stops` |
| 6 | Revert warm path to `if (wasWarm) fireCaptureReady('warm')` with no gate | **NO — GAP** | none; all 17 tests still pass |
| 7 | Remove `!(remoteWantsWebgpu && !gpuUsable)` clause in `_restoreModelSelection()` | **YES** | `Fix 9 > does NOT select WebGPU via the remote-config fallthrough when the GPU is absent` |

**4 of 7 mutations caught. 3 of 7 slip through with all 17 tests green** — mutations 2,
3, and 6 each revert or corrode the exact bug the test suite claims to guard against,
and the suite doesn't notice.

---

## Headline findings (the 3 uncaught mutations)

### 1. Mutation 3 — the supersession guard's own test is vacuous

`app/renderer/app/webgpu/inference-orchestrator.ts:96-99`:
```ts
// Only act if this worker is STILL the active one. Without this, a
// late event from a superseded worker would terminate its
// replacement and stomp the newer init's state.
if (this.worker !== created) return;
```
Deleting this line makes **zero** tests fail. The test that exists to cover it —
`test/orchestrator.test.mjs:122-149`, "a superseded worker cannot terminate its
replacement" — never actually exercises the removed branch, because
`testkit/fake-worker.mjs:34-41`:
```js
emit(data) {
  if (this.terminated) return;
  for (const fn of [...this.listeners]) fn({ data });
}
```
By the time the test calls `staleWorker.emit({ type: 'device-lost', ... })` (line 142),
`staleWorker.terminated` is already `true` (set by the `orch.dispose()` call at line
131, three lines earlier in the same test). `emit()` refuses to deliver, so the
listener containing the guard — mutated or not — is **never invoked**. The final
assertions (`freshWorker.terminated === false`, `orch.isLoading() === true`) pass
trivially because nothing happened, not because the guard fired correctly. Confirmed
empirically: with the guard deleted, all 17 tests still pass.

This is the fake doing the test's job for it, exactly as flagged in the task brief.
There is currently no way, with this fake, to simulate a genuinely in-flight (not yet
terminated) stale worker delivering a late message — which is the actual race the
guard defends against (a message already in the event queue when `dispose()` runs).

**Suggested fix:** give `FakeWorker` an `emitEvenIfTerminated()` escape hatch (or make
`terminate()` not synchronously flip `terminated` before queued messages drain), and
rewrite the test to hold `staleWorker` at "message in flight, not yet terminated" when
`emit()` is called — e.g. capture the listener reference before disposing, or emit
before calling `dispose()` completes its synchronous body.

### 2. Mutation 2 — the loading-guard test never reaches the state it names

`test/orchestrator.test.mjs:104-120`, "dispose() with no request in flight does not
clear the loading guard," never actually calls `dispose()` with no request in flight.
By the time `orch.dispose()` runs (line 118), `sendMessage()` has already posted the
`init` message and set `this.pending` (confirmed by instrumenting the scratch copy:
after a single `flush()` — `setTimeout(0)` — the fake worker has already received
`{ type: 'init', backend: 'wasm' }`, because `prepareModelCache()` under the test stub
only awaits microtasks, which a macrotask tick fully drains). So `dispose()` always hits
the `if (pending)` branch, which rejects the pending request and, via `initialize()`'s
own `finally`, clears `loading` regardless of the mutation. The test also never asserts
`isLoading()` after `first` settles — it only checks `isLoading() === true` *before*
`dispose()`. Combined, the mutation (clearing `loading` unconditionally inside
`disposeSync()`) is invisible to this test.

The recon doc it's named for (Recon A) describes the *actual* dangerous case: `dispose()`
landing **before** `sendMessage()` has run (e.g., mid-`prepareModelCache()`), where
`pending` is still `null` and the worker may not even exist yet — that's precisely the
"no request in flight" state the test's name promises but never reaches.

### 3. Mutation 6 — the "warm path included" gate tests never call the warm path

`test/audio-capture.test.mjs:88-138`, the whole "Fix 5" describe block, only calls
`cap.maybeFireCaptureReady(...)` directly and the static `AudioCapture.readySamplesFor(...)`.
None of the four tests call `startRawRecording()`. Reverting the actual wiring in
`app/renderer/app/audio/AudioCapture.ts:505-506` back to the pre-fix
`if (wasWarm) fireCaptureReady('warm')` (bypassing `maybeFireCaptureReady` entirely on
the warm path) is **not caught** — all 17 tests still pass. The tests prove the gate
*function* requires real audio when called; they do not prove production code actually
*calls* it on the warm path instead of short-circuiting. Given the fix's own description
("the WARM path... fired it immediately with no checks at all"), this is exactly the
regression the suite exists to prevent, and it's the one path with no integration-level
test at all.

---

## Vacuous / tautological assertions

- **`assert.rejects(fn, 'plain string')` does not validate the rejection reason.**
  `test/orchestrator.test.mjs:96-99`:
  ```js
  await assert.rejects(
    () => withinMs(initPromise, 1000),
    'device-lost must reject the pending init instead of leaving it for the 900s timeout',
  );
  ```
  Confirmed empirically (`node -e "assert.rejects(() => Promise.reject(new Error('x')), 'unrelated string')"` → passes). Node only uses a string 2nd-arg as a message-on-failure fallback; it does not check *why* the promise rejected. So this call would also pass if `initPromise` never settled and `withinMs`'s own 1000ms watchdog fired instead (i.e., against the pre-fix code, which doesn't reject device-lost promptly at all). The real regression protection for this test comes entirely from the two lines that follow it — `assert.strictEqual(orch.isLoading(), false, ...)` and `assert.strictEqual(orch.isReady(), false)` — which *do* correctly distinguish old vs. new behavior (on old code `loading` would still be `true` at that point, since `initialize()`'s `finally` hasn't run). The test as a whole is sound; the `assert.rejects` call inside it is decorative.

- **The supersession test's tail assertions are tautological**, as detailed above — they
  pass because the fake refuses to deliver the message, not because the guarded code ran.

No case was found of a test asserting purely "a fake/mock was called" divorced from
observable production state (e.g., `workers.length === 1` in
`orchestrator.test.mjs:116` is a legitimate proxy — a second Worker really would be a
second ~2.5GB model in memory, and the array is populated by the injected factory
observing real `createWorker()` calls, not asserting the double was invoked for its own
sake).

---

## Would these tests have passed against the pre-fix code?

| Test | Would pass pre-fix? | Note |
|---|---|---|
| Fix 0a: init error rejects | No | Old code swallowed the error and resolved — legit regression guard |
| Fix 0a: concurrent init → `AlreadyLoadingError` | No | `AlreadyLoadingError` is new; old code (if it guarded at all) didn't throw this type |
| Fix 0b: device-lost rejects promptly | No (via the tail asserts, not the `rejects` call — see above) | |
| Fix 0b: dispose w/ no request in flight | **Untestable claim** — as shown, the test never reaches that state either way | Weak regardless of fix status |
| Fix 0b: superseded worker | **Vacuous both ways** — passes regardless of guard, pre- or post-fix | See headline finding #1 |
| Fix 1: defers release while recording | No | Old code released unconditionally — legit |
| Fix 1: releases immediately when idle | **Yes, passes on both** | Legitimate non-regression check (guards against a naive "always defer" overcorrection), not a bug-catcher |
| Fix 1: deferred release applied on stop | N/A | `applyPendingMicRelease`/`micReleasePending` are new API surface; couldn't run pre-fix |
| Fix 5: muted-gate / energy-flows / reset-on-silence (3 tests) | **Yes, passes on both** | These test `maybeFireCaptureReady` itself, whose cold-path logic predates this fix; they don't exercise the warm-path wiring the fix changed (see headline finding #3) |
| Fix 5: warm threshold < cold, not zero | N/A | New static method, but only checks the numbers, not that they're consulted |
| Fix 9: rejects webgpu when GPU absent | No | Legit |
| Fix 9: restores webgpu when present but not warm | Designed as a guard against a *plausible wrong fix* (v1 DoD gating on `isAvailable()`), not literally pre-fix code | Good practice, correctly documented in its own comment |
| Fix 9: selects webgpu when present+warm | **Yes, passes on both** | Baseline positive-path check |
| Fix 9: rejects via remote-config fallthrough | No | Legit (mutation 7) |
| Fix 9: falls through to local, no saved pref | **Yes, passes on both** | Baseline, not discriminating |

---

## Over-faithful fake: `fake-worker.mjs`

Covered above (headline finding #1). One additional, narrower note: `emit()`'s early
return on `terminated` is *correct* modeling for the general case (a truly dead worker
can't deliver a message) — the problem is specifically that the one test relying on
"stale-but-not-yet-torn-down" delivery has no way to reach that state with the current
fake, because the test's own setup (`orch.dispose()`) always terminates the stale worker
before the late event is emitted.

## Timing dependence: `flush()` = `setTimeout(0)`

`test/orchestrator.test.mjs:40`: `const flush = () => new Promise((r) => setTimeout(r, 0));`
comments that it exists to get "past all pending microtasks (`prepareModelCache` awaits
several)." Verified empirically: with the current stub (`stubBrowserStorage()` — no
`navigator.storage.persist`, synchronous `localStorage`), `prepareModelCache()` only
awaits microtasks (one `await requestPersistence()` that short-circuits, then
synchronous `localStorage` calls), so a single macrotask tick reliably drains it —
confirmed by probing that `workers[0].posted` already contains the `init` message
immediately after one `flush()`.

This is reliable **today**, but it is timing-dependent on an implementation detail of
`model-cache.ts` that the test doesn't control: if `prepareModelCache()` ever gains a
real async hop (e.g., the `clearParakeetStore()` IndexedDB path, which real Chromium
resolves via a task queue, not a microtask — currently untriggered under test because
`previousVersion` is always null on a fresh stub) or `requestPersistence()` starts doing
real work, a single `setTimeout(0)` may no longer be enough, and tests would start
flaking intermittently rather than failing loudly.

**Suggested more robust alternative:** poll for the specific condition the test actually
needs (e.g., `await waitUntil(() => latest()?.posted.length > 0)` with a bounded retry
loop over `setTimeout(0)` or `setImmediate`) instead of assuming a fixed number of ticks.
Even simpler: have `FakeWorker` expose a promise that resolves on first `postMessage()`,
and await that directly instead of guessing via a timer.

## Private-field access in `audio-capture.test.mjs`

Tests write directly to TypeScript `private` fields (`cap.rawStream`, `cap.rawWorklet`,
`cap.micReleasePending`) and call `private` methods (`cap.maybeFireCaptureReady(...)`,
implicitly via `feed()`). This works at runtime because `private` is erased by esbuild
(no `#`-based true privacy), and it is **never type-checked**: `tsconfig.json`'s
`include` is `["app/**/*"]` only — `test/` and `testkit/` are outside the TS project, and
`testkit/ts-loader.mjs` explicitly notes "Type errors are not reported here; `npm run
typecheck` owns that." So `npm run typecheck` never sees these files, and there is no
compiler backstop at all against the private-access coupling.

Practically: this couples the tests tightly to internal field names. Renaming
`rawStream` → `micStream`, or refactoring the readiness-tracking fields
(`captureReadyFired`/`captureReadySamples`) into a small state object — either of which
would be an *entirely internal, behavior-preserving* refactor — silently breaks these
tests with no compile-time signal, only a runtime test failure (or worse, if the field
name collision is coincidental, a silently-wrong test).

**Better seam:** the class already has one good precedent —
`AudioCapture.readySamplesFor()` is `static` and pure specifically so it's testable
without reaching into instance internals (per its own doc comment, "Exposed (static,
pure) so the thresholds are unit-testable"). The same pattern could be extended: a
small constructor-injectable "fake mic driver" or an exported pure `computeReadyGate()`
function (taking track-muted state + rms history and returning fire/no-fire) would let
tests exercise the gating logic through a public, refactor-safe seam instead of
poking `rawStream`/`rawWorklet` directly.

## Coverage gaps — no test at all

1. **`CaptureApp.tsx`'s 3-strike backoff consumer (Fix 0a's actual point).** The fix's
   own DoD says: "`initFailRef` increments per consecutive failure; after 3, auto
   re-init halts... `webgpu:model-ready(true)` fires only on genuine readiness." The
   orchestrator tests prove `initialize()` now rejects and distinguishes
   `AlreadyLoadingError` — but **nothing tests the caller**. `app/renderer/app/CaptureApp.tsx`
   (`initFailRef`, lines ~46, 68, 79-84, 470) is never imported or referenced by any test
   file. There is no test proving `AlreadyLoadingError` is actually excluded from the
   3-strike count, that the counter trips at exactly 3, or that `webgpu:model-ready`
   isn't sent after a failed init. `grep -rln "CaptureApp" test/` → no matches.

2. **Fixes 3, 3b, and 4 (hotkey-live-at-launch / dev-prod asset gating / bounded
   renderer-load-failure → error tray state) have zero automated test coverage.**
   `grep -rln "main-simple\|tray-manager\|engineReadyRef\|did-fail-load" test/` → no
   matches. Per `_review/FIX-PLAN.md`'s DoD v2 table these fixes are evidenced only as
   `(S)` (typecheck/manual code inspection) and `(W)` (Windows manual click-through),
   which is defensible for `main-simple.js`'s dependence on real `BrowserWindow`/
   `globalShortcut` — but it means three of the seven fixes have no regression guard
   that runs in CI or on `npm test` at all; a revert of any of them would only be caught
   by a human doing the Windows manual checklist.

3. **The warm-path *wiring* in `AudioCapture.startRawRecording()` (headline finding
   #3).** Already covered above — worth repeating as a coverage gap in its own right,
   since it's the single highest-value missing test in the suite: one integration test
   that calls `startRawRecording()` with a pre-warmed `rawStream` and asserts
   `onCaptureReady` does *not* fire before the worklet delivers energy-bearing frames
   would close mutation 6, close the "warm path included" name-vs-reality gap, and
   would have been cheap to write given the fakes already exist.

Runner-up gaps, noted but not detailed: `track.onended` wiring (called out in Fix 1's
DoD as "wired to abort with a distinct cue" but no `onTrackEvent`/`onended` reference
anywhere in `test/`), and the real `WebGpuBridgeAdapter` class in general — as shown by
mutation 4, it is not exercised by any test; every Fix 9 test replaces it with a
hand-written two-state fake that doesn't model the real three-state
`available`/`unavailable`/`unknown` contract at all.
