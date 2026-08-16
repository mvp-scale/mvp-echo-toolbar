/**
 * Parallel range downloader — the piece that gets a 1,182 MB encoder onto a
 * machine in under 30 seconds instead of three minutes.
 *
 * HuggingFace throttles per CONNECTION, not per client. Measured against their
 * CDN: 4.9 MB/s on one stream, 50.7 MB/s on eight. Same link, no credentials.
 * So the download is not bandwidth-bound, it is connection-bound, and the fix
 * is range requests in parallel.
 *
 * Everything here is exercised through an injected fetch, so the logic is
 * testable without Electron, without a network, and without moving a gigabyte.
 * The only part that cannot be covered here is Chromium's actual `net.fetch`,
 * which is why that is the injected seam rather than a hard dependency.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { planRanges, downloadFile, downloadParts } = require('../app/main/model-downloader');

/** Serves part N for a URL ending in the part's index. */
function partFetch(parts) {
  return async (url) => {
    const i = Number(/(\d+)$/.exec(url)?.[1] ?? 0);
    const p = parts[i] || parts[0];
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-length', String(p.length)]]),
      arrayBuffer: async () => p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength),
    };
  };
}

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-dl-'));

/**
 * A fake server holding `body`, honouring Range when `ranges` is true.
 * `failRange` makes one specific range fail, to exercise the partial-failure path.
 */
function fakeFetch(body, { ranges = true, failRange = null, onRequest = () => {} } = {}) {
  return async (url, init = {}) => {
    onRequest(init);
    const range = init.headers?.Range || init.headers?.range;

    if (init.method === 'HEAD' || (!range && init.method === undefined && false)) {
      return {
        ok: true,
        status: 200,
        headers: new Map([
          ['content-length', String(body.length)],
          ...(ranges ? [['accept-ranges', 'bytes']] : []),
        ]),
      };
    }

    if (range) {
      if (!ranges) return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(0) };
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      const [start, end] = [Number(m[1]), Number(m[2])];
      if (failRange && start === failRange) throw new Error('chunk failed');
      const slice = body.subarray(start, end + 1);
      return { ok: true, status: 206, arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) };
    }

    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(0) };
  };
}

/** Deterministic bytes so a mis-assembled file is detectable, not just wrong-sized. */
function makeBody(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = i % 251;
  return b;
}

describe('planRanges — every byte exactly once', () => {
  test('splits into the requested number of chunks', () => {
    assert.strictEqual(planRanges(1000, 4, 1).length, 4);
  });

  test('covers the whole file with no gaps and no overlap', () => {
    const ranges = planRanges(1000, 7, 1);

    assert.strictEqual(ranges[0].start, 0);
    assert.strictEqual(ranges[ranges.length - 1].end, 999, 'the last byte must be included');
    for (let i = 1; i < ranges.length; i++) {
      assert.strictEqual(ranges[i].start, ranges[i - 1].end + 1,
        `gap or overlap between chunk ${i - 1} and ${i}`);
    }
  });

  test('a file smaller than the connection count does not produce empty chunks', () => {
    // 3 bytes over 8 connections must not yield five zero-length requests; a
    // zero-length range is a malformed request, not a no-op.
    const ranges = planRanges(3, 8, 1);

    assert.ok(ranges.length <= 3, `expected at most 3 chunks, got ${ranges.length}`);
    for (const r of ranges) assert.ok(r.end >= r.start, 'no empty or inverted range');
  });

  test('a single-byte file yields one range', () => {
    assert.deepStrictEqual(planRanges(1, 8, 1), [{ start: 0, end: 0 }]);
  });

  test('one connection is the whole file', () => {
    assert.deepStrictEqual(planRanges(500, 1, 1), [{ start: 0, end: 499 }]);
  });
});

