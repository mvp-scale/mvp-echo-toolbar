# Overlap-Stitch Correctness Design — Chunked Parakeet Transcription

Scope: correctness of merging N overlapping chunk transcriptions into one transcript. Parallel
execution architecture (how chunks are scheduled/run) is owned by a separate design; this document
treats chunk *results* as an input (arriving in any completion order, consumed here in chunk-index
order) and is otherwise read-only against `node_modules/parakeet.js@1.4.4` and the current app code.

---

## 1. What the model actually returns

### 1.1 `transcribe()` result shape

`ParakeetModel.transcribe(audio, sampleRate, opts)` — full option list and result shape:

`node_modules/parakeet.js/src/parakeet.js:600-623`
```js
async transcribe(audio, sampleRate = 16000, opts = {}) {
    const {
      returnTimestamps = false,
      returnConfidences = false,
      temperature = 1.0, // Greedy decoding (1.0) is better for ASR than sampling (1.2)
      debug = false,
      enableProfiling = true,
      skipCMVN = false,
      frameStride = 1,
      previousDecoderState = null,
      returnDecoderState = false,
```

Default (`{}`) returns `{ utterance_text, words: [], metrics, is_final }` — no timestamps, no
confidences, no token IDs. Everything needed for merging is **opt-in**:
`returnTimestamps`, `returnConfidences`, `returnTokenIds`, `returnFrameIndices`, `returnLogProbs`,
`returnTdtSteps` (`node_modules/parakeet.js/src/parakeet.js:613-621`, README table at
`node_modules/parakeet.js/README.md:174-190`). With `returnTimestamps`/`returnConfidences` both on,
the full shape is (`node_modules/parakeet.js/src/parakeet.js:1075-1122`):

```js
1075	    const result = {
1076	      utterance_text: text,
1077	      words,
1078	      tokens: tokensDetailed,
1079	      confidence_scores: returnConfidences ? {
1080	        token: tokenConfs.map(c => +c.toFixed(4)),
1081	        token_avg: +avgTokenConf?.toFixed(4),
1082	        word: words.map(w => w.confidence),
1083	        word_avg: +avgWordConf?.toFixed(4),
```

Plus opt-in `decoderState`, `tokenIds`, `frameIndices`, `logProbs`, `tdtSteps` when requested.

### 1.2 Timestamps — yes, but derived, discrete, and off by default

**`returnTimestamps` exists and is usable (YES)**, at word and token granularity. Units are
**seconds**, computed from a fixed **encoder frame stride** (not a continuous alignment model):

`node_modules/parakeet.js/src/parakeet.js:538-540`
```js
  getFrameTimeStride() {
    return this.subsampling * this.windowStride;
  }
```
with defaults `subsampling = 8`, `windowStride = 0.01` (`node_modules/parakeet.js/src/parakeet.js:61`),
and `windowStride` grounded in the mel front-end's actual hop:
`node_modules/parakeet.js/src/mel.js:31-34` — `SAMPLE_RATE = 16000`, `HOP_LENGTH = 160` (10 ms).
**Frame stride = 8 × 0.01 = 0.08 s (80 ms).** This is the quantization floor for every timestamp
the library emits — no sub-frame interpolation.

Per-token start/end is built directly from the frame index and the TDT duration-predictor's step
count, not an independent forced aligner:

`node_modules/parakeet.js/src/parakeet.js:909-916`
```js
        if (returnTimestamps) {
          const durFrames = step > 0 ? step : 1;
          const endFrame = Math.min(Tenc, t + Math.max(1, durFrames));
          const start = effectiveTimeOffset + (t * TIME_STRIDE);
          const end = effectiveTimeOffset + (endFrame * TIME_STRIDE);
          tokenTimes.push([start, end]);
        }
```
Word timestamps are just the first/last token's start/end accumulated while walking the `▁`-marked
token stream (`node_modules/parakeet.js/src/parakeet.js:1041-1052`). Bottom line: timestamps are
real and directly usable for merging, but **coarse (≥80 ms grid) and dependent on the TDT duration
predictor's own accuracy** — treat them as a strong hint for alignment, not ground truth to the
millisecond.

### 1.3 Confidence scores — per-token and per-word, both usable for arbitration

`confidence_scores` (when `returnConfidences: true`) is **not** limited to the two fields the app
currently reads. Full detailed shape:

