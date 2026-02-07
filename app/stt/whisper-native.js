const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

/**
 * Native Faster-Whisper engine that works out of the box
 * Uses our own trusted standalone executable built with PyInstaller
 */
class WhisperNativeEngine {
  constructor() {
    this.initialized = false;
    this.binaryPath = null;
    this.modelPath = null;
    this.currentEngine = 'native'; // 'native' or 'python'
    this.gpuAvailable = false;
    this.userDataPath = app.getPath('userData');
    
    // Engine configurations
    this.engines = {
      native: {
        name: 'Whisper Native',
        description: 'Works immediately, no setup required',
        speed: '1x (CPU) / 5-10x (GPU)',
        accuracy: 'Good',
        setupTime: '0 seconds',
        requirements: 'None',
        icon: '🚀'
      },
      python: {
        name: 'Faster-Whisper Python',
        description: 'Better accuracy, requires Python',
        speed: '4-5x (CPU) / 15-30x (GPU)',
        accuracy: 'Excellent',
        setupTime: '2-3 minutes',
        requirements: 'Python + 500MB download',
        icon: '🐍'
      }
    };
    
    // Model information (uses Faster-Whisper CTranslate2 models)
    this.models = {
      tiny: { 
        name: 'tiny',
        size: '39 MB',
        speed: 'Fastest',
        accuracy: 'Good',
        bundled: true
      },
      base: { 
        name: 'base',
        size: '74 MB',
        speed: 'Fast',
        accuracy: 'Better',
        bundled: false
      },
      small: { 
        name: 'small',
        size: '244 MB',
        speed: 'Moderate',
        accuracy: 'Best',
        bundled: false
      }
    };
  }

  /**
   * Initialize the native whisper engine
   */
  async initialize(modelName = 'tiny') {
    try {
      // Get binary path - use prebuilt binary bundled with app
      this.binaryPath = this.getWhisperBinaryPath();
      
      // Check GPU availability
      this.gpuAvailable = await this.checkGPUSupport();
      
      // Get model path
      this.modelPath = await this.getModelPath(modelName);
      
      // Test the binary
      const testCmd = `"${this.binaryPath}" --help`;
      await execAsync(testCmd);
      
      this.initialized = true;
      
      return {
        success: true,
        engine: 'native',
        gpu: this.gpuAvailable,
        model: modelName,
        info: this.engines.native
      };
    } catch (error) {
      console.error('Failed to initialize whisper native:', error);
      throw error;
    }
  }

  /**
   * Get the path to our standalone faster-whisper executable
   */
  getWhisperBinaryPath() {
    // Our own trusted executable name
    const binaryName = process.platform === 'win32' ? 'whisper-standalone.exe' : 'whisper-standalone';
    
    // Check multiple possible locations
    const resourcePath = process.resourcesPath || path.join(__dirname, '../../');
    const possiblePaths = [
      path.join(resourcePath, 'bin', binaryName),           // Production: resources/bin/
      path.join(__dirname, '../../whisper-bin', binaryName), // Development: ./whisper-bin/
      path.join(this.userDataPath, 'bin', binaryName)       // User data fallback
    ];
    
    for (const binPath of possiblePaths) {
      if (fs.existsSync(binPath)) {
        return binPath;
      }
    }
    
    // If not found, we need to build it first
    throw new Error('Standalone whisper executable not found. Please run: npm run build:standalone');
  }

  /**
   * Check if GPU acceleration is available
   */
  async checkGPUSupport() {
    try {
      // On Windows, check for DirectML/CUDA support
      if (process.platform === 'win32') {
        // Check for NVIDIA GPU
        const { stdout: nvidia } = await execAsync('wmic path win32_VideoController get name', { timeout: 2000 }).catch(() => ({ stdout: '' }));
        if (nvidia.toLowerCase().includes('nvidia')) {
          return true;
        }
        
        // Check for AMD GPU
        if (nvidia.toLowerCase().includes('amd') || nvidia.toLowerCase().includes('radeon')) {
          return true;
        }
        
        // Check for Intel Arc GPU
        if (nvidia.toLowerCase().includes('intel') && nvidia.toLowerCase().includes('arc')) {
          return true;
        }
      }
    } catch (error) {
      console.log('GPU check failed:', error);
    }
    
    return false;
  }

