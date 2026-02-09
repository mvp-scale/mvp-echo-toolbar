/**
 * Engine Port -- Interface contract for all STT engine adapters.
 *
 * This file defines the contract that every adapter (remote, local-sidecar,
 * or any future engine) MUST implement.  JavaScript has no formal interfaces,
 * so this serves as the authoritative documentation.
 *
 * The hexagonal (ports & adapters) pattern keeps the EngineManager decoupled
 * from transport details: the manager speaks only to this port contract, and
 * each adapter translates that into HTTP calls, subprocess commands, etc.
 *
 * ── Usage ──
 *
 *   const adapter = new SomeAdapter();
 *   adapter.configure({ endpointUrl: '...', apiKey: '...' });
 *
 *   if (await adapter.isAvailable()) {
 *     const result = await adapter.transcribe('/tmp/audio.webm', { language: 'en' });
 *     console.log(result.text);
 *   }
 *
 * ── Contract ──
 */

/**
 * @typedef {Object} TranscriptionResult
 * @property {string}  text           - The transcribed text (may be empty string for silence).
 * @property {string}  language       - ISO 639-1 language code detected or forced (e.g. "en").
 * @property {number}  duration       - Audio duration in seconds as reported by the server.
 * @property {number}  processingTime - Wall-clock ms from request start to result.
 * @property {string}  engine         - Human-readable engine label (e.g. "remote (parakeet-tdt-0.6b)").
 * @property {string}  model          - Model ID that was used for this transcription.
 */

/**
 * @typedef {Object} TranscribeOptions
 * @property {string} [model]    - Model ID to use (overrides adapter default).
 * @property {string} [language] - ISO 639-1 language code to force (e.g. "en").
 */

/**
 * @typedef {Object} HealthInfo
 * @property {string}  adapter  - Adapter name ("remote", "local-sidecar", etc.).
 * @property {string}  state    - One of "loaded", "degraded", "unavailable", "error".
 * @property {string}  [model]  - Currently loaded model ID, if any.
 * @property {Object}  [extra]  - Adapter-specific metadata (e.g. server engine details).
 */

/**
 * @typedef {Object} ModelInfo
 * @property {string}  id     - Unique model identifier (e.g. "parakeet-tdt-0.6b-v2-int8").
 * @property {string}  label  - Human-readable display name.
 * @property {string}  group  - Grouping key for UI (e.g. "gpu", "local").
 * @property {string}  state  - One of "loaded", "available", "download".
 * @property {boolean} [active] - True if this model is currently loaded on the server.
 */

/**
 * @typedef {Object} AdapterConfig
 * @property {string}  [endpointUrl]   - Server URL (remote adapter).
 * @property {string}  [apiKey]        - Bearer token for auth.
 * @property {string}  [selectedModel] - Default model ID.
 * @property {string}  [language]      - Default language override.
 * @property {boolean} [isConfigured]  - Whether the adapter has been configured.
 */

/**
 * Engine Port interface -- every adapter must implement these methods:
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  async transcribe(audioFilePath, options)                           │
 * │    Transcribe an audio file on disk.                                │
 * │    @param {string} audioFilePath - Absolute path to audio file.     │
 * │    @param {TranscribeOptions} options                               │
 * │    @returns {Promise<TranscriptionResult>}                          │
 * │    @throws {Error} on unrecoverable failure.                        │
 * ├──────────────────────────────────────────────────────────────────────┤
 * │  async isAvailable()                                                │
 * │    Check whether this adapter's backend is reachable / ready.       │
 * │    @returns {Promise<boolean>}                                      │
 * ├──────────────────────────────────────────────────────────────────────┤
 * │  async getHealth()                                                  │
 * │    Return detailed health/status information.                       │
 * │    @returns {Promise<HealthInfo>}                                   │
 * ├──────────────────────────────────────────────────────────────────────┤
 * │  async switchModel(modelId)                                         │
 * │    Request the backend to switch to a different model.              │
 * │    @param {string} modelId                                          │
 * │    @returns {Promise<void>}                                         │
 * │    @throws {Error} if model not found or switch fails.              │
 * ├──────────────────────────────────────────────────────────────────────┤
 * │  async listModels()                                                 │
 * │    List all models the backend knows about.                         │
 * │    @returns {Promise<ModelInfo[]>}                                   │
 * ├──────────────────────────────────────────────────────────────────────┤
 * │  getConfig()                                                        │
 * │    Return the current adapter configuration (synchronous).          │
 * │    @returns {AdapterConfig}                                         │
 * ├──────────────────────────────────────────────────────────────────────┤
 * │  configure(config)                                                  │
 * │    Update adapter configuration and persist to disk.                │
 * │    @param {AdapterConfig} config                                    │
 * │    @returns {void}                                                  │
 * └──────────────────────────────────────────────────────────────────────┘
 */

// No runtime export needed -- this file is documentation only.
// Adapters are validated by the EngineManager at initialization time.
module.exports = {};
