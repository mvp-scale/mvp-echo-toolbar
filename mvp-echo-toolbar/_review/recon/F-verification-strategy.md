# Recon F — Verification strategy for the 12-fix batch

Scope: read-only recon on a headless Linux dev box for a Windows-11-only Electron app with
zero tests, no `tsc` gate, and no committed lockfile. Goal: the cheapest verification per fix
that yields *real* evidence, not a testing pyramid nobody asked for.

No source files were modified. Commands run: `npx tsc --noEmit`, `npx tsc -b --force`,
`./node_modules/.bin/electron --version` (with/without `--no-sandbox`), `node -e` probes of
`node:test`, `node:module`, and `esbuild` in a temp context, and `grep`/`egrep` over `app/`.

---

## 1. What runs headless today

| Module | Nature | Headless-testable as-is? | Evidence |
|---|---|---|---|
| `app/renderer/app/CaptureApp.tsx:12-22` `trimSilence()` | Pure (Float32Array math) | **Yes** — but it's a private top-of-file function, not exported. Would need a re-export or copy-paste-into-harness. | no import of DOM/window at module scope besides the rest of the file's browser code below it |
| `app/renderer/app/diag.ts` `encodeWav()` (52-76), `shortHash()` (52-56) | Pure | **Yes**, already exported/importable in isolation | `diag.ts:38-49` `ilog`/`sendDiag`/`saveDiagAudio` touch `window.electron.ipcRenderer` but only inside their own function bodies — module import itself has no top-level browser calls |
| `app/renderer/app/webgpu/inference-orchestrator.ts` (`InferenceOrchestrator`) | Mixed: control-flow logic is pure, but constructs `new Worker(...)` (line 57) and calls `prepareModelCache()` | **Partially** — importable with zero side effects at module scope (no top-level DOM calls); needs `global.Worker` stub + `navigator.storage`/`localStorage`/`indexedDB` stubs to *run* `initialize()` | `inference-orchestrator.ts:10` only imports `./model-cache`, which is also side-effect-free at import time |
| `app/renderer/app/webgpu/model-cache.ts` | Browser-coupled (`navigator.storage`, `localStorage`, `indexedDB`) but functions, not module scope | **Yes with stubs** — 3 small stub surfaces (`navigator.storage.persist/persisted`, `localStorage.getItem/setItem`, `indexedDB.open`) | `model-cache.ts:22,31-43,73,94` |
| `app/renderer/app/webgpu/gpu-detector.ts` | Browser-coupled (`navigator.gpu`) | **No** — real WebGPU adapter probe, unstubbable in any meaningful way (stubbing it just tests the stub) | `gpu-detector.ts:24,29,37-38` |
| `app/renderer/app/webgpu/inference-worker.ts` | Worker-only globals (`self`, `parakeet.js`/WASM/WebGPU) | **No** — runs inside a Worker context and depends on `parakeet.js`'s ONNX runtime; not meaningfully stubbable | `inference-worker.ts:16,24,54,81-96` |
| `app/renderer/app/audio/AudioCapture.ts` | Heavy browser coupling: `AudioContext`, `AudioWorklet`, `MediaStream`, `navigator.mediaDevices` | **No** — would require faking an entire Web Audio graph (worklet message ports, `MediaStreamTrack.muted`, `getUserMedia`); cost exceeds value | `AudioCapture.ts:132,147,243-256,313-325,364,594-605` |
| `app/renderer/app/main.tsx`, `popup-main.tsx`, `welcome-main.tsx` | Entry points | **No** — throw immediately on import (`document.getElementById` at module scope) | `main.tsx:7-10` (`document.getElementById('root')`, throws if null — and `document` itself is undefined in plain Node) |
| `app/renderer/app/PopupApp.tsx`, `CaptureApp.tsx` (as components), `SettingsPanel.tsx`, `WelcomeScreen.tsx`, `StatusIndicator.tsx`, `TranscriptionDisplay.tsx` | React components | **No** — need `jsdom` + React Testing Library (not installed) to render; not proportionate for a one-person tray app | `PopupApp.tsx:22` `navigator.userAgent`, `popup-main.tsx:8,15` `document.`/`navigator.userAgent` |
| `app/renderer/app/audio/{completion,start,warning}-sound.ts` | `AudioContext`/`window.AudioContext` | **No** | `completion-sound.ts:7`, `start-sound.ts:11`, `warning-sound.ts:122,147,173` |
| `app/main/main-simple.js` | Electron main process, `app.requestSingleInstanceLock()` at module scope (line 100) | **No** — importing it in plain Node runs real Electron app lifecycle calls immediately; not stubbable without a large refactor | `main-simple.js:100-109` |
| `app/stt/engine-manager.js`, `app/stt/adapters/webgpu-bridge-adapter.js` | CommonJS, but the GPU probe (`refreshGpuCapability`) shells out to `hiddenWindow.webContents.executeJavaScript(...)` | **No** for the GPU-probe path — needs a real Electron renderer | `webgpu-bridge-adapter.js:16,185,230` |

