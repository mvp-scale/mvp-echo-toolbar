const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { EngineManager } = require('../stt/engine-manager');
const TrayManager = require('./tray-manager');
const { log, clearLog, getLogPath } = require('./logger');

const engineManager = new EngineManager();
const trayManager = new TrayManager();
const logPath = getLogPath();

// ── Startup Cleanup (Boy Scout: leave no trace) ──

// Fresh log file each session
clearLog();

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

  // Detect renderer crashes — log and recover tray state
  hiddenWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`CRITICAL: Hidden window renderer crashed! reason=${details.reason}, exitCode=${details.exitCode}`);
    // Reset tray so user isn't stuck on "processing" forever
    try {
      if (trayIcon) trayIcon.setToolTip('MVP-Echo Toolbar - Ready');
    } catch (_e) {}
  });

  hiddenWindow.webContents.on('crashed', () => {
    log('CRITICAL: Hidden window webContents crashed');
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
    popupWindow.webContents.send('transcription-updated', engineManager.getLastTranscription());
    positionPopup();
    popupWindow.show();
    popupWindow.focus();
  }
}

/**
 * Show the approved React welcome screen on first run.
 * Uses welcome-config.json to track "don't show again" preference.
 */
let welcomeWindow = null;

function showWelcomeWindow() {
  const preloadPath = getPreloadPath();

  welcomeWindow = new BrowserWindow({
    width: 540,
    height: 640,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    center: true,
    show: false,
    transparent: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: preloadPath,
    },
  });

  if (process.env.NODE_ENV === 'development') {
    welcomeWindow.loadURL('http://localhost:5173/welcome.html');
  } else {
    const htmlPath = path.join(__dirname, '../../dist/renderer/welcome.html');
    welcomeWindow.loadFile(htmlPath);
  }

  welcomeWindow.once('ready-to-show', () => {
    welcomeWindow.show();
    welcomeWindow.focus();
  });

  welcomeWindow.on('closed', () => {
    welcomeWindow = null;
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

  // Welcome window: show unless user dismissed this version's welcome
  const welcomeCfgPath = path.join(app.getPath('userData'), 'welcome-config.json');
  const currentVersion = app.getVersion();
  let showWelcome = true;
  try {
    if (fs.existsSync(welcomeCfgPath)) {
      const data = JSON.parse(fs.readFileSync(welcomeCfgPath, 'utf8'));
      // Show welcome again if version changed (new release)
      showWelcome = data.dismissedVersion !== currentVersion;
    }
  } catch (_e) { /* show by default on error */ }

  if (showWelcome) {
    log('Showing welcome window');
    showWelcomeWindow();
  }

  // Create hidden capture window
  createHiddenWindow();

  // Initialize engine manager (probes adapters, selects best one)
  const engineStatus = await engineManager.initialize();
  log('EngineManager initialized: ' + JSON.stringify(engineStatus));

  // Register engine IPC handlers (processAudio, cloud:*, engine:*, get-last-transcription)
  engineManager.setupIPC({
    hiddenWindow,
    getPopupWindow: () => popupWindow,
  });

  log('MVP-Echo Toolbar: Engine ready');

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

// Tray state update with safety timeout
let processingTimer = null;
ipcMain.handle('tray:update-state', async (_event, state) => {
  trayManager.setState(state);
  // Clear any existing timeout
  if (processingTimer) { clearTimeout(processingTimer); processingTimer = null; }
  // If entering processing/recording, set a 30s safety reset
  if (state === 'processing' || state === 'recording') {
    processingTimer = setTimeout(() => {
      log(`WARN: Tray stuck on "${state}" for 30s — resetting to ready`);
      trayManager.setState('ready');
      processingTimer = null;
    }, 30000);
  }
  return { success: true };
});

// Copy last transcription and close popup
ipcMain.handle('popup:copy-and-close', async () => {
  const last = engineManager.getLastTranscription();
  if (last.text) {
    clipboard.writeText(last.text);
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

// Welcome screen preference handlers
const welcomeConfigPath = path.join(app.getPath('userData'), 'welcome-config.json');

ipcMain.handle('welcome:get-preference', async () => {
  try {
    const currentVersion = app.getVersion();
    if (fs.existsSync(welcomeConfigPath)) {
      const data = JSON.parse(fs.readFileSync(welcomeConfigPath, 'utf8'));
      // Show welcome if this version hasn't been dismissed
      return { showOnStartup: data.dismissedVersion !== currentVersion };
    }
  } catch (err) {
    log('Failed to read welcome config: ' + err.message);
  }
  return { showOnStartup: true };
});

ipcMain.handle('welcome:set-preference', async (_event, preference) => {
  try {
    const data = { dismissedVersion: preference.dismissedVersion || app.getVersion() };
    fs.writeFileSync(welcomeConfigPath, JSON.stringify(data, null, 2), 'utf8');
    log('Welcome preference saved: ' + JSON.stringify(data));
    return { success: true };
  } catch (err) {
    log('Failed to save welcome config: ' + err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('app:get-version', async () => {
  return app.getVersion();
});

ipcMain.handle('welcome:close', async () => {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.close();
  }
  return { success: true };
});
