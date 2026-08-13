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