**Bottom line**: of ~20 renderer/main files, only a handful of *specific functions* (not whole
modules) are genuinely pure and cheaply testable: `trimSilence`, `encodeWav`, `shortHash`, and
the control-flow (not I/O) logic inside `InferenceOrchestrator`. Everything else is coupled to
Electron, the DOM, Web Audio, or WebGPU strongly enough that stubbing it costs more than it's
worth for a 1-person project.

---

## 2. What's already installed / usable at zero incremental cost

- **`vitest`/`jest`/`mocha`/any test runner: absent.** `ls node_modules | egrep -i '(vitest|jest|mocha)'` → no matches. `node_modules/.bin` has only `tsc` for anything test-adjacent.
- **`node:test` + `node:assert`: built in, zero cost.** Confirmed `require('node:test')` works: `node -e "const t = require('node:test'); ...` → `node:test OK function`. Node version here is **v20.19.5** (`node --version`), well above `package.json`'s `"engines": {"node": ">=18.0.0"}` (line 44) — `node:test` has been stable since Node 18, so this is safe to assume on the maintainer's own machine too, and it adds **zero** entries to `package.json`/the (absent, gitignored) lockfile.
- **`esbuild` 0.21.5 is already present transitively** (pulled in by `vite`, confirmed `node_modules/esbuild/package.json` version `0.21.5`) and is directly `require()`-able and usable programmatically: a smoke test (`esbuild.transformSync('const x: number = 1; export function add(a:number,b:number){return a+b}', {loader:'ts'})`) transpiles TS→JS synchronously with no new dependency. Combined with `node:module`'s `register()` hook (confirmed present: `require('node:module').register` is a function on this Node version), a ~15-line custom loader could let `node:test` `import` real `.ts` files directly. This is the only way to headlessly execute the actual `.ts` source (Node 20.19.5 has **no** native TS support — `--experimental-strip-types` requires Node ≥22.6 and isn't present here: `node --experimental-strip-types -e ...` → `bad option`).
- **No `ts-node`/`tsx`/`swc` present** — don't add them; `esbuild` (already there) covers the same need for free.
- **No lockfile is committed** (`.gitignore:50` `package-lock.json`; confirmed `git check-ignore -v package-lock.json` → matched), so CI's `npm install` is unpinned — this is exactly why the recommendation below adds **zero new `package.json` entries**.

---

## 3. The `tsc` question — cleaner than expected

```
$ npx tsc --noEmit          # 2.7s wall time
app/renderer/app/PopupApp.tsx(151,9): error TS6133: 'langDisplay' is declared but its value is never read.

$ npx tsc -b --force        # honors project references (tsconfig.node.json too)
app/renderer/app/PopupApp.tsx(151,9): error TS6133: 'langDisplay' is declared but its value is never read.
```

**1 error, in both `--noEmit` and `-b` (project-references) mode, in 2.7 seconds.** The offending
line: `PopupApp.tsx:150-151` declares `const langDisplay = '';` and never reads it — dead code
left over from a removed feature, not a real bug. `tsconfig.json` already has `strict: true`,
`noUnusedLocals: true`, `noUnusedParameters: true` (lines 15-17) — the strict gate is already
configured, just never wired into a script or CI step.

**This means adding a `tsc` gate is a 10-minute job, not a multi-hour one**: delete the one
dead line (or prefix `_langDisplay`), add `"typecheck": "tsc --noEmit"` to `package.json`
scripts, done. There is no backlog of suppressed type errors to work through first.

---

## 4. Can the app run at all on this Linux box? — No, and WebGPU is unreachable regardless

```
$ ./node_modules/.bin/electron --version
[FATAL] setuid_sandbox_host.cc(158): The SUID sandbox helper binary was found, but is not
configured correctly. ... chrome-sandbox must be owned by root and mode 4755.
electron exited with signal SIGTRAP

$ ./node_modules/.bin/electron --no-sandbox --version
v28.3.3
```

