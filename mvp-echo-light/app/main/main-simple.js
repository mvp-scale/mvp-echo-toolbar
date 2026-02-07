const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// MVP-Echo Light uses cloud-based transcription
const WhisperRemoteEngine = require('../stt/whisper-remote');
const cloudEngine = new WhisperRemoteEngine();

// File logging setup
const logPath = path.join(os.tmpdir(), 'mvp-echo-debug.log');

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(message);
  try {
    fs.appendFileSync(logPath, logMessage);
  } catch (err) {
    console.error('Failed to write to log file:', err);
  }
}

// Log startup info
log(`MVP-Echo: Starting application, log file: ${logPath}`);
log(`MVP-Echo: __dirname = ${__dirname}`);
log(`MVP-Echo: process.cwd() = ${process.cwd()}`);
log(`MVP-Echo: NODE_ENV = ${process.env.NODE_ENV}`);
log(`MVP-Echo: Platform: ${os.platform()}, Arch: ${os.arch()}`);
log(`MVP-Echo: App path: ${app.getAppPath()}`);
log(`MVP-Echo: User data path: ${app.getPath('userData')}`);

let mainWindow;
let shortcutActive = false;

function createWindow() {
  const preloadPath = path.resolve(__dirname, '../preload/preload.js');
  log('MVP-Echo: Preload script path: ' + preloadPath);
  
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: preloadPath,
    },
    // Modern Windows 11 styling
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',        // Clean white background matching MVP Scale
      symbolColor: '#6b7280',  // Gray window controls 
      height: 40
    },
    title: 'MVP-Echo',
    backgroundMaterial: 'mica',
    roundedCorners: true,
    // Window transparency effects
    show: false,
    // Additional modern window options
    autoHideMenuBar: true,
    // Enable modern window frame
    frame: true,
    thickFrame: true,
  });

  // Load the React app
  log('MVP-Echo: NODE_ENV = ' + process.env.NODE_ENV);
  if (process.env.NODE_ENV === 'development') {
    log('MVP-Echo: Loading from Vite dev server at http://localhost:5173');
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    log('MVP-Echo: Loading from local file system');
    const htmlPath = path.join(__dirname, '../../dist/renderer/index.html');
    log('MVP-Echo: HTML file path: ' + htmlPath);
    log('MVP-Echo: HTML file exists: ' + fs.existsSync(htmlPath));
    mainWindow.loadFile(htmlPath);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Ensure window comes to foreground when activated
  mainWindow.on('focus', () => {
    log('Window focused');
  });
  
  // Handle window activation (especially from taskbar/dock click)
  mainWindow.on('show', () => {
    mainWindow.focus();
    if (process.platform === 'win32') {
      mainWindow.moveTop();
    }
  });
  
  // Handle restore from minimize
  mainWindow.on('restore', () => {
    mainWindow.focus();
    if (process.platform === 'win32') {
      mainWindow.moveTop();
    }
  });

  mainWindow.on('closed', () => {
    app.quit();
  });
}

