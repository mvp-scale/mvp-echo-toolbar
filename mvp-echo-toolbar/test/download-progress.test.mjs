/**
 * The download progress aggregator.
 *
 * parakeet fetches several files and reports a percentage PER FILE
 * (inference-worker.ts:118-127). Forwarding that raw shows the user 0→100%
 * two or three times in a single download, which reads as a stuck or restarting
 * download rather than a progressing one.
 *
 * This repo already ruled on exactly this shape once — test/model-store.test.js
 * asserts "per-file progress that resets to 0 reads as a stuck download", which
 * is why model-store.js aggregates across files. The hub path never learned it.
 *
 * The other job here is the bound, and it lives at the emitter rather than at
 * each consumer: a 1.2GB download produces tens of thousands of raw ticks, and
 * every forward becomes an IPC message and a broadcast to three windows.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

const { createProgressAggregator } = await import('../app/renderer/app/webgpu/download-progress.ts');

describe('createProgressAggregator', () => {
  test('it sums across files instead of restarting per file', () => {
    const agg = createProgressAggregator();

    agg.push({ file: 'encoder.onnx', loaded: 500, total: 1000 });
    const afterDecoder = agg.push({ file: 'decoder.onnx', loaded: 0, total: 1000 });

    assert.strictEqual(afterDecoder?.total, 2000, 'the denominator is every file seen so far');
    assert.strictEqual(afterDecoder?.loaded, 500);
    assert.strictEqual(afterDecoder?.pct, 25);
  });

  test('bytes downloaded never go backwards, and it still reaches 100%', () => {
    // The failure this module exists for: raw per-file ticks make the user watch
    // 0→100% once per file. `loaded` is the guarantee — it is monotonic
    // unconditionally, which is what "this is progressing, not stuck" rests on.
    const agg = createProgressAggregator();
    const seen = [];
    const feed = (file, loaded, total) => {
      const out = agg.push({ file, loaded, total });
      if (out) seen.push(out);
    };

    for (let i = 0; i <= 100; i += 5) feed('encoder.onnx', i * 10, 1000);
    for (let i = 0; i <= 100; i += 5) feed('decoder.onnx', i * 10, 1000);

    assert.ok(seen.length > 0);
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i].loaded >= seen[i - 1].loaded,
        `bytes went backwards: ${seen[i - 1].loaded} then ${seen[i].loaded}`);
    }
    assert.strictEqual(seen[seen.length - 1].pct, 100);
  });

  test('the percentage is monotonic once the file set is known', () => {
    // The common case, and the only one on the live path: model-store.js knows
    // every file and its exact size from the manifest before the first byte, so
    // the denominator never moves.
    const agg = createProgressAggregator();
    const seen = [];

    for (let i = 0; i <= 1000; i += 7) {
      // Both files present from the first tick, as a known-manifest download is.
      agg.push({ file: 'decoder.onnx', loaded: Math.min(i, 100), total: 100 });
      const out = agg.push({ file: 'encoder.onnx', loaded: i, total: 1000 });
      if (out) seen.push(out);
    }

    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i].pct >= seen[i - 1].pct,
        `percentage went backwards: ${seen[i - 1].pct}% then ${seen[i].pct}%`);
    }
  });

  test('a file appearing late grows the denominator — the percentage dips, and that is deliberate', () => {
    // KNOWN AND ACCEPTED. If a small file completes before a large one is even
    // announced, the honest aggregate falls: 100% of 1MB becomes 1% of 100MB.
    //
    // The alternative — clamping so the percentage never decreases — is worse,
    // and specifically worse in this exact case: it would report 100% for the
    // entire remaining download. A number that stalls at 100% while 1.2GB is
    // still moving is the "silent wait" failure with a decoration on top.
    //
    // This only affects the hub path (parakeet announces files as it fetches
    // them). The on-disk store computes its total from the manifest up front, so
    // once --model-store is the default this case stops arising in practice.
    // If it looks bad on Windows, the fix is showing MB alongside the percent —
    // monotonic in the numerator — not lying about the fraction.
    const agg = createProgressAggregator();

    const small = agg.push({ file: 'vocab.txt', loaded: 100, total: 100 });
    const afterBigAppears = agg.push({ file: 'encoder.onnx', loaded: 0, total: 9900 });

    assert.strictEqual(small?.pct, 100);
    assert.strictEqual(afterBigAppears?.pct, 1, 'honest: 100 bytes of 10,000 is 1%');
    assert.ok(afterBigAppears.loaded >= small.loaded, 'but bytes downloaded still never regress');
  });

  test('it emits only when the whole-number percentage changes', () => {
    const agg = createProgressAggregator();

    assert.ok(agg.push({ file: 'a', loaded: 10, total: 1000 }), 'first tick is news');
    assert.strictEqual(agg.push({ file: 'a', loaded: 11, total: 1000 }), null, 'still 1%');
    assert.ok(agg.push({ file: 'a', loaded: 20, total: 1000 }), '2% is news');
  });

  test('thirty thousand raw ticks produce at most 101 forwards', () => {
    // The bound, at the resource that emits it. Every forward becomes an IPC
    // message and a broadcast to three windows; unthrottled, a 1.2GB download
    // would flood the record with tens of thousands of revisions.
    const agg = createProgressAggregator();
    let emitted = 0;

    for (let i = 0; i <= 30000; i++) {
      if (agg.push({ file: 'encoder.onnx', loaded: i, total: 30000 })) emitted++;
    }

    assert.ok(emitted <= 101, `expected at most 101 forwards, got ${emitted}`);
    assert.ok(emitted >= 100, `expected roughly one per percent, got ${emitted}`);
  });

  test('a zero total does not produce NaN%', () => {
    const agg = createProgressAggregator();

    const out = agg.push({ file: 'a', loaded: 0, total: 0 });

    assert.ok(out === null || Number.isFinite(out.pct), 'NaN% on screen is worse than no percentage');
  });

  test('a file whose total is revised upward is respected', () => {
    // Content-Length can arrive after the first chunk; the denominator must be
    // allowed to grow rather than being pinned to whatever was seen first.
    const agg = createProgressAggregator();

    agg.push({ file: 'a', loaded: 100, total: 200 });
    const out = agg.push({ file: 'a', loaded: 100, total: 1000 });

    assert.strictEqual(out?.total, 1000);
  });

  test('each download gets its own aggregator', () => {
    // Instantiated per init, so a second download cannot inherit the first's
    // file map and start at 100%.
    const first = createProgressAggregator();
    first.push({ file: 'a', loaded: 1000, total: 1000 });

    const second = createProgressAggregator();
    const out = second.push({ file: 'a', loaded: 0, total: 1000 });

    assert.strictEqual(out?.pct, 0);
  });
});
