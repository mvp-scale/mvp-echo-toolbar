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
 */

const { DEFAULT_MODEL } = require('./engine-state');

/**
 * @param {object} state            the authoritative EngineState record
 * @param {object} opts
 * @param {boolean} opts.orchestratorReady  has the renderer's worker finished loading
 * @returns {Readonly<{engine: string, modelId: string, mode: string, selectedModelId: string, reason: string|null}>}
 */
function planCapture(state, { orchestratorReady = false } = {}) {
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
      engine: 'local',
      modelId: DEFAULT_MODEL,
      mode: 'webm',
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
    mode: state.engine === 'webgpu' ? 'raw-pcm' : 'webm',
    selectedModelId,
    reason: null,
  });
}

module.exports = { planCapture };
