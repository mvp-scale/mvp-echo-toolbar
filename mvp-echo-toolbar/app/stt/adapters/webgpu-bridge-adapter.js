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

    // Check GPU capability (use cached value if available)
    if (!this._gpuCapability) {
      this._gpuCapability = await this._probeGpu();
    }

    if (!this._gpuCapability || !this._gpuCapability.available) {
      return { available: false, error: 'WebGPU not available on this system' };
    }
    if (!hasModel) {
      return { available: false, error: 'WebGPU model not downloaded' };
    }
    return { available: true };
  }

  // ── Engine Port: getHealth ──

  async getHealth() {
    const downloaded = this.modelManager.isModelDownloaded();
    const downloadState = this.modelManager.getDownloadState();

    let state = 'unavailable';
    if (downloaded && this._gpuCapability?.available) {
      state = 'loaded';
    } else if (downloaded && !this._gpuCapability?.available) {
      state = 'degraded';
    } else if (downloadState === 'downloading') {
      state = 'degraded';
    }

    return {
      adapter: 'webgpu',
      state,
      model: this.activeModelId,
      extra: {
        gpu: this._gpuCapability,
        modelDownloaded: downloaded,
        downloadState,
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
   * @returns {Promise<{available: boolean, adapterName?: string, vendor?: string, error?: string}>}
   */
  async _probeGpu() {
    const hidden = this._getHiddenWindow();
    if (!hidden || hidden.isDestroyed()) {
      log('WebGpuBridgeAdapter: Cannot probe GPU -- hidden window not available');
      return { available: false, error: 'Hidden window not ready' };
    }

    try {
      // Ask the renderer to check navigator.gpu
      const result = await hidden.webContents.executeJavaScript(`
        (async () => {
          if (!navigator.gpu) {
            return { available: false, error: 'WebGPU not supported in this browser' };
          }
          try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
              return { available: false, error: 'No GPU adapter found' };
            }
            const info = await adapter.requestAdapterInfo();
            return {
              available: true,
              adapterName: info.device || 'Unknown GPU',
              vendor: info.vendor || 'Unknown',
              architecture: info.architecture || '',
              maxBufferSize: adapter.limits.maxBufferSize,
            };
          } catch (err) {
            return { available: false, error: err.message };
          }
        })()
      `);

      this._gpuCapability = result;
      log('WebGpuBridgeAdapter: GPU probe result:', JSON.stringify(result));
      return result;
    } catch (err) {
      log('WebGpuBridgeAdapter: GPU probe failed:', err.message);
      return { available: false, error: err.message };
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
