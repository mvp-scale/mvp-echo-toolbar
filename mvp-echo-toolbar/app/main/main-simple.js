const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { EngineManager } = require('../stt/engine-manager');
const TrayManager = require('./tray-manager');
const { log, clearLog, getLogPath, flushSync } = require('./logger');

const engineManager = new EngineManager();
const trayManager = new TrayManager();
const logPath = getLogPath();

// ── Diagnostics flag ──
// OFF by default (clean, quiet console). Enable at launch with either:
//   "MVP-Echo Toolbar.exe" --diag      (CLI arg)
//   set MVP_DEBUG=1 && "MVP-Echo Toolbar.exe"   (env var, reliable for portable)
// When on, the renderer streams one structured fingerprint line per recording to
// a dedicated diagnostics file (separate from the general debug log).
const DIAG_ENABLED = process.argv.includes('--diag') || !!process.env.MVP_DEBUG;

// ── Cross-origin isolation toggle ──
// OFF by default since 3.1.0. On via --coi / MVP_COI=1.
//
// Isolation genuinely works on file:// under Chromium 120 (measured:
// crossOriginIsolated true, SharedArrayBuffer live, 16 cores), and it bought
// multi-threaded WASM decode. But Chromium 150 enforces COEP's
// "worker initialization" check on the module worker, and under file:// the
// document and the worker chunk are separate opaque origins -- so the worker is
// blocked, the orchestrator never becomes ready, and the hotkey dies. On
// Electron 43 you can have a working worker or 16-thread decode, not both,
// until the renderer moves off file:// to a real origin (plan phase 3).
//
// Off is the correct default meanwhile: a slower transcription beats an app
// that cannot record. Every release before 3.0.28 already decoded
// single-threaded, and typical recordings are 1-8s where the difference is tens
// of milliseconds. Nothing in app/ reads crossOriginIsolated or
// SharedArrayBuffer, and parakeet's threading fallback is a warning, not a
// crash.
const COI_ENABLED = process.argv.includes('--coi') || !!process.env.MVP_COI;

// ── SharedArrayBuffer switch (experimental, plan item 14) ──
// Chromium can expose SharedArrayBuffer without cross-origin isolation. With
// COEP off there is no worker block left to lift, and parakeet gates its
// threaded path on SharedArrayBuffer existing rather than on
// crossOriginIsolated -- so this may restore multi-threaded decode with no
// origin change at all.
//
// Flag-gated rather than on by default: it relaxes a Spectre mitigation, and
// whether Chromium 150 still honours the switch is unverified. Turn it on with
// --sab / MVP_SAB=1, measure, then decide.
const SAB_SWITCH = process.argv.includes('--sab') || !!process.env.MVP_SAB;
if (SAB_SWITCH) {
  app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
}

// ── Replay mode ──
// --replay=<path-to.wav> pushes a saved recording through the real
// transcription pipeline instead of the microphone. Deterministic: the same
// bytes and the same model every run, so a difference in output is the code
// change and not how the sentence was read.
function parseReplayArg(argv) {
  const arg = (argv || []).find((a) => typeof a === 'string' && a.startsWith('--replay='));
  return arg ? arg.slice('--replay='.length).replace(/^"|"$/g, '') : null;
}
const REPLAY_PATH = parseReplayArg(process.argv);
const diagPath = path.join(os.tmpdir(), 'mvp-echo-diagnostics.log');

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
// Print where config actually lands. engine-state.json was reported missing
// from %APPDATA%\mvp-echo-toolbar while the legacy configs were being READ from
// there successfully — a contradiction that no amount of reasoning at a
// distance resolved, so the app now states the path it resolves.
log(`MVP-Echo Toolbar: userData = ${app.getPath('userData')}`);

// Diagnostics: announce status + start a fresh diagnostics file when enabled.
if (DIAG_ENABLED) {
  try { fs.writeFileSync(diagPath, `# MVP-Echo diagnostics — session start ${new Date().toISOString()}\n`); } catch (_e) { /* ignore */ }
  log(`MVP-Echo Toolbar: DIAGNOSTICS ON → ${diagPath}`);
} else {
  log('MVP-Echo Toolbar: diagnostics OFF (launch with --diag or MVP_DEBUG=1 to enable)');
}


// ── App Config (configurable keybind) ──

