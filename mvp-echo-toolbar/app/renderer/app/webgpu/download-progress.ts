/**
 * Turn parakeet's per-file download ticks into one number that only goes up.
 *
 * The worker reports progress PER FILE (inference-worker.ts:118-127): each file
 * runs its own 0→100%, and parakeet fetches several. Forwarding that raw means
 * the user watches the percentage restart two or three times in a single
 * download, which reads as stuck rather than progressing.
 *
 * This codebase already ruled on this exact shape once — model-store.js
 * aggregates across files for the same reason, asserted in
 * test/model-store.test.js as "per-file progress that resets to 0 reads as a
 * stuck download". The hub path never learned it.
 *
 * It is also where the BOUND lives, and it lives here — at the thing that
 * emits — rather than at each consumer. A 1.2GB download produces tens of
 * thousands of raw ticks, and every forward becomes an IPC message plus a
 * broadcast to three windows. Throttling to whole-percent transitions caps that
 * at ~101 per download no matter how many consumers appear later.
 *
 * Pure: no DOM, no worker, no Electron. One aggregator per download.
 */

export interface ProgressTick {
  file: string;
  loaded: number;
  total: number;
}

export interface AggregateProgress {
  loaded: number;
  total: number;
  pct: number;
}

export interface ProgressAggregator {
  /** Fold in one raw tick. Returns the aggregate only when it is worth sending. */
  push(tick: ProgressTick): AggregateProgress | null;
}

export function createProgressAggregator(): ProgressAggregator {
  // file -> its latest known byte counts. A Map rather than a running sum
  // because ticks are cumulative per file, not deltas: adding them would count
  // the same bytes repeatedly.
  const files = new Map<string, { loaded: number; total: number }>();
  let lastPct = -1;

  return {
    push({ file, loaded, total }) {
      // `total` may be revised upward once a real Content-Length arrives, so it
      // is overwritten rather than pinned to whatever was seen first.
      files.set(file, { loaded, total });

      let sumLoaded = 0;
      let sumTotal = 0;
      for (const f of files.values()) {
        sumLoaded += f.loaded;
        sumTotal += f.total;
      }

      // A zero denominator is a download whose size is not known yet. Report
      // nothing rather than NaN% — no percentage beats a wrong one on screen.
      if (sumTotal <= 0) return null;

      const pct = Math.min(100, Math.round((sumLoaded / sumTotal) * 100));
      if (pct === lastPct) return null;
      lastPct = pct;

      return { loaded: sumLoaded, total: sumTotal, pct };
    },
  };
}
