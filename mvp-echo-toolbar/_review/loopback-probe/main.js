/**
 * End-to-end probe for Phase 1: the REAL model-server + model-store, fetched by
 * a REAL file:// module worker, under the app's own Electron 43.
 *
 * The unit tests cover the server in isolation. This covers the seam, which is
 * where every defect the Windows rounds found actually lived.
 *
 * It answers four things that cannot be answered by reading code:
 *
 *   1. Can a file:// module worker fetch http://127.0.0.1 at all? (The whole
 *      premise. A custom model:// scheme could not.)
 *   2. Do the bytes arrive identically? (A 1.2GB encoder off by one byte fails
 *      late and obscurely inside ORT.)
 *   3. Does a file OVER 1 GiB survive? onnxruntime-web branches at 1073741824
 *      bytes into a preallocate-and-stream path driven entirely by
 *      Content-Length — and the fp32 weights sidecar is 2,435 MB. A sparse file
 *      exercises that branch without moving 2.4GB.
 *   4. Does onnxruntime-web itself — not just fetch() — create a session from a
 *      loopback URL? ORT loads with `fetch(url, {credentials:'same-origin'})`,
 *      which is a different request than a bare fetch().
 *
 * Run:  node_modules/.bin/electron _review/loopback-probe --ozone-platform=headless --no-sandbox --disable-gpu
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createModelServer } = require('../../app/main/model-server');
const { ensureModel } = require('../../app/main/model-store');

// A real ONNX file, if the unpacked build is present. Optional: the probe still
// answers 1-3 without it.
const REAL_ONNX = path.join(
  __dirname, '../../dist/win-unpacked/resources/sherpa_onnx_models',
  'sherpa-onnx-nemo-parakeet-tdt_ctc-110m-en-int8/model.int8.onnx',
);
const BIG_SPARSE = process.env.MVP_PROBE_BIG || '';

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-probe-'));
  const payload = crypto.randomBytes(2 * 1024 * 1024);
  const expectSha = crypto.createHash('sha256').update(payload).digest('hex');

  // Byte counts that match what the store will download, so ensureModel's
  // completeness check passes and NOTHING is fetched from the network.
  const manifest = {
    fp16: [
      { name: 'encoder-model.fp16.onnx', bytes: payload.length, key: 'encoderUrl' },
      { name: 'decoder_joint-model.int8.onnx', bytes: 16, key: 'decoderUrl' },
      { name: 'vocab.txt', bytes: 6, key: 'tokenizerUrl' },
    ],
  };
  fs.writeFileSync(path.join(dir, 'encoder-model.fp16.onnx'), payload);
  fs.writeFileSync(path.join(dir, 'decoder_joint-model.int8.onnx'), Buffer.alloc(16));
  fs.writeFileSync(path.join(dir, 'vocab.txt'), 'hello\n');

  let bigSize = 0;
  if (BIG_SPARSE && fs.existsSync(BIG_SPARSE)) {
    bigSize = fs.statSync(BIG_SPARSE).size;
    fs.copyFileSync(BIG_SPARSE, path.join(dir, 'big.sparse'));
  }
  let realOnnx = false;
  if (!process.env.MVP_PROBE_NO_ORT && fs.existsSync(REAL_ONNX)) {
    fs.copyFileSync(REAL_ONNX, path.join(dir, 'real-model.onnx'));
    realOnnx = true;
  }

  const server = createModelServer({ dir });
  const addr = await server.start();

  // The REAL store and the REAL downloader, wired to the REAL server — the seam
  // under test. Every file is already on disk at its declared size, so the
  // downloader must take its skip path (model-downloader.js:86) and never touch
  // the network. A fetchImpl that throws is how that is proved rather than
  // assumed: if anything reaches out, this rejects.
  let networkCalls = 0;
  const res = await ensureModel('fp16', {
    dir, manifest, urlFor: server.urlFor,
    fetchImpl: () => { networkCalls++; throw new Error('probe: the store must not hit the network when files are complete'); },
  });

  console.log(`\nserver:   ${addr.origin}  token=${addr.token.length} chars`);
  console.log(`store:    ${JSON.stringify(res.urls, null, 2)}`);
  console.log(`network:  ${networkCalls === 0 ? 'NONE — served from disk' : `${networkCalls} calls (WRONG)`}`);

  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, nodeIntegration: true, contextIsolation: false, sandbox: false },
  });
  win.webContents.on('console-message', (_e, _l, m) => console.log(`  [renderer] ${m}`));

  const done = new Promise((resolve) => ipcMain.once('probe-result', (_e, r) => resolve(r)));
  await win.loadFile(path.join(__dirname, 'page.html'));
  win.webContents.send('go', {
    urls: res.urls,
    expectSha,
    expectBytes: payload.length,
    bigUrl: bigSize ? server.urlFor('big.sparse') : null,
    bigSize,
    onnxUrl: realOnnx ? server.urlFor('real-model.onnx') : null,
    ortPath: path.join(__dirname, '../../dist/renderer/assets/ort.bundle.min-CyvNfplx.js'),
  });

  const result = await Promise.race([done, new Promise((r) => setTimeout(() => r('TIMEOUT'), 180000))]);
  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(result, null, 2));

  // The bytes must be identical, not merely the right count. Asserted here
  // rather than eyeballed: a transposition would keep the length and change
  // nothing else visible.
  const enc = Array.isArray(result) && result.find((r) => r.step === 'fetch:encoderUrl');
  console.log(`\nsha expected: ${expectSha}`);
  console.log(`sha served:   ${enc?.sha}`);
  console.log(`BYTES IDENTICAL: ${enc?.sha === expectSha ? 'YES' : 'NO'}`);

  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  app.exit(0);
});
