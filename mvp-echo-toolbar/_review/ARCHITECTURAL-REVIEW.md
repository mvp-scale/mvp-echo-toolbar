# MVP-Echo Toolbar — Architectural Review

**Reviewed:** v3.0.27 (`dev` @ 9b61105) · 2026-08-13
**Scope:** full application — `app/main`, `app/preload`, `app/renderer`, `app/stt`, build & release pipeline (~7,600 LOC)
**Method:** three waves — 7 agents partitioned by subsystem (01–07), 1 by failure mode (08), then 6 more tracing specific data paths and lifecycles end-to-end (09–14). Every finding requires `file:line` + verbatim excerpt. Speculation excluded; unconfirmable suspicions marked `UNVERIFIED`.
**Backing detail:** `_review/raw/01`–`14` — this document is the synthesis, not a replacement.

> **Correction applied 2026-08-13 — the model is ~2.5 GB, not ~1.2 GB.** `hub.js:425-429` forces the
> encoder to **fp32** whenever the backend starts with `webgpu` (int8 unsupported there), and
> `inference-worker.ts` sets only `decoderQuant`, so the encoder defaults to int8 → forced fp32.
> fp32 encoder weights are 2,435,420,160 B + ~9 MB int8 decoder ≈ **2.5 GB resident per model
> instance**. The "~1.2 GB" figure repeated in code comments (`inference-worker.ts:50`) and in
> raw passes 01–11 is the *fp16* encoder file, which this backend never loads. All memory
> arithmetic below uses 2.5 GB. Raw files 01–11 predate this correction and still say 1.2 GB.

---

## Bottom line

The app is architecturally sound at the boundaries that matter most for Electron — `contextIsolation: true` / `nodeIntegration: false` everywhere, no implicit off-device audio path, renderer-as-single-authority for recording lifecycle. The defects are not in the big decisions; they are in **state ownership, failure paths, and the absence of any gate between "code compiles" and "artifact ships."**

**4 P0.** Passes 01–08 produced 75 findings (4 P0 / 15 P1 / 33 P2 / 23 P3). Passes 09–14 added ~17 more plus two design documents, and deliberately overlap the earlier passes — pass 11 was tasked with *refuting* 08's two P0 claims and confirmed both — so a single de-duplicated total would be misleading and is not claimed here. **No new P0s were found by the deep pass; it confirmed the existing two and explained the memory symptom.**

Five things dominate everything else:

1. **Two failure-recovery mechanisms are inverted — they convert recoverable events into outages.** The orchestrator's "don't thrash" guard is dead code, leaving an unbounded 15-second re-init loop; and a GPU device loss during init wedges the app for 15 minutes with recording disabled. See cluster **C0** — these are the two most severe findings in the review and were missed by the first pass.
2. **The record hotkey has four independent ways to silently do nothing.** Different subsystems, same user experience: press the key, nothing happens, no error.
3. **The "empty recording" bug class is still live** — the readiness gate that fixed it only guards the cold-mic path, and a `devicechange` event can stop the mic mid-recording.
4. **The packaged app never establishes cross-origin isolation**, so the WASM decoder runs single-threaded on *every* transcription in shipped builds. Silent, permanent, unlogged.
5. **Memory is a footprint problem, not a leak** — ~2.5 GB baseline (2× what the code believed) plus a ~438 MB transient peak on the failure path, with no release path anywhere in the stack. See cluster **C0.5**. Separately, the app does **no chunking at all**, which is a shipped correctness bug above ~60–90 s of audio.

---

## Scorecard

| Domain | Findings | P0 | P1 | Raw file |
|---|---|---|---|---|
| Main process, window & tray lifecycle | 10 | — | 2 | [`01-main-process.md`](raw/01-main-process.md) |
| IPC contract, preload bridge, security | 13 | — | 3 | [`02-ipc-security.md`](raw/02-ipc-security.md) |
| Audio capture pipeline | 8 | 1 | 1 | [`03-audio-capture.md`](raw/03-audio-capture.md) |
| WebGPU inference pipeline | 11 | — | 3 | [`04-webgpu-inference.md`](raw/04-webgpu-inference.md) |
| React renderer | 9 | — | 3 | [`05-renderer-react.md`](raw/05-renderer-react.md) |
| STT engine abstraction | 10 | — | 3 | [`06-stt-engines.md`](raw/06-stt-engines.md) |
| Build, packaging, distribution | 11 | 1 | 4 | [`07-build-packaging.md`](raw/07-build-packaging.md) |
| **Memory growth & hangs** (failure-mode pass) | **4** | **2** | **1** | [`08-memory-and-hangs.md`](raw/08-memory-and-hangs.md) |
| PCM allocation ledger (data-path trace) | 6 | — | 2 | [`09-pcm-allocation-trace.md`](raw/09-pcm-allocation-trace.md) |
| Retention & unbounded-growth audit | 6 | — | 2 | [`10-retention-audit.md`](raw/10-retention-audit.md) |
| GPU & worker resource lifecycle | ledger + 2 verdicts | — | — | [`11-gpu-worker-lifecycle.md`](raw/11-gpu-worker-lifecycle.md) |
| Parallel chunking design | design doc | — | — | [`12-parallel-chunking-design.md`](raw/12-parallel-chunking-design.md) |
| Overlap-stitch correctness | design doc | — | — | [`13-overlap-stitch-correctness.md`](raw/13-overlap-stitch-correctness.md) |
| Audio buffer correctness | 5 | — | — | [`14-audio-buffer-correctness.md`](raw/14-audio-buffer-correctness.md) |

