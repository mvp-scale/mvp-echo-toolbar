const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { WhisperNativeEngine } = require('./whisper-native');
const { whisperEngine } = require('./whisper-engine');

/**
 * Engine Manager - Handles switching between native and Python engines
 * Starts with native (works immediately), allows upgrade to Python
 */
class EngineManager {
  constructor() {
    this.currentEngine = 'native';
    this.nativeEngine = new WhisperNativeEngine();
    this.pythonEngine = whisperEngine; // Existing Python engine
    this.config = null;
    this.configPath = path.join(app.getPath('userData'), 'engine-config.json');
    this.mainWindow = null;
    
    this.loadConfig();
  }

  /**
   * Load saved engine configuration
   */
  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.currentEngine = this.config.engine || 'native';
      } else {
        this.config = {
          engine: 'native',
          pythonInstalled: false,
          lastUsed: Date.now()
        };
      }
    } catch (error) {
      console.error('Error loading engine config:', error);
      this.config = { engine: 'native' };
    }
  }

  /**
   * Save engine configuration
   */
  saveConfig() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error('Error saving engine config:', error);
    }
  }

  /**
   * Initialize the engine manager
   */
  async initialize() {
    console.log('🎯 Initializing Engine Manager...');
    
    // Always initialize native engine first (works out of box)
    try {
      await this.nativeEngine.initialize();
      console.log('✅ Native engine ready');
    } catch (error) {
      console.error('❌ Native engine initialization failed:', error);
    }
    
    // Check if Python engine is available and user prefers it
    if (this.config.pythonInstalled && this.currentEngine === 'python') {
      try {
        const pythonAvailable = await this.checkPythonAvailable();
        if (pythonAvailable) {
          console.log('✅ Python engine available');
        } else {
          console.log('⚠️ Python not available, falling back to native');
          this.currentEngine = 'native';
        }
      } catch (error) {
        console.log('⚠️ Python check failed, using native engine');
        this.currentEngine = 'native';
      }
    }
    
    return {
      engine: this.currentEngine,
      gpu: this.nativeEngine.gpuAvailable
    };
  }

  /**
   * Check if Python engine is available
   */
  async checkPythonAvailable() {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);
    
    try {
      await execAsync('python --version');
      await execAsync('python -c "import faster_whisper"');
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Process audio with current engine
   */
  async processAudio(audioData, options = {}) {
    const engine = this.currentEngine === 'python' ? this.pythonEngine : this.nativeEngine;
    
    try {
      // For native engine, we need to save audio to temp file
      if (this.currentEngine === 'native') {
        const tempPath = path.join(app.getPath('temp'), `audio_${Date.now()}.wav`);
        
        // Convert audio data to WAV file
        await this.saveAudioToFile(audioData, tempPath);
        
        // Process with native engine
        const result = await this.nativeEngine.transcribe(tempPath, options);
        
        // Clean up temp file
        fs.unlinkSync(tempPath);
        
        return result;
      } else {
        // Use Python engine
        return await this.pythonEngine.processAudio(audioData, options);
      }
    } catch (error) {
      console.error('Process audio failed:', error);
      
      // Fallback to native if Python fails
      if (this.currentEngine === 'python') {
        console.log('Falling back to native engine...');
        this.currentEngine = 'native';
        return await this.processAudio(audioData, options);
      }
      
      throw error;
    }
  }

  /**
   * Save audio data to WAV file
   */
  async saveAudioToFile(audioData, filePath) {
    // Convert audio array to Buffer
    const buffer = Buffer.from(audioData);
    
    // Create WAV header
    const wavHeader = this.createWavHeader(buffer.length);
    
    // Write WAV file
    const wavBuffer = Buffer.concat([wavHeader, buffer]);
    fs.writeFileSync(filePath, wavBuffer);
  }

  /**
   * Create WAV header for audio data
   */
  createWavHeader(dataSize) {
    const header = Buffer.alloc(44);
    
    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    
    // fmt chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // Mono
    header.writeUInt32LE(16000, 24); // Sample rate
    header.writeUInt32LE(32000, 28); // Byte rate
    header.writeUInt16LE(2, 32); // Block align
    header.writeUInt16LE(16, 34); // Bits per sample
    
    // data chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    
    return header;
  }

  /**
   * Upgrade to Python engine
   */
  async upgradeEngine() {
    console.log('🚀 Starting engine upgrade to Python/Faster-Whisper...');
    
    const InitManager = require('../main/init-manager');
    const initManager = new InitManager();
    
    // Set up progress reporting
    initManager.mainWindow = this.mainWindow;
    
    try {
      // Run initialization (downloads Python and Faster-Whisper)
      const result = await initManager.initialize();
      
      if (result.success) {
        this.currentEngine = 'python';
        this.config.engine = 'python';
        this.config.pythonInstalled = true;
        this.saveConfig();
        
        console.log('✅ Engine upgrade complete');
        return { success: true };
      } else {
        throw new Error('Initialization failed');
      }
    } catch (error) {
      console.error('❌ Engine upgrade failed:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Switch between engines
   */
  async switchEngine(engineName) {
    if (engineName === 'python' && !this.config.pythonInstalled) {
      return { success: false, error: 'Python engine not installed' };
    }
    
    this.currentEngine = engineName;
    this.config.engine = engineName;
    this.saveConfig();
    
    return { success: true, engine: engineName };
  }

  /**
   * Get current engine status
   */
  getStatus() {
    return {
      current: this.currentEngine,
      gpu: this.nativeEngine.gpuAvailable,
      pythonAvailable: this.config.pythonInstalled,
      engines: {
        native: this.nativeEngine.engines.native,
        python: this.nativeEngine.engines.python
      }
    };
  }

  /**
   * Set up IPC handlers
   */
  setupIPC(mainWindow) {
    this.mainWindow = mainWindow;
    
    ipcMain.handle('engine:status', () => {
      return this.getStatus();
    });
    
    ipcMain.handle('engine:switch', async (event, engineName) => {
      return await this.switchEngine(engineName);
    });
    
    ipcMain.handle('engine:upgrade', async (event, engineName) => {
      if (engineName === 'python') {
        return await this.upgradeEngine();
      }
      return { success: false, error: 'Unknown engine' };
    });
    
    ipcMain.handle('engine:process-audio', async (event, audioData, options) => {
      return await this.processAudio(audioData, options);
    });
  }
}

module.exports = { EngineManager };