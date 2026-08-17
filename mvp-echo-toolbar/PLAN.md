# Corrective plan — first-run experience

_Written 2026-08-17 after a long session on `electron-43`; restructured the same day once Phase 1.1
landed and the Phase 2 recon came back. Authoritative for what comes next. `BRIDGE.md` is the state
summary; this is the work. Live task list: `#1`–`#11` (see the phase sections)._

## The goal, in the maintainer's words

> "Making the tool work often, offering all of the possible states that a user would want in a
> communicated way to set expectations and not create frustration."

The GPU model lands on a user's machine in under 30 seconds, downloads once ever, and the user is
never left guessing what is happening. Today it is ~90 seconds of silence with a dead hotkey. That
is the worst moment in the product.

---

## Confidence — what every claim in this document is worth

Every status below carries one of these. They are not decoration: rule 1 and rule 2 exist because
a **Probed** result was once treated as **Verified**, and a transport error was treated as a
capability verdict.

| Mark | Means | What it licenses |
|---|---|---|
| **Verified** | Ran on a real Windows build, observed in a log | Shipping it on by default |
| **Probed** | Ran headlessly against the real system (Electron/Chromium/ORT), not on Windows | Building on it, behind a flag |
| **Tested** | Unit tests only; the module is right, the wiring is unproven | Merging it, not enabling it |
| **Assumed** | Reasoned from reading code | Nothing. Write a probe first |

The gap between **Probed** and **Verified** is where the expensive mistake lives. Every Windows
defect this branch found was in the WIRING between modules, never in the modules themselves.

### Direction

These are signposts, not gates. They point at "fast enough and clear enough to feel good to use."
**Nothing here should ever be rewritten to buy a second.** A wait the user understands is not a
problem; a wait they don't is the entire problem.

| Where we're heading | Now | Confidence | Phase |
|---|---|---|---|
| GPU model arrives in seconds, not minutes | ~90s | Measured | 1 |
| Downloads **once, ever** | store built, off by default | Probed | 1 |
| **Every state communicated** — no silent waits | 90s of "loading", dead hotkey | Verified | 2 |
| **Least VRAM** | 1.5 GB (was 4) | Verified | ✅ |
| Fast transcription | 12.3× realtime | Verified | ✅ |
| **The user's selection is never overridden** | holds | Verified | ✅ |
| Every engine works and is exercised | only GPU tested on this build | — | 3 |
| **No third-party code fetched at runtime** | ORT pulled from jsdelivr every cold start | Verified | 3 |

---

## What is true right now

`electron-43`, 12 commits ahead of `dev`. **248 tests.** `npm run typecheck && npm test &&
npm run build` all green.

**Verified on Windows:**
- fp16 encoder — 1,182 MB, **1.5 GB VRAM vs 4 GB**, chosen per machine from
  `adapter.features.has('shader-f16')` with an fp32 fallback.
- GPU transcription 377–889 ms; 10.9 s of audio in 889 ms.
- Selection persists across restart; nothing overrides an explicit choice.
- A GPU press while the model is loading **blocks and says why** — it does not silently
  transcribe on another engine. (It says the wrong thing, and only to the console — see Phase 2.)
- Endpoint status reports only what was observed, never "Connected" for a typed URL.

**Probed, and switched OFF behind `--model-store`:**
- `app/main/model-server.js` — loopback file server, 35 tests. Replaces the `model://` scheme.
- `app/main/model-downloader.js` — parallel range + multi-part downloader, 22 tests.
- `app/main/model-store.js` — manifest, `%LOCALAPPDATA%` paths, size-verified completeness,
  variant pruning, single-flight, 25 tests.
- Release assets published and **measured end to end**: fp32 19.6 s, fp16 10.8 s, int8 6.8 s;
  second run 0.00 s, no network.
  `https://github.com/mvp-scale/mvp-echo-toolbar/releases/tag/models-parakeet-tdt-0.6b-v2`
