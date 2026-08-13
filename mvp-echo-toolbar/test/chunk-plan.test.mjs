/**
 * Fix 0c — when to transcribe in windows.
 *
 * The app transcribed every recording in one shot, and a single transcribe()
 * collapses to empty text somewhere above ~60-90s, so long dictations silently
 * failed. See _review/FIX-PLAN.md fix 0c.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

const { chunkPlanFor, CHUNK_THRESHOLD_S, CHUNK_LENGTH_S } = await import(
  '../app/renderer/app/webgpu/chunk-plan.ts'
);

const SR = 16000;
const secs = (n) => n * SR;

describe('chunkPlanFor', () => {
  test('keeps short push-to-talk recordings on the single-shot path', () => {
    // The common case. Windowing here would add overhead for no benefit.
    assert.strictEqual(chunkPlanFor(secs(5), SR).chunked, false);
    assert.strictEqual(chunkPlanFor(secs(29), SR).chunked, false);
  });

  test('chunks well before the observed ~60-90s failure point', () => {
    assert.strictEqual(chunkPlanFor(secs(45), SR).chunked, true,
      '45s is under the failure point but must already be chunked — the threshold is a margin, not a trigger');
    assert.ok(CHUNK_THRESHOLD_S < 60,
      'the threshold must sit below where one-shot decode starts returning empty');
  });

  test('chunks a full-length recording', () => {
    const plan = chunkPlanFor(secs(600), SR);
    assert.strictEqual(plan.chunked, true);
    assert.strictEqual(plan.chunkLengthS, CHUNK_LENGTH_S);
  });

  test('window length stays inside the range parakeet.js accepts', () => {
    // normalizeChunkLengthS() clamps to [20, 180]; a value outside that would be
    // silently rewritten, so the constant must already be legal.
    assert.ok(CHUNK_LENGTH_S >= 20 && CHUNK_LENGTH_S <= 180);
  });

  test('is exclusive at the threshold', () => {
    assert.strictEqual(chunkPlanFor(secs(CHUNK_THRESHOLD_S), SR).chunked, false);
    assert.strictEqual(chunkPlanFor(secs(CHUNK_THRESHOLD_S) + 1, SR).chunked, true);
  });

  test('does not force chunking on a bogus sample rate', () => {
    // durationS would be Infinity/NaN and wrongly trip the chunked path.
    assert.strictEqual(chunkPlanFor(secs(10), 0).chunked, false);
    assert.strictEqual(chunkPlanFor(0, SR).chunked, false);
  });
});