*(CSP was independently reported by two agents; counted once. Passes 09–14 overlap 08 by design — 11 was tasked with adversarially refuting 08's two P0 claims; both were confirmed.)*

---

## Convergent failure clusters

Individual findings under-represent the risk. These are the places where **independent defects in unrelated subsystems produce the same user-visible symptom** — which is why the symptoms have been hard to pin down.

### C0 — Recovery mechanisms that make things worse (the two worst findings)

Both defects live in the *error paths* of the WebGPU orchestrator — code written specifically to make failures survivable. Neither was caught by the subsystem-partitioned pass, because each is a seam between two files that were reviewed by different agents.

**C0-a — the anti-thrash guard is dead code, leaving an unbounded re-init loop.**
`InferenceOrchestrator.initialize()` catches init failure, disposes, and **never re-throws** (`inference-orchestrator.ts:81-92`). So `CaptureApp`'s `catch` never runs — it instead executes `initFailRef.current = 0` and sends `webgpu:model-ready(true)` on a model that failed to load (`CaptureApp.tsx:67-76`). The give-up test `if (initFailRef.current >= 3)` at `CaptureApp.tsx:461` can therefore never fire. The only surviving bound is a 15-second cooldown, so a persistently-failing init becomes **a fresh Worker plus a full ~1.2 GB model load attempt every 15 seconds, indefinitely.**

The comment at `CaptureApp.tsx:457-459` names this exact scenario as the thing being prevented — *"so a reload that keeps failing on a memory-constrained machine can't thrash (the 'memory tried-and-reused' loop)."* The guard doesn't work, and the loop is self-reinforcing when memory pressure is what's failing the init in the first place.

**C0-b — a GPU device loss during init wedges the app for 15 minutes.**
The `device-lost` listener calls `disposeSync()`, which terminates the worker and nulls it — but does **not** reject the in-flight init promise, and does not clear `this.loading` (`inference-orchestrator.ts:65-70`, `:136-143`). That promise's only remaining exit is its **900,000 ms timeout** (`:76`). For 15 minutes `isLoading()` stays `true`, so every hotkey press is ignored at `CaptureApp.tsx:454` — and the re-init recovery at `:456` is gated on `!isLoading()`, meaning **the stuck flag disables the very path meant to recover from it.** No fallback to the webm engine. The app looks alive; recording is impossible.

Hybrid-GPU laptops and driver/TDR resets are the documented trigger the loss-watcher exists for — so the recovery mechanism turns a routine, recoverable event into a 15-minute outage. The same defect applies to the 120s `transcribe` timeout, which is the underlying mechanism behind `04-P2`.

**Why the first pass missed both:** the agents were partitioned by subsystem, so no one owned the question "what never resolves, and what grows without bound?" C0-a spans `inference-orchestrator.ts` (agent 04) and `CaptureApp.tsx` (agent 05); each read its own file correctly and neither owned the seam. That is a defect in how the fan-out was designed, not in the agents' work.

### C0.5 — The memory picture: not a leak, a footprint

Passes 09–11 and 14 traced every byte end to end. **The headline is a negative result: with diagnostics off, nothing in the app grows without bound.** The reported memory pressure is explained by three things that are not leaks, plus one loop that is.

**1. The baseline is ~2× what everyone believed.** ~2.5 GB resident per model instance (see correction at the top), not 1.2 GB. Nothing in the code, comments, or prior reviews reflected this.

**2. The transient working set is large and peaks on the failure path.** Audio-path allocations only, excluding model weights (`raw/09`):

| Recording length | Peak | On empty-result retry |
|---|---|---|
| 10 s | ~5 MB | ~7.8 MB |
| 60 s | ~30 MB | ~44 MB |
| 600 s | ~300 MB | **~438 MB** |

So a full-length recording that hits the retry sits at **~2.9 GB** total, transiently. The retry is triggered by the empty-transcription bug — so the worst memory path is reached by the most common failure.

Contributors: `postMessage` with no transfer list (`inference-orchestrator.ts:173`) structured-clone-copies the PCM instead of transferring it; `trimSilence` (`CaptureApp.tsx:12-22`) copies unconditionally via `.slice()` even when nothing is trimmed, then runs *again* on the retry; and parakeet's `mel.js` `_paddedBuffer` is a grows-only `Float64Array` that ratchets to a **~92 MB permanent high-water mark** after one long recording, never released until worker dispose.

**3. There is no release path anywhere in the stack.** `grep -rn "\.release(" node_modules/parakeet.js/src/` returns **zero hits**. The encoder (fp32/WebGPU) and decoder (int8/WASM) ONNX sessions are never released, though `ort.InferenceSession.release()` exists and does real work — freeing the WASM-side session and, via `jsepOnReleaseSession`, the GPU buffers. Beneath that, onnxruntime-web's WebGPU backend keeps a buffer **free-list pool that deliberately does not destroy released buffers** (`gpu-data-manager.ts:190-405`), only recycles them; true free requires a `dispose()` reachable only from the `release()` nobody calls. Model-weight Blob URLs from `hub.js:getModelFile()` are never revoked either (only the tokenizer's text blob is).