`node_modules/parakeet.js/src/parakeet.js:1079-1087`
```js
      confidence_scores: returnConfidences ? {
        token: tokenConfs.map(c => +c.toFixed(4)),
        token_avg: +avgTokenConf?.toFixed(4),
        word: words.map(w => w.confidence),
        word_avg: +avgWordConf?.toFixed(4),
        frame: frameConfs.map(f => +f.toFixed(4)),
        frame_avg: frameConfs.length ? +(frameConfs.reduce((a, b) => a + b, 0) / frameConfs.length).toFixed(4) : null,
        overall_log_prob: +overallLogProb.toFixed(6)
      } : { overall_log_prob: null, frame: null, frame_avg: null },
```
So `token`/`word` (per-item arrays) exist alongside the `*_avg` scalars the app currently reads —
`app/renderer/app/webgpu/inference-worker.ts:136` (`scores?.word_avg ?? scores?.token_avg`) only
uses the averages; the per-token/per-word arrays are already computed and available for
seam arbitration without extra cost. Each `confVal` is the softmax probability of the *chosen*
(argmax) token under the model's own distribution at that decode step:

`node_modules/parakeet.js/src/parakeet.js:874-876`
```js
        confVal = 1 / sumExp;
        // Log probability: log(softmax(logit)) = logit - log(sum(exp(logits)))
        logProbVal = (maxLogit * invTemp) - maxVal - Math.log(sumExp);
```
Uncalibrated, but valid for *relative* comparison between two candidate decodes of the same audio
— exactly what overlap arbitration needs.

### 1.4 TDT-specific alignment aids — token IDs, frame indices, duration steps

The joiner's output tensor is split into vocabulary logits and duration logits:

`node_modules/parakeet.js/src/parakeet.js:367-368`
```js
    const tokenLogits = data.subarray(0, vocab);
    const durLogits = data.subarray(vocab, totalDim);
```
`step = argmax(durLogits)` (`node_modules/parakeet.js/src/parakeet.js:382-386`) is the TDT duration
prediction — how many encoder frames to advance after emitting this token — and it drives both the
frame-advance loop (`parakeet.js:929-935`) and the timestamp `end_time` above. Opt-in outputs expose
all of this per-token: `returnTokenIds` (raw vocab IDs), `returnFrameIndices` (which encoder frame
emitted each token), `returnLogProbs` (raw log-prob), `returnTdtSteps` (the duration step itself) —
`node_modules/parakeet.js/src/parakeet.js:614-621`. These four together are strictly more precise
and cheaper to compare than raw text: token IDs are exact-integer comparable, frame indices give a
time position without the 3-line word-accumulation logic, and log-probs feed arbitration directly.

### 1.5 The library already ships two overlap mergers — read before designing one

`parakeet.js` exports **`FrameAlignedMerger`** and **`LCSPTFAMerger`**, purpose-built for exactly
this problem (merging overlapping chunk transcriptions using token IDs + frame indices), and both
are public API:

`node_modules/parakeet.js/src/index.js:5`
```js
export { ParakeetModel, StatefulStreamingTranscriber, FrameAlignedMerger, LCSPTFAMerger } from './parakeet.js';
```

**`LCSPTFAMerger`** (LCS + Probabilistic Token-Frame Alignment) is the stronger of the two: longest
common *substring* on token-ID sequences, frame-index verification of the match, log-prob
arbitration when the match is weak, and a Gaussian "vignette" weight that de-prioritizes tokens near
a chunk's own edges:

`node_modules/parakeet.js/src/parakeet.js:1879-1909`
```js
    // === STEP 1: NeMo-style LCS on token IDs ===
    const X = this.pendingTokens.map(t => t.id);
    const Y = overlapTokens.map(t => t.id);
    const [startX, startY, lcsLength] = this._lcsSubstring(X, Y);
    // === STEP 2: PTFA Enhancement - Verify frame alignment ===
    let anchorValid = false;
    if (lcsLength >= this.K) {
      anchorValid = this._verifyFrameAlignment(...);
    }
    if (anchorValid) {
      const confirmEnd = startX + lcsLength;
      this.confirmedTokens.push(...this.pendingTokens.slice(0, confirmEnd));
    } else if (lcsLength > 0) {
      const bestPath = this._arbitrateByLogProb(pathA, pathB);
```
When no anchor is found at all, the built-in fallback is:

