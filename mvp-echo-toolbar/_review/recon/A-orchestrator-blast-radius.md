# Recon A — `InferenceOrchestrator` blast radius for Fix 0a / Fix 0b

Scope: read-only investigation of every caller of `InferenceOrchestrator`'s public API
(`initialize`, `dispose`, `abort`, `disposeSync`, `isReady`, `isLoading`, `transcribe`), the
consequences of (0a) making `initialize()` re-throw + gating `webgpu:model-ready`, and (0b)
tracking/rejecting the pending `sendMessage` promise + clearing `loading` in `disposeSync()`.

Files read in full: `app/renderer/app/webgpu/inference-orchestrator.ts`,
`app/renderer/app/CaptureApp.tsx`, `app/renderer/app/webgpu/model-cache.ts`,
`app/renderer/app/webgpu/inference-worker.ts`, `app/stt/webgpu-model-manager.js`,
`app/stt/engine-manager.js` (relevant sections), `app/renderer/app/components/SettingsPanel.tsx`
(relevant section).

Code search method: `grep`/`egrep` over `app/` (the aoa index is present at `.aoa/` but
`aoa grep`/`aoa peek` were not invoked as standalone CLI commands here — `grep -rn` over the
small `app/` tree was faster and gave the same file:line results; every citation below was
verified by direct `Read`).

---

## 0. Headline: `app/renderer/app/CaptureApp.tsx` is the *only* caller

```
$ grep -rln "inference-orchestrator" --include="*.ts" --include="*.tsx" .
app/renderer/app/CaptureApp.tsx
```

No other renderer entry point, test file, or main-process file imports
`InferenceOrchestrator` or references `orchestratorRef`. `SettingsPanel.tsx` talks to the
orchestrator only indirectly, through IPC (`webgpu:model-status`, `webgpu:model-ready`) —
see §7. This makes the blast radius small and fully enumerable.

---

## 1. Complete call-site inventory

### `.initialize()` — 1 call site

**`CaptureApp.tsx:50-77`** (`initWebGpuOrchestrator`, the only caller):
```
const initWebGpuOrchestrator = useCallback(async () => {
    const api = (window as any).electronAPI;
    if (orchestratorRef.current.isReady() || orchestratorRef.current.isLoading()) return;
    try {
      ...
      await orchestratorRef.current.initialize(backend, appVersion);
      initFailRef.current = 0; // success resets the failure/backoff counter
      console.log('CaptureApp: WebGPU orchestrator ready');

      const ipc = (window as any).electron?.ipcRenderer;
      if (ipc) ipc.invoke('webgpu:model-ready', true);
    } catch (e) {
      initFailRef.current += 1;
      console.warn(`CaptureApp: WebGPU orchestrator init failed (attempt ${initFailRef.current}):`, e);
    }
  }, []);
```
- **Today (pre-0a):** `.initialize()` never rejects for a *genuine* init failure (it's caught
  and swallowed inside the orchestrator, see §2). The only way this `catch` at line 73 fires
  today is the synchronous `throw new Error('Already loading')` at
  `inference-orchestrator.ts:44` (still becomes a rejected promise because `initialize` is
  `async`) — see §4 for how that's reachable via a race. Consequence: line 68-72 (the
  `webgpu:model-ready(true)` IPC call) fires **even when the model failed to actually load**,
  because `await initialize()` resolves normally either way.
- **After 0a:** genuine init failures now reject too, landing in the *same* existing `catch`.
  **No new catch is needed here** — the try/catch already wraps the call. What changes is that
  `initFailRef.current += 1` will now fire for real failures (previously it basically never
  did — see §4), and line 72 will no longer fire on failure because the `await` on line 67
  throws before reaching it (this is effectively "the gating" the fix describes; an explicit
  `if (orchestratorRef.current.isReady())` guard before line 72 is still recommended as
  defense-in-depth, see §7).

### `.dispose()` — 1 call site

**`CaptureApp.tsx:119-124`**:
```
useEffect(() => {
  ...
  return () => {
      orchestratorRef.current.dispose();
  };
}, [initWebGpuOrchestrator]);
```
`dispose()` (`inference-orchestrator.ts:119-121`) is `void`, synchronous, never throws. 0a/0b
don't change its signature. **No new catch needed.**

### `.abort()` — 1 call site

