/**
 * RemoteAdapter -- HTTP client adapter for the MVP-Bridge server.
 *
 * Implements the Engine Port contract by talking to the server's
 * OpenAI-compatible API endpoints:
 *   GET  /health                  - server health check
 *   GET  /v1/models               - list available models
 *   POST /v1/models/switch        - switch active model
 *   POST /v1/audio/transcriptions - transcribe audio file
 *
 * Configuration is persisted to `toolbar-endpoint-config.json` in the
 * Electron userData directory, maintaining backward compatibility with
 * the previous whisper-remote.js config file.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const fetch = require('node-fetch');
const { log } = require('../../main/logger');

// Read version from package.json so it stays in sync with builds
const APP_VERSION = (() => {
  try {
    return require('../../../package.json').version;
  } catch (_e) {
    return '0.0.0';
  }
})();

const USER_AGENT = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 MVP-Echo-Toolbar/${APP_VERSION}`;

const BASE_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'Cache-Control': 'no-cache',
};

/**
 * Map full language names (as returned by some backends) to ISO 639-1 codes.
 */
const LANGUAGE_MAP = {
  'english': 'en', 'spanish': 'es', 'french': 'fr', 'german': 'de',
  'chinese': 'zh', 'japanese': 'ja', 'italian': 'it', 'portuguese': 'pt',
  'russian': 'ru', 'korean': 'ko', 'dutch': 'nl', 'polish': 'pl',
  'arabic': 'ar', 'hindi': 'hi', 'turkish': 'tr', 'vietnamese': 'vi',
  'thai': 'th', 'indonesian': 'id', 'swedish': 'sv', 'danish': 'da',
  'norwegian': 'no', 'finnish': 'fi',
};

class RemoteAdapter {
  constructor() {
    this.endpointUrl = null;
    this.apiKey = null;
    this.selectedModel = 'gpu-english';
    this.language = null;
    this.isConfigured = false;
    this.configPath = path.join(app.getPath('userData'), 'toolbar-endpoint-config.json');
    this.maxRetries = 2;

    this._loadConfig();
  }

  // ── Engine Port: transcribe ──