`node_modules/parakeet.js/src/parakeet.js:1906-1909`
```js
    } else {
      // No overlap found - possible discontinuity, confirm all pending
      this.confirmedTokens.push(...this.pendingTokens);
    }
```
**This default fallback is important and, read carefully, has a gap** (see §2.2/§3): it always
keeps the *earlier* chunk's (`pendingTokens`) version of the disputed region and silently discards
the *later* chunk's overlap tokens (`overlapTokens` are only ever used for matching, never
committed on the no-anchor path). If the earlier chunk is the one that's empty/wrong (the app's
known intermittent bug), this default would keep nothing and drop the later chunk's good content.
The design in §2 builds a thin health-gate wrapper around this class rather than reimplementing it.

`FrameAlignedMerger` is a simpler stability-count merger (require a token to reappear across N
overlapping calls before confirming it) — designed more for continuous streaming with heavy
re-decoding of the same span than for a fixed 4-second double-buffer; not used as the primary
choice here (see §2 for why).

### 1.6 The library's own long-audio chunker — evidence, not something we call directly

`transcribeLongAudioWithChunks` (`node_modules/parakeet.js/src/long_audio.js`) is the library's
*sequential*, adaptive-window long-form helper. It is not directly reusable for "fixed 30 s chunks,
transcribed in parallel" (its whole algorithm depends on knowing the previous window's output before
choosing the next window's start — see `runAutoSentenceWindowing`,
`node_modules/parakeet.js/src/long_audio.js:343-419`), but it is valuable evidence about what this
library's own authors consider a safe operating point:

`node_modules/parakeet.js/src/long_audio.js:1-9`
```js
const AUTO_WINDOW_THRESHOLD_S = 180;
const MIN_CHUNK_LENGTH_S = 20;
const MAX_CHUNK_LENGTH_S = 180;
const AUTO_CHUNK_LENGTH_S = 90;
const AUTO_WINDOW_FALLBACK_OVERLAP_S = 10;
```
Their blind-fallback overlap (used only when no natural pause is found to cut on) is **10 seconds**
— 5× the 2 s proposed here — and their primary strategy is not fixed overlap at all, it's cutting at
detected pauses (`relocateCursorToNearbyGap`, `node_modules/parakeet.js/src/long_audio.js:318-341`)
plus text-level word dedup (`dedupeMergedWords`, `node_modules/parakeet.js/src/long_audio.js:138-164`,
keeps whichever duplicate word has the longer measured duration). This is direct in-repo evidence
used in §4's overlap-sizing verdict, not a library capability we invoke.

### 1.7 Punctuation and casing are ordinary vocabulary tokens — not a separate pass

The tokenizer is SentencePiece-style; `▁` marks a word start, decode just concatenates sanitized
tokens and normalizes whitespace by regex:

`node_modules/parakeet.js/src/tokenizer.js:63-86`
```js
  decode(ids) {
    const tokens = [];
    for (const id of ids) {
      if (id === this.blankId) continue;
      const token = this.sanitizedTokens[id];
      ...
    }
    let text = tokens.join('');
    text = text.replace(/^\s+/, '');
    text = text.replace(/\s+(?=[^\w\s])/g, '');
    text = text.replace(/\s+/g, ' ');
    return text.trim();
  }
```
There is no separate punctuation/truecasing model — casing and punctuation are ordinary vocabulary
entries the decoder emits like any other token. Confirmed by inspecting the sibling Parakeet-family
tokenizer shipped in this repo at
`dist/win-unpacked/resources/sherpa_onnx_models/sherpa-onnx-nemo-parakeet-tdt_ctc-110m-en-int8/tokens.txt`
(same 1025-size vocab convention as `parakeet-tdt-0.6b-v2`, `node_modules/parakeet.js/src/models.js:45-56`):
capitalized subwords (`▁The 104`, `▁And 121`) and bare punctuation (`. 986`, `, 988`, `? 1002`, `! 1016`)
both live directly in the vocabulary — not read from `parakeet.js` JS source itself (that source has
no vocab data), but corroborating the same tokenizer scheme the JS `decode()` implements. Implication
in §3.6.

### 1.8 What the app currently does (baseline before this change)

