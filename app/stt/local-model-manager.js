const { app } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * Model registry for local CPU models (sherpa-onnx Parakeet CTC/TDT).
 *
 * Test build: models are bundled as extraResources and "downloaded"
 * via a local copy from resourcesPath to userData.
 * Production: swap copyFromBundled() for real HTTP download.
 */

const MODEL_REGISTRY = {
  'local-fast': {
    label: 'Fast',
    detail: '126 MB',
    dir: 'parakeet-tdt_ctc-110m-en-int8',
  },
  'local-balanced': {
    label: 'Balanced',
    detail: '624 MB',
    dir: 'parakeet-ctc-0.6b-en-int8',
  },
  'local-accurate': {
    label: 'Accurate',
    detail: '1.1 GB',
    dir: 'parakeet-tdt_ctc-1.1b-en-int8',
  },
};

class LocalModelManager {
  constructor() {
    this.userDataPath = app.getPath('userData');
    this.modelsDir = path.join(this.userDataPath, 'local-models');
    this.binDir = path.join(this.userDataPath, 'sherpa-onnx-bin');
  }

  /**
   * Resolve sherpa-onnx-offline.exe path.
   * Checks userData first (if copied there), then bundled extraResources, then dev layout.
   */
  getBinaryPath() {
    const exe = 'sherpa-onnx-offline.exe';

    const candidates = [
      path.join(this.binDir, exe),
      // Bundled in extraResources (production build)
      path.join(process.resourcesPath || '', 'sherpa-onnx-bin', exe),
      // Dev layout: project root
      path.join(__dirname, '../../sherpa-onnx-bin', exe),
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  /**
   * Resolve the DLL directory that contains onnxruntime.dll etc.
   * Same search order as getBinaryPath but returns the directory.
   */
  getBinaryDir() {
    const binaryPath = this.getBinaryPath();
    if (!binaryPath) return null;
    return path.dirname(binaryPath);
  }

  /**
   * Resolve bundled extraResources path for a model (source for copy).
   */
  _getBundledModelDir(modelId) {
    const entry = MODEL_REGISTRY[modelId];
    if (!entry) return null;

    const candidates = [
      // Production: extraResources
      path.join(process.resourcesPath || '', 'local-models', entry.dir),
      // Dev layout: project root sherpa_onnx_models/
      path.join(__dirname, '../../sherpa_onnx_models',
        modelId === 'local-fast' ? 'sherpa-onnx-nemo-parakeet-tdt_ctc-110m-en-int8' :
        modelId === 'local-balanced' ? 'sherpa-onnx-nemo-parakeet-ctc-0.6b-en-int8' :
        'sherpa-onnx-nemo-parakeet-tdt_ctc-1.1b-en-int8'),
    ];

    for (const p of candidates) {
      if (fs.existsSync(p) &&
          fs.existsSync(path.join(p, 'model.int8.onnx')) &&
          fs.existsSync(path.join(p, 'tokens.txt'))) {
        return p;
      }
    }
    return null;
  }

  /**
   * Get the userData path where a model is installed.
   */
  getModelPath(modelId) {
    const entry = MODEL_REGISTRY[modelId];
    if (!entry) return null;
    return path.join(this.modelsDir, entry.dir);
  }

  /**
   * Check if a model is already "downloaded" (present in userData).
   */
  isModelDownloaded(modelId) {
    const dir = this.getModelPath(modelId);
    if (!dir) return false;
    return (
      fs.existsSync(path.join(dir, 'model.int8.onnx')) &&
      fs.existsSync(path.join(dir, 'tokens.txt'))
    );
  }

  /**
   * "Download" a model — for test build this copies from bundled extraResources
   * to userData. onProgress(pct) called with 0-100.
   */
  async downloadModel(modelId, onProgress) {
    const entry = MODEL_REGISTRY[modelId];
    if (!entry) throw new Error(`Unknown model: ${modelId}`);

    const srcDir = this._getBundledModelDir(modelId);
    if (!srcDir) throw new Error(`Bundled model not found for ${modelId}`);

    const destDir = this.getModelPath(modelId);
    fs.mkdirSync(destDir, { recursive: true });

    const files = fs.readdirSync(srcDir);
    const total = files.length;

    for (let i = 0; i < files.length; i++) {
      const src = path.join(srcDir, files[i]);
      const dest = path.join(destDir, files[i]);
      fs.copyFileSync(src, dest);
      if (onProgress) onProgress(Math.round(((i + 1) / total) * 100));
    }

    // Also ensure the binary is available in userData
    this._ensureBinary();

    return { success: true, modelId, path: destDir };
  }

  /**
   * Copy sherpa-onnx binary + DLLs to userData if not already there.
   */
  _ensureBinary() {
    if (fs.existsSync(path.join(this.binDir, 'sherpa-onnx-offline.exe'))) return;

    // Find bundled binary directory
    const candidates = [
      path.join(process.resourcesPath || '', 'sherpa-onnx-bin'),
      path.join(__dirname, '../../sherpa-onnx-bin'),
    ];

    for (const srcBinDir of candidates) {
      if (fs.existsSync(path.join(srcBinDir, 'sherpa-onnx-offline.exe'))) {
        fs.mkdirSync(this.binDir, { recursive: true });
        for (const f of fs.readdirSync(srcBinDir)) {
          fs.copyFileSync(path.join(srcBinDir, f), path.join(this.binDir, f));
        }
        return;
      }
    }
  }

  /**
   * List all models with their current state.
   */
  listModels() {
    return Object.entries(MODEL_REGISTRY).map(([id, entry]) => ({
      id,
      label: entry.label,
      detail: entry.detail,
      group: 'local',
      downloaded: this.isModelDownloaded(id),
    }));
  }
}

module.exports = { LocalModelManager, MODEL_REGISTRY };
