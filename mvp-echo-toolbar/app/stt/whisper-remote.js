/**
 * Whisper Remote Engine - Cloud-based STT
 * Enhanced with improved hallucination removal
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
    this.configPath = path.join(app.getPath('userData'), 'toolbar-endpoint-config.json');

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
        console.log('MVP-Echo Toolbar: Loaded endpoint config:', this.endpointUrl);
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
      console.log('MVP-Echo Toolbar: Saved endpoint config');
    } catch (error) {
      console.error('Failed to save endpoint config:', error);
    }
  }

  async testConnection() {
    if (!this.endpointUrl) {
      return { success: false, error: 'No endpoint configured' };
    }

    try {
      const baseUrl = this.endpointUrl.replace('/v1/audio/transcriptions', '');
      const healthUrl = `${baseUrl}/health`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await fetch(healthUrl, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'MVP-Echo-Toolbar/2.0.0'
          }
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          try {
            const modelsResponse = await fetch(`${baseUrl}/v1/models`, {
              headers: {
                'Accept': 'application/json',
                'User-Agent': 'MVP-Echo-Toolbar/2.0.0'
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
            return { success: true, device: 'cloud' };
          }
        } else {
          const errorText = await response.text().catch(() => 'Unknown error');
          return { success: false, error: `Health check failed: HTTP ${response.status}` };
        }
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          return { success: false, error: 'Connection timeout - server not responding' };
        }
        throw fetchError;
      }
    } catch (error) {
      let errorMessage = error.message;
      if (error.code === 'ECONNREFUSED') {
        errorMessage = 'Connection refused - server may be offline';
      } else if (error.code === 'ENOTFOUND') {
        errorMessage = 'Server not found - check the URL';
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
      const audioBuffer = fs.readFileSync(audioFilePath);

      const FormData = require('form-data');
      const formData = new FormData();

      formData.append('file', audioBuffer, {
        filename: 'recording.webm',
        contentType: 'audio/webm'
      });

      const model = options.model || this.selectedModel;
      formData.append('model', model);
      formData.append('response_format', 'verbose_json');
      formData.append('temperature', '0');

      if (options.language || this.language) {
        formData.append('language', options.language || this.language);
      }

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

      // Detect language
      let detectedLanguage = result.language
        || result.detected_language
        || result.lang
        || result.detected_lang
        || (result.segments && result.segments[0]?.language)
        || 'en';

      const languageMap = {
        'english': 'en', 'spanish': 'es', 'french': 'fr', 'german': 'de',
        'chinese': 'zh', 'japanese': 'ja', 'italian': 'it', 'portuguese': 'pt',
        'russian': 'ru', 'korean': 'ko', 'dutch': 'nl', 'polish': 'pl',
        'arabic': 'ar', 'hindi': 'hi', 'turkish': 'tr', 'vietnamese': 'vi',
        'thai': 'th', 'indonesian': 'id', 'swedish': 'sv', 'danish': 'da',
        'norwegian': 'no', 'finnish': 'fi'
      };

      const langLower = detectedLanguage.toLowerCase();
      if (languageMap[langLower]) {
        detectedLanguage = languageMap[langLower];
      }

      // Get text - try segment-level filtering first if available
      let text = '';
      if (result.segments && Array.isArray(result.segments)) {
        // Filter out segments with high no_speech probability
        const validSegments = result.segments.filter(seg => {
          if (seg.no_speech_prob !== undefined && seg.no_speech_prob > 0.6) {
            console.log(`Filtered silent segment (no_speech_prob=${seg.no_speech_prob.toFixed(2)}): "${seg.text}"`);
            return false;
          }
          return true;
        });
        text = validSegments.map(seg => seg.text).join('').trim();
      }

      // Fallback to plain text field if no segments or empty result
      if (!text) {
        text = result.text || result.transcription || '';
      }

      // Apply hallucination removal pipeline
      text = this.removeRepetitions(text);
      text = this.removeTrailingPhraseRepetitions(text);
      text = this.removeKnownHallucinations(text);

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

  /**
   * Remove hallucinated sentence repetitions from transcription text
   * Detects and removes repeated sentences like "Thank you. Thank you. Thank you..."
   */
  removeRepetitions(text) {
    if (!text || text.length < 20) return text;

    const sentences = text.split(/(?<=[.!?])\s+/);
    if (sentences.length < 2) return text;

    // Check for repeated sentences at the end (threshold lowered from >2 to >1)
    const lastSentence = sentences[sentences.length - 1].trim().toLowerCase();
    let repeatCount = 0;

    for (let i = sentences.length - 1; i >= 0; i--) {
      if (sentences[i].trim().toLowerCase() === lastSentence) {
        repeatCount++;
      } else {
        break;
      }
    }

    // If 2+ repetitions at end, keep only one
    if (repeatCount > 1) {
      const cleanSentences = sentences.slice(0, sentences.length - repeatCount + 1);
      console.log(`Removed ${repeatCount - 1} repeated sentences: "${lastSentence}"`);
      return cleanSentences.join(' ');
    }

    return text;
  }

  /**
   * Remove trailing phrase repetitions (2-5 word phrases repeated at end)
   * Example: "the quick brown fox the quick brown fox" → "the quick brown fox"
   */
  removeTrailingPhraseRepetitions(text) {
    if (!text || text.length < 10) return text;

    const words = text.trim().split(/\s+/);
    if (words.length < 4) return text;

    // Check phrase lengths from 2 to 5 words
    for (let phraseLen = 2; phraseLen <= Math.min(5, Math.floor(words.length / 2)); phraseLen++) {
      const lastPhrase = words.slice(-phraseLen).join(' ').toLowerCase();
      let repeatCount = 0;

      // Count how many times this phrase repeats at the end
      for (let i = words.length; i >= phraseLen; i -= phraseLen) {
        const chunk = words.slice(i - phraseLen, i).join(' ').toLowerCase();
        if (chunk === lastPhrase) {
          repeatCount++;
        } else {
          break;
        }
      }

      // If phrase repeats 2+ times at end, keep only one
      if (repeatCount > 1) {
        const keepWords = words.slice(0, words.length - (repeatCount - 1) * phraseLen);
        console.log(`Removed ${repeatCount - 1} trailing phrase repetitions: "${lastPhrase}"`);
        return keepWords.join(' ');
      }
    }

    return text;
  }

  /**
   * Remove known Whisper hallucination patterns
   * Filters out entire-text hallucinations and strips trailing hallucination patterns
   */
  removeKnownHallucinations(text) {
    if (!text) return text;

    const trimmed = text.trim();

    // Known full-text hallucinations (entire output is just this)
    const fullTextHallucinations = [
      'thank you.',
      'thanks for watching.',
      'bye.',
      'you',
      'thank you for watching.',
      'thanks for watching!',
      'the end.',
      'subscribe.',
      '...',
      '. . .',
      'you.',
    ];

    if (fullTextHallucinations.includes(trimmed.toLowerCase())) {
      console.log(`Filtered full-text hallucination: "${trimmed}"`);
      return '';
    }

    // Strip trailing hallucination patterns (these commonly appear at the end of real text)
    const trailingPatterns = [
      /\s*Thank you\.?\s*$/i,
      /\s*Thanks for watching\.?\s*$/i,
      /\s*Bye\.?\s*$/i,
      /\s*The end\.?\s*$/i,
      /\s*Subscribe\.?\s*$/i,
      /\s*\.{3,}\s*$/,
    ];

    let cleaned = trimmed;
    for (const pattern of trailingPatterns) {
      cleaned = cleaned.replace(pattern, '');
    }

    if (cleaned !== trimmed) {
      console.log(`Stripped trailing hallucination from: "${trimmed}" → "${cleaned}"`);
    }

    return cleaned.trim();
  }
}

module.exports = WhisperRemoteEngine;