`app/renderer/app/webgpu/inference-worker.ts:125-129`
```ts
  const result = await model.transcribe(audio, sampleRate, {
    returnTimestamps: false,  // unused downstream — saves decoder bookkeeping
    returnConfidences: true,
    enableProfiling: false,   // stop the per-transcription RTF/console.table spam
  });
```
Whole-recording, single-shot, no timestamps, confidences on. `app/renderer/app/CaptureApp.tsx:299-311`
already has a retry-once-on-empty pattern for the known intermittent empty-transcription bug (cited
as precedent in §3), and `app/renderer/app/audio/AudioCapture.ts:117`
(`READY_ENERGY_FLOOR = 0.005`) already establishes an RMS-floor pattern for distinguishing "no real
audio" from "engine problem" — reused conceptually in §3 to distinguish a silent chunk from a failed
one. There is no existing chunking code anywhere in `app/renderer/app/` (`grep -rn "chunk"` only
matches audio-buffer variable names, not a segmentation feature) — chunked parallel transcription is
new.

---

## 2. Merge algorithm

### 2.1 Chosen strategy

**Token-ID LCS with frame-index verification and log-prob arbitration, built directly on the
library's own `LCSPTFAMerger`, wrapped with an explicit per-chunk health gate (retry-then-flag) so a
degenerate chunk can never silently make the *other* chunk's good overlap content disappear.** Final
text is produced by a single `tokenizer.decode()` call over the fully-merged token-ID sequence, never
by concatenating each chunk's own `utterance_text` strings.

Why this over the alternatives named in the brief:

- **Timestamp-midpoint cut**: rejected as the *sole* mechanism. Timestamps are real (§1.2) but
  quantized to an 80 ms grid and derived from the TDT duration predictor, not a forced aligner — a
  blind midpoint cut can land inside a word with no verification that both chunks agree there. Frame
  index is used here, but only as a *verification* signal for an LCS-found anchor
  (`_verifyFrameAlignment`, `parakeet.js:1983-1993`), not as the primary cut rule.
- **Pure text-level LCS / diff**: rejected as primary because text has already lost the exact
  token boundary information (spacing/punctuation merge, `▁` handling) and any surface-form
  difference (a homophone spelled differently) defeats a naive string match even when the audio truly
  agrees. Token IDs are the more precise, cheaper-to-compare signal parakeet.js already computes.
- **Confidence-weighted selection alone**: rejected as primary because confidence is uncalibrated and
  two chunks can independently be *equally* (over)confident about two different wrong answers.
  Confidence/log-prob is used here only as the tie-break when token IDs already show a genuine
  disagreement (`_arbitrateByLogProb`, `parakeet.js:2004-2014`), never as the mechanism for finding
  *where* to cut.
- **Hybrid (chosen)**: LCS token match finds *where* both chunks agree; frame-index tolerance
  (`timeTolerance`) verifies the match isn't a coincidental repeated word; log-prob/confidence
  resolves the rarer case where they don't verify but a plausible partial match exists; a health gate
  in front handles the case where one side has nothing usable to match against at all (§2.2).

### 2.2 Why a wrapper around `LCSPTFAMerger`, not the class used bare

Traced against the actual `processChunk` code (`parakeet.js:1844-1921`): when `lcsLength === 0`
because one side is *empty* (not merely disagreeing), the library's fallback still executes
`this.confirmedTokens.push(...this.pendingTokens)` and then `this.pendingTokens = newTokens` — i.e.
it always keeps the **earlier** chunk's version and discards the **later** chunk's `overlapTokens`
outright, with no distinction between "genuine content disagreement" and "one side is blank because
it failed." If chunk *i* is the one that returned empty (the app's known intermittent bug) and chunk
*i+1* correctly captured the same overlap audio, bare `LCSPTFAMerger` usage would discard chunk
*i+1*'s correct overlap text and keep nothing — the exact silent-drop failure mode this design must
prevent. The wrapper in §2.3 adds a pre-merge health/retry gate so a chunk is only ever fed to the
merger as "confirmed empty," never accidentally treated as "confirmed correct but blank."

### 2.3 Pseudocode

Chunk geometry: chunk *i* nominally owns `[nominalStart_i, nominalEnd_i)` (30 s, except possibly the
last), and its audio window is `[nominalStart_i - 2, nominalEnd_i + 2]` clamped to the recording's
true bounds. Adjacent chunks therefore share a `2×OVERLAP_S` (nominally 4 s) window straddling every
internal boundary — see §4 for why 2 s per side.

