/**
 * LocalModelManager — Locates the pre-baked sherpa-onnx binary and model.
 *
 * The Fast (110m) model ships inside the installer via extraResources.
 * No downloads, no multi-model registry. Just path resolution.
 */

const path = require('path');
const fs = require('fs');
const { log } = require('../main/logger');

const MODEL_ID = 'local-fast';
const MODEL_LABEL = 'English CPU';
const MODEL_DIR_NAME = 'sherpa-onnx-nemo-parakeet-tdt_ctc-110m-en-int8';
const BINARY_NAME = process.platform === 'win32' ? 'MVP-Echo CPU Engine (sherpa-onnx).exe' : 'sherpa-onnx-offline';

class LocalModelManager {
  constructor() {
    this._binaryPath = null;
    this._modelPath = null;
    this._resolve();
  }

  /**
   * Search for the binary and model in known locations.
   * Priority: extraResources (production) → project tree (development).
   */
  _resolve() {
    const resourcesPath = process.resourcesPath || '';

    // Binary candidates
    const binCandidates = [
      path.join(resourcesPath, 'sherpa-onnx-bin', BINARY_NAME),
      path.join(__dirname, '../../sherpa-onnx-bin', BINARY_NAME),
    ];
    for (const p of binCandidates) {
      if (fs.existsSync(p)) {
        this._binaryPath = p;
        break;
      }
    }

    // Model candidates — look for model.int8.onnx + tokens.txt
    const modelCandidates = [
      path.join(resourcesPath, 'sherpa_onnx_models', MODEL_DIR_NAME),
      path.join(__dirname, '../../sherpa_onnx_models', MODEL_DIR_NAME),
    ];
    for (const p of modelCandidates) {
      if (
        fs.existsSync(path.join(p, 'model.int8.onnx')) &&
        fs.existsSync(path.join(p, 'tokens.txt'))
      ) {
        this._modelPath = p;
        break;
      }
    }

    if (this._binaryPath) log('LocalModelManager: binary at', this._binaryPath);
    else log('LocalModelManager: binary not found');

    if (this._modelPath) log('LocalModelManager: model at', this._modelPath);
    else log('LocalModelManager: model not found');
  }

  /** @returns {string|null} Absolute path to sherpa-onnx-offline binary. */
  getBinaryPath() {
    return this._binaryPath;
  }

  /** @returns {string|null} Absolute path to model directory. */
  getModelPath(modelId) {
    if (modelId && modelId !== MODEL_ID) return null;
    return this._modelPath;
  }

  /** @returns {boolean} Whether the pre-baked model files exist on disk. */
  isModelDownloaded(modelId) {
    if (modelId && modelId !== MODEL_ID) return false;
    return !!this._modelPath;
  }

  /** @returns {Array} Single-entry list for the pre-baked model. */
  listModels() {
    return [{
      id: MODEL_ID,
      label: MODEL_LABEL,
      group: 'local',
      downloaded: !!this._modelPath,
    }];
  }
}

module.exports = { LocalModelManager, MODEL_ID };