**`CaptureApp.tsx:271-276`** (60s safety timeout inside `performStop`):
```
const safetyTimeout = setTimeout(() => {
        console.error('CaptureApp: SAFETY TIMEOUT — processing exceeded 60s, aborting + resetting');
        requestGenRef.current++; // supersede this run
        if (wasRawPcm) orchestratorRef.current.abort();
        resetState(electronAPI);
      }, 60000);
```
`abort()` (`inference-orchestrator.ts:132-134`) is also `void`, synchronous, never throws.
0a/0b don't change its signature. **No new catch needed.** (0b *does* change what happens to
the in-flight `transcribe()` promise this abort was implicitly stalling — see §5.)

### `.disposeSync()` — 0 external call sites

Private method (`inference-orchestrator.ts:136`). Called only from inside the class: the
`device-lost` worker-message listener (`:68`), `dispose()` (`:120`), `abort()` (`:133`), and
the `initialize()` catch block (`:89`). No inventory action needed for external callers.

### `.isReady()` — 4 call sites, all synchronous booleans

`CaptureApp.tsx:52, 279, 454, 487, 489` (489 calls it twice — once for the mode flag, once
again inline in a log string). All are plain `if`/ternary reads. Signature and behavior
(`this.modelReady && this.worker !== null`, `inference-orchestrator.ts:24-26`) are untouched
by 0a/0b. **No new catch needed anywhere.**

### `.isLoading()` — 2 call sites

`CaptureApp.tsx:52, 456`. Same as above — synchronous boolean, untouched signature. Worth
flagging for §3/§6: after 0b, `loading` gets an extra writer (`disposeSync()`), so these two
read sites can now observe a `loading→false` transition triggered from a different call stack
than `initialize()`'s own `finally`. See §3, state B, for the specific hazard this opens.

### `.transcribe()` — 2 call sites, both already guarded

**`CaptureApp.tsx:302`** (first attempt) and **`:309`** (retry-once-on-empty), both inside the
`try` block of `performStop` (`:278-425`), which has a catch at `:406-414` and a `finally` at
`:415-424` that both check `isStale()` before acting. `.transcribe()`'s own error contract
(`inference-orchestrator.ts:100-117`) is not changed by 0a/0b. **No new catch needed** — but
the *error the awaiter sees* changes shape/timing when a `device-lost`/`abort()` happens
mid-transcribe: pre-0b it arrives late (worker-timeout at 120s: `Worker timed out after
120000ms`, `:155`); post-0b it arrives immediately (whatever message `disposeSync()` passes to
the tracked rejector). See §5 for why this doesn't change which branch runs.

**Tally for the "return to me" question: 0 call sites need a *new* `catch`.** Every call site
of every method in this inventory is already inside an existing try/catch or is a method that
cannot throw. The risk after 0a is not "missing catch," it's (a) the un-awaited
`initWebGpuOrchestrator()` invocations (§2) and (b) `initFailRef` semantics changing (§4).

---

## 2. Unhandled-rejection audit

Two fire-and-forget calls to `initWebGpuOrchestrator()` (itself `async`, returns a `Promise`,
never awaited):

- **`CaptureApp.tsx:97`** inside `loadConfig()`'s `if (selectedModelRef.current.startsWith('webgpu-'))` branch.
- **`CaptureApp.tsx:133`** inside the `webgpu:init-orchestrator` IPC listener.

```
const unsub = api.onWebgpuInitOrchestrator(() => {
      console.log('CaptureApp: Received webgpu:init-orchestrator from main');
      initWebGpuOrchestrator();
    });
```

**Verdict: safe, no unhandled rejection risk, before or after 0a.** `initWebGpuOrchestrator`
(`:50-77`) wraps its entire body — including the now-rejecting `await
orchestratorRef.current.initialize(...)` — in a `try { ... } catch (e) { initFailRef.current
+= 1; console.warn(...); }` with **no re-throw**. That means `initWebGpuOrchestrator()`'s own
returned promise *never* rejects, regardless of whether `.initialize()` rejects. The two
un-awaited call sites are therefore not exposed to 0a's new rejection at all — the absorption
happens one level down, inside `initWebGpuOrchestrator` itself, not at the call sites named in
the prompt. This is worth confirming explicitly because it means **0a requires no changes to
`:97` or `:133`** — the existing design already isolates the rejection.

The one place that *does* newly see a rejection is line 67 (`await
orchestratorRef.current.initialize(...)`) inside `initWebGpuOrchestrator` — and it's caught in
the same function, one line away. No other `await`/`.then()` chain touches `.initialize()`.

