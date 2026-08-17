# Session Bridge — start here to continue this work

_Last updated: 2026-08-17. Human-readable handoff so a fresh conversation starts oriented — no need
to replay an old session. (Auto-memory also loads for this project; this is the readable companion.)_

---

## Current state: `electron-43` ready to release as 3.1.0

**313 tests.** `npm run typecheck && npm test && npm run build` green.
49 commits ahead of `dev`. Version already 3.1.0 in both package.json files; no v3.1.0 tag yet.

Verified on Windows by the maintainer: GPU, CPU and hosted engines all transcribe; GPU→CPU→GPU
switching; selection restored across restart; no tray blinking; no init storm.

> **Honest caveat on first-run.** A genuine COLD download — empty model dir, percentage climbing,
> hotkey pressed mid-download, Windows `.part` handling — was reported working by the maintainer
> rather than captured in a log. Every log on file shows the warm path (`already on disk`). If a
> first-run bug appears later, start there.

### What 3.1.0 is

**The model now lives on disk and is served over loopback.** `model://` cannot work — Chromium
refuses a cross-origin fetch from a `file://` document to any scheme outside
chrome/chrome-extension/chrome-untrusted/data/http/https, and the initiator-origin check runs
before `supportFetchAPI` matters. `http://127.0.0.1` is on that list. `app/main/model-server.js`
is the replacement: ephemeral port, per-session path token, `basename()` confinement, `Host`
check, exact `Content-Length`. On by default; `--no-model-store` is the way back.
Evidence: `_review/LOOPBACK-PROBE.md`.

**The flag that gated it never worked.** `preload.js` read `process.argv.includes('--model-store')`,
but preload runs in the RENDERER, whose command line is Chromium's. Measured: main sees the flag,
preload sees `--type=renderer`. So it was always false, in dev and packaged alike — the store had
no working way to be switched on. Fixed with `additionalArguments`;
`test/renderer-flags.test.js` fails the build if a flag the preload reads is not forwarded.

**A download is no longer indistinguishable from a crash.** `engine-state.js` owns a `downloading`
status plus a percentage, written through one method and guarded on the payload's `modelId` —
what the download is ABOUT — rather than on `state.engine === 'webgpu'`, which would have been the
sixth instance of the `activeAdapter` routing bug. Progress is aggregated across files first,
because parakeet reports per-file and a raw forward walks 0→100% once per file.
Decision and rationale: `_review/DOWNLOAD-STATE-DECISION.md`.

**Prefetch, deliberately visible.** The GPU model is fetched in the background once the user has
chosen the GPU engine, reporting into the same record everything else reads. A silent 1.2GB pull
is not delight, it is a surprise you happen not to notice.

### Open, deliberately

- **#10 — onnxruntime-web is still fetched from cdn.jsdelivr.net on every cold start.** Blocked on
  a dependency bug: parakeet's `initOrt()` destructures a `wasmPaths` option and never assigns it,
  so passing it through does nothing. Setting `ort.env.wasm.wasmPaths` directly works (measured:
  zero CDN requests) but onnxruntime-web is parakeet's dependency, not ours, and a vite
  `resolve.alias` does not reach the worker build. Privacy concern, not functional.
- **#12 — a failed model load reads as "loading" forever** (`engine-state.js` collapses every
  failure into `loading`). The fix means classifying failures in a catch block, and a
  misclassification marks a working GPU unusable on a network blip — which is the mistake that
  once cost a user their 1.2GB encoder. Its own task, its own risk budget.

### The expensive lesson from this session

Enabling that store by default replaced a *working* fp16 path with a broken one, and it was
destructive rather than merely broken: the blocked fetch was read as "fp16 is unusable", which
deleted a user's already-downloaded 1.2 GB encoder and started a 2.4 GB one — then retried 61
times in 50 seconds, because a failed init reported not-ready, which changed the record, which
broadcast, which triggered another init.

Three rules came out of it, and they are restated at the top of `PLAN.md`: never default-enable a
mechanism that has not loaded a model on a real Windows build; a transport error is never a verdict
about capability; and bounds belong at the resource being exhausted, not at each caller.

_Historical detail of the reliability work is in `_review/RELIABILITY-PLAN.md`._

