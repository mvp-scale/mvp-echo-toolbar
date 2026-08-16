/**
 * Item 29 — one authoritative record of which engine is selected.
 *
 * Today "which engine/model is selected" lives in seven places that disagree.
 * Captured live on the maintainer's machine, all three config files at once:
 *
 *   local-sidecar-config.json    -> local-fast
 *   webgpu-adapter-config.json   -> webgpu-parakeet-0.6b
 *   toolbar-endpoint-config.json -> parakeet-tdt-0.6b-v2-int8
 *
 * Nothing reconciles them, and `_restoreModelSelection()` picks between them by
 * a hardcoded precedence rather than by which the user actually chose last —
 * so a stale WebGPU entry outranks an explicit CPU selection on every restart.
 *
 * This module is the single record plus its transitions, as pure functions:
 * no Electron, no filesystem, no adapters. Everything else derives from it.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  createState,
  assertPair,
  engineForModel,
  select,
  applyGpu,
  restore,
} = require('../app/stt/engine-state');

describe('engineForModel — the id namespace is the routing table', () => {
  test('webgpu- ids route to the webgpu engine', () => {
    assert.strictEqual(engineForModel('webgpu-parakeet-0.6b'), 'webgpu');
  });

  test('local- ids route to the local engine', () => {
    assert.strictEqual(engineForModel('local-fast'), 'local');
  });

  test('anything else is remote', () => {
    assert.strictEqual(engineForModel('parakeet-tdt-0.6b-v2-int8'), 'remote');
    assert.strictEqual(engineForModel('gpu-english'), 'remote');
  });
});

describe('assertPair — the invariant that kills wrong-adapter dispatch', () => {
  test('accepts a matching engine and model', () => {
    assert.doesNotThrow(() => assertPair('webgpu', 'webgpu-parakeet-0.6b'));
    assert.doesNotThrow(() => assertPair('local', 'local-fast'));
  });

  test('rejects a model that belongs to a different engine', () => {
    // This is the mismatch that reached the main-process WebGPU adapter and
    // threw "transcribe() called on main-process adapter" — which then logged
    // as {} and cost an entire debugging session.
    assert.throws(() => assertPair('webgpu', 'local-fast'), /webgpu-parakeet|local-fast|mismatch/i);
  });

  test('names both sides, so the log says what disagreed', () => {
    try {
      assertPair('local', 'webgpu-parakeet-0.6b');
      assert.fail('should have thrown');
    } catch (err) {
      assert.match(err.message, /local/);
      assert.match(err.message, /webgpu-parakeet-0\.6b/);
    }
  });
});

describe('select — an explicit choice is authoritative', () => {
  test('selecting a model sets both engine and model together', () => {
    const s = select(createState(), 'local-fast');

    assert.strictEqual(s.engine, 'local');
    assert.strictEqual(s.modelId, 'local-fast');
  });

  test('every accepted write bumps rev', () => {
    const a = createState();
    const b = select(a, 'local-fast');
    const c = select(b, 'webgpu-parakeet-0.6b');

    assert.ok(b.rev > a.rev, 'rev must advance');
    assert.ok(c.rev > b.rev);
  });

  test('the previous state is not mutated', () => {
    const a = select(createState(), 'local-fast');
    select(a, 'webgpu-parakeet-0.6b');

    assert.strictEqual(a.modelId, 'local-fast', 'transitions must be pure');
  });

  test('CHOOSING CPU CLEARS THE WEBGPU SELECTION', () => {
    // The reported bug, at its root: picking CPU left webgpu-adapter-config.json
    // holding a stale model id, which then outranked the CPU choice on restart.
    // With one record there is nothing left to go stale.
    const gpu = select(createState(), 'webgpu-parakeet-0.6b');
    const cpu = select(gpu, 'local-fast');

    assert.strictEqual(cpu.engine, 'local');
    assert.strictEqual(cpu.modelId, 'local-fast');
  });

  test('an unusable engine is still selectable, and says why', () => {
    // Selecting is the user's call. Whether it can RUN is a separate axis --
    // conflating them is what let a probe override an explicit choice.
    const s = select(createState({ gpu: 'unusable' }), 'webgpu-parakeet-0.6b');

    assert.strictEqual(s.modelId, 'webgpu-parakeet-0.6b');
    assert.strictEqual(s.status, 'unusable');
    assert.ok(s.reason, 'an unusable status must carry a human-readable reason');
  });
});

describe('applyGpu — only a definitive negative may override the user', () => {
  test('indeterminate never overrides an explicit choice', () => {
    // A TypeError from a removed API is "we could not ask", not "no GPU".
    const chosen = select(createState(), 'webgpu-parakeet-0.6b');
    const after = applyGpu(chosen, 'indeterminate');

    assert.strictEqual(after.modelId, 'webgpu-parakeet-0.6b');
    assert.strictEqual(after.engine, 'webgpu');
  });

  test('a definitive unusable GPU demotes to local, and records why', () => {
    const chosen = select(createState(), 'webgpu-parakeet-0.6b');
    const after = applyGpu(chosen, 'unusable');

    assert.strictEqual(after.engine, 'local');
    assert.match(after.reason, /gpu/i, 'the demotion must explain itself');
  });

  test('a demotion remembers the original choice so it can be restored', () => {
    const chosen = select(createState(), 'webgpu-parakeet-0.6b');
    const demoted = applyGpu(chosen, 'unusable');
    const recovered = applyGpu(demoted, 'usable');

    assert.strictEqual(recovered.modelId, 'webgpu-parakeet-0.6b',
      'a GPU that comes back should restore the choice the user actually made');
  });

  test('a usable GPU does not disturb a deliberate local choice', () => {
    const cpu = select(createState(), 'local-fast');
    const after = applyGpu(cpu, 'usable');

    assert.strictEqual(after.modelId, 'local-fast',
      'having a GPU is not a reason to override someone who picked CPU');
  });
});

describe('restore — one door, not three', () => {
  test('a valid persisted record is restored as-is', () => {
    const saved = { rev: 7, engine: 'local', modelId: 'local-fast' };

    const s = restore(saved, { gpu: 'usable' });

    assert.strictEqual(s.modelId, 'local-fast');
  });

  test('a corrupt pair is repaired from the model id, not trusted', () => {
    const saved = { rev: 3, engine: 'webgpu', modelId: 'local-fast' };

    const s = restore(saved, { gpu: 'usable' });

    assert.strictEqual(s.engine, 'local', 'the model id is the source of truth for routing');
  });

  test('nothing persisted falls back to the bundled CPU engine', () => {
    const s = restore(null, { gpu: 'usable' });

    assert.strictEqual(s.engine, 'local',
      'the safe default is the engine that ships in the box');
  });

  test('a saved GPU choice survives an indeterminate probe on cold boot', () => {
    // The renderer that answers the probe cannot be up yet at restore time, so
    // "unknown" must mean "trust the saved preference" or WebGPU would be
    // disabled on every cold boot.
    const saved = { rev: 9, engine: 'webgpu', modelId: 'webgpu-parakeet-0.6b' };

    const s = restore(saved, { gpu: 'indeterminate' });

    assert.strictEqual(s.modelId, 'webgpu-parakeet-0.6b');
  });

  test('a saved GPU choice is demoted when the GPU is definitively absent', () => {
    const saved = { rev: 9, engine: 'webgpu', modelId: 'webgpu-parakeet-0.6b' };

    const s = restore(saved, { gpu: 'unusable' });

    assert.strictEqual(s.engine, 'local');
    assert.ok(s.reason);
  });
});

describe('applyModelReady — the renderer reports readiness UP', () => {
  // Observed failure: the orchestrator logged "Model loaded and ready", yet
  // planCapture fell back to CPU with "GPU model still loading" on the very
  // next hotkey press. state.status was created as 'unknown' and NOTHING ever
  // moved it to 'ready' — main received webgpu:model-ready and only forwarded
  // it to the model manager. So the WebGPU path could never be taken.
  const { applyModelReady } = require('../app/stt/engine-state');

  test('a ready report makes a webgpu selection actually usable', () => {
    const chosen = select(createState(), 'webgpu-parakeet-0.6b');

    const after = applyModelReady(chosen, true);

    assert.strictEqual(after.status, 'ready',
      'without this the GPU engine is selected but permanently unusable');
  });

  test('a not-ready report moves it back to loading', () => {
    const ready = applyModelReady(select(createState(), 'webgpu-parakeet-0.6b'), true);

    const after = applyModelReady(ready, false);

    assert.strictEqual(after.status, 'loading');
  });

  test('it bumps rev so the record is broadcast', () => {
    const chosen = select(createState(), 'webgpu-parakeet-0.6b');

    assert.ok(applyModelReady(chosen, true).rev > chosen.rev);
  });

  test('it does not disturb a local selection', () => {
    const cpu = select(createState(), 'local-fast');

    const after = applyModelReady(cpu, true);

    assert.strictEqual(after.modelId, 'local-fast');
    assert.strictEqual(after.engine, 'local');
  });
});
