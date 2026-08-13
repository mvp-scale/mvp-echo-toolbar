# E — Engine/Adapter Selection Recon (Fix 9)

Scope: `app/stt/engine-manager.js`, `app/stt/adapters/webgpu-bridge-adapter.js`,
`app/stt/webgpu-model-manager.js`, `app/stt/adapters/remote-adapter.js`,
`app/stt/adapters/local-sidecar-adapter.js`, `app/main/main-simple.js`,
`app/renderer/app/CaptureApp.tsx`, `app/renderer/app/components/SettingsPanel.tsx`.
Read-only recon for Fix 9 (`_restoreModelSelection()` deferring to the live probe).
No source files modified. `_review/` treated as orientation only — every claim below
was re-verified directly against current code (and, for §6, executed in a plain Node
REPL against the actual file).

---

## 0. The headline finding

**Naive deference breaks WebGPU restore entirely — every cold boot, deterministically,
not as a race.** The deciding timeline (full trace in §4):

`cloud:get-config` (the *only* channel through which the renderer learns
`selectedModel`) blocks on `EngineManager._readyPromise`, which resolves at the end of
`initialize()`. But `initialize()`'s WebGPU probe (`isAvailable()`) partly depends on
`WebGpuModelManager._ready`, which is only set `true` by a `webgpu:model-ready` IPC that
the renderer can only send *after* it has already learned `selectedModel` from
`cloud:get-config` and initialized the orchestrator. So the one live signal
`isAvailable()` needs cannot exist yet the first time it's ever checked in a session —
not "usually can't," structurally cannot. A fix that gates `_restoreModelSelection()`
on `isAvailable()`'s raw return value would make WebGPU permanently unrestorable.

The fix is to gate on GPU **hardware** capability only (a sub-check inside
`isAvailable()` that genuinely is knowable at `initialize()` time), not on the whole
`isAvailable()` result, which also folds in the structurally-unknowable model-readiness
flag. Details in §3–§4.

---

## 1. Consumer map — `selectedModelId` / `activeAdapter` / `activeAdapterName`

All three fields live only on the `EngineManager` instance (`app/stt/engine-manager.js`).
There is no other holder of this state in main; the renderer only ever sees it through
the `cloud:get-config` IPC response, which is engine-manager.js:422-431 re-serializing
`this.activeAdapter.getConfig()` plus `selectedModel: this.selectedModelId`.

### Main-process readers (all in `engine-manager.js`)

| Reader | file:line | What it does with the field | Effect if selection becomes `local-*` instead of `webgpu-*` (GPU-less machine) |
|---|---|---|---|
| `processAudio()` — ffmpeg branch | `:225` `if (this.activeAdapterName === 'local-sidecar')` | Converts the recorded WebM to 16kHz mono WAV via bundled ffmpeg before transcribing | **Activates.** Only the local-sidecar branch converts; webgpu never reaches `processAudio` at all (see §2) and remote sends WebM as-is. |
| `processAudio()` — transcribe delegate | `:237` `await this.activeAdapter.transcribe(transcribePath, ...)` | Dispatches to whichever adapter is active | Delegates to `LocalSidecarAdapter.transcribe()` (spawns `sherpa-onnx-offline.exe`) instead of the renderer-side `InferenceOrchestrator` path (webgpu never calls this — see `webgpu-bridge-adapter.js:69-75`, `transcribe()` always throws by design) |
| `getStatus()` | `:352-360` `this.activeAdapter.getHealth()/.getConfig()` | Feeds `engine:status` IPC | Reports local-sidecar health (binary/model presence) instead of GPU/model-download state |
| `listModels()` `adjustState` | `:375-386` | Marks the active adapter's model `loaded`, others `available` | The `local-*` entry shows `loaded` in Settings; the `webgpu-*` entry shows `available`/`download` instead |
| `cloud:get-config` handler | `:422-431` | Returns `{...activeAdapter.getConfig(), selectedModel: this.selectedModelId}` | **The single fan-out point to the renderer** — see below |
| `cloud:configure` handler | `:433-437` | `this.activeAdapter.configure(config)` | Settings' endpoint/API-key form now configures the local-sidecar adapter's config object instead of webgpu's |
| `cloud:test-connection` handler | `:439-454` | `this.activeAdapter.isAvailable()` / `.getHealth()` | Tests local-sidecar liveness instead of GPU+model liveness |
| `switchAdapter()` | `:284-301` | Explicit override (not a reader of the restore path, but shares the same 3 fields) | Unaffected by Fix 9 — user-invoked, separate code path |