- Evidence for the serving layer: `_review/LOOPBACK-PROBE.md`. A real `file://` module worker
  fetches `http://127.0.0.1` byte-identically, streams >1 GiB with an exact `Content-Length`, and
  **onnxruntime-web creates a real `InferenceSession` off a loopback URL**.

**Why `model://` was abandoned:** Chromium refuses a cross-origin fetch from a `file://` document
to anything outside `chrome`, `chrome-extension`, `chrome-untrusted`, `data`, `http`, `https`.
`supportFetchAPI` makes a scheme fetchable but the initiator-origin check runs first. Shipping it
on by default replaced a working path with a broken one and cost a user their 1.2 GB encoder.

---

## Rules for this work, learned the hard way

1. **Never default-enable an unproven mechanism.** Behind a flag until a build proves it on
   Windows. Two mechanisms shipped unproven; both failed and one was destructive.
2. **A transport error is not a capability verdict.** A blocked fetch was read as "fp16 is broken",
   which deleted a good 1.2 GB file and started a 2.4 GB download.
3. **Bounds live at the resource, not the caller.** A failed init reported not-ready → record
   changed → broadcast → re-init → failed. 61 attempts. The caller's 3-strike guard covered only
   one of three call sites.
4. **Enumerate what a user can do DURING any operation with duration.** Press again, switch, quit.
   Two bugs were re-entry: concurrent downloads racing a `.part` file, and a superseded model
   switch still loading 1.2 GB.
5. **Windows is in the loop, not a formality.** Both re-entry bugs were invisible on Linux — POSIX
   renames open files happily and produces silent corruption instead of an error.

---

## How we work — the test-driven structure

Not a methodology to announce. A shape every task in this plan follows, because each step of it
was paid for by a specific failure.

### The four steps, in order

**1. Probe the unknown first, with the smallest thing that answers it.**
Before building on a mechanism, prove the mechanism. The loopback server started as a 40-line
Electron probe that answered one question — *can a `file:// `worker fetch `http://127.0.0.1`?* —
and it also refuted the assumption that CORS headers were needed. Probes live in `_review/` and are
committed, because the next person will ask the same question.

**2. Test the pure derivation before the wiring exists.**
Every user-visible state in this app is derived by a pure function that needs no DOM, no Electron
and no GPU. These are the TDD surfaces — write the assertion first, in the file named here:

| Surface | Signature | Test file |
|---|---|---|
| `engine-status-label.ts:79` | `statusLabel(state) → {label, tone, detail}` | `test/engine-status-label.test.mjs` |
| `engine-status-label.ts:55` | `endpointStatusLabel({url, testing, probe})` | `test/engine-status-label.test.mjs` |
| `capture-plan.ts:66` | `planCapture(state, {orchestratorReady}) → {…, blocked, reason}` | `test/capture-plan.test.mjs` |
| `engine-state.js` | `select/applyGpu/restore/applyModelReady` | `test/engine-state.test.js` |
| `tray-flash.ts:38` | `createTrayFlasher({setState, generation, timers})` | `test/tray-flash.test.mjs` |

If a new behaviour cannot be expressed as an assertion against one of these, it is probably being
put in the wrong layer.

**3. Probe the seam, not just the units.**
Every defect the Windows rounds found was in the wiring between modules, never in the modules
themselves. The pure logic had tests and was right; the seams had none. A unit test that the store
returns a URL and a unit test that the server serves a file prove nothing about the two together —
`_review/loopback-probe/` runs the real store against the real server through a real worker.

**4. The gate is three commands, then Windows.**

```
npm run typecheck && npm test && npm run build
```

Build is not optional: a CommonJS/ESM mismatch once passed the other two and still broke the
bundle. Green at every commit.

And then, separately and named as its own step: **a Windows acceptance run**. A passing probe is
not a passing build. Nothing is enabled by default until a real build has done the thing.

### What this rules out

- Enabling something because its tests pass. Tests are step 2; shipping needs step 4.
- Writing UI for a state before the state exists as a tested pure value.
- Marking a task done with a manual checklist unrun. If it stays manual, it says so.

---

# Phase 1 — Get the model there _(the 30s target)_

