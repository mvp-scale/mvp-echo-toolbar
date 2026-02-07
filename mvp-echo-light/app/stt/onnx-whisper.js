const ort = require('onnxruntime-node');
const path = require('path');
const fs = require('fs');

class ONNXWhisperEngine {
  constructor() {
    this.session = null;
    this.modelPath = null;
    this.provider = 'cpu'; // 'dml' for DirectML, 'cpu' for CPU
    this.initialized = false;
    this.modelInfo = {
      tiny: { 
        size: '39 MB', 
        speed: 'Fastest', 
        accuracy: 'Good',
        file: 'whisper-tiny.onnx'
      },
      base: { 
        size: '74 MB', 
        speed: 'Fast', 
        accuracy: 'Better',
        file: 'whisper-base.onnx'
      },
      small: { 
        size: '244 MB', 
        speed: 'Moderate', 
        accuracy: 'Best',
        file: 'whisper-small.onnx'
      }
    };
  }

  async checkGPUSupport() {
    try {
      // Check if DirectML is available (Windows GPU acceleration)
      const providers = ort.listProviders();
      console.log('Available ONNX providers:', providers);
      
      if (providers.includes('DmlExecutionProvider')) {
        // Test if we can actually create a session with DirectML
        try {
          const testSession = await ort.InferenceSession.create(
            path.join(__dirname, 'test-model.onnx'),
            { executionProviders: ['DmlExecutionProvider'] }
          );
          await testSession.dispose();
          return { 
            available: true, 
            provider: 'DirectML',
            performance: '10-20x faster than CPU'
          };
        } catch (e) {
          console.log('DirectML available but initialization failed:', e);
        }
      }
      
      return { 
        available: false, 
        provider: 'CPU',
        performance: 'Standard speed'
      };
    } catch (error) {
      console.error('Error checking GPU support:', error);
      return { 
        available: false, 
        provider: 'CPU',
        performance: 'Standard speed'
      };
    }
  }

  async initialize(modelName = 'tiny', useGPU = true) {
    try {
      const model = this.modelInfo[modelName];
      if (!model) {
        throw new Error(`Unknown model: ${modelName}`);
      }

      // Model path in user data or resources
      const userDataPath = require('electron').app.getPath('userData');
      this.modelPath = path.join(userDataPath, 'models', model.file);
      
      // Check if model exists, if not use bundled one
      if (!fs.existsSync(this.modelPath)) {
        this.modelPath = path.join(process.resourcesPath, 'models', model.file);
      }

      // Check GPU support if requested
      const gpuInfo = await this.checkGPUSupport();
      
      // Configure execution providers
      const executionProviders = [];
      if (useGPU && gpuInfo.available) {
        executionProviders.push({
          name: 'DmlExecutionProvider',
          deviceId: 0
        });
        this.provider = 'dml';
      }
      executionProviders.push('CPUExecutionProvider');

      // Create ONNX Runtime session
      console.log(`Initializing ONNX Runtime with ${this.provider.toUpperCase()} provider...`);
      this.session = await ort.InferenceSession.create(this.modelPath, {
        executionProviders,
        graphOptimizationLevel: 'all',
        enableCpuMemArena: true,
        enableMemPattern: true
      });

      this.initialized = true;
      
      return {
        success: true,
        provider: this.provider,
        model: modelName,
        gpuInfo
      };
    } catch (error) {
      console.error('Failed to initialize ONNX Runtime:', error);
      throw error;
    }
  }

  async transcribe(audioData) {
    if (!this.initialized || !this.session) {
      throw new Error('ONNX Runtime not initialized');
    }

    try {
      const startTime = Date.now();
      
      // Preprocess audio to mel spectrogram
      const melSpectrogram = await this.audioToMelSpectrogram(audioData);
      
      // Create input tensor
      const inputTensor = new ort.Tensor('float32', melSpectrogram.data, melSpectrogram.dims);
      
      // Run inference
      const feeds = { 'mel': inputTensor };
      const results = await this.session.run(feeds);
      
      // Decode output tokens to text
      const text = await this.decodeTokens(results.tokens);
      
      const processingTime = Date.now() - startTime;
      
      return {
        text,
        processingTime,
        provider: this.provider,
        engine: 'ONNX Runtime'
      };
    } catch (error) {
      console.error('Transcription failed:', error);
      throw error;
    }
  }

  async audioToMelSpectrogram(audioData) {
    // Convert audio to mel spectrogram
    // This is a simplified version - in production you'd use proper STFT and mel filterbanks
    const sampleRate = 16000;
    const nFFT = 400;
    const hopLength = 160;
    const nMels = 80;
    
    // Placeholder for actual mel spectrogram computation
    // You would use a library like wav-decoder and implement STFT
    const melData = new Float32Array(nMels * 3000); // 30 seconds max
    
    return {
      data: melData,
      dims: [1, nMels, 3000]
    };
  }

  async decodeTokens(tokenTensor) {
    // Decode output tokens to text
    // This would use the Whisper tokenizer
    const tokens = Array.from(tokenTensor.data);
    
    // Placeholder - in production you'd use the actual tokenizer
    return "Transcribed text from ONNX Runtime";
  }

  async dispose() {
    if (this.session) {
      await this.session.dispose();
      this.session = null;
      this.initialized = false;
    }
  }

  getPerformanceComparison() {
    return {
      'ONNX + CPU': {
        speed: '1x',
        accuracy: 'Good',
        requirements: 'None (Works out of box)',
        setupTime: '0 seconds',
        icon: '🖥️'
      },
      'ONNX + DirectML (GPU)': {
        speed: '10-20x',
        accuracy: 'Good',
        requirements: 'NVIDIA/AMD/Intel GPU',
        setupTime: '0 seconds',
        icon: '🚀'
      },
      'Python + Faster-Whisper': {
        speed: '4-5x',
        accuracy: 'Better',
        requirements: 'Python + 500MB download',
        setupTime: '2-3 minutes',
        icon: '🐍'
      },
      'Python + Faster-Whisper + GPU': {
        speed: '15-30x',
        accuracy: 'Better',
        requirements: 'Python + CUDA + 2GB download',
        setupTime: '5-10 minutes',
        icon: '⚡'
      }
    };
  }
}

module.exports = { ONNXWhisperEngine };