### Renderer readers (via `cloud:get-config`)

| Reader | file:line | What it does | Effect if `local-*` instead of `webgpu-*` |
|---|---|---|---|
| `CaptureApp` mount effect | `CaptureApp.tsx:87-98` | `selectedModelRef.current = config.selectedModel`; if it `startsWith('webgpu-')`, calls `initWebGpuOrchestrator()` | **Does not auto-init the orchestrator.** No ~2.5GB parakeet.js load, no GPU worker spun up at startup. |
| `CaptureApp` pre-transcribe re-read | `CaptureApp.tsx:365-373` (STANDARD/webm path, inside `performStop`) | Re-fetches `cloud:get-config` right before sending audio, refreshing `selectedModelRef.current` | Sends `model: 'local-<id>'` to `processAudio`, which routes to the ffmpeg+sidecar path above |
| Hotkey start-branch dead-path check | `CaptureApp.tsx:454` `if (selectedModelRef.current.startsWith('webgpu-') && !orchestratorRef.current.isReady())` | Ignores the keypress outright when true | **Condition is false** — recording proceeds normally via the webm/IPC path (see §2, this is the core payoff of Fix 9) |
| Raw-PCM vs webm mode select | `CaptureApp.tsx:487` `orchestratorRef.current.isReady()` | Chooses capture mode | Always `webm` mode, since the orchestrator was never initialized |
| `SettingsPanel` config load | `SettingsPanel.tsx:230-238` | `setSelectedModelId(config.selectedModel)` — panel's own mirrored state | Radio/highlight shows the local model as selected instead of the GPU one |
| `SettingsPanel` `isLocalMode` | `SettingsPanel.tsx:140` `selectedModelId.startsWith('local-') \|\| selectedModelId.startsWith('webgpu-')` | Gates local-mode-only UI (no material change — both `local-*` and `webgpu-*` set this `true`) | No change |
| `SettingsPanel` loaded-state reconcile | `SettingsPanel.tsx:258-266`, `129-136` | Marks the model matching `selectedModelId` as `'loaded'` in the model list | Local model row shows `loaded`, webgpu row shows `available` |

**Bottom line:** every consequence funnels through exactly one pipe — `selectedModelId` →
`cloud:get-config` → `CaptureApp.tsx:91` (`selectedModelRef.current`). Change what
`_restoreModelSelection()` writes to `selectedModelId`/`activeAdapter`/`activeAdapterName`
and every downstream effect above follows automatically; there is no second copy of this
state to keep in sync.

---

## 2. The renderer routing consequence — traced precisely

`CaptureApp.tsx:454-473`, the dead-hotkey branch, verbatim:

```tsx
// CaptureApp.tsx:454-473
if (selectedModelRef.current.startsWith('webgpu-') && !orchestratorRef.current.isReady()) {
  console.log('CaptureApp: Ignoring shortcut — WebGPU model not ready');
  if (!orchestratorRef.current.isLoading()) {
    const sinceLast = Date.now() - lastInitAtRef.current;
    if (initFailRef.current >= 3) {
      console.error('CaptureApp: orchestrator init failed 3× — not auto-retrying; app restart needed');
    } else if (sinceLast > 15000) {
      initWebGpuOrchestrator();
    }
  }
  api.updateTrayState('error');
  setTimeout(() => api.updateTrayState('ready'), 1500);
  return; // ← hotkey press is fully swallowed, no fallback to webm/IPC
}
```