```text
INPUTS (per chunk i, produced by the parallel-execution layer — may resolve out of order,
        but are consumed here strictly in index order):
  chunk[i] = {
    index, nominalStartS, nominalEndS,       # the 30s span this chunk "owns"
    windowStartS, windowEndS,                 # actual audio window sent to transcribe(), post-clamp
    audio, sampleRate, rms,                   # for the silence-vs-failure disambiguator
    ok: bool,                                 # transcribe() resolved (no throw/timeout)
    raw: TranscribeResult | null,             # requires at minimum tokenIds, frameIndices, logProbs
  }

CONSTANTS
  FRAME_STRIDE      = model.getFrameTimeStride()     # 0.08s  (parakeet.js:538-540)
  OVERLAP_S         = 2.0                            # per-side buffer (input to this design)
  SEAM_OVERLAP_S    = 2 * OVERLAP_S                   # 4.0s nominal shared span between neighbors
  SILENCE_RMS_FLOOR = <tuned>                        # cf. AudioCapture.ts:117 READY_ENERGY_FLOOR pattern
  HEALTH_LOGPROB_FLOOR = <tuned>                     # mean(logProbs) below this = suspect chunk

merger = new LCSPTFAMerger({ frameTimeStride: FRAME_STRIDE })   # from 'parakeet.js', not reimplemented
gaps = []            # [{ startS, endS, reason }] — always surfaced, never silent
statuses = []        # [{ index, status }] for observability/telemetry

# ---------- Pass 1: per-chunk health gate + repair ----------
for c in chunk[] in index order:
  emptyOrGarbled = !c.ok
                   or c.raw == null
                   or c.raw.tokenIds.length == 0
                   or mean(c.raw.logProbs) < HEALTH_LOGPROB_FLOOR

  if emptyOrGarbled and c.rms < SILENCE_RMS_FLOOR:
    c.status = 'silent'                 # legitimately quiet — not a failure, no retry, no gap

  elif emptyOrGarbled:                  # real energy present but nothing usable came back
    c.raw = await retryTranscribe(c.audio, c.sampleRate)     # ONE retry, mirrors
                                                               # CaptureApp.tsx:304-309's existing
                                                               # whole-recording retry-once pattern
    stillBad = c.raw == null or c.raw.tokenIds.length == 0
               or mean(c.raw.logProbs) < HEALTH_LOGPROB_FLOOR
    c.status = stillBad ? 'failed' : 'ok'

  else:
    c.status = 'ok'

  statuses.push({ index: c.index, status: c.status })

# ---------- Pass 2: sequential fan-in merge (must run in index order even
#            though Pass-1 compute may have completed out of order) ----------
prevFedIndex = -1
for i, c in chunk[] in index order:

  if c.status == 'failed':
    # Exclude from the merger entirely. The 2s edges bordering this chunk are
    # still separately covered by the healthy neighbors' own buffers — only
    # the true interior is unrecoverable. Flag it; never drop it silently.
    gaps.push({
      startS: c.nominalStartS + OVERLAP_S,
      endS:   c.nominalEndS   - OVERLAP_S,
      reason: 'chunk-transcription-failed-after-retry',
    })
    continue                              # prevFedIndex intentionally NOT advanced to i

  overlapS = (prevFedIndex == -1) ? 0.0
           : (i == prevFedIndex + 1) ? clamp(SEAM_OVERLAP_S, 0, min(c.windowLenS, prevWindowLenS))
           : 0.0                          # a FAILED chunk was skipped in between -> no shared audio

  tokensForMerge = (c.status == 'silent')
                 ? { tokenIds: [], frameIndices: [], logProbs: [] }
                 : { tokenIds: c.raw.tokenIds, frameIndices: c.raw.frameIndices, logProbs: c.raw.logProbs }

  merger.processChunk(tokensForMerge, c.windowStartS, overlapS)
  prevFedIndex = i

# ---------- Pass 3: finalize ----------
finalTokenIds = merger.getAllTokens().sort_by(absTime).map(t => t.id)   # library already sorts
text = tokenizer.decode(finalTokenIds)     # ONE decode call -> consistent SentencePiece spacing
                                            # across every seam, no manual string concatenation

return { text, gaps, statuses }
```

Interface contract this places on the parallel-execution layer: chunk transcription can complete in
any order, but **the merge (Pass 1 health-check may run per-chunk as results land; Pass 2 must
consume results strictly in chunk-index order)** — `LCSPTFAMerger` is stateful
(`pendingTokens`/`confirmedTokens` mutated per call), so merge is an O(N) sequential reduce *after*
the parallel map, not itself parallelizable.

---

## 3. Edge-case table

