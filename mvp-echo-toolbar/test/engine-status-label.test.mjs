/**
 * Item 22 — the popup must not assert "Ready" regardless of reality.
 *
 * StatusIndicator took no props and rendered a hardcoded green dot and the
 * literal string "Ready". The one window a user opens to find out what is wrong
 * told them nothing was. During the Electron 43 failure — worker blocked,
 * orchestrator never ready, hotkey dead — it still said Ready.
 *
 * The derivation is a pure function so it can be tested without a DOM, per the
 * strategy's "extract, don't simulate".
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

const { statusLabel } = await import('../app/renderer/app/engine-status-label.ts');

const rec = (over = {}) => ({
  rev: 1, engine: 'local', modelId: 'local-fast', status: 'ready',
  reason: null, gpu: 'indeterminate', ...over,
});

describe('statusLabel', () => {
  test('a ready engine reads Ready and is green', () => {
    const s = statusLabel(rec({ status: 'ready' }));

    assert.strictEqual(s.label, 'Ready');
    assert.strictEqual(s.tone, 'ok');
  });

  test('no record yet reads as connecting, not as Ready', () => {
    const s = statusLabel(null);

    assert.notStrictEqual(s.label, 'Ready', 'unknown must never render as Ready');
    assert.strictEqual(s.tone, 'idle');
  });

  test('a loading engine says so', () => {
    const s = statusLabel(rec({ engine: 'webgpu', modelId: 'webgpu-parakeet-0.6b', status: 'loading' }));

    assert.match(s.label, /load/i);
    assert.strictEqual(s.tone, 'busy');
  });

  test('an unusable engine surfaces its reason verbatim', () => {
    const s = statusLabel(rec({
      engine: 'webgpu', status: 'unusable', reason: 'GPU unavailable on this system',
    }));

    assert.strictEqual(s.tone, 'error');
    assert.match(s.label, /GPU unavailable/);
  });

  test('an unusable engine with no reason still does not claim Ready', () => {
    const s = statusLabel(rec({ status: 'unusable', reason: null }));

    assert.strictEqual(s.tone, 'error');
    assert.notStrictEqual(s.label, 'Ready');
  });

  test('the engine in use is identifiable when ready', () => {
    const cpu = statusLabel(rec({ engine: 'local', status: 'ready' }));
    const gpu = statusLabel(rec({ engine: 'webgpu', modelId: 'webgpu-parakeet-0.6b', status: 'ready' }));

    assert.notStrictEqual(cpu.detail, gpu.detail, 'the popup should distinguish CPU from GPU');
  });

  test('an unknown status is reported as unknown rather than assumed good', () => {
    const s = statusLabel(rec({ status: 'unknown' }));

    assert.notStrictEqual(s.tone, 'ok');
  });
});