This only triggers when `selectedModelRef.current` (== `EngineManager.selectedModelId`,
delivered via `cloud:get-config`) starts with `webgpu-`. **Does Fix 9 resolve it?**
Yes, for the specific bug class it targets: on a machine where `_restoreModelSelection()`
today blindly restores a stale `webgpu-*` preference (GPU became unavailable, driver
removed, profile copied from a different machine — the disk config in
`webgpu-adapter-config.json` says `activeModelId` is set and `isConfigured` is `true`,
regardless), a correctly-designed Fix 9 makes `selectedModelId` fall back to
`local-*`/remote instead. `selectedModelRef.current.startsWith('webgpu-')` is then
`false`, the dead-hotkey branch is never entered, and recording proceeds via the normal
webm/IPC path to whatever adapter really is usable. This is documented as **cause 4** of
the 4-cause "hotkey does nothing" cluster in `_review/ARCHITECTURAL-REVIEW.md:114`
("Routes to a not-ready engine while a verified-working adapter sits idle").

**What Fix 9 does *not* fix** — a second, independent cause of the same symptom,
documented separately as **cause 3** in the same table
(`_review/ARCHITECTURAL-REVIEW.md:113`, addressed by the *different*, still-unimplemented
Fix 10 "forward `download-progress`... fall back to the webm engine for the first
recording while WebGPU warms"): when `webgpu-*` genuinely **is** the correct,
GPU-capable selection but the orchestrator hasn't finished loading yet this session
(first-ever run, cold IndexedDB cache, or a load that's merely slow), the exact same
`CaptureApp.tsx:454` branch swallows the hotkey with no fallback, for as long as loading
takes (up to a 15-min timeout per `_review/ARCHITECTURAL-REVIEW.md:113`), and after 3
failed attempts stops retrying but *still never falls back* — the user is stuck until
they change something in Settings or restart. Fix 9 is about *which* adapter gets
selected at restore time; it does nothing about *what CaptureApp does while waiting* for
a correctly-selected webgpu adapter to warm up. These are two separate, complementary
fixes — confirm both land if the goal is "hotkey never silently does nothing."

---

## 3. Does the fix lose the "restore across restarts" feature? — the core risk

### 3a. What `isAvailable()` actually checks

```js
// webgpu-bridge-adapter.js:79-95
async isAvailable() {
  const hasModel = this.activeModelId && this.modelManager.isModelDownloaded(this.activeModelId);
  if (!this._gpuCapability) {
    this._gpuCapability = await this._probeGpu();
  }
  if (!this._gpuCapability || !this._gpuCapability.available) {
    return { available: false, error: 'WebGPU not available on this system' };
  }
  if (!hasModel) {
    return { available: false, error: 'WebGPU model not downloaded' };
  }
  return { available: true };
}
```

It is really two independent checks ANDed together, with different liveness properties:

1. **GPU hardware capability** (`_probeGpu()`, `:176-216`) — asks the hidden window to
   run `navigator.gpu.requestAdapter()` via `executeJavaScript`. This needs the hidden
   window's Chromium page to exist and have a JS context — nothing more. It does **not**
   need React to have mounted, does **not** need CaptureApp, does **not** need the
   parakeet.js orchestrator. It's genuinely knowable early.
2. **"hasModel"** — despite the name, this is **not** a disk-cache check. It calls
   `this.modelManager.isModelDownloaded(this.activeModelId)`, and
   `WebGpuModelManager.isModelDownloaded()` **ignores its argument entirely**:

   ```js
   // webgpu-model-manager.js:15-30
   class WebGpuModelManager {
     constructor() {
       this._ready = false; // ← always false at construction, every app launch
     }
     setReady(ready) { this._ready = ready; }       // only caller: IPC handler below
     isModelDownloaded() { return this._ready; }     // arg is dead — always ignored
   }
   ```

   `_ready` is a **session-scoped, renderer-driven "model is warm in this renderer's
   memory right now"** flag, not a "was this model previously cached to disk" flag (that
   distinction genuinely exists for the *other* engine — `LocalSidecarAdapter.isAvailable()`
   at `local-sidecar-adapter.js:146-156` does a real disk/binary check — but not for
   WebGPU). The only setter is the IPC handler:

   ```js
   // engine-manager.js:499-502
   ipcMain.handle('webgpu:model-ready', async (_event, ready) => {
     this.webgpuAdapter.modelManager.setReady(ready);
     return { success: true };
   });
   ```

### 3b. Can `_probeGpu()` (axis 1) return a false negative transiently at startup?

Yes, but for a *different*, well-understood reason than `_ready`: it needs the hidden
window (`this._getHiddenWindow()`) to exist. In `main-simple.js`, `initialize()` is only
called after `createHiddenWindow()` (`:396`) *and* an explicit await on `did-finish-load`
(`:399-405`) — so by the time `initialize()` runs, the hidden window reliably exists and
has a loaded JS context (verified by direct read of `main-simple.js:389-409`, and
empirically in §6 — outside that sequencing, e.g. if `_probeGpu()` were called before
the window exists, it returns `{ available: false, error: 'Hidden window not ready' }`,
a real "not ready" state distinguishable from a genuine negative GPU probe). Within the
current call order this transient case doesn't actually occur, but it's worth encoding
as a distinguishable "unknown" state rather than folding it into "unavailable," since a
future refactor of the startup order (e.g. Fix 3, which moves `globalShortcut.register`
earlier — see `_review/FIX-PLAN.md:40`) could change that guarantee.

### 3c. Can deferring blindly to `isAvailable()` permanently downgrade a legitimate user?

**Yes, permanently, on every single cold boot** — this is not a transient race that
sometimes goes the wrong way; it is a closed loop that can never complete in the
"webgpu available" direction the first time it's evaluated. See §4 for the full proof.
This is the central risk the task asked to analyze, and it's real and unconditional
under a naive implementation.

### 3d. Recommended design

Split the two axes and gate the restore decision on the one that's actually knowable at
`initialize()` time:

- Add/reuse a **hardware-only** probe (`_probeGpu()`'s result, or a thin wrapper around
  it — `refreshGpuCapability()` at `webgpu-bridge-adapter.js:230-233` already exists and
  does exactly this) that returns a **three-state** result: `available` / `unavailable`
  (definitive — `navigator.gpu` undefined, or `requestAdapter()` returned `null`, or a
  non-transient error) / `unknown` (hidden window not ready to answer).
- In `_restoreModelSelection()`, gate the `webgpuConfig.activeModelId && webgpuConfig.isConfigured`
  branch on this hardware probe, **not** on `webgpuAdapter.isAvailable()`'s combined
  result. Treat `unknown` the same as "trust the saved preference" (today's behavior) —
  only a definitive `unavailable` should skip the branch and fall through to
  remote/local. This removes the stale-preference bug (GPU genuinely gone) without
  reintroducing the permanent-downgrade risk (model-not-yet-warm is not a reason to
  distrust a saved GPU preference — the orchestrator hasn't even been asked to load yet
  at this point in the boot sequence).
- Model readiness (`_ready`) stays exactly what it is today: a post-restore, renderer-
  reported signal that only affects `CaptureApp.tsx:454`'s dead-hotkey gate and
  `getHealth()`'s `degraded` state — not the restore decision itself.
- `initialize()` currently calls `_restoreModelSelection()` from **four** separate
  return points (`:99`, `:109`, `:119`, `:127`), each after a different partial probe,
  silently discarding whichever of `remoteResult`/`localResult` was computed once
  `_restoreModelSelection()` overwrites `activeAdapter`. Collapse this to a single call
  after all three probes have run, so the hardware-gated webgpu-restore decision can be
  made alongside (not after-the-fact-clobbering) the remote/local results.

---

## 4. Ordering — the deciding timeline, established from code

```js
// main-simple.js:389-409
engineManager.setupIPC({ getHiddenWindow: () => hiddenWindow, getPopupWindow: () => popupWindow });
createHiddenWindow();
await new Promise((resolve) => {
  if (hiddenWindow.webContents.isLoading()) {
    hiddenWindow.webContents.once('did-finish-load', resolve);
  } else { resolve(); }
});
const engineStatus = await engineManager.initializeAndSignalReady();  // ← resolves _readyPromise when done
```

```js
// engine-manager.js:422-431
ipcMain.handle('cloud:get-config', async () => {
  await this._readyPromise;              // ← blocks until initialize() has fully returned
  const adapterConfig = this.activeAdapter.getConfig();
  return { ...adapterConfig, selectedModel: this.selectedModelId };
});
```

```tsx
// CaptureApp.tsx:87-98 (renderer's only path to learn selectedModel / init the orchestrator)
const config = await ipc.invoke('cloud:get-config');           // ← can't return before _readyPromise
if (config.selectedModel) selectedModelRef.current = config.selectedModel;
if (selectedModelRef.current.startsWith('webgpu-')) {
  initWebGpuOrchestrator();                                    // ← loads parakeet.js, THEN:
}
```

```tsx
// CaptureApp.tsx:71-72, inside initWebGpuOrchestrator(), only after orchestrator.initialize() succeeds
const ipc = (window as any).electron?.ipcRenderer;
if (ipc) ipc.invoke('webgpu:model-ready', true);                // ← the ONLY setter of _ready = true
```

Chain, cause → effect: `initialize()`'s `webgpuAdapter.isAvailable()` call needs
`_ready === true` to return `{available:true}` → `_ready` is only set by
`webgpu:model-ready` → that IPC is only sent from inside `initWebGpuOrchestrator()` →
that is only invoked from `CaptureApp.tsx:97` after reading `config.selectedModel` from
`cloud:get-config` → `cloud:get-config` cannot resolve until `_readyPromise` resolves →
`_readyPromise` resolves only when `initialize()` (the very call awaiting
`isAvailable()`) finishes. **This is a closed cycle, not an occasionally-lucky race**:
on every cold boot, `webgpuAdapter.isAvailable()` is evaluated strictly *before* the one
event that could ever make it return `available:true` on the "hasModel" axis. The GPU
hardware sub-check (§3a axis 1) is not part of this cycle and resolves fine at this
point; the "hasModel"/`_ready` sub-check is unconditionally false, always, the first
time `initialize()` runs. Confirms §3c and §0.

This also means: today's code "working" for GPU-capable users across restarts is
entirely because `_restoreModelSelection()` **ignores** `isAvailable()`'s result and
consults only the disk-persisted `activeModelId`/`isConfigured` — i.e. the very thing
identified as the bug is also, structurally, the only reason the "restore my WebGPU
choice" feature currently functions at all. Any fix must replace that blind trust with
a *different*, actually-live signal (the hardware probe), not with `isAvailable()`
itself.

---

## 5. Interaction with `switchModel()` (`:312-346`) and planned Fix 0d

`switchModel()` is the **explicit, user-driven** adapter switch (invoked via
`engine:switch-model` IPC from `SettingsPanel.tsx:353`); it is a separate code path from
the boot-time `_restoreModelSelection()` and is not directly affected by Fix 9's restore
logic. Two points of interaction worth noting:

1. **No collision at boot.** At the moment `_restoreModelSelection()` runs inside
   `initialize()`, the renderer has not yet called `initWebGpuOrchestrator()` for
   *anything* this session (that only happens after `cloud:get-config` resolves, which
   is downstream of `_restoreModelSelection()` — see §4). So whatever Fix 9 decides
   (restore webgpu or fall back), there is no orchestrator resident yet to dispose.
   **Fix 0d ("dispose the orchestrator when switching away from webgpu",
   `_review/FIX-PLAN.md:96`, currently targeted at `switchModel()`/`switchAdapter()`) is
   a non-issue for the initial boot-restore decision.**

2. **Collision risk only if Fix 9 is extended to a mid-session fallback.** If the
   recommended design in §3d is later extended so that a "webgpu never became ready
   after N attempts" signal (there is currently no such IPC — only
   `webgpu:model-ready(true)` is ever sent; a failed orchestrator init just logs and
   increments `initFailRef`, per `CaptureApp.tsx:73-76`) causes EngineManager to
   downgrade the *active* adapter away from webgpu mid-session, that downgrade should
   reuse `switchModel()`/`switchAdapter()` (or a shared helper), not a fourth ad hoc
   field-mutation site. `switchModel()` already has the analogous "entering webgpu" hook
   (`hidden.webContents.send('webgpu:init-orchestrator')`, `:322-326`); Fix 0d's
   "leaving webgpu" counterpart belongs on the same path so any future
   session-fallback logic gets the dispose behavior for free instead of needing to be
   taught about it separately. This is a design note for *if* the fallback is built, not
   something Fix 9's boot-time-only scope requires today.

---

## 6. Testability — minimal seam, verified headless

Dev box is headless Linux; product is Windows; zero existing tests
(`package.json:14` — `"test": "echo \"No tests yet\""`).

**`engine-manager.js` does not itself call `app.getPath`** (`grep -n '\bapp\.' engine-manager.js`
returns nothing) — the `app` destructured at `:18` is unused inside the class. The
problem is entirely in the **hard-constructed adapters**:

```js
// engine-manager.js:30-39
class EngineManager {
  constructor() {
    this.remoteAdapter = new RemoteAdapter();
    this.localSidecarAdapter = new LocalSidecarAdapter();
    this.webgpuAdapter = new WebGpuBridgeAdapter();   // ← all three, unconditionally
```

Each adapter's constructor calls `app.getPath('userData')` synchronously
(`webgpu-bridge-adapter.js:26`, `local-sidecar-adapter.js:17`, `remote-adapter.js:61`).
No injection seam exists today — adapters cannot be swapped for test doubles.

**Empirically verified** (executed directly, not inferred):

```
$ node -e "const e = require('electron'); console.log(typeof e, e);"
string /home/corey/.../node_modules/electron/dist/electron
```

`require('electron')` in plain Node does **not** throw — it resolves to a string (the
path to the Electron binary), which is normal, documented Electron behavior outside the
Electron runtime. So the module loads fine headless; destructuring `{ ipcMain, app }`
off that string silently yields `undefined` for both, and nothing breaks **until code
actually calls `app.getPath(...)` or `ipcMain.handle(...)`**.

```
$ node -e "const { EngineManager } = require('./app/stt/engine-manager.js'); new EngineManager();"
THREW: Cannot read properties of undefined (reading 'getPath')
```

Confirms the exact failure point: construction, not require.

**Seam that works today with zero source changes** — stub the `electron` module in
`require.cache` before requiring `engine-manager.js` (equivalent to `jest.mock('electron', ...)`
or a `--require` preload shim for a plain `node:test`/`tap` harness):

```js
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    app: { getPath: () => require('os').tmpdir() },
    ipcMain: { handle: () => {} },
  },
};
const { EngineManager } = require('./app/stt/engine-manager.js');
const em = new EngineManager();
await em.initialize();   // runs to completion headless
```

Verified by direct execution: `new EngineManager()` constructs successfully (adapters'
`app.getPath()` calls resolve to a tmpdir), and `em.initialize()` runs the real
`webgpuAdapter.isAvailable()` → `_probeGpu()` path, which correctly reports
`{ available: false, error: 'Hidden window not ready' }` (since `_getHiddenWindow()`
defaults to `() => null` before `setupIPC()` wires a real getter) and falls through to
the `remote` fallback branch, exactly matching real behavior with no hidden window
present. This is sufficient to exercise `initialize()`/`_restoreModelSelection()` end to
end, including the Fix 9 branch, by controlling what each adapter's `isAvailable()`/
`getConfig()` return (either by pre-writing their config JSON files into the stubbed
tmpdir `userData`, or — cleaner — adding a small constructor-injection seam):

```js
// proposed, not applied — minimal, backward-compatible seam
constructor({ remoteAdapter, localSidecarAdapter, webgpuAdapter } = {}) {
  this.remoteAdapter = remoteAdapter || new RemoteAdapter();
  this.localSidecarAdapter = localSidecarAdapter || new LocalSidecarAdapter();
  this.webgpuAdapter = webgpuAdapter || new WebGpuBridgeAdapter();
  ...
}
```

With that one change, a test can pass plain object doubles
(`{ isAvailable: async () => ({available: false}), getConfig: () => ({activeModelId: 'webgpu-parakeet-0.6b', isConfigured: true}) }`)
for each adapter and assert `activeAdapterName`/`selectedModelId` after `initialize()` —
covering exactly the stale-preference/live-probe-conflict scenario Fix 9 targets,
without touching `electron` at all. **Recommended: use both** — the `require.cache` stub
for anything that still needs the real adapter classes (e.g. verifying `_loadConfig()`/
`_saveConfig()` JSON round-trips), and constructor injection for pure selection-logic
unit tests of `initialize()`/`_restoreModelSelection()`.

---

## Summary for the caller

- **Naive deference breaks WebGPU restore entirely: yes**, deterministically on every
  cold boot, not a race — see §4's closed-cycle proof (`cloud:get-config` → `_readyPromise`
  → `initialize()` → `isAvailable()` → `_ready` → `webgpu:model-ready` IPC →
  `initWebGpuOrchestrator()` → `cloud:get-config`, first link before last).