Every reclaim therefore depends on `Worker.terminate()`. JS heap and WASM linear memory reclaim are effectively engine-guaranteed; **GPU/VRAM reclaim on terminate is `UNVERIFIED`** — Chromium's GPU-process cleanup is async and cross-process. This is the honest boundary of static analysis, and it is exactly where a VRAM symptom would live.

**4. Two paths hold ~2.5 GB with nothing running.** Confirmed by code, not hypothetical:
- Switching from a WebGPU model to a local/remote engine in Settings **never disposes the orchestrator** — `engine-manager.js:312-346` never reaches `orchestratorRef.current.dispose()`. The full worker stays resident, idle, for the rest of the session.
- The C0-a re-init loop discards and re-requests a worker + `GPUDevice` every 15 s indefinitely. If GPU-side reclaim lags the next device acquisition — plausible given async cross-process cleanup — this is the clearest path to stacking VRAM growth, and `raw/11` rates it the best match for the reported symptom.

**The one genuinely unbounded thing** is diagnostics-only: `%TEMP%\mvp-echo-audio\` accumulates one WAV per recording with no cap and no eviction, and is missed by the existing orphan sweep (name/extension mismatch), surviving restarts. Worst case ~1.9 GB over ~100 recordings. The sibling diagnostics log also has no size cap, unlike `mvp-echo-toolbar-debug.log` which is capped at 5 MB.

**Ruled out** (checked and found correctly bounded): `pcmChunks` resets reliably across recordings; all `CaptureApp`/`AudioCapture` timers are cleared; transcript history is bounded; the decoder cache is LRU-capped; no aliasing anywhere in the audio path — every derived buffer is a real copy, and the worklet posts `new Float32Array(ch)` rather than a view onto the audio thread's reused backing store (`AudioCapture.ts:99-102`), so the classic reused-view corruption bug does not exist here.

### C1 — "I pressed the hotkey and nothing happened" (4 independent causes)

| # | Cause | Where |
|---|---|---|
| 1 | `globalShortcut.register()` runs only *after* `await engineManager.initializeAndSignalReady()` — which awaits a WebGPU adapter probe in the hidden renderer. Hotkey is not registered at all until GPU probing finishes. | `main-simple.js:396-438` |
| 2 | The startup chain awaits `did-finish-load` with **no `did-fail-load` handler and no timeout**. If the page fails to load, engine init and shortcut registration never run. Tray looks healthy; recording is dead, permanently, silently. | `main-simple.js:399-405` |
| 3 | WebGPU model load is **eager** for the steady-state user. While loading (up to a 15-min timeout), a hotkey press is *ignored outright* — no fallback to the working webm/IPC engine, feedback limited to a 1.5s tray flash. | `CaptureApp.tsx:95-98`, `:454-473` |
| 4 | `_restoreModelSelection()` overrides `initialize()`'s live availability probe with a stale persisted WebGPU preference that never re-checks GPU or model presence. Routes to a not-ready engine while a verified-working adapter sits idle. | `engine-manager.js:152-193`, `webgpu-bridge-adapter.js:153-158` |

Cause 2 is reachable in production via a separate finding: dev-vs-prod asset loading is gated on `NODE_ENV === 'development'` — an inheritable env var — rather than `app.isPackaged`. A dev workstation with `NODE_ENV` set globally launches the packaged `.exe` pointed at `localhost:5175`, load fails, `whenReady()` hangs forever. (`main-simple.js:149-154`, `:216-220`, `:326-330`)

**Structural read:** the app's core interaction has its readiness fully coupled to GPU/model probing, with no "shortcut works while the engine warms up" mode and no visible degraded state.

### C2 — "The recording came back empty" (the historical bug, still live)

The energy+mute readiness gate at `AudioCapture.ts:488-517` is well-reasoned and correct. It just doesn't cover the paths that matter now:

- **[P0]** The `devicechange` listener calls `releaseMicStream()` unconditionally — **including mid-recording**. Any headphone plug, Bluetooth reconnect, or USB arrival stops the mic track the live worklet graph is reading from. No exception thrown; the worklet simply stops receiving frames and `stopRawRecording()` returns whatever accumulated. Surfaces to the user as `∅ no speech`. (`AudioCapture.ts:361-371`, `:380-390`)
- **[P1]** The warm-reuse path — **the default under `keep-ready`** — fires `fireCaptureReady('warm')` immediately with no `track.muted` check and no confirmation that a single real frame has arrived. `wasWarm` reflects only `readyState === 'live'` at reuse time, which says nothing about a Bluetooth headset that power-saved during a hold window now configurable up to 1h. (`AudioCapture.ts:474-478`, `:298-303`)

**Structural read:** `AudioCapture` has no state field. "Are we recording" is inferred from which of ~8 optional members happen to be set — which is exactly why a `devicechange` transition that should be illegal during RECORDING is trivially allowed.

### C3 — "It's slow and nothing says why"

| Cost | Where |
|---|---|
| **COOP/COEP set only on the Vite dev server, never in the packaged app.** No `SharedArrayBuffer` → parakeet.js falls back to `numThreads = 1`. The decoder is *forced* to WASM whenever the backend is `webgpu`, so this hits **every transcription**, not just cold start. No error, no log — just permanently degraded RTF. | `vite.config.ts:54-66` vs `main-simple.js:131-185`; `parakeet.js/src/backend.js:67-74`, `parakeet.js:221-224` |
| Model files download **sequentially** (`for…await`, not `Promise.all`) on the cold-start critical path — ~1.2 GB, one file at a time. | `parakeet.js/src/hub.js:457-476` |
| Local sidecar **spawns a fresh process and reloads the ONNX model on every transcription** — direct violation of the project's own "keep models loaded" rule. | `local-sidecar-adapter.js:44-77` |
| Audio crosses IPC as `Array.from(new Uint8Array(buf))` — a boxed JS array, ~8× the memory and clone cost of passing the `ArrayBuffer` structured-clone handles natively. On recordings up to 600s. | `CaptureApp.tsx:376-380` → `engine-manager.js:220` |
| Main-process logging is `fs.appendFileSync`, and the renderer forwards **every** `console.error`/`console.warn` into it — ungated by the `--diag` flag. A renderer retry loop becomes a burst of blocking main-thread disk I/O. | `logger.js:12-33`, `CaptureApp.tsx:151-163` |
| Full OS-temp-directory `readdirSync` sweep at module load — **before** the single-instance-lock check, so a second instance about to quit pays it too. | `main-simple.js:40-49` vs `:100-109` |

Download progress *is* computed (`inference-worker.ts:63-72`) and goes to `console.log` only. The richest signal the pipeline produces never reaches the person waiting.

### C4 — The 290 MB download

Measured: portable `.exe` **290.5 MB**; unpacked footprint **974 MB**; `app.asar` alone **417 MB** against ~25 MB of actual renderer payload.

| Waste | Size | Where |
|---|---|---|
| **[P0]** `files: ["dist/**/*"]` is self-referential with `directories.output: "dist"`. A prior build's full `win-unpacked` tree — including a second `electron.exe` and Chromium `.pak`s — was found packed **inside** `app.asar`. `npm run dist` cleans first; a bare `electron-builder` invocation does not. Compounds across builds. | ~unbounded | `package.json:16-25` |
| `parakeet.js` + nested `onnxruntime-web` shipped raw in the asar and **never loaded** — it's a renderer-only import Vite already bundles. Four unused `.wasm` variants. | 134 MB | `package.json:34` |
| Full multimedia `ffmpeg.exe` bundled for one WebM→WAV conversion. Byte-identical to the `ffmpeg-essentials.zip` build. An audio-only build is 5–20 MB. | 169.9 MB | `package.json:26-32` |
| All ~55 Chromium locale `.pak` files for an English-only UI. | 37 MB | electron-builder default |

The P0 is `UNVERIFIED` for *released* artifacts (CI does a fresh checkout, so `dist/` doesn't pre-exist) — but nothing at the glob level prevents it, so any build caching or retry-in-place reproduces it. Confirm by running `asar list` on a released `.exe` and grepping for `/dist/win-unpacked`.

### C5 — No gate between "compiles" and "shipped"

- `tsc` **never runs.** `tsconfig.json` sets `noEmit: true`, Vite transpiles via esbuild without type-checking, and there is no `typecheck` script. Type errors and broken imports reach releases unopposed.
- `"test": "echo \"No tests yet\""` — never invoked by either workflow.
- CI's only artifact verification is `dir dist`. Nothing confirms the `.exe` launches.
- CI runs `npm install` against a **gitignored** lockfile. This is the exact mechanism that broke 3.0.23 (`@noble/hashes` drift); the `overrides` pin protects one package, nothing protects the rest.
- The one existing test harness (`test-audio-capture.html`) exercises a **different architecture** than production and tests the opposite AGC setting — green checks there validate nothing that ships.

### C6 — State ownership is the root cause under most of the above

| Symptom | Missing owner |
|---|---|
| `devicechange` legal during RECORDING | `AudioCapture` has no state enum — state inferred from optional fields |
| Two adapter-selection algorithms silently fighting | `initialize()` and `_restoreModelSelection()` both mutate `activeAdapter` with no arbiter |
| Model-id desync after a mid-session switch | Three React roots each cache IPC config independently, no broadcast |
| Main-process health permanently stale | `webgpu:model-ready` is push-only — sent `true`, never `false` on teardown |
| 4 dead channels, silent-`undefined` on typo'd channel | No shared IPC channel contract; names hand-duplicated across 4+ files |

---

## Throughput: parallel chunked transcription

Design work in [`raw/12`](raw/12-parallel-chunking-design.md) (execution) and [`raw/13`](raw/13-overlap-stitch-correctness.md) (merge correctness), against the owner's spec: 30 s chunks, run in parallel, 2 s overlap on both ends, stitched back together.

**The app does no chunking at all today.** `inference-worker.ts:125` calls `model.transcribe()` on the entire buffer in one shot and never touches parakeet.js's own `transcribeLongAudio` API. Per production logs in `RELEASE-INSTABILITY-GAP-ANALYSIS.md`, decode collapses to empty text above ~60–90 s. **Chunking fixes a shipped correctness bug independent of any throughput gain** — that alone justifies landing it.

**COOP/COEP is not a prerequisite.** Each `Worker` is its own OS thread with its own WASM instance, so N workers decode concurrently today with no header changes. Cross-origin isolation only enables *intra*-worker threading; it remains a worthwhile separate fix for the linear path (see C3) but does not gate this design.

**Architecture:** N independent workers, each with its own full model instance, running today's unmodified worker code. This is the only safe option without forking parakeet.js — a single `ParakeetModel` reuses mutable scratch buffers across calls (`parakeet.js:43`), so two concurrent `transcribe()` calls on one instance would race, and the library exposes no way to share one encoder session across multiple decoders (which rules out the theoretically better one-encoder/many-decoder hybrid).

**Memory caps N.** At ~2.5 GB per instance: **N=2 (~5 GB)** on 8 GB+ VRAM, N=1 required on integrated/4 GB, N=3 only on high-VRAM cards. Gate on the existing (currently unused) `estimatedVram` bucket — noting `04-P2`, that heuristic conflates `maxBufferSize` with VRAM and needs fixing first if it's to carry this decision.

**The merger already exists.** parakeet.js ships `LCSPTFAMerger` (`parakeet.js:1811-2014`, exported from `index.js:5`) — token-ID LCS with frame-index verification and log-prob arbitration, purpose-built for overlap stitching. `returnTimestamps: true` yields word/token start/end times (currently disabled at `inference-worker.ts:126`), derived from an 80 ms encoder-frame stride plus the TDT duration predictor — good enough to cut on, not sample-accurate.

**One custom wrapper is required.** Bare `LCSPTFAMerger` defaults, on a no-anchor overlap, to keeping the *earlier* chunk's version and discarding the later one's (`parakeet.js:1906-1909`). If the earlier chunk is the empty one — this app's known bug — that silently drops the healthy neighbour's content too. `raw/13` wraps it with a per-chunk health gate: retry once, then exclude the failed chunk and emit an explicit `gaps[]` marker rather than silently swallowing ~26 s of speech. Stated limit: the merge layer can flag that gap but not recover it.

**On 2 s overlap:** sound as a floor, not certified. parakeet.js's own long-audio chunker defaults to a **10 s** overlap (`long_audio.js:5`) and leans on pause-snapping rather than fixed windows. The encoder's true receptive field can't be determined from JS source (opaque ONNX weights) — flagged as a gap rather than guessed. Recommendation: gate 2 s behind the WER self-check in `raw/13` §5, or use 3 s.

**On expected speedup — honest uncertainty.** The decoder-stage gain is real and OS-thread-backed. The GPU-encoder gain is **not** verified: one 0.6B forward pass may already saturate a mid-range GPU, in which case N concurrent encoder passes largely serialize. The app has never captured per-stage timing (`enableProfiling: false` throughout), so no defensible speedup number can be given from source. **Turn profiling on and measure the encoder/decoder split before committing to an N.** The one production anchor available (`RELEASE-INSTABILITY-GAP-ANALYSIS.md`): the current pipeline does ~189 s of audio in ~8–10 s (RTF ≈ 0.04–0.05).

---

## Ranked remediation

Ordered by (user impact × confidence) ÷ effort.

| # | Fix | Impact | Effort |
|---|---|---|---|
| 0a | `throw err` at the end of `initialize()`'s catch block; gate `webgpu:model-ready(true)` on real readiness | Restores the 3-strike bound — stops the unbounded 15s re-init/~2.5 GB loop | XS |
| 0b | Reject the pending `sendMessage` from `disposeSync()` and clear `this.loading` there | Turns a 15-minute wedge into an immediate, recoverable failure | S |
| 0c | Chunk audio into 30 s windows before `model.transcribe()` (parakeet's `transcribeLongAudio`, or the design in `raw/12`) | Fixes the shipped empty-decode bug above ~60–90 s; prerequisite for parallelism | M |
| 0d | Dispose the orchestrator when switching away from a WebGPU model in Settings | Releases ~2.5 GB that currently sits idle for the whole session | XS |
| 0e | `postMessage(message, [audio.buffer])` — add the transfer list; reuse `trimmed` on the retry instead of re-running `trimSilence(pcm)` | Removes ~150 MB of avoidable copy on the 600 s retry path | XS |
| 0f | Cap/evict `%TEMP%\mvp-echo-audio\` and the diagnostics log; fix the orphan sweep's name/extension mismatch | Kills the only unbounded on-disk growth (diagnostics mode) | XS |
| 1 | Guard `devicechange` on recording-active; treat as abort with a distinct error rather than a silent empty result | Kills the live P0 data-loss path | S |
| 2 | Inject COOP/COEP via `session.defaultSession.webRequest.onHeadersReceived`; assert `crossOriginIsolated === true` at runtime | Multi-thread WASM decode on every transcription | S |
| 3 | Register `globalShortcut` **before** awaiting engine init; handler shows "still starting" instead of no-op | Removes cause 1 of C1 | S |
| 4 | Add `did-fail-load` + timeout to the `whenReady()` chain → visible `error` tray state | Removes the silent permanent hang | S |
| 5 | Apply the mute + short energy gate to the warm-mic path (50–100 ms fallback, preserving the latency win) | Closes the remaining empty-recording door | S |
| 6 | Add `"!dist/win-unpacked/**"` etc. to `files`, or move `directories.output` to `release/` | Structurally removes the P0 bloat path | XS |
| 7 | Move `parakeet.js` to `devDependencies`; swap in an audio-only ffmpeg | ~290 MB → ~90 MB download | S/M |
| 8 | Commit `package-lock.json`, switch CI to `npm ci`, add `tsc -b` as a required step | Reproducible builds + a real gate | XS |
| 9 | Let `_restoreModelSelection()` win only when it agrees with the live probe | Removes cause 4 of C1 | S |
| 10 | Forward `download-progress` over IPC to tray/overlay; fall back to the webm engine for the first recording while WebGPU warms | Removes cause 3 of C1 and the silent multi-minute wait | M |
| 11 | Send `ArrayBuffer` directly over IPC instead of `Array.from(...)` | ~8× less copy/alloc on the fallback path | XS |
| 12 | Async logger + rate-limit renderer console forwarding; gate on `--diag` like `console.log` already is | Unblocks the main thread | S |
| 13 | Add `will-navigate` deny + `setWindowOpenHandler({action:'deny'})`; set `sandbox: true`; scope `connect-src` | Shrinks blast radius of any future renderer bug | S |
| 14 | Rebuild the FormData per retry attempt in `_fetchWithRetry` | Makes remote retry actually work instead of doubling latency then failing | S |

---

## Full findings index

Severity: **P0** crash/data-loss · **P1** user-visible perf or reliability · **P2** latent bug or architecture · **P3** minor.

### P0

| Finding | Where | File |
|---|---|---|
| Orchestrator failure counter can never increment → unbounded 15s re-init loop, ~1.2 GB per cycle | `inference-orchestrator.ts:81-92`, `CaptureApp.tsx:67-76`, `:461` | 08 |
| Device loss during init leaves `loading` stuck true for 15 min → recording impossible, recovery path self-disabled | `inference-orchestrator.ts:65-70`, `:73-77`, `:136-143` | 08 |
| `devicechange` stops the live mic mid-recording → silent truncated/empty capture | `AudioCapture.ts:361-371`, `:380-390` | 03 |
| `files`/`directories.output` self-reference packs a prior build's Electron runtime into `app.asar` | `package.json:16-25` | 07 |

### P1

| Finding | Where | File |
|---|---|---|
| PCM structured-cloned to the worker (no transfer list); empty-result retry re-trims → ~150 MB transient at the 600s cap | `inference-orchestrator.ts:105-109`, `:173`, `CaptureApp.tsx:299-311` | 08 |
| Global shortcut registration blocked behind full engine/GPU init | `main-simple.js:396-438` | 01 |
| `whenReady()` hangs forever if the hidden window fails to load (no `did-fail-load`, no timeout) | `main-simple.js:399-405` | 01 |
| No `will-navigate` / `setWindowOpenHandler` guard on any window | `main-simple.js:135-147`, `:199-214`, `:308-324` | 02 |
| `sandbox: false` on all three windows with no functional need | `main-simple.js:144, 211, 321` | 02 |
| Audio boxed as `Array<number>` across IPC (~8× overhead) | `CaptureApp.tsx:376-380` | 02 |
| Warm-mic ready cue fires with no verification audio is flowing | `AudioCapture.ts:474-478` | 03 |
| Production build never establishes cross-origin isolation → single-threaded WASM decode forever | `vite.config.ts:54-66`, `main-simple.js:131-185` | 04 |
| Eager WebGPU load blocks the hotkey, zero progress feedback, 15-min timeout, no fallback | `CaptureApp.tsx:95-98`, `:454-473` | 04 |
| Sequential model-file downloads on the cold-start critical path | `hub.js:457-476` | 04 |
| Settings text inputs persisted per keystroke, no debounce → out-of-order writes revert config | `SettingsPanel.tsx:269-278` | 05 |
| WebGPU model switch desyncs `selectedModelRef` → mislabeled transcription metadata | `CaptureApp.tsx:131-137`, `:346` | 05 |
| Welcome window renders blank indefinitely with no dismiss affordance if version IPC hangs | `welcome-main.tsx:19-36` | 05 |
| Retry re-sends an already-drained `FormData` stream → zero bytes, hangs to 120s, still fails | `remote-adapter.js:104-109`, `:410-442` | 06 |
| Stale persisted WebGPU preference overrides the live availability probe | `engine-manager.js:152-193` | 06 |
| Local sidecar spawns a fresh process + full model load per transcription | `local-sidecar-adapter.js:44-77` | 06 |
| `parakeet.js`/`onnxruntime-web` ship raw and unused in `app.asar` (134 MB) | `package.json:34` | 07 |
| Full multimedia `ffmpeg.exe` (169.9 MB) bundled for one WebM→WAV conversion | `package.json:26-32` | 07 |
| Ships fully unsigned → SmartScreen warning for every user | `package.json:33-40` | 07 |
| CI `npm install` against a gitignored lockfile → non-reproducible builds | `build-electron-app.yml:45-46`, `.gitignore:50` | 07 |

### P2 — 32 findings

Grouped; full detail with excerpts in the raw files.

- **Main process (01):** sync renderer-console→disk forwarding · sync full-temp-dir sweep before the instance lock · `countdown:update` unbounded await on `ready-to-show` · `diag:*` sync fs writes of audio buffers · permissive CSP (`connect-src *`, `unsafe-eval`)
- **IPC (02):** CSP across all 4 entry points · `on`/`removeListener` bypass the `invoke` allowlist · invalid channel resolves to `undefined` instead of rejecting · 4 dead channels (incl. `capture:request-reload`, an unwired recovery hatch) · `countdown:update` and `webgpu:store-transcription` dereference renderer input unguarded · `app-config:set` merges arbitrary keys · `removeAllListeners`-before-`on` is a global reset, not an unsubscribe
- **Audio (03):** `ensureRawEngine()` leaves the engine permanently half-initialized if `addModule()` fails · two capture pipelines with opposite audio-processing philosophies and no cross-reference · test harness exercises a different architecture and the opposite AGC setting
- **WebGPU (04):** main-process "ready" state goes permanently stale (never sent `false`) · mid-transcription device loss waits out an unrelated 60s timeout · loss-watcher requests a different adapter than the compute session · `isModelDownloaded(modelId)` ignores its argument · no integrity check on cached model blobs · `estimatedVram` conflates `maxBufferSize` with VRAM
- **Renderer (05):** `StatusIndicator` is hardcoded "Ready" — no in-popup error surface · one ~400-line `useEffect` owns six concerns · `SettingsPanel` unmounted (not hidden) by the countdown, forcing 4 IPC refetches
- **STT (06):** `switchModel()` remote branch commits before awaiting · `getStatus().available` treats `error` as available · no abort path for in-flight transcription · `UNVERIFIED` orphaned child processes on quit
- **Build (07):** no typecheck/lint/test gate anywhere · dead `resources/stt` duplicate · `NODE_ENV` instead of `app.isPackaged` for asset loading
- **Memory/hangs (08):** worker `dispose()` never runs before `terminate()`, so every surviving init cycle leaves an undestroyed `GPUDevice` — severity raised from `04-P3` because the C0-a loop multiplies it

### P3 — 23 findings

Welcome window competes with GPU init at startup · `app-config:set` accepts `shortcut` with no live re-registration · tray icon generator unwired from any build script · inconsistent `{success,data,error}` envelope · `tray:update-state` reports success on invalid state · no internal reentrancy guard in `AudioCapture` · dead `onAudioLevel` param (no live level meter on the primary path) · no recording cap inside `AudioCapture` · `dispose()` races `terminate()` · deprecated `requestAdapterInfo()` · untracked copy-feedback timeout · constructors inside `useRef` initializers · inline array literal per render · `whisper-remote.js` — 447 lines fully dead, carrying a duplicate of the retry bug · `engine-port.js` doc drift (`boolean` vs `{available,error}`) · plaintext API key at rest · all ~55 Chromium locales shipped · CI `contents: write` for a read-only job · unversioned `build-deps-v0.0.0` as CI's sole binary source.

---

## Worth preserving

Called out because a remediation pass shouldn't undo them:

- **Renderer as single authority for recording lifecycle.** `main-simple.js:535-541` documents a real prior bug (dueling main/renderer timers desyncing tray state) and the fix — tray as a pure reflection — is the right architecture. It's the template the load-failure gaps should follow.
- **`render-process-gone` crash recovery with a crash budget** is well done.
- **`contextIsolation: true` + `nodeIntegration: false`** everywhere, and a real (if incomplete) channel allowlist on `invoke`.
- **No implicit off-device audio.** Verified: `RemoteAdapter.transcribe()` throws unless the user explicitly saved an endpoint; no hardcoded remote endpoint exists anywhere in `app/stt/` or `app/main/`.
- **Two previously-known hazards are confirmed fixed** in current code: the app-version-keyed cache wipe (`model-cache.ts:80-92` now clears only on genuine model-identity change) and denied persistent-storage (`main-simple.js:354-360` auto-approves).
- **The `isStale()` / `requestGenRef` generation-counter pattern** in `CaptureApp` correctly guards against late responses stomping fresh state. It's the pattern `SettingsPanel`'s keystroke saves should adopt.
- **Cue-sound modules are clean** — short-lived contexts, `.close()` tied to `onended`, no leaks found.
- **The `@noble/hashes` `overrides` pin** is correct as far as it goes.

---

## Method & limits

- Each domain was reviewed independently with no shared context, then de-duplicated here. CSP was the only finding reported twice.
- **The subsystem partition has a known blind spot.** Passes 01–07 split by *file ownership*, which means a defect spanning two files owned by different agents can be missed even when both agents read their own file correctly — exactly what happened with C0-a. Pass 08 re-partitioned by *failure mode* ("what never resolves, what grows without bound") and found two P0s in those seams. Other failure-mode partitions worth running: concurrency/reentrancy, first-run vs. steady-state, and long-uptime behaviour.
- **C0-a and C0-b are confirmed by code reading, not by reproduction.** Which one is firing on a given machine is undetermined; `raw/08` ends with a log-signature table that discriminates between them. The log is at `%TEMP%\mvp-echo-toolbar-debug.log` and is **wiped on every app start**, so it must be copied before restarting.
- Agents verified suspicions against `node_modules/parakeet.js` and `node_modules/combined-stream` source before writing them up, and explicitly discarded several false positives (parakeet's `powerPreference` is correctly set by the library; `resetMelCache`/`clearIncrementalCache` are real methods; confidence-score keys are correct; the post-abort stale-promise race is already guarded).
- Build sizes are measured (`du`/`ls`/`asar list`) against a local `dist/`, not estimated.
- **Not covered:** runtime profiling, Windows-specific behavior (the dev box is headless Linux), and whether released CI artifacts reproduce the `app.asar` self-reference. Three findings are marked `UNVERIFIED` with the exact test that would settle each.
- **No source files were modified.**
