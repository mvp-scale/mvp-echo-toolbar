# H — Definition-of-Done Conformance Audit

**Scope:** `git diff 515f4fc..HEAD -- mvp-echo-toolbar/` against `_review/FIX-PLAN.md` §"Definition of
Done — v2 (post-recon, authoritative)". Rows audited: **8, 0a, 0b, 1, 3, 3b, 4, 5, 9**. Rows 0c, 0e,
0d, 0f confirmed genuinely not implemented (see end of doc).

**Method:** read every changed hunk in the seven commits (`f3c915c`, `3515c42`, `5a33e9e`, `20e3658`,
`6ad64be`, `a747e9d`, `ee7560b`); ran `npm test` (17/17 pass) and `npx tsc --noEmit` (green, 2.7s);
ran `git check-ignore -v` for the four claimed-gitignored artifacts from both the outer repo root and
the inner project dir. No source modified.

---

## Summary table

| Fix | Done when | Evidence | Must not regress | Overall |
|---|---|---|---|---|
| **8** | MET | MET | MET | **MET** |
| **0a** | MET | MET | MET | **MET** |
| **0b** | MET | MET | PARTIALLY MET — happy-path "normal init completes" has no test | **PARTIALLY MET** |
| **1** | PARTIALLY MET — `track.onended` abort-with-distinct-cue never wired | PARTIALLY MET — no (W) check recorded; tracking table overclaims ✅ | MET | **PARTIALLY MET** |
| **3** | PARTIALLY MET — no new tray icon (DoD explicitly asked for one) | PARTIALLY MET — (H) log-timestamp evidence absent, no test file exists | MET | **PARTIALLY MET** |
| **3b** | MET | MET | MET | **MET** |
| **4** | MET | MET | MET | **MET** |
| **5** | MET | MET | MET | **MET** |
| **9** | MET | MET | MET | **MET** |
| **0c / 0e / 0d / 0f** | genuinely absent, confirmed | — | — | **NOT IMPLEMENTED (correctly unclaimed)** |

**Fixes not fully MET: 0b, 1, 3.** Details below.

---

## Fix 8 — Typecheck gate

**Done when** — all four clauses MET:
- `npm run typecheck` exists, passes: `mvp-echo-toolbar/package.json:12` — `"typecheck": "tsc --noEmit"`. Ran it: exit 0, 2.7s.
- Uses `--noEmit` not `tsc -b`: confirmed above; `tsconfig.node.json` has no `"noEmit"` key, so `-b` would indeed emit.
- 4 artifacts gitignored: `.gitignore:107-109` (outer repo root):
  ```
  *.tsbuildinfo
  mvp-echo-toolbar/vite.config.js
  mvp-echo-toolbar/vite.config.d.ts
  ```
  Verified with `git check-ignore -v`, run from **both** the outer root and from inside the inner
  project dir (the exact "one level up" trap the task called out):
  ```
  $ git check-ignore -v mvp-echo-toolbar/vite.config.js      # from outer root
  .gitignore:108:mvp-echo-toolbar/vite.config.js	mvp-echo-toolbar/vite.config.js
  $ git check-ignore -v vite.config.js                        # from inner project dir
  .gitignore:108:mvp-echo-toolbar/vite.config.js	vite.config.js
  $ git check-ignore -v tsconfig.tsbuildinfo tsconfig.node.tsbuildinfo   # both match *.tsbuildinfo
  ```
  All four paths match from both locations. Not a bug — the patterns are correctly prefixed with
  `mvp-echo-toolbar/` for the two vite.config files, and `*.tsbuildinfo` matches anywhere.
- Single existing error fixed: `mvp-echo-toolbar/app/renderer/app/PopupApp.tsx` — `const langDisplay = '';` line removed entirely (confirmed absent via `grep -n langDisplay`), not merely silenced.

**Evidence (S)** — MET. `npx tsc --noEmit` from the inner dir: exit 0 in 2.705s, matches the DoD's "~2.7s" claim exactly.

**Must not regress** — MET. Diff for this fix touches only `package.json`, `.gitignore`, and one dead-variable removal in `PopupApp.tsx`. No behavioral line changed.

**dist pipeline check:** `package.json:9` — `"dist": "npm run clean && npm run typecheck && npm run build && electron-builder --win --publish=never"`. Typecheck is inserted before build/packaging — sane ordering, a type error blocks the pipeline.

---

## Fix 0a — Orchestrator init failures surface

