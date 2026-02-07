const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

class InitManager {
  constructor() {
    this.userDataPath = app.getPath('userData');
    this.modelsPath = path.join(this.userDataPath, 'models');
    this.pythonPath = path.join(this.userDataPath, 'python-embedded');
    this.statusPath = path.join(this.userDataPath, 'init-status.json');
    
    // Model configurations
    this.models = {
      tiny: {
        included: true, // Ships with app
        path: path.join(process.resourcesPath, 'models', 'tiny.bin'),
        size: '39 MB'
      },
      base: {
        url: 'https://huggingface.co/openai/whisper-base/resolve/main/pytorch_model.bin',
        size: '74 MB',
        filename: 'base.bin'
      },
      small: {
        url: 'https://huggingface.co/openai/whisper-small/resolve/main/pytorch_model.bin', 
        size: '244 MB',
        filename: 'small.bin'
      }
    };
    
    this.pythonEmbedUrl = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip';
    this.initSteps = [];
    this.currentStep = 0;
  }

  async checkSystemPython() {
    try {
      const { stdout } = await execAsync('python --version');
      if (stdout.includes('Python 3.')) {
        const version = stdout.match(/Python (\d+\.\d+)/)[1];
        return { available: true, version, path: 'python' };
      }
    } catch (e) {
      // Python not in PATH, check common locations
      const commonPaths = [
        'C:\\Python311\\python.exe',
        'C:\\Python310\\python.exe',
        'C:\\Python39\\python.exe',
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python311', 'python.exe'),
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python310', 'python.exe')
      ];
      
      for (const pyPath of commonPaths) {
        if (fs.existsSync(pyPath)) {
          try {
            const { stdout } = await execAsync(`"${pyPath}" --version`);
            const version = stdout.match(/Python (\d+\.\d+)/)[1];
            return { available: true, version, path: pyPath };
          } catch (e) {
            continue;
          }
        }
      }
    }
    
    return { available: false };
  }

  async initialize() {
    this.initSteps = [];
    
    // Step 1: Check Python
    this.addStep('Checking Python installation...');
    const pythonInfo = await this.checkSystemPython();
    
    if (pythonInfo.available) {
      this.updateStep(`Found Python ${pythonInfo.version}`, 'success');
    } else {
      this.updateStep('Python not found, will download embedded version', 'info');
      this.addStep('Downloading Python embedded (10 MB)...');
      await this.downloadPythonEmbedded();
    }
    
    // Step 2: Check Whisper dependencies
    this.addStep('Checking Whisper dependencies...');
    const depsInstalled = await this.checkWhisperDeps(pythonInfo.path || this.getPythonExe());
    
    if (!depsInstalled) {
      this.updateStep('Installing Whisper dependencies...', 'progress');
      await this.installWhisperDeps(pythonInfo.path || this.getPythonExe());
      this.updateStep('Whisper dependencies installed', 'success');
    } else {
      this.updateStep('Whisper dependencies ready', 'success');
    }
    
    // Step 3: Check models
    this.addStep('Checking voice models...');
    const hasBaseModel = fs.existsSync(path.join(this.modelsPath, 'base.bin'));
    
    if (!hasBaseModel) {
      this.updateStep('Downloading enhanced model (74 MB)...', 'progress');
      await this.downloadModel('base');
      this.updateStep('Enhanced model downloaded', 'success');
    } else {
      this.updateStep('Voice models ready', 'success');
    }
    
    // Step 4: Complete
    this.addStep('System initialization complete!', 'success');
    await this.saveStatus({ initialized: true, timestamp: Date.now() });
    
    return { success: true, pythonPath: pythonInfo.path || this.getPythonExe() };
  }

  addStep(message, status = 'progress') {
    const step = {
      id: Date.now(),
      message,
      status, // progress, success, error, info
      timestamp: new Date().toISOString()
    };
    
    this.initSteps.push(step);
    this.broadcastStatus();
  }

