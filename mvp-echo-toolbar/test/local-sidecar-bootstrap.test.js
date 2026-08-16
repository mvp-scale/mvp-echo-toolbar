/**
 * Item 12 — the bundled CPU engine must adopt its own pre-baked model.
 *
 * `activeModelId` starts null in the constructor and only switchModel() or
 * configure() ever set it. So on a fresh profile the CPU engine reported
 * itself unavailable even though `model.int8.onnx` and `tokens.txt` were
 * sitting on disk inside the bundle.
 *
 * That is not a cosmetic defect: it removes the bottom rung of the fallback
 * ladder. EngineManager.initialize() falls through webgpu -> remote -> local
 * -> remote-as-fallback, so a machine with no usable GPU skipped the CPU
 * engine that was ready to run and landed on an unconfigured remote adapter.
 * Reachable on Electron 28, on any fresh install, before the user touches a
 * single setting — which is why "just pick CPU" was never the escape hatch it
 * appeared to be.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { installElectronStub, silenceLogger } = require('../testkit/electron-stub');

installElectronStub();
silenceLogger();

const LocalSidecarAdapter = require('../app/stt/adapters/local-sidecar-adapter');
const { MODEL_ID } = require('../app/stt/local-model-manager');

/**
 * An adapter with a stubbed model manager and no disk writes.
 * `modelManager` is a plain field, so substitution needs no new seam.
 */
function makeAdapter({ binary = '/fake/sherpa.exe', modelOnDisk = true } = {}) {
  const adapter = new LocalSidecarAdapter();
  const saves = [];
  adapter.activeModelId = null; // fresh profile
  adapter.modelManager = {
    getBinaryPath: () => binary,
    isModelDownloaded: (id) => modelOnDisk && (!id || id === MODEL_ID),
    getModelPath: () => '/fake/model-dir',
    listModels: () => [{ id: MODEL_ID, label: 'English CPU', group: 'local', downloaded: modelOnDisk }],
  };
  adapter._saveConfig = () => saves.push(adapter.activeModelId);
  return { adapter, saves };
}

describe('LocalSidecarAdapter — bootstraps the pre-baked model', () => {
  test('a fresh profile with the model on disk reports AVAILABLE', async () => {
    const { adapter } = makeAdapter();

    const result = await adapter.isAvailable();

    assert.strictEqual(result.available, true,
      'the model is on disk; reporting unavailable removes the only safe fallback');
  });

  test('the adopted model is recorded, so routing has something to name', async () => {
    const { adapter } = makeAdapter();

    await adapter.isAvailable();

    assert.strictEqual(adapter.activeModelId, MODEL_ID);
  });

  test('the adoption is persisted, so it survives a restart', async () => {
    const { adapter, saves } = makeAdapter();

    await adapter.isAvailable();

    assert.deepStrictEqual(saves, [MODEL_ID]);
  });

  test('transcribe() does not refuse on a fresh profile', async () => {
    const { adapter } = makeAdapter();

    // Reaching the spawn is success here; we only assert it got PAST the
    // "no model selected" guard, which is what used to reject immediately.
    await assert.rejects(
      () => adapter.transcribe('/tmp/does-not-exist.wav'),
      (err) => {
        assert.doesNotMatch(err.message, /No local model selected/,
          'the pre-baked model should have been adopted before this check');
        return true;
      },
    );
  });

  test('an explicit user selection is never overwritten', async () => {
    const { adapter, saves } = makeAdapter();
    adapter.activeModelId = 'some-other-model';

    await adapter.isAvailable();

    assert.strictEqual(adapter.activeModelId, 'some-other-model');
    assert.deepStrictEqual(saves, [], 'nothing to persist when a choice already exists');
  });

  test('no model on disk still reports unavailable', async () => {
    const { adapter } = makeAdapter({ modelOnDisk: false });

    const result = await adapter.isAvailable();

    assert.strictEqual(result.available, false, 'adoption must require the files to exist');
    assert.strictEqual(adapter.activeModelId, null);
  });

  test('a missing binary still reports unavailable', async () => {
    const { adapter } = makeAdapter({ binary: null });

    const result = await adapter.isAvailable();

    assert.strictEqual(result.available, false);
  });
});
