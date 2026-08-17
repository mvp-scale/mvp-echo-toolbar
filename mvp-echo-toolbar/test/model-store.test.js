/**
 * The on-disk model store.
 *
 * Two properties here are the ones that bite in production and cannot be seen
 * by reading the code: that a machine downloads at most once, and that a
 * variant switch does not silently double disk usage.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MANIFEST, modelDir, isComplete, pruneOtherVariants, ensureModel,
} = require('../app/main/model-store');

/**
 * A byte-sized stand-in for the real manifest.
 *
 * The real one declares a 1.18GB encoder; using it here meant every size check
 * wrote 1.2GB to disk and the suite took 14 seconds. The SHAPE is what is under
 * test, not the sizes — so the manifest is injected, exactly like fetchImpl.
 */
const TINY = {
  fp16: [
    { name: 'encoder-model.fp16.onnx', bytes: 4096, key: 'encoderUrl' },
    { name: 'decoder_joint-model.int8.onnx', bytes: 256, key: 'decoderUrl' },
    { name: 'vocab.txt', bytes: 32, key: 'tokenizerUrl' },
  ],
  int8: [
    { name: 'encoder-model.int8.onnx', bytes: 2048, key: 'encoderUrl' },
    { name: 'decoder_joint-model.int8.onnx', bytes: 256, key: 'decoderUrl' },
    { name: 'vocab.txt', bytes: 32, key: 'tokenizerUrl' },
  ],
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-store-'));

/** Write every file for a variant at its declared size. */
function populate(dir, variant, { short = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of MANIFEST[variant]) {
    fs.writeFileSync(path.join(dir, f.name), Buffer.alloc(f.name === short ? 5 : f.bytes > 4096 ? 4096 : f.bytes));
  }
}

/** A download stub that records calls and writes the declared size. */
function fakeDownload(calls) {
  return async (url, dest, opts) => {
    calls.push(url);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.alloc(opts.expectedBytes));
    opts.onProgress?.({ loaded: opts.expectedBytes, total: opts.expectedBytes });
    return { path: dest, bytes: opts.expectedBytes, fromCache: false };
  };
}

describe('modelDir — Local, never Roaming', () => {
  test('it uses LOCALAPPDATA, not the userData path', () => {
    // userData is %APPDATA%\Roaming on Windows. A gigabyte there is synced to a
    // file server at every logon on a domain-joined machine — and moving it
    // afterwards means relocating it on every user's disk.
    const dir = modelDir({ localAppData: 'C:\\Users\\x\\AppData\\Local' });

    assert.match(dir, /Local/);
    assert.doesNotMatch(dir, /Roaming/);
  });

  test('it falls back when LOCALAPPDATA is absent, rather than throwing', () => {
    // macOS and Linux have no LOCALAPPDATA; the app must still run.
    assert.ok(modelDir({ localAppData: undefined, fallbackDir: '/home/u/.config' }));
  });

  test('with neither, it fails loudly instead of writing somewhere arbitrary', () => {
    assert.throws(() => modelDir({ localAppData: undefined, fallbackDir: undefined }));
  });
});

describe('isComplete — size is the authority', () => {
  test('all files present at the right size is complete', () => {
    const dir = tmp();
    for (const f of TINY.fp16) fs.writeFileSync(path.join(dir, f.name), Buffer.alloc(f.bytes));

    assert.strictEqual(isComplete('fp16', dir, TINY), true);
  });

  test('a truncated file is NOT complete', () => {
    // The self-heal case: antivirus, a full disk, or a crash mid-write leaves a
    // file that exists and is wrong. Existence alone would trust it forever.
    const dir = tmp();
    for (const f of TINY.fp16) fs.writeFileSync(path.join(dir, f.name), Buffer.alloc(f.bytes));
    fs.writeFileSync(path.join(dir, 'vocab.txt'), Buffer.alloc(3));

    assert.strictEqual(isComplete('fp16', dir, TINY), false);
  });

  test('a missing file is not complete', () => {
    const dir = tmp();
    assert.strictEqual(isComplete('fp16', dir, TINY), false);
  });

  test('an unknown variant is not complete rather than throwing', () => {
    assert.strictEqual(isComplete('fp64', tmp(), TINY), false);
  });
});

