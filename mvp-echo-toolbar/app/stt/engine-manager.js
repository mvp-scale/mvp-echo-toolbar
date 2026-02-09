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

const { ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

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
    console.log('EngineManager: Initializing...');

    // Check remote adapter
    const remoteResult = await this.remoteAdapter.isAvailable();
    if (remoteResult.available) {
      this.activeAdapter = this.remoteAdapter;
      this.activeAdapterName = 'remote';
      console.log('EngineManager: Remote adapter is available and selected');
      return { adapter: 'remote', available: true };
    }

    // Check local sidecar
    const localResult = await this.localSidecarAdapter.isAvailable();
    if (localResult.available || localResult === true) {
      this.activeAdapter = this.localSidecarAdapter;
      this.activeAdapterName = 'local-sidecar';
      console.log('EngineManager: Local sidecar adapter selected');
      return { adapter: 'local-sidecar', available: true };
    }

    // Fallback: keep remote as active so user can configure it via Settings
    this.activeAdapter = this.remoteAdapter;
    this.activeAdapterName = 'remote';
    console.log('EngineManager: No adapter available yet; remote selected for configuration');
    return { adapter: 'remote', available: false };
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
    const tempPath = path.join(
      os.tmpdir(),
      `mvp-echo-audio-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.webm`
    );

    try {
      // Write audio to temp file
      const audioBuffer = Buffer.from(audioData);
      fs.writeFileSync(tempPath, audioBuffer);

      // Delegate to active adapter
      const result = await this.activeAdapter.transcribe(tempPath, {
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
      console.error('EngineManager: processAudio failed:', error);
      return {
        success: false,
        text: '',
        processingTime: 0,
        engine: `${this.activeAdapterName} (error)`,
        error: error.message,
      };
    } finally {
      // Always clean up temp file
      this._cleanupTempFile(tempPath);
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
   * Delegate model switch to the active adapter.
   * @param {string} modelId
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async switchModel(modelId) {
    try {
      await this.activeAdapter.switchModel(modelId);
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
   * Delegate model listing to the active adapter.
   * @returns {Promise<Array>}
   */
  async listModels() {
    return await this.activeAdapter.listModels();
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
      return this.activeAdapter.getConfig();
    });

    ipcMain.handle('cloud:configure', async (_event, config) => {
      console.log('EngineManager: Configuring adapter:', config.endpointUrl || '(no URL)');
      this.activeAdapter.configure(config);
      return { success: true };
    });

    ipcMain.handle('cloud:test-connection', async () => {
      console.log('EngineManager: Testing connection...');
      const result = await this.activeAdapter.isAvailable();
      if (!result.available) {
        console.log('EngineManager: Connection test failed:', result.error);
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
      console.log('EngineManager: Processing audio array of length:', audioArray.length);
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
   * Delete a temp file, logging but not throwing on failure.
   * @param {string} filePath
   */
  _cleanupTempFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.error('EngineManager: Failed to clean up temp file:', error.message);
    }
  }
}

module.exports = { EngineManager };