function loadAppConfig() {
  const configPath = path.join(app.getPath('userData'), 'app-config.json');
  const defaults = { shortcut: 'CommandOrControl+Alt+Z', micReadinessMode: 'keep-ready', micIdleReleaseMs: 30000 };

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

app.on('second-instance', (_event, argv) => {
  // A second launch carrying --replay is a test command, not a request to show
  // the UI: forward it to the already-running instance instead of quitting
  // silently. Without this, replay only ever worked on a cold start.
  const replayPath = parseReplayArg(argv);
  if (replayPath) {
    log('MVP-Echo Toolbar: Second instance requested replay.');
    triggerReplay(replayPath);
    return;
  }
  log('MVP-Echo Toolbar: Second instance detected, showing popup.');
  togglePopup();
});

let hiddenWindow = null;
let popupWindow = null;
let shortcutActive = false;
let countdownActive = false;
let rendererCrashCount = 0;
const MAX_RENDERER_CRASHES = 3;

/** True once EngineManager has finished initializing and the hotkey can record. */
let engineReady = false;
/** True when startup ended in a terminal failure (no retry is pending). */
let startupFailed = false;

function getPreloadPath() {
  return path.resolve(__dirname, '../preload/preload.js');
}

/**
 * Should windows load from the Vite dev server rather than the built bundle?
 *
 * Both conditions are required:
 *   - NODE_ENV alone is an inheritable env var, so a PACKAGED exe launched from
 *     a shell that exports NODE_ENV=development would try to reach a dev server
 *     that isn't running and render a blank window with no error.
 *   - app.isPackaged alone is also wrong: `npm start` runs UNPACKAGED against an
 *     already-built dist/renderer, and would be misrouted to the dev server.
 */
function shouldUseDevServer() {
  return !app.isPackaged && process.env.NODE_ENV === 'development';
}

/**
 * Wait for a window's first load to settle, bounded.
 *
 * The previous version awaited a bare did-finish-load with no failure path and
 * no timeout: if the renderer failed to load, startup hung forever, the engine
 * was never initialized, and the tray sat looking healthy while recording was
 * silently dead. Resolves with a status object rather than rejecting so the
 * caller can branch explicitly.
 *
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
function waitForFirstLoad(win, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) {
      resolve({ ok: false, reason: 'window destroyed before load' });
      return;
    }
    if (!win.webContents.isLoading()) {
      resolve({ ok: true });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      win.webContents.removeListener('did-finish-load', onLoad);
      win.webContents.removeListener('did-fail-load', onFail);
      resolve(result);
    };

    const onLoad = () => finish({ ok: true });
    const onFail = (_event, errorCode, errorDescription, _url, isMainFrame) => {
      // Subframe failures don't stop the page. ERR_ABORTED (-3) is what a
      // superseded navigation reports and is not a real failure either.
      if (!isMainFrame || errorCode === -3) return;
      finish({ ok: false, reason: `did-fail-load ${errorCode}: ${errorDescription}` });
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: `no load event within ${timeoutMs}ms` }),
      timeoutMs,
    );

    win.webContents.on('did-finish-load', onLoad);
    win.webContents.on('did-fail-load', onFail);
  });
}

/**
 * Read a WAV off disk and hand it to the capture window for transcription.
 * The renderer waits for the model itself, so this does not need to.
 */
function triggerReplay(filePath) {
  if (!hiddenWindow || hiddenWindow.isDestroyed()) {
    log(`Replay FAILED: capture window not available`);
    return;
  }
  try {
    const bytes = fs.readFileSync(filePath);
    log(`Replay: sending ${filePath} (${bytes.length} bytes) to the capture window`);
    hiddenWindow.webContents.send(
      'diag:replay-audio',
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  } catch (e) {
    log(`Replay FAILED to read ${filePath}: ${e && e.message}`);
  }
}

/**
 * Deny navigation and window.open for a window.
 *
 * The preload script stays attached to a webContents for its lifetime, not just
 * the first load — so if one of these windows were ever navigated elsewhere,
 * the whole IPC surface (config writes, clipboard, the mic pipeline) would come
 * with it. Nothing here has a legitimate reason to navigate or open a window.
 */
function lockNavigation(win) {
  win.webContents.on('will-navigate', (event, url) => {
    log(`Blocked navigation attempt to ${url}`);
    event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    log(`Blocked window.open to ${url}`);
    return { action: 'deny' };
  });
}

/**
 * Forward a window's console warnings and errors into the debug log.
 *
 * Two gaps this closes. First, only the hidden capture window has a console
 * shim — Settings and the welcome screen end every failure path at a bare
 * console.error in a window nothing was listening to, so those failures went
 * nowhere at all. Second, and the reason this exists even for the shimmed
 * window: messages generated by the browser itself never pass through a shim.
 * A COEP violation or a blocked worker script is reported by Chromium, not by
 * app code, so it is structurally invisible to console forwarding done inside
 * the renderer. That is what made the Electron 43 failure so hard to see.
 *
 * Only warn and error are forwarded — info/debug would flood the file. Lines
 * are tagged with the window so a duplicate of the hidden window's own shim
 * output is identifiable rather than confusing.
 */
function forwardConsole(win, label) {
  win.webContents.on('console-message', (...args) => {
    // Electron 35 replaced the positional (event, level, message, line, source)
    // signature with a single event object carrying those as properties. Duck-
    // type so one build works on both 28 and 43 during the migration.
    const e = args[0] || {};
    const isNewShape = e.message !== undefined;
    const level = isNewShape ? e.level : args[1];
    const message = isNewShape ? e.message : args[2];
    const line = isNewShape ? e.lineNumber : args[3];
    const source = isNewShape ? e.sourceId : args[4];

    // Old shape used integers (2 = warning, 3 = error); new shape uses strings.
    const isWarnOrError =
      typeof level === 'string' ? (level === 'warning' || level === 'error') : (level >= 2);
    if (!isWarnOrError) return;

    const where = source ? ` (${source}:${line})` : '';
    log(`[console:${label}:${level}] ${message}${where}`);
  });
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

  if (shouldUseDevServer()) {
    hiddenWindow.loadURL('http://localhost:5175/index.html');
  } else {
    const htmlPath = path.join(__dirname, '../../dist/renderer/index.html');
    hiddenWindow.loadFile(htmlPath);
  }

  lockNavigation(hiddenWindow);
  forwardConsole(hiddenWindow, "capture");

  hiddenWindow.on('closed', () => {
    hiddenWindow = null;
  });

  // A clean load means we're healthy — reset the crash budget so the cap is a
  // rapid-crash-LOOP breaker, not a lifetime limit. Without this, 3 unrelated
  // renderer crashes spread over a days-long session would permanently stop
  // recovery and silently kill recording.
  hiddenWindow.webContents.on('did-finish-load', () => {
    rendererCrashCount = 0;
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

  if (shouldUseDevServer()) {
    popupWindow.loadURL('http://localhost:5175/popup.html');
  } else {
    const htmlPath = path.join(__dirname, '../../dist/renderer/popup.html');
    popupWindow.loadFile(htmlPath);
  }

  lockNavigation(popupWindow);
  forwardConsole(popupWindow, "popup");

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

  if (shouldUseDevServer()) {
    welcomeWindow.loadURL('http://localhost:5175/welcome.html');
  } else {
    const htmlPath = path.join(__dirname, '../../dist/renderer/welcome.html');
    welcomeWindow.loadFile(htmlPath);
  }

  lockNavigation(welcomeWindow);
  forwardConsole(welcomeWindow, "welcome");

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

  // Auto-approve the mic, and persistent-storage. The latter exempts the ~1.2GB
  // parakeet model blob (cached in IndexedDB) from Chromium quota eviction —
  // without it, navigator.storage.persist() is denied and the cache can be
  // evicted under storage pressure, forcing a full re-download on a later launch.
  // ── Cross-origin isolation ──
  // Without COOP/COEP, SharedArrayBuffer is undefined and parakeet.js falls
  // back to ONE WASM thread (backend.js:67-74). The decoder is FORCED onto WASM
  // in every webgpu mode, so that penalty is paid on every transcription, in
  // every packaged build, silently -- there is no error, just a permanently
  // worse RTF. vite.config.ts sets these for the dev server only, which is why
  // it never shows up while developing.
  //
  // 'credentialless' rather than 'require-corp': the model is fetched
  // cross-origin from HuggingFace, and require-corp would reject those
  // responses unless they carry CORP. credentialless permits them.
  // Escape hatch: this is the one change that could break a FRESH model
  // download (COEP vs. HuggingFace's CORS), and that cannot be verified on a
  // dev box with no Windows, no WebGPU and no real network. Launching with
  // --no-coi (or MVP_NO_COI=1) disables it WITHOUT a rebuild, so a single
  // build can test both states and isolate the cause of a failed download.
  if (COI_ENABLED) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      // Only our OWN documents get the isolation headers. Stamping them onto a
      // cross-origin model download would be meaningless at best.
      const isOwnDocument =
        details.url.startsWith('file://') || details.url.startsWith('http://localhost:5175');
      if (!isOwnDocument) {
        callback({});
        return;
      }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Cross-Origin-Opener-Policy': ['same-origin'],
          'Cross-Origin-Embedder-Policy': ['credentialless'],
        },
      });
    });
    log(`MVP-Echo Toolbar: cross-origin isolation ON via --coi (multi-threaded WASM decode; on Chromium 150 this blocks the module worker)${SAB_SWITCH ? ' [+SharedArrayBuffer switch]' : ''}`);
  } else {
    log(`MVP-Echo Toolbar: cross-origin isolation OFF (default since 3.1.0; decode single-threaded unless the SAB switch works)${SAB_SWITCH ? ' [+SharedArrayBuffer switch]' : ''}`);
  }

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media' || permission === 'persistent-storage') {
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

  // Show "starting" until the engine is genuinely ready. The tray used to read
  // "Ready" during this whole window while the hotkey did nothing.
  trayManager.setState('starting');

  // Register the global shortcut BEFORE awaiting the renderer load and engine
  // init. Those can take seconds (GPU probe) or, on a failed load, never
  // complete at all -- and the hotkey is the app's primary interaction, so its
  // registration must not be hostage to them. Presses that arrive early are
  // handled by the engineReady gate inside the handler.
  const ret = globalShortcut.register(appConfig.shortcut, () => {
    if (shortcutActive) {
      log('Global shortcut ignored (debounce active)');
      return;
    }

    // Explicit readiness flag, not inferred state. Before the engine resolves,
    // the renderer's selectedModel is still '' -- so it would NOT take its
    // "model not ready" branch and would instead start a recording routed to
    // the wrong (default) adapter, which then fails silently.
    if (!engineReady) {
      if (startupFailed) {
        // Startup is not "in progress" — it is over and it failed, with no
        // retry. Showing "Starting up..." here would erase the error state
        // (the only signal the user gets) and imply recovery that isn't
        // happening. Re-assert the error instead.
        log(`Global ${shortcutLabel} received but startup failed - staying in error state`);
        trayManager.setState('error');
        return;
      }
      log(`Global ${shortcutLabel} received before engine ready - ignoring`);
      trayManager.setState('starting');
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

  // Wait for the renderer to load before probing GPU via executeJavaScript.
  // Bounded: a failed or hung load must surface, not wedge startup forever.
  const loadResult = await waitForFirstLoad(hiddenWindow);
  if (!loadResult.ok) {
    startupFailed = true;
    rendererCrashCount++;
    log(`CRITICAL: hidden capture window failed to load (${loadResult.reason}). ` +
        `Recording is unavailable; engine init skipped. ` +
        `(load failures this session: ${rendererCrashCount}/${MAX_RENDERER_CRASHES})`);
    try { trayManager.setState('error'); } catch (_e) { /* ignore */ }
    // Unblock IPC handlers awaiting readiness so the popup/Settings can still
    // open and show an error rather than hanging on every invoke().
    engineManager.abortInitialization(loadResult.reason);
    return;
  }

  // Initialize engine manager (probes adapters, selects best one).
  // Resolves the engine-ready promise so awaiting IPC handlers proceed.
  // Push the engine record to every window on every change. Previously the
  // popup had no state channel at all and fabricated the status it displayed;
  // the renderer kept its own copy of "which model is selected" that could sit
  // 42 seconds stale. One writer in main, broadcast to all readers.
  engineManager.setStateBroadcaster((state) => {
    for (const win of [hiddenWindow, popupWindow, welcomeWindow]) {
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('engine:state', state); } catch (_e) { /* window going away */ }
      }
    }
  });

  const engineStatus = await engineManager.initializeAndSignalReady();
  log('EngineManager initialized: ' + JSON.stringify(engineStatus));

  engineReady = true;
  trayManager.setState('ready');
  log('MVP-Echo Toolbar: Engine ready');

  if (REPLAY_PATH) triggerReplay(REPLAY_PATH);
});

