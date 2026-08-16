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
  status: 'ready' | 'loading' | 'unusable' | 'unknown';
  reason: string | null;
  gpu: 'usable' | 'unusable' | 'indeterminate';
  endpoint?: { url: string | null; verifiedAt: number | null };
  preferredModelId?: string | null;
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
  { orchestratorReady = false }: { orchestratorReady?: boolean } = {},
): CapturePlan {
  const selectedModelId = state.modelId;

  // The WebGPU path needs its worker warm, because inference runs in the
  // renderer against raw PCM. If it is not warm we do NOT refuse the press:
  // a dead hotkey is a worse failure than a slower transcript, and refusing
  // silently is how it went unnoticed for a release. Fall back to the bundled
  // CPU engine for THIS recording only.
  if (state.engine === 'webgpu' && !(orchestratorReady && state.status === 'ready')) {
    const reason = state.gpu === 'unusable'
      ? 'GPU unavailable — recorded on the CPU engine'
      : 'GPU model still loading — recorded on the CPU engine';
    return Object.freeze({
      engine: 'local' as const,
      modelId: FALLBACK_MODEL,
      mode: 'webm' as const,
      // Deliberately unchanged: falling back for one recording must not rewrite
      // what the user chose. The next recording uses the GPU.
      selectedModelId,
      reason,
    });
  }

  return Object.freeze({
    engine: state.engine,
    modelId: state.modelId,
    // Raw PCM only for in-renderer inference; everything dispatched to the main
    // process goes as webm, which is what those adapters accept.
    mode: (state.engine === 'webgpu' ? 'raw-pcm' : 'webm') as 'raw-pcm' | 'webm',
    selectedModelId,
    reason: null,
  });
}
