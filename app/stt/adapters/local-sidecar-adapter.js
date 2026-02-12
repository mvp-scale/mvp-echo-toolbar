const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { LocalModelManager } = require('../local-model-manager');

/**
 * Local CPU engine adapter — runs sherpa-onnx-offline.exe as a subprocess
 * for each transcription request.
 *
 * Implements the Engine Port contract:
 *   transcribe(audioFilePath) → TranscriptionResult
 *   isAvailable() → boolean
 *   getHealth() → object
 */
class LocalSidecarAdapter {
  constructor() {
    this.modelManager = new LocalModelManager();
    this.activeModelId = null;
    this.configPath = path.join(app.getPath('userData'), 'local-sidecar-config.json');
    this._loadConfig();
  }

  _loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.activeModelId = data.activeModelId || null;
      }
    } catch (err) {
      console.error('LocalSidecarAdapter: failed to load config:', err.message);
    }
  }

  _saveConfig() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify({
        activeModelId: this.activeModelId,
      }, null, 2));
    } catch (err) {
      console.error('LocalSidecarAdapter: failed to save config:', err.message);
    }
  }

  /**
   * Transcribe a WAV file using sherpa-onnx-offline.exe.
   * Returns { success, text, processingTime, engine, model, error }
   */
  async transcribe(audioFilePath) {
    const binaryPath = this.modelManager.getBinaryPath();
    if (!binaryPath) {
      return { success: false, text: '', error: 'sherpa-onnx binary not found' };
    }

    if (!this.activeModelId || !this.modelManager.isModelDownloaded(this.activeModelId)) {
      return { success: false, text: '', error: 'No local model selected or downloaded' };
    }

    const modelDir = this.modelManager.getModelPath(this.activeModelId);
    const modelFile = path.join(modelDir, 'model.int8.onnx');
    const tokensFile = path.join(modelDir, 'tokens.txt');

    const startTime = Date.now();

    return new Promise((resolve) => {
      const args = [
        '--nemo-ctc-model=' + modelFile,
        '--tokens=' + tokensFile,
        '--num-threads=4',
        audioFilePath,
      ];

      // Set PATH/env so DLLs next to the exe are found
      const binDir = path.dirname(binaryPath);
      const env = { ...process.env };
      env.PATH = binDir + path.delimiter + (env.PATH || '');

      const child = spawn(binaryPath, args, {
        env,
        cwd: binDir,
        windowsHide: true,
        timeout: 120000,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      child.on('error', (err) => {
        resolve({
          success: false,
          text: '',
          processingTime: Date.now() - startTime,
          engine: 'local-cpu',
          model: this.activeModelId,
          error: err.message,
        });
      });

      child.on('close', (code) => {
        const processingTime = Date.now() - startTime;

        if (code !== 0) {
          resolve({
            success: false,
            text: '',
            processingTime,
            engine: 'local-cpu',
            model: this.activeModelId,
            error: `sherpa-onnx exited with code ${code}: ${stderr.trim()}`,
          });
          return;
        }

        // sherpa-onnx-offline prints the transcribed text to stdout.
        // Format: filename followed by the transcription text on subsequent lines.
        const text = this._parseOutput(stdout);

        resolve({
          success: true,
          text,
          processingTime,
          engine: 'local-cpu',
          model: this.activeModelId,
        });
      });
    });
  }

  /**
   * Parse sherpa-onnx-offline stdout.
   * Typical output:
   *   /path/to/audio.wav
   *   the transcribed text here
   *
   * We skip the first line (filename) and join the rest.
   */
  _parseOutput(stdout) {
    const lines = stdout.trim().split('\n');
    if (lines.length <= 1) return lines[0] || '';

    // Skip first line (file path echo) and join remaining
    return lines.slice(1).join(' ').trim();
  }

  /**
   * True if binary exists AND at least one model is downloaded.
   */
  async isAvailable() {
    const hasBinary = !!this.modelManager.getBinaryPath();
    const models = this.modelManager.listModels();
    const hasModel = models.some(m => m.downloaded);
    return hasBinary && hasModel;
  }

  /**
   * Health report for status display.
   */
  async getHealth() {
    const binaryPath = this.modelManager.getBinaryPath();
    const models = this.modelManager.listModels();
    const downloadedModels = models.filter(m => m.downloaded);

    return {
      engine: 'local-cpu',
      binaryFound: !!binaryPath,
      activeModel: this.activeModelId,
      downloadedModels: downloadedModels.map(m => m.id),
      status: binaryPath && downloadedModels.length > 0 ? 'ready' : 'setup-required',
    };
  }

  /**
   * Switch the active model. Must already be downloaded.
   */
  switchModel(modelId) {
    if (!this.modelManager.isModelDownloaded(modelId)) {
      return { success: false, error: `Model ${modelId} is not downloaded` };
    }
    this.activeModelId = modelId;
    this._saveConfig();
    return { success: true, activeModel: modelId };
  }

  /**
   * Delegate to model manager.
   */
  listModels() {
    return this.modelManager.listModels();
  }

  getConfig() {
    return { activeModelId: this.activeModelId };
  }

  configure(opts) {
    if (opts.activeModelId) {
      return this.switchModel(opts.activeModelId);
    }
    return { success: true };
  }
}

module.exports = { LocalSidecarAdapter };
