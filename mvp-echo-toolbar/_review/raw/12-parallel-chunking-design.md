# Parallel Chunked Transcription — Feasibility & Design

Scope: execution/parallelism architecture only. Overlap-stitch text-merge correctness
(dedup, word-boundary alignment across the 2 s overlap) is handled by a separate
workstream and is deliberately **not** designed here — this doc defines the boundary
(what data the merge stage receives) but not the merge algorithm.

Sources read: `app/renderer/app/webgpu/inference-worker.ts`,
`app/renderer/app/webgpu/inference-orchestrator.ts`, `app/renderer/app/webgpu/gpu-detector.ts`,
`app/renderer/app/webgpu/model-cache.ts`, `app/renderer/app/CaptureApp.tsx`,
`app/renderer/app/audio/AudioCapture.ts`, `app/main/main-simple.js`, `vite.config.ts`,
`node_modules/parakeet.js@1.4.4/src/{parakeet.js,backend.js,hub.js,mel.js,long_audio.js,models.js}`,
plus the existing repo reviews `_review/raw/04-webgpu-inference.md` and
`/home/corey/projects/mvp-echo-toolbar/RELEASE-INSTABILITY-GAP-ANALYSIS.md`, and a live
HuggingFace file listing for `ysdede/parakeet-tdt-0.6b-v2-onnx@main` (fetched during this
review to get real weight-file byte sizes — labeled explicitly below since it isn't a
repo `file:line`).

**Convention used throughout:** "RTF" below always means `processing_time / audio_duration`
(lower = faster than real time), the standard ASR convention. Note parakeet.js's own
internal metric is the **inverse** — `rtf: audioDur / (total_ms/1000)`, displayed as "Nx" —
so its console output and this doc's RTF numbers are reciprocals of each other. This is
flagged explicitly because the two conventions are easy to conflate when reading logs.

---

## 0. The single most important pre-existing fact

**The app does not chunk today, at all, and this is already causing a correctness bug —
independent of parallelism.** `inference-worker.ts:125` calls `model.transcribe(audio, sampleRate, {...})`
on the **entire** captured buffer (up to 600 s, `CaptureApp.tsx:25`) in one shot. parakeet.js
ships its own long-audio windowing (`transcribeLongAudio`/`transcribeLongAudioWithChunks`,
`node_modules/parakeet.js/src/long_audio.js`), and the app never calls it:

```js
// app/renderer/app/webgpu/inference-worker.ts:125-129
const result = await model.transcribe(audio, sampleRate, {
  returnTimestamps: false,
  returnConfidences: true,
  enableProfiling: false,
});
```