app.whenReady().then(async () => {
  createWindow();

  // MVP-Echo Light: Cloud engine is ready immediately (no local initialization needed)
  log('MVP-Echo Light: Cloud engine ready');
  
  // Register global shortcut for Ctrl+Alt+Z - toggle recording
  const ret = globalShortcut.register('CommandOrControl+Alt+Z', () => {
    // Aggressive debounce to prevent hardware key repeat issues
    if (shortcutActive) {
      log('⚠️ Global shortcut ignored (debounce active)');
      return;
    }
    
    shortcutActive = true;
    log('🔥 Global Ctrl+Alt+Z detected - bringing window to foreground');
    
    // IMMEDIATELY bring window to foreground before sending event
    if (mainWindow) {
      // Restore if minimized
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      
      // Show if hidden
      if (!mainWindow.isVisible()) {
        mainWindow.show();
      }
      
      // Force window to foreground on Windows
      mainWindow.setAlwaysOnTop(true);
      mainWindow.focus();
      mainWindow.setAlwaysOnTop(false);
      
      // Windows-specific extra focus methods
      if (process.platform === 'win32') {
        mainWindow.moveTop();
        mainWindow.setSkipTaskbar(false);
      }
    }
    
    // Now send toggle command to renderer
    mainWindow.webContents.send('global-shortcut-toggle');
    
    // Longer debounce to prevent multiple key combination detections
    setTimeout(() => {
      shortcutActive = false;
      log('🔄 Global shortcut debounce reset');
    }, 500);
  });

  if (!ret) {
    log('Global shortcut registration failed');
  } else {
    log('Global shortcut Ctrl+Alt+Z registered successfully');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  // Unregister global shortcuts
  globalShortcut.unregisterAll();
});

app.on('before-quit', async () => {
  // Light version - no local whisper engine to cleanup
  log('MVP-Echo Light: Shutting down');
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC Handlers for STT functionality
let mediaRecorder = null;

// System info handler
ipcMain.handle('get-system-info', async () => {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  
  // Check GPU capabilities through Whisper engine
  let hasGpu = false;
  let gpuProvider = 'CPU';
  
  // Light version - cloud processing
  log('MVP-Echo Light: Cloud-based transcription');
  hasGpu = false;
  gpuProvider = 'Cloud';

  // Light version uses cloud models
  const modelInfo = 'cloud';

  // No portable session in Light version
  const portableInfo = { active: false, portable: false };
  
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model || 'Unknown',
    cpuCores: cpus.length,
    totalMemory: Math.round(totalMem / (1024 * 1024 * 1024)),
    freeMemory: Math.round(freeMem / (1024 * 1024 * 1024)),
    hasGpu,
    gpuProvider,
    whisperModel: modelInfo,
    version: '1.0.0',
    portable: portableInfo
  };
});

// Portable session info handler (Light version - cloud only)
ipcMain.handle('get-portable-info', async () => {
  return { available: false, message: 'Light version uses cloud processing' };
});

// Recording handlers - simplified since audio recording is handled in renderer
ipcMain.handle('start-recording', async (event, source = 'unknown') => {
  log(`🎤 Recording started via: ${source}`);
  return { 
    success: true, 
    message: `Recording started via ${source}` 
  };
});

ipcMain.handle('stop-recording', async (event, source = 'unknown') => {
  log(`🛑 Recording stopped via: ${source}`);
  return { 
    success: true, 
    message: `Recording stopped via ${source}` 
  };
});

// Copy to clipboard handler
ipcMain.handle('copy-to-clipboard', async (event, text) => {
  const { clipboard } = require('electron');
  clipboard.writeText(text);
  return { success: true };
});

// Bring window to foreground handler
ipcMain.handle('bring-to-foreground', async () => {
  if (mainWindow) {
    // Restore window if minimized
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    
    // Show the window if it's hidden
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    
    // Bring to front on Windows
    mainWindow.setAlwaysOnTop(true);
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(false);
    
    // Additional Windows-specific focus
    if (process.platform === 'win32') {
      mainWindow.setSkipTaskbar(false);
      mainWindow.moveTop();
    }
    
    log('🔝 Window brought to foreground');
    return { success: true };
  }
  return { success: false, error: 'Window not available' };
});

// Process audio with Cloud STT
ipcMain.handle('processAudio', async (event, audioArray, options = {}) => {
  log('🎤 Processing audio array of length: ' + audioArray.length);
  log('🎤 Using model: ' + (options.model || cloudEngine.selectedModel));

  try {
    // Check if cloud engine is configured
    if (!cloudEngine.isConfigured) {
      throw new Error('Cloud endpoint not configured. Please configure in Settings.');
    }

    // Save audio to temp file for cloud engine
    const tempPath = path.join(os.tmpdir(), `mvp-echo-audio-${Date.now()}.webm`);
    const audioBuffer = Buffer.from(audioArray);
    fs.writeFileSync(tempPath, audioBuffer);

    log('📁 Audio saved to temp file: ' + tempPath);

    // Process with cloud engine, passing model and language from options
    const result = await cloudEngine.transcribe(tempPath, {
      model: options.model,
      language: options.language
    });

    // Clean up temp file
    try {
      fs.unlinkSync(tempPath);
      log('🗑️ Temp file cleaned up');
    } catch (e) {
      log('⚠️ Failed to clean up temp file: ' + e.message);
    }

    log('✅ Cloud transcription result: ' + JSON.stringify(result));

    return {
      success: true,
      text: result.text,
      processingTime: result.processingTime,
      engine: result.engine,
      language: result.language,
      model: result.model
    };

  } catch (error) {
    log('❌ Cloud processing failed: ' + error.message);

    return {
      success: false,
      text: '',
      processingTime: 0,
      engine: 'Cloud (error)',
      error: error.message
    };
  }
});

// Cloud configuration IPC handlers
ipcMain.handle('cloud:configure', async (event, config) => {
  log('☁️ Configuring cloud endpoint: ' + config.endpointUrl);

  cloudEngine.endpointUrl = config.endpointUrl;
  cloudEngine.apiKey = config.apiKey || null;
  if (config.model) cloudEngine.selectedModel = config.model;
  if (config.language !== undefined) cloudEngine.language = config.language || null;
  cloudEngine.isConfigured = !!config.endpointUrl;
  cloudEngine.saveConfig();

  return { success: true };
});

ipcMain.handle('cloud:test-connection', async () => {
  log('☁️ Testing cloud connection...');
  const result = await cloudEngine.testConnection();
  log('☁️ Connection test result: ' + JSON.stringify(result));
  return result;
});

ipcMain.handle('cloud:get-config', () => {
  return cloudEngine.getConfig();
});

// Export file handler
ipcMain.handle('export-text', async (event, content, filename) => {
  const { dialog } = require('electron');
  const fs = require('fs');
  
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: filename,
    filters: [
      { name: 'Text Files', extensions: ['txt'] },
      { name: 'Markdown Files', extensions: ['md'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  
  if (!result.canceled && result.filePath) {
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { success: true, path: result.filePath };
  }
  
  return { success: false, message: 'Export cancelled' };
});