// MVP-Echo Whisper Engine using Python Sidecar
// Uses reliable Python OpenAI Whisper libraries via subprocess communication
console.log('📦 MVP Whisper Engine - Python Sidecar Integration');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// Import Python manager for portable support
let pythonManager;
try {
  const { pythonManager: pm } = require('../main/python-manager');
  pythonManager = pm;
} catch (error) {
  console.log('⚠️ Python manager not available, using system Python');
}

/**
 * WhisperEngine - Production STT implementation using Python Whisper
 */
class WhisperEngine {
  constructor() {
    this.pythonProcess = null;
    this.isInitialized = false;
    this.modelSize = 'tiny';
    this.executionMode = 'python';
    this.requestQueue = [];
    this.isProcessing = false;
  }

  /**
   * Initialize the engine with a model
   */
  async initialize(modelSize = 'tiny') {
    try {
      console.log(`🎯 Initializing Python Whisper engine with ${modelSize} model...`);
      
      // Clean up any old temp files first
      await this.cleanupTempFiles();
      
      this.modelSize = modelSize;
      
      // Start Python Whisper service
      await this.startPythonService();
      
      // Test the service
      const testResult = await this.sendRequest({ action: 'ping' });
      if (!testResult.pong) {
        throw new Error('Python service ping test failed');
      }
      
      // Get available models
      try {
        const modelsResult = await this.sendRequest({ action: 'list_models' });
        if (modelsResult.models) {
          this.availableModels = modelsResult.models;
          console.log(`📦 Available models: ${this.availableModels.map(m => m.name).join(', ')}`);
          
          // Check if any models are offline
          const offlineModels = this.availableModels.filter(m => 
            m.description && (m.description.includes('offline') || !m.description.includes('download'))
          );
          if (offlineModels.length > 0) {
            console.log(`🔄 Offline models available: ${offlineModels.map(m => m.name).join(', ')}`);
          }
        }
      } catch (error) {
        console.warn('⚠️ Could not get model list:', error);
        this.availableModels = [
          { name: 'tiny', description: 'Fastest, basic accuracy' },
          { name: 'base', description: 'Good balance' },
          { name: 'small', description: 'Better accuracy' }
        ];
      }
      
      this.isInitialized = true;
      console.log(`✅ Python Whisper engine initialized successfully`);
      console.log(`🐍 Model: faster-whisper ${modelSize}`);
      console.log(`⚡ Device: CPU (int8 quantization)`);
      
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize Python Whisper engine:', error);
      this.isInitialized = false;
      throw error;
    }
  }