- Electron **is installed** (`node_modules/electron`, `node_modules/.bin/electron`) and its binary runs *only* with `--no-sandbox` (matches `dev:electron`'s existing `--no-sandbox --ozone-platform-hint=auto` flags in `package.json:8` — those flags were clearly added for exactly this reason).
- `--version` exits without creating a window, so it doesn't prove `BrowserWindow` works. Actually creating a window needs a compositor: `DISPLAY` is unset, and `xvfb-run`/`Xvfb` are **not installed** (`which xvfb-run` / `which Xvfb` both fail). Without a display server, `BrowserWindow` creation is not expected to succeed even with `--no-sandbox --disable-gpu`.
- **This was not empirically pushed further** (per the task's "do not actually launch it" instruction for the app) — the above is a feasibility read from the installed tooling, not a launch attempt.
- **What would be needed for a real Electron smoke test**: `apt-get install xvfb` (a system package, not an npm dependency — doesn't touch the lockfile-drift concern) and `xvfb-run -a electron --no-sandbox app/main/main-simple.js`. This is plausible to add later but is out of scope for "cheapest today."
- **WebGPU is unreachable headless regardless of xvfb.** `navigator.gpu` (`gpu-detector.ts:24`) needs a real GPU-backed Chromium WebGPU implementation; Xvfb only provides a software X11 display, not a GPU/ANGLE/Vulkan backend. This **rules out** any headless verification of: the live GPU-availability probe (fix 9), `inference-worker.ts`'s actual model load/warmup/transcribe (fix 0c, 0e's real inference), and end-to-end audio→transcript testing. These remain Windows-only, real-hardware checks no matter what infrastructure is added here.

---

## 5. Per-fix evidence design

Legend: **(S)** static/typecheck/code-read, **(H)** headless harness (Node, stubs, no Electron/DOM), **(W)** Windows manual, minutes not hours.

| # | Fix | Class | Cheapest real evidence |
|---|---|---|---|
| 0a | Orchestrator re-throws on init failure; counter increments; 3-strike halt | **H** + S | Today `initialize()` catches its own error, calls `disposeSync()`, and does **not** rethrow (`inference-orchestrator.ts:81-92`) — meaning `CaptureApp.tsx:73-76`'s `catch (e) { initFailRef.current += 1; ... }` can **never fire today**; the counter is dead code. Harness: stub `global.Worker` (a class whose `postMessage` never replies to `{type:'init'}`, or immediately replies `{type:'error', message:'boom'}`), stub `navigator.storage`/`localStorage` for `prepareModelCache()`, `await orchestrator.initialize('wasm')`, assert it **rejects**. Once that's proven, the counter/3-strike logic in `CaptureApp.tsx:74,461` is a single already-correct line reachable only once the rethrow exists — a quick (S) read confirms the wiring, no need to re-implement React hook testing. |
| 0b | Device-lost during init rejects the pending promise within ~1s; `isLoading()` clears | **H** (primary, high value) | Today the persistent `'device-lost'` listener (`inference-orchestrator.ts:65-70`) only calls `disposeSync()` — it does **not** settle the pending `sendMessage()` promise, which only resolves/rejects on `'ready'`/`'error'`/timeout (`inference-orchestrator.ts:158-165`). Since the init timeout is `900000`ms (`inference-orchestrator.ts:76`), a device-lost-during-init currently hangs for **up to 15 minutes**, not ~1s. Harness: stub `Worker` whose `postMessage` on `{type:'init'}` asynchronously dispatches a `{type:'device-lost'}` message (no `'ready'` ever sent); `Promise.race([orchestrator.initialize(...), timeoutMs(2000)])`; assert it settles well under 2s and `orchestrator.isLoading() === false` after. This is the single most concrete, cheapest-to-prove bug in the batch. |
| 1 | `devicechange` during recording no longer stops the mic | **W** (primary), S (pre-check) | Today `AudioCapture.ts:364-367`'s `devicechange` listener calls `releaseMicStream()` **unconditionally**, including mid-recording — this stops the live tracks feeding the active worklet. Full headless stubbing of `AudioContext`/`AudioWorklet`/`MediaStream` costs more than the fix. (S): after the fix, confirm the handler now checks an "is a recording active" guard before releasing. (W): on the Windows box, start a recording, trigger a `devicechange` (unplug/replug a USB mic, or toggle a Bluetooth headset), keep talking, stop, and confirm (a) the transcript isn't truncated/empty and (b) the debug log (`%TEMP%\mvp-echo-toolbar-debug.log`) shows the `devicechange` line (`AudioCapture.ts:365`'s `dlog`) **without** a `mic released after idle` line (`AudioCapture.ts:388`) appearing mid-recording. |
| 3 | Global shortcut registered before engine init | **S** (sufficient) | Today `globalShortcut.register(...)` is at `main-simple.js:415`, **after** the awaited `engineManager.initializeAndSignalReady()` at `main-simple.js:409`. This is pure statement ordering in one linear `async` function — reading the diff (does `register()` now appear before the `await ...initializeAndSignalReady()` line) is fully conclusive; no harness adds confidence a code read doesn't already give, and importing `main-simple.js` standalone is unsafe/meaningless (it calls `app.requestSingleInstanceLock()` and would try to register a *real* global OS shortcut — `main-simple.js:100`). (W) cross-check, free: the existing log lines already timestamp both events — `Global shortcut ... registered successfully` (`main-simple.js:437`) vs `EngineManager initialized: ...` (`main-simple.js:410`) — `grep` the debug log after one real launch and confirm the shortcut line's timestamp now precedes the engine-initialized line's. |
| 4 | Renderer load failure surfaces an error state within a bounded time | **W** (primary); S confirms the handler exists | No `did-fail-load` handler exists anywhere today: `grep -n "did-fail-load" app/main/main-simple.js` → **no matches** (only `did-finish-load` at line 164 and `render-process-gone` at line 172 are handled). A synthetic headless Electron smoke test is possible in principle (Electron can run offscreen without a display) but this box has no `xvfb`/`DISPLAY` and building a throwaway headless-Electron harness to validate one `did-fail-load` handler is disproportionate for a fix this size. (S): confirm the new handler is wired and updates tray/error state within a bounded timer. (W): on Windows, temporarily rename `dist/renderer/index.html` (or point `loadFile` at a bad path) for one launch, confirm the tray flips to an error state within a few seconds instead of hanging silently forever, then restore the file. |
| 5 | Warm-mic ready cue gated on `track.muted` + real audio energy | **S** (already implemented — regression guard only) | This behavior **already exists** in the current code: `AudioCapture.ts:504` (`if (track && track.muted) return;`) and `:505-513` (RMS-floor gate, `READY_ENERGY_FLOOR = 0.005` at `:117`) — this matches `MEMORY.md`'s note that this shipped in v3.0.23. Treat item 5 as a **regression check**, not new work: (S) diff review after the other 11 fixes land, confirming the two-gate logic in `maybeFireCaptureReady` (`AudioCapture.ts:501-517`) is untouched or intentionally changed. (W), cheap: one real recording, confirm the start-chirp (`playStartSound`, `CaptureApp.tsx:175`) still lands *after* speech is audible, not before. |
| 9 | Stale WebGPU preference no longer overrides the live availability probe | **S** + **W** today; **H** becomes cheap IF the fix extracts a pure decision function | Today `SettingsPanel.tsx:234` restores `config.selectedModel` unconditionally, and `CaptureApp.tsx:95-98` auto-inits the orchestrator purely by checking `selectedModelRef.current.startsWith('webgpu-')` — neither cross-checks the live probe result from `webgpu:check-availability` (`SettingsPanel.tsx:213`, backed by `engine-manager.js:485-487`'s `refreshGpuCapability()`, which itself calls into `webgpu-bridge-adapter.js:185`'s `hiddenWindow.webContents.executeJavaScript(...)` — a **real Electron renderer call, not headless-testable**). Recommend the implementer extract the fallback decision as a pure function, e.g. `resolveEffectiveModel(storedModelId, gpuAvailable): string` — that one function becomes a 5-line (H) `node:test` case with zero stubs. Absent that refactor: (S) code read confirming the new code path checks `gpuInfo.available` before honoring a stored `webgpu-*` selection; (W) on Windows, temporarily disable the GPU adapter (Device Manager → disable the GPU, or force software rendering) with a WebGPU model previously selected, relaunch, and confirm the app falls back to a CPU model instead of silently retry-looping (watch for repeated `orchestrator init failed` lines in the debug log, which would mean it's *not* fixed). |
| 0c | 30s chunking produces non-empty text + correct seam merging | **H** (primary, high value — biggest single test-writing payoff in the batch) | Not implemented yet — no chunking/segmentation logic exists today (`grep -n "chunk" CaptureApp.tsx` and `AudioCapture.ts` only match unrelated recording-buffer/PCM-quantum "chunks", not 30s transcription windows). This is fundamentally numeric/string logic (split a `Float32Array` into N windows with overlap; merge N text results handling boundary duplication) with **no** browser API surface if written as pure functions — the single best (H) candidate in the batch. Recommend the implementer export e.g. `chunkAudio(pcm, sampleRate, chunkS, overlapS): Float32Array[]` and `mergeChunkTexts(texts: string[]): string` as standalone, pure, exported functions; then `node:test` cases with synthetic Float32Arrays (silence, a synthetic tone crossing a chunk boundary) and canned text arrays (including a deliberately duplicated word at a seam) give real confidence with no stubs at all. (W) supplement: record something >30s for real and confirm no duplicated phrase around the ~30s mark and nothing is dropped. |
| 0e | PCM transferred (not copied) to the worker | **H** (primary, cheap and conclusive) | Today `inference-orchestrator.ts:173`'s `this.worker.postMessage(message)` passes **no transfer list** — `message.audio` (the PCM `Float32Array`) is structured-cloned (copied), not transferred. This is empirically, not just textually, provable in Node: `node:worker_threads`'s `MessageChannel`/`MessagePort.postMessage(msg, transferList)` implements the same structured-clone/transfer semantics as browsers (a transferred `ArrayBuffer` is detached — `byteLength` becomes `0` after). Harness: stub `global.Worker` as a thin wrapper around a real `MessagePort`, call `orchestrator.transcribe(pcm, 16000)`, and assert `pcm.buffer.byteLength === 0` immediately after the call returns from `postMessage` (proving transfer) vs. today's code leaving `byteLength` unchanged (proving copy). This directly measures the thing the fix claims, using only Node built-ins. |

---

## 6. The highest-leverage cheap win: wire up the `tsc --noEmit` gate

**Recommendation: add `"typecheck": "tsc --noEmit"` to `package.json` and run it before every
fix is considered done** (and ideally in CI, though that's a separate, optional step). Fix the
one pre-existing error first (`PopupApp.tsx:151`, delete or prefix the unused `langDisplay`).

**Reasoning:**
- **Cost is effectively zero.** 2.7 seconds wall time (measured above), `typescript` is already
  a `devDependency` (`package.json:38`), `tsconfig.json` already has `strict`, `noUnusedLocals`,
  `noUnusedParameters` turned on (lines 15-17) — nothing to configure. No new `package.json`
  entries, no lockfile-drift risk (the exact concern `CLAUDE.md` flags for this repo).
- **The codebase already typechecks almost clean** (1 trivial dead-code error) — this is not a
  "spend a day silencing 200 errors first" situation, which is the realistic failure mode this
  recon was asked to rule out.
- **Coverage-per-effort is the best in the batch.** Every one of the 12 fixes touches `.ts`/`.tsx`
  files (`inference-orchestrator.ts`, `AudioCapture.ts`, `CaptureApp.tsx`, `SettingsPanel.tsx`,
  `gpu-detector.ts`, `model-cache.ts`) — a single fast command catches an entire class of the
  errors most likely in a hand-edited async/event-driven codebase like this one: wrong
  `postMessage` signatures (directly relevant to fix 0e), `Promise`/`async` typos (fix 0a/0b),
  wrong IPC payload shapes, null-safety slips, `Worker`/`MessageEvent` type misuse. It's a static
  analysis pass over 100% of the TypeScript surface for 2.7 seconds, versus building bespoke
  stubs per fix.
- **It's a strict superset of "free"**: unlike headless `node:test` harnesses (which need
  per-module stubbing decisions, as the table above shows — worthwhile for maybe 3 of the 12
  fixes) or Windows manual passes (which cost the maintainer's actual minutes each time), the
  `tsc` gate costs nothing extra to run again after every single edit during the batch.

**Second-tier follow-up** (not the single recommendation, but the natural next increment once
the `tsc` gate is in): a handful of `node:test` cases for the genuinely pure functions —
`trimSilence` (`CaptureApp.tsx:12-22`, needs exporting), `encodeWav`/`shortHash`
(`diag.ts`, already exported), and, if fix 0c's chunk/merge logic is written as pure functions
per the recommendation in row 0c above, that logic too. These are the only pieces of the
codebase where a `node:test` unit test is cheaper than a manual Windows pass **and** more
conclusive than a code read — everything else in this app is either trivially checked by
reading the diff, or is fundamentally an Electron/DOM/WebGPU/real-hardware behavior that no
amount of headless infrastructure on this Linux box will faithfully reproduce.