| Case | Behaviour | Why |
|---|---|---|
| Word straddling the seam, chunks transcribe it differently | LCS+frame-verify finds the anchor around it; if verified, the **earlier** chunk's token span for the whole matched region (including this word) is committed — the later chunk's copy is used only to validate the seam location, never to supply the committed text, unless the match is *weak* (`lcsLength>0` but `!anchorValid`), in which case `_arbitrateByLogProb` picks the higher-weighted-log-prob side | `parakeet.js:1893-1905`; committing the earlier chunk's tokens is also what keeps casing/punctuation continuity correct — see §3.6 |
| Two chunks disagree on the overlap text entirely (no LCS match, `lcsLength == 0`, both sides otherwise healthy) | Earlier chunk's full pending token run is committed as-is (library default, `parakeet.js:1906-1909`); later chunk's overlap tokens for that span are discarded, its post-overlap tokens become the new pending. Logged as a low-confidence seam (via `statuses`/debug output), not auto-corrected — see §6 for residual risk | No ground truth to prefer one side over the other absent a stronger signal than "no shared substring found"; earlier-wins is at least deterministic and matches the casing/punctuation-continuity argument in §3.6 |
| A chunk returns empty (known intermittent bug) | Health gate (§2.3 Pass 1) classifies by RMS: if the chunk's own audio has real energy, retry once, then mark `failed` if still empty and **exclude it from the merger** (never fed as a false "confirmed empty"); its true un-recoverable interior (nominal span minus the 2s edges still covered by neighbors) is pushed to `gaps[]`, never silently dropped | Directly closes the gap identified in §2.2: bare `LCSPTFAMerger` would keep the empty chunk's "confirmed" nothing and discard the healthy neighbor's overlap tokens along with it |
| A chunk errors or times out | Same path as "returns empty" — `c.ok == false` forces `emptyOrGarbled = true` regardless of RMS, so it goes through the same retry-then-flag handling | The merge layer doesn't need to know *why* a chunk has no usable result, only that it doesn't; one failure taxonomy, one recovery path |
| Silence spanning a whole chunk | RMS below `SILENCE_RMS_FLOOR` → `status = 'silent'`, no retry, no gap flag, contributes an empty token set to the merger call (keeps `pendingTokens` bookkeeping correct for the next chunk's overlap math) | Distinguishing "legitimately silent" from "engine bug" needs a signal outside the model's own output, since both look identical as `utterance_text: ''`; reuses the RMS-floor pattern already established at `AudioCapture.ts:117` (`READY_ENERGY_FLOOR = 0.005`) rather than inventing a new one |
| Final chunk shorter than the overlap window | Right buffer clamped to `min(OVERLAP_S, audio remaining past nominalEnd)`; if the final *nominal* remainder itself is smaller than roughly `SEAM_OVERLAP_S` (so the chunk would be mostly-or-all overlap with no unique interior), absorb it into the previous chunk's request instead of dispatching a standalone final chunk | Mirrors the library's own `MIN_CHUNK_LENGTH_S = 20` floor concept (`long_audio.js:2`) — a chunk that's nearly all-overlap breaks the `overlapDuration < chunk length` assumption `processChunk` relies on and can leave `newTokens` empty, silently losing its tail |
| Speaker mid-word at the very start or end of the whole recording | Chunk 0's left buffer and the last chunk's right buffer are clamped to the true recording bounds (no manufactured pre-roll/post-roll); no `gaps[]` entry is created here — there is no neighboring chunk to compare against, so flagging it would be a false positive | This is **not** a chunking-introduced risk — a single-shot whole-file `transcribe()` call has the identical exposure at the true recording boundaries. Chunking's job is to not make the *interior* seams worse than this baseline, not to fix an inherent one |
| Parallel chunk results arrive out of order | Pass 1 (health check) may run as each result lands; Pass 2 (the actual `merger.processChunk` fan-in) buffers and replays strictly in chunk-index order | `LCSPTFAMerger` state (`pendingTokens`) is only meaningful relative to the immediately-preceding call; feeding it out of order silently corrupts every downstream anchor, with no error raised |

### 3.6 Punctuation and casing across seams

The model emits casing and punctuation as ordinary vocabulary tokens (§1.7), so there is no separate
normalization pass to reconcile between chunks — whichever chunk's tokens are committed for a given
span also supplies its casing/punctuation for that span verbatim.

This makes the earlier-chunk-wins default (§3 row 1) load-bearing for a second reason beyond
acoustic-boundary robustness: chunks are decoded **independently in parallel** (no
`previousDecoderState` handoff across chunk boundaries — that option exists,
`parakeet.js:610,761-765`, but is only usable for genuinely sequential/stateful decoding of
contiguous chunks, not parallel independent ones). Each chunk's decoder LSTM state starts from the
same zero-initialized tensors every model instance is constructed with
(`parakeet.js:85-91`, `this._combState1`/`_combState2`), identical to how a completely standalone
utterance starts. A chunk that happens to begin mid-sentence therefore has no way to know it isn't
utterance-initial, and ASR decoders commonly show a mild bias toward capitalizing an utterance-first
word. Concretely: chunk *i+1*'s first few words (which fall inside the shared overlap and *do* have
real preceding sentence context, captured correctly by chunk *i* which decoded them mid-utterance)
are exactly the tokens the earlier-chunk-wins default discards chunk *i+1*'s version of — so the
default is casing-correct as a side effect, not just seam-robust.