**Done when** — all clauses MET:
- Failed `initialize()` rejects: `inference-orchestrator.ts:126` — `throw err;` at the end of the catch block (previously swallowed).
- `initFailRef` increments per consecutive failure, halts after 3 with a log: `CaptureApp.tsx:83` (`initFailRef.current += 1`) and `CaptureApp.tsx:470-473` (`if (initFailRef.current >= 3) { ...'init failed 3× — not auto-retrying'... }`).
- `webgpu:model-ready(true)` fires only on genuine readiness: `CaptureApp.tsx:75` — `if (ipc && orchestratorRef.current.isReady()) ipc.invoke('webgpu:model-ready', true);`
- `AlreadyLoadingError` is a distinguishable type excluded from the 3-strike count: `inference-orchestrator.ts:26-31` (class def), `:75` (`throw new AlreadyLoadingError()`), `CaptureApp.tsx:80-84` (`if (e instanceof AlreadyLoadingError) { ...; return; }` — returns **before** `initFailRef.current += 1`).
- New observable (Settings no longer reports false "model loaded"): same code as the `model-ready` gate above — the IPC is never sent `true` unless `isReady()`.

**Evidence** — MET. `test/orchestrator.test.mjs` describe "Fix 0a" — 2 tests, both pass (verified via `npm test`: `ok 4 - Fix 0a — init failure must surface to the caller`, 2 subtests green). IPC gating verified by static read (S).

**Must not regress** — MET:
- Successful init still resets counter: `CaptureApp.tsx:68` — `initFailRef.current = 0;`.
- 15s cooldown still applies: `CaptureApp.tsx:472` — `else if (sinceLast > 15000)`.
- "0 call sites need a new catch": confirmed by exhaustive grep — the **only** direct call to `.initialize()` in the renderer is `CaptureApp.tsx:67`, inside the try/catch of `initWebGpuOrchestrator`. All other sites (`CaptureApp.tsx:106, 142, 474`) call `initWebGpuOrchestrator()` itself, un-awaited — since that function's own try/catch absorbs every rejection internally, no caller needs new error handling.

---

## Fix 0b — Teardown settles in-flight requests

**Done when** — all clauses MET:
- `device-lost` during init rejects within ~1s: tested and passing (`test/orchestrator.test.mjs`, "device-lost during init rejects the pending init promptly").
- `isLoading()` clears: same test, asserts `orch.isLoading() === false`.
- next press can re-init: consistent with the cooldown/backoff logic in Fix 0a (not independently re-tested here, but logically dependent on `isLoading()` clearing, which is proven).
- `loading` cleared/rejected **only when a pending request exists**: `inference-orchestrator.ts:178-182` —
  ```js
  const pending = this.pending;
  if (pending) {
    this.pending = null;
    pending.reject(reason ?? new Error('Inference worker torn down'));
  }
  ```
  and the comment at `:186-190` explains `loading` is deliberately left to `initialize()`'s `finally`. Tested: "dispose() with no request in flight does not clear the loading guard" — passes, and additionally asserts a second concurrent `initialize()` is still refused (`workers.length === 1`).
- Epoch/generation guard: `inference-orchestrator.ts:99` — `if (this.worker !== created) return;` inside the device-lost listener, keyed on worker-reference identity rather than a numeric epoch, but functionally equivalent. Tested: "a superseded worker cannot terminate its replacement" — passes, asserts the replacement worker survives a late `device-lost` from the terminated stale worker and `isLoading()` stays `true` for the newer init.

**Evidence** — MET. All three claimed assertions (rejection latency, `isLoading()`, worker count == 1) are present and passing in `test/orchestrator.test.mjs`.

**Must not regress** — **PARTIALLY MET**:
- 900s init timeout backstop remains: MET — `inference-orchestrator.ts:108`, unchanged `900000`.
- `transcribe`'s 120s path fixed identically: MET — `inference-orchestrator.ts:145`, `120000`, and it shares the same `sendMessage()`/`pending` machinery as init, so the same settle-on-teardown behavior applies to it automatically.
- **"Normal init completes" — not actually tested.** All three `test/orchestrator.test.mjs` "Fix 0b" tests, plus both "Fix 0a" tests, drive the orchestrator through a **failure** or **concurrent-rejection** path. None emits a successful `'ready'` reply and asserts the promise **resolves** and `isReady()` becomes `true`. This matters because the refactor materially touched the success path too: `cleanup()` (`inference-orchestrator.ts:220-225`) now does `if (this.pending === entry) this.pending = null;` on **every** settle, success included, and this logic did not exist before. The happy path is very likely fine by inspection, but the DoD's own evidence class for this row is (H), and the happy-path regression is the one clause with zero harness coverage.

---

## Fix 1 — `devicechange` must not truncate a recording

