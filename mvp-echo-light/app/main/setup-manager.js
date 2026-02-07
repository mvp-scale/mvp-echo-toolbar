const { app, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

class SetupManager {
  constructor() {
    this.setupComplete = false;
    this.userDataPath = app.getPath('userData');
    this.modelsPath = path.join(this.userDataPath, 'models');
    this.pythonPath = path.join(this.userDataPath, 'python');
    this.configPath = path.join(this.userDataPath, 'setup-config.json');
    
    // Model URLs and checksums
    this.models = {
      tiny: {
        url: 'https://huggingface.co/openai/whisper-tiny/resolve/main/pytorch_model.bin',
        size: 145 * 1024 * 1024, // 145MB
        sha256: null // We'll verify after download
      }
    };
    
    // Python embedded distribution
    this.pythonUrl = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip';
    this.pythonSize = 10 * 1024 * 1024; // ~10MB
  }

  async checkSetupStatus() {
    try {
      if (fs.existsSync(this.configPath)) {
        const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.setupComplete = config.setupComplete || false;
        return config;
      }
    } catch (error) {
      console.error('Error reading setup config:', error);
    }
    
    return {
      setupComplete: false,
      modelDownloaded: false,
      pythonInstalled: false,
      offlineMode: false
    };
  }

  async saveSetupConfig(config) {
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    } catch (error) {
      console.error('Error saving setup config:', error);
    }
  }

  downloadFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      let downloadedBytes = 0;
      
      https.get(url, (response) => {
        const totalBytes = parseInt(response.headers['content-length'], 10);
        
        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          file.write(chunk);
          
          if (onProgress) {
            const progress = (downloadedBytes / totalBytes) * 100;
            onProgress(progress, downloadedBytes, totalBytes);
          }
        });
        
        response.on('end', () => {
          file.end();
          resolve();
        });
        
        response.on('error', (error) => {
          fs.unlinkSync(destPath);
          reject(error);
        });
      }).on('error', (error) => {
        reject(error);
      });
    });
  }

  async downloadModel(modelName, onProgress) {
    const model = this.models[modelName];
    if (!model) {
      throw new Error(`Unknown model: ${modelName}`);
    }
    
    fs.mkdirSync(this.modelsPath, { recursive: true });
    const modelPath = path.join(this.modelsPath, `${modelName}.pt`);
    
    // Check if already downloaded
    if (fs.existsSync(modelPath)) {
      const stats = fs.statSync(modelPath);
      if (stats.size === model.size) {
        return modelPath;
      }
    }
    
    await this.downloadFile(model.url, modelPath, onProgress);
    return modelPath;
  }

  async downloadPython(onProgress) {
    fs.mkdirSync(this.pythonPath, { recursive: true });
    const zipPath = path.join(this.pythonPath, 'python.zip');
    
    // Check if already installed
    const pythonExe = path.join(this.pythonPath, 'python.exe');
    if (fs.existsSync(pythonExe)) {
      return this.pythonPath;
    }
    
    await this.downloadFile(this.pythonUrl, zipPath, onProgress);
    
    // Extract Python
    await this.extractZip(zipPath, this.pythonPath);
    
    // Install pip and required packages
    await this.setupPythonPackages();
    
    return this.pythonPath;
  }

  async extractZip(zipPath, destPath) {
    return new Promise((resolve, reject) => {
      const unzip = spawn('powershell', [
        '-Command',
        `Expand-Archive -Path "${zipPath}" -DestinationPath "${destPath}" -Force`
      ]);
      
      unzip.on('close', (code) => {
        if (code === 0) {
          fs.unlinkSync(zipPath); // Clean up zip
          resolve();
        } else {
          reject(new Error(`Extraction failed with code ${code}`));
        }
      });
    });
  }

  async setupPythonPackages() {
    const pythonExe = path.join(this.pythonPath, 'python.exe');
    
    // Download get-pip.py
    const getPipPath = path.join(this.pythonPath, 'get-pip.py');
    await this.downloadFile('https://bootstrap.pypa.io/get-pip.py', getPipPath);
    
    // Install pip
    await this.runCommand(pythonExe, [getPipPath]);
    
    // Install required packages
    const pipExe = path.join(this.pythonPath, 'Scripts', 'pip.exe');
    await this.runCommand(pipExe, ['install', 'torch', 'openai-whisper', 'numpy']);
  }

  runCommand(command, args) {
    return new Promise((resolve, reject) => {
      const process = spawn(command, args);
      
      process.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command failed with code ${code}`));
        }
      });
    });
  }

  setupIPC() {
    ipcMain.handle('setup:check-status', async () => {
      return await this.checkSetupStatus();
    });
    
    ipcMain.handle('setup:download-model', async (event, modelName) => {
      try {
        const modelPath = await this.downloadModel(modelName, (progress, downloaded, total) => {
          event.sender.send('setup:download-progress', {
            type: 'model',
            progress,
            downloaded,
            total
          });
        });
        return { success: true, path: modelPath };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    
    ipcMain.handle('setup:download-python', async (event) => {
      try {
        const pythonPath = await this.downloadPython((progress, downloaded, total) => {
          event.sender.send('setup:download-progress', {
            type: 'python',
            progress,
            downloaded,
            total
          });
        });
        return { success: true, path: pythonPath };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
    
    ipcMain.handle('setup:complete', async () => {
      const config = {
        setupComplete: true,
        modelDownloaded: true,
        pythonInstalled: true,
        offlineMode: false,
        timestamp: new Date().toISOString()
      };
      await this.saveSetupConfig(config);
      this.setupComplete = true;
      return { success: true };
    });
    
    ipcMain.handle('setup:toggle-offline', async (event, enabled) => {
      const config = await this.checkSetupStatus();
      config.offlineMode = enabled;
      await this.saveSetupConfig(config);
      return { success: true };
    });
  }
}

module.exports = SetupManager;