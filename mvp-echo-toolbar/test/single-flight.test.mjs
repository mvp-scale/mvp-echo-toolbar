/**
 * singleFlight — one run at a time, enforced synchronously.
 *
 * The bug this exists for, observed on Windows 2026-08-17: hundreds of
 * "Initializing parakeet.js orchestrator" lines inside a few milliseconds.
 *
 * CaptureApp's guard was `if (isReady() || isLoading()) return`, and
 * `isLoading()` only becomes true INSIDE orchestrator.initialize() — which sits
 * behind three awaits (requestAdapter, getAppVersion, and now model:ensure).
 * Every `engine:state` broadcast arriving in that window passed the guard,
 * because none of them had yet caused `loading` to flip. Adding the model store
 * widened the window and turned a 2-attempt race into a storm.
 *
 * This is the same shape as PLAN.md rule 3 — a caller-side guard that does not
 * actually bound the resource — and the same shape model-store.js already had
 * to solve for concurrent downloads. An `await` between a check and the state
 * change it guards is not a mutex.
 *
 * The fix has to be SYNCHRONOUS: set before the first await, cleared in a
 * finally, so no interleaving can observe an unlocked state.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

const { singleFlight } = await import('../app/renderer/app/single-flight.ts');

/** Resolves on the next macrotask, letting queued microtasks interleave. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('singleFlight', () => {
  test('concurrent callers produce exactly ONE run', async () => {
    let runs = 0;
    const guarded = singleFlight(async () => {
      runs++;
      await tick();
    });

    await Promise.all([guarded(), guarded(), guarded(), guarded()]);

    assert.strictEqual(runs, 1, `four concurrent callers must share one run, got ${runs}`);
  });

  test('a caller arriving DURING the first await is still blocked', async () => {
    // The exact failure: the old guard was re-checked only at entry, and the
    // state it checked did not change until several awaits later.
    let runs = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const guarded = singleFlight(async () => { runs++; await gate; });

    const first = guarded();
    await tick();          // first is now parked mid-await
    await guarded();       // arrives in the window that used to be unguarded

    assert.strictEqual(runs, 1, 'the window between the check and the state change must be closed');
    release();
    await first;
  });

  test('it unlocks after the run finishes, so a later call works', async () => {
    let runs = 0;
    const guarded = singleFlight(async () => { runs++; await tick(); });

    await guarded();
    await guarded();

    assert.strictEqual(runs, 2, 'this is single-flight, not run-once');
  });

  test('a REJECTED run still unlocks', async () => {
    // Caching the lock on failure would make one transient error permanent for
    // the life of the process — the same reason model-store clears its in-flight
    // map on both paths.
    let runs = 0;
    const guarded = singleFlight(async () => {
      runs++;
      await tick();
      throw new Error('boom');
    });

    await assert.rejects(guarded(), /boom/);
    await assert.rejects(guarded(), /boom/);

    assert.strictEqual(runs, 2, 'a failure must not wedge the guard shut');
  });

  test('the rejection reaches the caller that triggered it', async () => {
    const guarded = singleFlight(async () => { throw new Error('surfaced'); });

    await assert.rejects(guarded(), /surfaced/);
  });

  test('a dropped caller resolves rather than hanging', async () => {
    // Callers are fire-and-forget here (an IPC broadcast handler). A dropped
    // call must settle, or every superseded broadcast leaks a pending promise.
    let release;
    const gate = new Promise((r) => { release = r; });
    const guarded = singleFlight(async () => { await gate; });

    const first = guarded();
    await tick();
    const dropped = guarded();

    await assert.doesNotReject(dropped);
    release();
    await first;
  });

  test('a synchronous throw still unlocks', async () => {
    let runs = 0;
    const guarded = singleFlight(() => { runs++; throw new Error('sync'); });

    await assert.rejects(guarded(), /sync/);
    await assert.rejects(guarded(), /sync/);

    assert.strictEqual(runs, 2);
  });
});
