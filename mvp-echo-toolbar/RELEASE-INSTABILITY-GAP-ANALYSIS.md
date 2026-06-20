# Gap Analysis: What Degraded the Released Toolbar (3.0.12 → 3.0.23, on the way to GitHub)

> **Method:** multi-agent gap analysis — 2 recon agents (version/build-pipeline timeline + live-log symptom→subsystem map) → 5 perspective lenses (audio capture, transcription empties, tray lifecycle, build-pipeline drift, startup consistency) → **two independent red teams per finding** (A = evidence & recent-regression, B = symptom-causality) → synthesis. 22 findings adjudicated. Every claim grounded in real `file:line` + commit SHA. 52 agents.
>
> **Generated:** 2026-06-19 · branch `dev` · HEAD `6b56300` (v3.0.23) · driven by live console logs from the released build (`main-C4hiBp7G.js`).

## 1. Bottom line

**The degradation is a source-code regression cluster, not dependency drift.** The build pipeline is a real, unmanaged hazard (gitignored lockfile + bare `npm install`), but it is **not** the active cause today — the behaviorally-decisive dependency (`parakeet.js`) resolves to the identical `1.4.4` in CI as locally, and it exact-pins `onnxruntime-web` to `1.24.1`, so there is no resolvable version delta to change transcription behavior.

**One-line answer: we introduced a bug (several, actually) — the pipeline did not change inference behavior.**

Ranked most-likely causes:

1. **Empty/truncated long audio = one-shot `model.transcribe()` on multi-minute buffers** (`inference-worker.ts:125-132`), with parakeet's own windowing API (`transcribeLongAudio`, 180s/90s) never called. The decode degrades/collapses past ~1 min. This is the headline symptom. It is a *design limitation present since the engine's inception (2407e63)*, but it crossed its failure threshold because users started recording 1–3 min clips. **The empty-retry added in 3.0.16 (9ad6438) masks it** by re-running the *identical* audio once (deterministically empty again → "retry did NOT recover").
2. **Audio start/stop glitches = the 3.0.16 persistent forced-16kHz capture engine** (suspend/resume churn, keep-alive node), replacing the prior fresh-context-per-recording model.
3. **Tray instability = downstream amplification** — the un-debounced renderer-mirror tray (unchanged since Feb) gets hammered more often by the *increased failure surface* (more empties → more error→ready / ready blips), compounded by the main-side backstop timers being removed in 3.0.12 (17fc451).

Startup/go-live latency (305–522ms) is **not a regression** — it is a newly-added metric (3.0.21) faithfully measuring a pre-existing device unmute dead-window.

---

## 2. What changed on the way to GitHub

| Version / commit | Change | Subsystem | Regression risk | Explains a symptom? |
|---|---|---|---|---|
| 2407e63 (3.0.x origin) | WebGPU engine via `parakeet.js ^1.4.4`; **one-shot `model.transcribe()` with no chunking**; 60s safety timeout; 120s orchestrator timeout | Inference engine + dep surface | HIGH (latent) | **YES** — long-audio empties/truncation (the decode path), but pre-dates window |
| 17fc451 (3.0.12) | Removed main-side 30s/600s tray safety timers; orchestrator `abort()`=terminate-worker; device-lost watcher | Tray lifecycle + WebGPU recovery | MED | Partial — tray instability (removed the only backstop) |
| 9ad6438 (3.0.16) | **Persistent forced-16kHz AudioContext** (suspend/resume, keep-alive node); **empty-retry-once**; `resetMelCache`/`clearIncrementalCache` per call; `rendererCrashCount` reset on did-finish-load | Audio capture + retry logic | HIGH | **YES** — audio start/stop (engine churn); masks empties (retry); amplifies tray churn |
| e56c3db (3.0.20) | `autoGainControl` flipped **false→true**; track mute/unmute diagnostics; removed 10-min engine freshen-up | Audio capture / diagnostics | MED→LOW | NO (AGC-on *reduced* empties per A/B; not length-correlated) |
| df21b80 (3.0.21) | Capture-readiness gate (250ms unmuted frames + 1500ms fallback); new `start-sound.ts` "talk now" chirp; `● live in Nms` metric mechanism | Audio readiness / start cue | LOW | YES (benign) — explains the modest 305–522ms latency spread |
| 4cfd75f (3.0.22) | Logging only (`● live in` log string surfaced here) | Diagnostics | LOW | No |
| 35f0d42 (3.0.23) | Model re-download fix + persist cache | Model cache | LOW | No (separate, already-diagnosed) |
| 6b56300 (CI fix) | Pin `@noble/hashes 1.8.0` via overrides | Build deps | LOW | No — but **proves CI drift is real** (ESM-only 2.x broke the build) |
| **Pipeline (pre-existing since 3053c0d)** | `package-lock.json` gitignored (.gitignore:50); CI runs bare `npm install` not `npm ci` (build-electron-app.yml:46) | Build pipeline | HIGH (latent), not active | NO for inference (versions match local) |