---

## 3. State-machine table for `InferenceOrchestrator`

Fields: `worker` (`null` | `Worker`), `modelReady` (bool), `loading` (bool), and the proposed
new field `pending` (`null` | the tracked `{resolve, reject}` for the in-flight `sendMessage`
call — assumed to be a single slot, not a queue/array; see note at end of table).

| # | worker | modelReady | loading | pending | Meaning | Reached from |
|---|--------|-----------|---------|---------|---------|---------------|
| A | null | F | F | null | Idle | constructor; clean `disposeSync()` completion |
| B | null | F | **T** | null | Init in progress, *before* worker exists — inside `await prepareModelCache()` (`:53`) | entered at `initialize():47` |
| C | Worker | F | T | present | Init in progress, worker created, awaiting `{type:'init'}` response (`:73-77`) | after `:56-71` |
| D | Worker | T | F | null | Ready / idle | after `:79` succeeds |
| E | Worker | T | F | present | Transcribe in flight | during `transcribe()` `:105-109` |
| F | Worker | F | F | null | **Invalid** — worker exists but is neither loading nor ready | not normally reachable: every failure path that nulls `modelReady` also nulls `worker` in the same `disposeSync()` call |
| G | null | T | any | any | **Invalid** — `modelReady=true` with no worker | not reachable under current code; `isReady()` ANDs both fields (`:24-26`) so even a latent bug here fails safe |

### Q: what happens if `disposeSync()` runs while `initialize()` is between `prepareModelCache()` and worker creation? (state B)

Today, `disposeSync()` in state B is nearly a no-op: `if (this.worker)` is false, so only
`this.modelReady = false` runs (already false). **This is the hazard 0b introduces.** If 0b's
"clear `loading` there" is implemented as an unconditional `this.loading = false` inside
`disposeSync()`, then an *external* `disposeSync()` call during state B (reachable via
`.dispose()` on unmount, or in principle `.abort()`) would flip `loading` back to `false`
**while the in-flight `initialize()` call is still executing** (still inside `prepareModelCache()`
or about to run `if (!this.worker) { this.worker = new Worker(...) }`, `:56-71`).

That reopens the exact race described in §4: `initWebGpuOrchestrator`'s guard
(`orchestratorRef.current.isReady() || orchestratorRef.current.isLoading()`, `:52`) would now
see `isLoading() === false` mid-flight and could legitimately launch a **second concurrent
`initialize()` call**, which would itself pass the `if (this.loading) throw` guard
(`:44`, now also false) and start its own `prepareModelCache()` + worker creation — two workers
racing to become `this.worker`. This is a **reachable-but-invalid state introduced by a naive
0b implementation**, not present today (today `disposeSync()` in state B doesn't touch
`loading` at all, so the original `initialize()` call keeps exclusive ownership of `loading`
until its own `finally` at `:91`).

