# IPC Contract, Preload Bridge & Electron Security Model — Review

Scope: `app/preload/preload.js`, `app/main/main-simple.js`, `app/stt/engine-manager.js` (IPC
handlers live here too), `app/renderer/app/**` (all IPC call sites), `app/main/tray-manager.js`,
`app/main/logger.js`, `app/stt/adapters/webgpu-bridge-adapter.js` (executeJavaScript site).

## Channel inventory

| Channel | Preload? | Handled in main? | Called from renderer? | Note |
|---|---|---|---|---|
| `start-recording` | yes — `preload.js:8` | yes — `main-simple.js:458` | yes — `CaptureApp.tsx:480` | |
| `stop-recording` | yes — `preload.js:9` | yes — `main-simple.js:463` | yes — `CaptureApp.tsx:258` | |
| `processAudio` | yes — `preload.js:10` | yes — `engine-manager.js:472` | yes — `CaptureApp.tsx:377` | camelCase, breaks naming convention |
| `copy-to-clipboard` | yes — `preload.js:13` | yes — `main-simple.js:472` | yes — `CaptureApp.tsx:329,389`, `PopupApp.tsx:139` | |
| `tray:update-state` | yes — `preload.js:16` | yes — `main-simple.js:542` | yes — `CaptureApp.tsx` (many) | |
| `global-shortcut-toggle` (event) | yes — `preload.js:19-23` | sent `main-simple.js:426` | `CaptureApp.tsx:428` | |
| `countdown:update` | yes — `preload.js:26` | yes — `main-simple.js:568` | yes — `CaptureApp.tsx:193,217` | unguarded input, see [P2] |
| `countdown-update` (event) | yes — `preload.js:29-33` | sent `main-simple.js:588` | `PopupApp.tsx:103` | |
| `get-last-transcription` | yes — `preload.js:36` | yes — `engine-manager.js:479` | yes — `PopupApp.tsx:80` | |
| `transcription-updated` (event) | yes — `preload.js:39-43` | sent `main-simple.js:292`, `engine-manager.js:528` | `PopupApp.tsx:87` | |
| `popup:copy-and-close` | yes — `preload.js:46` | yes — `main-simple.js:548` | **NO** | dead channel, see [P2] |
| `popup:hide` | yes — `preload.js:49` | yes — `main-simple.js:560` | yes — `PopupApp.tsx:146` | |
| `welcome:get-preference` | yes — `preload.js:52` | yes — `main-simple.js:611` | **NO** | dead channel, see [P2] |
| `welcome:set-preference` | yes — `preload.js:53` | yes — `main-simple.js:625` | yes — `WelcomeScreen.tsx:17` | |
| `welcome:close` | yes — `preload.js:54` | yes — `main-simple.js:661` | yes — `welcome-main.tsx:13` | |
| `app:get-version` | yes — `preload.js:57` | yes — `main-simple.js:637` | yes — `CaptureApp.tsx:63` | |
| `capture:request-reload` | yes — `preload.js:61` | yes — `main-simple.js:522` | **NO** | dead channel, see [P2] |
| `webgpu:store-transcription` | yes — `preload.js:65` | yes — `engine-manager.js:505` | yes — `CaptureApp.tsx:342` | unguarded input, see [P2] |
| `webgpu:init-orchestrator` (event) | yes — `preload.js:68-72` | sent `engine-manager.js:325` | `CaptureApp.tsx:131` | |
| `cloud:configure` | yes — whitelist `preload.js:80` | yes — `engine-manager.js:433` | yes — `SettingsPanel.tsx:274,288,359,389` | |
| `cloud:test-connection` | yes — whitelist `preload.js:80` | yes — `engine-manager.js:439` | yes — `SettingsPanel.tsx:289` | |
| `cloud:get-config` | yes — whitelist `preload.js:80` | yes — `engine-manager.js:422` | yes — `CaptureApp.tsx:89,369`, `SettingsPanel.tsx:230` | |
| `engine:list-models` | yes — whitelist `preload.js:81` | yes — `engine-manager.js:466` | yes — `SettingsPanel.tsx:149` | |
| `engine:switch-model` | yes — whitelist `preload.js:81` | yes — `engine-manager.js:462` | yes — `SettingsPanel.tsx:353` | |
| `engine:status` | yes — whitelist `preload.js:81` | yes — `engine-manager.js:458` | **NO** | dead channel, see [P2] |
| `debug:open-devtools` | yes — whitelist `preload.js:82` | yes — `main-simple.js:595` | yes — `PopupApp.tsx:154` | |
| `debug:renderer-log` | yes — whitelist `preload.js:82` | yes — `main-simple.js:604` | yes — `diag.ts:41`, `CaptureApp.tsx:154,158,162` | handler returns nothing |
| `webgpu:check-availability` | yes — whitelist `preload.js:83` | yes — `engine-manager.js:485` | yes — `SettingsPanel.tsx:213` | |
| `webgpu:model-status` | yes — whitelist `preload.js:83-84` | yes — `engine-manager.js:489` | yes — `SettingsPanel.tsx:370` | |
| `webgpu:model-ready` | yes — whitelist `preload.js:84` | yes — `engine-manager.js:499` | yes — `CaptureApp.tsx:72` | invoke call has no `.catch` |
| `diag:enabled` | yes — whitelist `preload.js:85` | yes — `main-simple.js:489` | yes — `CaptureApp.tsx:167` | |
| `diag:record` | yes — whitelist `preload.js:85` | yes — `main-simple.js:493` | yes — `diag.ts:48` | |
| `diag:save-audio` | yes — whitelist `preload.js:85` | yes — `main-simple.js:507` | yes — `diag.ts:85` | |
| `app-config:get` | yes — whitelist `preload.js:86` | yes — `main-simple.js:643` | yes — `CaptureApp.tsx:105,286`, `SettingsPanel.tsx:252` | |
| `app-config:set` | yes — whitelist `preload.js:86` | yes — `main-simple.js:647` | yes — `SettingsPanel.tsx:301,310` | no key/type validation, see [P2] |

