/**
 * Fix 0c — when to transcribe in windows.
 *
 * The app transcribed every recording in one shot, and a single transcribe()
 * collapses to empty text somewhere above ~60-90s, so long dictations silently
 * failed. See _review/FIX-PLAN.md fix 0c.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

const { chunkPlanFor, CHUNK_THRESHOLD_S, CHUNK_LENGTH_S, dedupeOverlappingWords, joinWords } =
  await import('../app/renderer/app/webgpu/chunk-plan.ts');

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

describe('dedupeOverlappingWords', () => {
  const w = (text, start, end) => ({ text, start_time: start, end_time: end });

  test('removes a span replayed from an earlier window', () => {
    // Reproduces the real failure: parakeet.js windows overlap by 10s and its
    // own dedup only compares ADJACENT words, so a repeated multi-word span
    // survives. Confirmed against the library with a synthetic model at chunk
    // lengths 30/45/60/90 — it duplicates at all of them, including its own
    // 90s default.
    const words = [
      w('nine', 40, 41), w('body', 41, 43),
      w('ten', 45, 46), w('body', 46, 48),
      // seam: the next window replays the same 10s
      w('nine', 40, 41), w('body', 41, 43),
      w('ten', 45, 46), w('body', 46, 48),
      w('eleven', 50, 51),
    ];

    const out = dedupeOverlappingWords(words);

    assert.strictEqual(joinWords(out), 'nine body ten body eleven');
  });

  test('keeps genuine repetition, which carries later timestamps', () => {
    // A speaker actually saying the same thing twice must survive — the only
    // thing that marks a duplicate is time running backwards.
    const words = [w('again', 10, 11), w('again', 12, 13), w('again', 14, 15)];

    assert.strictEqual(dedupeOverlappingWords(words).length, 3);
  });

  test('tolerates small timestamp jitter between adjacent words', () => {
    // Real adjacent words can overlap by tens of ms; that must not be treated
    // as a seam.
    const words = [w('one', 1.0, 1.5), w('two', 1.45, 2.0), w('three', 1.95, 2.5)];

    assert.strictEqual(dedupeOverlappingWords(words).length, 3);
  });

  test('handles an empty word list', () => {
    assert.deepStrictEqual(dedupeOverlappingWords([]), []);
    assert.strictEqual(joinWords([]), '');
  });
});
