<!--
  Produced 2026-08-16 by a 13-agent audit: 6 Sonnet dimension passes (state machine,
  engine selection, IPC/endpoints, toolbar UI state, model lifecycle, Chromium-150 compat),
  each adversarially judged by an Opus verifier, then synthesized by Opus.
  27 raw findings -> 22 survived verification.
  Severity: {"medium":9,"critical":2,"high":4,"low":7}
  DRAFT — for Corey to edit before any code is written. Nothing here has been implemented.
-->
# MVP-Echo Toolbar — Reliability & Electron 43 Decision Document

> **Status (2026-08-16): phases 1 and 2+3 are implemented on branch `electron-43`.**
> 27 of 31 items done, 2 dropped with reasons (28, 30), 1 deferred (31), and one extra bug found
> and fixed that was not in the original list. Tests **34 → 120**, typecheck clean at every commit.
> Phase 1 is verified on real Windows hardware; the later work is not yet — see "Still unverified".
>
> The COEP decision is settled: ship Electron 43 with cross-origin isolation **off by default**
> (`main-simple.js:25`). §4's original premise was refuted by measurement; §7 logs every correction.

## Phase order

Three phases. Items 1–4 are already committed on `electron-43` and are not repeated here.

| # | Phase | Items | What it is, and why it's one unit |
|---|---|---|---|
| **1** | Ship Electron 43 | 5–14 | The security release. Make failures legible (5–7), fix what 43 actually broke (8–11, 13), give the app a working CPU fallback (12), and probe the free win (14). Everything here is required for 43 to function or to fail safely. Nothing optional rides along. |
| **2** | Reliability release | 15–27 | The 13 defects that exist identically on Electron 28. Independent of the platform and of each other — any subset can ship in any order. |
| **3** | Structural | 28–31 | Decouple the model cache → move to a real origin and restore isolation → one authoritative engine record. Internal order matters; the cache must move first or the origin change costs every user 2.4 GB. Sidecar warm-up (31) rides along last. |

**Why three and not one.** Two boundaries are load-bearing:

*Between 1 and 2* — bundling behaviour changes into a platform migration is exactly what made this
week hard to diagnose. If the Electron 43 release also changes how model selection works, a bug report
tells you nothing about which one caused it. Within phase 1 the same rule applies to the two candidate
explanations for "the GPU engine never becomes ready": the removed `adapter.info` API and the COEP
worker block must stay separately toggleable, or a green result proves nothing.

*Between 2 and 3* — phase 3 rewrites how state flows through main, preload and renderer. That needs
its own soak. Doing it during a 15-major platform migration is how you get failures nobody can
attribute.

**Why not more than three.** An earlier draft had eight. Three of them contained a single item, which
is a task, not a phase; the logging fixes cannot alter behaviour so they don't need their own release
cycle; and the cache/origin/state work is one project with an internal ordering constraint rather than
three separate ones.

Item numbers refer to the consolidated list in §8.

---

All `file:line` citations are relative to **`/home/corey/projects/mvp-echo-toolbar/mvp-echo-toolbar`**. Primary files:

- `/home/corey/projects/mvp-echo-toolbar/mvp-echo-toolbar/app/stt/engine-manager.js`
- `/home/corey/projects/mvp-echo-toolbar/mvp-echo-toolbar/app/stt/adapters/webgpu-bridge-adapter.js`
- `/home/corey/projects/mvp-echo-toolbar/mvp-echo-toolbar/app/stt/adapters/local-sidecar-adapter.js`
- `/home/corey/projects/mvp-echo-toolbar/mvp-echo-toolbar/app/stt/adapters/remote-adapter.js`
- `/home/corey/projects/mvp-echo-toolbar/mvp-echo-toolbar/app/main/main-simple.js`
- `/home/corey/projects/mvp-echo-toolbar/mvp-echo-toolbar/app/main/logger.js`
- `/home/corey/projects/mvp-echo-toolbar/mvp-echo-toolbar/app/preload/preload.js`
- `/home/corey/projects/mvp-echo-toolbar/mvp-echo-toolbar/app/renderer/app/CaptureApp.tsx`
- `/home/corey/projects/mvp-echo-toolbar/mvp-echo-toolbar/app/renderer/app/components/SettingsPanel.tsx`
- `/home/corey/projects/mvp-echo-toolbar/mvp-echo-toolbar/app/renderer/app/webgpu/inference-orchestrator.ts`

---

## 0. The single most important fact

```
$ git diff --stat dev electron-43
 .github/workflows/build-electron-app.yml | 2 +-
 mvp-echo-toolbar/package.json            | 6 +++---
 package.json                             | 2 +-
 3 files changed, 5 insertions(+), 5 deletions(-)
```

**Zero application code changed.** Every defect below exists identically on Electron 28. Electron 43 removed two crutches — `adapter.requestAdapterInfo()` and a permissive COEP posture for the module worker — that were keeping the WebGPU path on the happy road where the design defects never surfaced. **You are not regressing because of Electron 43. You are seeing, for the first time, what the app does when its primary engine fails.** Reverting to 28 hides it; it does not fix it.

---

## 1. Root causes

Six defects. Every confirmed issue and every surviving finding is an instance of one of them.

### RC-1 — Engine identity has seven owners and no invariant

"Which engine/model is selected" is stored independently in:

| # | Location | Code |
|---|---|---|
| 1 | `EngineManager.activeAdapter` | `engine-manager.js:44` — **the only thing that routes** (`:285 await this.activeAdapter.transcribe(...)`) |
| 2 | `EngineManager.selectedModelId` | `engine-manager.js:51` — what the UI is told |
| 3 | `RemoteAdapter.selectedModel` + `isConfigured` | `remote-adapter.js:57,59`, persisted `toolbar-endpoint-config.json` |
| 4 | `LocalSidecarAdapter.activeModelId` | `local-sidecar-adapter.js:16`, persisted |
| 5 | `WebGpuBridgeAdapter.activeModelId` | `webgpu-bridge-adapter.js:25`, persisted — **never cleared**, only written at `:25`, `:36`, `:162`, `:193` |
| 6 | renderer `selectedModelRef.current` | `CaptureApp.tsx:39`, written at **only** `:100` and `:428` |
| 7 | renderer `orchestrator.isReady()` | `CaptureApp.tsx:561` — **the actual renderer-side router** |

Nothing reconciles them, and there are **two independent routers reading different copies**: the renderer picks raw-PCM-vs-webm from #7 (`CaptureApp.tsx:561 const useRawPcm = orchestratorRef.current.isReady();` — the comment at `:560` says "Don't check model name here"), while main routes on #1 and **ignores the `model` it was sent**:

```js
// engine-manager.js:285-288
const result = await this.activeAdapter.transcribe(transcribePath, {
  model: options.model,      // accepted, forwarded, never validated against activeAdapter
  language: options.language,
});
```

The restore path (`engine-manager.js:169-240`) is a 3-branch precedence puzzle over #3/#4/#5 with two stale doors that outrank an explicit choice: the WebGPU door (`:190`, confirmed issue #1) and the remote door (`:213`, evaluated *before* the local branch at `:231`).

