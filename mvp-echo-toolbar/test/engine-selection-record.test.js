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
    configure: () => {},
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

  test('a saved GPU choice is kept when the GPU is definitively absent', async () => {
    // Previously this demoted to the CPU engine. That was the automatic
    // switching: you picked GPU, and a restart on a machine whose probe failed
    // put you on CPU with nothing on screen saying so. Now the selection stands
    // and the record carries the reason it cannot run.
    const store = { value: null };

    const first = makeManager({ gpuHardware: true, store });
    await first.initialize();
    await first.switchModel(WEBGPU_MODEL);

    const onWeakMachine = makeManager({ gpuHardware: false, store });
    await onWeakMachine.initialize();

    assert.strictEqual(onWeakMachine.selectedModelId, WEBGPU_MODEL,
      'a restart must not silently move the user to another engine');
    assert.strictEqual(onWeakMachine.activeAdapterName, 'webgpu');
    assert.strictEqual(onWeakMachine.state.status, 'unusable');
    assert.ok(onWeakMachine.state.reason, 'the UI needs something to show the user');
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

  test('a failed server call does not throw the selection away', async () => {
    // The fake remote adapter throws, exactly as the real one does against a
    // server with no /v1/models/switch route — MVP-Bridge 1.0.0 returns 404 for
    // it, and its own openapi.json lists only /health, /v1/models and
    // /v1/audio/transcriptions. Committing the selection only AFTER that call
    // succeeded meant clicking the hosted model appeared to do nothing at all.
    const store = { value: null };
    const mgr = makeManager({ gpuHardware: true, store });
    await mgr.initialize();

    const result = await mgr.switchModel('parakeet-tdt-0.6b-v2-int8');

    assert.strictEqual(mgr.selectedModelId, 'parakeet-tdt-0.6b-v2-int8',
      'the click IS the selection; a server refusing to switch does not undo it');
    assert.strictEqual(mgr.activeAdapterName, 'remote');
    assert.strictEqual(store.value.modelId, 'parakeet-tdt-0.6b-v2-int8',
      'and it is persisted immediately, not on success of a network call');
    assert.ok(result.warning, 'but the failure must be reported, never swallowed');
  });

  test('a hosted selection survives a restart even when the switch call failed', async () => {
    const store = { value: null };

    const first = makeManager({ gpuHardware: true, store });
    await first.initialize();
    await first.switchModel('parakeet-tdt-0.6b-v2-int8');

    const second = makeManager({ gpuHardware: true, store });
    await second.initialize();

    assert.strictEqual(second.selectedModelId, 'parakeet-tdt-0.6b-v2-int8');
    assert.strictEqual(second.activeAdapterName, 'remote');
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

describe('WebM to WAV conversion must follow the dispatch, not the selection', () => {
  // Second half of the routing fix, and a hole the first half opened. Dispatch
  // was changed to route by options.model, but the ffmpeg conversion still
  // keyed off activeAdapterName. So with WebGPU selected and the renderer
  // correctly falling back to CPU, sherpa-onnx received a raw .webm:
  //   wave-reader.cc: Expected chunk_id RIFF. Given: 0xa3df451a
  test('a local- dispatch needs WAV even while webgpu is the active adapter', async () => {
    const mgr = makeManager({ gpuHardware: true });
    await mgr.initialize();
    await mgr.switchModel(WEBGPU_MODEL);

    assert.strictEqual(mgr._needsWavConversion('local-fast'), true,
      'the sidecar only reads WAV; the active adapter is irrelevant to that');
  });

  test('a webgpu- dispatch does not', async () => {
    const mgr = makeManager({ gpuHardware: true });
    await mgr.initialize();

    assert.strictEqual(mgr._needsWavConversion(WEBGPU_MODEL), false);
  });

  test('with no model named, it follows the active adapter', async () => {
    const mgr = makeManager({ gpuHardware: true });
    await mgr.initialize();
    await mgr.switchModel('local-fast');

    assert.strictEqual(mgr._needsWavConversion(undefined), true);
  });
});

describe('the migrated record must be persisted, not just applied', () => {
  // Found on Windows: engine-state.json did not exist after many launches.
  // _restoreModelSelection applied the migrated record in memory and never
  // saved it, so migration re-ran on EVERY boot using the old precedence —
  // which reads the stale webgpu config first. An existing user who had chosen
  // CPU would therefore be silently moved to GPU on upgrade, and stay there
  // until they manually switched models. The original bug, via the upgrade path.
  test('a migration writes the record so it happens exactly once', async () => {
    const store = { value: null };
    const mgr = makeManager({ gpuHardware: true, store, staleWebgpuModel: WEBGPU_MODEL });

    await mgr.initialize();

    assert.ok(store.value, 'the migrated record must be saved on first run');
    assert.strictEqual(store.value.modelId, WEBGPU_MODEL);
  });

  test('the second launch reads the record and does NOT re-migrate', async () => {
    const store = { value: null };

    const first = makeManager({ gpuHardware: true, store, staleWebgpuModel: WEBGPU_MODEL });
    await first.initialize();
    await first.switchModel('local-fast');

    // Legacy config still names WebGPU — as it does on the real machine, since
    // nothing ever clears it. The saved record must win.
    const second = makeManager({ gpuHardware: true, store, staleWebgpuModel: WEBGPU_MODEL });
    await second.initialize();

    assert.strictEqual(second.selectedModelId, 'local-fast',
      'once migrated, the stale legacy config must never be consulted again');
  });

  test('a restore with no legacy config at all still persists the default', async () => {
    const store = { value: null };
    const mgr = makeManager({ gpuHardware: true, store });

    await mgr.initialize();

    assert.ok(store.value, 'even the default should be written, so boot is deterministic');
  });
});

describe('endpoint config and connection tests belong to the REMOTE adapter', () => {
  // Found on Windows: the endpoint was configured, the log confirmed the URL,
  // and switching to a hosted model still failed with "Remote endpoint not
  // configured". cloud:configure called this.activeAdapter.configure() — which
  // was the local sidecar, whose configure() reads only activeModelId and drops
  // endpointUrl. The remote adapter never received it. cloud:test-connection had
  // the same bug, so "Test Connection" was testing the CPU engine and would
  // report success regardless of the endpoint.
  test('configureEndpoint always reaches the remote adapter, whatever is active', async () => {
    const mgr = makeManager({ gpuHardware: true });
    await mgr.initialize();
    await mgr.switchModel('local-fast');           // active adapter is now local
    let received = null;
    mgr.remoteAdapter.configure = (c) => { received = c; };

    mgr.configureEndpoint({ endpointUrl: 'http://192.168.1.169:20300/v1/audio/transcriptions' });

    assert.ok(received, 'the remote adapter must receive endpoint config');
    assert.match(received.endpointUrl, /192\.168\.1\.169/);
  });

  test('testConnection probes the remote adapter, not whatever is active', async () => {
    const mgr = makeManager({ gpuHardware: true });
    await mgr.initialize();
    await mgr.switchModel('local-fast');
    let probed = false;
    mgr.remoteAdapter.isAvailable = async () => { probed = true; return { available: true }; };

    await mgr.testConnection();

    assert.strictEqual(probed, true,
      'testing the ACTIVE adapter reports the CPU engine is fine and tells the user nothing');
  });
});