4 of 34 declared channels (`popup:copy-and-close`, `welcome:get-preference`,
`capture:request-reload`, `engine:status`) are defined in preload **and** handled in main but are
never invoked anywhere in the renderer tree — confirmed by exhaustive grep of every `.tsx`/`.ts`
file under `app/renderer/`.

---

### [P1] No navigation / new-window guard on any BrowserWindow — preload API is exposed to whatever origin the window ends up on
- **Where:** `app/main/main-simple.js:135-147` (hidden window), `199-214` (popup window), `308-324` (welcome window)
- **What:** None of the three `BrowserWindow`s register `webContents.on('will-navigate', ...)` or `webContents.setWindowOpenHandler(...)`. Confirmed by `grep -rn "setWindowOpenHandler\|will-navigate\|openExternal\|new-window"` across `app/` — zero matches. The preload script (`preload.js`) is attached to the `webContents` for its lifetime, not just for the first `loadFile`/`loadURL` call — if that `webContents` is ever navigated to a different origin (redirect, compromised dependency calling `window.location =`, a link click inside a future feature), Electron re-runs the **same preload script** against the new page, so `window.electronAPI` and `window.electron.ipcRenderer` (with its `cloud:configure`, `app-config:set`, `processAudio`, etc.) become available to that arbitrary page.
- **Evidence:**
  ```js
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
  ```
  (no `will-navigate`/`setWindowOpenHandler` registered anywhere for this or any other window)
