/**
 * EngineState — the single authoritative record of which engine is selected.
 *
 * "Which engine/model is selected" previously lived in seven places that
 * disagreed: three persisted adapter configs, two EngineManager fields, and two
 * renderer values. Nothing reconciled them, and two independent routers read
 * different copies — which is how a recording captured for the CPU engine got
 * dispatched to the WebGPU adapter, and how a stale WebGPU config outranked an
 * explicit CPU choice on every restart.
 *
 * This module is that record and its transitions, as PURE FUNCTIONS. No
 * Electron, no filesystem, no adapters, no I/O. Everything else derives from
 * it. Keeping it pure is what makes it testable, and the fact that it was not
 * testable before is the same reason it was not correct.
 *
 * Two axes are deliberately kept separate, because conflating them is the
 * original sin here:
 *   - WHAT THE USER CHOSE   (engine + modelId)  — authoritative, only `select` writes it
 *   - WHETHER IT CAN RUN    (status + gpu)      — observed, never rewrites the choice
 *     unless the negative is definitive.
 */

/** The model that ships in the box. The only safe universal fallback. */
const DEFAULT_MODEL = 'local-fast';

/**
 * The id namespace IS the routing table.
 *
 * Deriving the engine from the model id rather than storing it separately means
 * the two can never disagree — the class of bug this module exists to delete.
 */
function engineForModel(modelId) {
  if (typeof modelId === 'string' && modelId.startsWith('webgpu-')) return 'webgpu';
  if (typeof modelId === 'string' && modelId.startsWith('local-')) return 'local';
  return 'remote';
}

/**
 * Reject an engine/model pair that cannot possibly work.
 *
 * The check that would have turned "transcribe() called on main-process
 * adapter" — an opaque throw that then logged as `{}` — into a message naming
 * both sides of the disagreement.
 */
function assertPair(engine, modelId) {
  const expected = engineForModel(modelId);
  if (expected !== engine) {
    throw new Error(
      `engine/model mismatch: engine "${engine}" cannot run model "${modelId}" ` +
      `(that model belongs to engine "${expected}")`
    );
  }
}

function createState(overrides = {}) {
  return {
    rev: 0,
    engine: 'local',
    modelId: DEFAULT_MODEL,
    status: 'unknown',
    reason: null,
    gpu: 'indeterminate',
    endpoint: { url: null, verifiedAt: null },
    /**
     * The last model the user explicitly chose, retained across a demotion so a
     * GPU that comes back restores their actual preference instead of silently
     * stranding them on the fallback.
     */
    preferredModelId: null,
    ...overrides,
  };
}

/** Status derived from the choice and the observed capability. */
function withStatus(state) {
  if (state.engine === 'webgpu' && state.gpu === 'unusable') {
    return { ...state, status: 'unusable', reason: 'GPU unavailable on this system' };
  }
  return { ...state, status: state.status === 'unusable' ? 'unknown' : state.status, reason: null };
}

/**
 * Record an explicit user choice. This is the only authoritative write.
 *
 * Selecting always sets engine and modelId together, so the pair cannot drift,
 * and always records the choice as `preferredModelId`. An engine that cannot
 * currently run is still selectable — refusing the selection is what let a
 * capability probe override a person.
 */
function select(state, modelId) {
  const engine = engineForModel(modelId);
  assertPair(engine, modelId);
  return withStatus({
    ...state,
    rev: state.rev + 1,
    engine,
    modelId,
    preferredModelId: modelId,
  });
}

/**
 * Fold in an observed GPU capability.
 *
 * Only `'unusable'` — a probe that ran and found nothing — may override a
 * choice. `'indeterminate'` means we failed to ASK, which is not a fact about
 * the hardware, and treating it as one is what reported "no usable GPU on this
 * system" about a working 3090.
 */
function applyGpu(state, gpu) {
  const next = { ...state, rev: state.rev + 1, gpu };

  if (gpu === 'unusable' && next.engine === 'webgpu') {
    return {
      ...next,
      engine: 'local',
      modelId: DEFAULT_MODEL,
      status: 'unusable',
      reason: 'GPU unavailable on this system; using the CPU engine',
    };
  }

  const preferred = next.preferredModelId;
  if (gpu === 'usable' && preferred && engineForModel(preferred) === 'webgpu' && next.engine !== 'webgpu') {
    return { ...next, engine: 'webgpu', modelId: preferred, status: 'unknown', reason: null };
  }

  return next;
}

/**
 * Rebuild state from the persisted record.
 *
 * One door. The old three-branch precedence puzzle over three config files —
 * with two stale doors that outranked an explicit choice — collapses to: read,
 * repair, and only demote on a definitive negative.
 */
function restore(saved, { gpu = 'indeterminate' } = {}) {
  const base = (!saved || typeof saved.modelId !== 'string')
    ? createState({ gpu })
    : createState({
      ...saved,
      // Repair rather than trust: the model id is the source of truth for
      // routing, so a record whose engine disagrees is corrected, not honoured.
      engine: engineForModel(saved.modelId),
      gpu,
      preferredModelId: saved.modelId,
    });

  if (base.engine === 'webgpu' && gpu === 'unusable') {
    return {
      ...base,
      engine: 'local',
      modelId: DEFAULT_MODEL,
      status: 'unusable',
      reason: 'GPU unavailable on this system; using the CPU engine',
    };
  }

  return base;
}

/**
 * Fold in the renderer's report that its worker is (or is no longer) warm.
 *
 * This is the one fact main cannot observe: the orchestrator lives in the
 * renderer. Without it, `status` was created as 'unknown' and NOTHING ever
 * moved it, so a WebGPU selection was permanently unusable — the orchestrator
 * logged "Model loaded and ready" and the very next hotkey press still fell
 * back to CPU with "GPU model still loading". main received webgpu:model-ready
 * and only forwarded it to the model manager.
 */
function applyModelReady(state, ready) {
  const next = { ...state, rev: state.rev + 1 };
  // Readiness is a fact about the WebGPU worker specifically; it says nothing
  // about the CPU or remote engines.
  if (next.engine !== 'webgpu') return next;
  return { ...next, status: ready ? 'ready' : 'loading', reason: null };
}

module.exports = {
  DEFAULT_MODEL,
  applyModelReady,
  createState,
  engineForModel,
  assertPair,
  select,
  applyGpu,
  restore,
};
