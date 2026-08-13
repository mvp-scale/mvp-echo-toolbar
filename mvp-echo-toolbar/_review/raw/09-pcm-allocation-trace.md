# 09 — PCM Allocation Trace (mic frame → transcription result)

**Method:** this is not a file-by-file review. One data path — the raw audio bytes — is traced
end-to-end across `AudioCapture.ts` → `CaptureApp.tsx` → `inference-orchestrator.ts` →
`inference-worker.ts` → `node_modules/parakeet.js` internals, and back out through the diagnostics
side-path. Every row cites `path:line` with a verbatim excerpt. Anything not directly read is marked
`UNVERIFIED` with what would confirm it. `08-memory-and-hangs.md` already flagged the missing
transfer-list as P1 (`08-P1`) — that finding is confirmed independently below and extended with the
parakeet.js-internal allocations it does not cover (mel buffers, the padded-buffer high-water mark,
the encoder-output transpose).

---

## Allocation ledger

Legend: **T** = recording length in seconds. Sample rate 16 kHz, Float32 (4 B/sample). Frame math
uses the model's documented `subsampling: 8` and a 10 ms (160-sample) hop, i.e. `nFrames ≈ T×100`,
`Tenc ≈ T×12.5`. Encoder hidden dim **D is UNVERIFIED** (not present in any JS config file — it's
baked into the ONNX graph); estimates below use D=1024 as a labeled placeholder. Confirm by logging
`enc.dims` at `parakeet.js:698` on a real run.

