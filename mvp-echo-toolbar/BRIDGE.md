# Session Bridge — start here to continue this work

_Last updated: 2026-08-17. Human-readable handoff so a fresh conversation starts oriented — no need
to replay an old session. (Auto-memory also loads for this project; this is the readable companion.)_

---

## Current state: ✅ SHIPPED v3.1.0 (2026-08-17)

Released through the full pipeline — `dev` fast-forwarded from `electron-43`, `clean-release.yml`
→ `main` + tag `v3.1.0`, CI-built exe from `main`, public Release. **Nothing pending.**

- Release: https://github.com/mvp-scale/mvp-echo-toolbar/releases/tag/v3.1.0
- `main` at `0d163f5`; released exe SHA-256
  `3c7d5b0fbead157f0f9c72a43b827fef6b897c45876117201cdb9b01fb933178`
- **313 tests.** `npm run typecheck && npm test && npm run build` is the gate, green at every commit.

> **The one honest caveat.** A genuine COLD first run — empty model dir, percentage climbing,
> hotkey pressed mid-download, Windows `.part` handling — was reported working by the maintainer
> rather than captured in a log. Every log on file shows the warm path (`already on disk`).
> **If a first-run bug ever appears, start there**, and reproduce with:
> `Move-Item "$env:LOCALAPPDATA\mvp-echo-toolbar\models" "...\models-backup"` then launch.

### What 3.1.0 was

**The model now lives on disk and is served over loopback.** `model://` cannot work — Chromium
refuses a cross-origin fetch from a `file://` document to any scheme outside
chrome/chrome-extension/chrome-untrusted/data/http/https, and the initiator-origin check runs
before `supportFetchAPI` matters. `http://127.0.0.1` IS on that list. `app/main/model-server.js`
is the replacement: ephemeral port, per-session path token, `basename()` confinement, `Host` check,
exact `Content-Length`, correct MIME types. On by default; `--no-model-store` is the way back.
Evidence: `_review/LOOPBACK-PROBE.md`.

**The flag that gated it never worked, in any build ever.** `preload.js` read
`process.argv.includes('--model-store')`, but preload runs in the RENDERER, whose command line is
Chromium's. Measured: main sees the flag, preload sees `--type=renderer`. Always false, dev and
packaged alike. Fixed with `additionalArguments`; `test/renderer-flags.test.js` fails the build if
a flag the preload reads is not forwarded. **`--diag` only ever worked because it goes over IPC.**

**A download is no longer indistinguishable from a crash.** `engine-state.js` owns a `downloading`
status plus a percentage, written through one method (`EngineManager.reportDownloadProgress`) and
guarded on the payload's `modelId` — what the download is ABOUT — not on `state.engine`, which
would have been the sixth instance of the `activeAdapter` routing bug. Progress is aggregated
across files first, because parakeet reports per-file and a raw forward walks 0→100% once per
file. Design rationale, and the three bugs the review caught that all three designs shared:
`_review/DOWNLOAD-STATE-DECISION.md`.

**Prefetch, deliberately visible.** Fetched in the background once the user has chosen the GPU
engine, reporting into the same record everything else reads. The maintainer's call: *"Silent pull
does not create customer delight because it's silent."*

### Open, deliberately — start here next session

- **#10 — onnxruntime-web is still fetched from `cdn.jsdelivr.net` on every cold start.**
  BLOCKED ON AN UPSTREAM BUG, and the published research about this was WRONG: parakeet's
  `initOrt()` (`node_modules/parakeet.js/src/backend.js`) destructures a `wasmPaths` option,
  documents it, and **never assigns it** — the only write is the CDN default, guarded by
  `if (!ort.env.wasm.wasmPaths)`. Setting `ort.env.wasm.wasmPaths` DIRECTLY works (measured:
  `InferenceSession.create` in 3.65 s, **zero** jsdelivr requests). Setting it ourselves before
  `fromUrls` would win, but onnxruntime-web is parakeet's dependency, not ours, and a vite
  `resolve.alias` does not reach the worker build (`vite:worker-import-meta-url` runs its own
  Rollup pass; directory and explicit-entry aliases both failed). Real options: pin
  onnxruntime-web as a direct dependency at parakeet's exact 1.24.1; patch/vendor `initOrt`; or
  move the worker off the vite worker pipeline. Privacy concern, not functional.

- **#12 — a failed model load reads as "loading" forever.** `engine-state.js` collapses every
  failure into `loading`, so a GPU model that failed to load looks like one still arriving and the
  user waits for something that is never coming. The fix means classifying failures in a catch
  block — and a misclassification marks a WORKING GPU unusable on a network blip, which is exactly
  what once deleted a user's 1.2 GB encoder. Its own task, its own risk budget.

- **Minor:** `_review/` (37 files) and `PLAN.md` ship to `main`. Pre-existing — v3.0.28 had 28 of
  them — but if they should stay internal like `BRIDGE.md` does, it is two lines in `.dev-only`.

### Tooling worth reusing (found the hard way this session)

- **Windows exes build LOCALLY on the Linux box, in ~4 minutes.** wine 9.0 is installed,
  `sherpa-onnx-bin` (180 MB) is present and `sherpa_onnx_models` is a symlink to the outer project.
  A previous session believed this did not work; it does. Iterate locally, and use CI only for the
  release build (provenance).
- **Electron runs headless here** with `--ozone-platform=headless` plus
  `webPreferences.offscreen: true` (there is no X server). That is how `_review/loopback-probe/`
  answers questions no unit test can — whether Chromium permits a fetch, whether ORT loads.
  Neither switch changes the network stack or origin rules.
- **ALWAYS check which binary produced a log.** Two rounds were spent this session diagnosing a
  stale exe. Artifacts and CI builds carry the commit sha; compare it before theorising.
