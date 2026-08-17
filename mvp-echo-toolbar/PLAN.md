# Corrective plan — first-run experience

_Written 2026-08-17 after a long session on `electron-43`. Authoritative for what comes next.
`BRIDGE.md` is the state summary; this is the work._

## The goal, in the maintainer's words

> "Making the tool work often, offering all of the possible states that a user would want in a
> communicated way to set expectations and not create frustration."

Concretely, and these are targets not aspirations:

| Target | Now | Status |
|---|---|---|
| GPU model on a machine in **under 30s** | ~90s | ❌ |
| Downloads **once, ever** | re-downloads when browser storage drops it | ❌ |
| **Every state communicated** — no silent waits | 90s of "loading" and a dead hotkey | ❌ |
| **Least VRAM** | 1.5 GB (was 4) | ✅ |
| Fast transcription | 12.3× realtime | ✅ |
| **The user's selection is never overridden** | holds | ✅ |
| Every engine works and is exercised | only GPU tested on the current build | ❌ |

---

## What is true right now

HEAD is `7974adc` on `electron-43`, 11 commits ahead of `dev`, all pushed. 212 tests;
`npm run typecheck && npm test && npm run build` all green.

**Working and verified on Windows:**
- fp16 encoder — 1,182 MB, **1.5 GB VRAM vs 4 GB**, chosen per machine from
  `adapter.features.has('shader-f16')` with an fp32 fallback.
- GPU transcription 377–889 ms; 10.9 s of audio in 889 ms.
- Selection persists across restart; nothing overrides an explicit choice.
- A GPU press while the model is loading **blocks and says why** — it does not silently
  transcribe on another engine.
- Endpoint status reports only what was observed ("Reachable · 1 model", "Key rejected"),
  never "Connected" for a typed URL.

**Built, tested, and switched OFF (`--model-store`):**
- `app/main/model-downloader.js` — parallel range + multi-part downloader, 19 tests.
- `app/main/model-store.js` — manifest, `%LOCALAPPDATA%` paths, size-verified completeness,
  variant pruning, single-flight, 24 tests.
- Release assets published and **measured end to end**: fp32 19.6 s, fp16 10.8 s, int8 6.8 s;
  second run 0.00 s, no network.
  `https://github.com/mvp-scale/mvp-echo-toolbar/releases/tag/models-parakeet-tdt-0.6b-v2`

**Why it is off:** `model://` cannot work. Chromium refuses a cross-origin fetch from a `file://`
document to anything outside `chrome`, `chrome-extension`, `chrome-untrusted`, `data`, `http`,
`https`. `supportFetchAPI` makes a scheme fetchable but the initiator-origin check runs first.
Shipping it on by default replaced a working path with a broken one and cost a user their 1.2 GB
encoder. **`http://127.0.0.1` IS on that list** — a loopback server is the fix.

---

## Rules for this work, learned the hard way tonight

1. **Never default-enable an unproven mechanism.** Behind a flag until a build proves it on
   Windows. Two mechanisms shipped unproven tonight; both failed and one was destructive.
2. **A transport error is not a capability verdict.** A blocked fetch was read as "fp16 is broken",
   which deleted a good 1.2 GB file and started a 2.4 GB download.
3. **Bounds live at the resource, not the caller.** A failed init reported not-ready → record
   changed → broadcast → re-init → failed. 61 attempts. The caller's 3-strike guard covered only
   one of three call sites.
4. **Enumerate what a user can do DURING any operation with duration.** Press again, switch, quit.
   Two bugs tonight were re-entry: concurrent downloads racing a `.part` file on Windows, and a
   superseded model switch still loading 1.2 GB.
5. **Windows is in the loop, not a formality.** Both re-entry bugs were invisible on Linux —
   POSIX renames open files happily and produces silent corruption instead of an error.

---

## Phase 1 — Serve the model from disk _(the 30s target)_

**Why first:** it is the single worst customer moment. 90 s of silence on first run.

### 1.1 Loopback file server
- Tiny HTTP server in main, bound to `127.0.0.1` on an ephemeral port, serving `modelDir()` only.
- Path-confined by `basename()`; no directory listing; range support (Electron's `net.fetch` on a
  `file://` URL already streams and honours ranges — reuse it as the handler body).
- Per-session random path prefix so other local processes cannot enumerate it.
- Replace `model://models/<file>` with `http://127.0.0.1:<port>/<token>/<file>` in
  `ensureModel()`'s returned URLs. Nothing else in the store changes.

**Tests:** server serves a known file byte-identical; refuses `../` traversal; refuses a path
outside the token; port is ephemeral and bound to loopback only; URL shape matches what
`fromUrls` expects.