| # | Step | File:line | Allocates | Size (f(T)) | Copy/Ref | Released |
|---|------|-----------|-----------|-------------|----------|----------|
| 1 | Worklet quantum capture | `AudioCapture.ts:100-101` | `Float32Array(128)` per 8ms quantum | 512 B × (125×T) messages | Copy (`new Float32Array(ch)`), then **transferred** (zero-copy) via `postMessage(copy,[copy.buffer])` | Ownership moves to main thread each message; no leak |
| 2 | Main-thread chunk buffer | `AudioCapture.ts:459-460` | pushes ref into `pcmChunks[]` | pointer array, ~8 B/entry × 125T entries | Reference only | Cleared at `stopRawRecording` (:570), `cleanup()` (:648), `teardownRawEngine` (:418) |
| 3 | Chunk concatenation | `AudioCapture.ts:563-570` | `rawPcm = new Float32Array(totalLength)` | `T×16000×4` B | **Copy** (necessary — only way to get one contiguous buffer from N transferred chunks) | `pcmChunks=[]` right after (:570) frees the 125T source chunks for GC |
| 4 | Conditional resample | `AudioCapture.ts:594-606` | `AudioBuffer` channel data + `OfflineAudioContext` rendered buffer | up to 2× `T×16000×4` B, transient | Copy ×2 | Only if `ctx.sampleRate !== 16000` (rare — context is requested at 16 kHz); local to the `if` block |
| 5 | Silence trim | `CaptureApp.tsx:17` | `trimmed = audio.slice(...)` | **always** `≈T×16000×4` B (see P1 below — even a no-op trim copies) | Copy | `trimmed` is function-local to `performStop`; GC-eligible once the block exits |
| 6 | Empty-result retry | `CaptureApp.tsx:309` | second `trimSilence(pcm)` call | another `≈T×16000×4` B | Copy | Same lifetime as #5; first `trimmed` may still be reachable when this allocates |
| 7 | Worker postMessage | `inference-orchestrator.ts:173` (via `:105-109`) | structured-clone of `audio` field | `≈T×16000×4` B | **Copy** (no transfer list) | Sender-side `trimmed` NOT neutered — stays live in renderer; worker gets an independent clone |
| 8 | Worker-side `audio` param | `inference-worker.ts:107`, `parakeet.js:600` | the cloned Float32Array | same as #7 | Reference (already a copy from #7) | Local to `transcribe()`; not stored on `model` |
| 9 | Mel padded scratch buffer | `mel.js:451-460` (`this._paddedBuffer`) | `Float64Array(ceil((N+512)×1.2))` | `≈T×16000×1.2×8` B ≈ **2.4×T×16000 B** | Copy of input samples (pre-emphasis writes into it) | **Retained on the `JsPreprocessor` instance for the model's lifetime** — grows-only, never shrinks, freed only on worker dispose/terminate |
| 10 | Raw mel (pre-normalization) | `mel.js:487-503` | `rawMel = new Float32Array(nMels×nFrames)` (no `outBuffer` passed by the single-shot call path) | `128×T×100×4` B ≈ `T×51,200` B | Copy | Local to `computeRawMel`; garbage as soon as `normalizeFeatures` returns |
| 11 | Normalized features | `mel.js:587-596` | `features = new Float32Array(nMels×featuresLen)` | `≈T×51,200` B | Copy | Returned up through `computeFeatures`; held in `transcribe()`'s scope through encoder call |
| 12 | Encoder input tensor | `parakeet.js:673` | `ort.Tensor('float32', features, ...)` | 0 extra (wraps `features`) | Reference at JS level (ORT may copy into WASM/WebGPU memory — out of scope, engine-internal) | `input.dispose()` at :693 |
| 13 | Encoder output → transpose | `parakeet.js:704, 709-726` | `transposed = new Float32Array(Tenc×D)` | `T×12.5×D×4` B (D **UNVERIFIED**, ≈`T×51,200` B if D=1024) | Copy (layout transform `[1,D,T]→[T,D]`, required by the frame-sequential decode loop — not avoidable without restructuring the decoder) | Local to `transcribe()`; retained through the entire decode loop (read every frame) |
| 14 | Per-frame decode buffer | `parakeet.js:104`, `736-739`, `793-794` | `_encoderFrameBuffer = new Float32Array(D)` | `D×4` B (≈4 KB), **allocated once, reused every frame and every call** | `.set(subarray)` copy into a persistent buffer — correct reuse pattern | Lives for the model's lifetime |
| 15 | Joiner logits view | `parakeet.js:367-368` | `tokenLogits = data.subarray(...)` | 0 (view) | **Zero-copy view**, correctly commented "do not mutate without copying" | Backing tensor disposed at :891 each step |
| 16 | Diagnostics WAV encode | `diag.ts:59-76`, called from `CaptureApp.tsx:324` | `new ArrayBuffer(44 + n×2)` | `≈T×16000×2` B (half of Float32 — 16-bit PCM) | Copy | Gated by `--diag`; sent over IPC to main (own clone there, out of scope) |
| 17 | Fallback (non-WebGPU) path | `CaptureApp.tsx:376` | `Array.from(new Uint8Array(audioBuffer))` | webm bytes × (≥4-8× JS number-array overhead) | Copy, boxed-number expansion | Only when orchestrator not ready (fallback engine) — still touches audio bytes, see P2 below |

---

## Peak resident bytes — computation

All figures are the raw-PCM-scaled components only (ledger rows 3, 5-11, 13); they exclude the
constant ~1.2 GB ONNX model weights resident in the worker for the whole session — that's a fixed
baseline, not part of the per-recording delta, and must be added separately for a total-footprint
figure.

**Assumptions stated explicitly:**
- "No-retry" = normal path, one `trimSilence` + one `transcribe` call, prompt GC between phases.
- "Retry" = the empty-result retry (`CaptureApp.tsx:307-311`), which is the failure mode `08-P1`
  already flagged as reaching the worst case.
- D=1024 for the transpose row (**UNVERIFIED** — flagged in the ledger).
- `_paddedBuffer` (row 9) is counted once even under retry — it's grows-only and reused, not
  reallocated on the second call.

| T | Renderer side (pcm + trimmed[, 2nd trimmed]) | Worker side (clone + rawMel + features + padded + transposed) | **No-retry peak** | **Retry peak** |
|---|---|---|---|---|
| 10s | 0.64 + 0.64 = 1.28 MB | 0.64 + 0.51 + 0.51 + 1.54 + 0.51 = 3.71 MB | **~5.0 MB** | **~7.8 MB** |
| 60s | 3.84 + 3.84 = 7.68 MB | 3.84 + 3.07 + 3.07 + 9.22 + 3.07 = 22.27 MB | **~30 MB** | **~44 MB** |
| 600s | 38.4 + 38.4 = 76.8 MB | 38.4 + 30.72 + 30.72 + 92.16 + 30.72 = 222.72 MB | **~300 MB** | **~438 MB** |