**Why first:** it is the single worst customer moment. 90 s of silence on first run.

### 1.1 Loopback file server — ✅ DONE, confidence: **Probed**

`app/main/model-server.js`. Ephemeral port on `127.0.0.1`, one directory, per-session random path
token, `basename()` confinement, `Host`-header check, exact `Content-Length`, range support.
`ensureModel` no longer builds URLs — it takes a `urlFor` and throws *before downloading* if it is
missing. 35 tests; suite 212 → 248. Full evidence in `_review/LOOPBACK-PROBE.md`.

### 1.2 Verify on Windows — task **#1** — confidence gate: Probed → **Verified**

`& ".\<exe>" --diag --model-store`

**Acceptance:** log shows `ModelStore: serving fp16 on 127.0.0.1:<port>` and `source=disk`; the
worker loads; a transcription succeeds; a **second launch downloads nothing**.

### 1.3 Turn the store on by default — task **#2** — blocked by #1

Flip `preload.js:8` to `--no-model-store` as the escape hatch. The flag parse is a pure function;
test it before touching preload.

**Acceptance:** a first run on the XPS feels fast and never looks stuck. Measured download is
10.8 s against ~90 s today — record the number so we know where we are, but the number is not the
pass mark. Combined with #9 the user should not perceive a wait at all.

### 1.4 Prefetch at first launch — task **#9** — blocked by #2, #5

The item that actually delivers the goal. The CPU engine is bundled and works immediately, so
fetch the GPU model in the background before the user ever selects GPU. **This is what turns 11 s
into zero perceived wait.**

Rule 4 applies hardest here, because it runs unrequested: selecting GPU mid-prefetch must join the
in-flight download (`model-store.js:141` is single-flight — prove it covers this path), quitting
mid-prefetch must leave no corrupt `.part`, and a 1.2 GB unrequested download on a metered
connection is a consent question that gets answered explicitly rather than assumed.

### Done — Phase 1

**The model gets there, and it only ever gets there once.**

- A first run on a clean Windows profile feels fast, and never looks stuck
- A second run touches **no network at all** — read it from the log, don't infer it
- Selecting GPU after the app has been open a minute is instant
- Killing the app mid-download and relaunching recovers — no corrupt file, no starting over
- `--no-model-store` still reaches the old hub path, so there is a way back
- Gate green

---

# Phase 2 — Never leave the user guessing _(the frustration target)_

**Why:** even at 11 s, a silent wait with a dead hotkey is the wrong experience. At 90 s it is
unacceptable.

**The recon changed the shape of this phase.** It reads like adding an enum value. It is not.

### 2.1 Decide the single source of truth — task **#3** — confidence: **Verified** (read from code)

**Four disconnected state machines** describe "is the model coming down", and none talk to each
other:

| # | Where | Vocabulary | Problem |
|---|---|---|---|
| 1 | `engine-state.js:60,76-79,162` | `ready\|loading\|unusable\|unknown` | no `downloading` at all |
| 2 | `inference-orchestrator.ts:41-42` | `modelReady`/`loading` booleans | no progress field whatsoever |
| 3 | `webgpu-model-manager.js:33-35` | `completed\|idle` | never emits `downloading` — which makes `webgpu-bridge-adapter.js:201`'s `downloading` branch **dead code** |
| 4 | `SettingsPanel.tsx:8` | has `'downloading'` already | optimistic, set at click time (line 444), not derived from bytes |

**Deliverable: a written decision in `_review/`, no code.** Which one owns the fact, how the other
three derive from it, and whether the tray starts listening to `engine:state` (it does not today —
tray state comes from ad-hoc call sites only). Writing UI before this decision just produces a
fifth vocabulary.

### 2.2 `downloading` + percent in the pure layer — task **#4** — blocked by #3

Today `loading` covers both "warming a cached model (~20 s)" and "fetching 1.2 GB (~90 s)".

