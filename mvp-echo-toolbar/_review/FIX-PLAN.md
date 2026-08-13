# Fix Plan — traceability map

Every fix below traces to a numbered finding in a raw review file and to exact `file:line` in the
code. **Fix IDs match the "Ranked remediation" table in [`ARCHITECTURAL-REVIEW.md`](ARCHITECTURAL-REVIEW.md)** —
that table is the canonical ordering; this document is the reading guide and work breakdown.

Scope assumption: personal / small-group open-source tool. Priorities are *reliability* and *speed*,
not distribution hardening. See "Deliberately skipped" at the end.

---

## How to read the review

| If you want… | Read |
|---|---|
| The 2-minute version | [`ARCHITECTURAL-REVIEW.md`](ARCHITECTURAL-REVIEW.md) → "Bottom line" |
| Why the same symptom has many causes | `ARCHITECTURAL-REVIEW.md` → "Convergent failure clusters" (C0–C6) |
| The memory answer specifically | `ARCHITECTURAL-REVIEW.md` → **C0.5**, then [`raw/09`](raw/09-pcm-allocation-trace.md), [`raw/10`](raw/10-retention-audit.md), [`raw/11`](raw/11-gpu-worker-lifecycle.md) |
| The chunking/speed design | `ARCHITECTURAL-REVIEW.md` → "Throughput", then [`raw/12`](raw/12-parallel-chunking-design.md) + [`raw/13`](raw/13-overlap-stitch-correctness.md) |
| Evidence for one specific fix | The raw file named in the tables below — each finding has a verbatim code excerpt |

Raw files are numbered by review pass, not by importance: **01–07** subsystem passes, **08** failure-mode
pass, **09–14** deep data-path/lifecycle passes.

> Note: raw files 01–11 say the model is "~1.2 GB". That was wrong — it is **~2.5 GB**. See the
> correction banner at the top of `ARCHITECTURAL-REVIEW.md`. Passes 12–14 use the corrected figure.

---

## Phase 1 — Stop it breaking

Everything the user experiences as friction: the hotkey doing nothing, recordings coming back empty,
the app freezing. Seven fixes, nearly all one-to-three lines.

| ID | Fix | Code | Finding | Read |
|---|---|---|---|---|
| **0a** | `throw err` at the end of `initialize()`'s catch, so a failed init actually reports failure. Gate the `webgpu:model-ready(true)` IPC on real readiness. | `inference-orchestrator.ts:81-92`; `CaptureApp.tsx:67-76`, `:461` | P0 — dead 3-strike guard → unbounded 15s/~2.5 GB reload loop | [`raw/08`](raw/08-memory-and-hangs.md) §P0#1 · confirmed [`raw/11`](raw/11-gpu-worker-lifecycle.md) "CLAIM A" · cluster **C0-a** |
| **0b** | Track the pending `sendMessage` rejector; call it from `disposeSync()`. Clear `this.loading` there too. | `inference-orchestrator.ts:65-70`, `:73-77`, `:136-143`, `:145-175` | P0 — device loss during init wedges the app 15 min; recovery is self-disabled | [`raw/08`](raw/08-memory-and-hangs.md) §P0#2 · confirmed [`raw/11`](raw/11-gpu-worker-lifecycle.md) "CLAIM B" · cluster **C0-b** |
| **1** | Guard `devicechange` on recording-active — abort with a distinct error instead of silently stopping the mic. | `AudioCapture.ts:361-371`, `:380-390` | P0 — headphone/Bluetooth/USB event truncates a live recording | [`raw/03`](raw/03-audio-capture.md) §P0 · cluster **C2** |
| **3** | Register `globalShortcut` *before* awaiting engine init; handler shows "still starting" rather than no-op. | `main-simple.js:396-438` | P1 — hotkey not registered until GPU probing finishes | [`raw/01`](raw/01-main-process.md) §P1#1 · cluster **C1** cause 1 |
| **4** | Add `did-fail-load` + a timeout to the `whenReady()` chain; surface an `error` tray state. | `main-simple.js:399-405` | P1 — page load failure hangs startup forever, silently | [`raw/01`](raw/01-main-process.md) §P1#2 · cluster **C1** cause 2 |
| **5** | Apply the mute + short energy gate to the **warm** mic path (50–100 ms fallback, keeping most of the latency win). | `AudioCapture.ts:474-478`, `:298-303`; contrast the correct cold path at `:501-517` | P1 — "talk now" chirp fires with no proof audio is flowing | [`raw/03`](raw/03-audio-capture.md) §P1 · cluster **C2** |
| **9** | Let `_restoreModelSelection()` win only when it agrees with `initialize()`'s live probe. | `engine-manager.js:152-193`; `webgpu-bridge-adapter.js:153-158` | P1 — stale saved preference routes to a dead engine while a working one sits idle | [`raw/06`](raw/06-stt-engines.md) §P1#2 · cluster **C1** cause 4 |