At T=600s (the hard cap, `CaptureApp.tsx:25`), a single empty-result retry — the exact failure mode
`03-P0`/`03-P1` (per `08-memory-and-hangs.md`) show is still reachable — pushes the audio-path
transient working set to **~440 MB**, on top of the constant ~1.2 GB model. The single largest
component in that stack, and the one most directly fixable, is the missing transfer list at
`inference-orchestrator.ts:173` (row 7): it alone accounts for a full, avoidable `T×16000×4` B copy
(38.4 MB at T=600s) on every call.

---

### [P1] `trimSilence` always copies, even when nothing is trimmed

- **Where:** `app/renderer/app/CaptureApp.tsx:12-22`
- **What:** `trimSilence` uses `audio.slice(...)`, not `subarray`. When the recording has no
  leading/trailing near-silence (the common case — `start` stays `0`, `end` stays `audio.length-1`),
  the computed slice bounds are `slice(0, audio.length)` — a full copy of an array that needed no
  trimming at all.
- **Evidence:**
  ```ts
  function trimSilence(audio: Float32Array, threshold = 0.004): Float32Array {
    let start = 0, end = audio.length - 1;
    while (start < end && Math.abs(audio[start]) < threshold) start++;
    while (end > start && Math.abs(audio[end]) < threshold) end--;
    const pad = 3200;
    const trimmed = audio.slice(Math.max(0, start - pad), Math.min(audio.length, end + pad + 1));
  ```
- **Cost:** `T×16000×4` B unconditionally, on every recording, whether or not trimming did anything
  (38.4 MB at T=600s). Doubled again on the empty-result retry (`CaptureApp.tsx:309`), which
  recomputes `trimSilence(pcm)` from scratch rather than reusing the first `trimmed`.
- **Fix:** short-circuit when `start === 0 && end === audio.length - 1` (nothing crossed the
  threshold) and return `audio` directly. Separately, reuse the first `trimmed` array on retry
  instead of calling `trimSilence(pcm)` a second time — the retry is about the *model's* result being
  empty, not about the trim being wrong, so recomputing it buys nothing.

---

### [P1] PCM crosses the worker boundary via structured clone, not transfer — confirmed, and the worker-internal cost it triggers is bigger than the boundary copy alone

- **Where:** `app/renderer/app/webgpu/inference-orchestrator.ts:105-109, 173`
- **What:** Same defect `08-memory-and-hangs.md` logged as `08-P1`. Confirmed independently here:
  `postMessage(message)` at line 173 has no second (transfer-list) argument, so the `audio` field
  (the `trimmed` Float32Array) is deep-copied into the worker rather than transferred. Because
  `trimmed` comes from `.slice()` (ledger row 5), it is already a buffer distinct from `pcm` —
  transferring its buffer would be fully safe; `pcm` is only needed later, untouched, for
  `saveDiagAudio` (`CaptureApp.tsx:324`).
- **Evidence:**
  ```ts
  // inference-orchestrator.ts:105-109
  const result = await this.sendMessage(
    { type: 'transcribe', audio: pcm, sampleRate }, 'transcription-result', 120000
  );
  // inference-orchestrator.ts:173
  this.worker.postMessage(message);   // no transfer list
  ```
- **Cost:** `T×16000×4` B copied at the boundary (38.4 MB at T=600s), and this is what feeds directly
  into ledger rows 8-11: the clone becomes the `audio` param that `computeFeatures` immediately turns
  into a further 61.44 MB of mel buffers (rows 10+11) at T=600s. The boundary copy is the trigger for
  the larger downstream allocation, not just an isolated cost.
- **Fix:** `this.worker.postMessage(message, [message.audio.buffer])` (guard for the case where
  `audio` is absent, e.g. the `init`/`dispose` messages). Contrast with the worklet's own
  `postMessage(copy, [copy.buffer])` at `AudioCapture.ts:101`, which already does this correctly —
  the pattern exists in this codebase, it's just not applied at the orchestrator boundary.

