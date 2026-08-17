/**
 * capture-plan — decide how one recording will be captured and dispatched.
 *
 * Routing used to be decided twice, in two places, at two different times: the
 * capture MODE at record start from `orchestrator.isReady()`, and the
 * DESTINATION at stop from a config re-read. When those disagreed — a model
 * switch mid-recording, or an orchestrator that became ready in between — the
 * audio was captured for one engine and handed to another, and thrown away.
 *
 * The rule is not "never latch". Deriving again at stop is exactly what lost
 * the recording. It is: derive ONCE, here, at record start; freeze the result;
 * and use that frozen value when the recording ends. A recording is a unit of
 * work that carries its own routing. A switch mid-recording affects the next
 * recording, not the one in flight.
 *
 * Pure by construction — no React, no DOM, no Electron, no I/O — so the routing
 * rules can be tested directly instead of through a browser.
 *
 * Lives in the renderer and is ESM. It was briefly a CommonJS module under
 * app/stt/ with a hand-written .d.ts, which typechecked and unit-tested fine
 * but broke `vite build`: Rollup cannot see a named export off
 * `module.exports = {...}`. Only the bundler catches that, which is why
 * `npm run build` now belongs in the verification gate alongside typecheck and
 * tests.
 */

/**
 * The bundled CPU model, used as the universal fallback.
 *
 * Duplicated from engine-state.js rather than imported, because that module is
 * CommonJS (the main process requires it) and importing it here reintroduces
 * exactly the interop problem above. `test/capture-plan.test.mjs` asserts the
 * two constants stay equal, so the duplication cannot silently drift.
 */
export const FALLBACK_MODEL = 'local-fast';

export interface EngineStateRecord {
  rev: number;
  engine: 'webgpu' | 'local' | 'remote';
  modelId: string;
  status: 'ready' | 'loading' | 'downloading' | 'unusable' | 'unknown';
  reason: string | null;
  gpu: 'usable' | 'unusable' | 'indeterminate';
  endpoint?: { url: string | null; verifiedAt: number | null };
  preferredModelId?: string | null;
  /** Bytes in flight for `modelId`. Non-null only while status is 'downloading'. */
  progress?: { loaded: number; total: number; pct: number; at?: number } | null;
}

export interface CapturePlan {
  readonly engine: 'webgpu' | 'local' | 'remote';
  readonly modelId: string;
  readonly mode: 'raw-pcm' | 'webm';
  /** What the user actually chose — unchanged by a fallback. */
  readonly selectedModelId: string;
  /**
   * True when the chosen engine cannot serve this recording yet.
   *
   * The caller must NOT record. It must show `reason` and leave the selection
   * alone. Substituting a different engine here is the exact behaviour this
   * field exists to prevent.
   */
  readonly blocked: boolean;
  /** Why this recording cannot proceed, or null. Shown to the user. */
  readonly reason: string | null;
  /**
   * Whether being blocked is a FAILURE or just a WAIT.
   *
   * The caller flashed the tray's red `error` state for both, so pressing the
   * hotkey during a perfectly healthy download looked identical to a crash.
   * A wait is not an error and must not be dressed as one.
   */
  readonly blockedKind: 'error' | 'wait' | null;
}

export function planCapture(
  state: EngineStateRecord,
  { orchestratorReady = false }: { orchestratorReady?: boolean } = {},
): CapturePlan {
  const selectedModelId = state.modelId;

  // The WebGPU path needs its worker warm, because inference runs in the
  // renderer against raw PCM. If it is not warm, the recording does NOT happen.
  //
  // This used to silently transcribe on the CPU engine instead. That is the
  // automatic switching the maintainer ruled out, and it was the worst instance
  // of it: you selected GPU, the app reported GPU, and every word went through
  // a different engine while a 2.3GB download ran in the background. "You have
  // to wait and download the GPU, not automatically convert it and say GPU but
  // yet use CPU."
  //
  // Waiting is the honest behaviour. If the user wants the CPU engine, that is
  // one click, and it is their click to make.
  if (state.engine === 'webgpu' && !(orchestratorReady && state.status === 'ready')) {
    // One message used to cover all of these, and it said "ready shortly" —
    // true for a 20s warm start, a lie during a 90s download, and simply wrong
    // when the GPU cannot run at all. Each state now says what is actually
    // happening and what the user can do about it.
    const unusable = state.gpu === 'unusable';
    const pct = state.progress?.pct;
    let reason: string;
    if (unusable) {
      reason = 'GPU unavailable — select the CPU engine in Settings to record';
    } else if (state.status === 'downloading') {
      reason = Number.isFinite(pct)
        ? `Downloading GPU model — ${pct}%. Press again when it is ready, or switch to CPU in Settings.`
        : 'Starting the GPU model download. Press again shortly, or switch to CPU in Settings.';
    } else {
      reason = 'GPU model still loading — it will be ready shortly';
    }

    return Object.freeze({
      engine: state.engine,
      modelId: state.modelId,
      mode: 'raw-pcm' as const,
      selectedModelId,
      blocked: true,
      reason,
      blockedKind: (unusable ? 'error' : 'wait') as 'error' | 'wait',
    });
  }

  return Object.freeze({
    engine: state.engine,
    modelId: state.modelId,
    // Raw PCM only for in-renderer inference; everything dispatched to the main
    // process goes as webm, which is what those adapters accept.
    mode: (state.engine === 'webgpu' ? 'raw-pcm' : 'webm') as 'raw-pcm' | 'webm',
    selectedModelId,
    blocked: false,
    reason: null,
    blockedKind: null,
  });
}
