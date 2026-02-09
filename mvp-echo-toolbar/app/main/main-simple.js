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

// ── Startup Cleanup (Boy Scout: leave no trace) ──

// Fresh log file each session
try {
  fs.writeFileSync(logPath, '');
} catch (_e) { /* ignore */ }

// Sweep orphaned audio temp files from previous sessions
try {
  const tmpDir = os.tmpdir();
  const orphans = fs.readdirSync(tmpDir).filter(f => f.startsWith('mvp-echo-audio-') && f.endsWith('.webm'));
  if (orphans.length > 0) {
    orphans.forEach(f => {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch (_e) { /* ignore */ }
    });
  }
} catch (_e) { /* ignore */ }

log(`MVP-Echo Toolbar: Starting, log file: ${logPath}`);

// ── App Config (configurable keybind) ──

function loadAppConfig() {
  const configPath = path.join(app.getPath('userData'), 'app-config.json');
  const defaults = { shortcut: 'CommandOrControl+Alt+Z' };

  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge with defaults so new keys are always present
      const merged = { ...defaults, ...parsed };
      log('Loaded app config: ' + JSON.stringify(merged));
      return merged;
    }
  } catch (e) {
    log('Failed to read app-config.json, using defaults: ' + e.message);
  }

  // Create default config file
  try {
    fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2));
    log('Created default app-config.json');
  } catch (e) {
    log('Failed to write default app-config.json: ' + e.message);
  }

  return defaults;
}

function shortcutDisplayLabel(accelerator) {
  return accelerator
    .replace('CommandOrControl', 'Ctrl')
    .replace('CmdOrCtrl', 'Ctrl');
}

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

/**
 * Show a welcome window on first run (replaces tray balloon which Win11 suppresses)
 */
function showWelcomeWindow(shortcutLabel) {
  const version = require('../../package.json').version;
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; }
  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    background: #1a1a2e; color: #e0e0e0;
    padding: 20px 22px 16px; user-select: none;
    -webkit-app-region: drag;
  }
  .header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4px; }
  h1 { font-size: 16px; font-weight: 600; color: #fff; }
  .version { font-size: 11px; color: #556; }
  .subtitle { font-size: 11px; color: #888; margin-bottom: 14px; }
  .card {
    background: #16213e; border-radius: 8px; padding: 10px 14px;
    margin-bottom: 8px; display: flex; align-items: flex-start; gap: 10px;
  }
  .card .icon { font-size: 18px; flex-shrink: 0; margin-top: 1px; }
  .card h2 { font-size: 12px; font-weight: 600; color: #fff; margin-bottom: 2px; }
  .card p { font-size: 11px; color: #aaa; line-height: 1.35; }
  kbd {
    background: #0f3460; border-radius: 4px; padding: 1px 5px;
    font-family: 'Segoe UI', monospace; font-size: 11px; color: #7ec8e3;
  }
  .btn {
    -webkit-app-region: no-drag;
    display: block; width: 100%; margin-top: 14px; padding: 9px;
    background: #0f3460; color: #7ec8e3; border: none; border-radius: 8px;
    font-size: 13px; font-weight: 600; cursor: pointer; transition: background 0.15s;
  }
  .btn:hover { background: #1a4a7a; }
</style></head><body>
  <div class="header">
    <h1>MVP-Echo Toolbar</h1>
    <span class="version">v${version}</span>
  </div>
  <p class="subtitle">Quick tips to get started</p>
  <div class="card">
    <span class="icon">&#127908;</span>
    <div><h2>Record</h2><p>Press <kbd>${shortcutLabel}</kbd> to start &amp; stop recording from anywhere.</p></div>
  </div>
  <div class="card">
    <span class="icon">&#128269;</span>
    <div><h2>System Tray</h2><p>Look for the microphone icon in your system tray (bottom-right). Click it to see transcriptions.</p></div>
  </div>
  <div class="card">
    <span class="icon">&#128203;</span>
    <div><h2>Auto-Copy</h2><p>Transcriptions are automatically copied to your clipboard when finished.</p></div>
  </div>
  <button class="btn" onclick="window.close()">Got it</button>
</body></html>`;

  const welcomeWin = new BrowserWindow({
    width: 380,
    height: 330,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    center: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  welcomeWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  welcomeWin.once('ready-to-show', () => {
    welcomeWin.show();
    welcomeWin.focus();
  });
}

// ── App Lifecycle ──

app.whenReady().then(async () => {
  // Load user config (keybind, etc.)
  const appConfig = loadAppConfig();
  const shortcutLabel = shortcutDisplayLabel(appConfig.shortcut);

  // Auto-approve microphone permission
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });

  // Create tray icon (pass shortcut label for dynamic tooltip)
  trayManager.create({
    onTogglePopup: togglePopup,
    onQuit: () => app.quit(),
    shortcutLabel,
  });

  // Welcome window: show once (marker file prevents repeat)
  const welcomePath = path.join(app.getPath('userData'), '.welcome-complete');
  if (!fs.existsSync(welcomePath)) {
    log('Showing welcome window');
    showWelcomeWindow(shortcutLabel);
    try {
      fs.writeFileSync(welcomePath, new Date().toISOString());
    } catch (_e) { /* ignore */ }
  }

  // Create hidden capture window
  createHiddenWindow();

  log('MVP-Echo Toolbar: Cloud engine ready');

  // Register global shortcut (configurable)
  const ret = globalShortcut.register(appConfig.shortcut, () => {
    if (shortcutActive) {
      log('Global shortcut ignored (debounce active)');
      return;
    }

    shortcutActive = true;
    log(`Global ${shortcutLabel} detected - sending to hidden window`);

    // Send to hidden window WITHOUT bringing anything to foreground
    if (hiddenWindow && !hiddenWindow.isDestroyed()) {
      hiddenWindow.webContents.send('global-shortcut-toggle');
    }

    setTimeout(() => {
      shortcutActive = false;
    }, 500);
  });

  if (!ret) {
    log(`Global shortcut ${shortcutLabel} registration failed`);
  } else {
    log(`Global shortcut ${shortcutLabel} registered successfully`);
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

    // Clean up temp file on error
    try {
      const tmpDir = os.tmpdir();
      const orphans = fs.readdirSync(tmpDir).filter(f => f.startsWith('mvp-echo-audio-') && f.endsWith('.webm'));
      orphans.forEach(f => {
        try { fs.unlinkSync(path.join(tmpDir, f)); } catch (_e) { /* ignore */ }
      });
    } catch (_e) { /* ignore */ }

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

// Debug: open DevTools for capture window (where audio/transcription logs are)
ipcMain.handle('debug:open-devtools', async () => {
  log('Opening DevTools for capture window');
  if (hiddenWindow && !hiddenWindow.isDestroyed()) {
    hiddenWindow.webContents.openDevTools({ mode: 'detach' });
  }
  return { success: true };
});

// Debug: receive log messages from capture window renderer
ipcMain.handle('debug:renderer-log', async (_event, message) => {
  log(`[capture] ${message}`);
});
