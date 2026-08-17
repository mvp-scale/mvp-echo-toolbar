/**
 * Where the GPU model lives on disk, and how it gets there.
 *
 * Replaces parakeet.js's IndexedDB cache for the file layer. That cache was
 * observed losing a healthy 2.3GB copy between two inits thirty seconds apart,
 * with `persistent=true` reported both times — after which the app re-downloaded
 * the whole model. Files on disk with known sizes do not do that, and can be
 * checked without a browser.
 *
 * Two decisions are load-bearing.
 *
 * LOCAL, NOT ROAMING. `app.getPath('userData')` is %APPDATA%\Roaming on Windows.
 * On a domain-joined machine with roaming profiles, a gigabyte there is synced
 * to a server at every logon. Config stays in Roaming; model blobs go to Local.
 *
 * OUR OWN CDN, NOT HUGGINGFACE. Measured single-stream: 29.9 MB/s from GitHub
 * release assets against 4.9 MB/s from huggingface.co. Six times faster on ONE
 * connection, which is what makes this viable even if Chromium collapses
 * concurrent requests onto a single HTTP/2 socket. The model is cc-by-4.0, so
 * redistribution is permitted with attribution.
 */

const fs = require('fs');
const path = require('path');
const { downloadFile, downloadParts } = require('./model-downloader');

/**
 * Where the assets are published. Overridable so an air-gapped or
 * firewalled deployment can point at its own mirror without a rebuild — the
 * files are static and content-identical wherever they are served from.
 */
const DEFAULT_BASE =
  process.env.MVP_MODEL_BASE ||
  'https://github.com/mvp-scale/mvp-echo-toolbar/releases/download/models-parakeet-tdt-0.6b-v2';

/**
 * What each encoder variant needs on disk.
 *
 * `bytes` is the authority for "is this file already complete" — it is checked
 * on every launch, so a truncated or antivirus-mangled file self-heals instead
 * of failing to load forever. Sizes are EXACT byte counts from the upstream repo
 * API — not converted from megabytes, because this is compared with ===.
 */
const MANIFEST = {
  fp16: [
    { name: 'encoder-model.fp16.onnx', bytes: 1238960452, key: 'encoderUrl' },
    { name: 'decoder_joint-model.int8.onnx', bytes: 8998286, key: 'decoderUrl' },
    { name: 'vocab.txt', bytes: 10409, key: 'tokenizerUrl' },
  ],
  /**
   * fp32 — for GPUs without shader-f16. Two differences from the others:
   * the weights are an external `.onnx.data` sidecar, and that sidecar is
   * 2,435 MB, over GitHub's 2 GB per-asset cap, so it is published as parts.
   */
  fp32: [
    { name: 'encoder-model.onnx', bytes: 41770866, key: 'encoderUrl' },
    {
      name: 'encoder-model.onnx.data',
      bytes: 2435420160,
      key: 'encoderDataUrl',
      parts: ['encoder-model.onnx.data.part0', 'encoder-model.onnx.data.part1'],
    },
    { name: 'decoder_joint-model.int8.onnx', bytes: 8998286, key: 'decoderUrl' },
    { name: 'vocab.txt', bytes: 10409, key: 'tokenizerUrl' },
  ],
  int8: [
    { name: 'encoder-model.int8.onnx', bytes: 652184014, key: 'encoderUrl' },
    { name: 'decoder_joint-model.int8.onnx', bytes: 8998286, key: 'decoderUrl' },
    { name: 'vocab.txt', bytes: 10409, key: 'tokenizerUrl' },
  ],
};

/**
 * The directory holding model blobs.
 *
 * Deliberately NOT userData. See the header — Roaming profiles sync it.
 */
function modelDir({ localAppData = process.env.LOCALAPPDATA, fallbackDir } = {}) {
  const base = localAppData || fallbackDir;
  if (!base) throw new Error('modelDir: no local application data directory available');
  return path.join(base, 'mvp-echo-toolbar', 'models');
}

/** Is every file for `variant` present at its expected size? */
function isComplete(variant, dir, manifest = MANIFEST) {
  const files = manifest[variant];
  if (!files) return false;
  return files.every((f) => {
    try {
      return fs.statSync(path.join(dir, f.name)).size === f.bytes;
    } catch {
      return false;
    }
  });
}

/**
 * Delete every variant that is not `keep`.
 *
 * At 1.2GB each, leaving the old one behind after a switch silently doubles
 * disk use — and a machine that moves fp32 -> fp16 has no further use for the
 * files it just stopped loading.
 */
function pruneOtherVariants(keep, dir, manifest = MANIFEST) {
  const wanted = new Set((manifest[keep] || []).map((f) => f.name));
  const removed = [];
  for (const variant of Object.keys(manifest)) {
    if (variant === keep) continue;
    for (const f of manifest[variant]) {
      if (wanted.has(f.name)) continue; // shared between variants (decoder, vocab)
      const p = path.join(dir, f.name);
      try {
        if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); removed.push(f.name); }
      } catch { /* a file we cannot delete is not a reason to fail the load */ }
    }
  }
  return removed;
}

/**
 * Ensure every file for `variant` is on disk, then return the URL map that
 * `ParakeetModel.fromUrls` expects — pointing at the custom scheme, not the
 * network.
 *
 * Downloading is skipped entirely when the files are already present and the
 * right size, which is the whole point: one download per machine, ever.
 */
async function ensureModel(variant, opts = {}) {
  const {
    dir = modelDir(opts),
    base = DEFAULT_BASE,
    fetchImpl,
    onProgress,
    connections = 8,
    scheme = 'model',
    // Injected so the orchestration is testable without moving gigabytes.
    download = downloadFile,
    downloadMulti = downloadParts,
    // Injected so tests can declare byte-sized files instead of writing
    // gigabytes to disk to exercise a size check.
    manifest = MANIFEST,
  } = opts;

  const files = manifest[variant];
  if (!files) throw new Error(`unknown model variant: ${variant}`);

  fs.mkdirSync(dir, { recursive: true });

  const total = files.reduce((n, f) => n + f.bytes, 0);
  let done = 0;

  for (const f of files) {
    const dest = path.join(dir, f.name);
    const report = ({ loaded }) => onProgress?.({
      file: f.name,
      loaded: done + loaded,
      total,
      pct: Math.round(((done + loaded) / total) * 100),
    });

    if (Array.isArray(f.parts)) {
      await downloadMulti(f.parts.map((p) => `${base}/${p}`), dest, {
        fetchImpl, onProgress: report, expectedBytes: f.bytes, connections,
      });
    } else {
      await download(`${base}/${f.name}`, dest, {
        fetchImpl, onProgress: report, expectedBytes: f.bytes, connections,
      });
    }
    done += f.bytes;
  }

  // Only once the wanted variant is verifiably complete — never before, or a
  // failed download leaves the machine with neither.
  const pruned = pruneOtherVariants(variant, dir, manifest);

  const urls = {};
  for (const f of files) urls[f.key] = `${scheme}://models/${f.name}`;

  // fromUrls derives the external-data path as `filenames.encoder + '.data'`.
  // Without filenames it attaches no external data at all and the fp32 session
  // loads a graph with no weights — which fails late and obscurely.
  const filenames = {
    encoder: files.find((f) => f.key === 'encoderUrl')?.name,
    decoder: files.find((f) => f.key === 'decoderUrl')?.name,
  };

  return { dir, urls, filenames, pruned, bytes: total };
}

module.exports = { MANIFEST, DEFAULT_BASE, modelDir, isComplete, pruneOtherVariants, ensureModel };