Per `/home/corey/projects/mvp-echo-toolbar/RELEASE-INSTABILITY-GAP-ANALYSIS.md:42-44` (production
log evidence, not code, but concrete and already adjudicated by that review's red-teaming):
recordings around 52 s decode cleanly (852–871 chars), ~62 s degrades sharply (88 chars), and
136–189 s decode to nothing ("∅ no speech"). The greedy TDT decode loop
(`parakeet.js:790-959`, discussed in §1) collapses on long, undifferentiated buffers.

**Consequence for this design:** 30 s chunking is not purely a throughput optimization here —
it also fixes a real, already-shipped correctness bug, because 30 s is comfortably under the
~52–62 s point where decode quality starts degrading. That argues for landing chunking
(even sequential, even before any parallelism) on its own merits. The parallelism question
in this doc is "given we're chunking anyway, is running chunks concurrently worth it, and how."

---

## 1. Where the time actually goes

### 1a. What's verified from source (code facts)

**The pipeline per `transcribe()` call has four stages**, each timed internally when
`enableProfiling`/`debug` is on (`parakeet.js:627-653`, `961-990`): preprocess (mel), encode
(GPU), decode (WASM), tokenize. **The app currently runs with `enableProfiling: false`**
(`inference-worker.ts:128`), so **no per-stage breakdown has ever been captured in this app** —
`result.metrics` is `null` end-to-end (`parakeet.js:978-990` only populates `metrics` when
`perfEnabled` is true), and `inference-worker.ts:133` falls back to `{}`. This is a real gap:
before committing engineering time to a specific architecture, flip `enableProfiling: true` for
one instrumented run and capture real `preprocess_ms`/`encode_ms`/`decode_ms` on target hardware.
Everything below this point is reasoned from code structure, not measured in this app.

**Preprocessing (mel) is pure JS, single-threaded, on the worker's own thread — not WASM, not
gated by SharedArrayBuffer.** `mel.js:1-27` implements the full NeMo-compatible log-mel pipeline
(pre-emphasis, STFT via real FFT, mel filterbank matmul, per-feature CMVN) in plain JS:

```js
// node_modules/parakeet.js/src/mel.js:1-9
/**
 * Pure JavaScript log-mel spectrogram computation matching NeMo / onnx-asr nemo preprocessor.
 * ...
 * Pipeline (matching onnx-asr/preprocessors/nemo.py exactly):
 *   1. Pre-emphasis: ...
 *   4. STFT: Cast to Float64, symmetric Hann window (400→512 zero-padded),
 *            real FFT via N/2 complex FFT + spectrum reconstruction ...
```

This means COOP/COEP is **irrelevant** to this stage — it never touches WASM threads. It also
means this stage genuinely parallelizes for free across independent Worker threads (see §2).

**The encoder runs once per call on WebGPU** (`parakeet.js:684-694`), a single
`encoderSession.run({ audio_signal, length })`. It is GPU-bound; while it runs, the calling
JS thread is idle on the awaited promise. For a 30 s chunk at `subsampling=8`,
`windowStride=0.01` (`models.js:53,65`), the encoder produces `Tenc ≈ 30/0.08 = 375` output
frames (`getFrameTimeStride()`, `parakeet.js:538-540`).

**The decoder is forced onto WASM whenever the backend starts with `webgpu`, and is architecturally
sequential, frame-by-frame, batch=1 — this is the real bottleneck, not raw FLOPs:**

```js
// node_modules/parakeet.js/src/parakeet.js:221-224
// In hybrid mode, the decoder is always run on WASM
if (backend.startsWith('webgpu')) {
  decoderSessionOptions.executionProviders = ['wasm'];
}
```

The decode loop is a `for` loop over encoder frames with an **awaited** ONNX Run() call every
iteration — up to `Tenc` (≈375 for 30 s) sequential round-trips through the WASM binding, each
processing exactly one frame for exactly one utterance:

```js
// node_modules/parakeet.js/src/parakeet.js:790-798 (loop header + per-frame decode call)
for (let t = startFrame; t < Tenc;) {
  const frameStart = t * D;
  this._encoderFrameBuffer.set(transposed.subarray(frameStart, frameStart + D));
  const prevTok = ids.length ? ids[ids.length - 1] : this.blankId;
  const { tokenLogits, step, newState, _logitsTensor } = await this._runCombinedStep(this._encoderFrameTensor, prevTok, decoderState);
```

Every tensor shape in this path is hardcoded to batch=1 — confirmed, not inferred: encoder
input `[1, melBins, T]` (`parakeet.js:673`), length tensor `[1]` (`679`), per-frame encoder
tensor `[1, D, 1]` (`739`), decoder target tensor `[1, 1]` (`100`), decoder LSTM states
`[numLayers, 1, hidden]` (`88-91`). There is no vectorized/batched multi-utterance path
anywhere in `ParakeetModel`. Advancement is TDT-duration-driven (`step > 0` skips multiple
frames, `929-935`) so the actual iteration count for 30 s of real speech is typically well
below 375, but it remains a **strictly sequential, per-utterance, single-threaded-WASM loop**
— this is what "batch=1 decode" means concretely in this codebase, and it's the reason a
single utterance's decode cannot itself be parallelized (each step depends on the previous
step's LSTM state), while N *independent* chunks' decode loops can run concurrently
(different utterances, no cross-dependency).

The decoder network itself is small — `predHidden=640`, `predLayers=2` (`models.js:54,66`,
matched by `parakeet.js:81-83`) — a 2-layer LSTM plus a joint projection to vocab (1025 or
4097 tokens, `models.js:50,62`). Per-call compute for this size of network is small; the
per-iteration cost of up to ~375 sequential awaited WASM calls is more likely dominated by
fixed call/dispatch overhead than by matrix-multiply FLOPs — **this is an estimate**, not
measured (no per-frame timing exists anywhere in the code or logs), but it follows directly
from "many small sequential kernel launches" being the classic bottleneck shape, and it is the
strongest argument in this whole analysis for *why* parallel chunk dispatch (§3) targets the
decoder specifically rather than the encoder.

### 1b. The one real measured anchor (production logs, not code)

`RELEASE-INSTABILITY-GAP-ANALYSIS.md:51` cites "healthy RTF (~0.04)" for real production
recordings, with "a 189 s clip + retry ≈ 16–20 s". That means, on whatever hardware produced
those logs: **≈189 s of audio processed end-to-end (preprocess+encode+decode+tokenize, single
worker, one-shot, single-threaded WASM decoder, no COOP/COEP) in roughly 8–10 s** — call it
RTF ≈ 0.04–0.05, i.e. **~20–25× faster than real time already**, on the *current*, allegedly
"degraded", single-threaded, unparallelized pipeline.

**This is the load-bearing number for the whole feasibility question.** It's a single
aggregate data point on unknown hardware (not broken into stages, not necessarily
representative of the weakest hardware this app ships to), but it says the *linear* baseline
is not slow in absolute terms — a 3-minute dictation already returns in under 10 seconds.
That tempers, without ruling out, the premise that "very large real-time-factor gains" seen on
the owner's prior stack will reproduce here: their prior stack's payoff was presumably won
against a much worse linear baseline (RTF closer to or above 1). Here the ceiling to chase is
already ~20–25×; the practical win from parallelism is compressing an already-short wait
further, not "making transcription usable" — a different, smaller-magnitude problem.

**Estimate, not fact:** assuming stage costs scale roughly linearly with audio length (a
simplification — the decode-collapse behavior in §0 shows this breaks down for very long
uncontrolled buffers, but should hold reasonably well for clean, correctness-safe 30 s
chunks), a 30 s chunk end-to-end is on the order of **1–1.5 s** of wall time on that same
hardware. Get real numbers by turning on `enableProfiling` before building anything.

---

## 2. Is COOP/COEP a prerequisite? — No, not for chunk-level parallelism specifically

**Verified: the packaged app never establishes cross-origin isolation, so `SharedArrayBuffer`
is unavailable and WASM falls back to 1 thread — but only inside a single Worker's own WASM
instance.**

```js
// node_modules/parakeet.js/src/backend.js:65-74
if (backend === 'wasm' || backend === 'webgpu') {
  if (typeof SharedArrayBuffer !== 'undefined') {
    ort.env.wasm.numThreads = numThreads || navigator.hardwareConcurrency || 4;
    ort.env.wasm.simd = true;
  } else {
    console.warn('[Parakeet.js] SharedArrayBuffer not available - using single-threaded WASM');
    ort.env.wasm.numThreads = 1;
  }
}
```

`vite.config.ts:57-61` sets `Cross-Origin-Opener-Policy: same-origin` /
`Cross-Origin-Embedder-Policy: require-corp` **only** in `server.headers` (dev server). The
packaged app's hidden window loads via `hiddenWindow.loadFile(htmlPath)`
(`app/main/main-simple.js:153`), and there is no `onHeadersReceived`, no
`session.defaultSession.webRequest`, no COOP/COEP-setting code anywhere in `app/main/` —
confirmed by direct search (only `setPermissionRequestHandler` exists,
`main-simple.js:354-360`, unrelated to headers). So `crossOriginIsolated` is `false` in
production today, exactly as the task brief assumed.

**But this only disables *intra-worker* multi-threading — it does not disable *inter-worker*
parallelism.** A `new Worker(...)` (already used today, `inference-orchestrator.ts:57-60`) is
a genuine, separate OS-level thread in Chromium, with its own JS heap and its own independent
WASM linear memory/instance. That has been true of the dedicated Worker API since before
`SharedArrayBuffer` existed and has nothing to do with cross-origin isolation — COOP/COEP
governs whether *one* WASM instance can be handed a `SharedArrayBuffer` to split *one*
computation across multiple threads, not whether the browser can schedule N independent
Workers on N cores. **N independent worker+model instances, each internally single-threaded,
can still run their (sequential, single-threaded) decode loops concurrently on separate cores
today, with zero header changes.** This is general Chromium/web-platform behavior, not
something verifiable via `grep` in this repo, but it's well-established and it directly
determines the §3 recommendation.

**Where COOP/COEP *does* matter, and where it doesn't, precisely:**

| Scenario | COOP/COEP required? | Why |
|---|---|---|
| N-worker pool, each a full independent model instance (this doc's recommendation, §3) | **No** | Each worker is already its own OS thread; concurrent decode loops don't need `SharedArrayBuffer` to overlap on separate cores |
| Speeding up the *existing* single-worker, one-shot linear path | **Yes, to get any WASM thread benefit** | Only way to get >1 WASM thread inside that one worker's decoder |
| A hybrid "1 encoder + pool of decoders" design (§3, flagged not implementable without a library fork) | Partially — only relevant if the decoder pool shares WASM memory | Not reachable with parakeet.js's public API regardless (see §3) |

**Fixing COOP/COEP for the packaged app is a legitimate, separate, smaller fix** — inject
headers via `session.defaultSession.webRequest.onHeadersReceived` in `main-simple.js`
(intercepting the hidden/popup window's own document response is the standard Electron
pattern; a custom protocol is the more robust alternative if `onHeadersReceived` proves
unreliable for `file://`-loaded content, which is a known rough edge in Electron — **UNVERIFIED
here**, would need a build to confirm). **What breaks:** COEP `require-corp` requires every
cross-origin subresource to opt in via `Cross-Origin-Resource-Policy` (or be fetched
`credentialless`). This app fetches encoder/decoder/tokenizer files cross-origin from
`huggingface.co` (`hub.js:216-220`, plain `fetch(url)`, no `credentials`/`mode` override,
`hub.js:237`). Under strict `require-corp`, those responses need `Cross-Origin-Resource-Policy:
cross-origin` from HuggingFace's CDN — **UNVERIFIED whether HF's `resolve` endpoint sends that
header today**; if it doesn't, `require-corp` would break the model download entirely and the
app would need `credentialless` COEP mode instead (Chromium supports this; it doesn't require
the resource to opt in, at the cost of stripping credentials from the cross-origin request,
which is fine here since these are public, unauthenticated model files). This must be verified
against a live response header check before shipping a COOP/COEP change — flagged as a risk in
§7. It is **not** a blocker for the parallel-chunking work in this doc, which doesn't need it.

**Bottom line for Q2: COOP/COEP is not a hard prerequisite for parallel chunk dispatch.** It's
a good, independent fix for the linear/single-chunk case and worth doing, but sequencing it
"before" chunking is not required — they're additive, not ordered dependencies.

---

## 3. Concurrency architecture — options and memory arithmetic

### 3a. Real weight sizes (corrects an in-repo assumption)

The code repeatedly asserts "the model is ~1.2GB"
(`inference-worker.ts:50` comment, `model-cache.ts:5-6,69` comments). **Verified against the
live HuggingFace file listing for `ysdede/parakeet-tdt-0.6b-v2-onnx@main` (fetched during this
review, not a local `file:line`) — that figure understates the actual resident/download size
by roughly 2×:**

| File | Bytes | Used by this app? |
|---|---|---|
| `encoder-model.onnx` (graph only) | 41,770,866 | Yes — always |
| `encoder-model.onnx.data` (fp32 weights, external-data) | 2,435,420,160 | **Yes** — forced fp32 on webgpu, see below |
| `decoder_joint-model.int8.onnx` | 8,998,286 | Yes — `inference-worker.ts:61` explicitly pins `decoderQuant: 'int8'` |
| `vocab.txt` | 10,409 | Yes |
| `encoder-model.fp16.onnx` (1,238,960,452 bytes — this is almost certainly where "~1.2GB" came from) | — | **Not used**: webgpu backend forces fp32, not fp16 |

The fp32 forcing is real and explicit — `encoderQuant` defaults to `'int8'`
(`hub.js:416`), and is overridden:

```js
// node_modules/parakeet.js/src/hub.js:425-429
let encoderQ = encoderQuant;
if (backend.startsWith('webgpu') && encoderQ === 'int8') {
  console.warn('[Hub] Forcing encoder to fp32 on WebGPU (int8 unsupported)');
  encoderQ = 'fp32';
}
```

...and the `'fp32'` quant key maps to the base filename with no suffix
(`QUANT_SUFFIX.fp32 = '.onnx'`, `hub.js:17-21`), which is the small 41 MB graph proto — but
the *weights* live in the companion external-data file, wired in automatically once present
in the repo listing (`hub.js:382-391`, `parakeet.js:206-219`). 2,435,420,160 bytes / 4 bytes
per fp32 param ≈ 609M parameters — consistent with "0.6B" being the whole model's published
size, i.e. essentially the *entire* 0.6B is the encoder; the decoder+joint net is comparatively
tiny (9 MB int8).

**Real per-instance model footprint ≈ 41.8 MB + 2,435.4 MB + 9.0 MB + 0.01 MB ≈ 2.49 GB**
on disk/in the IndexedDB cache. Resident GPU VRAM for the encoder is the same order of
magnitude (fp32 WebGPU buffers ≈ weight size, plus per-inference activation memory that scales
with sequence length — small relative to the static weights for a 30 s window, and not
separately measured here — **estimate**). The decoder's 9 MB sits in ordinary CPU/WASM heap,
not GPU memory.

### 3b. Is a single model instance safe to call concurrently? — No, verified

`ParakeetModel` explicitly reuses per-instance mutable scratch state across calls, by design,
for hot-path performance on the *linear* single-call use case:

```js
// node_modules/parakeet.js/src/parakeet.js:43
// Internal decode buffers are reused aggressively to keep browser hot paths stable without changing public API behavior.
```

Concretely: `_encoderFrameBuffer`/`_encoderFrameTensor` (allocated once, reused every call,
`parakeet.js:736-740`), `_targetIdArray`/`_targetTensor` (`99-102`), `_combState1`/`_combState2`
default LSTM states (`89-91`), and the incremental decode cache `_incrementalCache`
(`109-110`, `769-782`). Two concurrent `transcribe()` calls on the **same** `ParakeetModel`
instance (e.g. via `Promise.all`) would race on these shared buffers — this is a real,
code-verified hazard, not a hypothetical. **A single model instance cannot safely serve two
in-flight chunks at once.** Combined with parakeet.js exposing no API to attach multiple
decoder/joiner sessions to one shared encoder session (`ParakeetModel`'s constructor takes
exactly one `encoderSession` and one `joinerSession`, `parakeet.js:61-64`; `fromUrls`
constructs exactly one of each per call, `267-277`), this rules out a same-instance
"batched/pipelined queue" approach and a "1 shared GPU encoder + pool of decoders" hybrid
**without modifying parakeet.js itself** (out of scope per the read-only constraint on this
task, and not attempted here).

### 3c. Options table

| Option | Safe on this stack today? | Memory for N | GPU parallel benefit | Verdict |
|---|---|---|---|---|
| **A. N workers, each a full independent `ParakeetModel` instance** | **Yes** — each worker has its own encoder+joiner session, no shared mutable state | N × ~2.5 GB (mostly VRAM) | Encoder passes queue/interleave on the one physical GPU (see caveat below); decode loops genuinely run concurrently across N OS threads regardless of GPU | **Recommended** — the only option implementable at the app level without forking the library |
| B. One worker, one model instance, sequential internal queue (dispatch chunks one at a time to the same instance) | Yes (it's just serialization) | ~2.5 GB flat, any N | None — chunks still process one at a time | Not "parallel," but valid as the *fallback*/low-memory mode, and still fixes the §0 correctness bug via chunking alone |
| C. Hybrid: 1 shared GPU encoder session + pool of decoder-only sessions | **No** — parakeet.js's public API bundles encoder+joiner per instance with no split point; would require forking/patching the vendored library | ~2.5 GB + (N-1) × ~9 MB (decoder-only) | Best theoretical memory profile | **Not implementable without modifying source** — flagged, not designed further per task constraints |

**GPU concurrency caveat for option A (estimate, not measured):** issuing N encoder passes
concurrently from N `GPUDevice` objects does not necessarily give N× GPU throughput. A single
0.6B-parameter transformer forward pass over ~375 frames plausibly already occupies a
meaningful fraction of a consumer GPU's compute units for its duration; concurrent submissions
from separate devices are scheduled by the driver and may interleave/time-slice rather than
truly co-execute at full speed. This is workload- and hardware-dependent and cannot be
determined from source — it needs a real profiling run. The practical implication: **expect
the decoder-stage parallelism (genuine, CPU/OS-thread-backed) to be the reliable part of the
win, and treat encoder-stage parallelism as a bonus that may be small-to-nothing on mid-range
GPUs and more real on GPUs with idle headroom** (a high-VRAM/high-SM-count card processing a
comparatively small 0.6B model, e.g. the kind of hardware the project owner may have prior
experience on).

### 3d. Max viable N — memory-gated

Using the real ~2.5 GB per-instance figure against typical Windows 11 target hardware VRAM
tiers (the app already has a capability bucket for this — `gpu-detector.ts:46-49`,
`estimatedVram: 'low' | 'medium' | 'high'` from `adapter.limits.maxBufferSize`, currently
unused for any N-selection logic but a ready integration point):

| VRAM class (illustrative) | N=1 | N=2 | N=3 | N=4 |
|---|---|---|---|---|
| ~4 GB (low-end/integrated) | ~2.5 GB — fits, tight | ~5.0 GB — **does not fit** | — | — |
| ~8 GB (typical mid-range discrete) | fits comfortably | ~5.0 GB — fits | ~7.5 GB — tight, likely contends with OS/browser compositor VRAM use | does not fit |
| ~12 GB | fits | fits | fits | ~10.0 GB — fits, marginal |
| ~24 GB (e.g. RTX 3090) | fits trivially | fits | fits | fits |

**Recommendation: default N=2, gated by `estimatedVram !== 'low'` (fall back to N=1, i.e. the
existing single-worker path, on low-VRAM/integrated hardware); N=3 only as an explicit opt-in
on `estimatedVram === 'high'`.** Given §3c's GPU-concurrency caveat, going beyond N=2–3 mostly
buys memory risk without a correspondingly reliable throughput gain — this is a case where
"more parallelism" stops paying well before VRAM is the binding constraint on high-end cards.

---

## 4. Concrete design

### 4a. Chunk boundaries

Nominal 30 s stride; each dispatched chunk extends ±2 s into neighboring audio where available
(interior chunks cover 34 s: 2 s pre-roll + 30 s payload + 2 s post-roll; the first chunk has
no pre-roll, the last has no post-roll and may be shorter than 30 s payload). This is boundary
*definition* only — the merge workstream owns how the 2 s overlaps get deduplicated/stitched;
this design's obligation is to make sure every chunk message carries enough metadata for that
stage to do its job:

```
chunk { index, startSample, endSample, payloadStartSample, payloadEndSample, timeOffsetS }
```

`timeOffsetS` maps directly onto parakeet.js's existing `opts.timeOffset` parameter
(`parakeet.js:587,625`, already supported by `transcribe()` for exactly this purpose — "Add
this offset to all timestamps"). Request `returnTimestamps: true` per chunk (unlike today's
`false`, `inference-worker.ts:126`) — the merge stage will need word-level timestamps to align
the overlap regions; that's the one piece of today's `transcribe()` call shape that must change
for chunking to be mergeable at all, independent of the merge algorithm itself.

### 4b. Worker pool lifecycle

Replace the single `InferenceOrchestrator` instance in `CaptureApp.tsx` with a pool manager
(`InferenceWorkerPool`) owning N `Worker` instances, each running today's unmodified
`inference-worker.ts` (no worker-side code changes needed — each worker already loads one
independent `ParakeetModel` via `fromHub`). Key lifecycle points:

- **Warm the whole pool once, not per-recording.** `inference-worker.ts:98-102` notes shader
  compilation takes "1–5s" on first WebGPU inference; that cost is paid once per **worker**,
  not per chunk. If the pool were created fresh per recording, N workers would each pay that
  1–5 s cold-start tax on every single recording — unacceptable. Mirror the existing
  eager-init-on-selected-model pattern (`CaptureApp.tsx:95-98`) but for N workers, all
  created and warmed at app-init/model-selection time, staying resident for the app's
  lifetime (same "keep the model loaded between transcriptions" rule already in
  `.claude/rules/stt.md`).
- **Sequence the first worker's cold download; parallelize the rest against a warm cache
  only.** `getModelFile()`'s IndexedDB cache (`hub.js:224-234`) has no write-lock — N workers
  cold-starting simultaneously would race to download and write the same ~2.5 GB blobs
  concurrently, wasting bandwidth and risking a corrupt/partial write under contention (this
  is on top of the pre-existing single-worker gap already flagged in
  `_review/raw/04-webgpu-inference.md`'s P2 finding on cache integrity). Init worker 0 first,
  await its `ready`, then init workers 1..N-1 (their `fromHub` calls will hit a populated
  IndexedDB cache per `hub.js:224-234` and skip the network fetch, but each still pays its own
  session-creation + shader-warmup cost — that part is not shareable across workers with
  parakeet.js's current API).
- **Cap `numThreads` per worker explicitly if COOP/COEP is later fixed.** `fromUrls` accepts
  `cpuThreads` (`parakeet.js:143`, plumbed to `initOrt({ numThreads: cpuThreads })`,
  `parakeet.js:160`); today's `inference-worker.ts` never sets it, so each worker would
  independently default to `navigator.hardwareConcurrency` WASM threads
  (`backend.js:68`) if `SharedArrayBuffer` ever becomes available. With N=2–3 workers each
  grabbing all cores, that's an oversubscription hazard the moment COOP/COEP lands — set
  `cpuThreads: Math.max(1, Math.floor(navigator.hardwareConcurrency / N))` per worker up
  front so the two fixes (COOP/COEP + chunk parallelism) compose safely instead of fighting
  each other for cores.

### 4c. Dispatch, backpressure, single-chunk failure

- Simple FIFO queue of chunk descriptors; a worker pulls the next chunk when it's idle. With
  N=2–3 workers and typically 2–20 chunks for a real recording, this is a trivial pool
  scheduler — no need for priority or fairness logic.
- **Backpressure is implicit and sufficient**: chunks beyond the pool's capacity simply wait in
  the queue; memory cost of queued-but-undispatched chunks is negligible (§5). No explicit
  flow-control needed.
- **A single chunk's failure must not fail the whole transcription.** Mirror the existing
  single-shot retry-once-on-empty pattern (`CaptureApp.tsx:307-311`) at chunk granularity:
  on error or empty result, retry that one chunk once on the same (or, if the worker itself
  errored/hung, a respawned) worker; if it fails twice, emit a `chunk-result` with an
  `error`/`empty` flag and the chunk's `[startSample,endSample]` so the merge stage can
  represent a known, bounded gap rather than silently losing audio or corrupting chunk order.
  This is a protocol-level obligation (the message must carry enough to represent partial
  failure); the merge stage decides how to render a gap.

### 4d. Message protocol changes

Today: `init`→`ready`, `transcribe`→`transcription-result`, single in-flight per worker
enforced by `InferenceOrchestrator.sendMessage()`'s one-pending-listener design
(`inference-orchestrator.ts:145-175`). That per-worker contract **does not need to change** —
each worker in the pool still only ever has one in-flight chunk at a time, which is exactly
what today's `sendMessage` already assumes and correctly implements. What changes is one level
up: the **pool** now fans out N of these single-in-flight conversations concurrently instead of
CaptureApp holding exactly one `InferenceOrchestrator`.

New/changed message shapes (worker-side `inference-worker.ts` needs the request/response
renamed and augmented, not restructured):

```
IN:  { type: 'transcribe-chunk', chunkId, audio, sampleRate, timeOffsetS, returnTimestamps: true }
OUT: { type: 'chunk-result', chunkId, text, words, metrics, error?: string }
```

`chunkId` is the only structurally new field — everything else already exists in some form on
the current `transcribe`/`transcription-result` pair. Transfer `audio` as a `Transferable`
(`postMessage(msg, [audio.buffer])`) rather than structured-cloning it — cheap either way at
these sizes (§5) but transfer avoids an unnecessary copy and is a one-line change at the call
site.

### 4e. Interaction with the existing 60 s safety timeout

Today, `CaptureApp.tsx:271-276` wraps the **entire** transcription (however long the audio) in
one fixed 60 s timer that hard-aborts (terminates) the single worker on expiry. That number was
already living dangerously per `RELEASE-INSTABILITY-GAP-ANALYSIS.md:51`'s own observation that
it "never fired" only because RTF happened to be healthy — it was not designed with any margin
tied to audio length.

Chunking changes the right shape of this safety net:

- **Per-chunk timeout**, sized to the *chunk*, not the whole recording — e.g. 20 s per chunk
  (generous relative to the §1b estimate of ~1–1.5 s expected work per 30 s chunk). On
  expiry, abort and retry just that chunk's worker (§4c), not the whole pool.
- **A pool-level outer watchdog** replaces the flat 60 s: scale it to expected total work,
  e.g. `max(60_000, numChunks * 5_000)` ms, so a legitimately long (up to the existing 600 s
  cap, `CaptureApp.tsx:25`) recording split into ~20 chunks isn't held to the same fixed
  ceiling as a 10 s clip. This is a direct, mechanical fix enabled by chunking — today's
  flat-60s design has no way to reason about "how much work is actually left."
- `orchestratorRef.current.abort()` (today, `inference-orchestrator.ts:132-134`) becomes
  "abort the pool" — terminate all N workers, matching today's philosophy that a timed-out run
  cannot be trusted to self-recover, and the next recording lazily re-inits (from the warm
  IndexedDB cache, so no re-download, only session/warmup cost × N — a real added cost of the
  pool design vs. today's single-worker recovery, worth surfacing to the user as "reconnecting"
  rather than silently eating N × 1–5 s).

---

## 5. Memory cost of the design

**Audio buffers are a rounding error.** Per chunk: 34 s × 16,000 Hz × 4 bytes (34 s payload
window including both 2 s overlaps) = 2,176,000 bytes ≈ 2.08 MiB. Even a generously deep queue
of, say, 10 chunks in flight or queued simultaneously is ~21 MB — negligible next to model
residency. **The dominant, and only consequential, memory cost is model instance residency**
(§3a/§3d): N × ~2.5 GB.

**Peak memory for the recommended N=2:** ~5.0 GB (mostly GPU VRAM for two fp32 encoders, plus
~18 MB CPU-side for two int8 decoders) + negligible audio-buffer overhead (tens of MB). This is
**not** viable next to a naively-assumed "~1.2GB model" (the task brief's own framing, inherited
from the code's stale comment) — it is viable next to the **real** ~2.5 GB figure only on
mid-to-high VRAM hardware (§3d's table: fits on ~8 GB+, does not fit on ~4 GB integrated/low-end
GPUs, where the design must fall back to N=1, i.e. today's architecture unchanged). This VRAM
gating is a hard requirement, not a nice-to-have, and should reuse the existing
`estimatedVram` bucket (`gpu-detector.ts:46-49`) that's already computed but currently unused
for any capacity decision.

---

## 6. Crossover length — when chunking (with or without parallelism) is a loss

**Below roughly one chunk-width (~30–34 s of audio), don't chunk at all** — send it through
unchanged as a single `transcribe()` call, identical to today's path. Reasoning:

- There is nothing to parallelize (one chunk = one chunk), so the pool degenerates to
  "1 worker does 1 unit of work" with strictly more overhead than today's direct call: an
  extra message round-trip, and forfeiting parakeet.js's incremental-mel-caching optimization
  (`prefixSamples`/`_incrementalMel`, `parakeet.js:441-448,592-593`) which only applies to
  **sequential, stateful, same-instance** calls sharing a real audio prefix — not to
  independent chunks dispatched to separate pool workers. That caching claims "~60-70%
  preprocessing savings" per its own doc comment (`parakeet.js:433`); losing it is a real,
  if secondary (preprocessing is a minority of total time per §1a), added cost of any chunked
  design, parallel or not.
- **The library's own long-audio windowing agrees on the general order of magnitude, from the
  opposite direction:** parakeet.js only auto-engages *its* (sequential, non-parallel) windowing
  above 180 s of audio:

  ```js
  // node_modules/parakeet.js/src/long_audio.js:1-5
  const AUTO_WINDOW_THRESHOLD_S = 180;
  const MIN_CHUNK_LENGTH_S = 20;
  const MAX_CHUNK_LENGTH_S = 180;
  const AUTO_CHUNK_LENGTH_S = 90;
  const AUTO_WINDOW_FALLBACK_OVERLAP_S = 10;
  ```

  That threshold is **not** directly transferable to this design (it's calibrated for the
  library's own 90 s chunks / 10 s overlap, and — per §0 — it's already too conservative for
  this app's actual failure mode, which starts degrading around 52–62 s, well under 180 s).
  It's cited here only as corroboration that chunking overhead is a real, acknowledged cost
  the library's own authors also gate behind a minimum-length threshold, not a free action to
  take on every buffer.
- For *genuine parallel* benefit specifically (as opposed to just correctness-safe chunking),
  the crossover is higher still: you need at least two real, independent chunks in flight for
  a pool to have anything to parallelize. At a 30 s stride, that means audio needs to exceed
  roughly **~58–60 s** (first chunk's 30 s payload + enough remaining audio to form a second
  chunk) before N=2 has two genuinely concurrent units of work; below that, a 2-worker pool
  reduces to the same single-chunk case as the paragraph above, just with one worker idle.

**Recommended engagement rule:** single-call path (today's, unchanged) for audio ≤ ~34 s;
chunked-but-effectively-sequential (pool naturally has only 1 chunk to run) for ~34–60 s;
genuine parallel dispatch only kicks in above ~60 s where ≥2 chunks exist simultaneously. This
also happens to line up with §0's correctness motivation — the app should force chunking well
before 180 s regardless of the parallelism question, and ~30 s chunks keep every individual
chunk safely under the ~52–62 s point where solo decode quality starts degrading.

---

## 7. Risks

1. **GPU-stage parallel benefit is unverified and may be small.** §3c's caveat is the central
   uncertainty in this whole design: N concurrent encoder passes on one physical GPU may
   mostly serialize on hardware that's already compute-bound by a single 0.6B-parameter
   forward pass. The decoder-stage parallelism (genuine, OS-thread-backed) is the reliable
   part of the win; do not scope this work assuming the encoder stage also scales N×. Validate
   with a real multi-worker profiling run before committing to a specific N in production.
2. **The "~1.2GB model" assumption is baked into multiple places in the existing codebase**
   (`inference-worker.ts:50`, `model-cache.ts:5-6,69`) and is off by roughly 2× against the
   real ~2.5 GB figure (§3a). Any capacity/VRAM-gating logic (including this design's N-
   selection) must use the corrected number, not the comment's number.
3. **No per-stage timing has ever been captured in this app** (`enableProfiling: false`
   throughout). This whole feasibility analysis is architecture-grounded but not
   hardware-validated. Treat every "expected gain" figure in this doc as provisional until a
   real instrumented run exists.
4. **Cold-start IndexedDB cache race across N workers** (§4b) is a new failure mode this
   design introduces if the sequencing discipline (first-worker-then-rest) isn't followed —
   parakeet.js's cache layer has no write-lock (`hub.js:224-234`), so naively initializing all
   N workers concurrently on a cold cache risks redundant/corrupted downloads.
5. **COOP/COEP's cross-origin-fetch impact on HuggingFace model downloads is unverified.** If
   pursued as a separate fix (§2), `require-corp` COEP mode could break the existing
   `fetch(url)` calls to `huggingface.co` (`hub.js:237`) unless HF's CDN sends
   `Cross-Origin-Resource-Policy`, or the app switches to `credentialless` COEP mode. Must be
   checked against live response headers before shipping — do not assume it "just works."
6. **N-worker teardown/recovery cost is multiplied.** Today's single-worker device-loss/abort
   recovery (`inference-orchestrator.ts:61-70,132-134`) pays a one-worker reload cost. A pool
   pays that N times on a full-pool abort (§4e) — every existing device-loss/timeout finding
   in `_review/raw/04-webgpu-inference.md` (P1/P2 findings on stale ready-state, non-fail-fast
   device loss) is still present per-worker and now needs to compose correctly across the
   whole pool, not just one worker.
7. **Merge-stage dependency not designed here.** This doc defines chunk boundaries and the
   data handed to the merge stage (§4a/§4d) but not the merge algorithm. If the merge
   workstream's needs (e.g. additional per-token fields like `returnFrameIndices`/
   `returnLogProbs`/`returnTdtSteps`, all already supported by `transcribe()`,
   `parakeet.js:614-617`) turn out to require more than word-level timestamps, the message
   protocol in §4d will need another field — cheap to add, but worth confirming with that
   workstream before implementation starts.