describe('downloadFile — assembles correctly', () => {
  test('parallel chunks reassemble to the exact original bytes', async () => {
    const dir = tmpdir();
    const body = makeBody(100_000);
    const dest = path.join(dir, 'model.onnx');

    await downloadFile('https://example/model', dest, {
      connections: 8,
      minChunkBytes: 1024,
      fetchImpl: fakeFetch(body),
    });

    assert.deepStrictEqual(fs.readFileSync(dest), body,
      'a mis-ordered chunk write corrupts the model silently — byte equality is the only real check');
  });

  test('it actually issues parallel range requests', async () => {
    const dir = tmpdir();
    const body = makeBody(80_000);
    let rangeRequests = 0;

    await downloadFile('https://example/model', path.join(dir, 'm'), {
      connections: 8,
      minChunkBytes: 1024,
      fetchImpl: fakeFetch(body, { onRequest: (init) => { if (init.headers?.Range) rangeRequests++; } }),
    });

    assert.strictEqual(rangeRequests, 8, 'the whole point is N connections, not one');
  });

  test('a server without Range support still produces a correct file', async () => {
    // Not every host honours Range. Assuming it did would silently truncate.
    const dir = tmpdir();
    const body = makeBody(50_000);
    const dest = path.join(dir, 'm');

    await downloadFile('https://example/model', dest, {
      connections: 8,
      minChunkBytes: 1024,
      fetchImpl: fakeFetch(body, { ranges: false }),
    });

    assert.deepStrictEqual(fs.readFileSync(dest), body);
  });

  test('progress is reported and reaches the total', async () => {
    const dir = tmpdir();
    const body = makeBody(60_000);
    let last = 0;

    await downloadFile('https://example/model', path.join(dir, 'm'), {
      connections: 4,
      minChunkBytes: 1024,
      fetchImpl: fakeFetch(body),
      onProgress: ({ loaded }) => { last = Math.max(last, loaded); },
    });

    assert.strictEqual(last, 60_000, 'a progress callback that never reaches 100% is what stalled the old timeout');
  });
});

describe('downloadFile — never leaves a corrupt file behind', () => {
  test('a failed chunk leaves NO file at the destination', async () => {
    const dir = tmpdir();
    const dest = path.join(dir, 'model.onnx');
    const body = makeBody(80_000);

    await assert.rejects(downloadFile('https://example/model', dest, {
      connections: 8,
      minChunkBytes: 1024,
      fetchImpl: fakeFetch(body, { failRange: 10_000 }),
    }));

    assert.strictEqual(fs.existsSync(dest), false,
      'a partial file at the real path is indistinguishable from a good one on the next launch');
  });

  test('it does not leave the .part file behind either', async () => {
    const dir = tmpdir();
    const dest = path.join(dir, 'model.onnx');

    await assert.rejects(downloadFile('https://example/model', dest, {
      connections: 8,
      minChunkBytes: 1024,
      fetchImpl: fakeFetch(makeBody(80_000), { failRange: 10_000 }),
    }));

    assert.deepStrictEqual(fs.readdirSync(dir), [], 'no junk left behind on failure');
  });

  test('a size mismatch is caught rather than written', async () => {
    const dir = tmpdir();
    const dest = path.join(dir, 'model.onnx');
    const body = makeBody(1000);

    // Server advertises 1000 but the single-stream body is short.
    const lyingFetch = async (_url, init = {}) => {
      if (init.method === 'HEAD') {
        return { ok: true, status: 200, headers: new Map([['content-length', '1000']]) };
      }
      const short = body.subarray(0, 400);
      return { ok: true, status: 200, arrayBuffer: async () => short.buffer.slice(short.byteOffset, short.byteOffset + short.byteLength) };
    };

    await assert.rejects(
      downloadFile('https://example/model', dest, { connections: 1, fetchImpl: lyingFetch }),
      /size/i,
    );
    assert.strictEqual(fs.existsSync(dest), false);
  });

  test('an existing complete file is not re-downloaded', async () => {
    const dir = tmpdir();
    const dest = path.join(dir, 'model.onnx');
    const body = makeBody(5000);
    fs.writeFileSync(dest, body);
    let fetched = false;

    await downloadFile('https://example/model', dest, {
      connections: 4,
      minChunkBytes: 1024,
      expectedBytes: 5000,
      fetchImpl: async () => { fetched = true; throw new Error('should not fetch'); },
    });

    assert.strictEqual(fetched, false, 'the whole point is not downloading it again');
  });

  test('an existing file of the WRONG size is replaced, not trusted', async () => {
    const dir = tmpdir();
    const dest = path.join(dir, 'model.onnx');
    fs.writeFileSync(dest, Buffer.alloc(17));
    const body = makeBody(5000);

    await downloadFile('https://example/model', dest, {
      connections: 4,
      minChunkBytes: 1024,
      expectedBytes: 5000,
      fetchImpl: fakeFetch(body),
    });

    assert.deepStrictEqual(fs.readFileSync(dest), body,
      'a truncated leftover must self-heal, or the app is stuck loading a corrupt model forever');
  });
});

