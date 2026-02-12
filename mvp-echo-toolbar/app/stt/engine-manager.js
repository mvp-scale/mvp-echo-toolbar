/**
 * EngineManager -- Hexagonal coordinator for STT adapters.
 *
 * Owns the lifecycle of all adapters (remote, local-sidecar), selects the
 * active one, and exposes IPC handlers that the renderer (CaptureApp,
 * SettingsPanel) already expects.
 *
 * IPC channels registered:
 *   cloud:get-config       - returns active adapter config
 *   cloud:configure        - updates active adapter config
 *   cloud:test-connection  - availability + health check
 *   engine:status          - current adapter info + health
 *   engine:switch-model    - delegate model switch to active adapter
 *   engine:list-models     - delegate model listing to active adapter
 *   processAudio           - main transcription entry point
 */

const { ipcMain, app } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { log } = require('../main/logger');

const RemoteAdapter = require('./adapters/remote-adapter');
const LocalSidecarAdapter = require('./adapters/local-sidecar-adapter');

class EngineManager {
  constructor() {
    /** @type {RemoteAdapter} */
    this.remoteAdapter = new RemoteAdapter();

    /** @type {LocalSidecarAdapter} */
    this.localSidecarAdapter = new LocalSidecarAdapter();

    /**
     * Currently active adapter.  Starts as remote; initialize() may change it.
     * @type {RemoteAdapter|LocalSidecarAdapter}
     */
    this.activeAdapter = this.remoteAdapter;

    /** Human-readable name of the active adapter. */
    this.activeAdapterName = 'remote';

    /** Currently selected model ID (tracks across adapter switches). Restored in initialize(). */
    this.selectedModelId = 'local-fast';

    /** Reference to the main BrowserWindow (for popup notifications). */
    this.mainWindow = null;

    /** Reference to the popup BrowserWindow (for transcription updates). */
    this.popupWindow = null;

    /** Most recent transcription text (for popup recall). */
    this.lastTranscription = '';

    /** Most recent transcription metadata. */
    this.lastTranscriptionMeta = {};
  }

  // ── Lifecycle ──

  /**
   * Probe adapters and select the best available one.
   *
   * Selection priority:
   *   1. Remote adapter (if configured and reachable)
   *   2. Local sidecar adapter (when implemented)
   *   3. Remote adapter (even if not configured -- so Settings UI can configure it)
   */
  async initialize() {
    log('EngineManager: Initializing...');

    // Clean up orphaned temp files from previous sessions / crashes
    this._cleanupOrphanedTempFiles();

    // Check remote adapter
    const remoteResult = await this.remoteAdapter.isAvailable();
    if (remoteResult.available) {
      this.activeAdapter = this.remoteAdapter;
      this.activeAdapterName = 'remote';
      log('EngineManager: Remote adapter is available and selected');
      this._restoreModelSelection();
      return { adapter: 'remote', available: true };
    }

    // Check local sidecar
    const localResult = await this.localSidecarAdapter.isAvailable();
    if (localResult.available || localResult === true) {
      this.activeAdapter = this.localSidecarAdapter;
      this.activeAdapterName = 'local-sidecar';
      log('EngineManager: Local sidecar adapter selected');
      this._restoreModelSelection();
      return { adapter: 'local-sidecar', available: true };
    }

    // Fallback: keep remote as active so user can configure it via Settings
    this.activeAdapter = this.remoteAdapter;
    this.activeAdapterName = 'remote';
    log('EngineManager: No adapter available yet; remote selected for configuration');
    this._restoreModelSelection();
    return { adapter: 'remote', available: false };
  }