- **Impact:** If the renderer is ever coerced into navigating off `dist/renderer/*.html` (e.g. via a bug in a bundled third-party inference library that runs in this same webContents), the full IPC surface — including the ability to overwrite `app-config.json`, trigger clipboard writes, and drive the mic/transcription pipeline — remains reachable from attacker-controlled content. `nodeIntegration:false`/`contextIsolation:true` prevent raw Node access but do not prevent this.
- **Fix:** Add a `will-navigate` handler on each `webContents` that calls `event.preventDefault()` for any URL that isn't the known `file://…/index|popup|welcome.html` (or `http://localhost:5175/*` in dev), and a `setWindowOpenHandler` that returns `{ action: 'deny' }` unconditionally (there is no legitimate `window.open` use case here).

### [P1] `sandbox: false` on every window despite the preload script needing nothing non-sandboxed
- **Where:** `app/main/main-simple.js:144, 211, 321`
- **What:** All three windows explicitly set `sandbox: false`. `app/preload/preload.js` only calls `require('electron')` for `contextBridge`/`ipcRenderer` — both fully available under Electron's sandboxed preload environment — so there is no functional reason found in the codebase for disabling the OS-level renderer sandbox.
- **Evidence:**
  ```js
  webPreferences: {
    backgroundThrottling: false,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    preload: preloadPath,
  },
  ```
- **Impact:** Disabling the sandbox removes an OS-enforced isolation layer between a compromised renderer process and the host (independent of contextIsolation/nodeIntegration, which only govern JS-level Node access). Combined with the missing navigation guard above, this widens the blast radius of any renderer-side compromise.
- **Fix:** Set `sandbox: true` on all three `webPreferences` blocks and verify preload still loads (it should — it only uses `contextBridge`/`ipcRenderer`). If sandboxing was disabled for a specific undocumented reason, record it in a comment.

### [P1] Audio payload is boxed into a plain `Array<number>` before crossing IPC on every non-WebGPU transcription
- **Where:** `app/renderer/app/CaptureApp.tsx:376-380`, consumed at `app/stt/engine-manager.js:220,472-475`
- **What:** The recorded WebM `ArrayBuffer` is converted with `Array.from(new Uint8Array(audioBuffer))` before being handed to `electronAPI.processAudio`, instead of sending the `Uint8Array`/`ArrayBuffer` directly. Electron's IPC (`ipcRenderer.invoke`) uses the structured-clone algorithm, which clones `ArrayBuffer`/`TypedArray` natively and cheaply; a plain JS array of numbers instead boxes every byte as a full JS number (8 bytes) inside a heap-allocated array element, multiplying both memory footprint and (de)serialization cost roughly 8x+ before `Buffer.from(audioData)` reconstructs it on the main side.
- **Evidence:**
  ```js
  const audioArray = Array.from(new Uint8Array(audioBuffer));
  const result = await electronAPI.processAudio(audioArray, {
    model: selectedModelRef.current,
    language: selectedLanguageRef.current,
  });
  ```
  ```js
  // preload.js:10
  processAudio: (audioArray, options) => ipcRenderer.invoke('processAudio', audioArray, options),
  ```
  ```js
  // engine-manager.js:219-222
  const audioBuffer = Buffer.from(audioData);
  fs.writeFileSync(webmPath, audioBuffer);
  ```
- **Impact:** Recordings can run up to `MAX_RECORDING_S = 600` (10 min, `CaptureApp.tsx:25`); at MediaRecorder's default WebM/Opus bitrate this is multiple MB of audio, which becomes tens of MB of boxed numbers plus full-array structured-clone copy overhead on the *only* code path used whenever the WebGPU orchestrator isn't ready (cold start, GPU unavailable, model still downloading) — directly adding UI-thread jank and IPC latency right before the "processing" spinner state.
- **Fix:** Send `audioBuffer` (or `new Uint8Array(audioBuffer)`) directly through `ipcRenderer.invoke`; reconstruct with `Buffer.from(new Uint8Array(arrayBuffer))` on the main side. No intermediate `Array.from` needed.