/**
 * Multi-part assets.
 *
 * GitHub caps a release asset at 2 GB, and the fp32 encoder's weights sidecar is
 * 2,323 MB. Splitting it is not a workaround for that limit so much as a better
 * shape overall: concurrent part-URLs give the same parallelism as Range
 * requests without depending on the server honouring Range at all, which
 * deletes the fallback path and the "server lied about ranges" failure mode.
 *
 * Reassembly is the risk. A part written at the wrong offset produces a file of
 * exactly the right SIZE and entirely wrong CONTENT, and the only symptom is a
 * model that fails to load after a multi-gigabyte download.
 */
describe('downloadParts — reassembling a split asset', () => {
  test('parts are joined in order, byte-identical to the original', async () => {
    const dir = tmpdir();
    const body = makeBody(90_000);
    const parts = [body.subarray(0, 30_000), body.subarray(30_000, 61_000), body.subarray(61_000)];
    const dest = path.join(dir, 'encoder.onnx');

    await downloadParts(
      parts.map((_, i) => `https://example/part${i}`),
      dest,
      { fetchImpl: partFetch(parts) },
    );

    assert.deepStrictEqual(fs.readFileSync(dest), body,
      'a part at the wrong offset yields the right size and the wrong file');
  });

  test('parts of UNEQUAL size still land at the right offsets', async () => {
    // The naive bug: assume every part is the size of the first one.
    const dir = tmpdir();
    const body = makeBody(50_000);
    const parts = [body.subarray(0, 1_000), body.subarray(1_000, 49_000), body.subarray(49_000)];
    const dest = path.join(dir, 'e.onnx');

    await downloadParts(parts.map((_, i) => `https://example/p${i}`), dest, { fetchImpl: partFetch(parts) });

    assert.deepStrictEqual(fs.readFileSync(dest), body);
  });

  test('all parts are fetched concurrently, not one after another', async () => {
    const dir = tmpdir();
    const body = makeBody(60_000);
    const parts = [body.subarray(0, 20_000), body.subarray(20_000, 40_000), body.subarray(40_000)];
    let inFlight = 0, peak = 0;

    await downloadParts(parts.map((_, i) => `https://example/p${i}`), path.join(dir, 'e'), {
      fetchImpl: async (url, init) => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return partFetch(parts)(url, init);
      },
    });

    assert.ok(peak > 1, `parts must overlap — peak concurrency was ${peak}`);
  });

  test('one bad part leaves nothing behind', async () => {
    const dir = tmpdir();
    const body = makeBody(60_000);
    const parts = [body.subarray(0, 30_000), body.subarray(30_000)];

    await assert.rejects(downloadParts(
      ['https://example/p0', 'https://example/p1'],
      path.join(dir, 'e.onnx'),
      { fetchImpl: async (url, init) => {
        if (url.endsWith('p1')) throw new Error('part failed');
        return partFetch(parts)(url, init);
      } },
    ));

    assert.deepStrictEqual(fs.readdirSync(dir), [], 'a half-assembled model must not survive');
  });

  test('a single-element part list behaves like a plain download', async () => {
    const dir = tmpdir();
    const body = makeBody(10_000);
    const dest = path.join(dir, 'e');

    await downloadParts(['https://example/only'], dest, { fetchImpl: partFetch([body]) });

    assert.deepStrictEqual(fs.readFileSync(dest), body);
  });
});