---

### [P2] The mel preprocessor's scratch buffer is a permanent high-water mark, not released between recordings

- **Where:** `node_modules/parakeet.js/src/mel.js:388-392, 451-460`
- **What:** `JsPreprocessor._paddedBuffer` (a `Float64Array`) is allocated lazily and grows to fit
  the longest audio seen, per the explicit comment `// Pre-allocate reusable buffers`. It is never
  shrunk and never freed except when the whole model/worker is disposed. One 600s recording leaves a
  **~92 MB** `Float64Array` resident on the model instance for the rest of the warm-worker's life,
  even if every subsequent recording is 10 seconds.
- **Evidence:**
  ```js
  // mel.js:451-460
  const pad = N_FFT >> 1;
  const paddedLen = N + 2 * pad;
  let paddedWasReallocated = false;
  if (!this._paddedBuffer || this._paddedBuffer.length < paddedLen) {
    const newSize = Math.ceil(paddedLen * 1.2);
    this._paddedBuffer = new Float64Array(newSize);
    paddedWasReallocated = true;
  }
  ```
- **Cost:** `≈T_max×16000×1.2×8` B, where `T_max` is the longest recording since the worker started
  (or last `dispose()`/abort). At T=600s that's ~92 MB retained indefinitely. This is a deliberate
  perf tradeoff by the library (avoid realloc), not a bug in the library's own terms — but it is a
  genuine "stays reachable after no longer needed" finding for this app's usage pattern (bursty,
  variable-length recordings on a long-lived warm worker), and it compounds with `08-P0`#1's
  unbounded-reinit-loop finding: each reinit creates a **fresh** `ParakeetModel` (and thus a fresh,
  initially-small `_paddedBuffer`), so the 92 MB is not itself unbounded across reinits — it resets —
  but within one warm session it is a one-way ratchet keyed to the single longest recording.
- **Fix:** none needed for correctness. If the 92 MB floor at idle is undesirable, `resetMelCache()`
  (already called before every transcription, `inference-worker.ts:117`) would need to be extended to
  also null `_paddedBuffer` when idle beyond some threshold — a library-side change, out of this
  app's control short of forking. Documenting the tradeoff is the actionable step here.

---

### [P2] Encoder-output transpose is a full, unavoidable copy — sizing it exposes the true worker-side peak