Naive concatenation risk if this design were *not* followed (e.g. `chunkA.utterance_text + ' ' +
chunkB.utterance_text` instead of one `tokenizer.decode()` over merged IDs): duplicated or missing
spaces around chunk-boundary punctuation, because the SentencePiece spacing rule
(`tokenizer.js:63-86`, the `\A\s|\s\B|(\s)\b`-style regex) is applied *per chunk*, not across the
seam — the merge in §2.3 avoids this by decoding the entire assembled token-ID sequence once.

---

## 4. Overlap-window sizing verdict: 2 seconds

**Verdict: workable as a floor, but thin — not comfortably safe on its own; ship it gated behind
the verification step in §5, and prefer 3 s if the parallel-execution budget allows.**

Reasoning:

- **What can be computed from parakeet.js source**: the frame stride is 80 ms
  (§1.2). 2 s = 25 encoder frames of margin on each side of a boundary — far above the frame
  quantization floor, so timestamp/frame-index granularity is not the limiting factor.
- **What cannot be answered from parakeet.js source**: the Conformer encoder's true receptive
  field / attention context is a property of the exported ONNX weights and graph (NeMo FastConformer),
  not something visible in this JS wrapper — there is no file:line in `parakeet.js` that specifies it,
  and this document does not claim one. Stated plainly as a gap rather than guessed at.
- **Indirect but concrete evidence from this repo**: the library's own long-form chunker's
  blind-fallback overlap is **10 s** (`long_audio.js:5`, `AUTO_WINDOW_FALLBACK_OVERLAP_S`) — 5× the
  proposed value — used specifically for the case where it *can't* find a natural pause to cut on.
  Its primary strategy isn't a fixed small overlap at all; it's pause-snapping
  (`relocateCursorToNearbyGap`, `long_audio.js:318-341`) plus post-hoc duplicate-word removal
  (`dedupeMergedWords`, `long_audio.js:138-164`). That's a materially more forgiving approach than
  "always cut through speech with a small fixed overlap," and its authors' own fallback number being
  5× larger is evidence worth weighing, not proof 2 s is wrong.