**Recommendation:** only clear `loading` (and only reject `pending`) inside `disposeSync()`
when `pending` is actually set (i.e., there's a live `sendMessage` in flight to reject).
In state B there is no `pending` yet — `loading` should stay owned by the in-flight
`initialize()` call's own `finally` block. Concretely: `if (this.pending) { this.pending.reject(err); this.pending = null; this.loading = false; }` guarded together, not `this.loading = false` unconditionally.

### Q: what if `device-lost` arrives *after* the init promise already resolved? (state D → disposeSync)

`inference-orchestrator.ts:65-70`:
```
this.worker.addEventListener('message', (event: MessageEvent) => {
          if (event.data?.type === 'device-lost') {
            console.error('[InferenceOrchestrator] WebGPU device lost — tearing down for clean re-init');
            this.disposeSync();
          }
        });
```
In state D, `pending` is `null` (no in-flight `sendMessage`), so 0b's reject-the-pending logic
is a correctly-guarded no-op. `disposeSync()` nulls `worker`, sets `modelReady=false`; `loading`
was already `false`. Clean transition D → A. **This case is safe under both the naive and the
guarded 0b implementation** — it's the in-flight cases (B, C, E) where the guard matters.

**Note on `pending` as a single slot, not a queue:** this is safe *only* because the codebase
never issues two concurrent `sendMessage()` calls today — `initialize()` and `transcribe()`
are both awaited sequentially at every call site (§1), and `initWebGpuOrchestrator`'s own
`isReady()/isLoading()` guard prevents a second `initialize()` from starting while one is
already in flight (modulo the state-B race above). If the fix ever needs to support concurrent
requests, a single `pending` field would silently drop/overwrite one caller's rejector —
worth a defensive assertion (`if (this.pending) throw/log` before overwriting) rather than
silent clobbering, even though it shouldn't trigger under current call patterns.

---

## 4. Re-entrancy: is "Already loading" distinguishable, and does anything depend on that?

**`inference-orchestrator.ts:44`**: `if (this.loading) throw new Error('Already loading');` —
this is a *synchronous* throw at the top of an `async` function, so it already produces a
**rejected promise today**, pre-0a. This is not new behavior from 0a.

**This is genuinely reachable, not just defensive/dead code.** `initWebGpuOrchestrator`'s guard
at `:52` (`if (orchestratorRef.current.isReady() || orchestratorRef.current.isLoading())
return;`) is checked *before* two `await`s — `navigator.gpu.requestAdapter()` (`:57`) and
`api?.getAppVersion?.()` (`:63`) — that both happen **before** `.initialize()` is actually
called at `:67`. If `initWebGpuOrchestrator()` is invoked twice close together (realistic:
mount-time auto-init at `:97` racing the `webgpu:init-orchestrator` IPC listener at `:133`,
e.g. user switches to the WebGPU model in Settings right at app startup), both invocations can
pass the `:52` guard (orchestrator's `loading` is still `false` for both, since neither has
reached `:67` yet) and both eventually call `.initialize()`. Whichever runs second hits `this.loading === true` and gets the `'Already loading'` rejection.

**Consequence today (pre-0a):** `initFailRef.current` is currently incremented **almost
exclusively by this harmless race**, not by genuine model-load failures — because genuine
failures are swallowed inside `.initialize()` and never reach the `catch` at `:73`. The
"give up after 3 failures, need app restart" bounded-recovery logic at
**`CaptureApp.tsx:461`** (`if (initFailRef.current >= 3) ...`) is effectively dead for its
intended purpose today.

**Consequence after 0a:** `initFailRef` starts correctly counting *real* failures (the fix's
intent) — but it will keep *also* counting harmless concurrent-call collisions, in the same
counter, indistinguishable from real hardware/model failures. Two back-to-back legitimate
triggers (mount + a fast Settings switch) could now burn into the 3-strikes budget for a
reason that isn't a real failure, reaching the "give up" state faster than intended.

**Recommendation:** yes, add a typed/distinguishable error (e.g. `class
AlreadyLoadingError extends Error {}` thrown at `:44`), and in the `:73` catch, `if (e
instanceof AlreadyLoadingError)` skip incrementing `initFailRef.current` (log at most). This
is a small, low-risk addition and directly fixes a counter-accuracy regression that 0a would
otherwise make more visible (today the counter is inaccurate but nobody notices because it's
rarely incremented for the right reason).

---

## 5. Interaction with the 60s safety timeout / `requestGenRef` staleness guard

**`CaptureApp.tsx:260-276`**:
```
const myGen = ++requestGenRef.current;
      const isStale = () => myGen !== requestGenRef.current;
      const safetyTimeout = setTimeout(() => {
        console.error('CaptureApp: SAFETY TIMEOUT — processing exceeded 60s, aborting + resetting');
        requestGenRef.current++; // supersede this run
        if (wasRawPcm) orchestratorRef.current.abort();
        resetState(electronAPI);
      }, 60000);
```

Order inside the timeout callback: **generation is bumped first**, then `abort()` (→
`disposeSync()`) runs, then `resetState()`. Two relevant scenarios:

1. **Pre-0b (today):** `abort()`'s `disposeSync()` doesn't touch the pending `transcribe()`
   promise from `:302`/`:309`. That promise sits pending until its own 120s timeout
   (`inference-orchestrator.ts:155`, `Worker timed out after 120000ms`), then rejects into
   `performStop`'s catch (`:406-414`). By then `isStale()` is already `true` (bumped at the
   top of the safety-timeout callback, long before the 120s mark), so the catch's `if
   (!isStale())` guard correctly skips the tray-state stomp, and the `finally`'s `if
   (!isStale())` correctly skips re-clearing flags `resetState()` already cleared. This is
   explicitly anticipated in the code comment at `:408-410`.

2. **Post-0b:** the same `transcribe()` promise instead rejects **immediately**, synchronously
   triggered inside the `setTimeout` callback (via `disposeSync()`'s reject of `pending`), but
   the actual `.catch`/`await`-continuation in `performStop` runs as a **microtask**, scheduled
   after the synchronous `setTimeout` callback body finishes running (i.e., after `abort()` and
   `resetState()` have both already completed). By the time that microtask runs, `isStale()` is
   already `true` (gen was bumped synchronously before `abort()`), so the *same* branch runs as
   in scenario 1 — no double-fire, no new branch. **Net effect of 0b here: the stale rejection
   arrives ~119s sooner (immediately vs. at the 120s worker-timeout), with no change to which
   branch executes.** This is a pure improvement (faster cleanup, no functional risk) — confirmed
   by tracing exact statement order, not just the intent comment.

**No double-fire, no branch change.** The one soft recommendation: since the error message
changes from `Worker timed out after 120000ms` to whatever 0b's `disposeSync()` passes to the
rejector, and `performStop`'s catch (`:407`) logs `error` verbatim via `console.error('CaptureApp: performStop error:', error)` — purely cosmetic, nothing parses this string (confirmed via grep, §"other" below), so no functional dependency on the message text.

---

## 6. Headless Node harness feasibility

**Confirmed: zero test infrastructure exists.** No `*.test.*`/`*.spec.*` files anywhere in the
repo (outside `node_modules`), no `vitest`/`jest` config, and `package.json`'s
`devDependencies` list has no test runner at all — just `typescript`, `vite`,
`@vitejs/plugin-react`, `electron`, `electron-builder`, `tailwindcss`/`postcss`,
`autoprefixer`, `concurrently`. A harness starts from nothing.

**What `initialize()`/`disposeSync()` touch that doesn't exist in plain Node:**

1. **`prepareModelCache()`** (`model-cache.ts:71-100`, called at `:53`) uses:
   - `navigator.storage.persist()` / `.persisted()` (`:22-24`)
   - `indexedDB.open(...)` (`:33`), only actually exercised on a real model-version mismatch
     (`clearParakeetStore()`, `:45-54`) — most test runs won't hit this branch
   - `localStorage.getItem`/`setItem` (`:73`, `:94`)

   None of these are Node globals. **But they're trivially stubbable** — `navigator`,
   `localStorage` can be plain object literals assigned to `globalThis`, and the
   `indexedDB.open` path is only hit on a version-mismatch branch that most `initialize()`
   test scenarios don't need to reach. `fake-indexeddb` (npm) would cover it if needed.

2. **`new Worker(new URL('./inference-worker.ts', import.meta.url), { type: 'module' })`**
   (`inference-orchestrator.ts:57-60`) is the real blocker. Two independent problems:
   - `Worker` is a DOM global; it doesn't exist in Node. Node's `worker_threads.Worker` is a
     *different, incompatible* API: it's an `EventEmitter` (`.on('message', ...)`, no
     `MessageEvent` wrapper — the payload arrives bare, not as `event.data`), whereas
     `inference-orchestrator.ts` uses `.addEventListener('message', (event: MessageEvent) =>
     ...)` and reads `event.data` throughout (`:65-70`, `:158-165`). A `worker_threads.Worker`
     is not a drop-in replacement without an adapter shim.
   - Even with a shim, `new URL('./inference-worker.ts', import.meta.url)` plus `{type:
     'module'}` resolution is a bundler-mediated pattern (Vite rewrites this to an emitted
     worker chunk at build time). Running the raw `.ts` file under plain Node/ts-node doesn't
     get Vite's URL rewrite, so the constructed URL wouldn't point at anything real even if
     `Worker` existed.

**Verdict: not realistic as-is.** Polyfilling `navigator`/`localStorage`/`indexedDB` is cheap
and doesn't require touching source. Polyfilling `Worker` well enough to drive
`initialize()`'s real code path (real `new Worker(url, {type:'module'})` call, real message
round-trip) is not — it would require faking both the DOM Worker constructor *and* Vite's
build-time URL rewrite, which is fragile and high-maintenance for a headless-Linux-testing-a-
Windows-app project that has no bundler-in-test setup today.

**Minimal seam that would make it testable:** inject a worker factory. Concretely, add an
optional constructor parameter to `InferenceOrchestrator`:
```ts
constructor(private workerFactory: () => WorkerLike = () =>
  new Worker(new URL('./inference-worker.ts', import.meta.url), { type: 'module' })) {}