- **Where:** `node_modules/parakeet.js/src/parakeet.js:697-731`
- **What:** The encoder returns `[1, D, Tenc]`; the frame-sequential decode loop needs `[Tenc, D]`
  row-major access per frame, so `transposed = new Float32Array(Tenc * D)` is allocated and filled
  with a manually-unrolled loop. This is a legitimate, necessary transform (not a lazy-copy mistake —
  the comment even notes it's benchmark-driven), but it is the largest single transient buffer in the
  decode phase and was not visible from the app-level files alone.
- **Evidence:**
  ```js
  // parakeet.js:704-731
  transposed = new Float32Array(Tenc * D);
  const encData = enc.data;
  for (let t = 0; t < Tenc; t++) {
    const tOffset = t * D;
    ...
  }
  ...
  enc.dispose?.();
  ```
- **Cost:** `Tenc×D×4` B. With `Tenc≈T×12.5` and D **UNVERIFIED** (placeholder 1024): ≈`T×51,200` B,
  i.e. ~30.7 MB at T=600s — retained for the full duration of the decode loop (which can run for
  thousands of steps on a 10-minute recording), concurrently with `features` (row 11, still in scope
  though unread after `input` is built) and the still-resident `_paddedBuffer` (P2 above).
- **Fix:** none — this is correct as written. Recorded here so the peak-bytes computation is
  traceable to real code rather than asserted. To pin down D precisely: log `enc.dims` at
  `parakeet.js:698` on one real transcription and report back.

---

### [P3] Worklet message churn: 125 small Float32Array allocations/sec, uncoalesced

- **Where:** `app/renderer/app/audio/AudioCapture.ts:96-104`
- **What:** Each 128-sample (8 ms) render quantum allocates and transfers its own `Float32Array(128)`
  (512 B). At T=600s that's 75,000 discrete small-object allocations/transfers over the recording —
  correct in pattern (transferred, not cloned — see the positive contrast in the P1 fix above) but
  high in count. Each message also triggers a JS event-loop tick and array-push on the main thread
  (`AudioCapture.ts:459-460`).
- **Evidence:**
  ```js
  // AudioCapture.ts:96-104
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length > 0) {
      const copy = new Float32Array(ch);
      this.port.postMessage(copy, [copy.buffer]); // transfer, avoid clone
    }
    return true;
  }
  ```
- **Cost:** No memory growth (each transfer moves ownership, no accumulation) — this is pure
  allocation/GC *churn*: 125 allocations/sec × up to 600s = 75,000 short-lived objects and 75,000
  `postMessage` round-trips per long recording, versus e.g. 16 batched postings/sec if 8 quanta were
  coalesced before posting.
- **Fix:** optional — batch N quanta (e.g. 8 → ~64 ms) into one buffer before `postMessage` if
  profiling shows worklet-thread or main-thread GC pauses during long recordings. Not urgent: the
  per-message payload is tiny and the pattern is otherwise correct (already transferred, not cloned).

---

### [P3] Fallback (non-WebGPU) path expands audio bytes into a boxed-number JS array

- **Where:** `app/renderer/app/CaptureApp.tsx:376`
- **What:** When the WebGPU orchestrator isn't ready, the standard `MediaRecorder`/webm path sends
  audio to the main process via `Array.from(new Uint8Array(audioBuffer))` — converting each byte into
  a full JS array element before IPC.
- **Evidence:**
  ```ts
  const audioArray = Array.from(new Uint8Array(audioBuffer));
  const result = await electronAPI.processAudio(audioArray, { ... });
  ```
  (Electron's `ipcRenderer.invoke` uses the structured clone algorithm and can pass an `ArrayBuffer`
  or typed array directly — the intermediate `Array.from` conversion is not required for IPC
  transport. **UNVERIFIED**: would need to confirm the `processAudio` IPC handler signature in
  `app/main/main-simple.js` accepts a typed array/ArrayBuffer without a shape change, which is outside
  this trace's file set.)
- **Cost:** webm is compressed (not raw PCM — much smaller than the WebGPU path's 38.4 MB/10min
  figure), but V8 typically represents a packed small-integer array at several bytes per element
  (vs. 1 byte in the source `Uint8Array`), so this is a several-times expansion on whatever the webm
  blob size is. Lower priority than the WebGPU-path findings above because this is the fallback
  engine, only exercised when the orchestrator isn't ready, but it is squarely on the "audio bytes"
  path this trace was scoped to.
- **Fix:** send `new Uint8Array(audioBuffer)` (or the `ArrayBuffer` itself) directly through
  `electronAPI.processAudio`, dropping the `Array.from` conversion, contingent on confirming the main
  process handler accepts it as-is.

---

## Per-recording reset hygiene (positive finding)

Contrary to the possibility flagged in the task brief, `pcmChunks` **is** reset between recordings —
three times over, defensively: `stopRawRecording()` (`AudioCapture.ts:570`), `cleanup()`
(`AudioCapture.ts:648`), and `teardownRawEngine()` (`AudioCapture.ts:418`). No cross-recording
accumulation was found in `pcmChunks`, `ids`, `tokenTimes`, `tokenConfs`, or any of the per-call
arrays inside `parakeet.js`'s `transcribe()` — they are all function-local and released each call.
The one real cross-recording accumulator is the `_paddedBuffer` high-water mark (P2 above), which
grows but does not leak (it's a single reused buffer, not an unbounded collection).

## Summary of severities

- P0: none found in this trace (the two P0s in this area are already logged in `08-memory-and-hangs.md`).
- P1 ×2: `trimSilence` unconditional copy; missing `postMessage` transfer list (confirms `08-P1`, extends its downstream cost).
- P2 ×2: `_paddedBuffer` high-water mark (library-internal, permanent-until-dispose); encoder-output transpose sizing (correct-but-costly, now quantified).
- P3 ×2: worklet message churn (75,000 small allocations per 600s recording); `Array.from(Uint8Array)` expansion on the fallback path.
