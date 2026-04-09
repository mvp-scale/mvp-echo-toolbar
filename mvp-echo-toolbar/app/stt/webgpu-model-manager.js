/**
 * WebGpuModelManager -- Tracks WebGPU model availability for the engine port.
 *
 * Unlike LocalModelManager (pre-baked binary + model files), the WebGPU path
 * uses parakeet.js which handles model download and caching internally
 * (via HuggingFace Hub → browser cache). This manager just provides metadata
 * and state tracking for the EngineManager and SettingsPanel.
 */

const { log } = require('../main/logger');

const MODEL_ID = 'webgpu-parakeet-0.6b';
const MODEL_LABEL = 'English GPU';

class WebGpuModelManager {
  constructor() {
    // parakeet.js manages download/caching — we just track readiness
    this._ready = false;
  }

  /** Mark the model as ready (called after parakeet.js loads in renderer). */
  setReady(ready) {
    this._ready = ready;
    log(`WebGpuModelManager: ready=${ready}`);
  }

  /** @returns {boolean} Whether the model is loaded and ready for inference. */
  isModelDownloaded() {
    return this._ready;
  }

  /** @returns {string} Current state. */
  getDownloadState() {
    return this._ready ? 'completed' : 'idle';
  }

  /** @returns {Array} Single-entry list for the WebGPU model. */
  listModels() {
    return [{
      id: MODEL_ID,
      label: MODEL_LABEL,
      group: 'webgpu',
      downloaded: this._ready,
    }];
  }
}

module.exports = { WebGpuModelManager, MODEL_ID };