  /**
   * Restore the persisted model selection from adapter configs.
   * Called once at the end of initialize() after adapter probing.
   *
   * Priority:
   *   1. Remote adapter's saved selectedModel (from toolbar-endpoint-config.json)
   *   2. Local sidecar adapter's saved activeModelId (from local-sidecar-config.json)
   *   3. Keep the default 'local-fast'
   */
  _restoreModelSelection() {
    try {
      const remoteConfig = this.remoteAdapter.getConfig();
      if (remoteConfig.selectedModel && remoteConfig.isConfigured) {
        this.selectedModelId = remoteConfig.selectedModel;
        // Ensure the correct adapter is active for the restored model
        if (this.selectedModelId.startsWith('local-')) {
          this.activeAdapter = this.localSidecarAdapter;
          this.activeAdapterName = 'local-sidecar';
        } else {
          this.activeAdapter = this.remoteAdapter;
          this.activeAdapterName = 'remote';
        }
        log('EngineManager: Restored model selection:', this.selectedModelId);
        return;
      }

      const localConfig = this.localSidecarAdapter.getConfig();
      if (localConfig.activeModelId) {
        this.selectedModelId = localConfig.activeModelId;
        this.activeAdapter = this.localSidecarAdapter;
        this.activeAdapterName = 'local-sidecar';
        log('EngineManager: Restored local model selection:', this.selectedModelId);
        return;
      }
    } catch (error) {
      log('EngineManager: Could not restore model selection:', error.message);
    }
  }

  // ── Core operations ──

  /**
   * Transcribe audio data from the renderer.
   *
   * The renderer sends a Uint8Array (serialized as a plain array over IPC).
   * We write it to a temp file, delegate to the active adapter, then clean up.
   *
   * @param {number[]} audioData - Audio bytes as a plain array (from IPC).
   * @param {Object}   [options]
   * @param {string}   [options.model]
   * @param {string}   [options.language]
   * @returns {Promise<{success: boolean, text: string, processingTime: number, engine: string, language: string, model: string, error?: string}>}
   */
  async processAudio(audioData, options = {}) {
    const webmPath = path.join(
      os.tmpdir(),
      `mvp-echo-audio-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.webm`
    );

    let transcribePath = webmPath;
    let wavPath = null;

    try {
      // Write WebM audio to temp file
      const audioBuffer = Buffer.from(audioData);
      fs.writeFileSync(webmPath, audioBuffer);
      log(`EngineManager: Wrote WebM to ${webmPath} (${audioBuffer.byteLength} bytes)`);

      // If local adapter is active, convert WebM→WAV using ffmpeg
      if (this.activeAdapterName === 'local-sidecar') {
        wavPath = path.join(
          os.tmpdir(),
          `mvp-echo-audio-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`
        );
        log('EngineManager: Converting WebM→WAV via ffmpeg...');
        await this._convertWebmToWav(webmPath, wavPath);
        transcribePath = wavPath;
        log(`EngineManager: WAV ready at ${wavPath}`);
      }

      // Delegate to active adapter
      const result = await this.activeAdapter.transcribe(transcribePath, {
        model: options.model,
        language: options.language,
      });

      // Store for popup recall
      this.lastTranscription = result.text;
      this.lastTranscriptionMeta = {
        processingTime: result.processingTime,
        engine: result.engine,
        language: result.language,
        model: result.model,
      };

      // Notify popup window if open
      this._notifyPopup();

      return {
        success: true,
        text: result.text,
        processingTime: result.processingTime,
        engine: result.engine,
        language: result.language,
        model: result.model,
      };

    } catch (error) {
      log('EngineManager: processAudio failed:', error);
      return {
        success: false,
        text: '',
        processingTime: 0,
        engine: `${this.activeAdapterName} (error)`,
        error: error.message,
      };
    } finally {
      // Always clean up temp files
      this._cleanupTempFile(webmPath);
      if (wavPath) this._cleanupTempFile(wavPath);
    }
  }

  /**
   * Switch between adapters (e.g. 'remote' or 'local-sidecar').
   * @param {string} adapterName
   * @returns {{success: boolean, adapter: string, error?: string}}
   */
  switchAdapter(adapterName) {
    switch (adapterName) {
      case 'remote':
        this.activeAdapter = this.remoteAdapter;
        this.activeAdapterName = 'remote';
        return { success: true, adapter: 'remote' };
      case 'local-sidecar':
        this.activeAdapter = this.localSidecarAdapter;
        this.activeAdapterName = 'local-sidecar';
        return { success: true, adapter: 'local-sidecar' };
      default:
        return { success: false, adapter: this.activeAdapterName, error: `Unknown adapter: ${adapterName}` };
    }
  }