**Acceptance (Windows):** log shows `source=disk`, the worker loads, transcription succeeds, and a
second launch downloads nothing.

### 1.2 Turn the store on by default
Only after 1.1 passes on a real build. Keep `--no-model-store` as the escape hatch.

**Acceptance:** first run ≤ 30 s wall clock from launch to "orchestrator ready" on the XPS.

---

## Phase 2 — Communicate the wait _(the frustration target)_

**Why:** even at 11 s, a silent wait with a dead hotkey is the wrong experience. At 90 s it is
unacceptable. `model:download-progress` is already emitted by main and nobody renders it.

- `EngineState` gains a distinct **`downloading`** status with a percentage — today
  `loading` covers both "warming a cached model" (~20 s) and "fetching 1.2 GB" (~90 s), which is
  why the blocked-press message says "ready shortly" when it may be minutes.
- Tray shows a distinct downloading state, not the same blink used for errors.
- Popup/StatusIndicator renders "Downloading GPU model — 47%".
- The blocked-press message tells the truth: "Downloading GPU model — 47%, about 40s left" or
  "GPU model loading" — different sentences for different states.
- **Start the download at first launch**, in the background, before the user selects GPU. The CPU
  engine is bundled and works immediately; by the time anyone picks GPU it should already be there.
  This is what turns 11 s into zero perceived wait.

**Tests:** pure derivation of every status → label/tray state, including percentage formatting;
`downloading` is distinguishable from `loading` and from `unusable`.

---

## Phase 3 — Parallel chunk decoding _(long dictations)_

Chunking exists and is correct — 30 s windows above a 30 s threshold, with seam de-duplication.
**Chunks run sequentially** (`long_audio.js:364`, a `for` loop with `await` inside). Parallel
workers were dropped earlier as memory-bound (BRIDGE:45); the maintainer wants it revisited.

- Measure first: time a 2-minute clip on the XPS and the 3090. If a 2-minute dictation is ~10 s on
  the weak machine, quantify the win before building anything.
- If pursued: bound concurrency by available memory, and note WebGPU **cannot** measure VRAM
  (an allocation probe returned 12,288 MB on a 4,096 MB card) — so attempt, catch, and fall back
  to sequential rather than predicting.
- Must not regress the seam de-duplication, which required hand-written logic because parakeet's
  own dedup only compares adjacent words.

**Acceptance:** a 2-minute recording transcribes identically to the sequential path (diff the
transcript) and faster; on a low-memory machine it falls back without failing.

---

## Phase 4 — Exercise every state

Only the GPU path was tested on the current build. The full matrix, on Windows:

| Engine | Path to check |
|---|---|
| **CPU** (`local-fast`) | bundled, no download, works offline on a fresh profile |
| **GPU** (`webgpu-parakeet-0.6b`) | fp16 on `shader-f16`, fp32 without |
| **Hosted** | endpoint saves, survives Settings reopen, transcribes, honest status label |

Plus the transitions, which is where every bug tonight lived:
- Switch engines mid-download, mid-recording, and rapidly back and forth.
- Press the hotkey during download, during load, during a switch.
- Restart on each engine and confirm the selection returns.
- Kill the app mid-download; relaunch; confirm it resumes or restarts cleanly with no corrupt file.

**Deliverable:** this list, run and recorded, in `_review/`. Tier-3 items stay a manual checklist
and are named as such rather than implied to be covered.

---

## Phase 5 — Not blocking, but open

- **fp16 accuracy is unverified.** Nobody has diffed a transcript between fp16 and fp32. Use
  `--replay` on one file, both quants, and compare.
- **onnxruntime-web is fetched from `cdn.jsdelivr.net` at runtime** on every cold start — visible
  in every log. An offline, privacy-first app should not pull third-party executable code from a
  CDN. `wasmPaths` in `fromUrls` can point at a local copy; the store already exists to hold it.
- **The server is a deployment problem, not a code one.** `mvp-stt-docker` v3.0.0 has everything;
  `192.168.1.169:20300` runs v1.0.0 — hence the `/v1/models/switch` 404 and the missing health
  fields. **It also has no working authentication:** `POST /v1/audio/transcriptions` returns 200
  with no key and with a wrong key. Full detail in `_review/DOCKER-SERVER-NOTES.md`.

---

## Definition of done

- First run on a clean profile: **≤ 30 s**, with visible progress the whole time.
- Second run: **no network**.
- Every engine and every transition in Phase 4 exercised on Windows and recorded.
- `npm run typecheck && npm test && npm run build` green at every commit.
- Nothing enabled by default that has not loaded a model on a real Windows build.
