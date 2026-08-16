/**
 * The hosted endpoint must survive being looked at.
 *
 * Reproduced headlessly against a live MVP-Bridge, driving the real
 * EngineManager and RemoteAdapter:
 *
 *   restart          -> endpointUrl = "http://192.168.1.169:20300/..."   OK
 *   open Settings    -> panel receives {"activeModelId":null,...}        field renders EMPTY
 *   save effect      -> endpointUrl = null                               ERASED
 *
 * `cloud:get-config` returned `this.activeAdapter.getConfig()`. With the CPU
 * engine selected — the default, and what most users are on — that is the local
 * sidecar's config, which has no `endpointUrl` at all. SettingsPanel rendered an
 * empty field, and the effect that saves on change then posted that empty value
 * straight back. Merely OPENING Settings deleted the endpoint.
 *
 * This is the same shape as the four routing bugs before it: the operation is
 * about the remote endpoint, so it must resolve to the remote adapter. What
 * happens to be active is irrelevant to it.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { installElectronStub, silenceLogger } = require('../testkit/electron-stub');

installElectronStub();
silenceLogger();

const { EngineManager } = require('../app/stt/engine-manager');
const { createState, select } = require('../app/stt/engine-state');

const ENDPOINT = 'http://192.168.1.169:20300/v1/audio/transcriptions';

/** A manager holding a saved endpoint, with the CPU engine selected. */
function managerOnCpuWithEndpoint() {
  const mgr = new EngineManager();
  mgr._saveEngineState = () => {};
  mgr.configureEndpoint({ endpointUrl: ENDPOINT, apiKey: 'sk-test' });
  mgr._applyState(select(createState(), 'local-fast'));
  return mgr;
}

describe('cloud:get-config is about the endpoint, not about what is active', () => {
  test('it reports the saved endpoint while the CPU engine is selected', () => {
    const mgr = managerOnCpuWithEndpoint();

    const cfg = mgr.getCloudConfig();

    assert.strictEqual(cfg.endpointUrl, ENDPOINT,
      'Settings cannot show an endpoint it was never told about');
    assert.strictEqual(cfg.apiKey, 'sk-test');
  });

  test('it still reports the selected model, which is a different question', () => {
    const mgr = managerOnCpuWithEndpoint();

    assert.strictEqual(mgr.getCloudConfig().selectedModel, 'local-fast');
  });

  test('it does not leak a local model id in as endpoint config', () => {
    // The specific misreading that lit a green "Connected" dot on an empty
    // endpoint box: the local adapter answers `isConfigured: true` because a
    // local MODEL is set, and SettingsPanel read that as "the endpoint is
    // reachable". Whether an endpoint works is a question only a request to it
    // can answer, so nothing here may claim it.
    const mgr = managerOnCpuWithEndpoint();

    assert.strictEqual(mgr.getCloudConfig().isConfigured, undefined,
      'isConfigured meant three different things; the endpoint surface must not carry it');
  });
});

describe('the round trip SettingsPanel performs must be non-destructive', () => {
  test('reading the config and posting it back does not erase the endpoint', () => {
    const mgr = managerOnCpuWithEndpoint();

    // Exactly what the panel does: load on mount, then the save effect fires
    // once configLoaded flips and posts whatever the fields are holding.
    const onMount = mgr.getCloudConfig();
    mgr.configureEndpoint({ endpointUrl: onMount.endpointUrl || '', apiKey: onMount.apiKey || '' });

    assert.strictEqual(mgr.remoteAdapter.endpointUrl, ENDPOINT,
      'opening Settings must never be able to delete the endpoint');
    assert.strictEqual(mgr.remoteAdapter.apiKey, 'sk-test');
  });

  test('a model id cannot arrive through the endpoint channel', () => {
    // SettingsPanel used to fire cloud:configure({model}) after every switch,
    // including for local and webgpu models. That set the REMOTE adapter's
    // selectedModel to things like "local-fast" and "webgpu-parakeet-0.6b" and
    // persisted them in toolbar-endpoint-config.json — which is how three
    // config files came to hold three different model ids at once. The caller
    // is fixed, but the channel should refuse it regardless.
    const mgr = managerOnCpuWithEndpoint();
    const before = mgr.remoteAdapter.selectedModel;

    mgr.configureEndpoint({ endpointUrl: ENDPOINT, apiKey: 'sk-test', model: 'webgpu-parakeet-0.6b' });

    assert.strictEqual(mgr.remoteAdapter.selectedModel, before,
      'which model is selected is the record\'s business, not the endpoint form\'s');
  });

  test('a deliberate clear still works', () => {
    // The fix must not become "the endpoint can never be removed". An empty
    // value the USER actually typed has to take effect.
    const mgr = managerOnCpuWithEndpoint();

    mgr.configureEndpoint({ endpointUrl: '', apiKey: '' });

    assert.strictEqual(mgr.remoteAdapter.endpointUrl, null);
  });
});
