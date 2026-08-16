/**
 * Fix 9 — engine selection must not let a stale saved preference override a
 * definitive live probe, WITHOUT breaking the cold-boot case.
 *
 * See _review/FIX-PLAN.md (DoD v2, Fix 9) and _review/recon/E-engine-selection.md.
 *
 * The subtlety these tests exist to pin down: `WebGpuBridgeAdapter.isAvailable()`
 * folds together two very different facts —
 *   1. GPU hardware capability          → knowable at initialize() time
 *   2. "model warm in renderer memory"  → NOT knowable at initialize() time,
 *      because the renderer only reports it via an IPC sent *after* it reads
 *      selectedModel back from `cloud:get-config`, which itself blocks on
 *      initialize() finishing. Closed cycle.
 *
 * So "defer to isAvailable()" is the WRONG fix — it would disable WebGPU on
 * every cold boot. Selection must key on hardware only, treating "not yet
 * knowable" as "trust the saved preference".
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const { installElectronStub, silenceLogger } = require('../testkit/electron-stub');

installElectronStub();
silenceLogger();

const { EngineManager } = require('../app/stt/engine-manager');

const WEBGPU_MODEL = 'webgpu-parakeet-0.6b';

/**
 * Build an EngineManager with all three adapters replaced by fakes.
 * The adapters are plain public fields, so no production seam is needed.
 *
 * @param {object} opts
 * @param {boolean} opts.gpuHardware   - is a usable GPU physically present
 * @param {boolean} opts.modelWarm     - has the renderer reported the model loaded
 * @param {string|null} opts.savedWebgpuModel - persisted WebGPU preference
 * @param {boolean} opts.localAvailable
 */
function makeManager({
  gpuHardware,
  modelWarm,
  savedWebgpuModel = null,
  localAvailable = true,
  remoteSelectedModel = null,
}) {
  const mgr = new EngineManager();

  mgr.webgpuAdapter = {
    activeModelId: savedWebgpuModel,
    // Mirrors the real adapter: unavailable if EITHER the GPU is missing OR
    // the model isn't warm in the renderer yet.
    isAvailable: async () => {
      if (!gpuHardware) return { available: false, error: 'WebGPU not available on this system' };
      if (!savedWebgpuModel || !modelWarm) return { available: false, error: 'WebGPU model not downloaded' };
      return { available: true };
    },
    // Hardware-only probe — the seam Fix 9 needs. Three-state.
    probeGpuCapability: async () => (gpuHardware ? 'available' : 'unavailable'),
    getConfig: () => ({ activeModelId: savedWebgpuModel, isConfigured: !!savedWebgpuModel }),
    getHealth: async () => ({ adapter: 'webgpu', state: 'unavailable' }),
  };

  mgr.remoteAdapter = {
    isAvailable: async () => ({ available: false, error: 'not configured' }),
    getConfig: () => ({ selectedModel: remoteSelectedModel, isConfigured: !!remoteSelectedModel }),
    getHealth: async () => ({ adapter: 'remote', state: 'unavailable' }),
  };

  mgr.localSidecarAdapter = {
    isAvailable: async () => ({ available: localAvailable }),
    getConfig: () => ({ activeModelId: 'local-fast' }),
    getHealth: async () => ({ adapter: 'local-sidecar', state: 'loaded' }),
  };

  mgr.activeAdapter = mgr.remoteAdapter;
  mgr._cleanupOrphanedTempFiles = () => {};

  // Isolate persistence per manager. _restoreModelSelection now WRITES the
  // record (so migration happens exactly once rather than on every boot), and
  // without this each test would leave a real engine-state.json in the stub's
  // userData for the next one to read — these tests are about selection logic,
  // not I/O.
  let persisted = null;
  mgr._loadEngineState = () => persisted;
  mgr._saveEngineState = (s) => { persisted = s; };

  return mgr;
}

describe('Fix 9 — engine selection vs. stale WebGPU preference', () => {
  test('does NOT select WebGPU when the GPU is definitively absent', async () => {
    // The bug: a saved webgpu preference from a prior session overrides a live
    // probe that correctly says this machine has no usable GPU, leaving the
    // user with a dead hotkey while a working local engine sits idle.
    const mgr = makeManager({
      gpuHardware: false,
      modelWarm: false,
      savedWebgpuModel: WEBGPU_MODEL,
      localAvailable: true,
    });

    await mgr.initialize();

    assert.notStrictEqual(
      mgr.activeAdapterName,
      'webgpu',
      'must not activate WebGPU when the GPU is definitively unavailable',
    );
    assert.strictEqual(mgr.activeAdapterName, 'local-sidecar');
    assert.ok(
      !String(mgr.selectedModelId).startsWith('webgpu-'),
      `selectedModelId should not be a webgpu model, got "${mgr.selectedModelId}"`,
    );
  });

  test('DOES restore WebGPU on cold boot when the GPU is present but the model is not yet warm', async () => {
    // The regression guard. At initialize() time the renderer has not yet
    // reported the model loaded — and structurally cannot have. Treating that
    // as "unavailable" would disable WebGPU on every single cold boot.
    const mgr = makeManager({
      gpuHardware: true,
      modelWarm: false, // renderer still booting — the normal cold-boot state
      savedWebgpuModel: WEBGPU_MODEL,
      localAvailable: true,
    });

    await mgr.initialize();

    assert.strictEqual(
      mgr.activeAdapterName,
      'webgpu',
      'a saved WebGPU preference must survive cold boot when the hardware is present',
    );
    assert.strictEqual(mgr.selectedModelId, WEBGPU_MODEL);
  });

  test('selects WebGPU when hardware is present and the model is warm', async () => {
    const mgr = makeManager({
      gpuHardware: true,
      modelWarm: true,
      savedWebgpuModel: WEBGPU_MODEL,
    });

    await mgr.initialize();

    assert.strictEqual(mgr.activeAdapterName, 'webgpu');
    assert.strictEqual(mgr.selectedModelId, WEBGPU_MODEL);
  });

  test('does NOT select WebGPU via the remote-config fallthrough when the GPU is absent', async () => {
    // Second door into the same bug: even with the webgpu-config branch gated,
    // the remote adapter's persisted selectedModel can itself be a "webgpu-*"
    // id, and that branch activates the WebGPU adapter on a plain string
    // prefix with no capability check at all.
    const mgr = makeManager({
      gpuHardware: false,
      modelWarm: false,
      savedWebgpuModel: WEBGPU_MODEL,
      remoteSelectedModel: WEBGPU_MODEL,
      localAvailable: true,
    });

    await mgr.initialize();

    assert.notStrictEqual(
      mgr.activeAdapterName,
      'webgpu',
      'the remote-config fallthrough must respect the GPU probe too',
    );
  });

  test('falls through to local when there is no saved WebGPU preference at all', async () => {
    const mgr = makeManager({
      gpuHardware: true,
      modelWarm: false,
      savedWebgpuModel: null,
      localAvailable: true,
    });

    await mgr.initialize();

    assert.strictEqual(mgr.activeAdapterName, 'local-sidecar');
  });
});
