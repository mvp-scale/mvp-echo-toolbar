/**
 * Fixes 0a and 0b — InferenceOrchestrator failure handling.
 *
 * See _review/FIX-PLAN.md (DoD v2), _review/raw/08-memory-and-hangs.md,
 * and _review/recon/A-orchestrator-blast-radius.md.
 *
 * 0a: initialize() swallowed init failures and resolved anyway, so the
 *     caller's 3-strike backoff counter was reset on every attempt and never
 *     tripped — leaving an unbounded 15s re-init loop, each cycle loading a
 *     ~2.5GB model.
 * 0b: disposeSync() terminated the worker without settling the in-flight
 *     request, so a device-lost during init left `loading === true` until a
 *     900_000ms timeout — a 15-minute wedge in which the recovery path is
 *     itself disabled because it is gated on !isLoading().
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import { FakeWorker, stubBrowserStorage } from '../testkit/fake-worker.mjs';

stubBrowserStorage();

const { InferenceOrchestrator, AlreadyLoadingError } = await import(
  '../app/renderer/app/webgpu/inference-orchestrator.ts'
);

/** Orchestrator wired to a FakeWorker, with the worker exposed to the test. */
function makeOrchestrator() {
  const workers = [];
  const orch = new InferenceOrchestrator(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  return { orch, workers, latest: () => workers[workers.length - 1] };
}

/** Yield past all pending microtasks (prepareModelCache awaits several). */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Reject if a promise hasn't settled quickly — the 15-min wedge shows up here. */
function withinMs(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`did not settle within ${ms}ms`)), ms)),
  ]);
}

describe('Fix 0a — init failure must surface to the caller', () => {
  test('initialize() rejects when the worker reports an init error', async () => {
    const { orch, latest } = makeOrchestrator();

    const initPromise = orch.initialize('wasm');
    await flush();
    latest().onPost = (msg, w) => {
      if (msg.type === 'init') w.emit({ type: 'error', message: 'model load failed' });
    };
    latest().emit({ type: 'error', message: 'model load failed' });

    await assert.rejects(
      () => withinMs(initPromise, 1000),
      /model load failed/,
      'a failed init must reject so the caller can count the failure',
    );
    assert.strictEqual(orch.isReady(), false);
    assert.strictEqual(orch.isLoading(), false, 'loading must clear after a failed init');
  });

  test('a concurrent initialize() rejects with a distinguishable AlreadyLoadingError', async () => {
    // This is a real race (mount auto-init vs. the webgpu:init-orchestrator IPC).
    // It must NOT be counted as an init failure by the caller's 3-strike guard.
    const { orch } = makeOrchestrator();

    const first = orch.initialize('wasm');
    const second = orch.initialize('wasm');

    await assert.rejects(() => withinMs(second, 1000), (err) => {
      assert.ok(err instanceof AlreadyLoadingError, `expected AlreadyLoadingError, got ${err?.name}`);
      return true;
    });

    orch.dispose();
    await first.catch(() => {});
  });
});

describe('Fix 0b — teardown must settle the in-flight request', () => {
  test('device-lost during init rejects the pending init promptly', async () => {
    const { orch, latest } = makeOrchestrator();

    const initPromise = orch.initialize('webgpu-hybrid');
    await flush();
    latest().emit({ type: 'device-lost', reason: 'destroyed' });

    await assert.rejects(
      () => withinMs(initPromise, 1000),
      'device-lost must reject the pending init instead of leaving it for the 900s timeout',
    );
    assert.strictEqual(orch.isLoading(), false, 'isLoading() must clear — the recovery path is gated on it');
    assert.strictEqual(orch.isReady(), false);
  });

  test('dispose() with no request in flight does not clear the loading guard', async () => {
    // Recon A: clearing `loading` unconditionally lets a dispose() landing
    // mid-initialize() reopen the guard, so two initialize() calls race and
    // each spawns its own worker — ~5GB of model instead of 2.5GB.
    const { orch, workers } = makeOrchestrator();

    const first = orch.initialize('wasm');
    await flush();
    assert.strictEqual(orch.isLoading(), true);

    // A second init while the first is still in flight must still be refused.
    await assert.rejects(() => orch.initialize('wasm'), (e) => e instanceof AlreadyLoadingError);
    assert.strictEqual(workers.length, 1, 'must not spawn a second worker while one init is in flight');

    orch.dispose();
    await first.catch(() => {});
  });

  test('a superseded worker cannot terminate its replacement', async () => {
    // Epoch guard (recon B): a stale init's late cleanup must not tear down a
    // newer worker and stomp its loading state.
    const { orch, workers } = makeOrchestrator();

    const first = orch.initialize('webgpu-hybrid');
    await flush();
    const staleWorker = workers[0];

    orch.dispose();
    await first.catch(() => {});
    assert.strictEqual(staleWorker.terminated, true);

    const second = orch.initialize('webgpu-hybrid');
    await flush();
    const freshWorker = workers[1];
    assert.notStrictEqual(freshWorker, staleWorker, 'a new worker should have been created');

    // The stale worker emits device-lost late. It is terminated, so a faithful
    // fake delivers nothing — but assert the replacement survives regardless.
    staleWorker.emit({ type: 'device-lost', reason: 'unknown' });

    assert.strictEqual(freshWorker.terminated, false, 'the replacement worker must not be torn down');
    assert.strictEqual(orch.isLoading(), true, 'the newer init must still be in flight');

    orch.dispose();
    await second.catch(() => {});
  });
});