### The headline

`git diff --stat dev electron-43` at the start was **three files, zero application code**. Every
defect found since exists identically on Electron 28. Electron 43 removed two crutches —
`adapter.requestAdapterInfo()` and a permissive COEP posture for the module worker — that had been
keeping the WebGPU path on the happy road. **The app was not regressing because of 43; 43 was the
first time anyone saw what it does when its primary engine fails.**

### State — VERIFIED, ready to merge

- **Tests 34 → 135.** The gate is three commands: `npm run typecheck && npm test && npm run build`.
  Build is not optional — a CommonJS/ESM mismatch once passed both of the other two and still broke
  the bundle.
- 27 of 31 planned items done, 2 dropped with reasons, 1 deferred, plus 5 defects found by testing
  that were never on the list.
- **Fully verified on the XPS** (2026-08-16). Every item in §9 of the plan passed:

| Evidence from the debug log | Confirms |
|---|---|
| `restored model selection: local-fast` | CPU choice survives a restart — the reported bug, closed |
| `wrote engine-state … (exists=true)` | The record persists; migration runs once |
| `mode=raw-pcm, engine=webgpu` → transcript | GPU path, 11–12× realtime |
| `mode=webm, engine=local` → ffmpeg → transcript | CPU path and WAV conversion |
| `[console:popup:error] Model switch failed: …` | Failures are visible; that line went nowhere before |
| `adapterName: "nvidia turing"` | GPU probe and label |

**Every defect the Windows rounds found was in the WIRING between modules, never in the modules
themselves.** The pure logic had tests and was right; the seams had none. Worth remembering before
trusting anything marked "done" that has only been typechecked.

### What was found and fixed

- `adapter.requestAdapterInfo()` was removed in Chrome 131. The probe let that decide availability,
  so Electron 43 reported "no usable GPU on this system" about a working 3090. `webgpu.d.ts`
  hand-declared the removed method, which is why `tsc` stayed green — deleted, along with the dead
  `gpu-detector.ts`.
- COEP blocks the Vite module worker under `file://` on Chromium 150. Cross-origin isolation is now
  **off by default** (`--coi` re-enables). Measured: single-threaded decode is **17.3x realtime** on
  the XPS, faster than the 12.6x recorded *with* threading — so the `app://` origin migration was
  dropped entirely, and with it a 2,371 MB re-download for every existing user.
- The CPU engine could never bootstrap its own bundled model, so a fresh install had no fallback at
  all. Reachable on Electron 28, before the user touches anything.
- "Which model is selected" lived in seven places that disagreed — captured live with three config
  files holding three different ids at once. Now one `engine-state.json`.
- Routing was decided twice, at record start and again at stop, so a mid-recording switch dispatched
  audio to the wrong engine and lost it. Now frozen per recording.
- A loading GPU model no longer kills the hotkey; it falls back to CPU for that recording.
- The logger turned every Error into `{}`. A failed worker hung for 15 minutes with no event. Two of
  three windows forwarded no console output at all.
- **RC-1 appeared four separate times** — routing on "what is active" instead of "what this operation
  is about". `processAudio` dispatch, the WebM→WAV conversion gate, the restore precedence, and
  finally `cloud:configure`/`cloud:test-connection`, which sent the endpoint to the CPU sidecar
  (whose `configure()` drops `endpointUrl`) while the log claimed otherwise. Expect more of this
  shape wherever `this.activeAdapter` is still consulted.

### Do this next