---

## 3. Confirmed causes (per symptom)

### Symptom A — Empty / truncated transcription on long audio (PRIMARY)
*Evidence: 189s & 136s → "∅ no speech"; 12.2s also empty; 61.9s → only 88 chars vs 852/871 for ~52s; proc/RTF healthy.*

- **Root cause: one-shot decode on multi-minute buffers.** `inference-worker.ts:125-132` feeds the *entire* Float32Array to a single `model.transcribe()` (returns `utterance_text || ''`). No chunking. parakeet.js ships `transcribeLongAudio` (auto-windows >180s into 90s chunks — `node_modules/parakeet.js/src/long_audio.js:1-4,462-468`; `parakeet.js:1147-1157`) which the app **never calls** (git log -S confirms zero references). The sequential RNNT/TDT greedy decode (`parakeet.js:790-798`) over ~3M samples can collapse to empty/few-token output. This matches the length curve exactly.
  - *Red-team scores:* `LONGAUDIO-ONESHOT-NO-WINDOWING` — A: explains symptom, but **pre-existing** (introduced 2407e63 = 3.0.8, before the window), adj 0.35. B: refuted the *fix* (windowing no-ops <180s, so it wouldn't change 3 of 4 failing clips), adj 0.22. **Honest caveat:** as the headline *mechanism* it's real and well-grounded; as a *recent regression* it is not — the same code ran in the "good" builds. The true "what changed" is that **input length crossed the design boundary**, plus the masking retry below.
- **Masking factor (in-window regression): empty-retry re-runs identical audio.** `CaptureApp.tsx:284-288` (added 9ad6438/3.0.16, git log -S "retrying once" = only this commit) re-runs `transcribe(trimSilence(pcm))` on the *same* pcm. For a deterministic length empty it returns empty again → exactly "the retry-once did NOT recover them." Worker resets only scratch caches between calls (`inference-worker.ts:116-119`), so nothing about the second pass differs.
  - *Scores:* `EMPTY-RETRY-MASKS-DETERMINISTIC-FAILURE` — A 0.6, B 0.5. Verified, in-window, real. It's a **mask/amplifier, not the cause.**

**Before→after:** Before, one-shot transcribe on short clips was reliable; after, the same code is hit with 60–189s recordings, and the 3.0.16 retry disguises a deterministic failure as a transient one while doubling latency.

> The recon's 60s-timeout-collision theory for these empties was **refuted by both red teams** (AC-3: A 0.12 / B 0.12): the observed log path is "∅ no speech" (`CaptureApp.tsx:327`), reachable only when *both* passes *completed* with empty text — the "SAFETY TIMEOUT — processing exceeded 60s" log is absent, and healthy RTF (~0.04) means a 189s clip + retry ≈ 16–20s, far under 60s. So the timeout never fired. The empties are genuine fast empty model output.

### Symptom B — Audio "starting and stopping" glitches
- **Root cause: persistent suspend/resume 16kHz capture engine (9ad6438 / 3.0.16).** `AudioCapture.ts:446-449` suspends (not closes) the context between recordings; `:267-269` resumes it at next start; a keep-alive `ConstantSourceNode` + zero-gain sink were added because the persistent graph was rendering "running but silent / intermittent zeros" (comment `:213-236`). Before (617f8c7): fresh `new AudioContext()` per recording, closed at stop (`:142`/`:252`). Forcing a non-native 16kHz context on Windows + suspend/resume churn is the most defensible source of the start/stop stutter.
  - *Scores:* `AC-2` — A 0.4, B 0.4. **Contributing/secondary, not refuted.** Confounded by the pre-existing device unmute dead-window (which the 3.0.21 cue made perceptible), so attribution to suspend/resume specifically is plausible but not isolable from logs.
- **Refuted sibling:** the forced-16kHz *real-time resample* quality theory (`AC-1`, A 0.2 / B 0.12) — degraded resampling is uniform per-frame and cannot produce a length threshold; it does not explain the empties it was filed against.

### Symptom C — Tray (notification-bar) instability
- **Root cause: un-debounced renderer-mirror tray amplified by the increased failure surface.** `tray-manager.js:92-104` does an immediate `setImage` with no coalescing — and is **unchanged since Feb (e988a48)**, so it is *not* a regression (`TRAY-4` confirmed, A 0.95 / B 0.88). The in-window change is 17fc451 (3.0.12) **removing the main-side 30s/600s backstop timers** (`main-simple.js:535-541`), making the renderer the sole authority. With more empties/long-audio failures (each pushing extra `error→ready` / `ready` transitions, e.g. `CaptureApp.tsx:314-315, 327-328, 447-448`) into an un-debounced tray, the bottom-right icon visibly churns.
  - *Scores:* `TRAY-1` — A 0.55, B 0.2 (B argues empties produce *fewer* swaps than successes; the better-evidenced amplifier is the removed backstop + crash-recovery resets). The honest read: tray instability is **downstream** of Symptoms A/B, not its own root bug.
- **Refuted tray theories:** `TRAY-2` (60s-timeout race, A 0.48 / B 0.12 — pre-existing, symptom path is synchronous), `TRAY-3` (renderer-crash recovery, A 0.12 / B 0.08 — logs prove the renderer did *not* crash; it completed and logged "∅ no speech").

### Symptom D — Startup / go-live latency (305–363ms, 522ms spike)
- **Not a regression.** The `● live in Nms` cue (mechanism in df21b80/3.0.21, log string in 4cfd75f/3.0.22) measures keypress→250ms-of-unmuted-frames (`AudioCapture.ts:324,354,364`). It faithfully exposes a **pre-existing device unmute/warm-up dead-window**; compute/RTF is healthy and dependency-independent.
  - *Scores:* `live-in-readiness-gate-added` A 0.88 / B 0.82; `live-in-not-a-regression` A 0.82 / B 0.82. The per-record `ctx.resume()` cost (`persistent-context-resume-per-record`, A 0.3 / B 0.2) is a minor, non-isolable contributor, **mislabeled as the primary spike source** — the 250ms gate + device unmute dominate.

---

## 4. Dependency-drift verdict

**Likelihood the released build shipped different `parakeet.js`/`onnxruntime` behavior than local: LOW today, but structurally unmanaged.**

- `package-lock.json` is gitignored (.gitignore:50) and untracked (`git ls-files` = none); CI runs bare `npm install` (build-electron-app.yml:46). So released artifacts re-resolve against the registry — a genuine reproducibility hazard (`BP-1` A 0.4 / B 0.9 as a *hazard*; does not explain symptoms).
- **But the inference stack cannot drift right now:** `npm view parakeet.js dist-tags` → latest `1.4.4` (no published version above it), so `^1.4.4` resolves to the locally-installed `1.4.4`; and `1.4.4` **exact-pins** `onnxruntime-web 1.24.1` (`node_modules/parakeet.js/package.json` deps; nested copy confirmed). No resolvable delta → no behavior delta. (`BP-3` A 0.9 / B 0.92 — correctly self-classified as latent, not active.)
- **Drift IS real and has already bitten CI:** `@noble/hashes` resolved to ESM-only 2.x and broke `electron-builder` at *build time* → fixed by the override in 6b56300 (`BP-2` A 0.95 / B 0.9). But that's a build-tool dep — it fails the build *loudly*, producing no artifact; it cannot silently degrade a runnable toolbar.
- On-disk locks are stale/inconsistent (`BP-4` A 0.5 / B 0.9): inner lock is Apr-8, predates all 3.0.16→3.0.23 work, has no `@noble/hashes` entry.

**How to prove it cheaply:** (a) On `dev`, run `npm install`, **commit the generated `package-lock.json`**, switch CI from `npm install` to `npm ci`. (b) In a CI run, dump `npm ls parakeet.js onnxruntime-web electron vite` and diff against the local resolved tree. (c) Rebuild the released artifact from the pinned lock and re-run the long-audio repro. Expectation: the empties persist identically → confirms source-bug, not drift.

---

## 5. Refuted / ruled out (proves we didn't invent the answer)

- **AC-1** (forced-16kHz real-time resample causes empties) — refuted: uniform per-frame degradation can't create a length threshold (A 0.2 / B 0.12).
- **AC-3** (60s safety-timeout × retry drops valid long-audio results) — refuted: observed "∅ no speech" log is unreachable from the timeout path; RTF too healthy for 60s to fire (A 0.12 / B 0.12).
- **AC-4** (start chirp's AudioContext contends mid-recording) — refuted: fires once at start, length-independent; latency measured *before* the chirp; output sessions mix independently of capture (A 0.12 / B 0.1).
- **AC-5** (60s-timeout `resetState` cold-rebuilds next recording) — refuted: empties take the clean path (no `cleanup()`); timeout doesn't fire (A 0.2 / B 0.15).
- **AGC-ON** (autoGainControl false→true caused empties) — refuted, *direction reversed*: the same diff shows AGC-on was the **fix** for blanks (rms 0.006→0.05), A/B-proven; not length-correlated (A 0.1 / B 0.08).
- **TRAY-2 / TRAY-3** — refuted (race is pre-existing/synchronous; renderer demonstrably did not crash) (≤0.2).
- **AC-6 / TRAY-4** — negative findings *confirmed*: capture has no buffer cap/drop and no use-after-transfer (truncation is downstream of capture, A 0.8 / B 0.85); tray-manager is byte-equivalent since Feb (A 0.95 / B 0.88).

**Prior startup report:** Its causes — eager WebGPU auto-init on mount (e2f6e51) + serialized `whenReady` — **still hold and are unfixed** (`eager-autoinit-still-present` A 0.95). But they are **pre-existing (3.0.9), not in the degradation window**, and explain *launch* latency only — orthogonal to the new empties/glitches/tray symptoms.

---

## 6. Did we introduce a bug?

**Yes — but mostly latent design choices that the recent versions exposed and masked, plus one clear in-window regression in capture architecture.**

- The **headline empties/truncation** come from a *design limitation* (one-shot transcribe, no windowing) that has existed since the engine was added — we did not introduce it in the GitHub window, but we also **never called the library's long-audio API** that exists precisely for this. The user hit it because recordings got longer.
- We **did** introduce, in the window: the **empty-retry** (3.0.16) that masks the failure as transient, the **persistent forced-16kHz suspend/resume capture engine** (3.0.16) that plausibly causes the start/stop glitches, and the **removal of the main-side tray backstop** (3.0.12) that lets failures churn the tray.
- We did **not** introduce a dependency/pipeline bug that changed inference behavior — the released build runs the same `parakeet.js 1.4.4` / `onnxruntime-web 1.24.1` as local.

---

## 7. Test-harness focus (round one)

Build these reproductions first:

1. **Varied-length transcription matrix, warm & cold:** record/replay fixed WAVs at 10s, 30s, 52s, 62s, 90s, 136s, 189s, 240s+ through the live pipeline. Capture `utterance_text` length per length-bucket. **Expected:** clean output ≤~52s, truncation ~60–130s, empty ≥~136s. This directly reproduces Symptom A and pins the collapse threshold.
2. **Windowing A/B:** same matrix routed through `model.transcribeLongAudio(pcm, 16000, {chunkLengthS: 30})` vs the current one-shot `transcribe()`. Confirms whether windowing fixes the long-clip empties (note B's caveat: auto-windowing no-ops <180s, so you must pass an explicit `chunkLengthS` to window the 62s/136s cases).
3. **Capture-engine soak:** 20+ consecutive start/stop cycles on the persistent 16kHz context; log per-recording rms/peak and any zero-frame islands. Reproduces Symptom B churn; compare against a fresh-context-per-recording variant.
4. **Tray state-transition soak:** drive 50 rapid record→empty→record cycles; count `setImage` calls and visually inspect icon stability with vs without a debounce/coalesce in `tray-manager.setState`.
5. **Pinned-lockfile rebuild:** commit `package-lock.json`, switch to `npm ci`, rebuild; diff resolved versions and re-run repro #1. **Expected:** empties unchanged → drift ruled out as cause.

*(Round two: randomized length/state fuzzing, memory-pressure injection for the crash-recovery path.)*

---

## 8. Cheapest next experiments (before any fix)

1. **Inspect the saved diag WAVs** (`saveDiagAudio`, `CaptureApp.tsx:301`) from a failing long recording: confirm the captured audio is intact and audible. This in one step separates "capture dropped/garbled the audio" from "model returned empty on good audio." (Cheapest, highest-information.)
2. **Feed a saved 189s diag WAV directly to `model.transcribeLongAudio` vs `transcribe`** in a tiny standalone node/worker script. If `transcribeLongAudio` returns full text and `transcribe` returns empty, the one-shot-decode root cause is confirmed and the fix is established.
3. **Add a one-line console log of `result.utterance_text.length` and elapsed ms** in `inference-worker.ts` around line 132, then reproduce. Confirms the empties are *fast* (decode collapse) vs *slow* (timeout), nailing the AC-3/timeout refutation in the live build.
4. **`npm ci` from a freshly committed lock + dump `npm ls`** — one CI run to definitively close out the drift hypothesis.

**Decisive single experiment if you only run one: #2** — direct `transcribeLongAudio` vs `transcribe` on a captured failing buffer. It confirms the primary cause and the fix simultaneously, with no UI or pipeline involvement.
