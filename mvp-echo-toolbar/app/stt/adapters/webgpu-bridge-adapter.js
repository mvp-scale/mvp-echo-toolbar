/**
 * WebGpuBridgeAdapter -- Engine Port adapter for on-device WebGPU inference.
 *
 * WebGPU is a browser API that only runs in the renderer process, but the
 * EngineManager lives in the main process.  This adapter acts as an IPC bridge:
 *
 *  - Model management (download, list, switch) happens in main via WebGpuModelManager
 *  - GPU detection delegates to the renderer via IPC
 *  - Transcription in the normal flow is handled renderer-side (CaptureApp
 *    short-circuits before hitting processAudio).  The transcribe() method
 *    here exists for interface compliance and as a fallback IPC path.
 *
 * Implements the Engine Port contract (see engine-port.js).
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { WebGpuModelManager, MODEL_ID } = require('../webgpu-model-manager');
const { log } = require('../../main/logger');

/**
 * The in-page WebGPU probe, injected into the hidden renderer via
 * executeJavaScript. Kept as an exported constant so it can be evaluated
 * against fake adapters in tests — a probe that only exists as a string
 * argument is untestable, which is why an API removal reached production.
 *
 * Two rules encoded here, both learned the hard way:
 *
 * 1. HAVING AN ADAPTER IS THE AVAILABILITY ANSWER. Adapter metadata is
 *    cosmetic. `requestAdapterInfo()` was removed in Chrome 131 and `.info`
 *    did not exist before Chrome 127, so on any given Chromium exactly one of
 *    them works. Letting a metadata failure decide availability is what made
 *    Electron 43 report "no usable GPU on this system" on a working 3090.
 *
 * 2. AN EXCEPTION IS INDETERMINATE, NOT A HARDWARE VERDICT. Only "no
 *    navigator.gpu" and "no adapter returned" are determinate negatives.
 *    Anything thrown means we failed to ASK, and the caller must not cache
 *    that or act on it as "this machine has no GPU".
 */
const GPU_PROBE_SOURCE = `
  (async () => {
    if (!navigator.gpu) {
      return { available: false, error: 'WebGPU not supported in this browser' };
    }
    let adapter;
    try {
      adapter = await navigator.gpu.requestAdapter();
    } catch (err) {
      return { available: false, indeterminate: true, error: 'requestAdapter threw: ' + err.message };
    }
    if (!adapter) {
      return { available: false, error: 'No GPU adapter found' };
    }

    // Best-effort metadata. Never allowed to affect \`available\`.
    let info = {};
    try {
      if (adapter.info) {
        info = adapter.info;
      } else if (typeof adapter.requestAdapterInfo === 'function') {
        info = await adapter.requestAdapterInfo();
      }
    } catch (_e) { /* metadata only — an unknown name is not a missing GPU */ }

    let maxBufferSize = null;
    try { maxBufferSize = adapter.limits.maxBufferSize; } catch (_e) { /* optional */ }

    // Chromium masks GPUAdapterInfo.device for privacy on most platforms, so
    // it is routinely empty while vendor and architecture are populated.
    // Reporting "Unknown GPU" next to a perfectly good "nvidia / turing" is a
    // self-inflicted loss of information — compose from whatever is present.
    const composed = [info.vendor, info.architecture].filter(Boolean).join(' ');
    const adapterName = info.device || info.description || composed || 'Unknown GPU';

    return {
      available: true,
      adapterName,
      vendor: info.vendor || 'Unknown',
      architecture: info.architecture || '',
      maxBufferSize,
    };
  })()
`;

class WebGpuBridgeAdapter {
  constructor() {
    this.modelManager = new WebGpuModelManager();
    this.activeModelId = null;
    this.configPath = path.join(app.getPath('userData'), 'webgpu-adapter-config.json');
    this._gpuCapability = null; // cached from renderer probe
    this._getHiddenWindow = () => null; // set via setHiddenWindowGetter()
    this._loadConfig();
  }

