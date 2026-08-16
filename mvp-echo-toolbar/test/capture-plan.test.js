/**
 * Items 15 & 16 — the capture routing decision, as a pure function.
 *
 * Two bugs, one cause. Routing was decided in two different places at two
 * different times:
 *
 *   record start  CaptureApp.tsx:561  useRawPcm = orchestrator.isReady()
 *   record stop   CaptureApp.tsx:428  selectedModelRef refreshed from config
 *
 * So a recording begun under local-fast was dispatched under
 * webgpu-parakeet-0.6b and thrown away ("transcribe() called on main-process
 * adapter"), and a hotkey press with the GPU model still loading was refused
 * outright with no fallback and no visible reason.
 *
 * The rule is NOT "never latch" — deriving again at stop time is precisely what
 * lost the audio. It is: derive ONCE at record start, freeze it into that
 * recording's context, and use the frozen value at stop. A recording is a unit
 * of work and carries its own routing. A model switch mid-recording affects the
 * NEXT recording, not the one in flight.
 *
 * Pure: no React, no DOM, no Electron. That is what makes it testable, and the
 * fact that it was not testable before is why it was not correct.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { planCapture } = require('../app/stt/capture-plan');
const { createState, select } = require('../app/stt/engine-state');

const WEBGPU = 'webgpu-parakeet-0.6b';

describe('planCapture — routing frozen at record start', () => {
  test('a ready WebGPU engine records raw PCM for in-renderer inference', () => {
    const state = { ...select(createState(), WEBGPU), status: 'ready' };

    const plan = planCapture(state, { orchestratorReady: true });

    assert.strictEqual(plan.engine, 'webgpu');
    assert.strictEqual(plan.modelId, WEBGPU);
    assert.strictEqual(plan.mode, 'raw-pcm');
  });

  test('the CPU engine records webm for the main-process sidecar', () => {
    const state = select(createState(), 'local-fast');

    const plan = planCapture(state, { orchestratorReady: false });

    assert.strictEqual(plan.engine, 'local');
    assert.strictEqual(plan.mode, 'webm');
  });

  test('a remote engine records webm', () => {
    const state = select(createState(), 'parakeet-tdt-0.6b-v2-int8');

    const plan = planCapture(state, { orchestratorReady: false });

    assert.strictEqual(plan.engine, 'remote');
    assert.strictEqual(plan.mode, 'webm');
  });
});

describe('planCapture — GPU selected but not ready falls back to CPU', () => {
  // The chosen behaviour: never block, never lose speech. The GPU selection is
  // left intact so the next recording uses it.

  test('falls back to the CPU engine rather than refusing the press', () => {
    const state = { ...select(createState(), WEBGPU), status: 'loading' };

    const plan = planCapture(state, { orchestratorReady: false });

    assert.strictEqual(plan.engine, 'local', 'a dead hotkey is worse than a slower transcript');
    assert.strictEqual(plan.mode, 'webm');
  });

  test('the fallback explains itself, so the tray and log can say why', () => {
    const state = { ...select(createState(), WEBGPU), status: 'loading' };

    const plan = planCapture(state, { orchestratorReady: false });

    assert.ok(plan.reason, 'a silent downgrade is how this went unnoticed for a release');
    assert.match(plan.reason, /gpu|load|ready/i);
  });

  test('the GPU selection is NOT altered by the fallback', () => {
    const state = { ...select(createState(), WEBGPU), status: 'loading' };

    const plan = planCapture(state, { orchestratorReady: false });

    assert.strictEqual(plan.selectedModelId, WEBGPU,
      'falling back for one recording must not rewrite what the user chose');
  });

  test('no fallback once the orchestrator reports ready', () => {
    const state = { ...select(createState(), WEBGPU), status: 'ready' };

    const plan = planCapture(state, { orchestratorReady: true });

    assert.strictEqual(plan.engine, 'webgpu');
    assert.strictEqual(plan.reason, null);
  });

  test('a definitively unusable GPU also falls back, without a dead hotkey', () => {
    const state = { ...select(createState({ gpu: 'unusable' }), WEBGPU) };

    const plan = planCapture(state, { orchestratorReady: false });

    assert.strictEqual(plan.engine, 'local');
    assert.ok(plan.reason);
  });
});

describe('planCapture — the plan is immutable and self-contained', () => {
  test('it carries everything stop needs, so nothing is re-derived later', () => {
    const state = { ...select(createState(), WEBGPU), status: 'ready' };

    const plan = planCapture(state, { orchestratorReady: true });

    for (const key of ['engine', 'modelId', 'mode']) {
      assert.ok(plan[key] !== undefined, `plan must carry ${key}`);
    }
  });

  test('a later state change cannot alter a plan already made', () => {
    // The lost-recording bug, stated as an invariant: the plan is a value, not
    // a view onto mutable state.
    const before = { ...select(createState(), 'local-fast'), status: 'ready' };
    const plan = planCapture(before, { orchestratorReady: false });

    select(before, WEBGPU); // user switches mid-recording

    assert.strictEqual(plan.engine, 'local');
    assert.strictEqual(plan.mode, 'webm');
  });

  test('the plan is frozen, so nothing downstream can mutate it', () => {
    const state = select(createState(), 'local-fast');

    const plan = planCapture(state, { orchestratorReady: false });

    assert.ok(Object.isFrozen(plan));
  });
});