  /**
   * Switch model, crossing adapter boundaries if needed.
   *
   * - local-* models → activate LocalSidecarAdapter
   * - gpu-* models   → activate RemoteAdapter, delegate model switch to server
   *
   * @param {string} modelId
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async switchModel(modelId) {
    try {
      if (modelId.startsWith('local-')) {
        // Switch to local adapter
        await this.localSidecarAdapter.switchModel(modelId);
        this.activeAdapter = this.localSidecarAdapter;
        this.activeAdapterName = 'local-sidecar';
        this.selectedModelId = modelId;
        log('EngineManager: Switched to local-sidecar adapter, model:', modelId);
      } else {
        // Switch to remote adapter + delegate model switch to server
        this.activeAdapter = this.remoteAdapter;
        this.activeAdapterName = 'remote';
        await this.remoteAdapter.switchModel(modelId);
        this.selectedModelId = modelId;
        log('EngineManager: Switched to remote adapter, model:', modelId);
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get current adapter info + health.
   * @returns {Promise<{adapter: string, available: boolean, health: Object, config: Object}>}
   */
  async getStatus() {
    const health = await this.activeAdapter.getHealth();
    const config = this.activeAdapter.getConfig();
    return {
      adapter: this.activeAdapterName,
      available: health.state !== 'unavailable',
      health: health,
      config: config,
    };
  }

  /**
   * List models from both adapters so the UI always shows the full picture.
   * Only the active adapter's model can show "loaded"; the other is "available".
   * @returns {Promise<Array>}
   */
  async listModels() {
    const [remoteModels, localModels] = await Promise.all([
      this.remoteAdapter.listModels().catch(() => []),
      this.localSidecarAdapter.listModels().catch(() => []),
    ]);

    const isRemoteActive = this.activeAdapterName === 'remote';
    const adjustState = (models, isActive) =>
      models.map(m => ({
        ...m,
        state: (!isActive && m.state === 'loaded') ? 'available' : m.state,
      }));

    return [
      ...adjustState(remoteModels, isRemoteActive),
      ...adjustState(localModels, !isRemoteActive),
    ];
  }

  /**
   * Get the last transcription and its metadata (for popup recall).
   * @returns {{text: string, processingTime?: number, engine?: string, language?: string, model?: string}}
   */
  getLastTranscription() {
    return {
      text: this.lastTranscription,
      ...this.lastTranscriptionMeta,
    };
  }

  // ── IPC Registration ──

  /**
   * Register all IPC handlers needed by the renderer.
   *
   * Maintains backward compatibility with the channels that CaptureApp.tsx,
   * SettingsPanel.tsx, and preload.js already use.
   *
   * @param {Object} windows
   * @param {BrowserWindow} windows.hiddenWindow - Hidden capture window.
   * @param {function} windows.getPopupWindow     - Getter for popup window (may be null).
   */
  setupIPC(windows = {}) {
    this._getPopupWindow = windows.getPopupWindow || (() => null);

    // ── Cloud config (used by SettingsPanel) ──

    ipcMain.handle('cloud:get-config', () => {
      const adapterConfig = this.activeAdapter.getConfig();
      // Always return the engine-manager's selected model so CaptureApp
      // knows whether it's in local or remote mode
      return {
        ...adapterConfig,
        selectedModel: this.selectedModelId,
      };
    });

    ipcMain.handle('cloud:configure', async (_event, config) => {
      log('EngineManager: Configuring adapter:', config.endpointUrl || '(no URL)');
      this.activeAdapter.configure(config);
      return { success: true };
    });

    ipcMain.handle('cloud:test-connection', async () => {
      log('EngineManager: Testing connection...');
      const result = await this.activeAdapter.isAvailable();
      if (!result.available) {
        log('EngineManager: Connection test failed:', result.error);
        return { success: false, error: result.error || 'Server not reachable' };
      }

      const health = await this.activeAdapter.getHealth();

      return {
        success: true,
        device: 'cloud',
        health: health,
      };
    });

    // ── Engine operations ──

    ipcMain.handle('engine:status', async () => {
      return await this.getStatus();
    });

    ipcMain.handle('engine:switch-model', async (_event, modelId) => {
      return await this.switchModel(modelId);
    });

    ipcMain.handle('engine:list-models', async () => {
      return await this.listModels();
    });

    // ── Audio processing (used by CaptureApp via preload) ──

    ipcMain.handle('processAudio', async (_event, audioArray, options = {}) => {
      log('EngineManager: Processing audio array of length:', audioArray.length);
      return await this.processAudio(audioArray, options);
    });

    // ── Popup transcription recall ──

    ipcMain.handle('get-last-transcription', async () => {
      return this.getLastTranscription();
    });

  }