**Subsumes:** confirmed #1, #3; `stale-model-ref-routes-to-wrong-adapter-and-throws`, `settingspanel-hardcoded-endpoint-autopersists-as-configured`, `getconfig-shape-varies-by-active-adapter`, `hosted-connected-status-not-verified`, `concurrent-model-switch-no-lock`, `hosted-model-id-hardcoded-allowlist-mismatch`, plus the model-lifecycle judge's items 1 and 2.

### RC-2 — Unknowns are laundered into definitive negatives, then cached for the process lifetime

```js
// webgpu-bridge-adapter.js:225-236 (inside executeJavaScript)
const info = await adapter.requestAdapterInfo();   // TypeError on Chromium 131+
...
} catch (err) {
  return { available: false, error: err.message };  // no `indeterminate`
}
// :240
this._gpuCapability = result;                       // cached unconditionally
```

The adjacent code already knows the correct discipline and states it in prose:

```js
// webgpu-bridge-adapter.js:208-211
// indeterminate: we could not ASK, which is not the same as "no GPU".
// Callers must not cache or act on this as a negative result.
return { available: false, indeterminate: true, error: 'Hidden window not ready' };
```

A removed-API `TypeError` is therefore converted into a hardware verdict — the *one* value that overrides an explicit user choice at `engine-manager.js:185-186 / :207`. Worse, `webgpu:check-availability` is a **mutating** call: `refreshGpuCapability()` (`webgpu-bridge-adapter.js:263-266`) nulls the cache and `_probeGpu` re-poisons it at `:240`, so merely opening Settings (`SettingsPanel.tsx:209-219`) changes engine-selection state.

The same pattern in the type system: `webgpu.d.ts:18-22` hand-declares `requestAdapterInfo(): Promise<GPUAdapterInfo>` as a **required** member and omits `info` entirely, and `@webgpu/types` is not a dependency — so `tsc --noEmit` is a green light on a method that cannot exist.

**Subsumes:** confirmed #4, `chrome131-api-removal-also-poisons-settings-gpu-display`, `requestadapterinfo-fix-already-proven-unused`.

### RC-3 — The failure channel is off by default, or lossy, or structurally absent

Five independent gags on the same signal:

1. `logger.js:64-70` — `parts.map(p => typeof p === 'string' ? p : JSON.stringify(p))`. `JSON.stringify(new Error('boom')) === '{}'`. This *is* confirmed issue #7, from `engine-manager.js:312 log('EngineManager: processAudio failed:', error)`.
2. `CaptureApp.tsx:209-213` — `console.log` returns early unless `isDiagEnabled()`. (`console.error`/`console.warn` at `:214-221` **do** forward — that half works.)
3. The console-forwarding shim exists **only in CaptureApp** (the hidden window). `SettingsPanel.tsx` ends every failure path at bare `console.error` (`:203`, `:240`, `:392`, `:396`) in a window with no shim and no `webContents.on('console-message')` handler anywhere in `main-simple.js`.
4. `SettingsPanel.tsx:3` — `type ModelState = 'loaded'|'available'|'switching'|'downloading'|'download'`. **No `'error'` member.** A model card is structurally incapable of showing failure.
5. `StatusIndicator.tsx:5-14` — no props, hardcoded green dot + literal `"Ready"`. The one window a user opens to investigate asserts everything is fine.

And `inference-orchestrator.ts` has **no** `worker.addEventListener('error')` and no `onerror` (only `'message'` at `:108`, `:258`), so a worker that fails to *load* produces no event at all — it hangs to the 900s timeout at `:122`, holding `this.loading = true` (`:86`, cleared only in the `finally` at `:141-143`), which in turn makes `CaptureApp.tsx:530 if (!orchestratorRef.current.isLoading())` false for 15 minutes and disables the only automatic recovery the app has.

**Subsumes:** confirmed #7; `processAudio-error-swallowed-as-empty-object`, `worker-error-event-not-handled`, `status-indicator-hardcoded-ready`, `webgpu-model-card-lies-download-not-error`, `hosted-connected-status-not-verified`, `optimistic-copied-badge`.

### RC-4 — Deferred continuations are generation-blind

The codebase has exactly one correct concurrency primitive — `requestGenRef` (`CaptureApp.tsx:45`) / `teardownEpoch` (`inference-orchestrator.ts:55`) — and applies it to exactly one path (the transcription result, `CaptureApp.tsx:322-323`, `:469-472`). Every other async boundary mutates global state without checking it still owns it:

- Five unguarded `setTimeout(() => updateTrayState('ready'), 3000)`: `CaptureApp.tsx:395-396`, `443-444`, `454-455`, `498-499`, `544-545` — against the one guarded twin at `:469-472`.
- `startWatchdog` (`CaptureApp.tsx:572-577`) calls `resetState(api)` with no handle on `startFn`; the abandoned promise's `.catch` at `:580-588` then kills a *newer* healthy recording.
- `switchModel`'s remote branch awaits a 60s server call **before** committing (`engine-manager.js:405-410`) with no generation guard — a slow switch clobbers a newer explicit choice in main.
- `_releaseWebGpuOrchestrator()` (`engine-manager.js:363`) fires `webgpu:dispose-orchestrator` with **zero** recording-in-progress check, and `CaptureApp.tsx:337` re-reads `orchestratorRef.current.isReady()` **live** at stop time instead of trusting the latched `rawPcmActiveRef` from `:562` — so a mid-recording model switch silently drops the PCM via `AudioCapture.ts:236-241` → `resolve(new ArrayBuffer(0))` → `CaptureApp.tsx:460-462` `updateTrayState('ready')`.

Main already documents this exact rule and follows it (`main-simple.js:779-789`: *"The previous main-side 30s/600s timers were a second, unsynchronized source of truth"*; `tray-manager.js:101-104` clears pending timeouts on every `setState`). The renderer re-created the anti-pattern it deleted from main.

**Subsumes:** `stale-tray-revert-timers`, `start-watchdog-no-cancellation`, `mid-recording-dispose-silent-audio-loss`, `concurrent-model-switch-no-lock`.

### RC-5 — The renderer runs on an opaque origin (`file://`) while depending on cross-origin isolation

`main-simple.js:509-526` stamps `COOP: same-origin` + `COEP: credentialless` on every `file://` response. `file://` documents have **opaque** origins; COOP `same-origin` cannot be satisfied by an opaque origin. No `Cross-Origin-Resource-Policy` header is set anywhere in `app/` (the only CORP in the repo is the Vite **dev-server** middleware at `vite.config.ts` in `serveModelFiles`). `protocol.handle` and `registerSchemesAsPrivileged` appear **nowhere** in the codebase (verified by grep). The module worker (`inference-orchestrator.ts:60 new Worker(new URL('./inference-worker.ts', import.meta.url), { type: 'module' })` → `dist/renderer/assets/inference-worker-B18sOrTV.js`) is blocked, and so is a second dynamic module load nobody has looked at: `AudioCapture.ts:287-288` `addModule(URL.createObjectURL(new Blob([WORKLET_CODE])))`, which is the raw-PCM capture path's only worklet.

The instrumentation for this failure lives inside the thing that fails: `inference-worker.ts:54-59` logs `crossOriginIsolated=... sharedArrayBuffer=...` from inside `init()` — reachable only when isolation already worked.

**Subsumes:** confirmed #5, plus the AudioWorklet exposure.

### RC-6 — There is no fallback ladder at capture time, and the bundled CPU engine can never be the safety net