### [P2] Overly permissive CSP across every renderer HTML entry point
- **Where:** `app/renderer/index.html:5`, `app/renderer/popup.html:5`, `app/renderer/welcome.html:5`, `app/renderer/test-audio-capture.html:5`
- **What:** Every CSP includes both `'unsafe-inline'` and `'unsafe-eval'` in `script-src`, and `connect-src *` (unrestricted network egress) in three of the four files.
- **Evidence:**
  ```html
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; worker-src 'self' blob:; connect-src *; media-src *; img-src 'self' data: blob:;" />
  ```
- **Impact:** `unsafe-eval`/`unsafe-inline` neutralize CSP's main value as a defense against script injection (needed today for WASM/ONNX runtime `eval`-based codegen, per the WebGPU/Parakeet pipeline), and `connect-src *` means any script that does run can exfiltrate to an arbitrary host with no CSP-level restriction — this compounds finding [P1] navigation-guard gap, since content on an attacker-controlled origin loaded into one of these windows would inherit the same permissive policy. No renderer code was found writing untrusted content via `innerHTML`/`dangerouslySetInnerHTML` (checked — transcription text is rendered as a React text child in `TranscriptionDisplay.tsx`, safely escaped), so there is currently no confirmed injection point; this is a latent hardening gap, not an active exploit path.
- **Fix:** If `unsafe-eval` is required by onnxruntime-web/parakeet.js, scope it narrowly (e.g. only on the hidden capture window's CSP, not popup/welcome, which don't run inference) and restrict `connect-src` to the specific remote endpoint host(s) the user configures rather than `*`.

### [P2] `window.electron.ipcRenderer.on`/`removeListener` bypass the channel allowlist that `invoke` enforces
- **Where:** `app/preload/preload.js:76-99`
- **What:** The second `contextBridge.exposeInMainWorld('electron', ...)` surface whitelists channels for `invoke` (`validChannels` array) but `on`/`removeListener` pass the caller-supplied `channel` straight to the raw `ipcRenderer` with no check at all.
- **Evidence:**
  ```js
  const validChannels = [
    'cloud:configure', 'cloud:test-connection', 'cloud:get-config',
    'engine:list-models', 'engine:switch-model', 'engine:status',
    'debug:open-devtools', 'debug:renderer-log',
    'webgpu:check-availability', 'webgpu:model-status',
    'webgpu:model-ready',
    'diag:enabled', 'diag:record', 'diag:save-audio',
    'app-config:get', 'app-config:set',
  ];
  if (validChannels.includes(channel)) {
    return ipcRenderer.invoke(channel, ...args);
  }
  },
  on: (channel, callback) => {
    ipcRenderer.on(channel, callback);
  },
  removeListener: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  },
  ```
- **Impact:** Any script running in a window with this preload (all three) can register a listener on *any* IPC event channel the main process might ever broadcast on `webContents.send`, not just the ones this window is meant to receive (e.g. the popup window could listen for `global-shortcut-toggle`, or a future channel never intended for it). This is not remote-code-execution, but it is an inconsistent trust boundary: `invoke` is allowlisted, `on` is not, in the same bridge object.
- **Fix:** Reuse the same `validChannels` allowlist (or a dedicated listen-allowlist) inside `on`/`removeListener`.

### [P2] Invalid channel on `window.electron.ipcRenderer.invoke` silently resolves to `undefined` instead of failing loudly
- **Where:** `app/preload/preload.js:78-91`
- **What:** When `channel` is not in `validChannels`, the `invoke` function falls through with no `else`, so it implicitly returns `undefined` — not a rejected Promise, not a thrown error.
- **Evidence:**
  ```js
  invoke: (channel, ...args) => {
    const validChannels = [ /* ... */ ];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
  },
  ```