**Done when** — **PARTIALLY MET** (2 of 3 clauses):
- `devicechange` while recording does not stop mic tracks: MET — `AudioCapture.ts:391` now calls `requestMicRelease('devicechange')` instead of the old unconditional `releaseMicStream()`; `requestMicRelease` (`:415-423`) defers when `this.rawWorklet` is truthy (a live recording), setting `micReleasePending = true` instead of touching the stream. Tested and passing (`test/audio-capture.test.mjs`, "defers the mic release while a recording is in progress").
- Defer design (flag + release right after `stopRawRecording()`): MET — `stopRawRecording()` at `AudioCapture.ts:681-682` checks `if (this.micReleasePending) { this.applyPendingMicRelease(); }` before falling through to the normal release-mode logic. Tested and passing ("a deferred release is applied once the recording stops").
- **`track.onended` wired to abort with a distinct cue: NOT MET.** `AudioCapture.ts:380` still just does `track.onended = () => { this.onTrackEvent?.('ended'); };` — unchanged by this diff (no hunk touches this line in `git diff 515f4fc..HEAD`). `CaptureApp.tsx:177` still wires `onTrackEvent` to diagnostics only: `audioCapture.current.onTrackEvent = (kind: string) => sendDiag(\`track-event: ${kind}\`);` — also unchanged. There is no abort call, no distinct cue, and no test for it anywhere (`grep -rn "onended|onTrackEvent" test/` returns nothing). The DoD's stated rationale — "`devicechange` carries no device identity" so `onended` is "the only signal actually tied to the in-use device" — is left unaddressed: a genuine unplug of the in-use mic still only produces a silent diagnostics line, not an abort.

**Evidence** — **PARTIALLY MET**. DoD names `(S) pre-check + (W) plug/unplug mid-recording`. The (S) static read supports the devicechange-defer half. The (W) manual check is **not documented anywhere** in FIX-PLAN.md's "Windows manual checks" table (that table has exactly 4 rows, for fixes 4 and 3 only — Fix 1 does not appear). Despite this, the tracking table (`_review/FIX-PLAN.md` row 7) marks Fix 1 **`✅` "verified against DoD"** — the highest status, reserved (per the table's own legend) for a DoD that has been fully satisfied. That claim is overstated on two counts: the onended clause isn't implemented, and the (W) evidence the DoD itself demands was never produced or scheduled.

**Must not regress** — MET. The critical regression guard — "the next recording after a device event must still cold-acquire" — holds: `applyPendingMicRelease()` calls `releaseMicStream()` (`AudioCapture.ts:437-446`), which nulls `this.rawStream`; `acquireMicStream()`'s warm-reuse branch requires a truthy `this.rawStream`, so the next call falls through to the cold `getUserMedia()` path (`:336-343`), which is also what re-arms the full cold energy gate.

---

## Fix 3 — Hotkey registered before engine init

**Done when** — **PARTIALLY MET**:
- `globalShortcut.register()` completes before engine init is awaited: MET — register call at `main-simple.js:473`, `waitForFirstLoad()` await at `:508` and `engineManager.initializeAndSignalReady()` at `:525` both come **after** registration returns.
- Early press produces "still starting" cue: MET — `main-simple.js:483-486`: `if (!engineReady) { log(...'received before engine ready'...); trayManager.setState('starting'); return; }`.
- Explicit `engineReadyRef`, not inferred: MET — `let engineReady = false;` (`:124`), flipped `true` only after `initializeAndSignalReady()` resolves (`:528`).
- **New tray `starting` state and a new icon: PARTIALLY MET.** The state exists — `tray-manager.js:17`: `starting: { icon: 'tray-processing.png', tooltip: 'MVP-Echo - Starting up...' }` — so `setState('starting')` is a recognized key and no longer silently no-ops, satisfying that half of the DoD's own stated rationale. But **no new icon file was added**; it reuses `tray-processing.png` verbatim. The DoD text is explicit: "a new tray `starting` state **and a new icon**." The code comment (`tray-manager.js:14-16`) defends the reuse on the grounds that the tooltip carries the distinction — a reasonable call, but it's a documented deviation from the literal DoD, not what was specified.

**Evidence** — **PARTIALLY MET**. DoD names `(S) statement order + (H) log-timestamp assertion`. The (S) half is confirmed by direct read of the statement order above. The **(H) half does not exist**: `find test/ -iname '*main*'` / `ls test/` shows only `audio-capture.test.mjs`, `engine-selection.test.js`, `orchestrator.test.mjs` — there is no test file for `main-simple.js` at all, so no log-timestamp assertion (or any other headless test) exercises the registration-before-init ordering or the `engineReady` gate. The tracking table correctly reflects this by marking the row `🟩` (not `✅`) — but `🟩`'s own definition is "awaiting **Windows-manual** evidence," which conflates a missing (H) test with a genuinely W-only requirement. The (H) evidence recon promised for this row was never produced.