```js
// local-sidecar-adapter.js:150-153
const hasActiveModel = this.activeModelId && this.modelManager.isModelDownloaded(this.activeModelId);
if (!hasActiveModel) {
  return { available: false, error: 'No local model downloaded' };
}
```

`this.activeModelId = null` in the constructor (`:16`) and **nothing bootstraps it**. Meanwhile the model is sitting on disk — `local-model-manager.js:77-80 isModelDownloaded()` returns `!!this._modelPath`, resolved at `:44-56` from the pre-baked bundle. So on a fresh install the CPU engine reports itself unavailable, `engine-manager.js:122-125` pins `activeAdapter = this.remoteAdapter`, and `cloud:get-config` hands the renderer `selectedModelId: 'local-fast'` routed to an unconfigured remote adapter. **This is reachable on Electron 28, on any fresh install, before the user touches anything.** It is a zero-friction/first-run defect, not an E43 defect.

At the other end, `CaptureApp.tsx:528` is a dead end with no downgrade:

```tsx
if (selectedModelRef.current.startsWith('webgpu-') && !orchestratorRef.current.isReady()) {
```

**Subsumes:** confirmed #2, `gpu-probe-failure-strands-webgpu-only-users-on-broken-remote`.

---

## 2. Severity-ordered fix plan

> **Attribution rule, stated once:** F1 (adapter.info) and F5 (COEP) are the two candidate causes of "the WebGPU orchestrator never becomes ready." **Do not bundle them.** They must ship — or at minimum be *toggled* — separately, or you will never know which one was the blocker. Everything else in this list is independently shippable.

---

### F0 — Make failures legible. Ship this ALONE, first. `[blocker for all measurement]`

**Change**
- `logger.js:64-70` — serialize `Error` specially: `p instanceof Error ? \`${p.name}: ${p.message}\n${p.stack}\` : JSON.stringify(p)`.
- `inference-orchestrator.ts` — add `created.addEventListener('error', e => …)` and `'messageerror'` next to the existing `'message'` listener at `:108`; reject `this.pending` immediately and call `disposeSync(err)` so `loading` clears instead of sitting at `:86` for 900s.
- `main-simple.js` — add `webContents.on('console-message', …)` → `log()` for **hiddenWindow, popupWindow and welcomeWindow**. This replaces the per-window shim and captures UA-generated errors (COEP violations, worker load failures) that `CaptureApp.tsx:214-217` structurally cannot see.
- Reduce the init timeout at `inference-orchestrator.ts:122` from `900000` to `180000`. 15 minutes is not a timeout, it is a hang.

**Why safe:** No behavior change beyond logging and one timeout constant. Cannot break a working path.
**Verify:** Launch packaged build with a deliberately unreachable endpoint, press hotkey. `mvp-echo-toolbar-debug.log` must contain a real message where `EngineManager: processAudio failed: {}` used to be. Then launch on E43 with the WebGPU model selected: the log must now contain a COEP/worker line within 3 minutes instead of nothing for 15.
**Independent:** Yes. **Ship it before anything else** — it is the instrument you measure F1 and F5 with.

---

### F1 — `adapter.info` + honest `indeterminate`. `[critical]`

**Change**
- `webgpu-bridge-adapter.js:226` — replace with the dual path that already exists, proven, at `_review/gpu-report.js:49-52`:
  ```js
  let info = adapter.info;
  if (!info && adapter.requestAdapterInfo) { try { info = await adapter.requestAdapterInfo(); } catch {} }
  ```
- `webgpu-bridge-adapter.js:234-236` — the `catch` must return `{ available: false, indeterminate: true, error: err.message }`. Only `!navigator.gpu` (`:216`) and `!adapter` (`:222`) are determinate negatives.
- `webgpu-bridge-adapter.js:240` — do not cache when `result.indeterminate`.
- `engine-manager.js:185-186` — `probeGpuCapability()` must return `'indeterminate'`, and `:190-207` must treat it like `'unknown'` (trust the saved preference), not like `'unavailable'`.
- Add `@webgpu/types` as a devDependency and **delete** `webgpu.d.ts:18-22`. Hand-rolled ambient types that mask platform API removals are how this shipped green.
- **Delete `app/renderer/app/webgpu/gpu-detector.ts` entirely.** `grep -rn "gpu-detector\|detectGpu" app/` returns only the definition and a comment — it has **zero importers**. Confirmed issue #4 cites `gpu-detector.ts:37`; that line is dead. Delete it so nobody fixes it and declares victory.

**Why safe:** `adapter.info` has existed since Chrome 127; the fallback preserves Chromium 120 (Electron 28). Both branches covered.
**Verify:** On E43, open Settings → the WebGPU line at `SettingsPanel.tsx:498-508` must read "WebGPU: Available" with a real adapter name. On E28, unchanged. Then restart with a saved WebGPU selection — `EngineManager: Ignoring saved WebGPU preference` must **not** appear in the log.
**Independent:** Yes. **Do not bundle with F5.**

---

### F2 — The bundled CPU engine bootstraps itself. `[critical]`

**Change** `local-sidecar-adapter.js:150-153`: if `!this.activeModelId` and `this.modelManager.isModelDownloaded()` is true for the single pre-baked id, adopt it and `_saveConfig()`. Same one-line guard in `transcribe()` at `:48-50`.

**Why safe:** It can only turn `{available:false}` into `{available:true}` when the model files provably exist on disk (`local-model-manager.js:44-56` checks `model.int8.onnx` + `tokens.txt`). It cannot make a working configuration worse.
**Why it matters most:** This is what makes every other failure survivable. Today, when GPU probing fails, `engine-manager.js:100-128` falls through WebGPU → remote → local → **remote-as-fallback**, and the local rung is missing because of this one null. With F2, the ladder actually has a bottom.
**Verify:** Delete `%APPDATA%/mvp-echo-toolbar/`, launch, press the hotkey without touching Settings. Must transcribe on CPU. Log must show `EngineManager: Local sidecar adapter selected`.
**Independent:** Yes.

---

### F3 — Delete the hardcoded LAN endpoint and the mount-time autosave. `[DOWNGRADED → low/cleanup]`

> **Severity corrected 2026-08-16.** This was filed critical/privacy on the theory that the hardcoded
> endpoint auto-persists as configured, sending audio to a stranger on a colliding subnet. **Not
> reproduced:** `toolbar-endpoint-config.json` on the real machine holds `endpointUrl: null`, so
> `isConfigured` is false and no audio is transmitted. The Settings panel *does* push the literal
> through `cloud:configure` on open (visible in the debug log), so the mechanism partly exists and the
> literal should still come out of the source — but it is cleanup, not a privacy incident. The rest of
> this item (the `verifiedAt` predicate) remains worth doing and folds into phase 6.

**Change**
- `SettingsPanel.tsx:107` — `useState('')`. The literal `http://192.168.1.10:20300/v1/audio/transcriptions` stays **only** as the `placeholder` at `:414`.
- `SettingsPanel.tsx:269-278` — this effect fires on mount because `:232 if (config.endpointUrl)` is skipped on a fresh profile while `:242` sets `configLoaded`. Gate it on an explicit user edit (a `dirtyRef`), not on `configLoaded`.
- `remote-adapter.js:373` — `isConfigured = !!this.endpointUrl` is the wrong predicate. Add a persisted `verifiedAt` timestamp set **only** by a successful `cloud:test-connection` (`engine-manager.js:509-524`). `isConfigured` becomes `!!endpointUrl && !!verifiedAt`.
- **Migration required:** existing installs already have the poisoned `toolbar-endpoint-config.json`. On `_loadConfig()` (`remote-adapter.js:445-460`), if `endpointUrl === 'http://192.168.1.10:20300/v1/audio/transcriptions'` and there is no `verifiedAt`, treat it as unconfigured.

