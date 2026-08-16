/**
 * Types for capture-plan.js.
 *
 * The module is CommonJS because the main process and the tests both consume
 * it; this declaration lets the renderer import it with real types rather than
 * `any`. Note the lesson from webgpu.d.ts, which hand-declared a platform API
 * that had been removed and so made `tsc` green on impossible code: a hand
 * declaration is only safe when it describes code in THIS repo, which changes
 * in lockstep with it.
 */

export interface EngineStateRecord {
  rev: number;
  engine: 'webgpu' | 'local' | 'remote';
  modelId: string;
  status: 'ready' | 'loading' | 'unusable' | 'unknown';
  reason: string | null;
  gpu: 'usable' | 'unusable' | 'indeterminate';
  endpoint: { url: string | null; verifiedAt: number | null };
  preferredModelId: string | null;
}

export interface CapturePlan {
  readonly engine: 'webgpu' | 'local' | 'remote';
  readonly modelId: string;
  readonly mode: 'raw-pcm' | 'webm';
  /** What the user actually chose — unchanged by a fallback. */
  readonly selectedModelId: string;
  /** Non-null only when this recording was downgraded; shown to the user. */
  readonly reason: string | null;
}

export function planCapture(
  state: EngineStateRecord,
  opts: { orchestratorReady?: boolean },
): CapturePlan;