  /**
   * Transcribe an audio file by POSTing it to the remote server.
   *
   * @param {string} audioFilePath - Absolute path to the audio file on disk.
   * @param {Object} [options]
   * @param {string} [options.model]    - Model ID override.
   * @param {string} [options.language] - Language code override.
   * @returns {Promise<{text: string, language: string, duration: number, processingTime: number, engine: string, model: string}>}
   */
  async transcribe(audioFilePath, options = {}) {
    if (!this.isConfigured) {
      throw new Error('Remote endpoint not configured. Please configure in Settings.');
    }

    const startTime = Date.now();

    try {
      const audioBuffer = fs.readFileSync(audioFilePath);

      const FormData = require('form-data');
      const formData = new FormData();

      formData.append('file', audioBuffer, {
        filename: 'recording.webm',
        contentType: 'audio/webm',
      });

      const model = options.model || this.selectedModel;
      formData.append('model', model);
      formData.append('response_format', 'verbose_json');
      formData.append('language', options.language || this.language || 'en');

      const formHeaders = formData.getHeaders();
      const headers = this._getRequestHeaders(formHeaders);

      const response = await this._fetchWithRetry(this.endpointUrl, {
        method: 'POST',
        headers: headers,
        body: formData,
        timeout: 120000, // 2 min for large audio
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(
          `HTTP ${response.status}: ${response.statusText}${errorBody ? ` - ${errorBody}` : ''}`
        );
      }

      const result = await response.json();
      const processingTime = Date.now() - startTime;

      // Extract text -- prefer top-level text field (Parakeet TDT returns it cleanly)
      let text = result.text || result.transcription || '';

      // Detect language
      let detectedLanguage = result.language
        || result.detected_language
        || result.lang
        || result.detected_lang
        || 'en';

      const langLower = detectedLanguage.toLowerCase();
      if (LANGUAGE_MAP[langLower]) {
        detectedLanguage = LANGUAGE_MAP[langLower];
      }

      return {
        text: text.trim(),
        language: detectedLanguage,
        duration: result.duration || 0,
        processingTime: processingTime,
        engine: `remote (${model.split('/').pop()})`,
        model: model,
      };

    } catch (error) {
      log('RemoteAdapter: transcription failed:', error);
      throw new Error(`Remote transcription failed: ${error.message}`);
    }
  }

  // ── Engine Port: isAvailable ──

  /**
   * Check whether the remote server is reachable.
   * @returns {Promise<boolean>}
   */
  /**
   * Check whether the remote server is reachable and authenticated.
   * Hits /v1/models (authenticated endpoint) to verify both connectivity and API key.
   *
   * @returns {Promise<{available: boolean, error?: string}>}
   */
  async isAvailable() {
    if (!this.endpointUrl) return { available: false, error: 'No endpoint configured' };

    try {
      const baseUrl = this._getBaseUrl();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await fetch(`${baseUrl}/v1/models`, {
          method: 'GET',
          signal: controller.signal,
          headers: this._getRequestHeaders(),
        });
        clearTimeout(timeoutId);

        if (response.ok) return { available: true };
        if (response.status === 401 || response.status === 403) {
          return { available: false, error: 'Invalid API key' };
        }
        return { available: false, error: `Server returned HTTP ${response.status}` };
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          return { available: false, error: 'Connection timeout' };
        }
        if (fetchError.code === 'ECONNREFUSED') {
          return { available: false, error: 'Connection refused - server may be offline' };
        }
        if (fetchError.code === 'ENOTFOUND') {
          return { available: false, error: 'Server not found - check the URL' };
        }
        return { available: false, error: fetchError.message };
      }
    } catch (_error) {
      return { available: false, error: _error.message };
    }
  }

  // ── Engine Port: getHealth ──

  /**
   * Return detailed health information from the remote server.
   * @returns {Promise<{adapter: string, state: string, model: string|null, extra: Object}>}
   */
  async getHealth() {
    if (!this.endpointUrl) {
      return { adapter: 'remote', state: 'unavailable', model: null };
    }

    try {
      const baseUrl = this._getBaseUrl();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      let healthData = null;
      let modelsData = null;

      try {
        const healthResponse = await fetch(`${baseUrl}/health`, {
          method: 'GET',
          signal: controller.signal,
          headers: this._getRequestHeaders(),
        });
        clearTimeout(timeoutId);

        if (!healthResponse.ok) {
          return { adapter: 'remote', state: 'error', model: null };
        }

        healthData = await healthResponse.json();
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          return { adapter: 'remote', state: 'unavailable', model: null, error: 'Connection timeout' };
        }
        return { adapter: 'remote', state: 'unavailable', model: null, error: fetchError.message };
      }

      // Fetch models list for additional context
      try {
        const modelsResponse = await fetch(`${baseUrl}/v1/models`, {
          headers: this._getRequestHeaders(),
        });
        modelsData = await modelsResponse.json();
      } catch (_e) {
        // Models list is supplementary; health check still succeeds
      }

      const engineStatus = healthData.engine || {};
      const loadedModel = engineStatus.model_id || null;
      const state = engineStatus.state === 'loaded' ? 'loaded' : 'degraded';

      return {
        adapter: 'remote',
        state: state,
        model: loadedModel,
        extra: {
          server: healthData,
          modelCount: modelsData?.data?.length || 0,
        },
      };

    } catch (error) {
      let errorMessage = error.message;
      if (error.code === 'ECONNREFUSED') {
        errorMessage = 'Connection refused - server may be offline';
      } else if (error.code === 'ENOTFOUND') {
        errorMessage = 'Server not found - check the URL';
      }
      return { adapter: 'remote', state: 'unavailable', model: null, error: errorMessage };
    }
  }

  // ── Engine Port: switchModel ──

  /**
   * Ask the remote server to switch to a different model.
   * @param {string} modelId
   * @returns {Promise<void>}
   */
  async switchModel(modelId) {
    if (!this.endpointUrl) {
      throw new Error('Remote endpoint not configured.');
    }

    const baseUrl = this._getBaseUrl();

    const response = await this._fetchWithRetry(`${baseUrl}/v1/models/switch`, {
      method: 'POST',
      headers: this._getRequestHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ model_id: modelId }),
      timeout: 60000, // Model switch can take a while
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Model switch failed: HTTP ${response.status}`);
    }

    // Update local config to track the newly selected model
    this.selectedModel = modelId;
    this._saveConfig();
  }

  // ── Engine Port: listModels ──

  /**
   * List models available on the remote server.
   * @returns {Promise<Array<{id: string, label: string, group: string, state: string}>>}
   */
  async listModels() {
    if (!this.endpointUrl) {
      return [];
    }

    try {
      const baseUrl = this._getBaseUrl();
      const response = await fetch(`${baseUrl}/v1/models`, {
        headers: this._getRequestHeaders(),
      });

      if (!response.ok) return [];

      const data = await response.json();
      const models = data.data || [];

      return models.map((m) => ({
        id: m.id,
        label: m.label || m.id,
        group: m.group || 'gpu',
        state: m.active ? 'loaded' : 'available',
      }));
    } catch (_error) {
      return [];
    }
  }

  // ── Engine Port: getConfig ──

  /**
   * Return the current adapter configuration.
   * @returns {{endpointUrl: string|null, apiKey: string|null, selectedModel: string, language: string|null, isConfigured: boolean}}
   */
  getConfig() {
    return {
      endpointUrl: this.endpointUrl,
      apiKey: this.apiKey,
      selectedModel: this.selectedModel,
      language: this.language,
      isConfigured: this.isConfigured,
    };
  }

  // ── Engine Port: configure ──

  /**
   * Update adapter configuration and persist to disk.
   * @param {Object} config
   * @param {string} [config.endpointUrl]
   * @param {string} [config.apiKey]
   * @param {string} [config.selectedModel]
   * @param {string} [config.language]
   */
  configure(config) {
    if (config.endpointUrl !== undefined) this.endpointUrl = config.endpointUrl || null;
    if (config.apiKey !== undefined) this.apiKey = config.apiKey || null;
    if (config.selectedModel !== undefined) this.selectedModel = config.selectedModel;
    if (config.model !== undefined) this.selectedModel = config.model;
    if (config.language !== undefined) this.language = config.language || null;
    this.isConfigured = !!this.endpointUrl;
    this._saveConfig();
  }

  // ── Private helpers ──

  /**
   * Derive the server base URL from the configured endpoint URL.
   * Strips /v1/audio/transcriptions if present.
   * @returns {string}
   */
  _getBaseUrl() {
    return this.endpointUrl.replace(/\/v1\/audio\/transcriptions\/?$/, '');
  }

  /**
   * Build request headers, merging base headers with optional extras and auth.
   * @param {Object} [extra]
   * @returns {Object}
   */
  _getRequestHeaders(extra = {}) {
    const headers = { ...BASE_HEADERS, ...extra };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Fetch with automatic retry on transient errors (502-504, network issues).
   * Uses exponential backoff: 1s, 2s.
   *
   * @param {string} url
   * @param {Object} options - Standard fetch options.
   * @param {number} [retries] - Max retry count (default: this.maxRetries).
   * @returns {Promise<Response>}
   */
  async _fetchWithRetry(url, options, retries = this.maxRetries) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, options);

        // Retry on transient server errors
        if (response.status >= 502 && response.status <= 504 && attempt < retries) {
          const delay = Math.pow(2, attempt) * 1000;
          log(
            `RemoteAdapter: HTTP ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        return response;
      } catch (error) {
        // Retry on network errors (timeout, connection reset)
        if (
          attempt < retries &&
          (error.type === 'system' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT')
        ) {
          const delay = Math.pow(2, attempt) * 1000;
          log(
            `RemoteAdapter: Network error (${error.code || error.type}), retrying in ${delay}ms (attempt ${attempt + 1}/${retries})`
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Load configuration from disk.
   */
  _loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.endpointUrl = config.endpointUrl || null;
        this.apiKey = config.apiKey || null;
        this.selectedModel = config.selectedModel || 'gpu-english';
        this.language = config.language || null;
        this.isConfigured = !!this.endpointUrl;
        log('RemoteAdapter: Loaded config:', this.endpointUrl);
      }
    } catch (error) {
      log('RemoteAdapter: Failed to load config:', error);
    }
  }

  /**
   * Persist current configuration to disk.
   */
  _saveConfig() {
    try {
      const config = {
        endpointUrl: this.endpointUrl,
        apiKey: this.apiKey,
        selectedModel: this.selectedModel,
        language: this.language,
      };
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      log('RemoteAdapter: Saved config');
    } catch (error) {
      log('RemoteAdapter: Failed to save config:', error);
    }
  }
}

module.exports = RemoteAdapter;
