/**
 * LocalSidecarAdapter -- Stub adapter for future local sherpa-onnx sidecar.
 *
 * This adapter will eventually manage a sherpa-onnx CLI binary as a child
 * process, providing fully offline, on-device transcription with no network
 * dependency.  The binary will be bundled with the Electron app or downloaded
 * on first use.
 *
 * Implementation is tracked as CONTEXT.md Task #10.
 *
 * For now, every method either returns a safe default or throws an error
 * indicating the feature is not yet available.
 */

class LocalSidecarAdapter {
  constructor() {
    // Future: paths to sherpa-onnx binary, model directory, process handle, etc.
  }

  // ── Engine Port: transcribe ──

  /**
   * @param {string} _audioFilePath
   * @param {Object} [_options]
   * @throws {Error} Always -- not yet implemented.
   */
  async transcribe(_audioFilePath, _options = {}) {
    throw new Error('Local sidecar not yet implemented. Please use the remote adapter.');
  }

  // ── Engine Port: isAvailable ──

  /**
   * @returns {Promise<{available: boolean, error?: string}>} Always unavailable -- no sidecar binary bundled yet.
   */
  async isAvailable() {
    return { available: false, error: 'Local sidecar not yet implemented' };
  }

  // ── Engine Port: getHealth ──

  /**
   * @returns {Promise<{adapter: string, state: string}>}
   */
  async getHealth() {
    return { adapter: 'local-sidecar', state: 'unavailable' };
  }

  // ── Engine Port: switchModel ──

  /**
   * @param {string} _modelId
   * @throws {Error} Always -- not yet implemented.
   */
  async switchModel(_modelId) {
    throw new Error('Local sidecar not yet implemented.');
  }

  // ── Engine Port: listModels ──

  /**
   * @returns {Promise<Array>} Always empty -- no models available yet.
   */
  async listModels() {
    return [];
  }

  // ── Engine Port: getConfig ──

  /**
   * @returns {{isConfigured: boolean}}
   */
  getConfig() {
    return { isConfigured: false };
  }

  // ── Engine Port: configure ──

  /**
   * No-op for the stub. Future implementation will persist sidecar settings.
   * @param {Object} _config
   */
  configure(_config) {
    // No-op
  }
}

module.exports = LocalSidecarAdapter;