**Must not regress** — MET:
- No double registration: MET — exhaustive grep for `globalShortcut.register` finds exactly one call site (`main-simple.js:473`).
- `unregisterAll()` on quit: MET — `main-simple.js:539`, in the `will-quit` handler, untouched by this diff.
- 500ms debounce: MET — `main-simple.js:499`, `}, 500);`, unchanged.

---

## Fix 3b — Correct dev/prod asset gating

**Done when** — MET. `shouldUseDevServer()` (`main-simple.js:140-151`) is `!app.isPackaged && process.env.NODE_ENV === 'development'`, replacing the old bare `process.env.NODE_ENV === 'development'` check at all three call sites: `createHiddenWindow` (`:218`), `createPopupWindow` (`:285`), `showWelcomeWindow` (`:395`) — confirmed via `git diff`, all three sites changed identically.

**Evidence (S)** — MET, confirmed by reading `package.json` scripts: `dev:electron` sets `NODE_ENV=development` explicitly with an unpackaged Electron process (dev server path taken); `start` (`"electron ."`) runs unpackaged with no `NODE_ENV` override (falls through to the built `dist/renderer/` path, not misrouted to the dev server) — matches the function's own doc comment rationale.

**Must not regress** — MET (by the same static analysis; no headless test exists but none was required by the DoD, which only lists `(S)`).

---

## Fix 4 — Bounded renderer-load failure

**Done when** — MET:
- Error tray state within 15s: MET — `waitForFirstLoad(win, timeoutMs = 15000)` (`main-simple.js:155`); on failure, `trayManager.setState('error')` (`:516`).
- Resolves with a status object, not reject: MET — `resolve({ ok: false, reason })` / `resolve({ ok: true })` throughout `waitForFirstLoad`, never a `reject`.
- Skip engine init, route through existing `rendererCrashCount`/`MAX_RENDERER_CRASHES`: MET — on failure the handler at `main-simple.js:512-520` increments the **same** module-level `rendererCrashCount` used by the pre-existing `render-process-gone` handler (`:238-249`) and logs it against `MAX_RENDERER_CRASHES`, then `return`s before reaching `engineManager.initializeAndSignalReady()`. (Note: unlike the `render-process-gone` handler, this branch doesn't itself branch on exceeding the cap — there's no retry to gate at startup — but it does share the counter/budget as the DoD asked, rather than inventing a new one.)

**Evidence** — MET. `(S)` confirmed above. `(W)`: documented in FIX-PLAN.md's Windows manual checks, row 5: "Rename `dist/renderer/index.html`, launch the exe" → "Tray goes to **error** within ~15s and the log names the failed load."

**Must not regress** — MET. Normal path (`loadResult.ok === true`) falls through unchanged to `engineManager.initializeAndSignalReady()`; subframe failures and `ERR_ABORTED` (`errorCode === -3`) are explicitly excluded from triggering `onFail` (`main-simple.js:170-172`), guarding against a spurious error on a merely slow or normally-superseded load.

---

## Fix 5 — Warm-mic path proves audio before firing the cue

**Done when** — MET:
- Warm path gates on `track.muted === false` AND real energy: MET — the `if (!wasWarm) this.maybeFireCaptureReady(...)` guard was removed; the call is now unconditional (`AudioCapture.ts:526`), and `maybeFireCaptureReady` (`:560-573`) checks `track.muted` (`:563`) and accumulates contiguous above-floor RMS for both paths.
- Concrete budget (~50ms warm / ~100-150ms fallback vs. cold 250ms/2000ms): MET — `READY_SECONDS_WARM = 0.05` (`:135`), `READY_FALLBACK_WARM_MS = 150` (`:136`), vs. unchanged `READY_SECONDS_COLD = 0.25`-equivalent (250ms, via `readySamplesFor`) and `READY_FALLBACK_MS = 2000` (pre-existing, untouched).
- Implementation shape matches the DoD's description (parameterized threshold via `readySamplesFor(sampleRate, wasWarm)` at `:142-146`, used at `:514`).

**Evidence (H)** — MET. `test/audio-capture.test.mjs` describe "Fix 5" — 4 tests, all passing: mute gate, fires-on-energy, contiguous-energy-reset, and warm-vs-cold threshold comparison (`warm > 0`, `warm < cold`, `warm <= 16000*0.1`).