```
where `WorkerLike` is a narrow interface (`postMessage`, `addEventListener`,
`removeEventListener`, `terminate`) matching only what `inference-orchestrator.ts` actually
uses. Production code passes nothing (default = real DOM `Worker`); a Node/Vitest harness
passes a fully in-memory fake implementing `WorkerLike` that the test controls directly —
letting it script `postMessage({type:'ready'})`, `postMessage({type:'device-lost'})`, or a
never-responding worker to exercise every state-machine transition in §3 without touching
`indexedDB`/`Worker`/bundler URL resolution at all. This is a **small, additive, low-risk
refactor** (one constructor param with a default) — it does not change any of the six public
method signatures audited in §1, so it's orthogonal to 0a/0b and could ship in the same PR or
a follow-up without re-auditing callers.

`navigator.storage`/`localStorage` do **not** need a DI seam — global stubbing in the test
setup file is sufficient and standard practice, since `prepareModelCache()` reads them as
ambient globals already (no refactor needed there).

---

## 7. Secondary consequence found while tracing: `webgpu:model-ready` gates real cross-process state

Not part of the six audited methods, but directly relevant to why "gate the IPC" (0a) matters
beyond CaptureApp itself: `ipc.invoke('webgpu:model-ready', true)` at **`CaptureApp.tsx:72`**
flows to **`app/stt/engine-manager.js:499-502`**:
```
ipcMain.handle('webgpu:model-ready', async (_event, ready) => {
      this.webgpuAdapter.modelManager.setReady(ready);
      return { success: true };
    });
