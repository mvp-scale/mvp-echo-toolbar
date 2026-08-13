# Architectural Review — Main Process, Window & Tray Lifecycle

Scope: `app/main/main-simple.js`, `app/main/tray-manager.js`, `app/main/logger.js`,
`scripts/generate-tray-icons.js`, `app/renderer/{index,popup,welcome}.html`
(plus `app/stt/engine-manager.js` and `app/renderer/app/CaptureApp.tsx` consulted
only to verify claims made about main-process code).

---

### [P1] Global shortcut registration is blocked behind full engine/GPU initialization
- **Where:** `app/main/main-simple.js:396-438`
- **What:** `globalShortcut.register()` only runs after `await engineManager.initializeAndSignalReady()` resolves. `initializeAndSignalReady()` calls `initialize()`, which awaits `webgpuAdapter.isAvailable()` — a WebGPU adapter probe executed inside the hidden renderer (`app/stt/engine-manager.js:87-101`). Until that completes, Ctrl+Alt+Z is not registered at all.
- **Evidence:**
  ```js
  const engineStatus = await engineManager.initializeAndSignalReady();
  log('EngineManager initialized: ' + JSON.stringify(engineStatus));
  log('MVP-Echo Toolbar: Engine ready');

  // Register global shortcut (configurable)
  const ret = globalShortcut.register(appConfig.shortcut, () => { ... });
  ```
- **Impact:** This directly reproduces the app's known startup-sluggishness symptom (see project memory: eager WebGPU model load at mount): the tray icon appears and looks "ready", but the primary interaction (global hotkey) is silently dead until GPU probing + model bookkeeping finishes. There is no tray state or notification telling the user the shortcut isn't live yet — pressing it early just does nothing.
- **Fix:** Register `globalShortcut` immediately in `whenReady()`, before awaiting engine init. If the engine isn't ready when the shortcut fires, have the handler show a "still starting up" tray/popup state instead of silently no-op'ing.

### [P1] `whenReady()` chain hangs forever if the hidden window's page fails to load
- **Where:** `app/main/main-simple.js:399-405`
- **What:** The startup chain awaits a bare `Promise` that only resolves on `did-finish-load`. There is no `did-fail-load` handler and no timeout.
- **Evidence:**
  ```js
  await new Promise((resolve) => {
    if (hiddenWindow.webContents.isLoading()) {
      hiddenWindow.webContents.once('did-finish-load', resolve);
    } else {
      resolve();
    }
  });
  ```
- **Impact:** If `dist/renderer/index.html` is missing/corrupt or the dev server isn't up (`NODE_ENV=development` path loads `http://localhost:5175/index.html`), this promise never resolves. Engine init and `globalShortcut.register()` (lines 407-438) never run. The tray icon exists and *looks* functional, but recording is completely dead with zero error surfaced to the user or the log.
- **Fix:** Add a `did-fail-load` listener that rejects/resolves with an error, and a timeout (e.g. 15s) that logs a hard failure and puts the tray into a visible `error` state via `trayManager.setState('error')`.

### [P2] Renderer `console.error`/`console.warn` are unconditionally forwarded to a synchronous main-process disk write
- **Where:** `app/main/logger.js:12-33`, `app/main/main-simple.js:604-606`, `app/renderer/app/CaptureApp.tsx:151-163`
- **What:** `log()` uses `fs.appendFileSync` on every call, plus an occasional synchronous full-file `readFileSync`/`writeFileSync` rewrite when the 5MB cap is hit. The renderer patches `console.error`/`console.warn` (not gated by the `--diag` flag, unlike `console.log`) to call `ipcMain.handle('debug:renderer-log', ...)` on every invocation, which calls `log()`.
  ```js
  // CaptureApp.tsx
  console.error = (...args: any[]) => {
    origError(...args);
    if (ipc) ipc.invoke('debug:renderer-log', 'ERROR: ' + args.map(String).join(' ')).catch(() => {});
  };
  ```
  ```js
  // logger.js
  function log(message) {
    ...
    fs.appendFileSync(logPath, logMessage);
  }
  ```
- **Impact:** Every renderer warning/error triggers a synchronous disk write on the main process, which blocks the Node event loop for the whole app (tray clicks, IPC handlers, popup show/hide) for the duration of that write. A burst of renderer warnings/errors (e.g. a retry loop in the audio pipeline) turns into a burst of blocking main-thread I/O, independent of whether diagnostics are enabled.
- **Fix:** Make `log()` asynchronous (`fs.appendFile` / a small write queue), and/or debounce or rate-limit `debug:renderer-log` forwarding from the renderer.

