/**
 * Item 20 — a tray revert must not outlive the thing it was reverting.
 *
 * CaptureApp had six copies of `setTimeout(() => updateTrayState('ready'), 3000)`
 * with no guard. A revert scheduled by one recording fires three seconds later
 * regardless of what has happened since, so it overwrites the tray state of a
 * NEWER recording — showing "ready" while recording, or clearing an error the
 * user never saw.
 *
 * Main already solved this: tray-manager.js clears any pending timeout on every
 * setState. The renderer re-created the anti-pattern main had deleted.
 *
 * Timers are injected so the tests are deterministic rather than slow.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

const { createTrayFlasher } = await import('../app/renderer/app/tray-flash.ts');

/** A controllable clock: nothing fires until run() is called. */
function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout: (fn, _ms) => { const id = next++; pending.set(id, fn); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    /** Fire everything still scheduled, in insertion order. */
    run: () => { const fns = [...pending.values()]; pending.clear(); fns.forEach((f) => f()); },
    get size() { return pending.size; },
  };
}

function setup({ generation = () => 0 } = {}) {
  const states = [];
  const timers = fakeTimers();
  const flash = createTrayFlasher({
    setState: (s) => states.push(s),
    generation,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  return { flash, states, timers };
}

describe('createTrayFlasher', () => {
  test('sets the requested state immediately', () => {
    const { flash, states } = setup();

    flash('error');

    assert.deepStrictEqual(states, ['error']);
  });

  test('reverts to ready when the timer fires', () => {
    const { flash, states, timers } = setup();

    flash('error');
    timers.run();

    assert.deepStrictEqual(states, ['error', 'ready']);
  });

  test('a second flash cancels the first revert, so only one fires', () => {
    const { flash, states, timers } = setup();

    flash('error');
    flash('recording');
    timers.run();

    assert.deepStrictEqual(states, ['error', 'recording', 'ready'],
      'the first revert must not still be queued');
  });

  test('THE BUG: a revert from a superseded generation does not fire', () => {
    let gen = 0;
    const { flash, states, timers } = setup({ generation: () => gen });

    flash('error');   // scheduled while gen === 0
    gen = 1;          // a newer recording starts
    timers.run();

    assert.deepStrictEqual(states, ['error'],
      'a stale revert must not clear a newer recording\'s tray state');
  });

  test('a revert from the current generation still fires', () => {
    let gen = 7;
    const { flash, states, timers } = setup({ generation: () => gen });

    flash('error');
    timers.run();

    assert.deepStrictEqual(states, ['error', 'ready']);
  });

  test('cancel() drops a pending revert', () => {
    const { flash, states, timers } = setup();

    flash('error');
    flash.cancel();
    timers.run();

    assert.deepStrictEqual(states, ['error']);
    assert.strictEqual(timers.size, 0);
  });

  test('a custom revert state is honoured', () => {
    const { flash, states, timers } = setup();

    flash('recording', { revertTo: 'idle' });
    timers.run();

    assert.deepStrictEqual(states, ['recording', 'idle']);
  });
});