**Tests first**, all pure, no DOM: `engine-state.js` produces it; `statusLabel()`'s switch
(`engine-status-label.ts:86`) renders it; percentage **formatting** is covered explicitly (0, 47,
100, absent). `capture-plan.ts:41` mirrors the status union by hand — add a sync assertion beside
the existing `FALLBACK_MODEL` one (`capture-plan.test.mjs:169`) or the two copies drift.

**Acceptance:** `downloading` is distinguishable from `loading` and from `unusable` in pure tests,
before anything renders it.

### 2.3 Wire real bytes into the record — task **#5** — blocked by #4

**Both progress signals are dead today:**

- **Path A** (loopback store): emitted `main-simple.js:600-603`. Not in preload. Zero listeners.
- **Path B** (parakeet hub, the one that runs today): `inference-worker.ts:126` →
  `inference-orchestrator.ts:324-331`, which rearms a stall timer, `console.log`s, and **drops it**.

Feed or delete `webgpu-model-manager.js:33-35` so the dead branch at
`webgpu-bridge-adapter.js:201` either works or goes. Rule 4: press, switch, quit — each covered.

### 2.4 Tell the truth on a blocked press — task **#6** — blocked by #4

**Worse than previously recorded.** `capture-plan.ts:93` produces
`'GPU model still loading — it will be ready shortly'` for both a 20 s warm and a 90 s download —
then `CaptureApp.tsx:688-695` sends it to **`console.warn` only**. The single user-visible signal
is `trayFlashRef.current('error')`: the same red blink used for genuine failures, reverting after
3 s. Press the hotkey during a download today and you get a red error and no explanation.

Different sentences for different states — "Downloading GPU model — 47%, about 40 s left" vs
"GPU model loading" — derived purely in `planCapture`, asserted as distinct strings before
`CaptureApp` is touched, and **routed to a surface a user can see**.

Cleanup while here: `CaptureApp.tsx:647-654` still claims `planCapture` "no longer refuses the
press". That was reverted by `91a1d10`. The comment contradicts the code.

### 2.5 Tray and Settings — tasks **#7**, **#8**

Tray (`tray-manager.js:11-22`) has six states and no `downloading`; it is icon + tooltip only, so a
percentage goes in the tooltip or nowhere. A downloading state must not be swallowed by the 3 s
auto-revert `done` uses (`tray-manager.js:112-115`). `starting` and `error` are defined with no
live call site — confirm or remove.

Settings (`SettingsPanel.tsx:107-111`) renders "Downloading..." with the subtext **"check console
for progress"**. The UI itself admits progress is not surfaced.

### Done — Phase 2

**At no point is the user looking at a screen that doesn't tell them what is happening.**

- A wait always says what it is waiting for, and roughly how long
- A download reads as a download — never as an error
- Pressing the hotkey during a wait gets an honest answer, on screen, not in a console
- **No string in the product tells anyone to open a console**
- One owner for download state, decided and written down — no fifth vocabulary
- `webgpu-bridge-adapter.js:201` is live code or deleted, not unreachable
- Gate green

---

# Phase 3 — Prove every path, and be genuinely offline _(the trust target)_

### 3.1 Exercise every engine and transition — task **#11** — blocked by #2

Only the GPU path has been tested on this build.

| Engine | Id | Path to check |
|---|---|---|
| CPU | `local-fast` (`local-sidecar-adapter.js:13`) | bundled, no download, offline on a fresh profile |
| GPU | `webgpu-parakeet-0.6b` (`webgpu-bridge-adapter.js:86`) | fp16 on `shader-f16`, fp32 without |
| Hosted | `remote-adapter.js:54` | saves, survives a Settings reopen, transcribes, honest label |

Plus the transitions, which is where every bug lived: switch mid-download, mid-recording, and
rapidly back and forth; press the hotkey during download, load and switch; restart on each engine;
kill mid-download and relaunch. Six config files under `userData` must survive all of it —
`engine-state.json`, `local-sidecar-config.json`, `webgpu-adapter-config.json`,
`toolbar-endpoint-config.json`, `app-config.json`, `welcome-config.json`.