### [P2] Synchronous full-temp-directory sweep runs before the single-instance-lock check
- **Where:** `app/main/main-simple.js:40-49` (executes before the lock check at `main-simple.js:100-109`)
- **What:** At module load — before `app.requestSingleInstanceLock()` is even checked — the code synchronously lists the *entire* OS temp directory and unlinks matches.
  ```js
  const tmpDir = os.tmpdir();
  const orphans = fs.readdirSync(tmpDir).filter(f => f.startsWith('mvp-echo-audio-') && f.endsWith('.webm'));
  if (orphans.length > 0) {
    orphans.forEach(f => {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch (_e) { /* ignore */ }
    });
  }
  ```
- **Impact:** On a machine with a large/heavily-used temp directory, `readdirSync` over the whole OS temp folder (not an app-specific subfolder) is a real, unbounded sync cost paid on *every* launch attempt — including a second-instance launch that is about to immediately `app.quit()` a few lines later. This adds avoidable synchronous I/O to the critical startup path, compounding the known slow-startup complaint.
- **Fix:** Move this sweep to run only after the single-instance-lock check succeeds, move it off the synchronous API (`fs.promises.readdir`/`unlink`), and/or scope temp files into an app-specific subdirectory (as is already done for diagnostics audio, see `diagAudioDir` at line 506) so the app never has to scan the shared system temp root.

### [P2] `countdown:update` IPC handler can hang indefinitely with no timeout
- **Where:** `app/main/main-simple.js:568-592`
- **What:** If the popup window doesn't exist yet, the handler creates it and awaits `ready-to-show` with no failure path.
  ```js
  if (!popupWindow || popupWindow.isDestroyed()) {
    createPopupWindow();
    await new Promise((resolve) => popupWindow.once('ready-to-show', resolve));
  }
  ```
- **Impact:** If `dist/renderer/popup.html` fails to load, `ready-to-show` never fires, and this `ipcMain.handle` invocation never resolves. Since the renderer's countdown UI drives this via `invoke()`, the calling code in the hidden window is left awaiting a promise that never settles, which can wedge the recording-countdown flow (the exact class of "alive but dead" state the code comments elsewhere say they're trying to avoid for the tray).
- **Fix:** Add a timeout (e.g. `Promise.race` with a few-second reject) and return `{ success: false }` on failure instead of hanging.

### [P2] `diag:save-audio` / `diag:record` do synchronous fs writes of audio buffers on the main process
- **Where:** `app/main/main-simple.js:493-517`
- **What:** Both diagnostics IPC handlers use `fs.appendFileSync` / `fs.writeFileSync` directly inside `ipcMain.handle`, including writing a full WAV buffer synchronously.
  ```js
  ipcMain.handle('diag:save-audio', async (_event, name, buf) => {
    if (!DIAG_ENABLED) return { success: false };
    try {
      if (!fs.existsSync(diagAudioDir)) fs.mkdirSync(diagAudioDir, { recursive: true });
      const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
      fs.writeFileSync(path.join(diagAudioDir, safe), Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf));
      return { success: true };
    } ...
  });
  ```
- **Impact:** Only reachable when `--diag`/`MVP_DEBUG=1` is set, but when active, every recording blocks the entire main process (tray, popup, all other IPC) for the duration of the synchronous write of a multi-second PCM/WAV buffer. This directly fights the purpose of a diagnostics tool meant to observe the app without perturbing its behavior.
- **Fix:** Switch to `fs.promises.writeFile`/`appendFile`.

### [P2] Overly permissive CSP contradicts the app's "audio never leaves the machine" privacy claim
- **Where:** `app/renderer/index.html:5`, `app/renderer/popup.html:5`, `app/renderer/welcome.html:5`
- **What:** All three renderer documents ship `connect-src *` (unrestricted network egress) plus `script-src 'self' 'unsafe-inline' 'unsafe-eval'`.
  ```html
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; worker-src 'self' blob:; connect-src *; media-src *; img-src 'self' data: blob:;" />
  ```
- **Impact:** `connect-src *` means any script that manages to execute in these renderers (via a dependency compromise or a bug reachable through `unsafe-eval`) can send data to any origin with no CSP-level restriction — directly at odds with the product's core privacy promise ("audio never leaves the machine", per project docs). `welcome.html` in particular has no legitimate reason to allow any outbound `connect-src` at all; it's a static local UI.
- **Fix:** Scope `connect-src` to the actual required origins (e.g. `'self'` plus whatever CDN/HF host the WebGPU model loader needs, if any — or `'none'` for `welcome.html`). If `unsafe-eval` is required by the WebGPU/wasm inference stack, keep it only on `index.html`, not on `popup.html`/`welcome.html` which don't run inference.