  /**
   * Get the model name for Faster-Whisper (models auto-download)
   */
  async getModelPath(modelName) {
    const model = this.models[modelName];
    if (!model) {
      throw new Error(`Unknown model: ${modelName}`);
    }
    
    // Faster-Whisper handles model downloading automatically
    // We just return the model name, executable will download if needed
    return model.name;
  }

  /**
   * Transcribe audio using our standalone faster-whisper executable
   */
  async transcribe(audioPath, options = {}) {
    if (!this.initialized) {
      throw new Error('Whisper native not initialized');
    }
    
    const startTime = Date.now();
    
    // Build command arguments for our standalone executable
    const args = [
      `"${audioPath}"`,                    // Audio file
      '--model', this.modelPath,          // Model name (tiny, base, etc.)
      '--language', options.language || 'auto', // Language
      '--output-json', '-',               // JSON output to stdout
      '--quiet'                           // Suppress progress messages
    ];
    
    // Add GPU/CPU flags
    if (options.disableGPU) {
      args.push('--cpu');
    } else if (this.gpuAvailable) {
      args.push('--gpu');
    }
    
    // Execute our standalone executable
    const command = `"${this.binaryPath}" ${args.join(' ')}`;
    
    try {
      const { stdout, stderr } = await execAsync(command, {
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 120000 // 2 minute timeout
      });
      
      // Parse JSON output from our executable
      let result;
      try {
        result = JSON.parse(stdout);
      } catch (e) {
        // Fallback: treat stdout as plain text
        result = {
          text: stdout.trim(),
          processing_time: Date.now() - startTime,
          engine: 'MVP-Echo Standalone Faster-Whisper'
        };
      }
      
      return {
        text: result.text || '',
        processingTime: result.processing_time || (Date.now() - startTime),
        engine: result.engine || 'MVP-Echo Standalone Faster-Whisper',
        gpu: this.gpuAvailable && !options.disableGPU,
        language: result.language,
        model: result.model || this.modelPath
      };
    } catch (error) {
      console.error('Whisper transcription failed:', error);
      throw error;
    }
  }

  // Removed parseWhisperOutput - our executable outputs clean JSON

  /**
   * Build our own trusted standalone executable if not present
   */
  async buildBinary() {
    const binaryName = process.platform === 'win32' ? 'whisper-standalone.exe' : 'whisper-standalone';
    const targetPath = path.join(__dirname, '../../whisper-bin', binaryName);
    
    if (fs.existsSync(targetPath)) {
      return targetPath;
    }
    
    // Need to build the standalone executable
    throw new Error('Standalone executable not found. Please run: npm run build:standalone');
  }

  // Removed getBinaryDownloadUrl - we build our own executable

  /**
   * Get performance comparison data
   */
  getPerformanceComparison() {
    return {
      native: {
        cpu: {
          speed: '1x baseline',
          accuracy: 'Good',
          powerUsage: 'Moderate'
        },
        gpu: {
          speed: '5-10x faster',
          accuracy: 'Good',
          powerUsage: 'Low (GPU optimized)'
        }
      },
      python: {
        cpu: {
          speed: '4-5x faster',
          accuracy: 'Excellent',
          powerUsage: 'Higher'
        },
        gpu: {
          speed: '15-30x faster',
          accuracy: 'Excellent',
          powerUsage: 'Moderate'
        }
      }
    };
  }

  /**
   * Check if engine upgrade is available
   */
  async checkUpgradeAvailable() {
    // Check if Python is installed
    try {
      await execAsync('python --version');
      return {
        available: true,
        engine: 'python',
        benefits: [
          'Better accuracy',
          '4-5x faster processing',
          'Advanced features (speaker diarization, etc.)'
        ]
      };
    } catch (e) {
      return {
        available: false,
        engine: null
      };
    }
  }
}

module.exports = { WhisperNativeEngine };