  /**
   * Start the Python Whisper service subprocess
   */
  async startPythonService() {
    if (this.pythonProcess) {
      return; // Already running
    }

    // Get Python executable path (portable or system)
    let pythonCmd = null;
    
    if (pythonManager) {
      try {
        console.log('🎁 Using portable Python environment...');
        pythonCmd = await pythonManager.getPythonEnvironment();
        console.log(`✅ Portable Python ready: ${pythonCmd}`);
      } catch (error) {
        console.warn('⚠️ Failed to setup portable Python, falling back to system Python:', error);
      }
    }
    
    // Fall back to system Python if portable not available
    if (!pythonCmd) {
      // Try different Python commands
      const pythonCommands = ['python', 'python3', 'py'];
      
      for (const cmd of pythonCommands) {
        try {
          // Test if command exists
          await new Promise((resolve, reject) => {
            const testProcess = spawn(cmd, ['--version'], { stdio: 'ignore' });
            testProcess.on('close', (code) => {
              if (code === 0) resolve();
              else reject();
            });
            testProcess.on('error', reject);
          });
          pythonCmd = cmd;
          break;
        } catch (e) {
          continue;
        }
      }

      if (!pythonCmd) {
        throw new Error('Python not found. Please install Python 3.7+ or use portable version');
      }
    }

    console.log(`🐍 Using Python command: ${pythonCmd}`);

    // Check multiple possible locations for the Python script
    const possiblePaths = [
      path.join(__dirname, '../../python/whisper_service.py'),
      path.join(process.resourcesPath, 'python/whisper_service.py'),
      path.join(process.cwd(), 'python/whisper_service.py'),
      path.join(__dirname, '../../../python/whisper_service.py'),
      // For portable version, also check in temp extracted location
      pythonManager && pythonManager.getSessionInfo().tempDir ? 
        path.join(pythonManager.getSessionInfo().tempDir, 'whisper_service.py') : null
    ].filter(p => p !== null);

    let pythonScript = null;
    for (const scriptPath of possiblePaths) {
      console.log(`🔍 Checking for Python script at: ${scriptPath}`);
      if (fs.existsSync(scriptPath)) {
        pythonScript = scriptPath;
        console.log(`✅ Found Python script at: ${scriptPath}`);
        break;
      }
    }

    if (!pythonScript) {
      console.error('❌ Python script not found in any of these locations:', possiblePaths);
      throw new Error('Python Whisper service script not found');
    }
    
    console.log(`🐍 Starting Python Whisper service: ${pythonScript}`);

    this.pythonProcess = spawn(pythonCmd, [pythonScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: path.dirname(pythonScript)
    });

    // Handle process events
    this.pythonProcess.on('error', (error) => {
      console.error('❌ Python process error:', error);
      this.pythonProcess = null;
    });

    this.pythonProcess.on('close', (code) => {
      console.log(`🐍 Python process closed with code ${code}`);
      this.pythonProcess = null;
    });

    // Log Python stderr (our logs)
    this.pythonProcess.stderr.on('data', (data) => {
      console.log(data.toString().trim());
    });

    // Give the process a moment to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    if (!this.pythonProcess) {
      throw new Error('Failed to start Python Whisper service');
    }
  }

  /**
   * Send a request to the Python service
   */
  async sendRequest(request) {
    if (!this.pythonProcess) {
      throw new Error('Python service not running');
    }

    return new Promise((resolve, reject) => {
      const requestJson = JSON.stringify(request) + '\n';
      let responseBuffer = '';
      let timeoutHandle = null;
      
      // Set up response handler for chunked data
      const onData = (data) => {
        responseBuffer += data.toString();
        
        // Check if we have a complete JSON line
        const lines = responseBuffer.split('\n');
        
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          if (line) {
            try {
              const response = JSON.parse(line);
              
              // Clean up handlers
              this.pythonProcess.stdout.removeListener('data', onData);
              if (timeoutHandle) clearTimeout(timeoutHandle);
              
              resolve(response);
              return;
            } catch (error) {
              // Invalid JSON, continue waiting for more data
              console.log(`[Debug] Invalid JSON line: ${line}`);
            }
          }
        }
        
        // Keep the last incomplete line in buffer
        responseBuffer = lines[lines.length - 1];
      };

      this.pythonProcess.stdout.on('data', onData);
      
      // Send request
      this.pythonProcess.stdin.write(requestJson);
      
      // Timeout after 60 seconds (longer for model download)
      timeoutHandle = setTimeout(() => {
        this.pythonProcess.stdout.removeListener('data', onData);
        reject(new Error('Python service timeout (60s)'));
      }, 60000);
    });
  }


  /**
   * Process audio and return transcription
   */
  async transcribe(audioData) {
    if (!this.isInitialized) {
      throw new Error('Engine not initialized. Call initialize() first.');
    }

    const startTime = Date.now();
    let tempFilePath = null;
    
    try {
      console.log(`🎤 Processing audio: ${audioData.byteLength} bytes of encoded WebM data`);

      // Write WebM audio data to temp file for Python Whisper service
      tempFilePath = await this.writeAudioToTempFile(audioData);
      
      // Send file path to Python Whisper service instead of raw data
      const request = {
        action: 'transcribe_file',
        audio_file: tempFilePath,
        model: this.modelSize
      };
      
      console.log(`🐍 Sending audio file to Python Whisper service: ${tempFilePath}`);
      const result = await this.sendRequest(request);
      
      const processingTime = Date.now() - startTime;
      
      if (result.error) {
        throw new Error(`Python Whisper error: ${result.error}`);
      }
      
      console.log(`✅ Transcription completed in ${processingTime}ms`);
      console.log(`📝 Result: "${result.text}"`);
      
      return {
        success: true,
        text: result.text,
        confidence: result.language_probability || 0.95,
        processingTime,
        engine: `faster-whisper (${this.executionMode})`,
        modelPath: `${result.model} (Python)`,
        language: result.language,
        segments: result.segments,
        duration: result.duration,
        audioStats: {
          fileSize: audioData.byteLength,
          format: 'WebM'
        }
      };
      
    } catch (error) {
      console.error('❌ Transcription failed:', error);
      throw error;
    } finally {
      // Clean up temp file immediately and aggressively
      if (tempFilePath) {
        try {
          if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
            console.log(`🧹 Cleaned up temp file: ${path.basename(tempFilePath)}`);
          }
        } catch (cleanupError) {
          console.warn('⚠️ Failed to cleanup temp file:', cleanupError);
          
          // Schedule cleanup for later if immediate cleanup fails
          setTimeout(() => {
            try {
              if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
                console.log(`🧹 Delayed cleanup successful: ${path.basename(tempFilePath)}`);
              }
            } catch (e) {
              console.warn('⚠️ Delayed cleanup also failed:', e);
            }
          }, 5000);
        }
      }
    }
  }

  /**
   * Write audio data to a temporary WAV file
   * Note: audioData is actually a WebM-encoded ArrayBuffer from MediaRecorder, not raw PCM
   */
  async writeAudioToTempFile(audioData) {
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, `mvp-echo-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.webm`);
    
    console.log(`🎵 Received encoded audio data: ${audioData.constructor.name}, ${audioData.byteLength} bytes`);
    
    try {
      // MediaRecorder produces WebM-encoded audio data, not raw PCM
      // Instead of trying to convert to WAV, save the WebM data directly
      // faster-whisper can handle WebM files natively
      
      const webmBuffer = Buffer.from(audioData);
      fs.writeFileSync(tempFilePath, webmBuffer);
      
      console.log(`✅ Saved WebM audio file: ${path.basename(tempFilePath)} (${webmBuffer.length} bytes)`);
      
      // Verify file was written correctly
      if (fs.existsSync(tempFilePath)) {
        const fileSize = fs.statSync(tempFilePath).size;
        console.log(`📁 File verification: ${fileSize} bytes written to disk`);
        
        if (fileSize !== webmBuffer.length) {
          throw new Error(`File size mismatch: expected ${webmBuffer.length}, got ${fileSize}`);
        }
      } else {
        throw new Error('Temp file was not created');
      }
      
      return tempFilePath;
      
    } catch (error) {
      console.error('❌ Failed to write audio file:', error);
      throw error;
    }
  }

  /**
   * Preprocess audio data for Whisper
   */
  preprocessAudio(audioData) {
    try {
      // Convert to Float32Array if needed
      let floatArray;
      
      if (audioData instanceof Float32Array) {
        floatArray = audioData;
      } else if (Array.isArray(audioData)) {
        floatArray = new Float32Array(audioData);
      } else {
        // Assume it's some kind of buffer/array-like
        floatArray = new Float32Array(audioData);
      }
      
      // Normalize audio to [-1, 1] range
      const maxVal = Math.max(...Array.from(floatArray).map(Math.abs));
      if (maxVal > 0) {
        for (let i = 0; i < floatArray.length; i++) {
          floatArray[i] /= maxVal;
        }
      }
      
      // Whisper expects 16kHz, 30-second chunks (480,000 samples)
      // For simplicity, we'll pad or trim to a reasonable size
      const targetLength = Math.min(480000, Math.max(16000, floatArray.length));
      const processed = new Float32Array(targetLength);
      
      if (floatArray.length >= targetLength) {
        processed.set(floatArray.subarray(0, targetLength));
      } else {
        processed.set(floatArray);
        // Rest stays zero-padded
      }
      
      console.log(`🔧 Preprocessed audio: ${processed.length} samples, range [${Math.min(...processed).toFixed(3)}, ${Math.max(...processed).toFixed(3)}]`);
      
      return processed;
    } catch (error) {
      console.error('❌ Audio preprocessing failed:', error);
      throw error;
    }
  }

  /**
   * Run inference (mock implementation for MVP)
   */
  async runInference(audioData) {
    // In production with real ONNX model:
    // const inputTensor = new ort.Tensor('float32', audioData, [1, audioData.length]);
    // const feeds = { 'audio_features': inputTensor };
    // const results = await this.session.run(feeds);
    // return this.decodeTokens(results);
    
    // For MVP demo, simulate realistic inference with intelligent mock responses
    await new Promise(resolve => {
      // Simulate realistic processing time based on audio length and mode
      const baseTime = this.executionMode === 'gpu' ? 500 : 1500;
      const processingTime = baseTime + (audioData.length / 1000) * (this.executionMode === 'gpu' ? 0.5 : 2);
      setTimeout(resolve, Math.min(processingTime, 3000));
    });

    // Generate contextually appropriate transcriptions
    const transcriptions = [
      "Hello, this is a test of the MVP Echo speech-to-text system.",
      "The quick brown fox jumps over the lazy dog.",
      "MVP Echo is now using ONNX Runtime with DirectML for GPU acceleration.",
      "This transcription demonstrates the real-time speech recognition capabilities.",
      "The system is working correctly with Windows 11 integration.",
      "Voice to text conversion is operating smoothly with high accuracy.",
      "The application successfully processes audio using advanced AI models.",
      "Real-time transcription is now active and ready for production use."
    ];
    
    // Add some intelligence based on audio characteristics
    let selectedText;
    const audioEnergy = this.calculateAudioEnergy(audioData);
    
    if (audioEnergy < 0.01) {
      selectedText = ""; // Low energy = silence
    } else if (audioEnergy < 0.05) {
      selectedText = transcriptions[Math.floor(Math.random() * 3)]; // Quieter speech
    } else {
      selectedText = transcriptions[Math.floor(Math.random() * transcriptions.length)];
    }
    
    const confidence = Math.min(0.95, 0.75 + audioEnergy * 10); // Higher energy = higher confidence
    
    return {
      text: selectedText,
      confidence: parseFloat(confidence.toFixed(2))
    };
  }

  /**
   * Calculate simple audio energy for mock intelligence
   */
  calculateAudioEnergy(audioData) {
    const sum = audioData.reduce((acc, sample) => acc + sample * sample, 0);
    return Math.sqrt(sum / audioData.length);
  }

  /**
   * Get engine status
   */
  getStatus() {
    return {
      initialized: this.isInitialized,
      mode: this.executionMode,
      modelPath: this.modelPath === 'MOCK_MODEL' ? 'Mock Model' : this.modelPath,
      sessionActive: this.session !== null
    };
  }

  /**
   * Get available models
   */
  getAvailableModels() {
    return this.availableModels || [
      { name: 'tiny', description: 'Fastest, basic accuracy' },
      { name: 'base', description: 'Good balance' },
      { name: 'small', description: 'Better accuracy' }
    ];
  }

  /**
   * Switch to a different model
   */
  async switchModel(newModelSize) {
    if (!this.isInitialized) {
      throw new Error('Engine not initialized. Call initialize() first.');
    }

    if (this.modelSize === newModelSize) {
      console.log(`📦 Already using model: ${newModelSize}`);
      return true;
    }

    console.log(`🔄 Switching from ${this.modelSize} to ${newModelSize} model...`);
    
    // Update model size
    const oldModel = this.modelSize;
    this.modelSize = newModelSize;

    try {
      // Test if the new model is available by doing a quick ping
      // The Python service will load the new model on the next transcription request
      const testResult = await this.sendRequest({ action: 'ping' });
      if (!testResult.pong) {
        throw new Error('Service not responding after model switch');
      }

      console.log(`✅ Switched to ${newModelSize} model successfully`);
      return true;
    } catch (error) {
      // Revert to old model on failure
      this.modelSize = oldModel;
      console.error(`❌ Failed to switch to ${newModelSize} model:`, error);
      throw error;
    }
  }

  /**
   * Get engine status
   */
  getStatus() {
    return {
      initialized: this.isInitialized,
      mode: this.executionMode,
      modelPath: `faster-whisper ${this.modelSize}`,
      sessionActive: this.pythonProcess !== null,
      pythonPid: this.pythonProcess?.pid || null,
      availableModels: this.getAvailableModels(),
      currentModel: this.modelSize
    };
  }

  /**
   * Clean up any leftover temp files
   */
  async cleanupTempFiles() {
    try {
      const tempDir = os.tmpdir();
      const files = fs.readdirSync(tempDir);
      
      let cleanedCount = 0;
      for (const file of files) {
        if (file.startsWith('mvp-echo-') && file.endsWith('.wav')) {
          try {
            const filePath = path.join(tempDir, file);
            const stats = fs.statSync(filePath);
            
            // Delete files older than 1 hour
            const ageMs = Date.now() - stats.mtime.getTime();
            if (ageMs > 3600000) { // 1 hour
              fs.unlinkSync(filePath);
              cleanedCount++;
            }
          } catch (e) {
            // Ignore individual file errors
          }
        }
      }
      
      if (cleanedCount > 0) {
        console.log(`🧹 Cleaned up ${cleanedCount} old temp files`);
      }
    } catch (error) {
      console.warn('⚠️ Error during temp file cleanup:', error);
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    try {
      if (this.pythonProcess) {
        console.log('🧹 Terminating Python Whisper service...');
        this.pythonProcess.kill('SIGTERM');
        
        // Wait for graceful shutdown
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 3000);
          this.pythonProcess.on('close', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
        
        // Force kill if still running
        if (this.pythonProcess && !this.pythonProcess.killed) {
          this.pythonProcess.kill('SIGKILL');
        }
        
        this.pythonProcess = null;
      }
      
      // Clean up any leftover temp files
      await this.cleanupTempFiles();
      
      // Clean up portable Python environment if used
      if (pythonManager) {
        console.log('🧹 Cleaning up portable Python environment...');
        await pythonManager.cleanup();
      }
      
      this.isInitialized = false;
      console.log('🧹 Python Whisper engine cleaned up');
    } catch (error) {
      console.error('❌ Error during cleanup:', error);
    }
  }
}

// Export singleton instance
const whisperEngine = new WhisperEngine();

module.exports = {
  WhisperEngine,
  whisperEngine
};