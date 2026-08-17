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
function makeOrchestrator(initStallMs) {
  const workers = [];
  const orch = new InferenceOrchestrator(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  }, initStallMs === undefined ? undefined : { initStallMs });
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

// ── The first-run download must be able to outlast the timeout ─────────────
//
// Found on a real first run (2026-08-16). The init timeout was a TOTAL budget
// of 180s. The encoder falls back to fp32 without `shader-f16`, so the payload
// is 2,322 MB — finishing in time demands 12.9 MB/s. At the observed ~7 MB/s
// the download hit 53%, the worker was disposed, CaptureApp re-initialised, and
// it restarted from 0%. Forever. The log showed healthy progress throughout:
//
//   21:00:49 [Download] encoder-model.onnx.data: 1219.4/2322.6 MB (53%)
//   21:00:49 Init failed — disposing worker: Worker timed out after 180000ms
//   21:01:17 [Download] encoder-model.onnx.data: 0.1/2322.6 MB (0%)
//
// The timeout now measures silence, so progress keeps it alive.

describe('init timeout is a stall window, not a total budget', () => {
  test('a slow but progressing download is NOT killed', async () => {
    const { orch, latest } = makeOrchestrator(60);

    const init = orch.initialize('webgpu-hybrid');
    await flush();
    const w = latest();

    // Six progress ticks, each arriving just before the 60ms window expires.
    // Total elapsed (~240ms) is far beyond the window; no single gap is.
    for (let pct = 10; pct <= 60; pct += 10) {
      await new Promise((r) => setTimeout(r, 40));
      w.emit({ type: 'download-progress', file: 'encoder-model.onnx.data', loaded: pct, total: 100, pct });
    }
    w.emit({ type: 'ready' });

    await init;
    assert.strictEqual(orch.isReady(), true, 'a download making steady progress must be allowed to finish');
    assert.strictEqual(w.terminated, false, 'and the worker must not be torn down under it');
  });

  test('but genuine silence still trips it', async () => {
    const { orch, latest } = makeOrchestrator(60);

    const init = orch.initialize('webgpu-hybrid');
    await flush();

    await assert.rejects(init, /sent nothing for 60ms/,
      'a worker that reports nothing at all is hung and must still be caught');
    assert.strictEqual(latest().terminated, true, 'and it must be disposed for a clean retry');
  });

  test('silence AFTER progress trips it too', async () => {
    // A download that genuinely stalls mid-flight must not be kept alive by the
    // progress it already made.
    const { orch, latest } = makeOrchestrator(60);

    const init = orch.initialize('webgpu-hybrid');
    await flush();
    latest().emit({ type: 'download-progress', file: 'x', loaded: 50, total: 100, pct: 50 });

    await assert.rejects(init, /sent nothing for 60ms/);
    assert.strictEqual(latest().terminated, true);
  });
});

// ── Failure must not feed the retry that produced it ───────────────────────
//
// Observed on Windows: 61 init attempts in 50 seconds.
//
//   init fails -> reportReadiness(false) -> main folds it into the record
//   -> rev bumps -> broadcast -> applyEngineState sees engine=webgpu and
//   !isReady() -> init again -> fails ...
//
// The 3-strike bound existed but only guarded the hotkey path, so this loop
// ran around it. The orchestrator itself must refuse to be re-entered on a
// hopeless cycle, because the callers cannot all be trusted to remember.

describe('initialize refuses to thrash after repeated failures', () => {
  test('it gives up after a bounded number of consecutive failures', async () => {
    const { orch, latest } = makeOrchestrator(40);

    let attempts = 0;
    for (let i = 0; i < 10; i++) {
      const p = orch.initialize('webgpu-hybrid').catch((e) => e);
      await flush();
      const w = latest();
      // A worker that reports a hard failure, like a blocked fetch.
      if (w && !w.terminated) w.emit({ type: 'error', message: 'Failed to fetch' });
      const err = await p;
      if (err instanceof Error && /giving up|too many/i.test(err.message)) break;
      attempts++;
    }

    assert.ok(attempts < 10,
      `initialize must stop accepting attempts after repeated failures; got ${attempts}`);
  });

  test('a success resets the budget', async () => {
    const { orch, latest } = makeOrchestrator(40);

    const p1 = orch.initialize('webgpu-hybrid').catch((e) => e);
    await flush();
    latest().emit({ type: 'error', message: 'Failed to fetch' });
    await p1;

    const p2 = orch.initialize('webgpu-hybrid');
    await flush();
    latest().emit({ type: 'ready' });
    await p2;

    assert.strictEqual(orch.isReady(), true, 'a recovered machine must not stay locked out');
  });
});

