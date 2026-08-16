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

describe('Item 6 — a worker that never LOADS must fail fast, not wedge', () => {
  // The Electron 43 case: COEP blocks the module worker, so the script never
  // runs and the worker can never send a message. With no 'error' listener the
  // init request sat unsettled for the full timeout, `loading` stayed true the
  // whole time, and CaptureApp's recovery path is gated on !isLoading() — so
  // the app was wedged with a dead hotkey and nothing in the log.

  test('a blocked/missing worker script rejects init instead of hanging', async () => {
    const { orch, latest } = makeOrchestrator();

    const initPromise = orch.initialize('webgpu-hybrid');
    await flush();
    latest().emitError({ message: 'Failed to load worker script', filename: 'inference-worker.js', lineno: 1 });

    await assert.rejects(
      () => withinMs(initPromise, 1000),
      /worker/i,
      'a worker load failure must surface to the caller',
    );
    assert.strictEqual(orch.isLoading(), false, 'loading must clear, or recovery stays disabled');
    assert.strictEqual(orch.isReady(), false);
  });

  test('an error event with no message still rejects', async () => {
    // A cross-origin/blocked load is exactly the case where the browser
    // withholds detail, so the empty-message path is the one that matters.
    const { orch, latest } = makeOrchestrator();

    const initPromise = orch.initialize('webgpu-hybrid');
    await flush();
    latest().emitError();

    await assert.rejects(() => withinMs(initPromise, 1000), /worker/i);
    assert.strictEqual(orch.isLoading(), false);
  });

  test('a messageerror also settles the pending request', async () => {
    const { orch, latest } = makeOrchestrator();

    const initPromise = orch.initialize('webgpu-hybrid');
    await flush();
    latest().emitMessageError();

    await assert.rejects(() => withinMs(initPromise, 1000), /worker/i);
    assert.strictEqual(orch.isLoading(), false);
  });

  test('an error from a superseded worker cannot tear down its replacement', async () => {
    const { orch, workers } = makeOrchestrator();

    const first = orch.initialize('webgpu-hybrid');
    await flush();
    const stale = workers[0];
    orch.dispose();
    await first.catch(() => {});

    const second = orch.initialize('webgpu-hybrid');
    await flush();
    const live = workers[workers.length - 1];
    assert.notStrictEqual(live, stale, 'a fresh worker should have been created');

    stale.emitError({ message: 'late failure from the old worker' });

    assert.strictEqual(live.terminated, false, 'the live worker must survive a stale error');
    orch.dispose();
    await second.catch(() => {});
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
      /device lost/i,
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

  test('a teardown during the pre-worker phase does not reopen the loading guard', async () => {
    // Mutation guard: if disposeSync() cleared `loading` unconditionally, a
    // dispose landing while initialize() is still in prepareModelCache() would
    // reopen the guard, letting a second initialize() race the first -- two
    // workers, ~2.5GB of model each.
    const { orch, workers } = makeOrchestrator();

    const first = orch.initialize('wasm'); // still pre-worker at this point
    orch.dispose();                        // nothing concrete to cancel yet

    await assert.rejects(() => orch.initialize('wasm'), (e) => e instanceof AlreadyLoadingError,
      'the in-flight init still owns the loading guard');

    await assert.rejects(() => withinMs(first, 1000), /cancelled/i,
      'a teardown during cache prep must actually cancel the init');
    assert.ok(workers.length <= 1, `must never spawn a second worker, saw ${workers.length}`);
    assert.strictEqual(orch.isLoading(), false);
  });

  test('a successful init resolves and reports ready', async () => {
    // The happy path had no coverage at all, yet the teardown refactor touched
    // the same cleanup code it runs through.
    const { orch, latest } = makeOrchestrator();

    const initPromise = orch.initialize('wasm');
    await flush();
    latest().emit({ type: 'ready' });
    await withinMs(initPromise, 1000);

    assert.strictEqual(orch.isReady(), true);
    assert.strictEqual(orch.isLoading(), false);
    assert.strictEqual(latest().terminated, false, 'a healthy worker must be kept warm');
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

    // Force delivery from the stale worker. Using emit() here would let the
    // fake's own termination check block the message, so the test would pass
    // even with the production supersession guard deleted — a vacuous test.
    staleWorker.emitForced({ type: 'device-lost', reason: 'unknown' });

    assert.strictEqual(freshWorker.terminated, false, 'the replacement worker must not be torn down');
    assert.strictEqual(orch.isLoading(), true, 'the newer init must still be in flight');

    orch.dispose();
    await second.catch(() => {});
  });
});