Live endpoint for the hosted path: `http://192.168.1.169:20300/v1/audio/transcriptions`, key
`sk-test`.

**Deliverable:** the list, run and **recorded**, in `_review/`. Tier-3 items stay a manual
checklist and are **named as such** rather than implied to be covered.

### 3.2 Stop fetching onnxruntime-web from a CDN — task **#10** — independent, ready now

An offline, privacy-first app pulls third-party executable code from `cdn.jsdelivr.net` on every
cold start. **It is not the config-only fix this was assumed to be:**

- `parakeet.js/src/backend.js:53-61` defaults `wasmPaths` to the CDN when unset.
- `wasmPaths` **is** a first-class forwarded param (`parakeet.js:137` → `:160`); it takes a prefix
  string or `{wasm, mjs}`. We simply never pass it — repo-wide grep returns nothing.
- Version is **1.24.1**, transitive via parakeet.js, not in our `package.json`.
- **The catch:** the build emits `ort-wasm-simd-threaded.jsep-*.wasm` (24.9 MB) but **not** the
  required `ort-wasm-simd-threaded.jsep.mjs` loader — ORT references it through a runtime string
  Vite cannot statically trace, so it is silently never copied. Pointing `wasmPaths` at `dist`
  today would 404.

One build-copy step plus one object literal at `inference-worker.ts:84`, served over the existing
loopback server.

**Probe first:** extend `_review/loopback-probe/` — set `wasmPaths` to the loopback `{wasm, mjs}`,
create a session, and assert **zero requests reach jsdelivr.net**.

### Done — Phase 3

**Every path has actually been used by a person, and nothing phones home.**

- Every engine and every transition in 3.1 run on Windows and written down in `_review/`
- Anything still manual is named as manual, not implied covered
- A cold start fetches nothing from the internet but the model itself
- Gate green

---

## Definition of done

The maintainer's, unchanged since the start of this work:

> "Making the tool work often, offering all of the possible states that a user would want in a
> communicated way to set expectations and not create frustration."

Which means the project is finished when:

1. **It works when you reach for it.** Every engine, every time. No dead hotkey.
2. **You can always tell what it is doing.** Never a silent wait. A wait you understand is fine;
   a wait you don't is the whole problem.
3. **Your choice stands.** Nothing switches engines behind your back.
4. **It downloads once, ever.**

And, as the standing conditions on getting there:

- `npm run typecheck && npm test && npm run build` green at every commit
- Nothing enabled by default that has not loaded a model on a real Windows build

**On the numbers.** Thirty seconds is a direction, not a gate — it names where "fast enough to
feel good" lives. A *communicated* 31 seconds is a win. A *silent* 29 seconds is not. If a change
would cost a rewrite to buy a second, it is the wrong change; go make the wait legible instead.
That is the whole reason ~90 s is unacceptable today — not the 90, the silence and the dead hotkey.

---

## Deferred, with reasons

Not blocking. Recorded so they are not rediscovered as if new.

- **Parallel chunk decoding.** `long_audio.js:364` runs chunks sequentially. `BRIDGE.md` records
  performance as **settled** — 100× realtime on the 3090 Ti, 12.6× on the XPS; a 2-minute
  dictation is ~1.2 s and ~9.5 s, and typical recordings are 1–8 s and never chunk. Reopen only
  with a new symptom, and measure before building. Note WebGPU **cannot** measure VRAM (an
  allocation probe returned 12,288 MB on a 4,096 MB card) — attempt and fall back, never predict.
- **fp16 accuracy is unverified.** Nobody has diffed a transcript between fp16 and fp32. One
  `--replay` file, both quants, diff the output.
- **The hosted server is a deployment problem, not a code one.** `mvp-stt-docker` v3.0.0 has
  everything; `192.168.1.169:20300` runs v1.0.0 — hence the `/v1/models/switch` 404 and the missing
  health fields. **It also has no working authentication:** `POST /v1/audio/transcriptions` returns
  200 with no key and with a wrong key. Detail in `_review/DOCKER-SERVER-NOTES.md`.
