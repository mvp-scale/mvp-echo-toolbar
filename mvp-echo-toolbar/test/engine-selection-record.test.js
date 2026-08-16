/**
 * Items 17, 18, 19 — EngineManager reads ONE record instead of three configs.
 *
 * The case no existing test covers, and the one the maintainer hit: the user
 * explicitly picks English CPU while a working GPU is present and a stale
 * `webgpu-adapter-config.json` still names a WebGPU model. On the next start,
 * `_restoreModelSelection()` checks the WebGPU config FIRST and returns, so the
 * explicit choice is silently discarded.
 *
 * The five "Fix 9" tests all remain correct — they pin the three-state probe,
 * which is still right. What they never model is a LATER choice outranking an
 * EARLIER one, because with three independent config files there was nothing
 * recording which came last.
 *
 * These tests exercise the round trip: choose, restart, and check the choice
 * survived. Persistence is injected so the assertions are about logic, not I/O.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { installElectronStub, silenceLogger } = require('../testkit/electron-stub');

installElectronStub();
silenceLogger();

const { EngineManager } = require('../app/stt/engine-manager');

const WEBGPU_MODEL = 'webgpu-parakeet-0.6b';

/**
 * An EngineManager with faked adapters and an injected state store.
 *
 * `store` is shared between managers to model a restart: the same persisted
 * record, a fresh process.
 */
function makeManager({
  gpuHardware = true,
  store = { value: null },
  localAvailable = true,
  /**
   * A leftover entry in webgpu-adapter-config.json. This is the condition that
   * produced the reported bug and it MUST be modelled, or the test passes for
   * the wrong reason — the first draft of this file omitted it and every
   * assertion went green against the broken code.
   */
  staleWebgpuModel = null,
} = {}) {
  const mgr = new EngineManager();

  mgr.webgpuAdapter = {
    activeModelId: staleWebgpuModel,
    isAvailable: async () => ({ available: gpuHardware }),
    probeGpuCapability: async () => (gpuHardware ? 'available' : 'unavailable'),
    getConfig: () => ({ activeModelId: staleWebgpuModel, isConfigured: !!staleWebgpuModel }),
    getHealth: async () => ({ adapter: 'webgpu', state: 'unavailable' }),
    switchModel: async () => {},
  };

  mgr.remoteAdapter = {
    isAvailable: async () => ({ available: false, error: 'not configured' }),
    getConfig: () => ({ selectedModel: null, isConfigured: false }),
    getHealth: async () => ({ adapter: 'remote', state: 'unavailable' }),
    // Mirrors the real adapter, which throws when no endpoint is saved. A fake
    // that silently succeeded made the rejection test pass vacuously.
    switchModel: async () => { throw new Error('Remote endpoint not configured.'); },
  };

  mgr.localSidecarAdapter = {
    isAvailable: async () => ({ available: localAvailable }),
    getConfig: () => ({ activeModelId: 'local-fast' }),
    getHealth: async () => ({ adapter: 'local-sidecar', state: 'loaded' }),
    switchModel: async () => {},
  };

  mgr._cleanupOrphanedTempFiles = () => {};
  mgr._getHiddenWindow = () => null;
  // Injected persistence — the seam that makes a restart testable.
  mgr._loadEngineState = () => store.value;
  mgr._saveEngineState = (s) => { store.value = s; };

  return mgr;
}