0. ✅ **DONE — the hosted endpoint has an honest state model.** Two commits; see below for what
   is still unverified. The rule that came out of it, in the maintainer's words: *"if the user
   clicks the GPU, the CPU, or the remote GPU model, that should be it. You shouldn't be
   automatically switching. It's the automatic switching that causes the unknown behavior."*

   - **A selection is committed and persisted the instant it is made**, before any adapter or
     network call. Engine-side failure returns a `warning` against a selection that stands.
   - **`applyGpu`/`restore` no longer rewrite `engine`/`modelId`.** A probe may set `status` and
     `reason` only. Six existing tests asserted the old demotion was correct and now assert the
     opposite.
   - **`cloud:get-config` reads the remote adapter, not `activeAdapter`.** The fifth instance of
     RC-1, and a destructive one: opening Settings on the CPU engine *erased* the saved endpoint.
   - **`isConfigured` is gone** from the endpoint payload; `endpointStatusLabel()` reports only
     what was observed — "Not tested" / "Reachable · N models" / "Key rejected" / the transport
     error. Never "Connected", never "Authenticated".
   - Endpoint saves 700 ms after typing stops, and editing the URL or key clears the probe result.

   **The server is the constraint now, and it is a DEPLOYMENT problem, not a code one.**
   `mvp-stt-docker` at v3.0.0 has everything the toolbar wants. The box at
   `192.168.1.169:20300` is running **v1.0.0** — four independent signals agree: `openapi.json`
   says 1.0.0 vs `bridge.py:142`'s `version="3.0.0"`; `POST /v1/models/switch` (bridge.py:175-205)
   404s; `/health` returns `{"status":"ok"}` with no `engine` block; `/v1/models` omits `active`,
   `label` and `group`. **Redeploy and model switching starts working with no client change.**

   ⚠️ **That deployment has no working authentication.** `POST /v1/audio/transcriptions` returns
   200 with no key and with a wrong key. The proxy IS in the request path (`BaseHTTP/0.6` fronting
   `uvicorn`), and the repo's `auth-proxy.py` requires a Bearer key on everything except `/health`
   — so the deployed proxy is stale too. Anyone who can reach that host can use the GPU. **Verify
   after redeploying rather than assuming.** This is also why the toolbar cannot claim the key was
   accepted: a 200 proves nothing when nothing checks. A 401 IS provable, so that path is built
   and will start working by itself once the real proxy is running.

   Also settled by reading the server: **Test Connection must never call `/v1/models/switch`.**
   Only one model is resident at a time and switching unloads it / restarts the inference
   subprocess (`managed_ws_adapter.py:410-411`). A "test" that evicted the loaded model would be
   destructive.

   <details><summary>Original problem statement (kept for context)</summary>

   Maintainer's own words:
   *"Test connection seems to give a false impression that it's connected. There's both connected
   and authenticated, and connected gives the wrong definition."* He is right, and it is worse than
   naming: `remote-adapter.js` defines `isConfigured` as `!!endpointUrl`, so **a URL merely being
   present renders a green "Connected" dot**. Nothing verifies the host answered, that the key was
   accepted, or that the model is switchable.

   At least four distinct facts are being collapsed into one word:

   | Fact | How you learn it | Currently shown as |
   |---|---|---|
   | A URL has been entered | string is non-empty | "Connected" ❌ |
   | The host is reachable | `/health` responds | — |
   | The key is accepted | `/v1/models` returns 200 not 401 | — |
   | A model can be switched | `/v1/models/switch` succeeds | — |

   The plan already specifies the mechanism (§5 rule 4 and item 27): drop `isConfigured` entirely,
   add a persisted `verifiedAt` set **only** by a successful test, and derive the label from
   `status` + `endpoint.verifiedAt`. That was never implemented. Do it with the same discipline as
   the rest: the derivation is a pure function, testable without a DOM, like
   `engine-status-label.ts`.

   Related and unfixed: **`SettingsPanel` saves config on every keystroke.** Typing an endpoint
   produced `Configuring adapter: 1`, then `92.168.1.169:203001`, then the full URL. Wants a
   debounce, and `verifiedAt` must be cleared whenever the URL or key changes — otherwise a stale
   "verified" survives an edit and the dot lies again.

   Also verify **persistence and ordering** of the endpoint fields specifically: they are the one
   surface where the maintainer has doubts, and the one path never confirmed end to end.

   </details>

1. **Merge to `dev` and soak.** Verification is done; nothing is blocking. The plan's own advice is
   separate soaks for a platform bump and for behaviour changes, and this branch is both — so watch
   for engine-selection oddities specifically.
2. **Triage the CDN dependency.** onnxruntime-web is fetched from
   `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.1/...` at runtime, visible in every log. An
   offline, privacy-first app should not pull third-party executable code on every cold start. This
   is a supply-chain decision, not a bug fix, and deserves its own session.
