# Audio Buffer Correctness Audit

Scope: `app/renderer/app/audio/AudioCapture.ts`, `app/renderer/app/CaptureApp.tsx`,
`app/renderer/app/diag.ts`, cross-checked against `node_modules/parakeet.js/src/*`.
Read-only; every claim below cites `file:line` with a verbatim excerpt.

## Buffer-operation table

| Operation | file:line | Input shape | Output shape | Correct? | Note |
|---|---|---|---|---|---|
| Worklet quantum copy | `AudioCapture.ts:99-102` | `Float32Array` view onto audio-thread's per-quantum buffer, len ≤128 | fresh owned `Float32Array`, same len | **Yes** | `new Float32Array(ch)` allocates a new buffer and copies values; the copy's own (not the reused) buffer is what gets transferred. Not the reused-view bug. |
| Worklet → main postMessage | `AudioCapture.ts:101` | fresh copy from above | same, ownership transferred | **Yes** | `postMessage(copy, [copy.buffer])` transfers the *copy's* buffer, never the audio thread's reused backing store. No aliasing possible. |
| pcmChunks push | `AudioCapture.ts:457-460` | one `Float32Array` per worklet message | array of distinct buffers | **Yes** | Each `chunk` is a distinct allocation (see above); no shared backing store between chunks. |
| Silent channel-data drop | `AudioCapture.ts:98-99` | `inputs[0][0]` possibly absent/empty | no message posted for that quantum | **Unverified / latent** | Samples for a quantum where `ch` is falsy or `length===0` are dropped with **no placeholder**, so before/after audio gets spliced together with no gap marker. See [P2]. |
| Concatenation | `AudioCapture.ts:563-570` | N chunks, total `totalLength` samples | one `Float32Array(totalLength)` | **Yes** | `reduce` sums exact lengths; `set(chunk, offset)` with `offset += chunk.length` — no drop, no double-count, no off-by-one. Empty `pcmChunks` → `totalLength=0` → valid empty array, no crash. |
| Peak/min/max/RMS scan | `AudioCapture.ts:575-586` | `rawPcm` (**pre**-resample) | scalars | **Partially** | Computed on `rawPcm`, not on the `pcm` actually returned/transcribed when the resample branch runs. See [P3-1]. |
| Resample (fallback path) | `AudioCapture.ts:590-610` | `rawPcm` len L at rate R (R≠16000) | `Float32Array` len `ceil((L/R)*16000)` | **Yes** | `OfflineAudioContext(1, outputLength, 16000).startRendering()` renders exactly `outputLength` frames; `getChannelData(0)` is exactly that length. No truncation. |
| Returned sampleRate tag | `AudioCapture.ts:627` | — | `sampleRate: RAW_PCM_SAMPLE_RATE` (constant 16000) | **Yes** | Always 16000 regardless of branch taken — correct in both cases because the resample branch actually produces true-16kHz data; the non-resample branch is already 16kHz. |
| `trimSilence` bidirectional scan + pad | `CaptureApp.tsx:12-22` | `Float32Array` len L | `Float32Array` len ∈ [1, L] (or original on fallback) | **Yes, with one latent edge case** | Never negative length, never exceeds L, never empty for L≥1. See [P3-2] for the fully-silent-buffer asymmetry (harmless in practice). |
| `trimSilence` sample-rate assumption | `CaptureApp.tsx:16,20` | — | — | **Latent** | `pad=3200`/`4800` are magic numbers hardcoded to 16kHz with no sample-rate parameter or assertion. See [P3-3]. |
| WAV header/body encode | `diag.ts:59-76` | `Float32Array` len n, rate `sampleRate` | `ArrayBuffer` len `44+2n` | **Yes** | RIFF/data chunk sizes, byteRate, blockAlign all arithmetically consistent; int16 clamp is asymmetric-correct (`*0x8000` neg / `*0x7fff` pos), no overflow at ±1.0. |
| Worker hand-off (main→worker) | `inference-orchestrator.ts:173` | `pcm`/`trimmed` Float32Array | — | **Yes (copy, not transfer)** | `postMessage(message)` has no transfer list, so it's a structured-clone **copy**. Main thread's buffer is untouched after the call — no cross-thread aliasing risk, at the cost of one extra copy. |

## Findings