// Tray app: window-all-closed does NOT quit
app.on('window-all-closed', () => {
  // No-op - tray app stays alive
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Logging is async now, so anything queued during shutdown would be lost.
  flushSync();
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

// Copy to clipboard — VERIFIED. The completion bell must mean "text is on the
// clipboard", not just "writeText was called". Windows clipboard writes can fail
// under contention (another app holding it), so write, read back, and retry once;
// return real success so the renderer only rings the bell on a confirmed copy.
ipcMain.handle('copy-to-clipboard', async (_event, text) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      clipboard.writeText(text);
      if (clipboard.readText() === text) {
        return { success: true };
      }
    } catch (e) {
      log('Clipboard write error: ' + (e && e.message ? e.message : e));
    }
    await new Promise((r) => setTimeout(r, 60)); // brief backoff before retry
  }
  log('Clipboard write could NOT be verified after retries');
  return { success: false };
});

// Diagnostics: renderer asks whether deep capture is enabled (set by launch flag).
ipcMain.handle('diag:enabled', async () => DIAG_ENABLED);

// Diagnostics: renderer streams one structured fingerprint line per recording.
// Written to the dedicated diagnostics file only when enabled.
ipcMain.handle('diag:record', async (_event, line) => {
  if (!DIAG_ENABLED) return { success: false };
  try {
    fs.appendFileSync(diagPath, `[${new Date().toISOString()}] ${line}\n`);
    return { success: true };
  } catch (e) {
    return { success: false, error: e && e.message };
  }
});

