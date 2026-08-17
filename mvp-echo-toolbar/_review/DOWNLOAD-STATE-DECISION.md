# Decision — who owns "the model is downloading, N%"

_2026-08-17. Task #3, PLAN.md Phase 2.1. Produced by three independent designs (minimal-change /
single-owner / UX-first) and one adversarial review. This is the decision; #4–#8 implement it._

## The decision

**`app/stt/engine-state.js` owns it, written through exactly one method,
`EngineManager.reportDownloadProgress()`. Nothing else stores a byte count.**

All three architects converged on this owner independently, so the ownership question is settled
rather than chosen. What follows is the hardening the review added on top.

```js
// engine-state.js
status: 'ready' | 'loading' | 'downloading' | 'unusable' | 'unknown'
progress: { loaded, total, pct, at } | null

applyDownloadProgress(state, { modelId, loaded, total, pct }) {
  const next = { ...state, rev: state.rev + 1 };
  if (next.modelId !== modelId) return next;   // WHAT THIS DOWNLOAD IS ABOUT
  return { ...next, status: 'downloading', reason: null, progress: { loaded, total, pct, at: Date.now() } };
}
```

**The guard keys on `modelId`, not `state.engine === 'webgpu'`.** All three designs copied
`applyModelReady`'s engine check (`engine-state.js:161`). That is the RC-1 shape — routing on what
is *currently active* rather than what the *operation is about* — and it would have been the sixth
instance in this codebase. Keying on `modelId` also drops late ticks from a superseded init for
free, and means a background prefetch (#9) for an unselected model is invisible by construction.

## The four machines

| Machine | Fate |
|---|---|
| `engine-state.js` | **Owner.** +1 status, +1 field, +1 pure fold, +2 invariants |
| `inference-orchestrator.ts:41-42` | **Conduit.** Stores nothing new; `modelReady`/`loading` untouched — CaptureApp's synchronous re-entry checks depend on them |
| `webgpu-model-manager.js:33-35` + `webgpu-bridge-adapter.js:196-203` | **Deleted**, in order (see below) |
| `SettingsPanel.tsx:8` `ModelState` | **Derived for the number only.** Keeps click-time optimism and its poll; only the subtext changes |

Deletion order matters — `getDownloadState()` has a live call site the UX-first design missed:
`engine-manager.js:808` puts it in the `webgpu:model-status` payload SettingsPanel polls every 2 s.
Drop the dead branch (`webgpu-bridge-adapter.js:196-203`), then `extra.downloadState` (`:212`),
then the field at `engine-manager.js:808` (SettingsPanel reads only `status.downloaded`), then the
method itself.

## Two invariants at the record — the defect all three designs shipped

In `withStatus()` (`engine-state.js:75-80`), which `select`/`applyGpu`/`restore` all funnel through:

- `'downloading'` is **webgpu-only** — any other engine collapses it to `'unknown'`
- `progress` is non-null **iff** `status === 'downloading'`
- `restore()` normalizes a persisted `'downloading'` to `'unknown'` — nothing is in flight at boot
- `applyModelReady()` clears `progress` on both branches

**Why this is load-bearing:** `switchModel()` calls `_saveEngineState()` at
`engine-manager.js:573`, and `select()` passes `status` straight through today
(`engine-state.js:79` only rewrites `'unusable'`). So switching GPU→CPU at 47% writes
`{engine:'local', status:'downloading', progress:{pct:47}}` to disk, and after a restart the popup
says **"Downloading CPU model — 47%" forever, with nothing downloading.** Two designs cleared
`progress` but not `status`; one cleared neither.

## One new pure module — the percentage must only move forward

`app/renderer/app/webgpu/download-progress.ts` — `createProgressAggregator()`, ~30 lines, a Map of
file → `{loaded, total}`, emitting only when the aggregate integer pct changes.

`inference-worker.ts:118-127` computes pct **per file**, and parakeet fetches several. Forwarding
it raw shows the user 0→100% two or three times per download. This repo already ruled on this exact
shape — `test/model-store.test.js:188`: *"per-file progress that resets to 0 reads as a stuck
download"* — which is why `model-store.js` aggregates. Path B never learned it.

The aggregator is also where the bound lives, at the resource that emits: ≤101 forwards per
download instead of tens of thousands. `arm()` (`inference-orchestrator.ts:329`) still fires on
every **raw** tick — throttling the stall timer would kill a slow-but-alive download as hung.

## How bytes arrive — two producers, one writer, mutually exclusive by construction

- **Path B** (hub, runs today): `inference-worker.ts:126` → orchestrator `:328` → aggregator →
  `onProgress` → CaptureApp invokes `webgpu:download-progress` → new handler beside
  `webgpu:model-ready` (`engine-manager.js:814`) → `reportDownloadProgress()` → `_applyState()` →
  the existing broadcast at `main-simple.js:782-788`.
- **Path A** (store, behind `--model-store`): its `onProgress` already runs in main, in
  EngineManager's own process — replace the dead `webContents.send` at `main-simple.js:600-603`
  with a direct call. No IPC hop. Already cumulative (`test/model-store.test.js:179-188`).

They can never both fire: `inference-worker.ts:81-92` takes the `fromUrls` path when `urls` is
present and passes **no** progress callback; only the `fromHub` path has one.

Progress is **never persisted** — the new handler does not call `_saveEngineState()`.

## The strings a user actually sees

```
statusLabel        progress null   → 'Downloading GPU model…'
                   pct 47          → 'Downloading GPU model — 47%'      tone: busy
                   'loading'       → 'Loading GPU model…'               (NEVER a number)

planCapture        downloading+pct → 'Downloading GPU model — 47%. Press again when it is
                                      ready, or switch to CPU in Settings.'      blockedKind: wait
                   downloading     → 'Starting the GPU model download. Press again shortly…'  wait
                   loading         → 'GPU model still loading — it will be ready shortly'     wait
                   gpu unusable    → 'GPU unavailable — select the CPU engine in Settings'    error

Settings card      '47%' / 'starting…'   ("check console for progress" is deleted)
Tray               STATES.downloading, reusing tray-processing.png; ' — 47%' in the tooltip
```

`loading` never carries a number: a warm cache moves no bytes, so inventing a percentage for it is
the silent-29-seconds failure with extra steps.

## The blocked press — AMENDED, minimal and inline

The reviewer proposed force-showing the popup (`ipcMain.handle('popup:show')`). **Dropped on the
maintainer's call: minimal UI changes, inline, consistent.** A window stealing focus while someone
is typing in another app is hostile, and the reviewer had already flagged it as its own judgement
call rather than something any of the three designs asked for.

What ships instead uses only surfaces that already exist:

- the tray leaves the red `error` icon alone for a wait and shows the busy icon, reverting to the
  true baseline rather than to a false `ready`
- the tray tooltip carries the live percentage
- the popup, when open, already renders `statusLabel(state)` via `StatusIndicator.tsx:22` — so it
  shows the honest sentence live, with **no new code at all**

**Honest consequence:** the full sentence is one hover or one click away rather than pushed at the
user. The immediate acknowledgement of a refused press is the tray icon changing, not a window.
If that proves too quiet on Windows, the escalation is `showInactive()` plus a short auto-hide —
still no focus theft.

## The tray stays single-writer

The renderer remains the only lifecycle writer (`main-simple.js:926-932` documents this).
CaptureApp keeps a `baselineRef` derived from `engine:state` and passes
`{revertTo: baselineRef.current}` to every flash — `tray-flash.ts:34` already supports it.

Two designs drove the tray from main's broadcaster on every tick. That is a second writer to a
single-writer surface, and it is reachable today: switch to CPU at 47% (the download is
deliberately *not* torn down, `CaptureApp.tsx:305-320`), start a CPU recording, and the next 1%
tick overwrites `recording` with `downloading`. Separately, `tray-flash.ts:55` defaults
`revertTo: 'ready'`, so any 3 s flash during a 90 s download ends with the tray asserting **Ready
while the hotkey is still blocked**.

## Five commits, each green against the gate

1. **The record learns `downloading`, and cannot lie about it later** — `engine-state.js` only, no
   wiring. Asserts the modelId guard (the RC-1 case) and the GPU→CPU-at-47% persistence case.
2. **A percentage that only ever moves forward** — the aggregator, imported by nothing. Asserts a
   two-file stream never re-emits 0%, and that 30,000 raw ticks produce ≤101 emissions.
3. **Three different waits say three different things** — `statusLabel` + `planCapture`, still
   unwired. Asserts the literal strings, and adds a status-union sync assertion beside the
   `FALLBACK_MODEL` one at `capture-plan.test.mjs:169`.
4. **Real bytes reach the record** — orchestrator `onProgress`, IPC, preload allowlist, Settings
   prop. `test/ipc-contract.test.js` is what proves handler/allowlist/invoke agree.
5. **A download reads as a download** — `popup:show`, tray `downloading` + `revertTo`, Path A
   wired, the four deletions in order.

Then the Windows acceptance run, named separately: **watch the percentage climb once, without
resetting, on a real cold download.**

## Deliberately not doing

No ETA math (`progress.at` is reserved for it). No `applyDownloadFailed` or transport-vs-capability
classification in CaptureApp's catch block — the gap is real (`engine-state.js:162` collapses every
failure into `loading` forever) but a misclassification there marks a working GPU unusable on a
network blip, which is PLAN rule 2 and cost a user 1.2 GB. **That is the recommended next task,
with its own risk budget.** No rewrite of `handleSelectModel` or its poll. No new tray icon. No
prefetch (#9). No change to `--model-store` defaults (#1/#2).

## Size

11 files, 1 new pure module, 1 new test file, ~170 lines of production code, ~25 new test cases.
One focused day, plus the Windows run.
