# D — Startup Sequencing Recon

Scope: `app/main/main-simple.js`, `app/main/tray-manager.js`, `app/stt/engine-manager.js`,
`app/stt/adapters/webgpu-bridge-adapter.js`, `app/preload/preload.js`,
`app/renderer/app/CaptureApp.tsx`, `package.json`. Read-only recon for Fixes 3 & 4 +
the `app.isPackaged` switch. No source files modified.

---

## 1. Startup dependency graph

Ordered as the code actually executes, module-load time through end of the
`whenReady()` callback.

| # | Step | file:line | Genuinely requires | Merely precedes |
|---|------|-----------|---------------------|------------------|
| 1 | Module-scope crash handlers (`uncaughtException`/`unhandledRejection`) | `main-simple.js:28-33` | Nothing — pure `process.on` registration | — |
| 2 | `clearLog()` | `main-simple.js:38` | Nothing | Everything after it that calls `log()` — incidental, `log()` doesn't check a "log ready" flag |
| 3 | Synchronous temp-file sweep | `main-simple.js:40-49` | Nothing (sync `fs.readdirSync`/`unlinkSync` on OS tmpdir) | Nothing downstream depends on it; it's a leftover-cleanup side effect, not a dependency |
| 4 | Single-instance lock (`requestSingleInstanceLock`) | `main-simple.js:100-114` | Must run before tray/window/IPC creation — a second instance must bail out before touching shared OS resources (tray icon slot, port, files) | Genuinely gates everything below it (module-scope `return` on failure at `:108`) |
| 5 | `app.whenReady()` | `main-simple.js:345` | Electron-internal readiness (browser process init) | Gates all `BrowserWindow`/`Tray` construction — Electron enforces this, not app logic |
| 6 | `loadAppConfig()` | `main-simple.js:347` | Nothing upstream; reads/creates `app-config.json` synchronously | Read by tray tooltip (`shortcutLabel`, step 8) and shortcut registration (step 12) — real dependency for those two, not for tray/window creation itself |
| 7 | `session.defaultSession.setPermissionRequestHandler` | `main-simple.js:354-360` | Nothing | Should genuinely precede any window that requests `media`/`persistent-storage` permission (hidden window's `getUserMedia`) — this is a **real** ordering requirement, currently satisfied incidentally because it's written before `createHiddenWindow()` |
| 8 | `trayManager.create(...)` | `main-simple.js:363-367` | `shortcutLabel` from step 6 (cosmetic — tooltip text only) | Nothing downstream requires the tray to exist first; tray creation is independent of hidden-window/engine chain |
| 9 | Welcome window show/skip | `main-simple.js:369-384` | `app.getVersion()`, `welcome-config.json` read | **Nothing else in the chain depends on this or waits for it** — fire-and-forget, runs in parallel with steps 10-15 in wall-clock terms (its own async `BrowserWindow`/`loadFile`) |
| 10 | `engineManager.setupIPC(...)` | `main-simple.js:389-392` | Nothing to have completed first; registers `ipcMain.handle` listeners | **True dependency for what comes after**: comment explicitly says this must run before `createHiddenWindow()` so the renderer's early `cloud:get-config` call doesn't hit an unregistered channel |
| 11 | `createHiddenWindow()` | `main-simple.js:396` (impl `:131-185`) | Step 10 (handlers registered) and step 7 (permission handler) | Not dependent on tray (step 8) or welcome window (step 9) — those are parallel-safe |
| 12 | `await` on `did-finish-load` | `main-simple.js:399-405` | Window object from step 11 to exist (`hiddenWindow.webContents`) | **This is the crux of Fix 4** — a bare promise with no `did-fail-load` and no timeout; a load failure (bad path, renderer crash pre-first-paint, missing `dist/renderer/index.html`) hangs the `whenReady()` callback forever. Nothing past this line ever runs. |
| 13 | `await engineManager.initializeAndSignalReady()` | `main-simple.js:409` (impl `engine-manager.js:87-141`) | Step 12 — needs a loaded renderer because `initialize()` → `webgpuAdapter.isAvailable()` → `_probeGpu()` calls `hidden.webContents.executeJavaScript(...)` (`webgpu-bridge-adapter.js:176-216`), which requires the page to have a DOM/JS context | Genuinely serial w.r.t. step 12. **Not** genuinely serial w.r.t. shortcut registration (step 14) — that's the point of Fix 3 |
| 14 | `globalShortcut.register(...)` | `main-simple.js:415-438` | Only `appConfig.shortcut` (step 6) and Electron being ready (step 5) | Currently placed after step 13 but has **no real dependency on it** — this is exactly the incidental-serialization Fix 3 targets |

**Genuinely serial chains:**
- Single-instance lock → everything (5)
- `whenReady()` → all window/tray creation (5 → 8/9/11)
- `setupIPC` → `createHiddenWindow` (10 → 11) — real, documented in-code
- `createHiddenWindow` → `did-finish-load` wait → `webgpuAdapter._probeGpu()` inside `initializeAndSignalReady()` (11 → 12 → 13) — real, GPU probe needs a live renderer JS context

**Only incidentally serial (safe to reorder/parallelize):**
- Welcome window (9) vs. hidden-window chain (10-13) — independent, already run without explicit sequencing between them (JS is single-threaded so they interleave via microtasks, but neither awaits the other)
- Tray creation (8) vs. hidden-window chain — independent
- `globalShortcut.register` (14) vs. `initializeAndSignalReady()` (13) — **only** incidentally serial; this is Fix 3's target
- Temp-file sweep (3) — has zero downstream readers; could run anywhere, or even be dropped to a background tick, without changing behavior

---

## 2. Is early shortcut registration safe?

Trace: `globalShortcut.register` handler → `hiddenWindow.webContents.send('global-shortcut-toggle')`
(`main-simple.js:415-438`) → preload bridges it 1:1 with **no queueing**:

```js
// preload.js:19-23
onGlobalShortcutToggle: (callback) => {
  ipcRenderer.removeAllListeners('global-shortcut-toggle');
  ipcRenderer.on('global-shortcut-toggle', callback);
  return () => ipcRenderer.removeAllListeners('global-shortcut-toggle');
},
```

→ consumed by `CaptureApp.tsx:428` inside a `useEffect` that only runs after React
mounts the hidden window's root component — which itself only happens after the
page's JS has executed post-`did-finish-load`. **Electron IPC does not queue
`webContents.send()` when there's no listener yet — the message is simply lost.**

### (a) Shortcut fires before the hidden window exists
Already guarded: `main-simple.js:425` — `if (hiddenWindow && !hiddenWindow.isDestroyed())`.
`shortcutActive` debounce still sets/resets. **Safe today, no corruption** — just a
silently-dropped keypress. Nothing to fix here.

### (b) Window exists, but before `did-finish-load` / before React mounts `CaptureApp`
`hiddenWindow.webContents.send(...)` fires into a page that either has no JS
context yet or hasn't reached the `useEffect` that calls `api.onGlobalShortcutToggle`.
**The IPC message is silently dropped** (no listener registered on the renderer
side yet). Result: user presses the hotkey, sees no reaction — tray icon doesn't
change (tray state is renderer-driven via `updateTrayState`, main never sets a
"recording" state itself), no error, no log entry on the renderer side (main does
log "detected" and "sending to hidden window", but that's not user-visible).
**Nothing is corrupted — it's a UX gap (dropped input), not a state-corruption
risk**, because `shortcutActive` still resets after 500ms and no capture/engine
state was ever touched.

### (c) Loaded and listener registered, but engine not yet ready
This is the actual target case for Fix 3. Trace what `CaptureApp`'s handler does
(`CaptureApp.tsx:428-524`) when it fires this early:

- `selectedModelRef.current` is still `''` (its initial value) — the config load
  that would populate it is itself gated behind `engineManager._readyPromise`:
  ```js
  // engine-manager.js:422-431
  ipcMain.handle('cloud:get-config', async () => {
    await this._readyPromise;
    const adapterConfig = this.activeAdapter.getConfig();
    return { ...adapterConfig, selectedModel: this.selectedModelId };
  });
  ```
- Because `selectedModelRef.current` is `''`, the `startsWith('webgpu-')` guard at
  `CaptureApp.tsx:454` is **false**, so the "ignoring shortcut — WebGPU model not
  ready" branch is **skipped**. Execution falls through to the "Start Recording"
  branch (`:475-524`).
- `orchestratorRef.current.isReady()` is also false (nothing loaded yet), so
  `useRawPcm = false` → it takes the **standard MediaRecorder + IPC path**, which
  on stop calls `electronAPI.processAudio(...)` → `ipcMain.handle('processAudio', ...)`
  → `engineManager.processAudio()` → `this.activeAdapter.transcribe(...)`.
- `activeAdapter` at this point is still the constructor default, `this.remoteAdapter`
  (`engine-manager.js:45`), because `initialize()` hasn't run yet to potentially
  reassign it to `webgpuAdapter`. If remote isn't configured, `transcribe()` fails;
  `processAudio` catches it and returns `{ success: false, ... }`
  (`engine-manager.js:263-271`), and `CaptureApp` shows the `error` tray state then
  reverts to `ready` after 3s (`CaptureApp.tsx:383-386`).

**What breaks:** not corruption, but a **wasted/confusing recording** — the app
records real microphone audio, silently routes it to the wrong (default/remote)
adapter instead of the user's actually-configured one, and then fails. The user
gets an "error" flash with no explanation, and if remote *is* reachable, they could
get a transcription result via the wrong engine while local WebGPU is still
warming up — inconsistent behavior, not a crash.

### Recommended guard
The handler needs an explicit **engine-readiness signal**, not an inference from
`selectedModelRef`/`orchestratorRef` (both are unreliable before config load
resolves). Concretely:
1. Add a `mainReady`/`engineReadyRef` boolean in `CaptureApp`, default `false`.
2. Have main emit an event (e.g. `webContents.send('engine-ready')`) at the point
   `initializeAndSignalReady()` resolves (`main-simple.js:409-410`), or have the
   renderer learn it via the already-existing `cloud:get-config` handler's await on
   `_readyPromise` (i.e., don't allow "Start Recording" until that first config
   load has completed at least once).
3. At the very top of the `onGlobalShortcutToggle` callback (`CaptureApp.tsx:429`),
   add: `if (!engineReadyRef.current) { show "still starting" tray state; return; }`
   — before the existing `isProcessingRef.current || isStartingRef.current` check,
   since neither of those is true during early startup and wouldn't otherwise catch
   this case.

This also incidentally fixes case (b) for presses that land *after* the listener
registers but the guard flag is naturally `false` until real config resolves — no
separate fix needed for (b) beyond what's already safe-by-default (dropped, not
corrupting).

---

## 3. Where does "still starting" live?

`tray-manager.js:11-17` — `STATES` is a flat map, and `setState()` **silently
no-ops on an unknown key**:

```js
// tray-manager.js:92-93
setState(state) {
  if (!this.tray || !STATES[state]) return;
```

No existing state fits semantically — `ready` implies fully operational,
`processing`/`recording` are mid-transcription lifecycle states owned entirely by
the renderer, `error` is transient (auto-reverts are all renderer-driven via
`setTimeout(() => updateTrayState('ready'), ...)`). Reusing `error` for "still
starting" would be misleading (it's not an error) and would collide with the
renderer's own error-flash-then-revert pattern, causing the tray to bounce between
two different logical meanings under the same visual.

**A new state is needed.** Concretely: add a `starting` entry to `STATES` in
`tray-manager.js:11-17`, e.g. `{ icon: 'tray-starting.png', tooltip: 'MVP-Echo -
Starting…' }`.

**Icon assets:** `app/main/icons/` currently has exactly 5 PNGs — `tray-ready.png`,
`tray-recording.png`, `tray-processing.png`, `tray-done.png`, `tray-error.png` —
one per existing `STATES` key, no spare/unused icon to repurpose. **Adding a
`starting` state requires a new icon.** `scripts/generate-tray-icons.js:1-26`
generates all 5 from a `STATES` color map (`ready:#4285f4`, `recording:#ea4335`,
`processing:#f57c00`, `done:#34a853`, `error:#9aa0a6`) by rasterizing the same SVG
path used on the welcome screen, at 32×32. Adding a 6th color entry there and
re-running the script is the correct way to generate `tray-starting.png` — but
**this script is not wired into any npm script** in `package.json` (confirmed —
no `scripts` entry references it), so it must be run manually
(`node scripts/generate-tray-icons.js`) and the output PNG committed. There's a
real risk of it going stale/forgotten since nothing enforces re-running it.

---

## 4. Bounded-wait design for Fix 4

Current code, the exact target:
```js
// main-simple.js:398-405
// Wait for the renderer to load before probing GPU via executeJavaScript.
await new Promise((resolve) => {
  if (hiddenWindow.webContents.isLoading()) {
    hiddenWindow.webContents.once('did-finish-load', resolve);
  } else {
    resolve();
  }
});
```

**Timeout value:** recommend **15 seconds**. Rationale: this is a local
`loadFile`/`loadURL` of bundled assets (or, in dev, a local Vite dev server on
`localhost:5175`) — not a network fetch to a remote host. It should resolve in low
hundreds of ms under normal conditions. 15s gives generous headroom for a
slow/loaded machine or antivirus-scanned first read of the unpacked asar, while
still being short enough that a genuinely broken load (missing `dist/renderer`,
crashed renderer pre-paint) doesn't leave the user staring at a "Starting…" tray
indefinitely. This is independent of, and much shorter than, the 60s
processing-safety-timeout and 25s start-watchdog already used elsewhere in this
codebase (`CaptureApp.tsx:271-276`, `:498-503`) — those bound *user-triggered*
operations; this bounds a *one-time startup* operation and should fail fast.

**Resolve vs. reject:** **resolve with a status flag** (e.g. `{ ok: true }` /
`{ ok: false, reason: 'timeout' | 'did-fail-load', detail }`), not reject. A
rejected promise from an unhandled `await` would either need a `try/catch`
wrapper anyway (equivalent complexity) or would hit the global
`unhandledRejection` handler (`main-simple.js:31-33`), which only logs — it
wouldn't itself drive the tray to an error state. Resolving with a status object
lets the caller branch explicitly and is more idiomatic for "wait up to N seconds,
tell me what happened" than throwing.

**What happens to the rest of the startup chain on failure:** engine init should
**not** be attempted if the load never finished — `initializeAndSignalReady()`
calls `webgpuAdapter.isAvailable()` → `_probeGpu()` →
`hidden.webContents.executeJavaScript(...)` (`webgpu-bridge-adapter.js:176-216`),
which requires a live JS context in the page; running it against a
never-finished-loading or crashed page will itself hang or throw. On timeout/fail,
skip straight to: set tray to the new `error`/failed state, log it, and — per the
existing recovery pattern used for `render-process-gone`
(`main-simple.js:172-184`) — consider destroying and recreating `hiddenWindow`
once (bounded, not a loop) so a transient failure has a chance to self-heal on the
next hotkey press or a future retry path. Global shortcut registration (Fix 3,
now decoupled) should still proceed regardless, so the hotkey handler exists to
show the "still starting"/error state rather than doing nothing.

**Surfacing to a user with no console:** the tray icon/tooltip is the only UI
surface available before any window is shown (welcome window is dismissible/
version-gated; popup is lazy-created on first click). Reuse (or extend) the
`error` tray state — set via `trayManager.setState('error')` — with a tooltip
override describing the failure (e.g. "MVP-Echo - Startup failed, click to
retry"), consistent with how `render-process-gone` already resets the tray on
renderer death (`main-simple.js:175`: `trayManager.setState('ready')` — note this
existing path resets to **ready**, not **error**, on renderer crash, which is
itself worth flagging: a crashed-and-not-yet-recovered hidden window currently
shows "Ready" while actually broken until `createHiddenWindow()`'s async
recreation completes).

**Interaction with the existing crash-budget mechanism:** found at
`main-simple.js:120-121` and used in `render-process-gone`:
```js
// main-simple.js:120-121
let rendererCrashCount = 0;
const MAX_RENDERER_CRASHES = 3;
```
```js
// main-simple.js:172-184
hiddenWindow.webContents.on('render-process-gone', (_event, details) => {
  log(`CRITICAL: Hidden window renderer gone! reason=${details.reason}, exitCode=${details.exitCode}`);
  try { trayManager.setState('ready'); } catch (_e) {}
  if (++rendererCrashCount > MAX_RENDERER_CRASHES) {
    log('Renderer crash loop detected — not recreating hidden window');
    return;
  }
  if (hiddenWindow && !hiddenWindow.isDestroyed()) hiddenWindow.destroy();
  hiddenWindow = null;
  createHiddenWindow();
});
```
This only fires on an OS-level renderer-process death (GPU crash, OOM-kill,
sandbox violation) — a *different* failure mode than "page loaded slowly" or
"page returned a network/file error via `did-fail-load`" (bad HTML, 404, ENOENT).
A `did-fail-load` during the *initial* load is not a `render-process-gone` event
and won't touch `rendererCrashCount` at all today. **Recommendation:** route the
new Fix-4 failure path (timeout or `did-fail-load`) through the *same*
`rendererCrashCount`/`MAX_RENDERER_CRASHES` budget before recreating the window,
so a startup-load failure and a later runtime crash share one counter — otherwise
a repeatedly-failing initial load could recreate the window unboundedly (no cap
currently exists on the Fix-4 path since it doesn't exist yet), independent of
the existing runtime-crash cap.

---

## 5. `app.isPackaged` switch — verify correctness at each call site

`app.isPackaged` is a synchronous, readonly boolean (`node_modules/electron/electron.d.ts:1843`)
computed from the executable path at Electron init — **it does not require
`app.whenReady()`** and is safe to read at any point after the `electron` module
loads. All three call sites already run *after* `app.whenReady()` resolves (they're
invoked from inside the `.then(async () => {...})` callback or from functions it
calls), so there is **no availability/timing problem** at any of the three sites:

- `main-simple.js:149` (`createHiddenWindow`, called at `:396`)
- `main-simple.js:216` (`createPopupWindow`, called lazily from `togglePopup`/IPC — still post-ready)
- `main-simple.js:326` (`showWelcomeWindow`, called at `:383`, inside the same `whenReady` callback)

**Does it break `npm run dev` / `dev:electron`?** No. Inner `package.json`:
```json
"dev:electron": "NODE_ENV=development electron --no-sandbox --ozone-platform-hint=auto app/main/main-simple.js"
```
This runs Electron directly against the source tree (unpackaged) — `app.isPackaged`
is `false` here, same truthiness as today's `NODE_ENV === 'development'` check, so
the dev-server branch (`hiddenWindow.loadURL('http://localhost:5175/...')`, etc.)
is still taken. **`npm run dev` is not broken by the switch.**

**What *is* at risk:** the inner `package.json`'s `"start": "electron ."` script
(`package.json:13`). This runs Electron **unpackaged** (no `NODE_ENV` set) against
the built `dist/renderer/` output — today it correctly hits the `else` branch
(`NODE_ENV !== 'development'`) and loads the built files via `loadFile`, which
work because `dist/renderer/{index,popup,welcome}.html` already exist in this repo
(verified: `dist/renderer/` contains `index.html`, `popup.html`, `welcome.html`,
`assets/`). Under a blind switch to `app.isPackaged`, `electron .` is **still
unpackaged** (`isPackaged === false`, identical to dev), so it would flip to the
dev-server branch and try to load `http://localhost:5175/...` — which is **not
running** in this workflow (no Vite server started by `npm start`). This would
silently blank/break `npm start` (root `package.json` also has an equivalent
`"start": "electron ."` at the outer level, same risk).

**Proposed condition:** don't switch to bare `app.isPackaged` — use
`app.isPackaged || process.env.NODE_ENV !== 'development'` as the "serve from
`dist/`" condition (i.e., invert: treat *dev-server* mode as the opt-in case,
requiring `NODE_ENV === 'development'` explicitly, and treat everything else —
packaged **or** unpackaged-without-the-dev-flag — as "load from `dist/`"). Concretely:
```js
if (!app.isPackaged && process.env.NODE_ENV === 'development') {
  hiddenWindow.loadURL('http://localhost:5175/index.html');
} else {
  hiddenWindow.loadFile(htmlPath);
}
```
This is strictly safer than either single-signal check alone: `dev:electron` still
sets `NODE_ENV=development` so it keeps hitting the dev-server branch; `npm start`
and the packaged app both fall through to `loadFile` as they do today.
(If `npm start`/root-`start` is confirmed dead/unused, the simpler
`app.isPackaged` swap would be fine — but nothing in the repo marks it deprecated,
and it wasn't found referenced in any doc/CI/workflow file, so treat it as a live
but easily-missed regression surface rather than assume it's safe to ignore.)

---

## 6. Testability — what's verifiable headless (Linux dev box) vs. Windows-only

**No test infrastructure exists**: no `*.test.js`/`*.spec.js` files anywhere in the
repo, no `jest`/`vitest`/`mocha` in `package.json`, `"test": "echo \"No tests
yet\""` (both inner and outer `package.json`).

**Requiring `main-simple.js` in a plain Node harness does not work out of the box.**
`require('electron')` outside the Electron runtime resolves to the npm shim
(`node_modules/electron/index.js`), which exports a **string** (path to the
Electron binary) via `module.exports = getElectronPath()` — not an object with
`app`/`BrowserWindow`/etc. Confirmed directly:
```
$ node -e "console.log(typeof require('electron'))"
string
```
So `const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, clipboard } = require('electron')`
(`main-simple.js:1`) would destructure a string and yield `undefined` for every
binding; the very next line to touch `app` (`app.requestSingleInstanceLock()` at
`:100`) throws immediately. **This means ordering assertions on the real
`main-simple.js` require a module-resolution stub** — e.g. pre-populating
`require.cache` for the resolved `electron` path with a fake module (a plain JS
object exposing mock `app`, `BrowserWindow`, `Tray`, `nativeImage`,
`globalShortcut`, `ipcMain`, `session`, `clipboard`, `screen`) before
`require()`-ing `main-simple.js`, or running under a lightweight Electron-mock
package. This is straightforward to build (the surface area used is small and
already enumerated by the `require` at the top of the file) but does not exist
today — it would be new test-harness code, not something runnable as-is.

**What actually *is* runnable headless today, evidenced by the repo:**
`dev:electron` already passes `--no-sandbox --ozone-platform-hint=auto`
(`package.json`), which are exactly the flags needed to get Electron's Chromium
to start on a headless/no-GPU Linux box (`--ozone-platform-hint=auto` lets it fall
back to a software/headless Ozone backend without a real display server, and
`--no-sandbox` avoids the Linux sandbox setup that often needs root/setuid helpers
not present on CI-like boxes). This strongly suggests **real headless dev-mode
launches of the full Electron app have been exercised on this Linux box before** —
i.e., `npm run dev` itself is plausibly runnable here for manual/observational
verification (log-timestamp ordering via `log()`/`getLogPath()`), even though no
automated harness wraps it. `FIX-PLAN.md:146` independently proposes exactly this:
"(S) ordering in source + (H) log-timestamp assertion: registration ts < engine-ready
ts" as a verification method for Fix 3.

**Verifiable here (headless Linux), without a Windows machine:**
- Static ordering/logic review of `main-simple.js`/`tray-manager.js`/`engine-manager.js`
  (this document).
- A stubbed-`electron` Node harness asserting **call order** (e.g. spy on
  `globalShortcut.register` vs. `EngineManager.prototype.initializeAndSignalReady`
  timestamps) — buildable now, not present yet.
- Launching the real app via `npm run dev` (Vite + Electron, `--no-sandbox
  --ozone-platform-hint=auto`) and reading `log()` output / `getLogPath()` for
  actual timestamp ordering of "shortcut registered" vs. "Engine ready" — real
  execution evidence, not a mock.
- WebGPU/GPU-adapter behavior *inside* that headless Electron: uncertain — depends
  on whether the CI/dev box's Mesa/software GPU stack exposes a `navigator.gpu`
  adapter under Ozone headless mode; would need an actual run to confirm (`_probeGpu()`
  may legitimately return `available: false` headless, which is a valid signal to
  test the *fallback* path but not the true-positive GPU path).
- Tray icon/state changes: `Tray`/`nativeImage` construction can run headless
  (Electron doesn't require a real system tray to construct the objects on Linux,
  though visually verifying the icon requires a desktop environment) — the
  `setState()` no-op-on-unknown-key logic (`tray-manager.js:92-93`) is pure and
  fully unit-testable without Electron at all if extracted, or testable via the
  stub harness above.

**Needs an actual Windows machine (or at minimum a real Windows-like desktop session):**
- Visual confirmation of the new tray icon/tooltip rendering correctly in the
  Windows system tray (icon scaling, tooltip truncation, taskbar overflow menu
  behavior).
- Real global-hotkey registration semantics — `globalShortcut.register` conflicts
  with other apps, OS-level accelerator quirks, and whether `Ctrl+Alt+Z` is
  intercepted by any other running software are Windows-specific and not
  reproducible on Linux.
- Real GPU adapter probing via `navigator.gpu.requestAdapter()` against actual
  Windows GPU drivers (the CUDA/DirectX path this app targets) — headless Linux
  Mesa software rendering is not representative.
- The actual `did-fail-load`/timeout failure path under real-world conditions
  (e.g., AV-scanner-locked asar, antivirus quarantining a file, actual disk I/O
  latency on a fresh install) — can be *simulated* cross-platform (point
  `loadFile` at a nonexistent path to force `did-fail-load`) but the realistic
  failure triggers are Windows-installer-specific.
