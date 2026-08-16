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
const { createState, restore, select, engineForModel, applyModelReady } = require('./engine-state');

const RemoteAdapter = require('./adapters/remote-adapter');
const LocalSidecarAdapter = require('./adapters/local-sidecar-adapter');
const WebGpuBridgeAdapter = require('./adapters/webgpu-bridge-adapter');

class EngineManager {
  constructor() {
    /** @type {RemoteAdapter} */
    this.remoteAdapter = new RemoteAdapter();

    /** @type {LocalSidecarAdapter} */
    this.localSidecarAdapter = new LocalSidecarAdapter();

    /** @type {WebGpuBridgeAdapter} */
    this.webgpuAdapter = new WebGpuBridgeAdapter();

    /**
     * Currently active adapter.  Starts as remote; initialize() may change it.
     * @type {RemoteAdapter|LocalSidecarAdapter|WebGpuBridgeAdapter}
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

    /**
     * Resolves once initialize() has finished restoring model selection.
     * IPC handlers that depend on activeAdapter / selectedModelId await this
     * so the renderer's startup config-load doesn't race past it.
     */
    this._readyPromise = new Promise((resolve) => { this._resolveReady = resolve; });

    /** Lazy getters for windows; resolved at IPC-call time, not setupIPC time. */
    this._getHiddenWindow = () => null;
    this._getPopupWindow = () => null;
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

    // Probe adapters in priority order, then restore the saved model selection
    // ONCE, at the end. (It used to be called from each branch, which meant a
    // branch's already-computed probe result was silently discarded.)
    let result;

    // Check WebGPU adapter first (best quality, local GPU)
    const webgpuResult = await this.webgpuAdapter.isAvailable();
    if (webgpuResult.available) {
      this.activeAdapter = this.webgpuAdapter;
      this.activeAdapterName = 'webgpu';
      log('EngineManager: WebGPU adapter is available and selected');
      result = { adapter: 'webgpu', available: true };
    } else {
      // Check remote adapter
      const remoteResult = await this.remoteAdapter.isAvailable();
      if (remoteResult.available) {
        this.activeAdapter = this.remoteAdapter;
        this.activeAdapterName = 'remote';
        log('EngineManager: Remote adapter is available and selected');
        result = { adapter: 'remote', available: true };
      } else {
        // Check local sidecar
        const localResult = await this.localSidecarAdapter.isAvailable();
        if (localResult.available || localResult === true) {
          this.activeAdapter = this.localSidecarAdapter;
          this.activeAdapterName = 'local-sidecar';
          log('EngineManager: Local sidecar adapter selected');
          result = { adapter: 'local-sidecar', available: true };
        } else {
          // Fallback: keep remote as active so user can configure it via Settings
          this.activeAdapter = this.remoteAdapter;
          this.activeAdapterName = 'remote';
          log('EngineManager: No adapter available yet; remote selected for configuration');
          result = { adapter: 'remote', available: false };
        }
      }
    }

    await this._restoreModelSelection();
    return result;
  }

  /**
   * Rebuild selection from the single record.
   *
   * Replaces a three-branch precedence puzzle over three independent config
   * files — two of whose branches could outrank an explicit user choice — with:
   * read one record, repair it, and demote only on a definitive negative.
   *
   * The GPU is probed lazily, only when something actually wants WebGPU, and
   * 'unknown' is passed through as 'indeterminate' so a cold boot (where the
   * renderer that answers the probe cannot be up yet) trusts the saved
   * preference instead of disabling WebGPU every time.
   */
  async _restoreModelSelection() {
    try {
      const saved = this._loadEngineState() || this._migrateLegacyConfigs();

      let gpu = 'indeterminate';
      if (saved && engineForModel(saved.modelId) === 'webgpu') {
        const probed = await this.webgpuAdapter.probeGpuCapability();
        gpu = probed === 'available' ? 'usable'
          : probed === 'unavailable' ? 'unusable'
            : 'indeterminate';
      }

      const state = restore(saved, { gpu });
      this._applyState(state);

      // Persist immediately. Applying in memory only meant engine-state.json
      // was never created until the user happened to switch models, so
      // migration re-ran on EVERY boot using the legacy precedence — which
      // reads the stale webgpu config first. An existing install where the user
      // had chosen CPU would be silently moved to GPU on upgrade and stay there.
      // Writing here makes migration happen exactly once, which is the whole
      // point of having one record.
      this._saveEngineState(state);

      if (state.reason) {
        log(`EngineManager: ${state.reason} (selected ${state.modelId})`);
      } else {
        log('EngineManager: restored model selection:', state.modelId);
      }
    } catch (error) {
      log('EngineManager: could not restore model selection:', error.message);
    }
  }