**Must not regress** — MET:
- Cold path unchanged: `READY_SECONDS_COLD`/`READY_FALLBACK_MS` values are untouched by the diff.
- Warm latency advantage preserved, no fallback to the 2s cold timeout: `READY_FALLBACK_WARM_MS = 150` is a distinct constant from the cold `2000`, selected via the ternary at `AudioCapture.ts:541`.

---

## Fix 9 — Live GPU probe wins over stale saved preference

**Done when** — MET:
- Three-state hardware-only probe: MET — `webgpu-bridge-adapter.js:117-129`, `probeGpuCapability()` returns `'available' | 'unavailable' | 'unknown'`, explicitly documented as hardware-only and distinct from `isAvailable()`.
- `'unknown'` (indeterminate) treated as "trust the saved preference": MET — `_probeGpu()` now tags an indeterminate result (`indeterminate: true`) when the hidden window isn't ready (`:208-210`) or `executeJavaScript` itself throws (`:244-246`), and never caches an indeterminate result (`if (!capability.indeterminate) { this._gpuCapability = capability; }` — both in `isAvailable()` at `:85-88` and `probeGpuCapability()` at `:118-121`). In `engine-manager.js`, `_restoreModelSelection()` only overrides the saved preference on a **definitive** `'unavailable'` (`gpuUsable = ... !== 'unavailable'`, `engine-manager.js:186-188`).
- Collapsed 4 call sites into 1: MET — `engine-manager.js:131`, single `await this._restoreModelSelection();` at the end of `initialize()`, replacing the three early-return branch calls plus the fallback-branch call that existed before (confirmed via diff — each of the four prior `return { adapter: ..., ... }` branches called `this._restoreModelSelection()` individually).

**Evidence (H)** — MET. `test/engine-selection.test.js`, 5 tests, all passing, using the `require.cache` electron stub (`testkit/electron-stub.js`) with zero production-code changes, exactly as recon claimed. Tests directly cover: GPU definitively absent → doesn't select WebGPU; GPU present but model not yet warm → **does** restore WebGPU (the critical anti-regression case); GPU present and warm → selects WebGPU; the remote-config fallthrough (`webgpu-*` string prefix match) also respects the probe; no saved preference → falls through to local.

**Must not regress** — MET. "A working saved WebGPU preference still restores across restarts" is the second test above (`'DOES restore WebGPU on cold boot when the GPU is present but the model is not yet warm'`), which is exactly the v1-DoD-breaking scenario the recon caught — it passes.

---

## Rows 0c, 0e, 0d, 0f — confirmed genuinely absent, not half-done

- **0c (chunking):** `inference-worker.ts:126` still has `returnTimestamps: false` (unused downstream, per its own comment) with no chunking code anywhere in the diff or the current tree. `grep` for `LCSPTFAMerger`/chunk-window logic in `app/renderer/app/webgpu/` returns nothing.
- **0e (transfer list / trim-once):** `inference-orchestrator.ts:235` — `worker.postMessage(message);` — no second (transfer list) argument. `CaptureApp.tsx:309` and `:318` both independently call `trimSilence(pcm)` — the retry re-runs it rather than reusing the first result, exactly the bug the fix was meant to close.
- **0d (dispose orchestrator on switch-away):** `engine-manager.js:360-391`, `switchModel()` — the `webgpu-*` branch calls `this.webgpuAdapter.switchModel(modelId)` and sends `webgpu:init-orchestrator` to warm up; there is no corresponding disposal call on the branches that switch **away** from WebGPU (`local-*`, remote) — nothing tears down the renderer-side `InferenceOrchestrator` or its ~2.5GB resident worker.
- **0f (diag cap/evict + sweep mismatch):** confirmed still broken exactly as `raw/10-retention-audit.md` F1 describes. The startup orphan sweep (`main-simple.js:40-49`, untouched by this diff) matches `mvp-echo-audio-*.webm` directly in `os.tmpdir()`. The actual diagnostics audio directory (`main-simple.js:598`, `diagAudioDir = path.join(os.tmpdir(), 'mvp-echo-audio')`) is a **subdirectory** (no trailing dash) holding sanitized-name `.wav` files written by `diag:save-audio` (`:599-608`) — a different path and a different extension, so the sweep still never touches it. No cap/eviction logic was added for either the diag WAV directory or `mvp-echo-diagnostics.log`.

All four are correctly left unclaimed — no row claims MET status for any of these in the tracking table (all show `⬜ not started`), consistent with what the code shows.