**Why this is critical, not cosmetic:** `192.168.1.10` is a commonly-assigned home-LAN address. On a colliding subnet the app POSTs the user's audio (`remote-adapter.js:91-109`) to a stranger's machine — a direct violation of the "audio never leaves the machine" promise. Separately, the same poisoned write is what makes `engine-manager.js:213` (remote branch, evaluated **before** the local branch at `:231`) silently discard an explicit CPU choice on **every** restart: `SettingsPanel.tsx:389` fires `cloud:configure({model})` **after** `engine:switch-model` already flipped `activeAdapter` to local-sidecar, and `local-sidecar-adapter.js:191-194` drops `model` on the floor, so `remoteAdapter.selectedModel` stays `'gpu-english'` forever.
**Verify:** Fresh profile → open Settings → close → inspect `toolbar-endpoint-config.json`. `endpointUrl` must be `null`. Then set a real endpoint, click Test Connection, restart — must still be selected.
**Independent:** Yes. Ship with F2 in the same release, as separate commits.

---

### F4 — One authoritative `EngineState` record. `[critical — the structural fix]`

Full design in §5. This is the fix that collapses RC-1 and most of RC-4. It is the largest change and should land **after** F0–F3 have stabilized the app, on its own branch, with its own soak.

**Independent:** Yes, but it will conflict with any half-measure applied to `_restoreModelSelection`. **Do not patch `engine-manager.js:169-240` piecemeal in the meantime** — F1/F2/F3 touch the *inputs* to that function, not the function itself, deliberately.

---

### F5 — COEP / worker. `[high]`

Full analysis in §4. Interim: flip the default at `main-simple.js:25`. **Never bundle with F1.**

---

### F6 — A real fallback ladder at capture time. `[high]`

**Change** `CaptureApp.tsx:526-547`. The current branch ignores the press, blinks the tray for 1.5s (`:544-545`), and returns. Replace with:
1. If the engine record says WebGPU is `'loading'` → ignore the press, but show a **distinct** tray state ("busy/loading"), not the same error blink used for "gave up permanently."
2. If the engine record says WebGPU is `'unusable'` → **downgrade to the webm/IPC path for this recording** and tell main to demote the selection. The user gets a slower transcription instead of a dead hotkey.
3. Only refuse the press when *no* engine is usable, and then say so on the tray with a persistent state, not a 1.5s blink.

Also: `webgpu:model-ready(false)` is currently sent from **exactly one place** — `CaptureApp.tsx:187`, the user-initiated dispose. Add it to the init-failure path (`inference-orchestrator.ts:135`), the device-lost path (`:115`) and `abort()` (`:189`). Without this, `WebGpuModelManager._ready` (`webgpu-model-manager.js:18`) stays `true` after the worker is terminated and Settings keeps rendering a green "loaded" dot on a dead engine.

**Verify:** Force `_probeGpu` to return unavailable (temporarily), select the GPU model, press the hotkey. Must transcribe via CPU with a visible tray difference — never do nothing.
**Independent:** Yes, but it is only *meaningful* after F2 (there has to be something to fall back to).

---

### F7 — Route on the adapter, and validate that the model belongs to it. `[high]`

**Change** `engine-manager.js:257-288`. Before `:285`, assert `modelBelongsToAdapter(options.model, this.activeAdapterName)`; on mismatch, log both values loudly and either re-resolve the adapter from the model id or fail with a message that names both. Today the mismatch dispatches into `webgpu-bridge-adapter.js:69-75`, which **unconditionally throws** `'WebGPU: transcribe() called on main-process adapter'`, and that throw becomes `{}` in the log.

Note this defect is **unconditional** — it does not require a stale ref. `CaptureApp.tsx:427-430` *refreshes* `selectedModelRef.current` to the webgpu id and then calls `processAudio` at `:435` anyway. The stale ref only explains how the recording got started (it lets `:528` pass).

**Verify:** Select the GPU model with the orchestrator deliberately not ready; the log must name the mismatch, not throw an opaque error.
**Independent:** Yes. Subsumed by F4, but worth doing standalone if F4 slips.

---

### F8 — Generation-guard every deferred continuation. `[medium]`

**Change** — one rule, five-plus sites:
- Wrap the tray reverts at `CaptureApp.tsx:395-396`, `443-444`, `454-455`, `498-499`, `544-545` in the `isStale()` pattern already used at `:469-472`. Better: replace all of them with a single `flashTrayError()` helper that captures the generation and cancels a prior pending revert (mirroring `tray-manager.js:101-104`).
- `AudioCapture.ts` — add an epoch/AbortController (it has none; verified across all 773 lines). `resetState` (`CaptureApp.tsx:291-300`) must invalidate the in-flight start so the `.catch` at `:580-588` cannot kill a *newer* recording, and so the orphaned `this.rawStream` from `AudioCapture.ts:346` is stopped instead of leaking a live mic for the session.
- `engine-manager.js:373-411` — capture `const gen = ++this.switchGen` before any `await`; refuse to commit `activeAdapter`/`selectedModelId` at `:405-410` if `gen !== this.switchGen`.
- `engine-manager.js:363 _releaseWebGpuOrchestrator()` — refuse (or defer) while a recording is in flight. Main does not currently know; the renderer must reply, or main must track it from `tray:update-state`.

**Verify:** Start a recording, switch models in Settings mid-recording. Audio must not silently vanish, and the hotkey must still work on the next press.
**Independent:** Yes, per-site. Do the tray sites first (cheap, self-contained).

---

### F9 — UI that can express failure. `[medium]`

- `SettingsPanel.tsx:3` — add `'error'` to `ModelState`; render it; surface `result.error` from the `else` branch at `:391-393` (that is where failed switches land — **not** the `catch` at `:395-397`).
- `StatusIndicator.tsx:5` — take the engine record as a prop; `PopupApp.tsx:201` passes it.
- `TranscriptionDisplay.tsx:12-17` — `onCopy` is typed `() => void`, so `PopupApp.tsx:136-141` discards the `{success}` that `main-simple.js:690-704` genuinely computes. Type it `() => Promise<{success:boolean}>` and gate the "Copied!" badge on it, matching what the main path already does at `CaptureApp.tsx:387-398`.
- `SettingsPanel.tsx:154-157` — the hardcoded `GPU_MODEL_MAP` (keyed `parakeet-tdt-0.6b-v2-int8`) filters against `DEFAULT_MODELS` ids (`gpu-english`), so the fallback at `:195` always renders phantom cards whose ids the server's `/v1/models/switch` rejects (`CONTEXT.md:429-430` documents `gpu-english` → `parakeet-tdt-0.6b-v2-int8` as *internal id* vs *backend model*). Pick one namespace. `gpu-english` is legacy from the dead `app/stt/whisper-remote.js:28`.

**Independent:** Yes.

---

### F10 — Bounded waits and a fail-closed IPC gate. `[low]`