describe('pruneOtherVariants — no accumulation', () => {
  test('it deletes the encoder of the variant no longer in use', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'encoder-model.fp16.onnx'), Buffer.alloc(10));
    fs.writeFileSync(path.join(dir, 'encoder-model.int8.onnx'), Buffer.alloc(10));

    pruneOtherVariants('fp16', dir, TINY);

    assert.strictEqual(fs.existsSync(path.join(dir, 'encoder-model.fp16.onnx')), true);
    assert.strictEqual(fs.existsSync(path.join(dir, 'encoder-model.int8.onnx')), false,
      'a stale encoder is a gigabyte of dead weight');
  });

  test('it does NOT delete files the kept variant shares', () => {
    // decoder and vocab appear in every variant. Pruning by variant naively
    // would delete the decoder the kept variant still needs.
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'decoder_joint-model.int8.onnx'), Buffer.alloc(10));
    fs.writeFileSync(path.join(dir, 'vocab.txt'), Buffer.alloc(10));

    pruneOtherVariants('fp16', dir, TINY);

    assert.strictEqual(fs.existsSync(path.join(dir, 'decoder_joint-model.int8.onnx')), true);
    assert.strictEqual(fs.existsSync(path.join(dir, 'vocab.txt')), true);
  });

  test('it tolerates files that are not there', () => {
    assert.doesNotThrow(() => pruneOtherVariants('fp16', tmp()));
  });
});

describe('ensureModel', () => {
  test('it downloads every file for the variant and returns fromUrls-shaped urls', async () => {
    const dir = tmp();
    const calls = [];

    const { urls } = await ensureModel('fp16', { dir, manifest: TINY, fetchImpl: () => {}, download: fakeDownload(calls) });

    assert.strictEqual(calls.length, TINY.fp16.length);
    assert.ok(urls.encoderUrl.startsWith('model://'), 'urls must point at the scheme, not the network');
    assert.ok(urls.decoderUrl && urls.tokenizerUrl, 'fromUrls needs all three');
  });

  test('progress is cumulative across files and ends at 100%', async () => {
    const dir = tmp();
    let lastPct = 0;

    await ensureModel('fp16', {
      dir, manifest: TINY, fetchImpl: () => {}, download: fakeDownload([]),
      onProgress: ({ pct }) => { lastPct = pct; },
    });

    assert.strictEqual(lastPct, 100, 'per-file progress that resets to 0 reads as a stuck download');
  });

  test('the base URL is overridable, for a mirror or an air-gapped deployment', async () => {
    const dir = tmp();
    const calls = [];

    await ensureModel('fp16', {
      dir, base: 'https://mirror.internal/models', manifest: TINY, fetchImpl: () => {}, download: fakeDownload(calls),
    });

    assert.ok(calls.every((u) => u.startsWith('https://mirror.internal/models/')), calls[0]);
  });

  test('switching variants prunes the one left behind', async () => {
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'encoder-model.int8.onnx'), Buffer.alloc(10));

    const { pruned } = await ensureModel('fp16', { dir, manifest: TINY, fetchImpl: () => {}, download: fakeDownload([]) });

    assert.deepStrictEqual(pruned, ['encoder-model.int8.onnx']);
  });

  test('a failed download does NOT prune the variant already on disk', async () => {
    // Otherwise a failed switch leaves the machine with neither model.
    const dir = tmp();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'encoder-model.int8.onnx'), Buffer.alloc(10));

    await assert.rejects(ensureModel('fp16', {
      dir, manifest: TINY, fetchImpl: () => {}, download: async () => { throw new Error('network down'); },
    }));

    assert.strictEqual(fs.existsSync(path.join(dir, 'encoder-model.int8.onnx')), true,
      'a failed download must not cost the user the model they already had');
  });

  test('an unknown variant is rejected by name', async () => {
    await assert.rejects(ensureModel('fp64', { dir: tmp(), manifest: TINY, fetchImpl: () => {} }), /fp64/);
  });
});