  /**
   * Wrap initialize() so the ready promise resolves when it finishes,
   * regardless of which return path was taken.
   */
  async initializeAndSignalReady() {
    try {
      return await this.initialize();
    } finally {
      this._resolveReady();
    }
  }

  /**
   * Give up on initialization and release anything awaiting readiness.
   *
   * Called when a precondition for initialize() can never be met -- e.g. the
   * hidden renderer failed to load, so the GPU probe (which runs via
   * executeJavaScript against it) can't happen. Without this, every IPC handler
   * that awaits _readyPromise hangs forever and the popup/Settings never open.
   *
   * @param {string} reason - logged for diagnosis
   */
  abortInitialization(reason) {
    log(`EngineManager: initialization aborted - ${reason}`);
    this._resolveReady();
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
  /** Absolute path of the single persisted record. */
  _engineStatePath() {
    return path.join(app.getPath('userData'), 'engine-state.json');
  }

  /** @returns {object|null} the persisted record, or null on first run. */
  _loadEngineState() {
    try {
      const p = this._engineStatePath();
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      log('EngineManager: could not read engine-state.json:', err.message);
      return null;
    }
  }

  _saveEngineState(state) {
    const target = this._engineStatePath();
    try {
      fs.writeFileSync(target, JSON.stringify(state, null, 2));
      // Verify rather than assume. A write that neither throws nor produces a
      // file is not something I was willing to keep reasoning about from a
      // distance — two theories about where it went were both wrong, so the
      // app now reports the resolved path and whether the file exists
      // afterwards.
      log(`EngineManager: wrote engine-state to ${target} (exists=${fs.existsSync(target)})`);
    } catch (err) {
      log(`EngineManager: could not write engine-state.json to ${target}:`, err);
    }
  }

  /**
   * First-run only: derive a record from the three legacy config files.
   *
   * Existing installs must not lose their selection just because the storage
   * moved. This reproduces the OLD precedence deliberately — it is the best
   * available guess at intent when there is no record of what came last. From
   * the first `switchModel()` onwards the record is authoritative and this is
   * never consulted again, which is what stops a stale entry outranking an
   * explicit choice a second time.
   */
  _migrateLegacyConfigs() {
    try {
      const webgpuConfig = this.webgpuAdapter.getConfig();
      if (webgpuConfig.activeModelId && webgpuConfig.isConfigured) {
        return { modelId: webgpuConfig.activeModelId };
      }
      const remoteConfig = this.remoteAdapter.getConfig();
      if (remoteConfig.selectedModel && remoteConfig.isConfigured) {
        return { modelId: remoteConfig.selectedModel };
      }
      const localConfig = this.localSidecarAdapter.getConfig();
      if (localConfig.activeModelId) {
        return { modelId: localConfig.activeModelId };
      }
    } catch (err) {
      log('EngineManager: legacy config migration failed:', err.message);
    }
    return null;
  }

  /**
   * Install the function that pushes the record to every renderer.
   *
   * Main→popup previously had no state channel at all, which is why the popup
   * fabricated every status it displayed. One writer, broadcast on every write.
   */
  setStateBroadcaster(fn) {
    this._broadcastState = fn;
  }

  /**
   * Resolve the adapter that can actually run `modelId`.
   *
   * processAudio used to dispatch on `this.activeAdapter` and merely forward
   * `options.model` without looking at it. So when the renderer correctly fell
   * back to CPU for a recording — because the GPU worker was not warm — the
   * audio still went to the WebGPU adapter, which is main-process-only and
   * throws "transcribe() called on main-process adapter". The recording was
   * lost even though every earlier decision had been right.
   *
   * The model id is the routing table; the active adapter is only a default for
   * callers that do not name one.
   */
  _adapterForModel(modelId) {
    if (!modelId) return this.activeAdapter;
    switch (engineForModel(modelId)) {
      case 'webgpu': return this.webgpuAdapter;
      case 'local': return this.localSidecarAdapter;
      default: return this.remoteAdapter;
    }
  }

  /**
   * Does this dispatch need WebM transcoded to WAV first?
   *
   * The sidecar reads WAV only. This has to follow the SAME resolution as
   * _adapterForModel — it previously keyed off `activeAdapterName`, so once
   * dispatch started routing by model id the two disagreed: with WebGPU
   * selected and the renderer correctly falling back to CPU, the conversion was
   * skipped and sherpa-onnx got a raw .webm ("Expected chunk_id RIFF").
   */
  _needsWavConversion(modelId) {
    return this._adapterForModel(modelId) === this.localSidecarAdapter;
  }

  /**
   * Endpoint and API-key config belongs to the REMOTE adapter, always.
   *
   * cloud:configure used to call this.activeAdapter.configure(). With the CPU
   * engine active that reached LocalSidecarAdapter, whose configure() reads only
   * activeModelId and silently drops endpointUrl — so the log said
   * "Configuring adapter: http://…" while the remote adapter still had nothing,
   * and selecting a hosted model failed with "Remote endpoint not configured"
   * for reasons the log actively contradicted. Same class as processAudio
   * routing on the active adapter: route by what the operation is ABOUT, not by
   * what happens to be selected.
   */
  configureEndpoint(config) {
    log('EngineManager: Configuring remote endpoint:', config.endpointUrl || '(no URL)');
    this.remoteAdapter.configure(config);
  }

  /** Probe the remote endpoint specifically — never whatever is active. */
  async testConnection() {
    return this.remoteAdapter.isAvailable();
  }

  /** Point activeAdapter/selectedModelId at whatever the record says. */
  _applyState(state) {
    this.state = state;
    this.selectedModelId = state.modelId;
    if (typeof this._broadcastState === 'function') {
      try { this._broadcastState(state); } catch (err) { log('EngineManager: state broadcast failed:', err.message); }
    }
    if (state.engine === 'webgpu') {
      this.activeAdapter = this.webgpuAdapter;
      this.activeAdapterName = 'webgpu';
    } else if (state.engine === 'local') {
      this.activeAdapter = this.localSidecarAdapter;
      this.activeAdapterName = 'local-sidecar';
    } else {
      this.activeAdapter = this.remoteAdapter;
      this.activeAdapterName = 'remote';
    }
  }

  async _restoreModelSelectionLegacy() {
    try {
      const remoteConfig = this.remoteAdapter.getConfig();
      const webgpuConfig = this.webgpuAdapter.getConfig();

      // A saved WebGPU preference can arrive through EITHER the webgpu adapter's
      // own config or the remote adapter's persisted selectedModel (which stores
      // a bare model id and is matched on the "webgpu-" prefix below). Both doors
      // must respect the same capability check, so resolve it once here.
      // Probed lazily -- only when something actually asks for WebGPU.
      const remoteWantsWebgpu = !!remoteConfig.selectedModel
        && remoteConfig.isConfigured
        && String(remoteConfig.selectedModel).startsWith('webgpu-');
      const wantsWebgpu = (webgpuConfig.activeModelId && webgpuConfig.isConfigured) || remoteWantsWebgpu;
      const gpuUsable = wantsWebgpu
        ? (await this.webgpuAdapter.probeGpuCapability()) !== 'unavailable'
        : false;

      if (webgpuConfig.activeModelId && webgpuConfig.isConfigured) {
        // Gate on HARDWARE capability only -- deliberately not isAvailable().
        //
        // isAvailable() also requires the model to be warm in the renderer,
        // which cannot be true yet at this point: the renderer only reports it
        // after reading this very selection back via cloud:get-config. Gating
        // on it would disable WebGPU on every cold boot.
        //
        // 'unknown' (renderer not up yet) therefore means "trust the saved
        // preference". Only a definitive 'unavailable' -- a probe that ran and
        // found no usable GPU -- overrides the user's choice.
        if (gpuUsable) {
          this.selectedModelId = webgpuConfig.activeModelId;
          this.activeAdapter = this.webgpuAdapter;
          this.activeAdapterName = 'webgpu';
          log('EngineManager: Restored WebGPU model selection:', this.selectedModelId);
          return;
        }
        log('EngineManager: Ignoring saved WebGPU preference -- no usable GPU on this system');
      }

      // Skip the remote-config branch when it names a WebGPU model we've just
      // established this machine can't run -- otherwise the prefix match below
      // would reactivate the adapter the check above deliberately rejected.
      if (remoteConfig.selectedModel && remoteConfig.isConfigured && !(remoteWantsWebgpu && !gpuUsable)) {
        this.selectedModelId = remoteConfig.selectedModel;
        // Ensure the correct adapter is active for the restored model
        if (this.selectedModelId.startsWith('local-')) {
          this.activeAdapter = this.localSidecarAdapter;
          this.activeAdapterName = 'local-sidecar';
        } else if (this.selectedModelId.startsWith('webgpu-')) {
          this.activeAdapter = this.webgpuAdapter;
          this.activeAdapterName = 'webgpu';
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

      // Convert WebM→WAV when the DISPATCH TARGET is the sidecar — which is not
      // necessarily the active adapter, because the renderer may have frozen a
      // CPU capture plan while the user's selection is still WebGPU.
      if (this._needsWavConversion(options.model)) {
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
      // Route by the model the CALLER named, not by whatever is currently
      // selected. The renderer freezes a capture plan at record start and may
      // legitimately have fallen back to CPU while the user's selection is
      // still WebGPU; dispatching on activeAdapter in that case sent the audio
      // to the main-process WebGPU adapter, which throws, and lost it.
      const adapter = this._adapterForModel(options.model);
      const result = await adapter.transcribe(transcribePath, {
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
      case 'webgpu':
        this.activeAdapter = this.webgpuAdapter;
        this.activeAdapterName = 'webgpu';
        return { success: true, adapter: 'webgpu' };
      default:
        return { success: false, adapter: this.activeAdapterName, error: `Unknown adapter: ${adapterName}` };
    }
  }

  /**
   * Tell the renderer to tear down the WebGPU worker.
   *
   * Switching away from a WebGPU model used to leave the orchestrator fully
   * loaded — encoder + decoder sessions, GPU buffers and the un-revoked model
   * blob, roughly 2.5GB — resident and idle for the rest of the session, doing
   * nothing. Nothing in the manager ever reached the renderer's dispose().
   */
  _releaseWebGpuOrchestrator() {
    const hidden = this._getHiddenWindow();
    if (hidden && !hidden.isDestroyed()) {
      log('EngineManager: releasing WebGPU orchestrator (switched to a non-GPU engine)');
      hidden.webContents.send('webgpu:dispose-orchestrator');
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
      // Record the choice FIRST, so "what the user picked" is committed before
      // any adapter work. The engine is derived from the model id rather than
      // set independently, so the pair cannot drift — that drift is how audio
      // captured for one engine reached another.
      const nextState = select(this.state || createState(), modelId);

      if (modelId.startsWith('webgpu-')) {
        // Switch to WebGPU adapter (on-device GPU)
        await this.webgpuAdapter.switchModel(modelId);
        this._applyState(nextState);
        this._saveEngineState(nextState);
        log('EngineManager: Switched to WebGPU adapter, model:', modelId);

        // Notify hidden window to initialize the parakeet.js orchestrator
        const hidden = this._getHiddenWindow();
        if (hidden && !hidden.isDestroyed()) {
          hidden.webContents.send('webgpu:init-orchestrator');
        }
      } else if (modelId.startsWith('local-')) {
        // Switch to local adapter
        await this.localSidecarAdapter.switchModel(modelId);
        this._applyState(nextState);
        this._saveEngineState(nextState);
        log('EngineManager: Switched to local-sidecar adapter, model:', modelId);
        this._releaseWebGpuOrchestrator();
      } else {
        // Switch to remote adapter + delegate model switch to server.
        // Await BEFORE committing: the webgpu/local branches above only
        // reassign after a successful switch, and doing it the other way round
        // here left the manager stranded on a broken adapter when the switch
        // failed, with the previously-working one deactivated.
        await this.remoteAdapter.switchModel(modelId);
        this._applyState(nextState);
        this._saveEngineState(nextState);
        log('EngineManager: Switched to remote adapter, model:', modelId);
        this._releaseWebGpuOrchestrator();
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
    const [remoteModels, localModels, webgpuModels] = await Promise.all([
      this.remoteAdapter.listModels().catch(() => []),
      this.localSidecarAdapter.listModels().catch(() => []),
      this.webgpuAdapter.listModels().catch(() => []),
    ]);

    const adjustState = (models, adapterName) =>
      models.map(m => ({
        ...m,
        state: (this.activeAdapterName !== adapterName && m.state === 'loaded')
          ? 'available' : m.state,
      }));

    return [
      ...adjustState(remoteModels, 'remote'),
      ...adjustState(localModels, 'local-sidecar'),
      ...adjustState(webgpuModels, 'webgpu'),
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
    this._getHiddenWindow = windows.getHiddenWindow || (() => null);

    // Give the WebGPU adapter a getter so GPU probes work whenever the
    // hidden window happens to be ready, even if setupIPC ran first.
    this.webgpuAdapter.setHiddenWindowGetter(this._getHiddenWindow);

    // ── Cloud config (used by SettingsPanel) ──

    ipcMain.handle('cloud:get-config', async () => {
      // Wait for initialize() to finish restoring selectedModelId so the
      // renderer's startup config-load doesn't see stale defaults.
      await this._readyPromise;
      const adapterConfig = this.activeAdapter.getConfig();
      return {
        ...adapterConfig,
        selectedModel: this.selectedModelId,
      };
    });

    ipcMain.handle('cloud:configure', async (_event, config) => {
      this.configureEndpoint(config);
      return { success: true };
    });

    ipcMain.handle('cloud:test-connection', async () => {
      log('EngineManager: Testing connection...');
      const result = await this.remoteAdapter.isAvailable();
      if (!result.available) {
        log('EngineManager: Connection test failed:', result.error);
        return { success: false, error: result.error || 'Server not reachable' };
      }

      const health = await this.remoteAdapter.getHealth();

      return {
        success: true,
        device: 'cloud',
        health: health,
      };
    });

    // ── Engine operations ──

    // Initial sync. The push channel ('engine:state') only fires on a change,
    // so a window that opens later needs to be able to ask once.
    ipcMain.handle('engine:get-state', async () => {
      await this._readyPromise;
      return this.state || null;
    });

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

    // ── WebGPU adapter operations ──

    ipcMain.handle('webgpu:check-availability', async () => {
      return this.webgpuAdapter.refreshGpuCapability();
    });

    ipcMain.handle('webgpu:model-status', async () => {
      const modelManager = this.webgpuAdapter.modelManager;
      return {
        downloaded: modelManager.isModelDownloaded(),
        downloadState: modelManager.getDownloadState(),
        gpu: this.webgpuAdapter.getGpuCapability(),
      };
    });

    // Notify main that parakeet.js model is loaded in renderer
    ipcMain.handle('webgpu:model-ready', async (_event, ready) => {
      this.webgpuAdapter.modelManager.setReady(ready);
      // Fold it into the record and rebroadcast. This is the one fact main
      // cannot observe for itself, and without it `status` sat at 'unknown'
      // forever — so planCapture kept falling back to CPU with "GPU model still
      // loading" immediately after the orchestrator reported it was ready.
      if (this.state) this._applyState(applyModelReady(this.state, ready));
      return { success: true };
    });

    // WebGPU transcription result from renderer (for popup recall)
    ipcMain.handle('webgpu:store-transcription', async (_event, result) => {
      this.lastTranscription = result.text || '';
      this.lastTranscriptionMeta = {
        processingTime: result.processingTime,
        engine: result.engine,
        language: result.language,
        model: result.model,
      };
      this._notifyPopup();
      return { success: true };
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
