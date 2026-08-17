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
     * Bytes in flight for `modelId`, or null. Non-null ONLY while
     * status === 'downloading' — see withStatus.
     *
     * `at` is a timestamp for a later "about 40s left"; nothing computes an ETA
     * yet. It is here because carrying one field costs nothing and adding it
     * later would be a second change to the shape.
     */
    progress: null,
    ...overrides,
  };
}

/**
 * Derive `status`/`reason` from the choice and the observed capability.
 *
 * This is the ONLY thing a capability may change. It answers "can the thing you
 * picked run right now", never "what are you running" — that question has
 * exactly one answer, the last model you clicked.
 */
function withStatus(state) {
  if (state.engine === 'webgpu' && state.gpu === 'unusable') {
    // A definitive negative outranks a download in flight: there is no point
    // reporting 47% toward a model this machine cannot run.
    return { ...state, status: 'unusable', reason: 'GPU unavailable on this system', progress: null };
  }
  // 'downloading' is a fact about the WebGPU worker. Any other engine holding it
  // is stale — and this is the ONE place that can be true, because select() and
  // restore() both funnel through here.
  //
  // Without this, switching GPU -> CPU at 47% wrote {engine:'local',
  // status:'downloading', progress:{pct:47}} to engine-state.json (switchModel
  // persists at engine-manager.js:573), and after a restart the popup read
  // "Downloading CPU model — 47%" forever with nothing downloading.
  const stale = state.status === 'downloading' && state.engine !== 'webgpu';
  const status = (state.status === 'unusable' || stale) ? 'unknown' : state.status;
  return { ...state, status, reason: null, progress: status === 'downloading' ? state.progress : null };
}

/**
 * Record an explicit user choice. This is the only authoritative write.
 *
 * Selecting always sets engine and modelId together, so the pair cannot drift.
 * An engine that cannot currently run is still selectable — refusing the
 * selection is what let a capability probe override a person.
 */
function select(state, modelId) {
  const engine = engineForModel(modelId);
  assertPair(engine, modelId);
  // Progress describes a download for the model that WAS selected. Choosing a
  // different one discards it — withStatus catches the webgpu -> other-engine
  // case, but not webgpu -> a different webgpu model, where the engine is
  // unchanged and the percentage would otherwise be attributed to the new pick.
  const movedOn = modelId !== state.modelId;
  return withStatus({
    ...state,
    rev: state.rev + 1,
    engine,
    modelId,
    status: movedOn && state.status === 'downloading' ? 'unknown' : state.status,
    progress: movedOn ? null : state.progress,
  });
}

/**
 * Fold in an observed GPU capability.
 *
 * It sets `gpu`, and through withStatus it may set `status`/`reason`. It does
 * NOT touch `engine` or `modelId` — a probe is not a selection.
 *
 * This used to rewrite a WebGPU choice to the CPU default whenever the probe
 * came back 'unusable', and rewrite it back again if the GPU returned. That is
 * the automatic switching that made the app unpredictable: the engine you were
 * on was decided by whatever probed last rather than by what you clicked, and
 * nothing on screen distinguished the two. Now an unusable GPU produces a
 * visible reason on the selection you actually made.
 *
 * `'indeterminate'` still means we failed to ASK, which is not a fact about the
 * hardware — treating it as one is what reported "no usable GPU on this system"
 * about a working 3090.
 */
function applyGpu(state, gpu) {
  return withStatus({ ...state, rev: state.rev + 1, gpu });
}

/**
 * Rebuild state from the persisted record.
 *
 * One door. The old three-branch precedence puzzle over three config files —
 * with two stale doors that outranked an explicit choice — collapses to: read,
 * repair the pair, and describe whether it can run.
 *
 * A restart is never allowed to be the moment the app changes engines on you.
 * Whatever you selected last is what you get back, even if the hardware to run
 * it has since gone away; in that case the record says so and the UI can tell
 * you, which is the honest version of what a silent demotion was hiding.
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
    });

  // Nothing is in flight at boot, by definition — so a persisted 'downloading'
  // is always a lie, even when the engine still matches. (It should never reach
  // disk: the progress handler deliberately does not persist. This is the belt
  // to that braces, because the record IS written on select and on restore.)
  const atBoot = base.status === 'downloading'
    ? { ...base, status: 'unknown', progress: null }
    : base;

  return withStatus(atBoot);
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
  // Either way the download is over: warm and ready, or back to a plain load
  // with no bytes being reported. A percentage that outlives its download is
  // the "stuck at 47%" complaint waiting to happen.
  return { ...next, status: ready ? 'ready' : 'loading', reason: null, progress: null };
}

/**
 * Fold in observed download progress for a specific model.
 *
 * THE GUARD IS THE POINT. It compares the payload's `modelId` against the
 * record — what this download is ABOUT — and NOT `state.engine === 'webgpu'`,
 * which is what `applyModelReady` above does. Keying on what happens to be
 * active rather than on what the operation concerns is the shape behind five
 * separate bugs in this codebase (the `activeAdapter` family), and this would
 * have been the sixth.
 *
 * Keying on the model id also buys two things for free: a late tick from a
 * superseded init cannot disturb the record, and a background prefetch for a
 * model the user has not selected is invisible by construction rather than by
 * a caller remembering to suppress it.
 *
 * Never persisted — the handler that calls this deliberately does not save.
 */
function applyDownloadProgress(state, { modelId, loaded, total, pct, at = Date.now() } = {}) {
  const next = { ...state, rev: state.rev + 1 };
  if (next.modelId !== modelId) return next;
  return { ...next, status: 'downloading', reason: null, progress: { loaded, total, pct, at } };
}

module.exports = {
  DEFAULT_MODEL,
  applyDownloadProgress,
  applyModelReady,
  createState,
  engineForModel,
  assertPair,
  select,
  applyGpu,
  restore,
};
