/**
 * Decides whether a recording needs to be transcribed in windows.
 *
 * Pure and dependency-free so it can be unit tested without a model, a worker,
 * or a browser. See _review/FIX-PLAN.md fix 0c.
 */

/**
 * Above roughly this much audio, a single one-shot `transcribe()` starts
 * returning empty text (observed in production logs from ~60-90s). Chunking
 * below that costs windowing overhead for no benefit, so this is deliberately
 * set under the observed failure point but above typical push-to-talk length.
 */
export const CHUNK_THRESHOLD_S = 30;

/**
 * Window length handed to `transcribeLongAudio`. parakeet.js clamps this to
 * [20, 180]s; 30s is the value that has worked in production elsewhere and sits
 * comfortably inside that range.
 */
export const CHUNK_LENGTH_S = 30;

export interface ChunkPlan {
  chunked: boolean;
  durationS: number;
  /** Only meaningful when `chunked` is true. */
  chunkLengthS: number;
}

/**
 * @param sampleCount - number of PCM samples (mono)
 * @param sampleRate  - samples per second
 */
export interface TimedWord {
  text: string;
  start_time: number;
  end_time: number;
}

/**
 * How far a word may start before the previous word ended and still be treated
 * as genuinely sequential. Real adjacent words can overlap by a few tens of ms
 * from timestamp jitter; a duplicated seam jumps back by seconds.
 */
const BACKWARD_TOLERANCE_S = 0.5;

/**
 * Drop words already covered by an earlier window.
 *
 * parakeet.js windows overlap by a fixed 10s (`long_audio.js:351`) and its own
 * `dedupeMergedWords` only compares each word to the IMMEDIATELY preceding one,
 * so it collapses a repeated single word but not a repeated multi-word span.
 * The result is that the overlap region is emitted twice — verbatim — at every
 * seam, at every chunk length including the library's own 90s default.
 *
 * The giveaway is that a duplicated span runs BACKWARDS in time: after emitting
 * a word ending at 48s the next word starts at 40s. Genuine speech never does
 * that, so keeping only forward-moving words removes the duplicates without
 * touching legitimate repetition (which carries later timestamps).
 */
export function dedupeOverlappingWords(words: TimedWord[]): TimedWord[] {
  const kept: TimedWord[] = [];
  let furthestEnd = -Infinity;
  for (const word of words) {
    if (word.start_time < furthestEnd - BACKWARD_TOLERANCE_S) continue;
    kept.push(word);
    furthestEnd = Math.max(furthestEnd, word.end_time);
  }
  return kept;
}

/** Rejoin de-duplicated words into a transcript. */
export function joinWords(words: TimedWord[]): string {
  return words.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
}

export function chunkPlanFor(sampleCount: number, sampleRate: number): ChunkPlan {
  // A zero/invalid rate would make durationS Infinity or NaN and wrongly force
  // the chunked path; treat it as "can't tell" and stay on the simple path.
  const durationS = sampleRate > 0 ? sampleCount / sampleRate : 0;
  return {
    chunked: durationS > CHUNK_THRESHOLD_S,
    durationS,
    chunkLengthS: CHUNK_LENGTH_S,
  };
}