- `main-simple.js:816-819` — `await new Promise(r => popupWindow.once('ready-to-show', r))` inside the **per-second** `countdown:update` handler, with no timeout and no null-check after `createPopupWindow()`. This is the exact anti-pattern `waitForFirstLoad` (`:172-218`) was written to kill. Reuse `waitForFirstLoad`.
- `preload.js:102-104` — `if (validChannels.includes(channel)) { return ipcRenderer.invoke(...) }` with **no else**. A typo'd or unlisted channel resolves to `undefined`, which every consumer treats as "no config yet" (`CaptureApp.tsx:98`, `SettingsPanel.tsx:233`). Add `throw new Error('IPC channel not allowed: ' + channel)`.
- Delete dead code: `capture:request-reload` (`preload.js:61` + `main-simple.js:766-777`, zero renderer callers) and `popup:copy-and-close` (`preload.js:46` + `main-simple.js:792`, zero callers). Neither would have helped here — both E43 blockers reproduce identically on a recreated window.

**Independent:** Yes.

---

### F11 — Warm the sherpa sidecar. `[medium — but do it LAST]`

`local-sidecar-adapter.js:72 spawn(binaryPath, args, …)` runs per request; ~1.485s of 1.913s is recognizer construction, violating `.claude/rules/stt.md` ("Keep models loaded between transcriptions").

**Explicitly deferred.** This converts a one-shot process into a long-lived one and adds an entire new lifecycle surface (crash/restart/zombie/quit-cleanup/stdin protocol) to an app that is currently regressing. It is a **performance** issue, not a correctness one. Do it after F0–F6 are soaked. And settle unverified item #5 (§6) first — if the 1.485s is process+DLL startup rather than model load, a warm process buys less than it costs.

---

## 3. The Electron 43 verdict

**Land Electron 43 after the reliability work — but keep the `electron-43` branch alive and keep testing on it now. Do not revert to 28.**

Justification:

1. **43 is not the cause.** The diff is three files, zero application code. Every defect in §1 exists on 28.
2. **43 is the best diagnostic instrument you have.** It removed exactly the two crutches that were hiding a three-way state divergence. On 28 the WebGPU path succeeds often enough that the missing fallback (RC-6), the poisoned probe cache (RC-2) and the silent logger (RC-3) never get exercised. Rolling back restores the illusion.
3. **28 is EOL.** Staying is not a long-term option, and the longer you wait the more the 15-major-version gap accumulates other removals you have not found yet (see §6, item 7).
4. **F0–F3 are improvements on 28 too.** None of them is an E43 workaround. F2 and F3 fix first-run defects that have been shipping to users on 28 the entire time.

Concrete sequence:
- Land **F0** on `dev` now. Release it on 28. It costs nothing and it is what turns the next week of debugging from guessing into measuring.
- Land **F1, F2, F3** on `dev`. Verify each on **both** 28 and 43 (43 built from a rebase of the 3-file diff — do not let application code diverge between branches).
- Settle §6 items 1, 2 and 4. Then land **F5**.
- Rebase `electron-43` (still 3 files) onto that and ship 43.
- **F4** lands after 43 is stable, on its own branch. Do not attempt a state-management rewrite simultaneously with a 15-major-version platform migration.

---

## 4. The COEP / worker decision

### ⚠️ The original framing here was REFUTED by measurement

This section originally argued that `file://` documents carry opaque origins, that COOP `same-origin`
therefore could not be satisfied, and that the app was consequently paying COEP's full cost while
never actually becoming isolated — which would have made turning the headers off essentially free.

**That is false.** Measured in the hidden window's DevTools on Electron 28:

```
COI true | SAB function | cores 16
info undefined | legacy function | f16 false | 7 features
```

Cross-origin isolation **genuinely works** on `file://` under Chromium 120. `SharedArrayBuffer` is
live and the 16-thread decode that 3.0.28 shipped is real. So dropping the headers has a **real
cost** — it is not free, and any reasoning built on "we were never isolated anyway" is void.

The `f16 false` / 7-features result also confirms `BRIDGE.md:57-60`: Edge and Chrome report
`shader-f16 true` and 18 features on the same GPU and driver, so the fp16 argument for moving to 43
stands independently.

### The real trade on Electron 43

Chromium 150 enforces COEP's `"worker initialization"` check (MDN `COEPViolationReport`) on the
module worker at `inference-orchestrator.ts:60`. Under `file://`, the document and the worker chunk
are separate opaque origins, so the worker is not exempt and is blocked. On 43 you can have a working
worker **or** 16-thread decode, not both — unless the origin changes.

### The three options

| | (a) Add CORP headers | (b) Custom `app://` scheme via `protocol.handle` | (c) `--enable-features=SharedArrayBuffer` |
|---|---|---|---|
| **Change** | One line in the block at `main-simple.js:509-526` | `registerSchemesAsPrivileged` + `protocol.handle` + change `loadFile` at `:286`, `:355`, `:467` | One `app.commandLine.appendSwitch` |
| **Fixes the worker block?** | Possibly — but `same-origin` CORP cannot match an opaque origin either, so you would need `cross-origin`, a blanket "anyone may embed my files" | Yes, definitively — real origin, real same-origin semantics | **No.** It re-enables SAB; it does not lift COEP's subresource gate |
| **Gets `crossOriginIsolated`?** | No | Yes | No |
| **New surface area** | None | **Large**: you own the file server — path traversal, MIME resolution, range requests for the WASM/model blobs; CSP must be rewritten; and **the origin changes**, so the IndexedDB parakeet cache and `localStorage` (`model-cache.ts:94`) move → a one-time ~1.2 GB re-download for every existing user | Process-wide relaxation of a Spectre mitigation in a process that fetches from HuggingFace and POSTs to a remote endpoint |
| **Verdict** | Diagnostic only | **Destination** | **Reject** |

### Option (d) — inline the worker: investigated and DEAD

A fourth option was considered: keep `file://` but load the worker from a blob URL, which inherits the
creating document's origin and would make it genuinely same-origin and therefore exempt. Suggestive
precedent existed in-repo — `AudioCapture.ts:287` already loads its AudioWorklet exactly that way.