- **Geometry point specific to this design**: because the buffer is symmetric (2 s on *both* ends of
  every chunk), the shared 4 s seam region sits at the tail of the earlier chunk and the head of the
  later chunk *simultaneously* — both copies are equally "near an edge" of their own window. This
  means the `LCSPTFAMerger` vignette weighting (`_computeVignette`, `parakeet.js:2024-2031`, which
  down-weights tokens near a chunk's edges) does **not** meaningfully discriminate between the two
  candidates in the typical case — both get a similarly reduced weight. The primary defense against
  boundary-quality loss here is therefore the *raw* per-token log-prob/confidence signal (§1.3), not
  the vignette; 2 s needs to be large enough that this raw signal is reliably good near the edge, which
  is exactly what §5's WER self-check is for.
- **Typical word/coarticulation timescales**: average English word duration is roughly 0.3–0.6 s, and
  coarticulation effects across a word boundary are on the order of 100–300 ms — 2 s is a 3–6×
  margin over those numbers, which is why it's plausible as a floor and not obviously broken.

Net: 2 s is a reasonable **starting point**, not a value this document can independently certify as
sufficient without the empirical check in §5, given the encoder's actual context sensitivity can't be
read out of the JS source. If the parallel-chunking design can absorb the extra compute, 3 s narrows
the gap to the library's own 10 s fallback without doubling chunk-transcription cost, and costs
nothing to change (it's a single constant, `OVERLAP_S`, in §2.3).

---

## 5. Verification strategy

All four are runnable without a labeled corpus:

1. **Single-shot vs. chunked WER diff (primary gate).** Take one real, multi-minute recording.
   Transcribe it twice with the *same* model instance: (a) whole-file via `transcribe()` — this is
   the reference, since it has no internal seams to get wrong; (b) via the chunked pipeline in §2.
   Word-align (a) against (b) with a standard Levenshtein/edit-distance word alignment and compute
   WER (`(substitutions + deletions + insertions) / len(reference words)`). Because both runs use
   identical model weights and audio, any non-trivial delta is *by construction* a merge defect, not
   a transcription-quality issue — this isolates exactly the risk this document owns. Target: WER
   near 0 (a couple of percent at most, from legitimate weak-anchor arbitration differences); anything
   materially higher means a seam bug. Trivially scriptable with Node + two text strings.
2. **Property tests over synthetic seams.** Build short test clips from known-text sources (TTS or
   pre-recorded) so ground truth is exact, then programmatically re-run the pipeline while varying:
   cut offset relative to word boundaries (mid-word, mid-silence, exactly at a word edge), overlap
   size (0/1/2/4 s), and chunk count. Assert normalized-text equality against the known script.
   Separately: stub one chunk's `transcribe()` call to return an empty result and assert (a) the
   *other* chunks' text is unaffected and (b) the failed span appears in `gaps[]` — this directly
   tests the §2.2/§3 empty-chunk fix, without needing the real intermittent bug to reproduce.
   Also assert byte-identical output across repeated runs of the same audio (nondeterminism guard —
   relevant given the app's own history with this model's intermittent-empty behavior).
3. **Adversarial overlap-disagreement spot check.** Deliberately perturb only the overlap samples of
   one chunk's copy (slight gain/EQ/noise) to force the weak/no-anchor arbitration path, and manually
   listen/inspect whether the chosen text is the more sensible candidate. Qualitative, but genuinely
   runnable, and specifically exercises the code path §3's first two table rows describe.
4. **Regression corpus from real failures.** The app already saves the raw audio behind every empty
   result today (`CaptureApp.tsx:324`, `saveDiagAudio(... '-EMPTY.wav')`). Extend that same practice to
   any chunk-boundary defect found in the field: save the triggering audio, add it to a small fixture
   set, replay it through both single-shot and chunked pipelines on every future change. Compounds
   coverage exactly where real defects have actually occurred, rather than needing a big generic
   labeled dataset up front.

---

## 6. Failure modes that remain

- **Genuinely lost interior of a `failed` chunk** (~26 s if a chunk fails both the initial call and
  the one retry): the merge layer can only *flag* this (`gaps[]`), not recover it — recovery (e.g.
  retry on a different backend/engine) belongs to the parallel-execution layer, not here. This must
  be surfaced to the UI, not swallowed as a clean-looking transcript.
- **Silence-vs-bug disambiguation is a tuned heuristic** (`SILENCE_RMS_FLOOR`), not a certainty. A
  very quiet-but-real utterance near the floor could be misclassified either way; bias the threshold
  low (toward "retry when in doubt") since an unnecessary retry is cheap and a missed one risks a
  silent drop.
- **LCS token-ID matching assumes deterministic decoding.** This holds under the current default
  (`temperature = 1.0`, explicitly commented as greedy: `parakeet.js:604`) — if a future change
  enables sampling for chunk transcription, two chunks can genuinely diverge token-for-token on
  identical overlap audio and LCS reliability drops. Keep `temperature: 1.0` for any chunk feeding
  this merge.
- **Frame-index tolerance depends on precise chunk-timing bookkeeping upstream.** `timeTolerance`
  in `LCSPTFAMerger` defaults to 0.15 s (`parakeet.js:1822`); any off-by-one-sample or resampling
  drift in how the parallel-execution layer slices/pads each chunk's audio can push a genuine match
  outside tolerance, forcing more chunks than acoustically necessary into the weak/no-anchor
  fallback. This is a coordination contract with that layer, not something this design can
  self-verify without ground truth.
- **Log-prob/vignette arbitration is a heuristic, not a proof.** For a true overlap disagreement with
  no clear winner, it can still pick the acoustically wrong candidate; only the WER self-check (§5.1)
  catches this empirically — there's no closed-form correctness guarantee.
- **Scope boundary**: this design fixes word/token-level fidelity across seams. Discourse-level
  formatting decisions (e.g., whether a chunk boundary should become a paragraph break) are out of
  scope — the merge produces one continuous decoded string, nothing more.
