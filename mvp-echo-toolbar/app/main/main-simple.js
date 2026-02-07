const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const WhisperRemoteEngine = require('../stt/whisper-remote');
const TrayManager = require('./tray-manager');

const cloudEngine = new WhisperRemoteEngine();
const trayManager = new TrayManager();

// File logging
const logPath = path.join(os.tmpdir(), 'mvp-echo-toolbar-debug.log');

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  console.log(message);
  try {
    fs.appendFileSync(logPath, logMessage);
  } catch (err) {
    // ignore log errors
  }
}

log(`MVP-Echo Toolbar: Starting, log file: ${logPath}`);

// ── Single Instance Lock ──
// Prevent multiple instances. If a second copy launches, focus the existing one.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  log('MVP-Echo Toolbar: Another instance is already running. Exiting.');
  app.quit();
}

app.on('second-instance', () => {
  log('MVP-Echo Toolbar: Second instance detected, showing popup.');
  togglePopup();
});

let hiddenWindow = null;
let popupWindow = null;
let shortcutActive = false;
let lastTranscription = '';
let lastTranscriptionMeta = {};

function getPreloadPath() {
  return path.resolve(__dirname, '../preload/preload.js');
}

/**
 * Create hidden window for audio capture
 * This window is never shown but keeps MediaRecorder/Web Audio API alive
 */
function createHiddenWindow() {
  const preloadPath = getPreloadPath();
  log('MVP-Echo Toolbar: Creating hidden capture window');

  hiddenWindow = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    skipTaskbar: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: preloadPath,
    },
  });

  if (process.env.NODE_ENV === 'development') {
    hiddenWindow.loadURL('http://localhost:5173/index.html');
  } else {
    const htmlPath = path.join(__dirname, '../../dist/renderer/index.html');
    hiddenWindow.loadFile(htmlPath);
  }

  hiddenWindow.on('closed', () => {
    hiddenWindow = null;
  });
}

/**
 * Create popup window for transcription display + settings
 * Created lazily on first tray click, then hidden/shown
 */
function createPopupWindow() {
  if (popupWindow && !popupWindow.isDestroyed()) {
    return;
  }

  const preloadPath = getPreloadPath();
  log('MVP-Echo Toolbar: Creating popup window');

  popupWindow = new BrowserWindow({
    show: false,
    width: 380,
    height: 300,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: preloadPath,
    },
  });

  if (process.env.NODE_ENV === 'development') {
    popupWindow.loadURL('http://localhost:5173/popup.html');
  } else {
    const htmlPath = path.join(__dirname, '../../dist/renderer/popup.html');
    popupWindow.loadFile(htmlPath);
  }

  // Hide on blur (click outside)
  popupWindow.on('blur', () => {
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.hide();
    }
  });

  popupWindow.on('closed', () => {
    popupWindow = null;
  });
}

/**
 * Position popup window above the tray icon
 */
function positionPopup() {
  if (!popupWindow || popupWindow.isDestroyed()) return;

  const trayBounds = trayManager.getBounds();
  if (!trayBounds) return;

  const display = screen.getDisplayNearestPoint({
    x: trayBounds.x,
    y: trayBounds.y,
  });

  const popupBounds = popupWindow.getBounds();
  const workArea = display.workArea;

  // Default: center horizontally above tray icon
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - popupBounds.width / 2);
  let y;

  // Determine if taskbar is at top or bottom
  if (trayBounds.y < workArea.y + workArea.height / 2) {
    // Taskbar at top - show below tray
    y = trayBounds.y + trayBounds.height + 4;
  } else {
    // Taskbar at bottom - show above tray
    y = trayBounds.y - popupBounds.height - 4;
  }

  // Keep within screen bounds
  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - popupBounds.width));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - popupBounds.height));

  popupWindow.setPosition(x, y);
}

/**
 * Toggle popup visibility
 */
function togglePopup() {
  if (!popupWindow || popupWindow.isDestroyed()) {
    createPopupWindow();
    // Wait for window to be ready before showing
    popupWindow.once('ready-to-show', () => {
      positionPopup();
      popupWindow.show();
      popupWindow.focus();
    });
    return;
  }

  if (popupWindow.isVisible()) {
    popupWindow.hide();
  } else {
    // Send latest transcription data before showing
    popupWindow.webContents.send('transcription-updated', {
      text: lastTranscription,
      ...lastTranscriptionMeta,
    });
    positionPopup();
    popupWindow.show();
    popupWindow.focus();
  }
}

// ── App Lifecycle ──

