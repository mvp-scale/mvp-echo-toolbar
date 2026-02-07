/**
 * Whisper Remote Engine - Cloud-based STT
 * Sends audio to remote endpoint for transcription
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const fetch = require('node-fetch');

class WhisperRemoteEngine {
  constructor() {
    this.endpointUrl = null;
    this.apiKey = null;
    this.selectedModel = 'Systran/faster-whisper-base';
    this.language = null;
    this.isConfigured = false;
    this.configPath = path.join(app.getPath('userData'), 'endpoint-config.json');

    // Load saved configuration
    this.loadConfig();
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.endpointUrl = config.endpointUrl || null;
        this.apiKey = config.apiKey || null;
        this.selectedModel = config.selectedModel || 'Systran/faster-whisper-base';
        this.language = config.language || null;
        this.isConfigured = !!this.endpointUrl;
        console.log('MVP-Echo Light: Loaded endpoint config:', this.endpointUrl);
      }
    } catch (error) {
      console.error('Failed to load endpoint config:', error);
    }
  }

  saveConfig() {
    try {
      const config = {
        endpointUrl: this.endpointUrl,
        apiKey: this.apiKey,
        selectedModel: this.selectedModel,
        language: this.language
      };
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      console.log('MVP-Echo Light: Saved endpoint config');
    } catch (error) {
      console.error('Failed to save endpoint config:', error);
    }
  }

  async configure(endpointUrl, apiKey = null, model = null) {
    this.endpointUrl = endpointUrl;
    this.apiKey = apiKey;
    if (model) this.selectedModel = model;

    // Test connection
    const health = await this.testConnection();
    if (health.success) {
      this.isConfigured = true;
      this.saveConfig();
    }

    return health;
  }

  async testConnection() {
    if (!this.endpointUrl) {
      return { success: false, error: 'No endpoint configured' };
    }

    try {
      const baseUrl = this.endpointUrl.replace('/v1/audio/transcriptions', '');
      const healthUrl = `${baseUrl}/health`;

      console.log('Testing connection to:', healthUrl);

      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      try {
        const response = await fetch(healthUrl, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'MVP-Echo/1.2.0'
          }
        });

        clearTimeout(timeoutId);
        console.log('Health check response status:', response.status);

        if (response.ok) {
          // Try to get models list
          try {
            const modelsResponse = await fetch(`${baseUrl}/v1/models`, {
              headers: {
                'Accept': 'application/json',
                'User-Agent': 'MVP-Echo/1.2.0'
              }
            });
            const modelsData = await modelsResponse.json();
            const availableModels = modelsData.data?.map(m => m.id) || [];

            return {
              success: true,
              device: 'cloud',
              models: availableModels,
              modelCount: availableModels.length
            };
          } catch (e) {
            console.log('Models endpoint not available, but health check passed');
            return {
              success: true,
              device: 'cloud'
            };
          }
        } else {
          const errorText = await response.text().catch(() => 'Unknown error');
          console.error('Health check failed:', response.status, errorText);
          return { success: false, error: `Health check failed: HTTP ${response.status}` };
        }
      } catch (fetchError) {
        clearTimeout(timeoutId);

        if (fetchError.name === 'AbortError') {
          console.error('Connection timeout after 10 seconds');
          return { success: false, error: 'Connection timeout - server not responding' };
        }
        throw fetchError;
      }
    } catch (error) {
      console.error('Connection test error:', error);

      // Provide more helpful error messages
      let errorMessage = error.message;
      if (error.code === 'ECONNREFUSED') {
        errorMessage = 'Connection refused - server may be offline';
      } else if (error.code === 'ENOTFOUND') {
        errorMessage = 'Server not found - check the URL';
      } else if (error.code === 'CERT_HAS_EXPIRED' || error.message.includes('certificate')) {
        errorMessage = 'SSL certificate error - check server certificate';
      } else if (error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
        errorMessage = 'SSL certificate verification failed';
      } else if (error.message.includes('self signed')) {
        errorMessage = 'Self-signed certificate not trusted';
      }

      return { success: false, error: errorMessage };
    }
  }

  async transcribe(audioFilePath, options = {}) {
    if (!this.isConfigured) {
      throw new Error('Cloud endpoint not configured. Please configure in Settings.');
    }

    const startTime = Date.now();

    try {
      // Read audio file
      const audioBuffer = fs.readFileSync(audioFilePath);

      // Create form data
      const FormData = require('form-data');
      const formData = new FormData();

      formData.append('file', audioBuffer, {
        filename: 'recording.webm',
        contentType: 'audio/webm'
      });

      // Use selected model or option override
      const model = options.model || this.selectedModel;
      formData.append('model', model);

      // Request verbose_json to get language detection
      formData.append('response_format', 'verbose_json');

      // Temperature 0 for deterministic output (OpenAI API compatible)
      formData.append('temperature', '0');

      // Add language if specified (forces language instead of auto-detect)
      if (options.language || this.language) {
        formData.append('language', options.language || this.language);
      }

      // Make request
      const headers = formData.getHeaders();
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(this.endpointUrl, {
        method: 'POST',
        headers: headers,
        body: formData
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      const processingTime = Date.now() - startTime;

      // Log the full response to see what fields the server returns
      console.log('Cloud transcription response:', JSON.stringify(result, null, 2));

      // Support various language field names from different server implementations
      let detectedLanguage = result.language
        || result.detected_language
        || result.lang
        || result.detected_lang
        || (result.segments && result.segments[0]?.language)
        || 'en';

      // Convert full language names to ISO codes (OpenAI returns "english", "spanish", etc.)
      const languageMap = {
        'english': 'en',
        'spanish': 'es',
        'french': 'fr',
        'german': 'de',
        'chinese': 'zh',
        'japanese': 'ja',
        'italian': 'it',
        'portuguese': 'pt',
        'russian': 'ru',
        'korean': 'ko',
        'dutch': 'nl',
        'polish': 'pl',
        'arabic': 'ar',
        'hindi': 'hi',
        'turkish': 'tr',
        'vietnamese': 'vi',
        'thai': 'th',
        'indonesian': 'id',
        'swedish': 'sv',
        'danish': 'da',
        'norwegian': 'no',
        'finnish': 'fi'
      };

      // Normalize to lowercase and map to ISO code if needed
      const langLower = detectedLanguage.toLowerCase();
      if (languageMap[langLower]) {
        detectedLanguage = languageMap[langLower];
      }

      // Get raw text
      let text = result.text || result.transcription || '';

      // Remove hallucinated repetitions (e.g., "Thank you. Thank you. Thank you...")
      text = this.removeRepetitions(text);

      return {
        text: text,
        language: detectedLanguage,
        duration: result.duration || 0,
        processingTime: processingTime,
        engine: `cloud (${model.split('/').pop()})`,
        model: model
      };

    } catch (error) {
      console.error('Cloud transcription failed:', error);
      throw new Error(`Cloud transcription failed: ${error.message}`);
    }
  }

  getConfig() {
    return {
      endpointUrl: this.endpointUrl,
      selectedModel: this.selectedModel,
      language: this.language,
      isConfigured: this.isConfigured
    };
  }

  setModel(model) {
    this.selectedModel = model;
    this.saveConfig();
  }

  setLanguage(language) {
    this.language = language;
    this.saveConfig();
  }

  /**
   * Remove hallucinated repetitions from transcription text
   * Detects and removes repeated phrases like "Thank you. Thank you. Thank you..."
   */
  removeRepetitions(text) {
    if (!text || text.length < 20) return text;

    // Split into sentences
    const sentences = text.split(/(?<=[.!?])\s+/);
    if (sentences.length < 3) return text;

    // Check for repeated sentences at the end
    const lastSentence = sentences[sentences.length - 1].trim().toLowerCase();
    let repeatCount = 0;

    // Count how many times the last sentence repeats at the end
    for (let i = sentences.length - 1; i >= 0; i--) {
      if (sentences[i].trim().toLowerCase() === lastSentence) {
        repeatCount++;
      } else {
        break;
      }
    }

    // If more than 2 repetitions, keep only 1
    if (repeatCount > 2) {
      const cleanSentences = sentences.slice(0, sentences.length - repeatCount + 1);
      console.log(`Removed ${repeatCount - 1} repeated phrases: "${lastSentence}"`);
      return cleanSentences.join(' ');
    }

    return text;
  }
}

module.exports = WhisperRemoteEngine;