/**
 * fp32 — the variant with an external-data sidecar, split across assets.
 *
 * Two things make it different from fp16 and both are easy to get wrong:
 *
 *   1. The weights live in a separate `.onnx.data` file. fromUrls needs
 *      `encoderDataUrl` AND `filenames`, because it derives the external-data
 *      path as `filenames.encoder + '.data'`. Omit filenames and the session
 *      loads a graph with no weights.
 *   2. That sidecar is 2,435,420,160 bytes — over GitHub's 2 GB asset cap — so
 *      it is published as parts and reassembled on download.
 */
describe('fp32 — external data, split into parts', () => {
  const FP32 = {
    fp32: [
      { name: 'encoder-model.onnx', bytes: 100, key: 'encoderUrl' },
      { name: 'encoder-model.onnx.data', bytes: 300, key: 'encoderDataUrl',
        parts: ['encoder-model.onnx.data.part0', 'encoder-model.onnx.data.part1'] },
      { name: 'decoder_joint-model.int8.onnx', bytes: 50, key: 'decoderUrl' },
      { name: 'vocab.txt', bytes: 10, key: 'tokenizerUrl' },
    ],
  };

  test('a part-ed file goes through downloadParts, not downloadFile', async () => {
    const dir = tmp();
    const single = [], multi = [];

    await ensureModel('fp32', {
      dir, manifest: FP32, fetchImpl: () => {},
      download: async (url, dest, o) => { single.push(url); fs.writeFileSync(dest, Buffer.alloc(o.expectedBytes)); return {}; },
      downloadMulti: async (urls, dest, o) => { multi.push(...urls); fs.writeFileSync(dest, Buffer.alloc(o.expectedBytes)); return {}; },
    });

    assert.strictEqual(multi.length, 2, 'both parts must be requested');
    assert.ok(multi[0].endsWith('.part0') && multi[1].endsWith('.part1'), 'and in order');
    assert.ok(!single.some((u) => u.includes('.data')), 'the sidecar must not be fetched as one asset');
  });

  test('it returns encoderDataUrl, or the session loads a graph with no weights', async () => {
    const dir = tmp();

    const { urls } = await ensureModel('fp32', {
      dir, manifest: FP32, fetchImpl: () => {},
      download: async (_u, d, o) => { fs.writeFileSync(d, Buffer.alloc(o.expectedBytes)); return {}; },
      downloadMulti: async (_u, d, o) => { fs.writeFileSync(d, Buffer.alloc(o.expectedBytes)); return {}; },
    });

    assert.ok(urls.encoderDataUrl, 'fromUrls cannot attach external data without it');
    assert.match(urls.encoderDataUrl, /encoder-model\.onnx\.data$/);
  });

  test('it returns filenames, which fromUrls needs to derive the external-data path', async () => {
    const dir = tmp();

    const res = await ensureModel('fp32', {
      dir, manifest: FP32, fetchImpl: () => {},
      download: async (_u, d, o) => { fs.writeFileSync(d, Buffer.alloc(o.expectedBytes)); return {}; },
      downloadMulti: async (_u, d, o) => { fs.writeFileSync(d, Buffer.alloc(o.expectedBytes)); return {}; },
    });

    assert.strictEqual(res.filenames?.encoder, 'encoder-model.onnx',
      'fromUrls builds the external path as filenames.encoder + ".data"');
    assert.strictEqual(res.filenames?.decoder, 'decoder_joint-model.int8.onnx');
  });

  test('the real manifest declares fp32 with a split sidecar', () => {
    const data = MANIFEST.fp32?.find((f) => f.name.endsWith('.onnx.data'));

    assert.ok(data, 'fp32 must be present or older GPUs stay on the slow source');
    assert.ok(Array.isArray(data.parts) && data.parts.length >= 2,
      'a 2,435 MB asset exceeds the 2 GB cap and must be split');
    assert.ok(data.bytes > 2 * 1024 * 1024 * 1024, 'sanity: this is the oversized one');
  });

  test('every real manifest entry declares which fromUrls key it fills', () => {
    for (const [variant, files] of Object.entries(MANIFEST)) {
      for (const f of files) {
        assert.ok(f.key, `${variant}/${f.name} has no key`);
        assert.ok(Number.isInteger(f.bytes) && f.bytes > 0, `${variant}/${f.name} has no byte count`);
      }
    }
  });
});