- **Impact:** A typo'd or newly-added channel name that was forgotten in `validChannels` doesn't surface as an error anywhere — every `await ipc.invoke('typo-channel')` call site in `CaptureApp.tsx`/`SettingsPanel.tsx`/`diag.ts` just gets `undefined` back and silently no-ops (most call sites already tolerate `undefined` via optional chaining, which is precisely what makes this class of bug invisible in testing). This matches the "silent failure paths that leave the UI stuck" pattern the review was asked to look for.
- **Fix:** In the `else` branch, `return Promise.reject(new Error(\`IPC channel not allowlisted: ${channel}\`))` so misconfigured channels fail fast and visibly during development.

### [P2] Four declared channels are dead code (defined in preload + handled in main, never called)
- **Where:** `preload.js:46` / `main-simple.js:548` (`popup:copy-and-close`), `preload.js:52` / `main-simple.js:611` (`welcome:get-preference`), `preload.js:61` / `main-simple.js:522` (`capture:request-reload`), `preload.js:81` / `engine-manager.js:458` (`engine:status`)
- **What:** Confirmed via `grep -rn "copyAndClose|requestCaptureReload|engine:status|getWelcomePreference" app/renderer` — zero call sites in any `.tsx`/`.ts` renderer file.
- **Evidence:**
  ```js
  // preload.js:61
  requestCaptureReload: () => ipcRenderer.invoke('capture:request-reload'),
  ```
  ```js
  // main-simple.js:522-533 — handler exists, comment describes it as a "last-resort audio recovery" path
  ipcMain.handle('capture:request-reload', async () => { /* destroys + recreates hiddenWindow */ });
  ```
- **Impact:** `capture:request-reload` in particular reads as a real recovery mechanism (per its comment: "Last-resort audio recovery... when the renderer reports a wedged-and-unrecoverable audio pipeline") that nothing in the renderer ever triggers — the recovery path it implies exists is not actually wired up from the UI/watchdog logic in `CaptureApp.tsx`, so a genuinely wedged audio pipeline has no caller-side trigger for this reset. The other three are inert surface area that increases the audit burden with no behavior behind it.
- **Fix:** Either wire `requestCaptureReload()` into the existing watchdog/retry logic in `CaptureApp.tsx` (e.g. after repeated `orchestrator init failed` per the 3-strikes logic around line 461), or remove the dead channels from preload/main/engine-manager together.