- **Recommended design:** gate `_restoreModelSelection()`'s webgpu branch on a
  **hardware-only** GPU probe (three-state: available/unavailable/unknown, reusing
  `_probeGpu()`/`refreshGpuCapability()`), not on `webgpuAdapter.isAvailable()`'s
  combined result — the latter also folds in `_ready`, which is structurally always
  false at this point in the boot sequence. Treat `unknown` (hidden window not ready) as
  "trust the saved preference," and only a definitive `unavailable` should fall through
  to remote/local. Also collapse `initialize()`'s four `_restoreModelSelection()` call
  sites into one, after all adapter probes, so it isn't discarding already-computed
  remote/local results.
- **Fix 9 alone fixes the dead-hotkey path for cause 4 only** (stale-preference routes
  to webgpu when it shouldn't) — confirmed via `CaptureApp.tsx:454`. It does **not** fix
  cause 3 (genuinely-selected-but-still-warming webgpu still swallows the hotkey with no
  fallback) — that's the separate, still-unimplemented Fix 10.
- **Fix 0d interaction:** none at boot time (nothing is resident to dispose when
  `_restoreModelSelection()` runs); relevant only if Fix 9 is later extended to a
  mid-session "give up on webgpu" fallback, which should route through
  `switchModel()`/`switchAdapter()` rather than a new ad hoc mutation site.
- **Minimal testing seam, verified working today:** stub the `electron` module via
  `require.cache` (zero source changes, confirmed by direct execution) to get
  `EngineManager` constructible headless; additionally add optional constructor
  injection for the three adapters (one small, backward-compatible change) to unit-test
  `initialize()`/`_restoreModelSelection()` selection logic with controllable fakes.