  _loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.activeModelId = data.activeModelId || null;
      }
    } catch (err) {
      log('WebGpuBridgeAdapter: failed to load config:', err.message);
    }
  }

  _saveConfig() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify({
        activeModelId: this.activeModelId,
      }, null, 2));
    } catch (err) {
      log('WebGpuBridgeAdapter: failed to save config:', err.message);
    }
  }

  /**
   * Provide a getter for the hidden window. Resolved lazily at probe time
   * so the adapter doesn't have to be re-wired after the window is created.
   * @param {() => BrowserWindow|null} getter
   */
  setHiddenWindowGetter(getter) {
    this._getHiddenWindow = getter || (() => null);
  }

  // ── Engine Port: transcribe ──

  /**
   * Transcribe is handled in the renderer via parakeet.js InferenceOrchestrator.
   * CaptureApp short-circuits before audio reaches the main process when WebGPU is active.
   * This method exists only for Engine Port interface compliance — hitting it is always a bug.
   */
  async transcribe(_audioFilePath, _options = {}) {
    throw new Error(
      'WebGPU: transcribe() called on main-process adapter. ' +
      'Audio should be processed in the renderer via InferenceOrchestrator. ' +
      'This indicates the recording used the wrong capture mode.'
    );
  }

  // ── Engine Port: isAvailable ──

  async isAvailable() {
    // Check if model is downloaded
    const hasModel = this.activeModelId && this.modelManager.isModelDownloaded(this.activeModelId);

    // Check GPU capability. Only cache a DETERMINATE result: an indeterminate
    // probe (hidden window not up yet) must not be frozen in as "no GPU" for
    // the rest of the session -- _probeGpu() itself caches only on success.
    const capability = this._gpuCapability || await this._probeGpu();
    if (!capability.indeterminate) {
      this._gpuCapability = capability;
    }

    if (!capability.available) {
      return { available: false, error: capability.error || 'WebGPU not available on this system' };
    }
    if (!hasModel) {
      return { available: false, error: 'WebGPU model not downloaded' };
    }
    return { available: true };
  }

  // ── Hardware-only capability probe (three-state) ──

  /**
   * Probe whether this machine *physically* has a usable GPU, independent of
   * whether the model happens to be loaded in the renderer right now.
   *
   * `isAvailable()` deliberately folds those two facts together, which makes it
   * the wrong signal for restoring a saved model preference at startup: the
   * "model is warm" half is structurally unknowable at that point (the renderer
   * only reports it via an IPC sent *after* it reads the restored selection
   * back). Keying startup selection on isAvailable() would therefore disable
   * WebGPU on every cold boot.
   *
   * @returns {Promise<'available'|'unavailable'|'unknown'>}
   *   'unknown' means the probe could not run (renderer not up yet) -- callers
   *   should treat it as "don't know", never as "no GPU".
   */
  async probeGpuCapability() {
    const capability = this._gpuCapability || await this._probeGpu();
    if (!capability.indeterminate) {
      this._gpuCapability = capability;
    }
    if (capability.available) return 'available';
    return capability.indeterminate ? 'unknown' : 'unavailable';
  }

  // ── Engine Port: getHealth ──

  async getHealth() {
    const downloaded = this.modelManager.isModelDownloaded();

    let state = 'unavailable';
    if (downloaded && this._gpuCapability?.available) {
      state = 'loaded';
    } else if (downloaded && !this._gpuCapability?.available) {
      state = 'degraded';
    }

    return {
      adapter: 'webgpu',
      state,
      model: this.activeModelId,
      extra: {
        gpu: this._gpuCapability,
        modelDownloaded: downloaded,
      },
    };
  }

  // ── Engine Port: switchModel ──

  async switchModel(modelId) {
    if (modelId !== MODEL_ID) {
      throw new Error(`Unknown WebGPU model: ${modelId}`);
    }
    // Don't gate on download status — parakeet.js downloads in the renderer
    // after the switch. CaptureApp detects the webgpu-* model and initializes
    // the orchestrator, which triggers fromHub() download.
    this.activeModelId = modelId;
    this._saveConfig();
    log('WebGpuBridgeAdapter: Switched to model:', modelId);
  }

  // ── Engine Port: listModels ──

  async listModels() {
    return this.modelManager.listModels().map(m => ({
      id: m.id,
      label: m.label,
      group: 'webgpu',
      state: m.downloaded
        ? (m.id === this.activeModelId ? 'loaded' : 'available')
        : 'download',
    }));
  }

  // ── Engine Port: getConfig ──

  getConfig() {
    return {
      activeModelId: this.activeModelId,
      isConfigured: !!this.activeModelId,
    };
  }

  // ── Engine Port: configure ──

  configure(config) {
    if (config.activeModelId) {
      this.activeModelId = config.activeModelId;
      this._saveConfig();
    }
  }

  // ── GPU Detection ──

  /**
   * Probe WebGPU availability by asking the renderer process.
   * Returns cached result on subsequent calls.
   * @see GPU_PROBE_SOURCE for the code that actually runs in the renderer.
   * @returns {Promise<{available: boolean, adapterName?: string, vendor?: string, error?: string}>}
   */
  async _probeGpu() {
    const hidden = this._getHiddenWindow();
    if (!hidden || hidden.isDestroyed()) {
      log('WebGpuBridgeAdapter: Cannot probe GPU -- hidden window not available');
      // indeterminate: we could not ASK, which is not the same as "no GPU".
      // Callers must not cache or act on this as a negative result.
      return { available: false, indeterminate: true, error: 'Hidden window not ready' };
    }

    try {
      const result = await hidden.webContents.executeJavaScript(GPU_PROBE_SOURCE);

      // Only a DETERMINATE answer may be cached. An indeterminate probe that
      // got cached here was the whole failure: a TypeError from a removed API
      // became a permanent "no GPU" for the rest of the process, and that is
      // the one value allowed to override an explicit user choice.
      if (!result.indeterminate) {
        this._gpuCapability = result;
      }
      log('WebGpuBridgeAdapter: GPU probe result:', JSON.stringify(result));
      return result;
    } catch (err) {
      // executeJavaScript itself failed (renderer navigating, destroyed
      // mid-call, ...). We never got an answer, so this is indeterminate too.
      log('WebGpuBridgeAdapter: GPU probe failed:', err.message);
      return { available: false, indeterminate: true, error: err.message };
    }
  }

  /**
   * Get cached GPU capability info.
   * @returns {{available: boolean, adapterName?: string, vendor?: string, error?: string}|null}
   */
  getGpuCapability() {
    return this._gpuCapability;
  }

  /**
   * Force a fresh GPU probe (clears cache).
   * @returns {Promise<Object>}
   */
  async refreshGpuCapability() {
    this._gpuCapability = null;
    return this._probeGpu();
  }
}

module.exports = WebGpuBridgeAdapter;
module.exports.GPU_PROBE_SOURCE = GPU_PROBE_SOURCE;