### [P2] `countdown:update` handler dereferences `data.active` with no validation and can hang indefinitely waiting on popup creation
- **Where:** `app/main/main-simple.js:568-592`
- **What:** The handler has no top-level try/catch and immediately does `data.active` — if `data` is ever `undefined`/`null` this throws inside the handler (Electron converts it to a rejected promise for the renderer, but bypasses the project's `{success, error}` convention used elsewhere). Separately, when the popup doesn't exist yet, the handler `await`s `popupWindow.once('ready-to-show', resolve)` with no timeout — if window creation stalls (e.g. resource exhaustion), this `ipcMain.handle` invocation never resolves.
- **Evidence:**
  ```js
  ipcMain.handle('countdown:update', async (_event, data) => {
    countdownActive = !!data.active;

    // Ensure popup exists
    if (!popupWindow || popupWindow.isDestroyed()) {
      createPopupWindow();
      await new Promise((resolve) => popupWindow.once('ready-to-show', resolve));
    }
  ```
- **Impact:** Low likelihood given the only caller (`CaptureApp.tsx:193,217`) always passes a well-formed object, but it's an unguarded IPC entry point reachable from renderer-controlled arguments, and the unbounded `await` is a latent hang if `ready-to-show` never fires.
- **Fix:** Guard with `data?.active`, wrap the body in try/catch returning `{success:false,error}`, and add a timeout race around the `ready-to-show` wait.

### [P2] `webgpu:store-transcription` handler dereferences `result.text` with no validation or try/catch
- **Where:** `app/stt/engine-manager.js:505-515`
- **What:** Same class of issue as above — `result.text || ''` assumes `result` is always an object; if `result` is `undefined`, this throws before the `||` guard can help.
- **Evidence:**
  ```js
  ipcMain.handle('webgpu:store-transcription', async (_event, result) => {
    this.lastTranscription = result.text || '';
    this.lastTranscriptionMeta = {
      processingTime: result.processingTime,
      ...
  ```
- **Impact:** Renderer-controlled input crashes the handler (as a rejected promise) rather than degrading gracefully; violates the project's `{success, data, error}` IPC convention (see `.claude/rules/stt.md`/`electron.md`).
- **Fix:** `if (!result || typeof result !== 'object') return { success: false, error: 'invalid result' };` at top of handler.

### [P2] `app-config:set` merges arbitrary renderer-supplied keys into persisted config with no schema/allowlist
- **Where:** `app/main/main-simple.js:647-659`
- **What:** `updates` from the renderer is spread directly into the persisted `app-config.json` with no key allowlist or type checking, even though the UI (`SettingsPanel.tsx`) only ever sends `micReadinessMode`/`micIdleReleaseMs`. This includes `shortcut`, which is read back on next launch and passed directly to `globalShortcut.register(appConfig.shortcut, ...)` (`main-simple.js:415`).
- **Evidence:**
  ```js
  ipcMain.handle('app-config:set', async (_event, updates) => {
    const configPath = path.join(app.getPath('userData'), 'app-config.json');
    try {
      const current = loadAppConfig();
      const next = { ...current, ...updates };
      fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
  ```
- **Impact:** Not exploitable today (no untrusted content reaches this window per [P1]'s current-state caveat), but it's a config-integrity gap: any future or compromised caller on this bridge can silently corrupt `shortcut` or introduce config keys the loader doesn't expect. `globalShortcut.register` fails safe (returns `false`, logged) for a bad accelerator string, so the immediate blast radius is low.
- **Fix:** Allowlist the specific keys `app-config:set` accepts (`micReadinessMode`, `micIdleReleaseMs`, and any future Settings-exposed keys) and validate their types/ranges before merging.

### [P2] Repeated `removeAllListeners(channel)`-before-`on` pattern in preload is a global reset, not a per-subscriber unsubscribe
- **Where:** `app/preload/preload.js:19-23, 29-33, 39-43, 68-72`
- **What:** All four event-subscription helpers (`onGlobalShortcutToggle`, `onCountdownUpdate`, `onTranscriptionUpdated`, `onWebgpuInitOrchestrator`) call `ipcRenderer.removeAllListeners(channel)` before adding the new listener, rather than tracking and removing only their own previously-registered listener.
- **Evidence:**
  ```js
  onGlobalShortcutToggle: (callback) => {
    ipcRenderer.removeAllListeners('global-shortcut-toggle');
    ipcRenderer.on('global-shortcut-toggle', callback);
    return () => ipcRenderer.removeAllListeners('global-shortcut-toggle');
  },
  ```
- **Impact:** Today each of these four is called from exactly one place (`CaptureApp.tsx`/`PopupApp.tsx`), so the global-reset semantics happen to be harmless. It is a latent footgun: if a second component ever subscribes to the same event in the same window (e.g. a future feature needing `onTranscriptionUpdated`), the second `on...` call would silently kill the first subscriber's listener with no error.
- **Fix:** Track the specific listener function and call `ipcRenderer.removeListener(channel, thatFunction)` in the returned unsubscribe, instead of `removeAllListeners`.

### [P3] Many IPC handlers don't follow the project's `{success, data, error}` response convention
- **Where:** representative examples — `engine-manager.js:422` (`cloud:get-config` returns the raw config object), `engine-manager.js:458` (`engine:status` returns raw status), `engine-manager.js:466` (`engine:list-models` returns a raw array), `main-simple.js:637` (`app:get-version` returns a raw string), `main-simple.js:604` (`debug:renderer-log` returns nothing)
- **What:** `.claude/rules/electron.md` states "Always return structured responses: `{ success, data, error }`"; roughly half of the registered handlers return domain data directly instead.
- **Evidence:**
  ```js
  ipcMain.handle('cloud:get-config', async () => {
    await this._readyPromise;
    const adapterConfig = this.activeAdapter.getConfig();
    return {
      ...adapterConfig,
      selectedModel: this.selectedModelId,
    };
  });
  ```
- **Impact:** Cosmetic/consistency only today (every caller happens to know which shape to expect), but it means callers can't uniformly check `.success` before reading `.data`, and any handler that starts throwing (see the two [P2] unguarded-input findings above) degrades differently depending on which convention its particular channel happens to follow.
- **Fix:** Not urgent; if the channel contract is ever centralized (see architecture note below), standardize the response envelope at the same time.

### [P3] `tray:update-state` reports success even when the state string is invalid and silently no-ops
- **Where:** `app/main/main-simple.js:542-545`, `app/main/tray-manager.js:92-93`
- **What:** `TrayManager.setState()` guards `if (!this.tray || !STATES[state]) return;` — an unknown state is silently ignored — but the IPC handler always returns `{ success: true }` regardless.
- **Evidence:**
  ```js
  ipcMain.handle('tray:update-state', async (_event, state) => {
    trayManager.setState(state);
    return { success: true };
  });
  ```
- **Impact:** Minor; a typo'd tray state (e.g. from a future new state value not added to `STATES`) would report success while the tray icon silently fails to update, which could be confusing to debug later.
- **Fix:** Have `setState` return a boolean and thread it into the handler's `success` field.

## Architecture assessment

- **No shared IPC channel contract.** Channel name strings are duplicated by hand across `preload.js`, `main-simple.js`, `engine-manager.js`, and every renderer call site (`CaptureApp.tsx`, `SettingsPanel.tsx`, `PopupApp.tsx`, `diag.ts`) with no single source of truth (e.g. a `channels.js` constants module shared via preload). This is the root cause behind several other findings: the 4 dead/orphaned channels, the `processAudio` naming inconsistency, and the risk that a typo silently no-ops (window.electron bridge) rather than fails loudly.
- **The security posture is inconsistent rather than uniformly weak.** `contextIsolation: true` + `nodeIntegration: false` are correctly set everywhere, and the channel-name allowlist on `invoke` is a real (if incomplete) control — but `sandbox: false`, the missing navigation/new-window guards, and the very permissive CSP each individually erode that otherwise-solid baseline. None of these alone is catastrophic (there's currently no confirmed script-injection entry point into the renderer), but together they mean a single future XSS-class bug (e.g. in a bundled inference library) would have a meaningfully larger blast radius than the "good" settings suggest.
- **Two IPC surfaces with two different trust models coexist in one preload script**: `electronAPI` (fixed method names, each hardcoded to one channel) vs. `electron.ipcRenderer` (generic `invoke`/`on`/`removeListener` gated by a string allowlist only on `invoke`). This split-brain design is why `on`/`removeListener` ended up unguarded — the allowlist pattern wasn't consistently applied to the whole bridge object.
- **Audio, the highest-volume payload in the app, takes the least efficient IPC path.** The WebGPU/local-inference path keeps PCM in the renderer and never crosses IPC with the raw audio; the fallback path (`processAudio`) is the one still serializing binary audio as a boxed JS array, which is backwards from an optimization standpoint — the common case is efficient, the fallback (cold start / no GPU) case is the one that pays the biggest IPC tax.
- **Recovery/dead-letter logic exists but isn't fully wired up.** `capture:request-reload` reads as a designed "wedged audio pipeline" recovery hatch (per its own comment) but has no caller anywhere in the renderer, meaning the failure mode it was built for currently has no way to trigger it.
- **Handler-level input validation is inconsistent.** Some handlers (`copy-to-clipboard`, `diag:save-audio`) defensively wrap risky operations in try/catch; others (`countdown:update`, `webgpu:store-transcription`) dereference renderer-supplied object properties with no guard at all. There's no shared validation helper/pattern across the ~30 handlers.