```
which sets `WebGpuModelManager._ready` (**`app/stt/webgpu-model-manager.js:18-25`**), which
directly backs `isModelDownloaded()`/`getDownloadState()` — consumed by
**`SettingsPanel.tsx:370`**'s polling loop (`webgpu:model-status`) that flips the model card
from "Downloading…" to "loaded" in the UI. **Today**, because `:72` fires unconditionally
after `await initialize()` resolves (which it always does, per §1/§2), a failed model load
would still tell the Settings UI the model is ready — a real, currently-shippable UI bug that
0a's IPC gating fixes as a side effect of the re-throw (line 72 simply won't be reached on
failure once `:67` throws). This confirms the fix's IPC-gating half is not cosmetic — it closes
a real state-desync between the renderer's `InferenceOrchestrator` and the main process's
`WebGpuModelManager`.

---

## Answers to the specific return-to-me questions

- **Call sites needing a new `catch`: 0.** Every one of the 7 call sites across the 6 public
  methods (§1) is already inside an existing try/catch, or calls a method that cannot throw
  (`dispose`, `abort`, `isReady`, `isLoading` are all synchronous/void; `disposeSync` is
  private with no external callers). The two un-awaited `initWebGpuOrchestrator()` invocations
  (`:97`, `:133`) are safe because `initWebGpuOrchestrator` itself fully absorbs the rejection
  one level down and never re-throws (§2).
- **Invalid state reachable after the change:** yes — if 0b clears `loading` in `disposeSync()`
  *unconditionally* (rather than only alongside rejecting a live `pending`), an external
  `dispose()`/`abort()` landing during the `prepareModelCache()` window (state B in §3) can
  reopen the `loading`-guard and let two `initialize()` calls run concurrently, each creating
  its own `Worker`. Recommendation: gate the `loading` clear on `pending` being non-null.
- **Typed error needed:** yes — `'Already loading'` is a real, reachable race (mount-time
  auto-init vs. the `webgpu:init-orchestrator` IPC listener, §4), not dead code, and after 0a it
  shares a counter (`initFailRef`, 3-strikes give-up logic at `CaptureApp.tsx:461`) with genuine
  init failures for the first time in a way that actually matters (today the counter rarely
  reflects real failures at all). Recommend a distinguishable `AlreadyLoadingError` excluded
  from the failure count.
- **Headless harness feasible without refactoring: no.** `navigator`/`localStorage`/`indexedDB`
  are cheaply stubbable, but the real DOM `Worker` + Vite-rewritten `import.meta.url` construct
  is not something plain Node (or Node+jsdom) can satisfy — Node's `worker_threads.Worker` is
  API-incompatible (`EventEmitter` vs `addEventListener`/`MessageEvent.data`), and there's no
  bundler in the test path to resolve the worker URL. A one-parameter constructor-injected
  worker factory (default = real `Worker`, test = in-memory `WorkerLike` fake) is the minimal
  seam that makes 0a/0b's state transitions testable, and it doesn't touch any of the six
  audited method signatures.