app.whenReady().then(async () => {
  // Auto-approve microphone permission
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });

  // Create tray icon
  trayManager.create({
    onTogglePopup: togglePopup,
    onQuit: () => app.quit(),
  });

  // Create hidden capture window
  createHiddenWindow();

  log('MVP-Echo Toolbar: Cloud engine ready');

  // Register global shortcut
  const ret = globalShortcut.register('CommandOrControl+Alt+Z', () => {
    if (shortcutActive) {
      log('Global shortcut ignored (debounce active)');
      return;
    }

    shortcutActive = true;
    log('Global Ctrl+Alt+Z detected - sending to hidden window');

    // Send to hidden window WITHOUT bringing anything to foreground
    if (hiddenWindow && !hiddenWindow.isDestroyed()) {
      hiddenWindow.webContents.send('global-shortcut-toggle');
    }

    setTimeout(() => {
      shortcutActive = false;
    }, 500);
  });

  if (!ret) {
    log('Global shortcut registration failed');
  } else {
    log('Global shortcut Ctrl+Alt+Z registered successfully');
  }
});

// Tray app: window-all-closed does NOT quit
app.on('window-all-closed', () => {
  // No-op - tray app stays alive
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('before-quit', () => {
  trayManager.destroy();
  log('MVP-Echo Toolbar: Shutting down');
});

// ── IPC Handlers ──

// Recording state tracking (for logging)
ipcMain.handle('start-recording', async (_event, source = 'unknown') => {
  log(`Recording started via: ${source}`);
  return { success: true };
});

ipcMain.handle('stop-recording', async (_event, source = 'unknown') => {
  log(`Recording stopped via: ${source}`);
  return { success: true };
});

// Copy to clipboard
ipcMain.handle('copy-to-clipboard', async (_event, text) => {
  clipboard.writeText(text);
  return { success: true };
});

// Tray state update
ipcMain.handle('tray:update-state', async (_event, state) => {
  trayManager.setState(state);
  return { success: true };
});

// Get last transcription (for popup)
ipcMain.handle('get-last-transcription', async () => {
  return {
    text: lastTranscription,
    ...lastTranscriptionMeta,
  };
});

// Copy last transcription and close popup
ipcMain.handle('popup:copy-and-close', async () => {
  if (lastTranscription) {
    clipboard.writeText(lastTranscription);
  }
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.hide();
  }
  return { success: true };
});

// Hide popup
ipcMain.handle('popup:hide', async () => {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.hide();
  }
  return { success: true };
});

// Process audio with Cloud STT
ipcMain.handle('processAudio', async (_event, audioArray, options = {}) => {
  log('Processing audio array of length: ' + audioArray.length);

  try {
    if (!cloudEngine.isConfigured) {
      throw new Error('Cloud endpoint not configured. Please configure in Settings.');
    }

    const tempPath = path.join(os.tmpdir(), `mvp-echo-audio-${Date.now()}.webm`);
    const audioBuffer = Buffer.from(audioArray);
    fs.writeFileSync(tempPath, audioBuffer);

    const result = await cloudEngine.transcribe(tempPath, {
      model: options.model,
      language: options.language,
    });

    // Clean up temp file
    try {
      fs.unlinkSync(tempPath);
    } catch (e) {
      log('Failed to clean up temp file: ' + e.message);
    }

    // Store last transcription for popup
    lastTranscription = result.text;
    lastTranscriptionMeta = {
      processingTime: result.processingTime,
      engine: result.engine,
      language: result.language,
      model: result.model,
    };

    // Notify popup if it's open
    if (popupWindow && !popupWindow.isDestroyed()) {
      popupWindow.webContents.send('transcription-updated', {
        text: lastTranscription,
        ...lastTranscriptionMeta,
      });
    }

    log('Cloud transcription result: ' + JSON.stringify(result));

    return {
      success: true,
      text: result.text,
      processingTime: result.processingTime,
      engine: result.engine,
      language: result.language,
      model: result.model,
    };
  } catch (error) {
    log('Cloud processing failed: ' + error.message);
    return {
      success: false,
      text: '',
      processingTime: 0,
      engine: 'Cloud (error)',
      error: error.message,
    };
  }
});

// Cloud configuration
ipcMain.handle('cloud:configure', async (_event, config) => {
  log('Configuring cloud endpoint: ' + config.endpointUrl);

  cloudEngine.endpointUrl = config.endpointUrl;
  cloudEngine.apiKey = config.apiKey || null;
  if (config.model) cloudEngine.selectedModel = config.model;
  if (config.language !== undefined) cloudEngine.language = config.language || null;
  cloudEngine.isConfigured = !!config.endpointUrl;
  cloudEngine.saveConfig();

  return { success: true };
});

ipcMain.handle('cloud:test-connection', async () => {
  log('Testing cloud connection...');
  const result = await cloudEngine.testConnection();
  log('Connection test result: ' + JSON.stringify(result));
  return result;
});

ipcMain.handle('cloud:get-config', () => {
  return cloudEngine.getConfig();
});