// ── Download progress reaches the caller, aggregated ───────────────────────
//
// This branch existed and threw its data away: it rearmed the stall timer,
// console.logged, and dropped the tick (inference-orchestrator.ts, the
// 'download-progress' case). That is why SettingsPanel said "check console for
// progress" — the console was genuinely the only place it went.

describe('download progress is forwarded, not just logged', () => {
  test('the caller receives an aggregate, not the raw per-file tick', async () => {
    const { orch, latest } = makeOrchestrator(500);
    const seen = [];

    const init = orch.initialize('webgpu-hybrid', undefined, 'fp32', undefined, (p) => seen.push(p));
    await flush();
    const w = latest();

    // Two files, as a real parakeet download reports: each runs its own 0→100%.
    w.emit({ type: 'download-progress', file: 'encoder.onnx', loaded: 500, total: 1000, pct: 50 });
    w.emit({ type: 'download-progress', file: 'decoder.onnx', loaded: 0, total: 1000, pct: 0 });
    w.emit({ type: 'ready' });
    await init;

    assert.ok(seen.length >= 2, 'progress must reach the caller at all');
    assert.strictEqual(seen[0].pct, 50, 'first file alone: 500 of 1000');
    assert.strictEqual(seen[1].total, 2000, 'the denominator is every file seen, not the latest one');
    assert.strictEqual(seen[1].pct, 25, 'aggregate — NOT the raw 0% the second file reported');
  });

  test('repeated ticks at the same percent are not forwarded', async () => {
    // The bound at the emitter: a 1.2GB download produces tens of thousands of
    // raw ticks, and every forward becomes an IPC message plus a broadcast to
    // three windows.
    const { orch, latest } = makeOrchestrator(500);
    const seen = [];

    const init = orch.initialize('webgpu-hybrid', undefined, 'fp32', undefined, (p) => seen.push(p));
    await flush();
    const w = latest();

    for (let i = 0; i < 50; i++) {
      w.emit({ type: 'download-progress', file: 'encoder.onnx', loaded: 500 + i, total: 100000, pct: 0 });
    }
    w.emit({ type: 'ready' });
    await init;

    assert.strictEqual(seen.length, 1, `50 sub-percent ticks must collapse to 1, got ${seen.length}`);
  });

  test('a second init does not inherit the first download\'s progress', async () => {
    const { orch, latest } = makeOrchestrator(500);
    const first = [];
    const second = [];

    const a = orch.initialize('webgpu-hybrid', undefined, 'fp32', undefined, (p) => first.push(p));
    await flush();
    latest().emit({ type: 'download-progress', file: 'encoder.onnx', loaded: 1000, total: 1000, pct: 100 });
    latest().emit({ type: 'ready' });
    await a;

    orch.dispose();
    const b = orch.initialize('webgpu-hybrid', undefined, 'fp32', undefined, (p) => second.push(p));
    await flush();
    latest().emit({ type: 'download-progress', file: 'encoder.onnx', loaded: 0, total: 1000, pct: 0 });
    latest().emit({ type: 'ready' });
    await b;

    assert.strictEqual(second[0]?.pct, 0, 'a fresh download starts at 0, not at the last one\'s 100');
  });

  test('omitting the callback is safe — nothing else changes', async () => {
    const { orch, latest } = makeOrchestrator(500);

    const init = orch.initialize('webgpu-hybrid');
    await flush();
    latest().emit({ type: 'download-progress', file: 'x', loaded: 1, total: 2, pct: 50 });
    latest().emit({ type: 'ready' });

    await init;
    assert.strictEqual(orch.isReady(), true);
  });
});
