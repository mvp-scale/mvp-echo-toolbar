/**
 * Items 8-9 — the in-page GPU probe must survive a platform API removal, and
 * must never turn "we could not ask" into "this machine has no GPU".
 *
 * The failure this pins down, observed on real hardware:
 *
 *   WebGpuBridgeAdapter: GPU probe result:
 *     {"available":false,"error":"adapter.requestAdapterInfo is not a function"}
 *   EngineManager: Ignoring saved WebGPU preference -- no usable GPU on this system
 *
 * That was a 3090 Ti. `GPUAdapter.requestAdapterInfo()` was removed in Chrome
 * 131 (replaced by the synchronous `.info`, which shipped in Chrome 127), so
 * on Chromium 150 the call throws — and the old probe let that decide
 * availability. Adapter metadata is cosmetic; having an adapter is the answer.
 *
 * The probe used to exist only as a template string passed to
 * executeJavaScript, which made it untestable by construction. It is now an
 * exported constant, evaluated here against fake adapters modelling each
 * Chromium generation.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { installElectronStub, silenceLogger } = require('../testkit/electron-stub');

installElectronStub();
silenceLogger();

const WebGpuBridgeAdapter = require('../app/stt/adapters/webgpu-bridge-adapter');
const { GPU_PROBE_SOURCE } = WebGpuBridgeAdapter;

/**
 * Evaluate the real probe source against a fake `navigator`.
 *
 * The opening paren must sit on the same line as `return` — the source begins
 * with a newline, and `return\n(...)` is silently rewritten to `return;` by
 * automatic semicolon insertion.
 */
function runProbe(navigatorStub) {
  const fn = new Function('navigator', `return (${GPU_PROBE_SOURCE});`);
  return fn(navigatorStub);
}

const limits = { maxBufferSize: 2147483648 };

/** Chromium 127+ — synchronous `.info`, no legacy method. */
const modernAdapter = {
  info: { device: 'NVIDIA GeForce RTX 3090 Ti', vendor: 'nvidia', architecture: 'ampere' },
  limits,
};

/** Chromium 120 (Electron 28) — legacy method only, no `.info`. */
const legacyAdapter = {
  requestAdapterInfo: async () => ({ device: 'GTX 1650', vendor: 'nvidia', architecture: 'turing' }),
  limits,
};

describe('GPU probe — metadata must not decide availability', () => {
  test('Chromium 150 shape: reads adapter.info', async () => {
    const r = await runProbe({ gpu: { requestAdapter: async () => modernAdapter } });

    assert.strictEqual(r.available, true);
    assert.strictEqual(r.adapterName, 'NVIDIA GeForce RTX 3090 Ti');
    assert.strictEqual(r.vendor, 'nvidia');
  });

  test('Chromium 120 shape: falls back to requestAdapterInfo()', async () => {
    const r = await runProbe({ gpu: { requestAdapter: async () => legacyAdapter } });

    assert.strictEqual(r.available, true);
    assert.strictEqual(r.adapterName, 'GTX 1650');
  });

  test('THE REGRESSION: a throwing requestAdapterInfo must not mean "no GPU"', async () => {
    // Exactly what Chromium 150 did to the old probe.
    const hostile = {
      requestAdapterInfo: () => { throw new TypeError('adapter.requestAdapterInfo is not a function'); },
      limits,
    };

    const r = await runProbe({ gpu: { requestAdapter: async () => hostile } });

    assert.strictEqual(r.available, true, 'an adapter exists, so the GPU is available');
    assert.strictEqual(r.adapterName, 'Unknown GPU', 'name degrades, availability does not');
  });

  test('a masked device name still yields a useful label', async () => {
    // Observed on the real machine: Chromium masks GPUAdapterInfo.device for
    // privacy, so it came back empty while vendor and architecture were
    // populated — and the probe reported the useless "Unknown GPU". Compose
    // from what IS available rather than giving up.
    const masked = { info: { device: '', vendor: 'nvidia', architecture: 'turing' }, limits };

    const r = await runProbe({ gpu: { requestAdapter: async () => masked } });

    assert.strictEqual(r.available, true);
    assert.match(r.adapterName, /nvidia/i);
    assert.match(r.adapterName, /turing/i);
    assert.notStrictEqual(r.adapterName, 'Unknown GPU');
  });

  test('an adapter with no metadata at all is still available', async () => {
    const r = await runProbe({ gpu: { requestAdapter: async () => ({ limits }) } });

    assert.strictEqual(r.available, true);
    assert.strictEqual(r.adapterName, 'Unknown GPU');
  });

  test('missing limits does not fail the probe', async () => {
    const r = await runProbe({ gpu: { requestAdapter: async () => ({ info: { device: 'X' } }) } });

    assert.strictEqual(r.available, true);
    assert.strictEqual(r.maxBufferSize, null);
  });
});

describe('GPU probe — determinate vs indeterminate negatives', () => {
  test('no navigator.gpu is a DETERMINATE negative', async () => {
    const r = await runProbe({});

    assert.strictEqual(r.available, false);
    assert.ok(!r.indeterminate, 'the API being absent is a real answer');
  });

  test('no adapter returned is a DETERMINATE negative', async () => {
    const r = await runProbe({ gpu: { requestAdapter: async () => null } });

    assert.strictEqual(r.available, false);
    assert.ok(!r.indeterminate, 'asking and getting nothing is a real answer');
  });

  test('requestAdapter throwing is INDETERMINATE', async () => {
    const r = await runProbe({
      gpu: { requestAdapter: async () => { throw new Error('device lost during probe'); } },
    });

    assert.strictEqual(r.available, false);
    assert.strictEqual(r.indeterminate, true, 'failing to ask is not a hardware verdict');
  });
});

describe('WebGpuBridgeAdapter._probeGpu — caching discipline', () => {
  /** Hidden-window stand-in returning a canned probe result. */
  function windowReturning(result) {
    return () => ({ isDestroyed: () => false, webContents: { executeJavaScript: async () => result } });
  }

  test('an indeterminate result is NOT cached', async () => {
    const adapter = new WebGpuBridgeAdapter();
    adapter.setHiddenWindowGetter(
      windowReturning({ available: false, indeterminate: true, error: 'requestAdapter threw' }),
    );

    await adapter._probeGpu();

    assert.strictEqual(adapter.getGpuCapability(), null,
      'caching an indeterminate probe makes a transient failure permanent for the process');
  });

  test('a determinate result IS cached', async () => {
    const adapter = new WebGpuBridgeAdapter();
    adapter.setHiddenWindowGetter(windowReturning({ available: false, error: 'No GPU adapter found' }));

    await adapter._probeGpu();

    assert.ok(adapter.getGpuCapability(), 'a real answer should not be re-probed');
    assert.strictEqual(adapter.getGpuCapability().available, false);
  });

  test('an indeterminate probe leaves capability "unknown", so a saved preference survives', async () => {
    const adapter = new WebGpuBridgeAdapter();
    adapter.setHiddenWindowGetter(
      windowReturning({ available: false, indeterminate: true, error: 'requestAdapter threw' }),
    );

    assert.strictEqual(await adapter.probeGpuCapability(), 'unknown',
      '"unknown" is the only value that does not override an explicit user choice');
  });
});
