/**
 * Fix 9 (adapter half) — the three-state hardware probe.
 *
 * The engine-selection tests substitute a fake adapter, so they can't catch a
 * regression in the REAL adapter's three-state contract. These exercise
 * `WebGpuBridgeAdapter` directly.
 *
 * The distinction under test: "we asked and there is no GPU" (unavailable)
 * versus "we could not ask yet" (unknown). Collapsing the second into the
 * first is what would disable WebGPU on every cold boot, because the renderer
 * that answers the probe cannot possibly be up when startup first asks.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { installElectronStub, silenceLogger } = require('../testkit/electron-stub');

installElectronStub();
silenceLogger();

const WebGpuBridgeAdapter = require('../app/stt/adapters/webgpu-bridge-adapter');

/** A hidden-window stand-in whose in-page probe returns `result`. */
function windowReturning(result) {
  return () => ({
    isDestroyed: () => false,
    webContents: { executeJavaScript: async () => result },
  });
}

describe('WebGpuBridgeAdapter.probeGpuCapability', () => {
  test('reports "unknown" when the renderer is not up yet', async () => {
    const adapter = new WebGpuBridgeAdapter();
    adapter.setHiddenWindowGetter(() => null);

    assert.strictEqual(await adapter.probeGpuCapability(), 'unknown',
      'not being able to ask is not the same as there being no GPU');
  });

  test('reports "unavailable" when the probe ran and found no adapter', async () => {
    const adapter = new WebGpuBridgeAdapter();
    adapter.setHiddenWindowGetter(
      windowReturning({ available: false, error: 'No GPU adapter found' }),
    );

    assert.strictEqual(await adapter.probeGpuCapability(), 'unavailable');
  });

  test('reports "available" when the probe found a GPU', async () => {
    const adapter = new WebGpuBridgeAdapter();
    adapter.setHiddenWindowGetter(
      windowReturning({ available: true, adapterName: 'Test GPU', vendor: 'test' }),
    );

    assert.strictEqual(await adapter.probeGpuCapability(), 'available');
  });

  test('does not cache an indeterminate result as a permanent negative', async () => {
    // The original bug: isAvailable() cached whatever _probeGpu() returned,
    // including "hidden window not ready". That froze a startup-timing
    // artifact in as "this machine has no GPU" for the whole session.
    const adapter = new WebGpuBridgeAdapter();

    adapter.setHiddenWindowGetter(() => null);
    assert.strictEqual(await adapter.probeGpuCapability(), 'unknown');

    // Renderer is up now and does have a GPU.
    adapter.setHiddenWindowGetter(
      windowReturning({ available: true, adapterName: 'Test GPU', vendor: 'test' }),
    );
    assert.strictEqual(await adapter.probeGpuCapability(), 'available',
      'an earlier unaskable probe must not be remembered as a negative');
  });

  test('caches a determinate result rather than re-probing', async () => {
    const adapter = new WebGpuBridgeAdapter();
    let probes = 0;
    adapter.setHiddenWindowGetter(() => ({
      isDestroyed: () => false,
      webContents: {
        executeJavaScript: async () => { probes += 1; return { available: true }; },
      },
    }));

    await adapter.probeGpuCapability();
    await adapter.probeGpuCapability();

    assert.strictEqual(probes, 1, 'a settled answer should be reused');
  });
});