**Related, worth doing in the same pass** (2 lines, prevents fix 4 from being needed in the field):
gate dev-vs-prod asset loading on `app.isPackaged` instead of `NODE_ENV` — `main-simple.js:149-154`,
`:216-220`, `:326-330`. See [`raw/07`](raw/07-build-packaging.md) §P2 "NODE_ENV".

---

## Phase 2 — Chunking

Land this for **correctness first**. The app currently hands the entire recording to the model in one
call and never chunks; per production logs in `RELEASE-INSTABILITY-GAP-ANALYSIS.md`, decode collapses
to empty above ~60–90 s. Parallelism is a follow-on, not the point of this phase.

| ID | Fix | Code | Read |
|---|---|---|---|
| **0c** | Split audio into 30 s windows with 2–3 s overlap before `model.transcribe()`. Enable `returnTimestamps`. Merge with parakeet's own `LCSPTFAMerger`, wrapped in a per-chunk health gate. | `inference-worker.ts:125` (the one-shot call), `:126` (`returnTimestamps: false`) | [`raw/12`](raw/12-parallel-chunking-design.md) — execution architecture · [`raw/13`](raw/13-overlap-stitch-correctness.md) — merge algorithm + pseudocode + edge-case table |
| **0e** | Add the `postMessage` transfer list; reuse `trimmed` on the retry instead of re-running `trimSilence(pcm)`. | `inference-orchestrator.ts:173`; `CaptureApp.tsx:12-22`, `:299-311` | [`raw/09`](raw/09-pcm-allocation-trace.md) — allocation ledger |

**Library facts that shape this design** (all cited with excerpts in `raw/12`/`raw/13`):
- `LCSPTFAMerger` already exists — `parakeet.js:1811-2014`, exported from `index.js:5`.
- Its no-anchor default keeps the *earlier* chunk and discards the later one (`parakeet.js:1906-1909`)
  — which silently eats a healthy neighbour's text when the earlier chunk is one of the empties.
  This is the one piece needing custom code.
- One `ParakeetModel` reuses mutable scratch buffers (`parakeet.js:43`), so concurrent
  `transcribe()` calls on a single instance race — parallelism requires separate workers.
- parakeet's own long-audio chunker defaults to a **10 s** overlap (`long_audio.js:5`), not 2 s.

---

## Phase 3 — Speed (measure first)

| ID | Fix | Code | Read |
|---|---|---|---|
| **2** | Inject COOP/COEP headers in the packaged app (`session.defaultSession.webRequest.onHeadersReceived`); assert `crossOriginIsolated === true` at runtime. | `vite.config.ts:54-66` (dev-only today) vs `main-simple.js:131-185` (nothing) | [`raw/04`](raw/04-webgpu-inference.md) §P1#1 · cluster **C3** |
| — | **Turn on `enableProfiling` and measure the encoder/decoder split.** No defensible N can be chosen without this. | `inference-worker.ts:128` | [`raw/12`](raw/12-parallel-chunking-design.md) §5 |
| — | Then: N independent workers, each with its own model instance. N=2 on 8 GB VRAM, N=3 on a 3090. | new | [`raw/12`](raw/12-parallel-chunking-design.md) §3–4 |