### [P2] Worklet silently drops a quantum's samples when no channel data is present — no gap marker
- **Where:** `app/renderer/app/audio/AudioCapture.ts:97-104`
- **What:** The worklet's `process()` only forwards a chunk when `ch && ch.length > 0`. If a render quantum arrives with no connected/populated channel 0 (e.g. a momentary graph reconfiguration, device transition, or a startup quantum before the source is fully wired), that quantum is **dropped outright** — not zero-filled, not marked. The concatenation step (`AudioCapture.ts:563-570`) has no knowledge this happened; it simply stitches the sample immediately before the gap to the sample immediately after it.
- **Evidence:**
```js
process(inputs) {
  const ch = inputs[0] && inputs[0][0];
  if (ch && ch.length > 0) {
    const copy = new Float32Array(ch);
    this.port.postMessage(copy, [copy.buffer]); // transfer, avoid clone
  }
  return true;
}
```
- **Failing input (hypothetical, matches the user's "splicing" suspicion):** if quanta 100 and 102 are posted normally (128 samples each) but quantum 101 is skipped because `inputs[0][0]` was momentarily absent, `pcmChunks` contains 256 real samples with an 128-sample (8ms @16kHz) discontinuity spliced invisibly between them — a click/warp with zero trace in `workletMsgCount` (it only counts *delivered* messages, not attempted quanta) or in the diagnostic WAV filename/metadata.
- **Status:** UNVERIFIED that `inputs[0][0]` actually goes empty/undefined during a normal *connected, live* `MediaStreamAudioSourceNode → AudioWorkletNode` graph on Chromium — per spec/typical implementation a connected source delivers 128 samples (silence-filled, not absent) every quantum, so this branch is likely a defensive no-op in steady state. **Confirming test:** log `workletMsgCount` alongside `performance.now()` deltas during a recording and compare expected quanta (`elapsed_ms / (128/sampleRate*1000)`) vs actual messages received; also visually/audibly inspect `saveDiagAudio` WAVs from a recording spanning a Bluetooth-codec switch or device hot-swap for clicks at the seam.

### [P3-1] Diagnostic peak/min/max/RMS reflect pre-resample audio, not the buffer actually transcribed
- **Where:** `app/renderer/app/audio/AudioCapture.ts:575-586` (stats computed) vs `588-610` (resample) vs `627` (return)
- **What:** `peak`/`rms` are computed once, over `rawPcm`, *before* the resample branch. When `rate !== RAW_PCM_SAMPLE_RATE`, the function still returns those pre-resample stats alongside the post-resample `pcm` buffer that's actually sent to the model and saved to WAV (`CaptureApp.tsx:290,302,319,324`).
- **Evidence:**
```js
let peak = 0, min = 0, max = 0, sumSq = 0;
for (let i = 0; i < rawPcm.length; i++) { /* ... computed on rawPcm ... */ }
...
if (rate !== RAW_PCM_SAMPLE_RATE && rawPcm.length > 0) {
  ...
  pcm = rendered.getChannelData(0);
} else {
  pcm = rawPcm;
}
...
return { pcm, sampleRate: RAW_PCM_SAMPLE_RATE, peak, rms, diag };
```
- **Impact:** Cosmetic/diagnostic only — the returned `pcm` audio itself is correct and unaffected; only the logged/filename-embedded `rms`/`peak` values can be slightly stale versus the actual transcribed buffer when the resample fallback fires (i.e. when the browser doesn't honor a 16kHz `AudioContext`). Low real-world frequency since Chromium generally does honor `{sampleRate:16000}`.
- **Fix:** Recompute (or additionally compute) peak/rms from `pcm` after the resample branch, or compute once after `pcm` is finalized.

### [P3-2] `trimSilence` collapses to the last index (not a symmetric shrink) for a fully-silent buffer
- **Where:** `app/renderer/app/CaptureApp.tsx:12-22`
- **What:** The two `while` loops are independent and only bound each other via `start<end`/`end>start`. For an all-below-threshold buffer, the first loop runs `start` all the way up to `audio.length-1` (stopping on the boundary check, not the threshold check); the second loop's guard `end>start` is then already false, so `end` never moves from its initial `audio.length-1`. Net effect: `start===end===audio.length-1` — the window collapses to the **last** sample, not e.g. the middle.
- **Evidence:**
```js
let start = 0, end = audio.length - 1;
while (start < end && Math.abs(audio[start]) < threshold) start++;
while (end > start && Math.abs(audio[end]) < threshold) end--;
const pad = 3200;
const trimmed = audio.slice(Math.max(0, start - pad), Math.min(audio.length, end + pad + 1));
if (trimmed.length < 4800 && audio.length >= 4800) return audio;
return trimmed;
```
- **Concrete arithmetic:** For an all-silent buffer of length L, `trimmed.length = min(L, 3201)` and the window is `audio.slice(max(0, L-3201), L)` — i.e. it keeps only the **tail**, discarding up to `L-3201` leading samples.
  - `L ≥ 4800`: `trimmed.length` is capped at 3201, which is `<4800`, so the `<4800 && ≥4800` fallback fires and the **original full buffer** is returned instead — no loss.
  - `L < 3201`: `max(0, L-3201)=0`, so `trimmed` is the entire buffer anyway — no loss.
  - `3201 ≤ L < 4800`: fallback does *not* fire (`audio.length<4800`); the function returns only the last 3201 samples, discarding up to 1598 leading samples. Since the whole buffer is below the silence threshold by construction of this case, the discarded samples are themselves silence/near-silence — no perceptible audio is lost, but the trim result is asymmetric/tail-biased rather than centered.
- **Severity:** P3 — never crosses into corruption, misalignment relative to *content* (there is none to misalign, by construction of the all-silent case), or empty output; purely a latent asymmetry in a pathological input class that the fallback already neutralizes for the size range that matters (≥4800 samples, i.e. ≥0.3s).
- **Fix (optional hardening):** change the boundary conditions to `start <= end` scanning independently from both ends without cross-gating on the other's current position, or special-case "buffer entirely below threshold" up front.

### [P3-3] `trimSilence` hardcodes 16kHz-derived constants with no sample-rate parameter
- **Where:** `app/renderer/app/CaptureApp.tsx:16,20`
- **What:** `pad = 3200` ("200ms at 16kHz") and the `4800` fallback threshold ("<0.3s") are magic numbers baked in assuming the input is always 16kHz. `trimSilence(audio: Float32Array, threshold = 0.004)` takes no sample-rate argument and never validates one.
- **Evidence:**
```js
const pad = 3200; // 200ms at 16kHz
const trimmed = audio.slice(Math.max(0, start - pad), Math.min(audio.length, end + pad + 1));
if (trimmed.length < 4800 && audio.length >= 4800) return audio; // <0.3s → original
```
- **Why it's currently safe:** every call site passes `pcm` from `AudioCapture.stopRawRecording()`, which is contractually always 16kHz (verified above — native or resampled, `sampleRate` returned is always `RAW_PCM_SAMPLE_RATE`). The invariant holds today.
- **Risk:** if a future call site ever passes non-16kHz audio (or the resample-rate contract in `AudioCapture.ts` regresses), `trimSilence` would silently apply the wrong pad duration (e.g. at 48kHz, 3200 samples = 66ms, not 200ms) with no error — a correctness bug with no runtime signal.
- **Fix:** thread `sampleRate` into `trimSilence` and derive `pad`/fallback threshold from it, or assert the expected rate.

### [P4 / non-issue, documented for completeness] Dead `workletNode` field
- **Where:** `app/renderer/app/audio/AudioCapture.ts:26, 643-647`
- **What:** `private workletNode?: AudioWorkletNode;` is declared and defensively torn down in `cleanup()`, but is **never assigned** anywhere in the file (the actual raw-PCM path uses `rawWorklet`, a separate field). No functional impact — purely dead code / minor maintenance-confusion risk, not a buffer bug.
- **Evidence:** `grep -n "workletNode\b" app/renderer/app/audio/AudioCapture.ts` returns only the declaration and the cleanup references — no assignment site.

## Cross-checks that came back clean (no bug found)

- **Aliasing (item 5):** `grep -n "subarray\|\.slice(\|new Float32Array(" ` across all three audited files shows **zero** uses of `subarray()` (view creation) anywhere in the raw-PCM path. Every array derivation is either `new Float32Array(...)` (fresh allocation) or `.slice()` (`TypedArray.prototype.slice` — a real copy, not a view, per spec). There is no code path where a view and a copy of the same backing buffer coexist and one write could corrupt what the other reads.
- **Worker hand-off:** `inference-orchestrator.ts:173` (`this.worker.postMessage(message)`) passes no transfer list, so `pcm`/`trimmed` are structured-clone **copied** to the worker, not transferred. The main thread's buffer remains valid and independent after the call — ruling out a class of "renderer reuses buffer while worker still reads it" bugs, at a (correctness-irrelevant) performance cost of one extra copy per transcription.
- **Sample-rate consistency (item 6):** Every consumer of `pcm`/`sampleRate` in `CaptureApp.tsx` (lines 290-324) uses the *same* `sampleRate` value returned alongside `pcm` from `stopRawRecording()` — `orchestratorRef.current.transcribe(trimmed, sampleRate)` and `saveDiagAudio(..., pcm, sampleRate)` never diverge. `diag.ts`'s `encodeWav` writes that same `sampleRate` into the WAV header (`diag.ts:66`), so the WAV is self-consistent with the data it contains.
- **Format / double-normalization (item 7):** `node_modules/parakeet.js/src/preprocessor.js:80` and `mel.js:418` both document the expected input as "Normalised mono PCM [-1,1] at 16 kHz" — i.e. plain Web Audio float samples, which are inherently in that range by the platform's own representation. No explicit gain/normalization step exists anywhere in `AudioCapture.ts` or `CaptureApp.tsx`; `autoGainControl: true` (`AudioCapture.ts:323`) is the *only* level adjustment, applied once at capture by the OS/browser, not reapplied or stacked by app code.
- **parakeet.js's own sample-rate handling (context, not a bug in this codebase):** `parakeet.js:436` (`computeFeatures`) and `preprocessor.js:83`/`mel.js:421` (`process(audio)`) take **no sample-rate argument at all** for feature extraction — the mel filterbank/window sizes are hardcoded to 16kHz internally, and the `sampleRate` parameter on `model.transcribe()` is used only for duration bookkeeping (`parakeet.js:671`), not resampling or validation. This means parakeet.js has **no internal safety net** if ever handed genuinely non-16kHz audio while told it's 16kHz — correctness fully depends on the caller (this app) being right, which the trace above confirms it is.