// Diagnostics: persist the exact captured PCM (as WAV) so it can be played back —
// the ground-truth test for captured-fine vs sparse vs corrupted. Files land in a
// subfolder next to the diagnostics log; only written when diagnostics are on.
const diagAudioDir = path.join(os.tmpdir(), 'mvp-echo-audio');
// One WAV per recording with no cap was the only genuinely unbounded growth in
// the app: it survives restarts and the startup sweep never matched it (that
// looks for 'mvp-echo-audio-*.webm' loose in the temp ROOT, not .wav files in
// this subdirectory). Keep a rolling window of the most recent recordings —
// those are the ones being diagnosed.
const MAX_DIAG_AUDIO_FILES = 40;

function pruneDiagAudio() {
  try {
    const files = fs.readdirSync(diagAudioDir)
      .filter(f => f.endsWith('.wav'))
      .map(f => {
        const full = path.join(diagAudioDir, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime); // newest first
    for (const stale of files.slice(MAX_DIAG_AUDIO_FILES)) {
      try { fs.unlinkSync(stale.full); } catch (_e) { /* ignore */ }
    }
  } catch (_e) { /* ignore */ }
}

ipcMain.handle('diag:save-audio', async (_event, name, buf) => {
  if (!DIAG_ENABLED) return { success: false };
  try {
    if (!fs.existsSync(diagAudioDir)) fs.mkdirSync(diagAudioDir, { recursive: true });
    const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
    const bytes = Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf);
    // Async: these are multi-MB WAVs and a sync write blocks the whole main
    // process — tray, popup and every other IPC handler — for its duration.
    await fs.promises.writeFile(path.join(diagAudioDir, safe), bytes);
    pruneDiagAudio();
    return { success: true };
  } catch (e) {
    return { success: false, error: e && e.message };
  }
});

// Last-resort audio recovery: reload the hidden capture window when the renderer
// reports a wedged-and-unrecoverable audio pipeline. Reload resets the entire
// audio/WebGPU stack (the model re-loads from the local cache).
ipcMain.handle('capture:request-reload', async () => {
  // Destroy + recreate rather than reload(): a plain reload reuses the same
  // renderer/GPU process and inherits the wedged audio/device handles. A fresh
  // window fully resets the audio + WebGPU stack (model re-loads from cache).
  log('Capture window reload requested (wedged audio recovery) — destroying + recreating');
  try {
    if (hiddenWindow && !hiddenWindow.isDestroyed()) hiddenWindow.destroy();
  } catch (_e) { /* ignore */ }
  hiddenWindow = null;
  createHiddenWindow();
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

// App config get/set — generic key-value access to app-config.json.
// Reuses the same file as the shortcut config, with safe merge-on-write.
ipcMain.handle('app-config:get', async () => {
  return loadAppConfig();
});

ipcMain.handle('app-config:set', async (_event, updates) => {
  const configPath = path.join(app.getPath('userData'), 'app-config.json');
  try {
    const current = loadAppConfig();
    const next = { ...current, ...updates };
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
    log('App config updated: ' + JSON.stringify(next));
    return { success: true };
  } catch (e) {
    log('Failed to write app-config.json: ' + (e && e.message ? e.message : e));
    return { success: false, error: e && e.message };
  }
});

ipcMain.handle('welcome:close', async () => {
  if (welcomeWindow && !welcomeWindow.isDestroyed()) {
    welcomeWindow.close();
  }
  return { success: true };
});