### [P3] Welcome window is created eagerly during the same startup window as engine/GPU init
- **Where:** `app/main/main-simple.js:381-384` (inside `app.whenReady().then()`, before `createHiddenWindow()`/engine init at lines 396-410)
- **What:** `showWelcomeWindow()` spins up a full additional `BrowserWindow` + renderer bundle unconditionally on every launch where the current version hasn't been dismissed, concurrently with the hidden window's WebGPU probe/model load.
- **Impact:** Adds an extra Chromium renderer process's worth of startup cost (JS bundle parse/execute, layout) competing for CPU/disk with the GPU-adapter probe that already gates the shortcut (see P1 finding above), on every fresh-install or post-update launch — exactly the moments when first impressions of startup speed matter most.
- **Fix:** Defer `showWelcomeWindow()` slightly (e.g. after engine init resolves, or via `setImmediate`) so it doesn't compete with the critical path that gates shortcut registration.

### [P3] `app-config:set` silently accepts a `shortcut` update with no live re-registration path
- **Where:** `app/main/main-simple.js:415-438` (registration) vs. `main-simple.js:647-659` (`app-config:set`)
- **What:** `app-config:set` is a generic merge-and-write handler with no key-specific handling; it happily persists a new `shortcut` value, but `globalShortcut.register()` only ever runs once, in `whenReady()`.
  ```js
  ipcMain.handle('app-config:set', async (_event, updates) => {
    const configPath = path.join(app.getPath('userData'), 'app-config.json');
    const current = loadAppConfig();
    const next = { ...current, ...updates };
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
    ...
  });
  ```
- **Impact:** Not currently reachable from the UI — `SettingsPanel.tsx` only calls `app-config:set` with `micReadinessMode`/`micIdleReleaseMs` today (verified by grep), so this is latent, not a live bug. But the handler's generality invites a future "change your hotkey" settings feature to be added and silently not take effect until restart, with no error returned to indicate why. `UNVERIFIED` as a live defect — flagging as a trap for future work.
- **Fix:** Either narrow `app-config:set` to the keys it's meant for, or add shortcut-specific handling that calls `globalShortcut.unregisterAll()` + re-registers when `updates.shortcut` is present.

### [P3] Tray icon generator is not wired into any build/dev script
- **Where:** `scripts/generate-tray-icons.js` (whole file); confirmed via `grep -rn "generate-tray-icons" package.json app/main` returning only the comment reference in `tray-manager.js:4`
- **What:** `scripts/generate-tray-icons.js` rasterizes the mic glyph from hardcoded SVG path constants (`MIC_BODY`, `MIC_CRADLE` at lines 131-133) that duplicate path data also present in `app/renderer/app/components/WelcomeScreen.tsx`. The script is not referenced by any `npm run` script in `package.json`.
- **Impact:** The five PNGs in `app/main/icons/` are committed static assets generated by hand at some point in the past. If the welcome-screen mic glyph is ever redesigned, nothing forces the tray icons to be regenerated to match — they will silently drift out of visual sync with the rest of the app's branding.
- **Fix:** Add an `npm run icons` script wired to this file, and consider a CI check (or a comment at the top of `WelcomeScreen.tsx`) noting the duplication so a future edit to one path updates the other.

---

## Architecture assessment

- **The startup critical path is a single linear chain with no fan-out and no timeouts.** Tray creation → welcome window → hidden window creation → wait-for-load → engine/GPU init → shortcut registration all happen serially inside one `whenReady().then()`, and two of the awaited steps (`did-finish-load`, and separately `ready-to-show` in the countdown handler) have no failure path. The result is that the app's core feature (global-shortcut recording) has its readiness fully coupled to GPU/model probing, with no independent "shortcut works even if the engine is still warming up" mode and no visible degraded state if any step never completes.
- **Main-process I/O is synchronous by default and shared across all consumers.** `logger.js` and the diagnostics IPC handlers all use `*Sync` fs calls, and the logger is on the hot path for renderer console forwarding (`console.error`/`console.warn`, unconditionally). Because Electron's main process is single-threaded, this makes tray/popup responsiveness hostage to disk I/O latency triggered by renderer-side logging that main-process code doesn't control the volume of.
- **No consistent "what if this window/lifecycle event never happens" story.** Some paths handle it (renderer crash recovery via `render-process-gone` with a crash budget is well done), but the load-side equivalent (`did-fail-load`) is absent everywhere it would matter (hidden window boot, popup on-demand creation), producing silent-hang failure modes rather than a visible `error` tray state.
- **State ownership is otherwise good and worth preserving**: the comment at `main-simple.js:535-541` documents a real prior bug (dueling main-side/renderer-side timers desyncing tray state) and the fix — making the renderer the single authority for recording lifecycle and the tray a pure reflection — is the right architecture and should be the template applied to the load-failure gaps above, not re-litigated.
- **Config and lifecycle wiring is more permissive than it needs to be**: `app-config:set` is a raw merge-and-persist with no per-key validation or live-apply hooks, which is fine today only because the renderer doesn't yet exercise the gap (see P3 shortcut finding).