  updateStep(message, status = 'progress') {
    if (this.initSteps.length > 0) {
      const lastStep = this.initSteps[this.initSteps.length - 1];
      lastStep.message = message;
      lastStep.status = status;
      this.broadcastStatus();
    }
  }

  broadcastStatus() {
    if (this.mainWindow) {
      this.mainWindow.webContents.send('init:status', {
        steps: this.initSteps,
        currentStep: this.currentStep,
        totalSteps: this.initSteps.length
      });
    }
  }

  async downloadPythonEmbedded() {
    const zipPath = path.join(this.pythonPath, 'python.zip');
    fs.mkdirSync(this.pythonPath, { recursive: true });
    
    await this.downloadFile(this.pythonEmbedUrl, zipPath, (progress) => {
      this.updateStep(`Downloading Python embedded (${progress}%)...`, 'progress');
    });
    
    // Extract using PowerShell
    await execAsync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${this.pythonPath}' -Force"`);
    fs.unlinkSync(zipPath);
    
    // Download get-pip
    const getPipPath = path.join(this.pythonPath, 'get-pip.py');
    await this.downloadFile('https://bootstrap.pypa.io/get-pip.py', getPipPath);
    
    // Install pip
    await execAsync(`"${this.getPythonExe()}" "${getPipPath}"`);
    
    this.updateStep('Python embedded installed', 'success');
  }

  getPythonExe() {
    return path.join(this.pythonPath, 'python.exe');
  }

  async checkWhisperDeps(pythonPath) {
    try {
      await execAsync(`"${pythonPath}" -c "import whisper"`);
      return true;
    } catch (e) {
      return false;
    }
  }

  async installWhisperDeps(pythonPath) {
    const pipPath = pythonPath.replace('python.exe', 'Scripts\\pip.exe');
    
    // Install in order with progress updates
    const packages = [
      { name: 'numpy', desc: 'Installing NumPy...' },
      { name: 'torch --index-url https://download.pytorch.org/whl/cpu', desc: 'Installing PyTorch (this may take a moment)...' },
      { name: 'openai-whisper', desc: 'Installing Whisper...' }
    ];
    
    for (const pkg of packages) {
      this.updateStep(pkg.desc, 'progress');
      await execAsync(`"${pipPath}" install ${pkg.name}`);
    }
  }

  async downloadModel(modelName) {
    const model = this.models[modelName];
    if (!model || model.included) return;
    
    fs.mkdirSync(this.modelsPath, { recursive: true });
    const modelPath = path.join(this.modelsPath, model.filename);
    
    await this.downloadFile(model.url, modelPath, (progress) => {
      this.updateStep(`Downloading ${modelName} model (${progress}%)...`, 'progress');
    });
    
    return modelPath;
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
            const progress = Math.round((downloadedBytes / totalBytes) * 100);
            onProgress(progress);
          }
        });
        
        response.on('end', () => {
          file.end();
          resolve();
        });
      }).on('error', reject);
    });
  }

  async saveStatus(status) {
    fs.writeFileSync(this.statusPath, JSON.stringify(status, null, 2));
  }

  async loadStatus() {
    try {
      if (fs.existsSync(this.statusPath)) {
        return JSON.parse(fs.readFileSync(this.statusPath, 'utf8'));
      }
    } catch (e) {
      console.error('Error loading init status:', e);
    }
    return { initialized: false };
  }

  setupIPC(mainWindow) {
    this.mainWindow = mainWindow;
    
    ipcMain.handle('init:check', async () => {
      const status = await this.loadStatus();
      return status;
    });
    
    ipcMain.handle('init:start', async () => {
      try {
        const result = await this.initialize();
        return result;
      } catch (error) {
        this.addStep(`Error: ${error.message}`, 'error');
        return { success: false, error: error.message };
      }
    });
    
    ipcMain.handle('init:get-status', () => {
      return {
        steps: this.initSteps,
        currentStep: this.currentStep,
        totalSteps: this.initSteps.length
      };
    });
  }
}

module.exports = InitManager;