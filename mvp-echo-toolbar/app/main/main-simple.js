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

// ── Global crash safety ──
// Without these, an uncaught error or rejected promise in any async path
// silently kills the main process (no dialog, no log). We log and KEEP RUNNING:
// for a resident tray utility, one stray async throw shouldn't take down voice
// capture. (Recoverability is handled per-subsystem, e.g. renderer-crash below.)
process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION: ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', (reason) => {
  log(`UNHANDLED REJECTION: ${reason && reason.stack ? reason.stack : reason}`);
});

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
  // Stop the rest of this module from initializing (tray, shortcuts, windows,
  // IPC) on a process that is already tearing down. Module-scope return is
  // valid here — Electron wraps main modules in the CommonJS function wrapper.
  return;
}

app.on('second-instance', () => {
  log('MVP-Echo Toolbar: Second instance detected, showing popup.');
  togglePopup();
});

let hiddenWindow = null;
let popupWindow = null;
let shortcutActive = false;
let countdownActive = false;
let rendererCrashCount = 0;
const MAX_RENDERER_CRASHES = 3;

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
    hiddenWindow.loadURL('http://localhost:5175/index.html');
  } else {
    const htmlPath = path.join(__dirname, '../../dist/renderer/index.html');
    hiddenWindow.loadFile(htmlPath);
  }

  hiddenWindow.on('closed', () => {
    hiddenWindow = null;
  });

  // Detect renderer crashes — reset tray AND recreate the capture window.
  // Without recreation the hidden window stays null and recording is silently
  // dead until the app is restarted. Guarded by a crash-count cap so a
  // crash-on-load can't spin into an infinite respawn loop.
  hiddenWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`CRITICAL: Hidden window renderer gone! reason=${details.reason}, exitCode=${details.exitCode}`);
    // Reset tray so the user isn't stuck on "Recording"/"Processing" forever.
    try { trayManager.setState('ready'); } catch (_e) {}

    if (++rendererCrashCount > MAX_RENDERER_CRASHES) {
      log('Renderer crash loop detected — not recreating hidden window');
      return;
    }
    if (hiddenWindow && !hiddenWindow.isDestroyed()) hiddenWindow.destroy();
    hiddenWindow = null;
    createHiddenWindow(); // rebuild the capture window so recording works again
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
    popupWindow.loadURL('http://localhost:5175/popup.html');
  } else {
    const htmlPath = path.join(__dirname, '../../dist/renderer/popup.html');
    popupWindow.loadFile(htmlPath);
  }

  // Hide on blur (click outside) — but not during countdown
  popupWindow.on('blur', () => {
    if (countdownActive) return;
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
    welcomeWindow.loadURL('http://localhost:5175/welcome.html');
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

  // Register engine IPC handlers FIRST so the renderer's startup
  // cloud:get-config call doesn't race past unregistered handlers.
  // Window references are passed as getters and resolved lazily.
  engineManager.setupIPC({
    getHiddenWindow: () => hiddenWindow,
    getPopupWindow: () => popupWindow,
  });

  // Create hidden capture window (handlers exist; cloud:get-config will await
  // engineManager._readyPromise which resolves at the end of initialize())
  createHiddenWindow();

  // Wait for the renderer to load before probing GPU via executeJavaScript.
  await new Promise((resolve) => {
    if (hiddenWindow.webContents.isLoading()) {
      hiddenWindow.webContents.once('did-finish-load', resolve);
    } else {
      resolve();
    }
  });

  // Initialize engine manager (probes adapters, selects best one).
  // Resolves the engine-ready promise so awaiting IPC handlers proceed.
  const engineStatus = await engineManager.initializeAndSignalReady();
  log('EngineManager initialized: ' + JSON.stringify(engineStatus));

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

// Tray state update. The tray is a pure reflection of renderer state — the
// renderer (CaptureApp) is the single authority for the recording/processing
// lifecycle and owns its own safety deadlines (60s processing valve + 590s
// auto-stop). The previous main-side 30s/600s timers were a second,
// unsynchronized source of truth: the 30s one fired mid-transcription and
// flipped the tray to "ready" while the renderer was still processing, so the
// next shortcut press was silently ignored ("alive but dead"). Removed.
ipcMain.handle('tray:update-state', async (_event, state) => {
  trayManager.setState(state);
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

// Countdown: hidden window sends timing data, main forwards to popup
ipcMain.handle('countdown:update', async (_event, data) => {
  countdownActive = !!data.active;

  // Ensure popup exists
  if (!popupWindow || popupWindow.isDestroyed()) {
    createPopupWindow();
    await new Promise((resolve) => popupWindow.once('ready-to-show', resolve));
  }

  // Force-show popup during countdown
  if (data.active && popupWindow && !popupWindow.isDestroyed()) {
    if (!popupWindow.isVisible()) {
      positionPopup();
      popupWindow.show();
      popupWindow.focus();
    }
  }

  // Forward countdown data to popup renderer
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send('countdown-update', data);
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