3. **Two things still never exercised.** The model DOWNLOAD path — every run so far has loaded from
   cache, so the ~1.2 GB first-run download is untested and its progress is invisible to the user.
   And the tray revert generation guard, which is unit-tested but has never run live.
4. `--sab` works on Chromium 150 (`SAB function | COI false | cores 16`) but should stay off — it
   relaxes a Spectre mitigation to buy throughput measured as unnecessary.

### Two process fixes worth keeping

- **Artifacts carry the commit sha.** Every build used to produce an identically named exe, so a
  stale download was indistinguishable from a fresh one. That cost three verification rounds in one
  day, each spent debugging code that was not running. When evidence contradicts the code twice,
  suspect the binary before forming a third theory.
- **`--diag` now surfaces browser-level failures.** `forwardConsole()` sends warnings and errors from
  all three windows to the log file, including messages Chromium generates itself, which no
  in-renderer shim can see. That is how the COEP block was finally identified.

---

## Historical: the original Electron 28 migration plan

### Why

**Primary reason is security.** Electron supports the latest three majors; latest is **43.4.0**, so
28.3.3 is 15 majors behind and long EOL — receiving no Chromium security patches, in an app that
fetches ~1.2 GB over the network and renders local HTML with `unsafe-eval` in its CSP.

Two blocked items come along for free, both confirmed by measurement on the XPS — Edge **and**
Chrome report `shader-f16: true` and 18 WebGPU features on the same GPU and driver, while Electron
28 reports `false` and 7:

| Unlock | Value |
|---|---|
| `shader-f16` | fp16 encoder: **2363 MB → 1182 MB**. On the 4096 MB 1650 that is 58% → 29% |
| `timestamp-query` | Real GPU profiling — the thing the (now-dropped) parallel-worker decision was blocked on |

Note fp16 is **memory headroom, not speed**. Do not sell it as a performance fix.

### Version landscape

| Electron | Chromium | Node | Note |
|---|---|---|---|
| **28.3.3** | 120 | 18.18.2 | current — EOL |
| 31.7.7 | 126 | 20.18.0 | |
| 35.7.5 | 134 | 22.16.0 | |
| 39.8.10 | 142 | 22.22.1 | |
| **43.4.0** | 150 | 24.18.1 | latest stable, supported window is 41–43 |

**Recommended target: 43.** Stepping 28→29→…→43 is 15 upgrades of mostly wasted effort for an app
with this small an API surface. Jump to latest, test, and bisect *only* if something breaks.

### Why the risk is lower than 15 majors suggests

The app uses a deliberately small, stable Electron surface — no `remote`, no custom protocols, and
**no native modules to rebuild** (parakeet.js is pure JS + wasm):

```
app 43 · ipcRenderer 38 · ipcMain 33 · webContents 18 · session 11 · clipboard 10
Tray 7 · screen 7 · BrowserWindow 7 · globalShortcut 3 · contextBridge 3
nativeImage 2 · Menu 2 · shell 1 · dialog 1
```

---

## Migration plan — recon each step before doing it

Each step has a question to answer *first*. Do not batch them; the whole point is that a failure
should be attributable.

### Step 1 — Baseline capture (before touching anything)
Record current behaviour so "did we break it" is answerable.
- `--replay` on a fixed WAV on **both** machines → transcript + timing
- `npm test`, `npm run typecheck`, `npm run dist` output sizes
- The GPU report (`_review/gpu-report.js`) on both

**Recon question:** do we have a reproducible before-picture on both the 3090 Ti and the XPS?

### Step 2 — Toolchain compatibility
Currently `electron-builder ^26.0.12` (latest 26.15.3), `vite ^5.0.12`, `typescript ^5.3.3`.

**Recon question:** does electron-builder 26.x support packaging Electron 43? If not, that is the
real blocker and it changes the target. Also check whether Node 24 in the main process affects
anything (all our main-process code is CommonJS `require`, which is still supported).

### Step 3 — Breaking-change audit, scoped to what we use
Read the Electron breaking-changes doc for 29→43, but **filter to the 15 APIs listed above**.
Ignore everything else.