**It cannot work here.** The inference worker fetches a **12–27 MB WASM binary by relative path at
runtime**, and an inlined worker has no path to resolve it against. Vite's `?worker&inline` only
inlines the static import graph, and parakeet.js reaches onnxruntime-web through a dynamic `import()`
regardless (vitejs/vite#17825). Recorded so nobody re-investigates it.

### Decision — settled 2026-08-16

**Take option (a′): turn cross-origin isolation off by default and ship Electron 43.** One line at
`main-simple.js:25` — invert `COI_ENABLED` so isolation is opt-in via `--coi` / `MVP_COI=1`. The
header block at `:509-526` stays exactly as written and still works when the flag is set.

Two independent Opus deciders — one briefed as a release engineer biased toward small reversible
changes, one as a platform architect biased toward correct foundations — reached this conclusion
**separately**. They disagreed only on the follow-up (below).

**What it costs, honestly.** Decode drops to a single thread; the WebGPU **encoder is untouched**.
For 1–8 second recordings — which is typical usage, and never hits the 30 s chunking path — the
difference is tens of milliseconds. The honest casualty is long dictations: a 2-minute recording goes
from ~1.2 s to roughly ~5 s on the 3090 Ti. Every release before 3.0.28 already ran this way.

Two facts make it safe: parakeet's threading fallback is a `console.warn` (`backend.js:66-74`), not a
crash; and **nothing in `app/` reads `crossOriginIsolated` or `SharedArrayBuffer`** — the only hits in
the entire codebase are a diagnostic log line and `_review/gpu-report.js`.

**Where the two deciders disagreed.** The release engineer wanted to ship, then profile the
encode-vs-decode split, and only touch the origin if the numbers demanded it. The architect argued
that before the origin is *ever* changed, the model cache must be moved out of browser storage —
otherwise the origin is permanently welded to the cache and any future move costs 2.4 GB again.
**Sided with the architect**, which is why cache decoupling is its own phase (5) and strictly precedes
the origin work (6).

**Then, in order:**

1. **Probe the free win (~30 min).** `app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')`
   — there are zero `appendSwitch` calls in `app/main/` today. parakeet checks for `SharedArrayBuffer`
   directly (`backend.js:66`), **not** for `crossOriginIsolated`. With COEP already off there is no
   worker block left to lift, so if the switch works you recover all 16 threads with no origin change.
   *(This reverses an earlier assessment that dismissed the switch outright — that assessment assumed
   COEP was being kept, where it is indeed useless.)*
2. **Decouple the cache** (phase 5) — content-hashed files under `%APPDATA%`, no user impact.
3. **Then the real origin** (phase 6) — `app://` or loopback, isolation back on, now costing users nothing.

**What would flip this decision.** One measurement: time a 30-second clip on the XPS 15 / GTX 1650
with `--coi` and without. Same build, no rebuild — the flag already exists. If the no-COI run exceeds
~3 seconds, single-threaded decode is worse on weak hardware than the historical numbers suggest and
the origin work moves from "later" to "now."

---

## 5. State-management design

### The record

One object, owned by main, in `EngineManager`. Everything else derives from it.

```js
{
  rev: 12,                        // monotonic; every accepted write bumps it
  engine: 'webgpu' | 'local' | 'remote',
  modelId: 'webgpu-parakeet-0.6b',
  status: 'ready' | 'loading' | 'unusable' | 'unknown',
  reason: null,                   // non-null iff status !== 'ready'; a STRING a human can read
  gpu: 'usable' | 'unusable' | 'indeterminate',
  endpoint: { url: null, verifiedAt: null },   // verifiedAt set ONLY by a successful test-connection
}
```

### Nine rules

1. **One writer.** Only `EngineManager` mutates it. `activeAdapter` becomes derived — `get activeAdapter() { return this.adapters[this.state.engine]; }` — deleting the independent field at `engine-manager.js:44`. `selectedModelId` (`:51`) is deleted as a separate field; it is `state.modelId`.

2. **An invariant on every write.** `assertPair(engine, modelId)`: `webgpu-*` only with `'webgpu'`, `local-*` only with `'local'`, everything else with `'remote'`. Reject and log otherwise. This single check kills the wrong-adapter dispatch at `engine-manager.js:285` and makes the `options.model` parameter meaningful for the first time.

3. **One persisted file.** `engine-state.json` replaces `toolbar-endpoint-config.json` + `local-sidecar-config.json` + `webgpu-config.json`. Adapters keep only transport config (URL, key). `_restoreModelSelection()` (`engine-manager.js:169-240`) collapses from a three-branch precedence puzzle with two stale doors into: *read record → validate → if invalid, ladder down and record why in `reason`.* Both stale doors (confirmed #1 at `:190`, and the remote twin at `:213`) disappear because there is only one door.

4. **Delete `isConfigured`.** It means three different things — `remote-adapter.js:373` (`!!endpointUrl`), `webgpu-bridge-adapter.js:186` and `local-sidecar-adapter.js:205` (both `!!activeModelId`) — and `SettingsPanel.tsx:235` reads all three as "the remote endpoint is reachable," which is why a local model id lights a green "Connected" dot. Replaced by `status` + `endpoint.verifiedAt`.

5. **Capability is tri-state and never cached when indeterminate.** `state.gpu` comes from the F1 probe. Only `'unusable'` may override a user's explicit choice.

6. **Preload pushes, it does not poll.** Add to `preload.js:90-108`: `engine:get-state` (invoke, for initial sync) and `onEngineState(cb)` (event). Main broadcasts to **every** window — hidden, popup, welcome — on every `rev` bump. Today main→popup has exactly two *data* channels (`main-simple.js:429`, `:832`; `engine-manager.js:598`) and **no state channel at all**; that one missing edge is why the popup fakes every state it shows. Also add the `else { throw }` at `preload.js:102-104`.

7. **The renderer derives, never latches.** Delete `selectedModelRef` (`CaptureApp.tsx:39`, written only at `:100` and `:428`). Delete the routing decision at `CaptureApp.tsx:561` (`const useRawPcm = orchestratorRef.current.isReady()`). Replace both with `state.engine === 'webgpu' && state.status === 'ready'`. The orchestrator reports readiness **up** (`webgpu:model-ready`, from *all* teardown paths per F6) and reads routing **down**. It never decides. This also fixes the 42-second stale-value window in confirmed issue #3 by construction, because there is nothing left to go stale.

8. **The toolbar derives.** `StatusIndicator.tsx` takes the record. `SettingsPanel`'s model cards derive `state` from `(rev, modelId, status)` instead of the optimistic local `setModels` at `SettingsPanel.tsx:325-331`, which removes the need for the 5-minute poll at `:366-386` entirely. The tray maps `status !== 'ready'` to a **distinct, persistent** state — today `CaptureApp.tsx:544-545` emits the identical 1.5s error→ready blink for "loading," "cooldown," "retrying" and "gave up permanently."

9. **Every async transition carries its generation.** `switchModel` (`engine-manager.js:373-411`) captures `++this.switchGen` before its first `await` and refuses to commit if superseded. Same rule for the tray reverts and the start watchdog (F8). One rule, applied everywhere, instead of one rule applied to one path.

### What this collapses

RC-1 entirely. Most of RC-4. The `isConfigured` overload, the `cloud:get-config` shape union (`engine-manager.js:492-501` spreading three incompatible `getConfig()` shapes over one channel), the mis-named `cloud:*` family that dispatches to whatever adapter happens to be live (`engine-manager.js:503-524`), and the "opening Settings mutates startup engine selection" side effect all cease to exist rather than being individually patched.

---

## 6. What is still unverified — and the cheapest test for each

### ✅ Settled since this document was written

| # | Question | Answer |
|---|---|---|
| 1 | Is `crossOriginIsolated` ever true on `file://`? | **YES.** `COI true`, `SAB function`, `cores 16` on Electron 28. The premise of §4 was wrong; isolation works and dropping it has a real cost. |
| 6 | Does the hidden window pass `waitForFirstLoad` on E43? | **YES.** No "failed to load" entries in the debug log. The engine-selection analysis is not downstream of an earlier bug. |
| — | Did 3.1.0 land in a different storage profile? | **NO.** Exactly one `%APPDATA%\mvp-echo-toolbar` profile, IndexedDB cache healthy at **2,371 MB across 10 files**. The `(first run)` line was simply the first write of that key. No upgrade re-download risk. |
| — | Does the hardcoded LAN endpoint auto-persist? | **NOT REPRODUCED.** `toolbar-endpoint-config.json` has `endpointUrl: null` on the real machine, so `isConfigured` is false and no audio is transmitted. **F3 downgraded from critical/privacy to cleanup.** |
| — | Is inlining the worker viable? | **NO** — see §4, option (d). Runtime WASM fetch by relative path kills it. |
| — | What does the on-disk config state actually look like? | Three stores, three different answers, captured live: `local-sidecar-config.json` → `local-fast`, `webgpu-adapter-config.json` → `webgpu-parakeet-0.6b`, `toolbar-endpoint-config.json` → `parakeet-tdt-0.6b-v2-int8`. **RC-1 confirmed on disk, not theorised.** |
| — | What regression protection exists? | 34 tests / 8 suites. **`switchModel()` and `_restoreModelSelection()` have none**, all three adapters are essentially untested (~969 lines), `CaptureApp.tsx` has zero. Note `test/engine-selection.test.js` ("Fix 9") **encodes the current override behaviour as correct** — fixing item 18 means *changing an existing test*, not just adding one. `testkit/electron-stub.js` fakes Electron, so engine-manager fixes are TDD-able on Linux. |

### Still open

| # | Question | Cheapest test | Decides |
|---|---|---|---|
| 2 | Does `--no-coi` restore the module worker on E43? | Launch the packaged exe with `--no-coi` (flag already exists, `main-simple.js:25`), press the hotkey with the GPU model selected. **No rebuild needed.** | Confirms COEP as the worker blocker and gives clean attribution vs F1. |
| 3 | Does the AudioWorklet blob module (`AudioCapture.ts:287-288`) also fail under COEP on 43? | With COI **on** on E43, select the GPU model and press the hotkey. If it fails before any worker message, the worklet is also blocked. Its failure is currently swallowed into the generic `'Start recording failed'` catch at `CaptureApp.tsx:580-588` — F0 will make it legible. | Whether COEP breaks *one* thing or *all* dynamic module loads. Changes F5 from "nice" to "mandatory." |
| 4 | Does `adapter.info` actually populate under E43 on the target GPU? | Run `_review/gpu-report.js` in the hidden-window DevTools. It already has the dual path at `:49-52`. | Validates F1 on the real target. Per `BRIDGE.md:57-60` it has only ever run on Chromium 120 (where `adapter.info` did not exist) and desktop Chrome — the `adapter.info` branch has **never** been exercised inside Electron. |
| 5 | Is the sidecar's 1.485s "recognizer created" model load, or process + DLL startup? | Run `sherpa-onnx-offline.exe` twice on the same wav from a warm shell; compare wall-clock to the internal timing. | Whether F11 (warm process) is worth its new lifecycle surface. |
| 7 | Is `requestAdapterInfo` the only removed API in play across 15 majors? | Run `_review/gpu-report.js` and scan the DevTools console during a full init for other `TypeError: … is not a function`. F0's `console-message` forwarding makes this permanent. | Whether F1 is the last platform-removal fix or the first of several. |
| 8 | Does the `enable-features=SharedArrayBuffer` switch still work on Chromium 150? | Add the `appendSwitch` call, launch with COI off, check `typeof SharedArrayBuffer` in DevTools. **~30 min.** | Whether phase 6 (origin work) is urgent or optional. A yes recovers 16-thread decode with no origin change. |
| 9 | What does single-threaded decode actually cost on weak hardware? | Time a 30 s clip on the XPS with `--coi` and without. No rebuild. | **The measurement that would flip §4.** Over ~3 s and the origin work moves from "later" to "now." |

---

## 6b. Test strategy for the merged phase 2+3

Phases 2 and 3 are merged and executed test-first. Written before any code.

**The blocker is that the code we are changing has almost no coverage, and that
is not an accident of neglect — it is a consequence of the design.**
`switchModel()` and `_restoreModelSelection()` have no tests, the three adapters
are ~969 untested lines, and `CaptureApp`/`SettingsPanel` have none at all with
no DOM harness. Logic that lives inside a React component or inside a template
string passed to `executeJavaScript` cannot be tested without either a browser
or a rewrite. Making it testable and making it correct are the same refactor —
which is why phase 3's "the renderer derives, never latches" is the enabling
move, not a nicety.

### Tier 1 — pure logic, no Electron, no DOM. TDD applies fully.

- **`EngineState`** (item 29): the record, its invariants, and every transition,
  as pure functions. `assertPair(engine, modelId)`, the restore ladder, the
  generation guard. This is the heart of the phase and it is ordinary
  input/output code — no excuse for anything but strict red-green.
- **engine-manager**: already reachable via `testkit/electron-stub.js`, which
  injects a fake `electron` into `require.cache`. Runs on Linux, no Electron.
- **orchestrator**: already reachable via `testkit/fake-worker.mjs`.
- **adapters**: reachable by substituting `modelManager` / fetch.

### Tier 2 — needs a harness, but no new dependency.

- **IPC contract test.** Statically read `main-simple.js`, `preload.js` and the
  renderer call sites; assert the three agree. Channels invoked with no handler,
  handlers missing from the allowlist, and dead channels are all detectable by
  reading source — no runtime, no jsdom. Catches items 25 and 26's entire class,
  and would have caught the allowlist silently returning `undefined`.
- **Extract, do not simulate.** Rather than adding jsdom to test React, pull the
  state derivation out of the components into pure modules and test those.
  Deriving card state from `(rev, modelId, status)` is exactly what §5 rule 8
  requires anyway, so the testable shape and the correct shape coincide. A
  component left over should be dumb enough not to need a test.

### Tier 3 — Windows only. Stays a manual list, and is named as such.

Recording, tray transitions, hotkey, clipboard, real GPU, real endpoint. No
pretence that these are covered; they go in the manual checklist and are
verified on a build.

### Order of work, which follows from the above

1. `EngineState` core, pure, TDD. No wiring.
2. Wire `engine-manager` to it — dissolves items 17, 18, 19.
3. Extract renderer derivation to pure functions — dissolves 15, 16, 22, 23.
4. IPC contract test, then fix what it reports — items 25, 26.
5. Leaf items with local tests: 20 (tray generations), 28 (cache relocation).
6. Item 30 (`app://` origin) is **dropped** — see §7. Item 31 last.

### The gate is three commands, not two

`npm run typecheck && npm test && npm run build`

Learned the hard way. `capture-plan` was CommonJS with a hand-written `.d.ts`: typecheck passed
because TypeScript read the declaration, the tests passed because they used `require()`, and the CI
build failed because Rollup cannot see a named export off `module.exports = {...}`. **Two green
checks that agree with each other can still be blind to the same thing.** `npm run dist` runs all
three, so anything less than all three is not the real gate.

### Rules held to for the duration

No production code without a failing test first; watch every test fail and
confirm it fails for the intended reason; minimal code to green; the existing
suite stays green at every commit. Where something genuinely cannot be tested
here (Windows runtime), say so explicitly in the commit rather than implying
coverage that does not exist.

---

## 7. What changed after this document was first written

Corrections made against measurement, kept visible rather than silently folded in:

1. **§4's premise was refuted.** Isolation genuinely works on `file://` (`COI true`, 16 cores). The
   original "turning COEP off is probably free" reasoning is void; the cost is real.
2. **The COEP decision is settled** — isolation off by default, ship 43. Two independent Opus
   deciders concurred; see §4.
3. **Option (d), inlining the worker, was investigated and is dead** — runtime WASM fetch by
   relative path.
4. **The `SharedArrayBuffer` switch was wrongly dismissed.** It is useless *while keeping COEP*, but
   with COEP off it may recover all 16 threads for free. Now phase 3.
5. **F3 downgraded** from critical/privacy to cleanup — endpoint is `null` on the real machine.
6. **Storage-profile risk closed** — one profile, 2,371 MB cache intact.
7. **RC-1 confirmed on disk** — three config files holding three different model ids simultaneously.
8. **Test coverage mapped** — the existing "Fix 9" suite encodes the buggy behaviour as correct, so
   item 18 requires changing a test, not just adding one.
9. **Threading turns out not to matter, so item 30 is DROPPED.** Measured on the XPS/GTX 1650 via
   `--replay`: 105.8 s of audio decoded in 6,130 ms — **17.3× realtime, single-threaded**, with
   parakeet explicitly reporting `SharedArrayBuffer not available - using single-threaded WASM`.
   BRIDGE recorded 12.6× for this machine *with* threading. The expensive half is the WebGPU
   encoder, which never needed `SharedArrayBuffer`. So the `app://` origin migration — which existed
   only to restore cross-origin isolation, which existed only to enable threading — buys nothing and
   costs every user a 2,371 MB re-download. Dropped. The `--sab` switch works on Chromium 150
   (`SAB function | COI false | cores 16`) but should stay off: it relaxes a Spectre mitigation to
   buy a benefit we have measured as unnecessary.
10. **NEW, not in the original 31 — the inference runtime is fetched from a CDN.** The logs show
    onnxruntime-web loading from `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.1/...` at
    runtime. For an app whose promise is local-first and privacy-first that means it does not work
    offline, and it is third-party executable code arriving on every cold start. Needs its own
    decision; not yet triaged.
11. **NEW — the CPU-switch bug reported from the 3.1.0 build.** Switching GPU→CPU appeared to do
    nothing because the WebGPU readiness poll was never cancelled on a non-WebGPU switch and its
    closure re-selected the GPU model seconds later. Another RC-4 instance. Fixed in `dfee58f`.

---

## 8. Consolidated item list

Phase numbers refer to the table at the top.

**Already committed on `electron-43`** *(not a phase — history)*
1. Electron 28 → 43.4.0 — 15 majors of missing Chromium security patches
2. `electron-builder` pinned to 26.15.3 — CI was silently drifting every build
3. CI Node 18 → 24 — Node 18 is EOL and builder deps already require newer
4. Version → 3.1.0 — so the test exe isn't named identically to the release it's compared against

**Phase 1 — ship Electron 43**

*Make failures legible first — these change no behaviour and are the instrument for everything else:*
5. Errors log as `{}` — the logger JSON-stringifies Error objects, destroying the message
6. Worker failures hang 15 minutes — nothing listens for the worker's `error` event
7. Settings and popup errors go nowhere — only the hidden window forwards its console

*Then what 43 actually broke, plus a safe floor:*
8. GPU detection crashes on 43 — calls a WebGPU method Chrome removed in 131
9. "Couldn't ask" is recorded as "no GPU" — an indeterminate probe is cached as a permanent negative
10. Hand-written WebGPU types assert a removed method exists — why typecheck passed on broken code
11. `gpu-detector.ts` is dead code — zero callers
12. CPU engine reports itself unavailable on a fresh install — never adopts the bundled model
13. Isolation off by default — unblocks the worker; costs multi-threaded decode
14. Probe the `SharedArrayBuffer` switch (~30 min, timeboxed) — may restore 16-thread decode for free

> Keep 8 and 13 separately toggleable. They are the two candidate explanations for "the GPU engine
> never becomes ready" and bundling them destroys attribution.

**Phase 2 — reliability release** *(all pre-existing on 28, any subset can ship)*
15. Hotkey dies when the GPU model isn't ready — no fallback, no visible reason, no recovery
16. Switching models mid-recording loses the recording
17. No check that the model belongs to the active engine
18. CPU choice overridden on restart by a stale GPU selection that is never cleared
19. Three config files disagree about which model is selected
20. Tray sticks in the wrong state — old timers overwrite a newer recording
21. Model cards can't show failure — the type has no error state
22. Popup status dot always says "Ready" — hardcoded
23. "Copied!" appears even when the clipboard write failed
24. Phantom model cards — hardcoded ids don't match what the server accepts
25. Unlisted IPC channels silently return `undefined` instead of erroring
26. Countdown handler can wait forever for a window
27. Hardcoded LAN endpoint in the settings field (was F3)

**Phase 3 — structural**
28. ~~Move the model cache out of browser storage~~ — **DROPPED**, see below
29. ✅ One authoritative record of which engine is selected — replaces the seven that disagreed
30. ~~Move to an `app://` origin and turn isolation back on~~ — **DROPPED**, threading measured irrelevant
31. Keep the CPU model loaded between transcriptions (~1.5 s tax per call) — **still deferred**

### Why 28 is dropped

Its entire stated rationale was to precede item 30: while the cache lives in browser storage it is
welded to the origin, so an origin change would cost every user a 2,371 MB re-download. Item 30 is
dropped, so that reason no longer exists.

What remains is eviction risk, and the app already calls `navigator.storage.persist()` — the machine
under test reports `persistent=true` with a healthy 2,371 MB cache. So the residual benefit is small
while the change is large and carries exactly the migration hazard that produced the v3.0.23
re-download bug. Doing a risky 2.4 GB migration for a reason that has evaporated is the kind of
unexamined momentum this document exists to prevent. Revisit only if eviction is actually observed.

### Why 31 stays deferred

Unchanged from the original reasoning, and §6 item 5 is still unsettled: nobody has established
whether the sidecar's 1.485 s "recognizer created" is model loading or process + DLL startup. If it
is the latter, a warm process buys less than the lifecycle surface it adds — crash, restart, zombie,
quit-cleanup, stdin protocol — on an app that has just been stabilised. It is a performance issue,
not a correctness one, and measured CPU throughput is RTF 0.035.

---

**31 items — 27 fixes, 4 already committed.** Ten ship with Electron 43; the rest are independent.
Everything from 15 down exists identically on Electron 28: it is not migration damage, it is what the
app has always done when its primary engine fails.

---

## 9. Still unverified — the Windows list

Tier 3 from §6b. Named explicitly rather than implied to be covered. Phase 1 (items 5–14) is
confirmed on the XPS; everything below landed after that build.

1. **A model switch mid-recording no longer loses the audio.** Start a recording, switch model in
   Settings while it runs, stop. The transcript must arrive, routed by the engine selected at START.
2. **The CPU fallback fires.** Select English GPU on a cold cache and press the hotkey before the
   model finishes loading. It must record and transcribe on CPU, log the reason, and leave the GPU
   selection intact — the old build refused the press entirely.
3. **CPU selection survives a restart** with a working GPU present. This is the reported bug; there
   is now a round-trip test, but the persisted `engine-state.json` path is untested on Windows.
4. **The popup shows real status**, not a hardcoded "Ready" — including an honest error while an
   engine is unusable.
5. **Legacy config migration.** An existing install must not lose its selection when the three old
   config files are superseded by `engine-state.json` on first run.
6. **Tray reverts no longer stomp a newer recording.** Trigger an error, immediately start another
   recording, and confirm the tray stays on `recording` past the 3-second mark.