describe('one record — an explicit choice cannot be outranked', () => {
  test('choosing CPU survives a restart, despite a working GPU AND a stale WebGPU config', async () => {
    // The exact reported failure. All three conditions are required: the user
    // chose CPU, the machine has a working GPU, and webgpu-adapter-config.json
    // still names a WebGPU model because nothing ever clears it.
    const store = { value: null };

    const first = makeManager({ gpuHardware: true, store, staleWebgpuModel: WEBGPU_MODEL });
    await first.initialize();
    await first.switchModel('local-fast');

    const second = makeManager({ gpuHardware: true, store, staleWebgpuModel: WEBGPU_MODEL });
    await second.initialize();

    assert.strictEqual(second.selectedModelId, 'local-fast',
      'a working GPU is not a reason to override someone who picked CPU');
    assert.strictEqual(second.activeAdapterName, 'local-sidecar');
  });

  test('choosing GPU survives a restart', async () => {
    const store = { value: null };

    const first = makeManager({ gpuHardware: true, store });
    await first.initialize();
    await first.switchModel(WEBGPU_MODEL);

    const second = makeManager({ gpuHardware: true, store });
    await second.initialize();

    assert.strictEqual(second.selectedModelId, WEBGPU_MODEL);
    assert.strictEqual(second.activeAdapterName, 'webgpu');
  });

  test('the LAST choice wins, not the highest-priority engine', async () => {
    const store = { value: null };

    const mgr = makeManager({ gpuHardware: true, store, staleWebgpuModel: WEBGPU_MODEL });
    await mgr.initialize();
    await mgr.switchModel(WEBGPU_MODEL);
    await mgr.switchModel('local-fast');

    const restarted = makeManager({ gpuHardware: true, store, staleWebgpuModel: WEBGPU_MODEL });
    await restarted.initialize();

    assert.strictEqual(restarted.selectedModelId, 'local-fast');
  });

  test('a saved GPU choice is demoted when the GPU is definitively absent', async () => {
    const store = { value: null };

    const first = makeManager({ gpuHardware: true, store });
    await first.initialize();
    await first.switchModel(WEBGPU_MODEL);

    const onWeakMachine = makeManager({ gpuHardware: false, store });
    await onWeakMachine.initialize();

    assert.strictEqual(onWeakMachine.activeAdapterName, 'local-sidecar',
      'a definitive negative may override; that part of Fix 9 still holds');
  });

  test('the active adapter always matches the selected model', async () => {
    // The invariant that kills wrong-adapter dispatch. Previously activeAdapter
    // and selectedModelId were independent fields that could disagree, which is
    // how audio captured for one engine reached another.
    const store = { value: null };
    const mgr = makeManager({ gpuHardware: true, store });
    await mgr.initialize();

    for (const id of [WEBGPU_MODEL, 'local-fast', WEBGPU_MODEL]) {
      await mgr.switchModel(id);
      const expected = id.startsWith('webgpu-') ? 'webgpu'
        : id.startsWith('local-') ? 'local-sidecar' : 'remote';
      assert.strictEqual(mgr.activeAdapterName, expected, `after selecting ${id}`);
    }
  });

  test('switching to a model rejects if the adapter cannot run it', async () => {
    const mgr = makeManager({ gpuHardware: true });
    await mgr.initialize();

    const result = await mgr.switchModel('definitely-not-a-real-model-id');

    // Remote is the catch-all engine, and it is not configured here, so this
    // must fail loudly rather than leave the manager on a broken adapter.
    assert.strictEqual(result.success, false);
    assert.ok(result.error, 'a failed switch must say why');
  });
});

describe('processAudio must route by the model it was given', () => {
  // Observed failure: planCapture correctly fell back to CPU and dispatched
  // model=local-fast, but EngineManager routed on this.activeAdapter — still
  // the WebGPU adapter, because that is what the user selected — so the audio
  // hit the main-process WebGPU adapter and threw "transcribe() called on
  // main-process adapter". The model parameter was accepted and ignored.
  test('a local- model resolves to the local adapter even while webgpu is selected', async () => {
    const mgr = makeManager({ gpuHardware: true });
    await mgr.initialize();
    await mgr.switchModel(WEBGPU_MODEL);

    assert.strictEqual(mgr._adapterForModel('local-fast'), mgr.localSidecarAdapter,
      'the recording was captured for CPU; it must be dispatched to CPU');
  });

  test('a webgpu- model resolves to the webgpu adapter', async () => {
    const mgr = makeManager({ gpuHardware: true });
    await mgr.initialize();

    assert.strictEqual(mgr._adapterForModel(WEBGPU_MODEL), mgr.webgpuAdapter);
  });

  test('no model falls back to the active adapter', async () => {
    const mgr = makeManager({ gpuHardware: true });
    await mgr.initialize();
    await mgr.switchModel('local-fast');

    assert.strictEqual(mgr._adapterForModel(undefined), mgr.activeAdapter);
  });
});
