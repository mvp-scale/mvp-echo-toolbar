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

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

import { planCapture, FALLBACK_MODEL } from '../app/renderer/app/capture-plan.ts';

// engine-state is CommonJS because the main process requires it.
const require = createRequire(import.meta.url);
const {
  createState, select, DEFAULT_MODEL, applyModelReady, applyGpu, applyDownloadProgress,
} = require('../app/stt/engine-state');

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

describe('planCapture — GPU selected but not ready BLOCKS, it does not substitute', () => {
  // Reversed 2026-08-16, on the maintainer's instruction, after watching it
  // happen: "You have to wait and download the GPU, not automatically convert
  // it and say GPU but yet use CPU."
  //
  // These tests previously asserted the substitution was correct, on the theory
  // that a dead hotkey is worse than a slower transcript. In practice the app
  // reported GPU on the tray and in Settings while every word went through the
  // CPU engine, and nothing on screen said otherwise. Silently using an engine
  // the user did not choose is the failure; refusing and saying why is not.

  test('it does NOT substitute the CPU engine', () => {
    const state = { ...select(createState(), WEBGPU), status: 'loading' };

    const plan = planCapture(state, { orchestratorReady: false });

    assert.strictEqual(plan.blocked, true, 'the press must not produce a recording');
    assert.strictEqual(plan.engine, 'webgpu', 'and the engine reported must be the one chosen');
    assert.notStrictEqual(plan.modelId, 'local-fast');
  });

  test('it explains itself, so the tray and log can say why', () => {
    const state = { ...select(createState(), WEBGPU), status: 'loading' };

    const plan = planCapture(state, { orchestratorReady: false });

    assert.ok(plan.reason, 'refusing without a reason is just a dead hotkey');
    assert.match(plan.reason, /gpu|load|ready/i);
  });

  test('the GPU selection is NOT altered', () => {
    const state = { ...select(createState(), WEBGPU), status: 'loading' };

    const plan = planCapture(state, { orchestratorReady: false });

    assert.strictEqual(plan.selectedModelId, WEBGPU,
      'being unable to record must not rewrite what the user chose');
  });

  test('it proceeds normally once the orchestrator reports ready', () => {
    const state = { ...select(createState(), WEBGPU), status: 'ready' };

    const plan = planCapture(state, { orchestratorReady: true });

    assert.strictEqual(plan.engine, 'webgpu');
    assert.strictEqual(plan.blocked, false);
    assert.strictEqual(plan.reason, null);
  });

  test('a definitively unusable GPU blocks too, and points at the fix', () => {
    const state = { ...select(createState({ gpu: 'unusable' }), WEBGPU) };

    const plan = planCapture(state, { orchestratorReady: false });

    assert.strictEqual(plan.blocked, true);
    assert.strictEqual(plan.engine, 'webgpu', 'still not silently moved elsewhere');
    assert.match(plan.reason, /settings|cpu/i,
      'a blocked press must tell the user what THEY can do about it');
  });

  test('a non-GPU selection is never blocked by orchestrator readiness', () => {
    const state = { ...select(createState(), 'local-fast'), status: 'ready' };

    const plan = planCapture(state, { orchestratorReady: false });

    assert.strictEqual(plan.blocked, false);
    assert.strictEqual(plan.engine, 'local');
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

describe('capture-plan / engine-state must agree on the fallback model', () => {
  test('FALLBACK_MODEL equals engine-state DEFAULT_MODEL', () => {
    // The constant is duplicated deliberately: engine-state is CommonJS (main
    // requires it) and importing it into this ESM renderer module reintroduces
    // the Rollup named-export problem that broke `vite build`. This test is what
    // makes the duplication safe.
    assert.strictEqual(FALLBACK_MODEL, DEFAULT_MODEL);
  });
});

describe('planCapture — a wait is not an error, and each wait says what it is', () => {
  // The blocked press used to produce ONE sentence — "GPU model still loading —
  // it will be ready shortly" — for a 20s warm start and a 90s download alike,
  // and the caller flashed the tray's red error state for both. Pressing the
  // hotkey during a healthy download looked exactly like a crash.
  const gpu = (over = {}) => ({
    ...select(createState(), 'webgpu-parakeet-0.6b'),
    gpu: 'usable',
    ...over,
  });

  test('a download names the percentage and what to do about it', () => {
    const plan = planCapture(
      gpu({ status: 'downloading', progress: { loaded: 470, total: 1000, pct: 47 } }),
      { orchestratorReady: false },
    );

    assert.strictEqual(plan.blocked, true, 'still refuses — the selection is never substituted');
    assert.strictEqual(
      plan.reason,
      'Downloading GPU model — 47%. Press again when it is ready, or switch to CPU in Settings.',
    );
    assert.strictEqual(plan.blockedKind, 'wait');
  });

  test('a download with no bytes reported yet still reads as started', () => {
    const plan = planCapture(gpu({ status: 'downloading', progress: null }), { orchestratorReady: false });

    assert.strictEqual(
      plan.reason,
      'Starting the GPU model download. Press again shortly, or switch to CPU in Settings.',
    );
    assert.strictEqual(plan.blockedKind, 'wait');
  });

  test('a warm start keeps its own, shorter message and no number', () => {
    const plan = planCapture(gpu({ status: 'loading' }), { orchestratorReady: false });

    assert.strictEqual(plan.reason, 'GPU model still loading — it will be ready shortly');
    assert.doesNotMatch(plan.reason, /\d/, 'no bytes are moving, so there is no percentage to give');
    assert.strictEqual(plan.blockedKind, 'wait');
  });

  test('an unusable GPU is the only one of these that is an error', () => {
    const plan = planCapture(gpu({ gpu: 'unusable', status: 'unusable' }), { orchestratorReady: false });

    assert.strictEqual(plan.reason, 'GPU unavailable — select the CPU engine in Settings to record');
    assert.strictEqual(plan.blockedKind, 'error',
      'this one genuinely needs the red treatment; a download does not');
  });

  test('the three waiting states produce three different sentences', () => {
    const reasons = [
      planCapture(gpu({ status: 'downloading', progress: { loaded: 1, total: 2, pct: 50 } }), {}).reason,
      planCapture(gpu({ status: 'downloading', progress: null }), {}).reason,
      planCapture(gpu({ status: 'loading' }), {}).reason,
    ];

    assert.strictEqual(new Set(reasons).size, 3, 'if two waits read the same, one of them is lying');
  });

  test('an unblocked plan carries no blockedKind', () => {
    const plan = planCapture(gpu({ status: 'ready' }), { orchestratorReady: true });

    assert.strictEqual(plan.blocked, false);
    assert.strictEqual(plan.blockedKind, null);
  });
});

describe('capture-plan / engine-state must agree on the status vocabulary', () => {
  test('every status engine-state can produce is one capture-plan knows', () => {
    // EngineStateRecord.status is hand-mirrored from engine-state.js for the
    // same CommonJS/ESM reason as FALLBACK_MODEL above. Without this, adding a
    // status in main leaves the renderer's union stale and the mismatch only
    // shows up as a `default:` branch quietly swallowing a real state.
    const gpuState = select(createState(), 'webgpu-parakeet-0.6b');
    const produced = new Set([
      createState().status,
      gpuState.status,
      applyModelReady(gpuState, true).status,
      applyModelReady(gpuState, false).status,
      applyGpu(gpuState, 'unusable').status,
      applyDownloadProgress(gpuState, {
        modelId: 'webgpu-parakeet-0.6b', loaded: 1, total: 2, pct: 50,
      }).status,
    ]);

    const known = new Set(['ready', 'loading', 'downloading', 'unusable', 'unknown']);
    for (const s of produced) {
      assert.ok(known.has(s), `engine-state produces status "${s}" which capture-plan does not declare`);
    }
  });
});