**Why measure first:** the decoder-stage gain from parallel workers is real and OS-thread-backed. The
GPU-encoder gain is **not verified** — a single 0.6B forward pass may already saturate the card, in
which case N concurrent encoders largely serialize. `raw/12` declines to give a speedup number from
source, and that's the right call.

**COOP/COEP is *not* a prerequisite for chunking** (each Worker is already its own OS thread with its
own WASM instance) — it's an independent win for the linear path. Verdict and reasoning in
[`raw/12`](raw/12-parallel-chunking-design.md) §2.

---

## Phase 4 — Housekeeping (cheap, do when convenient)

| ID | Fix | Code | Read |
|---|---|---|---|
| **0d** | Dispose the orchestrator when switching away from a WebGPU model — currently ~2.5 GB stays resident, idle, all session. | `engine-manager.js:312-346` | [`raw/11`](raw/11-gpu-worker-lifecycle.md) §"Switching away from WebGPU" |
| **0f** | Cap/evict `%TEMP%\mvp-echo-audio\`; cap the diagnostics log; fix the orphan sweep's name/extension mismatch. | `main-simple.js:40-49` (sweep), diag dir writes | [`raw/10`](raw/10-retention-audit.md) F1, F2 |
| **8** | Add `"typecheck": "tsc -b"` and run it before packaging. **Highest value-per-minute item in the whole review for a solo maintainer** — there are no tests and `tsc` never runs today, so type errors ship. | `package.json:7-15`, `tsconfig.json:11` | [`raw/07`](raw/07-build-packaging.md) §P2 "No type-checking" |
| **12** | Make the logger async; rate-limit renderer console forwarding. | `logger.js:12-33`; `CaptureApp.tsx:151-163` | [`raw/01`](raw/01-main-process.md) §P2#1 |
| **6, 7** | Slim the build: negate `dist/**` in the `files` glob, move `parakeet.js` to devDependencies, swap in an audio-only ffmpeg. 290 MB → ~90 MB. | `package.json:16-34` | [`raw/07`](raw/07-build-packaging.md) §P0, §P1#1–2 |

---

## Deliberately skipped

Not because they're wrong — because the cost/benefit doesn't hold for a personal tool with no
large-scale deployment. Documented so the decision is explicit rather than forgotten.

| Skipped | Finding | Why |
|---|---|---|
| Code signing / SmartScreen | [`raw/07`](raw/07-build-packaging.md) §P1 | Real certificate cost; a handful of users can click through once |
| Committed lockfile / `npm ci` | [`raw/07`](raw/07-build-packaging.md) §P1 | Matters with multiple contributors; you are the release manager |
| `sandbox: true`, CSP tightening | [`raw/02`](raw/02-ipc-security.md) §P1#2, §P2#1 | Correct settings already in place; no untrusted content reaches these windows |
| ~50 assorted P2/P3s | passes 01–07 | Cosmetic at this scale |

**One exception worth taking from the skipped pile:** the navigation guard —
`will-navigate` deny + `setWindowOpenHandler({action:'deny'})` — is ~3 lines and closes the only
security gap with a plausible path to mattering. `main-simple.js:135-147`, `:199-214`, `:308-324`;
[`raw/02`](raw/02-ipc-security.md) §P1#1.

---

## Definition of Done — v1 (pre-recon draft) — SUPERSEDED

**Superseded by v2 below.** Kept for traceability: v1 was written *before* recon, and recon changed
seven of the twelve DoDs — including one (Fix 9) where the v1 DoD, implemented literally, would have
**broken WebGPU on every cold boot**. The diff between v1 and v2 is the value recon produced.

### The constraint that shapes every DoD

The development box is **headless Linux**; the product is a **Windows 11 tray app**; there are
**zero automated tests** and `tsc` never runs. So "done" cannot mean "I ran the app and it worked."
Each DoD below names its evidence method, and each method must fall into one of:

- **(S) Static** — provable by reading code / typecheck. Weakest, always available.
- **(H) Harness** — runnable headless in Node against the module under test, with Electron/DOM stubbed.
- **(W) Windows manual** — requires you on Windows. Expensive; reserve for what genuinely needs it.

A DoD resting *only* on (W) is a risk flag — recon is asked to convert those to (H) where possible.

| ID | Done when | Evidence | Must not regress |
|---|---|---|---|
| **0a** | A failed `initialize()` **rejects**. `initFailRef` increments once per consecutive failure. After 3, auto re-init stops and logs `init failed 3× — not auto-retrying`. `webgpu:model-ready(true)` is sent **only** when `isReady()` is genuinely true. | (H) fault-inject an init failure; assert counter 1→2→3 then halt | A *successful* init still resets the counter to 0; no retry storm; the 15s cooldown still applies |
| **0b** | A `device-lost` during init rejects the in-flight init within ~1s. `isLoading()` returns false immediately after teardown. The next hotkey press can trigger a fresh init (subject to cooldown). | (H) post a `device-lost` message to a stubbed worker; assert rejection latency and `isLoading()` | Normal init still completes; the 900s timeout remains as a backstop for a genuinely slow first download; `transcribe`'s 120s path fixed the same way |
| **1** | A `devicechange` while RECORDING does **not** stop mic tracks. The recording either continues intact, or aborts with a **distinct** error + cue — never a silent empty result. | (H) if the guard is extractable; else (W) plug/unplug mid-recording | Warm-mic idle release on `devicechange` while **not** recording still works — that's the behaviour the listener was added for |
| **3** | `globalShortcut.register()` completes before engine init is awaited. A press during warmup produces a distinct "still starting" cue, not silence. | (S) ordering in source + (H) log-timestamp assertion: registration ts < engine-ready ts | No double registration; `unregisterAll()` on quit still fires; the 500ms debounce still holds |
| **4** | A renderer load failure surfaces an `error` tray state and a log line within a bounded time (≤15s) instead of hanging forever. | (H) point `loadFile` at a nonexistent path in a dev harness | Normal startup path unchanged; no spurious error state on a merely slow load |
| **5** | The warm-mic path fires `captureReady` only after `track.muted === false` **and** ≥1 above-floor frame from the new worklet. Added latency ≤100ms in the common case. | (H) stub track/worklet; assert no fire while muted. Latency confirmed via the existing `keypress→live Nms` diag line | Cold path behaviour unchanged; the warm-mic latency advantage is *mostly* preserved (not reverted to the 2s cold fallback) |
| **9** | When the live probe reports WebGPU unavailable, `_restoreModelSelection()` does **not** force `activeAdapterName='webgpu'`. `selectedModelId` reflects an adapter that actually works. | (H) stub `isAvailable()` → false; assert resulting adapter/model | A *working* saved WebGPU preference is still restored across restarts — the feature this function exists for |
| **0c** | Audio >30s is chunked; a 10-minute recording returns non-empty text. Merged output has no duplicated or dropped words at seams. A single failed chunk yields an explicit gap marker, not silent truncation. | (H) WER diff: same input transcribed linear vs chunked; (H) property tests over synthetic seams | Short (<30s) recordings take the single-chunk path with no added latency |
| **0e** | PCM crosses to the worker via transfer list; `trimSilence` runs once per transcription, not twice on retry. | (S) source + (H) assert `pcm.buffer.byteLength === 0` post-transfer | The retry still transcribes the same audio; `saveDiagAudio` still gets the untransferred original |
| **0d** | Switching away from a WebGPU model disposes the orchestrator; resident footprint drops. | (S) call path + (W) Task Manager | Switching *back* re-initialises correctly |
| **0f** | The diag WAV dir and diagnostics log are capped/evicted; the orphan sweep matches the actual filenames. | (H) filename-pattern assertion against real emitted names | Diagnostics remain useful — eviction keeps the most recent, not the oldest |
| **8** | `npm run typecheck` exists, passes, and runs before packaging. | (S) it runs green | Zero source behaviour change |

### Open questions — ANSWERED by recon

1. **What's testable headless?** More than expected, but not via Electron. Headless Electron is **not
   feasible** on this box — `chrome-sandbox` isn't setuid-root, no `DISPLAY`, no `xvfb`, and WebGPU is
   unreachable regardless ([`F`](recon/F-verification-strategy.md)). But pure-logic modules test fine
   in plain Node: `AudioCapture`'s gating arithmetic needs only field stubs, no jsdom ([`C`](recon/C-audiocapture-fix-design.md));
   `EngineManager` runs headless **today with zero source changes** via a `require.cache` stub of the
   `electron` module — verified by execution, not proposed ([`E`](recon/E-engine-selection.md)); and
   `esbuild` + `node:module.register()` are already present, so `node:test` needs **no new
   dependencies** ([`F`](recon/F-verification-strategy.md)). Only `InferenceOrchestrator` needs a
   small seam (inject a worker factory) ([`A`](recon/A-orchestrator-blast-radius.md)).
2. **Regression risk?** No fix is HIGH. Two are MEDIUM: **0b** (two independent agents found two
   different ways to break it) and **9** (would break WebGPU entirely if done naively). No site has
   ever been reverted ([`B`](recon/B-regression-archaeology.md)).
3. **True dependency order?** Only one hard ship-together pair exists (**3 + engineReadyRef**). The
   rest are independent, which is why the rollout below can be landed incrementally. Full graph in
   the tracking table.
4. **State machine for `AudioCapture`?** **No — point patches.** The needed fact is already free as
   `!!this.rawWorklet` (set/cleared synchronously, race-safe as a check), and Fix 5 is a data-gating
   problem, not a transition-legality one ([`C`](recon/C-audiocapture-fix-design.md)). **Dissent
   recorded:** [`B`](recon/B-regression-archaeology.md) notes this logic has been edited 3× across 3
   consecutive releases chasing the same question, and argues churn signals a design problem.
   **Tripwire: if this code needs a 4th edit, build the state machine instead of patching again.**

---

## Definition of Done — v2 (post-recon, authoritative)

Changes from v1 are marked **▲**. Evidence classes: **(S)** static/typecheck · **(H)** headless Node
harness · **(W)** Windows manual.

| ID | Done when | Evidence | Must not regress |
|---|---|---|---|
| **8** | `npm run typecheck` exists and passes. ▲ Uses `tsc --noEmit`, **not** `tsc -b` — `tsconfig.node.json` has no `noEmit`, so `-b` emits `vite.config.js`/`.d.ts`/`.tsbuildinfo` into the repo (observed during recon). ▲ Those 4 artifacts are gitignored. ▲ The single existing error (`PopupApp.tsx:151`, unused `langDisplay`) is fixed. | (S) runs green in ~2.7s | Zero source behaviour change |
| **0a** | A failed `initialize()` **rejects**. `initFailRef` increments per consecutive failure; after 3, auto re-init halts with a log. `webgpu:model-ready(true)` fires **only** on genuine readiness. ▲ `'Already loading'` becomes a **distinguishable error type, excluded from the 3-strike count** — it's a real reachable race (mount auto-init vs. the `webgpu:init-orchestrator` IPC), not dead code. ▲ New observable: Settings no longer reports "model loaded" after a failed load. | (H) w/ injected worker factory; (S) for the IPC gating | Successful init still resets the counter; 15s cooldown still applies; **0 call sites need a new `catch`** (verified — the un-awaited wrappers absorb rejections internally) |
| **0b** | A `device-lost` during init rejects the in-flight request within ~1s; `isLoading()` clears; next press can re-init. ▲ `loading` is cleared/rejected **only when a pending request actually exists** — unconditional clearing lets two `initialize()` calls race, each spawning a Worker (**~5 GB**). ▲ An **epoch/generation guard** prevents a stale call's delayed cleanup from terminating a *newer* call's live worker. | (H) post `device-lost` to a stubbed worker; assert rejection latency, `isLoading()`, and worker count == 1 | Normal init completes; the 900 s timeout remains as a backstop; `transcribe`'s 120 s path fixed identically |
| **1** | A `devicechange` while recording does **not** stop mic tracks. ▲ Design is **defer, not drop**: set a flag, apply `releaseMicStream()` right after `stopRawRecording()`. ▲ `track.onended` (today diagnostics-only, `CaptureApp.tsx:168`) is wired to abort with a distinct cue — it's the only signal actually tied to the in-use device. `devicechange` carries no device identity. | (S) pre-check + (W) plug/unplug mid-recording | ▲ **Critical:** the next recording after a device event must still **cold-acquire** (and therefore be gated). Today's P0 accidentally protects against the P1 — a naive "just ignore it" fix would make empty recordings *more* frequent |
| **3** | `globalShortcut.register()` completes before engine init is awaited; an early press shows a "still starting" cue. ▲ **Requires an explicit `engineReadyRef`** — without it an early press does *not* hit the "not ready" branch (`selectedModelRef` is still `''`) and falls through to **Start Recording via the wrong adapter**, silently failing. Inferring readiness from `selectedModelRef`/`orchestratorRef` is unreliable this early. ▲ Needs a new tray `starting` state **and a new icon** (all 5 existing icons are 1:1 with current states; `setState()` silently no-ops on unknown keys). | (S) statement order + (H) log-timestamp assertion | No double registration; `unregisterAll()` on quit; 500 ms debounce |
| **4** | A renderer load failure surfaces an `error` tray state within ▲ **15 s**. ▲ **Resolve with a status object, not reject**, so the caller branches explicitly. ▲ On failure, skip engine init and route through the **existing** `rendererCrashCount`/`MAX_RENDERER_CRASHES` budget (`main-simple.js:120-121`, `:172-184`), which today covers only OS-level renderer death, not a stuck initial load. | (S) + (W) point `loadFile` at a bad path | Normal startup unchanged; no spurious error on a merely slow load |
| **3b** | ▲ **New, split out of 3.** Dev/prod asset gating uses `!app.isPackaged && process.env.NODE_ENV === 'development'` — **not** bare `app.isPackaged`, which would break `npm start` (runs unpackaged against a built `dist/renderer/` and would misroute to the dev server). | (S) | `npm run dev` and `npm start` both work |
| **5** | Warm path fires `captureReady` only after `track.muted === false` **and** real energy. ▲ Concrete budget: **~50 ms** contiguous above-floor energy (vs. cold's 250 ms), **~100–150 ms** fallback (vs. cold's 2000 ms). ▲ Added latency **~50–70 ms** vs. today's buggy 0 ms. ▲ Implementation is one line: `AudioCapture.ts:467`'s `if (!wasWarm)` becomes a smaller gate; the worklet and RMS math already run every recording. | (H) field stubs — no jsdom needed | Cold path unchanged; warm latency advantage mostly preserved (must not fall back to the 2 s cold timeout) |
| **9** | Live probe result wins over a stale saved preference. ▲ **v1's DoD was wrong and would have broken WebGPU on every cold boot — deterministically, not as a race.** `cloud:get-config` blocks on `_readyPromise` (end of `initialize()`), but `isAvailable()` depends on `WebGpuModelManager._ready`, set only by an IPC the renderer sends *after* reading `selectedModel` from `cloud:get-config`. Closed cycle. ▲ Correct design: split the probe — gate on a **hardware-only three-state** result (`available`/`unavailable`/`unknown`); treat `unknown` as "trust the saved preference"; only a definitive `unavailable` falls through. ▲ Collapse `initialize()`'s four `_restoreModelSelection()` call sites into one, after all probes. | (H) `require.cache` electron stub — **works today, zero source changes**; + optional adapter injection | ▲ A *working* saved WebGPU preference still restores across restarts. ▲ Scope honesty: fixes C1 **cause 4 only**, not cause 3 (a correct WebGPU selection still warming) — that needs Fix 10 |
| **0c** | Audio >30 s chunked; a 10-min recording returns non-empty text; no duplicated/dropped words at seams; a failed chunk yields an explicit gap marker. | (H) WER diff linear-vs-chunked + property tests on synthetic seams | Recordings <30 s take the single-chunk path with no added latency |
| **0e** | PCM crosses via transfer list; `trimSilence` runs once, not twice on retry. | (H) `node:worker_threads` MessageChannel gives real detach semantics — assert `buffer.byteLength === 0` | Retry still transcribes the same audio; `saveDiagAudio` still receives the untransferred original |
| **0d** | Switching away from a WebGPU model disposes the orchestrator. ▲ Route through `switchModel()`/`switchAdapter()`, not a new ad hoc mutation site. ▲ No interaction with Fix 9 at boot (nothing is resident that early). | (S) call path + (W) Task Manager | Switching back re-initialises |
| **0f** | Diag WAV dir + diagnostics log capped/evicted; orphan sweep matches actual filenames. | (H) filename-pattern assertion | Eviction keeps the **most recent**, not the oldest |

---

## Phased rollout

**Sequencing principle:** Phase 0 first — it is the verification substrate for everything after it,
and it costs about an hour. Landing behaviour changes before it means fixing a zero-test codebase
blind.

**Phase 0 — Foundation.** Fix 8 (typecheck gate) + the two testing seams recon proved out (worker-factory
injection on `InferenceOrchestrator`; `require.cache` electron stub for `EngineManager`, which needs no
source change at all). No behaviour changes. Everything downstream becomes checkable.

**Phase 1 — Reliability.** The friction cluster. Order within the phase is by risk ascending, so the
riskiest change (0b) lands into a codebase already stabilised by the safer ones.

**Phase 2 — Chunking.** Correctness first (empty decode >60–90 s), parallelism later.

**Phase 3 — Speed.** COOP/COEP, then **measure**, then choose N. No N is picked before profiling.

**Phase 4 — Housekeeping.** Cheap, independent, do anytime.

---

## Tracking table

Status: `⬜ not started` · `🟨 in progress` · `🟩 done` · `✅ verified against DoD`

| # | ID | Phase | Fix | Depends on | Risk | Evidence | Files | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | **8** | 0 | Typecheck gate (`tsc --noEmit`) + fix 1 error + gitignore 4 artifacts | — | LOW | S | `package.json`, `.gitignore`, `PopupApp.tsx:151` | ⬜ |
| 2 | **T1** | 0 | Test seam: inject worker factory into `InferenceOrchestrator` (optional ctor param, no signature changes) | — | LOW | S | `inference-orchestrator.ts` | ⬜ |
| 3 | **T2** | 0 | Test seam: `node:test` runner + `require.cache` electron stub (zero new deps) | — | LOW | S | new `test/` | ⬜ |
| 4 | **3b** | 1 | `!app.isPackaged && NODE_ENV==='development'` asset gating | 8 | LOW | S | `main-simple.js:149,216,326` | ⬜ |
| 5 | **4** | 1 | `did-fail-load` + 15 s bounded wait → error tray state, via existing crash budget | 3b | LOW | S+W | `main-simple.js:399-405` | ⬜ |
| 6 | **5** | 1 | Warm-mic gate (~50 ms energy / ~100–150 ms fallback) | T2 | LOW-MED | H | `AudioCapture.ts:467,474-478` | ⬜ |
| 7 | **1** | 1 | Defer `releaseMicStream()` while recording + wire `track.onended` to abort | 5 | LOW | S+W | `AudioCapture.ts:361-371,380-390` | ⬜ |
| 8 | **3** | 1 | Register hotkey before engine init **+ `engineReadyRef` + new `starting` tray state/icon** | 4 | MED | S+H | `main-simple.js:396-438`, `tray-manager.js`, `icons/` | ⬜ |
| 9 | **0a** | 1 | `initialize()` re-throws; typed `AlreadyLoadingError` excluded from 3-strike count; gate `model-ready` IPC | T1 | LOW | H+S | `inference-orchestrator.ts:81-92`, `CaptureApp.tsx:67-76` | ⬜ |
| 10 | **9** | 1 | Three-state hardware-only probe; `unknown` ⇒ trust saved pref; collapse 4 call sites → 1 | T2, 0a | **MED** | H | `engine-manager.js:152-193`, `webgpu-bridge-adapter.js:79-95,153-158` | ⬜ |
| 11 | **0b** | 1 | Reject pending request on teardown **only when pending exists** + epoch guard | 0a, T1 | **MED (highest)** | H | `inference-orchestrator.ts:136-143,145-175` | ⬜ |
| 12 | **0e** | 2 | `postMessage` transfer list; reuse `trimmed` on retry | T1 | LOW | H | `inference-orchestrator.ts:173`, `CaptureApp.tsx:299-311` | ⬜ |
| 13 | **0c** | 2 | 30 s chunking + `LCSPTFAMerger` + per-chunk health gate + gap markers | 0e, T2 | MED | H | `inference-worker.ts:125-126`, new chunker | ⬜ |
| 14 | **2** | 3 | COOP/COEP via `onHeadersReceived`; assert `crossOriginIsolated` | 4 | MED | W | `main-simple.js` | ⬜ |
| 15 | **P1** | 3 | Turn on `enableProfiling`; measure encoder/decoder split | 2 | LOW | W | `inference-worker.ts:128` | ⬜ |
| 16 | **P2** | 3 | N parallel workers (N from P1 data, cap 2 @ 8 GB / 3 @ 24 GB) | P1, 0c | MED | W | new pool | ⬜ |
| 17 | **0d** | 4 | Dispose orchestrator on switch away from WebGPU | — | LOW | S+W | `engine-manager.js:312-346` | ⬜ |
| 18 | **0f** | 4 | Cap/evict diag WAV dir + diagnostics log; fix orphan sweep pattern | — | LOW | H | `main-simple.js:40-49` | ⬜ |
| 19 | **12** | 4 | Async logger + rate-limit renderer console forwarding | — | LOW | S | `logger.js:12-33` | ⬜ |
| 20 | **NAV** | 4 | `will-navigate` deny + `setWindowOpenHandler` deny (~3 lines) | — | LOW | S | `main-simple.js:135,199,308` | ⬜ |

**Not scheduled** (explicit decisions, see "Deliberately skipped"): code signing · committed lockfile /
`npm ci` · `sandbox: true` + CSP tightening · build slimming (6, 7) — fold into the next build change ·
Fix 10 (progress UI + warm-up fallback) — revisit after Phase 3 · ~50 assorted P2/P3s.

---

## Status

**Nothing has been implemented.** No source file has been modified — every review and recon pass was
read-only, and the only files written are under `_review/`.

One housekeeping note: a recon pass ran `tsc -b --force`, which emitted `vite.config.js`,
`vite.config.d.ts`, and two `.tsbuildinfo` files into the repo root (none gitignored). These were
deleted; the working tree is clean apart from `_review/`. This is folded into Fix 8's DoD as the
reason the script must use `--noEmit`.