**Recon question:** which of our specific call sites changed signature or behaviour? Particular
suspects, because our fixes ride on them:
- `session.defaultSession.webRequest.onHeadersReceived` — **the COOP/COEP fix depends on this**
- `session.setPermissionRequestHandler` — media + persistent-storage auto-approval
- `Tray` / `nativeImage` on Windows — icon loading and the new `starting` state
- `globalShortcut.register` — registered early now, before the window loads
- `webContents.setWindowOpenHandler` / `will-navigate` — the navigation guards
- `BrowserWindow` `webPreferences` defaults (`sandbox` is explicitly `false` in three places)

### Step 4 — Bump and build
Single change: Electron version in `mvp-echo-toolbar/package.json`. Then `npm run typecheck`,
`npm test`, `npm run dist`.

**Recon question:** does it build at all, and does the artifact size change unexpectedly?

### Step 5 — Verify the integration points on Windows
Static checks cannot cover these. Run the manual list in `_review/FIX-PLAN.md` §"Windows manual
checks", plus:
- `crossOriginIsolated=true` in the worker log — **if this regresses, the threading fix is gone**
- Tray shows "Starting up..." then "Ready"
- Hotkey works immediately; early press does not record through the wrong adapter
- `--replay` produces the same transcript as the Step 1 baseline
- Model loads from IndexedDB cache without re-downloading

**Recon question:** does anything differ from the Step 1 baseline, and is the difference explained?

### Step 6 — fp16, only after Step 5 is green
Two parts, and they are separate:
1. Confirm `adapter.features.has('shader-f16')` is now true inside Electron
2. Pass `encoderQuant: 'fp16'` in `inference-worker.ts` — **feature-gated, never unconditional**,
   with fallback to fp32

Also bump `MODEL_CACHE_VERSION` in `model-cache.ts`, or the old 2.4 GB encoder lingers in IndexedDB
alongside the new 1.2 GB one.

**Recon question:** does fp16 change the transcript? Use `--replay` on the same file, both quants,
and diff. Accuracy loss is normally negligible but has not been verified here.

### Step 7 — Soak, then ship
Same two-stage soak as 3.0.28: `--diag` on for a few days, then off for a few more.
**Separate soaks for the Electron bump and for fp16** — different failure signatures, and bundling
them makes a regression impossible to attribute.

---

## Traps that cost time in the last session

- ~~**Worker `console.log` is NOT forwarded to the main log**~~ — **fixed on `electron-43`.**
  `forwardConsole()` now sends warnings and errors from all three windows to the log file, including
  browser-generated ones (COEP violations, worker load failures) that no in-renderer shim can see.
  Plain `console.log` from the worker is still DevTools-only; use `console.warn` to be sure.
- **`CaptureApp` overrides `console.log` to be silent unless `--diag`.** `console.warn`/`error`
  always print. Use `console.warn` for anything that must be seen.
- **WebGPU cannot measure available VRAM.** `maxBufferSize` is an API cap; an allocation probe
  returned 12288 MB on a 4096 MB card because WDDM over-commits into system RAM. Do not build
  capacity prediction on either. Attempt, catch failure, fall back.
- **PowerShell needs the call operator:** `& ".\28.exe" --diag "--replay=C:\...\test.wav"`
- **`UserGpuPreferences` registry values must include the `.exe` extension** or Windows never
  matches them and the GPU preference silently does nothing.
- **`npm run dist` emits a stray `preload.js` at the project root** — byte-identical to
  `app/preload/preload.js`, unused, now gitignored. Don't edit it.
- **Release requires `gh auth switch -u mvp-scale` first**, or workflow dispatch 403s. A working
  `git push` does not mean `gh` can dispatch — different credentials.

## Useful tooling built last session

- `--replay=<file.wav>` — push a saved recording through the real pipeline. Deterministic
  before/after. Forwards to an already-running instance.
- `_review/gpu-report.js` — paste into DevTools for isolation, adapter, features, limits, cache state.
- `_review/seam-test-script.md` — 48 numbered sentences to read aloud; any drop or duplicate at a
  window boundary shows up as a missing or repeated number.
- `npm test` (34 tests, `node:test`, zero new deps) and `npm run typecheck`.