  // ── Private helpers ──

  /**
   * Notify the popup window of a new transcription, if it exists and is not destroyed.
   */
  _notifyPopup() {
    try {
      const popup = this._getPopupWindow ? this._getPopupWindow() : null;
      if (popup && !popup.isDestroyed()) {
        popup.webContents.send('transcription-updated', {
          text: this.lastTranscription,
          ...this.lastTranscriptionMeta,
        });
      }
    } catch (_e) {
      // Popup may have been closed; ignore
    }
  }

  /**
   * Remove orphaned mvp-echo-audio-* temp files from previous sessions.
   * Only deletes files older than 5 minutes to avoid racing with an
   * in-flight transcription.
   */
  _cleanupOrphanedTempFiles() {
    try {
      const tmpDir = os.tmpdir();
      const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('mvp-echo-audio-'));
      if (files.length === 0) return;

      const cutoff = Date.now() - 5 * 60 * 1000; // 5 min ago
      let cleaned = 0;
      for (const file of files) {
        try {
          const fullPath = path.join(tmpDir, file);
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(fullPath);
            cleaned++;
          }
        } catch (_e) { /* skip individual file errors */ }
      }
      if (cleaned > 0) log(`EngineManager: Cleaned up ${cleaned} orphaned temp file(s)`);
    } catch (error) {
      log('EngineManager: Orphan cleanup failed:', error.message);
    }
  }

  /**
   * Delete a temp file, logging but not throwing on failure.
   * @param {string} filePath
   */
  _cleanupTempFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      log('EngineManager: Failed to clean up temp file:', error.message);
    }
  }

  /**
   * Find ffmpeg.exe in the bundle.
   * @returns {string|null} Absolute path to ffmpeg.exe or null if not found.
   */
  _getFfmpegPath() {
    const candidates = [
      path.join(process.resourcesPath || '', 'sherpa-onnx-bin', 'ffmpeg.exe'),
      path.join(__dirname, '../../sherpa-onnx-bin', 'ffmpeg.exe'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  /**
   * Convert WebM to 16kHz mono WAV using ffmpeg.
   * @param {string} webmPath - Input WebM file path
   * @param {string} wavPath - Output WAV file path
   * @returns {Promise<void>}
   */
  async _convertWebmToWav(webmPath, wavPath) {
    const ffmpegPath = this._getFfmpegPath();
    if (!ffmpegPath) {
      throw new Error('ffmpeg.exe not found in bundle');
    }

    return new Promise((resolve, reject) => {
      const args = [
        '-i', webmPath,
        '-ar', '16000',      // 16 kHz sample rate
        '-ac', '1',          // mono
        '-f', 'wav',         // WAV format
        '-y',                // overwrite output
        wavPath
      ];

      log('EngineManager: Spawning ffmpeg:', ffmpegPath, args.join(' '));

      const child = spawn(ffmpegPath, args, {
        windowsHide: true,
        timeout: 30000,
      });

      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      child.on('error', (err) => {
        reject(new Error(`ffmpeg spawn failed: ${err.message}`));
      });

      child.on('close', (code) => {
        if (code !== 0) {
          log('EngineManager: ffmpeg stderr:', stderr);
          reject(new Error(`ffmpeg exited with code ${code}`));
          return;
        }
        if (!fs.existsSync(wavPath)) {
          reject(new Error('ffmpeg completed but WAV file not found'));
          return;
        }
        const wavSize = fs.statSync(wavPath).size;
        log(`EngineManager: ffmpeg conversion complete, WAV size: ${wavSize} bytes`);
        resolve();
      });
    });
  }
}

module.exports = { EngineManager };