- **`grep` in this repo is an indexed override and misses literal text.** Use `python3` or an
  explicit raw search when hunting for a string rather than a symbol.

## How 3.1.0 came about (kept — the reasoning still applies)

`git diff --stat dev electron-43` at the start of that branch was **three files, zero application
code**. Every defect found since existed identically on Electron 28. Electron 43 removed two
crutches — `adapter.requestAdapterInfo()` and a permissive COEP posture for the module worker —
that had been keeping the WebGPU path on the happy road. **The app was not regressing because of
43; 43 was the first time anyone saw what it does when its primary engine fails.**

**Every defect the Windows rounds found was in the WIRING between modules, never in the modules
themselves.** The pure logic had tests and was right; the seams had none. That held again in this
session: the flag that never reached the renderer, the init storm, the blinking tray — all seams,
none caught by 313 passing tests. Worth remembering before trusting anything marked "done" that
has only been typechecked.

### The expensive lessons, in order of what they cost

1. **Never default-enable an unproven mechanism.** Shipping the model store on by default replaced
   a WORKING fp16 path with a broken one — and destructively: a blocked fetch was read as "fp16 is
   unusable", which deleted a user's already-downloaded 1.2 GB encoder and started a 2.4 GB one.
2. **A transport error is never a verdict about capability.** That is the specific misreading
   above, and it is why `#12` is deliberately deferred rather than patched quickly.
3. **Bounds live at the resource being exhausted, not at each caller.** A failed init reported
   not-ready -> record changed -> broadcast -> re-init: 61 attempts in 50 seconds, because the
   caller's 3-strike guard covered one of three call sites. The same shape returned in this
   session as hundreds of inits in milliseconds, for the same reason — a guard checked before
   three awaits is not a mutex.
4. **Enumerate what a user can do DURING any operation with duration.** Press again, switch, quit.
   Several bugs were re-entry, and they were invisible on Linux: POSIX renames open files happily
   and produces silent corruption instead of an error.
5. **Windows is in the loop, not a formality.** See the caveat at the top of this file.

### Earlier findings still worth knowing

- `adapter.requestAdapterInfo()` was removed in Chrome 131, and `webgpu.d.ts` hand-declared it,
  which is why `tsc` stayed green while the probe reported "no usable GPU" about a working 3090.
- COEP blocks the Vite module worker under `file://` on Chromium 150, so cross-origin isolation is
  **off by default** (`--coi` re-enables). Measured: single-threaded decode is **17.3x realtime**
  on the XPS, faster than the 12.6x recorded *with* threading — so the `app://` origin migration
  was dropped, and with it a 2,371 MB re-download for every existing user.
- "Which model is selected" once lived in seven places that disagreed. Now one `engine-state.json`.
- Routing was decided twice, at record start and again at stop, so a mid-recording switch
  dispatched audio to the wrong engine and lost it. Now frozen per recording (`capture-plan.ts`).
- **RC-1 — routing on "what is currently active" rather than "what this operation is about" —
  appeared five separate times.** The download-progress guard would have been the sixth; it keys on
  `modelId` instead. Expect more of this shape wherever `this.activeAdapter` is still consulted.
- `--sab` works on Chromium 150 but should stay off: it relaxes a Spectre mitigation to buy
  throughput that was measured as unnecessary.

### Performance is settled — do not reopen without a new symptom

**100x realtime on the 3090 Ti, 12.6x on the XPS 15 7590 / GTX 1650.** A 2-minute dictation takes
~1.2 s and ~9.5 s; typical recordings are 1-8 s and never chunk. There is no user-facing latency
problem. Parallel chunk workers were **dropped**: memory-bound to desktop-only, complex, and would
optimise the machine already at 100x. What makes this app *feel* fast is prefetch and legibility,
not more speed.

### Two process fixes worth keeping

- **Artifacts carry the commit sha.** Every build used to produce an identically named exe, so a
  stale download was indistinguishable from a fresh one. That cost three verification rounds in
  one day, and two more in this session. When evidence contradicts the code twice, suspect the
  binary before forming a third theory.
- **`--diag` surfaces browser-level failures.** `forwardConsole()` sends warnings and errors from
  all three windows to the log file, including messages Chromium generates itself, which no
  in-renderer shim can see. That is how the COEP block was identified.

## Historical: the Electron 28 -> 43 migration (DONE, shipped in 3.1.0)

The step-by-step migration plan that used to live here has been removed: it was executed and
shipped. A fresh session should not read it as outstanding work. The summary of why it was done
and what it bought:

**Primary reason was security.** Electron supports the latest three majors, so 28.3.3 was 15
majors behind and long EOL — no Chromium security patches, in an app that fetches ~1.2 GB over the
network and renders local HTML with `unsafe-eval` in its CSP. Now on **43.4.0** (Chromium 150,
Node 24).

Two blocked items came along for free:

| Unlock | Value |
|---|---|
| `shader-f16` | fp16 encoder: **2363 MB -> 1182 MB**. On a 4096 MB card that is 58% -> 29% |
| `timestamp-query` | Real GPU profiling (the parallel-worker decision was once blocked on it) |

fp16 is **memory headroom, not speed** — do not sell it as a performance fix. It is chosen per
machine from `adapter.features.has('shader-f16')`, with an fp32 fallback, and **fp16 accuracy has
still never been diffed against fp32.** One `--replay` file, both quants, compare — that remains
genuinely open if anyone ever suspects transcript quality.

The app uses a deliberately small Electron surface — no `remote`, no custom protocols (the
`model://` attempt is gone), and **no native modules to rebuild** (parakeet.js is pure JS + wasm),
which is why a 15-major jump was lower risk than it sounds.

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
