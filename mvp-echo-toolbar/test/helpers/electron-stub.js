/**
 * Minimal `electron` module stub for headless Node tests.
 *
 * Main-process modules (`app/stt/*`, `app/main/logger.js`) do
 * `require('electron')` at load time. Outside the Electron runtime that
 * resolves to a *path string*, so `app.getPath(...)` throws. Injecting a stub
 * into `require.cache` before those modules load lets them run under plain
 * `node --test` with **zero production-code changes**.
 *
 * Must be called before requiring anything that pulls in `electron`.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * Install the stub. Returns the temp userData dir so tests can inspect or
 * clean up any config files the adapters write.
 */
function installElectronStub() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-echo-test-'));

  const stub = {
    app: {
      getPath: (name) => (name === 'userData' ? userData : os.tmpdir()),
      getVersion: () => '0.0.0-test',
      isPackaged: false,
      on: () => {},
      whenReady: () => Promise.resolve(),
    },
    // Adapters register IPC handlers at setupIPC() time, not construction —
    // but keep these no-ops so an accidental call can't blow up a test.
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
    BrowserWindow: class {},
    globalShortcut: { register: () => true, unregisterAll: () => {} },
    clipboard: { writeText: () => {} },
    Tray: class {},
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  };

  require.cache[require.resolve('electron')] = {
    id: require.resolve('electron'),
    filename: require.resolve('electron'),
    loaded: true,
    exports: stub,
  };

  return { userData, stub };
}

/**
 * Silence `app/main/logger.js` so test output stays pristine. The logger
 * writes to the real OS temp dir and console.logs every line; neither is
 * wanted in a test run.
 */
function silenceLogger() {
  const loggerPath = require.resolve('../../app/main/logger.js');
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { log: () => {}, clearLog: () => {}, getLogPath: () => '/dev/null' },
  };
}

module.exports = { installElectronStub, silenceLogger };
