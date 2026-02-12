/**
 * LocalSidecarAdapter -- Runs sherpa-onnx-offline.exe as a subprocess.
 * Implements the Engine Port contract.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { LocalModelManager } = require('../local-model-manager');
const { log } = require('../../main/logger');

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
      log('LocalSidecarAdapter: failed to load config:', err.message);
    }
  }

  _saveConfig() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify({
        activeModelId: this.activeModelId,
      }, null, 2));
    } catch (err) {
      log('LocalSidecarAdapter: failed to save config:', err.message);
    }
  }

  // ── Engine Port: transcribe ──

  async transcribe(audioFilePath, _options = {}) {
    const binaryPath = this.modelManager.getBinaryPath();
    if (!binaryPath) {
      throw new Error('sherpa-onnx binary not found');
    }
    if (!this.activeModelId || !this.modelManager.isModelDownloaded(this.activeModelId)) {
      throw new Error('No local model selected or downloaded');
    }

    const modelDir = this.modelManager.getModelPath(this.activeModelId);
    const modelFile = path.join(modelDir, 'model.int8.onnx');
    const tokensFile = path.join(modelDir, 'tokens.txt');
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const args = [
        '--nemo-ctc-model=' + modelFile,
        '--tokens=' + tokensFile,
        '--num-threads=4',
        audioFilePath,
      ];

      log(`LocalSidecarAdapter: spawning ${binaryPath} ${args.join(' ')}`);

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
        reject(new Error(`sherpa-onnx spawn error: ${err.message}`));
      });

      child.on('close', (code) => {
        const processingTime = Date.now() - startTime;
        log(`LocalSidecarAdapter: sherpa-onnx exited code=${code}, time=${processingTime}ms`);
        log(`LocalSidecarAdapter: stdout [${stdout.length} bytes]: ${stdout.trim()}`);
        log(`LocalSidecarAdapter: stderr [${stderr.length} bytes]: ${stderr.trim()}`);

        if (code !== 0) {
          reject(new Error(`sherpa-onnx exited with code ${code}: ${stderr.trim()}`));
          return;
        }

        // sherpa-onnx may write results to stdout or stderr depending
        // on platform/build.  Parse whichever has content.
        const text = this._parseOutput(stdout, stderr);
        log('LocalSidecarAdapter: parsed text: "' + text + '"');
        resolve({
          text,
          language: 'en',
          duration: 0,
          processingTime,
          engine: `local-cpu (${this.activeModelId})`,
          model: this.activeModelId,
        });
      });
    });
  }

  /**
   * Parse sherpa-onnx-offline output.
   *
   * All output goes to stderr. The result is a JSON line like:
   *   {"lang":"","emotion":"","event":"","text":"Hello world","timestamps":[],...}
   *
   * Extract the "text" field from that JSON.
   */
  _parseOutput(stdout, stderr) {
    const raw = (stdout + '\n' + stderr).trim();
    if (!raw) return '';

    // Find the JSON result line and extract the text field
    for (const line of raw.split('\n')) {
      const l = line.trim();
      if (!l.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(l);
        if (typeof parsed.text === 'string') {
          return parsed.text;
        }
      } catch (_e) {
        // Not valid JSON, skip
      }
    }

    return '';
  }

  // ── Engine Port: isAvailable ──

  async isAvailable() {
    const hasBinary = !!this.modelManager.getBinaryPath();
    if (!hasBinary) {
      return { available: false, error: 'sherpa-onnx binary not found' };
    }
    const hasActiveModel = this.activeModelId && this.modelManager.isModelDownloaded(this.activeModelId);
    if (!hasActiveModel) {
      return { available: false, error: 'No local model downloaded' };
    }
    return { available: true };
  }

  // ── Engine Port: getHealth ──

  async getHealth() {
    const binaryPath = this.modelManager.getBinaryPath();
    const models = this.modelManager.listModels();
    const downloadedModels = models.filter(m => m.downloaded);
    return {
      adapter: 'local-sidecar',
      state: binaryPath && downloadedModels.length > 0 ? 'loaded' : 'unavailable',
      model: this.activeModelId,
      extra: {
        binaryFound: !!binaryPath,
        downloadedModels: downloadedModels.map(m => m.id),
      },
    };
  }

  // ── Engine Port: switchModel ──

  async switchModel(modelId) {
    if (!this.modelManager.isModelDownloaded(modelId)) {
      throw new Error(`Model ${modelId} is not downloaded`);
    }
    this.activeModelId = modelId;
    this._saveConfig();
  }

  // ── Engine Port: listModels ──

  async listModels() {
    return this.modelManager.listModels().map(m => ({
      id: m.id,
      label: m.label,
      detail: m.detail,
      group: 'local',
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
}

module.exports = LocalSidecarAdapter;
