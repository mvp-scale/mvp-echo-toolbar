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

// ── The hosted endpoint ────────────────────────────────────────────────────
//
// "Test connection seems to give a false impression that it's connected.
//  There's both connected and authenticated, and connected gives the wrong
//  definition."
//
// isConfigured was `!!endpointUrl`, so typing a URL turned the dot green. Four
// facts were collapsed into one word: a URL exists, the host answered, the key
// was accepted, a model can be switched.

const { endpointStatusLabel } = await import('../app/renderer/app/engine-status-label.ts');

describe('endpointStatusLabel — say only what was observed', () => {
  test('a URL that merely exists is NOT connected', () => {
    const s = endpointStatusLabel({ url: 'http://192.168.1.169:20300/v1/audio/transcriptions' });

    assert.strictEqual(s.label, 'Not tested');
    assert.notStrictEqual(s.tone, 'ok', 'an untested URL must never render as a green dot');
  });

  test('no URL at all reads as not configured', () => {
    assert.strictEqual(endpointStatusLabel({ url: null }).label, 'Not configured');
    assert.strictEqual(endpointStatusLabel({ url: '' }).label, 'Not configured');
  });

  test('a successful test says reachable, never connected or authenticated', () => {
    const s = endpointStatusLabel({ url: 'http://h/v1', probe: { ok: true, status: 200, modelCount: 1 } });

    assert.strictEqual(s.tone, 'ok');
    assert.strictEqual(s.label, 'Reachable');
    assert.strictEqual(s.detail, '1 model');
    // The server under test returns 200 to a request with NO key and with a
    // WRONG key, so a 200 proves the host answered and nothing whatsoever
    // about credentials. Claiming otherwise would be the same bug reworded.
    assert.doesNotMatch(s.label, /connect|authenticat/i);
  });

  test('it pluralises the model count', () => {
    const s = endpointStatusLabel({ url: 'http://h/v1', probe: { ok: true, modelCount: 2 } });
    assert.strictEqual(s.detail, '2 models');
  });

  test('a 401 IS provable, so it is reported as a rejection', () => {
    const s = endpointStatusLabel({ url: 'http://h/v1', probe: { ok: false, status: 401 } });

    assert.strictEqual(s.label, 'Key rejected');
    assert.strictEqual(s.tone, 'error');
  });

  test('403 is a rejection too', () => {
    assert.strictEqual(
      endpointStatusLabel({ url: 'http://h/v1', probe: { ok: false, status: 403 } }).label,
      'Key rejected',
    );
  });

  test('an unreachable host shows the transport error verbatim', () => {
    const s = endpointStatusLabel({
      url: 'http://h/v1',
      probe: { ok: false, status: null, error: 'Connection refused - server may be offline' },
    });

    assert.match(s.label, /Connection refused/);
    assert.strictEqual(s.tone, 'error');
  });

  test('a failure with no message still says something', () => {
    assert.strictEqual(endpointStatusLabel({ url: 'http://h/v1', probe: { ok: false } }).label, 'Unreachable');
  });

  test('testing outranks a previous result', () => {
    const s = endpointStatusLabel({ url: 'http://h/v1', testing: true, probe: { ok: true, modelCount: 1 } });

    assert.strictEqual(s.label, 'Testing…');
    assert.strictEqual(s.tone, 'busy');
  });
});

describe('statusLabel — a download is not a load', () => {
  // 'loading' covered both warming a cached model (~20s, no bytes moving) and
  // fetching 1.2GB (~90s). One word for two experiences an order of magnitude
  // apart is why the blocked-press message promised "ready shortly" when it
  // might be minutes. Decision: _review/DOWNLOAD-STATE-DECISION.md.
  const downloading = (progress) => ({
    rev: 1, engine: 'webgpu', modelId: 'webgpu-parakeet-0.6b',
    status: 'downloading', reason: null, gpu: 'usable', progress,
  });

  test('it names the percentage', () => {
    const { label, tone } = statusLabel(downloading({ loaded: 470, total: 1000, pct: 47 }));

    assert.strictEqual(label, 'Downloading GPU model — 47%');
    assert.strictEqual(tone, 'busy', 'busy, never error — a download is not a failure');
  });

  test('0% still reads as started, not as absent', () => {
    assert.strictEqual(statusLabel(downloading({ loaded: 0, total: 1000, pct: 0 })).label,
      'Downloading GPU model — 0%');
  });

  test('100% is a legal thing to render', () => {
    assert.strictEqual(statusLabel(downloading({ loaded: 1000, total: 1000, pct: 100 })).label,
      'Downloading GPU model — 100%');
  });

  test('no progress yet says so rather than showing undefined%', () => {
    // The window between "the download started" and the first byte report.
    assert.strictEqual(statusLabel(downloading(null)).label, 'Downloading GPU model…');
  });

  test('a missing pct on a present progress object does not leak NaN', () => {
    const label = statusLabel(downloading({ loaded: 1, total: 2 })).label;

    assert.doesNotMatch(label, /NaN|undefined/, 'no percentage beats a broken one');
  });

  test('loading NEVER carries a number', () => {
    // A warm cache moves no bytes, so a percentage there would be invented.
    // This is what keeps the two statuses worth distinguishing at all.
    const warm = { ...downloading({ pct: 47, loaded: 1, total: 2 }), status: 'loading' };

    assert.strictEqual(statusLabel(warm).label, 'Loading GPU model…');
    assert.doesNotMatch(statusLabel(warm).label, /\d/);
  });
});
