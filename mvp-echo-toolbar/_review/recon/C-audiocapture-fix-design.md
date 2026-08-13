# AudioCapture Fix Design Recon — devicechange truncation (P0) + warm-mic false-ready (P1)

Scope: `app/renderer/app/audio/AudioCapture.ts` (read in full, 684 lines), cross-checked against its
only caller `app/renderer/app/CaptureApp.tsx` (read in full, 560 lines). `_review/raw/03-audio-capture.md`
and `_review/FIX-PLAN.md` were read as orientation and independently re-verified against the current
source — not treated as ground truth. This is a **design document**, not a patch. No source file was
modified.

## Bottom line

- **Not a state machine.** Two small, independent point-patches are the right size. A 4-value
  `phase` enum would mostly duplicate a fact the code can already derive for free
  (`!!this.rawWorklet`), touches every method in the file for no behavioral gain on the two bugs in
  scope, and adds risk in a file with zero tests that only fully verifies on Windows. Recommend adding
  one cheap boolean (`private recording = false`, or just reuse `!!this.rawWorklet`) as the shared
  primitive both fixes lean on — that's the entire "shared state" footprint needed.
- **Fix 1:** ignore/defer `devicechange` while recording (don't drop the "refresh device list" intent —
  apply it right after `stopRawRecording()` instead of mid-recording), **plus** separately wire the
  already-present `track.onended` handler to actually abort the recording with a distinct cue — today
  it only logs. `devicechange` itself carries no device identity, so it can't be filtered by "is this
  the active device" — only the track's own events can. See §3.
- **Fix 5:** reuse the existing two-gate (`muted` + energy) logic unchanged, just with a much shorter
  budget — ~50ms required contiguous energy vs. cold's 250ms, ~100-150ms fallback vs. cold's 2000ms.
  Mechanically trivial: the worklet is already recreated fresh every recording regardless of warm/cold,
  the only gate is one `if (!wasWarm)` on line 467. Estimated added latency in the common case: **~50-70ms**,
  not 250ms and nowhere near 2s. See §4.
- **Order matters.** Today's P0 bug (unconditional release on `devicechange`) accidentally forces the
  *next* recording cold, which accidentally protects it from P1 (cold path is already gated). A naive
  Fix 1 that just drops the event during recording removes that accidental protection and makes P1
  fire more often. The deferred-release design in §3 avoids this — recommend it specifically because it
  doesn't create a hard "must ship together" dependency. See §5.
- **Testability:** the gating arithmetic (Fix 5) and the guard boolean (Fix 1) are fully unit-testable
  headless with `navigator`/`AudioContext`/worklet objects stubbed as plain JS objects — no DOM/jsdom
  needed, since this file never touches `document`. The Web Audio graph itself (`AudioContext`,
  `AudioWorkletNode`, real `track.muted`/`ended` semantics per device class) cannot be exercised
  headless and must be verified manually on Windows. No test framework is installed today
  (`package.json`: `"test": "echo \"No tests yet\""`, no `vitest`/`jest` devDependency) — that's a
  prerequisite, not an assumption. See §6.

---

## 1. State model — confirmed, with one correction

The review's claim ("no state enum; state inferred from ~8 optional fields") is correct. Re-derived
independently, the fields that actually encode phase are:

| Field | Set | Cleared |
|---|---|---|
| `rawContext` | `ensureRawEngine()` (`:249`) | `teardownRawEngine()`/`cleanup()` |
| `rawStream` | `ensureMicStream()` cold acquire (`:313`) | `releaseMicStream()` (`:385-388`) |
| `rawWorklet`/`rawSource` | `startRawRecording()` (`:451`, `:456`), unconditional | `stopRawRecording()` (`:558-559`), `cleanup()` |
| `captureReadyFired` | `fireCaptureReady()` (`:522`) | reset at next `startRawRecording()` (`:440`) |
| `idleReleaseTimer` | `scheduleIdleRelease()` (`:401`) | fires, or cleared at next start/`releaseMicStream()` |
| `captureReadyTimer` | cold-path fallback only, `:482` | `fireCaptureReady()` (`:523`) |

`rawWorklet`/`rawSource` are set together with **no `await` between them** (`:451`→`:456`→`:469`/`:472`,
all synchronous), so `!!this.rawWorklet` is already a reliable, checkable "is a recording in progress"
fact — it just isn't checked anywhere outside the record/stop path itself.

**Correction to the review's 6-state list:** states 2 (`ENGINE_WARM_NO_MIC`) and 6 (`RELEASED`) are not
actually distinguishable by field signature — both are `rawContext` set + `rawStream` undefined +
`rawWorklet` undefined. They're the same resting state reached by two different histories (never-yet-acquired
vs. released-after-use), and behave identically going forward (next `startRawRecording()` cold-acquires
either way). Worth naming as one state, not two, when reasoning about transitions.

There is genuinely **no field at all** for "start in flight" inside this class — that guard exists only
in the caller:

```ts
// CaptureApp.tsx:437-440
if (isProcessingRef.current || isStartingRef.current) {
  console.log('CaptureApp: Ignoring shortcut — busy (processing or start in flight)');
  return;
}
```

Confirmed this guard is correct and does cover the only currently-live re-entrancy risk (verified by
reading `CaptureApp.tsx:428-524` in full, not just the cited range).

---

## 2. Is the right fix a state machine? — No; two point patches, plus one shared boolean

**Recommendation: point patches, not a `phase` enum.** Reasoning:

1. **Fix 1 only needs one bit of information**: "is a recording currently in progress." That bit
   already exists in derivable form (`!!this.rawWorklet`). A 4-value enum (`idle|starting|recording|stopping`)
   would have to be threaded through and kept in sync across `ensureRawEngine`, `ensureMicStream`,
   `startRawRecording`, `stopRawRecording`, `releaseMicStream`, `scheduleIdleRelease`, `cleanup`, and
   `teardownRawEngine` — every one of those methods currently mutates a subset of the ~6 fields above,
   and an enum adds a 7th thing to keep consistent with all of them, in a file with **zero tests** that
   only fully verifies on Windows hardware. That's a large diff surface for a fix that needs exactly one
   boolean check in one place (`:364-367`).
2. **Fix 5 gets nothing from a phase enum.** It isn't a state-transition-legality problem — recording
   IS legitimately happening on the warm path; the bug is that the code fires a "ready" signal without
   checking whether the signal is *true*. That's a data-gating problem (mute + energy), orthogonal to
   what phase the class is in. The fix is the same two-gate check already written for the cold path,
   applied to the warm path's frames — no new state field makes that easier or safer.
3. **`starting`, the one sub-phase this class has zero internal signal for today, is not implicated in
   either P0 or P1.** It's a real gap (flagged as [P3] in the existing review, confirmed by independent
   read of `CaptureApp.tsx:437-523`), but it's already fully mitigated by the current caller. Adding it
   now would be pre-emptive hardening for a hypothetical second caller, not a fix for either defect in
   scope.

**Does class-level state duplicate or replace the caller's guards?** Neither, cleanly — it would be
**additive, not a replacement**. `CaptureApp.tsx`'s `isStartingRef`/`isProcessingRef`/`isRecordingRef`
operate at a different altitude: they coordinate IPC calls, tray state, and the countdown timer — none
of which can move into `AudioCapture` (it has no IPC/UI concerns). A phase field inside `AudioCapture`
would protect the class against *any* future caller, including ones that don't reimplement the same
discipline; it would not let `CaptureApp.tsx` delete any of its own refs. Since today's one caller
already guards correctly, that additive value is architectural insurance, not a bug fix — reasonable to
defer.

**What to actually add:** a single `private recording = false` field (or just use `!!this.rawWorklet`
directly, avoiding even that), flipped in `startRawRecording`/`stopRawRecording`. This is the "shared
primitive" both fixes touch — small enough that it isn't really "a state machine," just naming a fact
that already exists.

---

## 3. Fix 1 design — devicechange mid-recording

**Can the code tell which device changed?** No, and this matters for picking the right behavior.
`devicechange` is a list-level event with no payload identifying which device changed:

```ts
// AudioCapture.ts:364-367
navigator.mediaDevices.addEventListener('devicechange', () => {
  dlog('[AudioCapture] devicechange event — releasing warm mic stream');
  try { this.releaseMicStream(); } catch { /* ok */ }
});
```

The handler takes no device-identifying argument, and nothing in the class calls `enumerateDevices()`
inside the handler to diff against a prior snapshot. The device fingerprint machinery that *does* exist
only runs at the next **cold acquire**, comparing against the *previous recording's* hash — it's a
post-hoc "did the device change since last time" check, not a live "is the currently-active device the
one that changed" check:

```ts
// AudioCapture.ts:332-337
const track = this.rawStream.getAudioTracks()[0];
const st: MediaTrackSettings = track ? track.getSettings() : {};
const idStr = `${st.deviceId || ''}|${(st as any).groupId || ''}|${track?.label || ''}`;
const hash = shortHash(idStr);
const deviceChanged = !!this.lastDeviceHash && hash !== this.lastDeviceHash;
this.lastDeviceHash = hash;
```

So **option (c) — re-acquire and continue — is out.** There's no way to tell if the changed device is
even the one in use without adding `enumerateDevices()` diffing (new surface, new race), and even with
that, splicing a new `MediaStreamAudioSourceNode` into a live worklet graph mid-recording is exactly the
kind of async, untested, no-precedent-in-file operation this codebase's own review flags as risky
(cf. `[P3]` reentrancy, `[P2]` half-init failure modes). Not worth it for two P0/P1 fixes.

**Recommendation: (a) ignore-with-deferral**, not a bare ignore-forever, and not (b) alone. Two
independent pieces:

**3a. Defer the generic `devicechange` release until the recording ends** (closes the truncation bug,
preserves the original "refresh device list eventually" intent):

```
devicechange fires:
  if recording:
    pendingDeviceChangeRelease = true   // don't touch rawStream now
  else:
    releaseMicStream()                  // unchanged — today's behavior when idle

stopRawRecording(), after the worklet/source are torn down:
  if pendingDeviceChangeRelease:
    pendingDeviceChangeRelease = false
    releaseMicStream()                  // now safe — forces next start() to cold-acquire
  else:
    (existing release-mode logic: releaseMicStream() or scheduleIdleRelease())
```

This reuses `!!this.rawWorklet` (or the new `recording` boolean from §2) as the guard, costs ~4 lines,
and — importantly — **preserves the property that a device change still forces the next recording to
cold-acquire**, which matters for §5.

**3b. Separately, wire `track.onended` to actually abort.** The class already listens for the one event
that *is* specific to the in-use device:

```ts
// AudioCapture.ts:351-355
if (track) {
  track.onmute = () => { this.onTrackEvent?.('mute'); };
  track.onunmute = () => { this.onTrackEvent?.('unmute'); };
  track.onended = () => { this.onTrackEvent?.('ended'); };
}
```

But today the only consumer just logs it — it does not stop or invalidate anything:

```ts
// CaptureApp.tsx:168
audioCapture.current.onTrackEvent = (kind: string) => sendDiag(`track-event: ${kind}`);
```

That means even without the `devicechange` bug, if the *actually-in-use* device is physically removed
mid-recording, `track.onended` fires, gets diagnosed, and the recording silently keeps "running" —
worklet just stops receiving frames — producing the exact same `∅ no speech` outcome the P0 finding
describes, via a different trigger. This is the one case where option **(b) — abort with a distinct
error/cue** is the right call, because it's the one signal genuinely tied to the device actually in use.
Recommend: on `onTrackEvent('ended')` while recording, mark the in-flight recording invalid and have
`CaptureApp.tsx` surface a distinct cue (not the generic error tone) instead of silently returning to
`performStop()`'s normal empty-result path.

**Edge cases this design must handle:**
- **Rapid repeat `devicechange` events** (Windows can fire one per affected device) — trivially safe,
  the deferred-release flag is idempotent (`pendingDeviceChangeRelease = true` repeatedly is a no-op).
- **`devicechange` landing exactly during `stopRawRecording()`'s synchronous disconnect window** — no
  race: JS is single-threaded and the disconnect (`:558-559`) happens with no `await` before it, so the
  event handler can't interleave mid-disconnect. By the time the handler runs, `recording` is already
  false or already true — never ambiguous.
- **Does `MediaStreamTrack.stop()` (called by our own `releaseMicStream()`) fire `onended`?** Per the
  Web platform spec, `.stop()` is an application-initiated stop and should **not** fire `ended`
  (`ended` fires only for source-side termination — device removed, permission revoked). This needs a
  real Chromium/Windows confirmation before treating `onended` as a trustworthy abort trigger — flagged
  as a manual verification item in §6, not assumed from source alone since it can't be executed in this
  headless sandbox.
- **`CaptureApp.tsx` has its own separate `devicechange` listener** (`:180-181`, diag-only, does not
  touch `AudioCapture`) — no interaction, just worth noting there are two independent listeners on the
  same event today; Fix 1 only touches the one inside `AudioCapture.ts`.

---

## 4. Fix 5 design — warm-path readiness gate

**Mechanically trivial, because the plumbing is already warm/cold-agnostic.** The worklet is recreated
fresh every single recording regardless of `wasWarm`, *before* the branch that's currently the bug:

```ts
// AudioCapture.ts:474-483
if (wasWarm) {
  // Device was already delivering audio — fire the cue immediately so the
  // user can speak without waiting for the energy gate.
  this.fireCaptureReady('warm');
} else {
  // Cold first acquisition (or after idle release / device change). Keep
  // the existing energy-gate path: fire when ~250ms of above-floor frames
  // have flowed, with a 2s fallback in case energy never crosses.
  this.captureReadyTimer = setTimeout(() => this.fireCaptureReady('timeout'), AudioCapture.READY_FALLBACK_MS);
}
```

...and the per-chunk RMS is already computed unconditionally in the worklet handler; only the call into
the gate is skipped for warm:

```ts
// AudioCapture.ts:464-468
      let sumSq = 0;
      for (let i = 0; i < chunk.length; i++) { const v = chunk[i]; sumSq += v * v; }
      const rms = chunk.length ? Math.sqrt(sumSq / chunk.length) : 0;
      if (!wasWarm) this.maybeFireCaptureReady(chunk.length, rms, readySamplesNeeded);
    };
```

`maybeFireCaptureReady` itself reads live state (`this.rawStream`), not anything cold-path-specific, so
it's directly reusable:

```ts
// AudioCapture.ts:501-505
private maybeFireCaptureReady(n: number, rms: number, needed: number): void {
  if (this.captureReadyFired) return;
  const track = this.rawStream?.getAudioTracks?.()[0];
  if (track && track.muted) return;                    // still mid-unmute
  if (rms < AudioCapture.READY_ENERGY_FLOOR) {
```

**Design:** stop special-casing `wasWarm` as "skip the gate" and instead special-case it as "use a
smaller gate":

```
const readySamplesNeeded = wasWarm
  ? Math.round(ctx.sampleRate * 0.05)   // ~50ms — new WARM_READY_MS constant
  : Math.round(ctx.sampleRate * 0.25);  // existing 250ms, unchanged

// worklet onmessage: call the SAME function unconditionally now
this.maybeFireCaptureReady(chunk.length, rms, readySamplesNeeded);

// replace the wasWarm branch:
this.captureReadyTimer = setTimeout(
  () => this.fireCaptureReady(wasWarm ? 'warm-timeout' : 'timeout'),
  wasWarm ? AudioCapture.WARM_READY_FALLBACK_MS /* ~100-150ms, new */ : AudioCapture.READY_FALLBACK_MS /* 2000ms, unchanged */
);
```

`fireCaptureReady` is already idempotent (`:521`, guarded by `captureReadyFired`), so wiring warm
through the same `maybeFireCaptureReady → fireCaptureReady` pipeline with a distinct `via` label
(`'warm-energy'` vs. `'warm-timeout'`) is a same-shape change to the cold path, reusing 100% of the
existing gate mechanism — no new mechanism, just new constants and one fewer special case.

**Latency cost, quantified.** The `AudioWorkletProcessor` render quantum is a fixed 128 samples per Web
Audio API spec; at the raw engine's 16kHz context (`RAW_PCM_SAMPLE_RATE`, `:7`, `:245`), that's 8ms of
audio per quantum:

- **Common case (device already live, no mute race):** `readySamplesNeeded = round(16000 × 0.05) = 800`
  samples → 800/128 ≈ 7 quanta → 7 × 128 / 16000 ≈ **56ms** of audio needed before the gate can pass.
  Since the graph is already actively running (keep-alive node + silent sink exist precisely so
  Chromium never sleeps the pipeline — `:258-281`), quanta should arrive back-to-back with no added
  device latency on top of that ~56ms. **Net added latency vs. today's buggy 0ms: roughly 50-70ms.**
- **Fallback case (mute race, e.g. OS privacy toggle or a headset re-negotiating):** bounded by
  `WARM_READY_FALLBACK_MS`, recommend ~100-150ms — still ~15-20x shorter than the cold path's 2000ms,
  because a warm device isn't paying an unmute/AGC cold-ramp, it's only being asked to prove the graph
  reconnected correctly.
- Compare: cold path costs 250ms typical / up to 2000ms worst case. Fix 5 costs **~50-150ms**, i.e. it
  gives up most but not all of the warm-path's latency win in exchange for actually verifying the
  signal — the stated point of warm-mic (avoid the ~1-2s OS device cold-open) is untouched, since that
  saving is in *not re-acquiring the device*, not in the readiness gate.

**Does `track.muted` mean what the code assumes on Windows?** This is not a new assumption introduced
by Fix 5 — it's the identical primitive the cold path already uses in production. Per project memory,
the cold-path two-gate fix (energy + `muted`) is the shipped fix for the historical "empties" bug
(v3.0.23) — i.e. this exact signal has already been validated against real Windows hardware for the
cold path. Fix 5 extends a already-trusted primitive to a second code path; it does not require
re-validating `track.muted` semantics from scratch. What *does* need Windows confirmation (not
assumable from source) is whether `muted` fires as expected on a **warm, previously-live** track after
various idle-release durations (`setIdleReleaseMs` now allows up to 1h) — a Bluetooth device
power-saving during an hour-long idle window and then reconnecting is a different real-world scenario
than a cold headset's initial unmute ramp, even though the code path is the same. Flagged for manual
testing in §6.

---

## 5. Interaction between Fix 1 and Fix 5

Today, the P0 bug **accidentally protects** against the P1 bug: any `devicechange` forces an unconditional
release, so the *next* `ensureMicStream()` call always cold-acquires:

```ts
// AudioCapture.ts:296-303
private async ensureMicStream(): Promise<boolean> {
  // Reuse the warm stream if its audio track is still live.
  if (this.rawStream) {
    const existingTrack = this.rawStream.getAudioTracks()[0];
    if (existingTrack && existingTrack.readyState === 'live') {
      dlog('[AudioCapture] Mic stream reused (warm)');
      return true; // wasWarm
```

...which only returns `true` (warm) if `rawStream` still exists — and `devicechange` today always clears
it. So every recording that follows a device event is currently forced onto the cold path, where the
(correct) energy+mute gate already applies. **This means shipping Fix 1 alone, naively, makes P1 worse**:
if the new behavior is "just drop the event while recording" (no deferral), the warm stream now survives
device-change events far more often, so *more* subsequent recordings take the ungated `wasWarm` branch —
increasing how often the P1 bug is actually hit, until Fix 5 lands.

**This is why the deferred-release design in §3a is the recommended shape, specifically**: it defers the
`releaseMicStream()` call to right after the interrupted recording's `stopRawRecording()` completes, but
still performs it — so the recording *immediately following* an interrupted one is still forced cold, same
as today. Net effect: Fix 1 (deferred variant) does not change P1's exposure surface at all, and there is
no hard "must ship in the same commit" dependency between the two.

That said, `_review/FIX-PLAN.md` already groups both as Phase 1 items (`1` and `5`), and given the above,
that grouping is the right call regardless of which variant of Fix 1 ships — recommend keeping them in
the same pass so the interaction is never observed in the field even transiently.

---

## 6. Testability

**Nothing is unit-tested today.** Confirmed directly:

```
$ grep -n '"test"' package.json
    "test": "echo \"No tests yet\""
```

No `vitest`/`jest`/`jsdom` in `devDependencies` (checked full `package.json`). The project already uses
Vite, so `vitest` is the natural addition (zero extra bundler config) — flagging this as a prerequisite
this task should call out explicitly, not something to assume is already available.

**What CAN be exercised headless, with a plain Node harness (no jsdom needed — this file never touches
`document`):**

- **Fix 5's gating arithmetic** — `maybeFireCaptureReady`/`fireCaptureReady` operate on primitive
  values (`n`, `rms`, `needed`) plus one field read (`this.rawStream?.getAudioTracks?.()[0].muted`).
  Construct a real `AudioCapture` instance, assign `(instance as any).rawStream = { getAudioTracks: () =>
  [{ muted: false }] }`, and call the private methods directly (TS `private` is not enforced at
  runtime, so this needs no DI to reach). This is exactly the harness `_review/FIX-PLAN.md`'s own DoD
  for item 5 already proposes: "(H) stub track/worklet; assert no fire while muted."
- **Fix 1's guard boolean** — stub `global.navigator = { mediaDevices: { addEventListener: (ev, fn) =>
  { captured = fn }, getUserMedia: async () => fakeStream } }` before constructing `AudioCapture`,
  capture the registered `devicechange` handler, set the new `recording` flag `true`/`false`, invoke the
  captured handler directly, and assert whether `releaseMicStream` (spy it via prototype override) was
  called synchronously vs. deferred to a flag checked in a stubbed `stopRawRecording`.
- **Injectable seams needed, in order of value:**
  1. None, strictly — both of the above work today via `(instance as any).field = ...` assignment,
     since every relevant field is a plain class property, not something wrapped in a closure. This is
     the cheapest seam (zero source changes) and should be tried first.
  2. If stricter typing is wanted later, the smallest real seam would be making `this.rawStream`
     assignable from a test without a full `MediaStream`-shaped object (already true — `getAudioTracks`
     is the only method the gating code calls on it) — no factory injection needed for *this* scope.
  3. An injectable clock is not needed for pass/fail assertions on the gates (fires or doesn't); only
     needed if a test wants to assert the exact ~50ms/~150ms timing windows, in which case Node's/the
     test runner's fake timers are sufficient — no bespoke clock abstraction required.

**What genuinely requires a Windows machine with real hardware — be honest, these cannot be verified
from this headless Linux box no matter how the code is structured:**

- Whether a real headphone plug / Bluetooth reconnect / USB arrival actually delivers `devicechange` the
  way assumed, and whether the deferred-release design (§3a) actually leaves the recording audibly
  intact.
- Whether `MediaStreamTrack.stop()` truly never fires `onended` on Chromium/Windows (spec says no, but
  spec compliance nuances have differed across engines/versions historically — needs confirming before
  `onended` is trusted as an abort trigger per §3b).
- Whether `track.muted` fires reliably on a **warm, previously-live** track across different device
  classes (built-in mic, USB headset, Bluetooth) after idle windows up to the new 1-hour
  `setIdleReleaseMs` ceiling — this is exactly the kind of per-device variance the file's own comments
  say was empirically tuned for the cold path (`AudioCapture.ts:113-116`: "TUNE from the logged
  `capture-ready via energy ... rms=` distribution per device").
- Real-world felt latency of the warm gate (is ~50-100ms actually imperceptible vs. today's 0ms).

**Manual test steps (Windows, exact):**

*Fix 1:*
1. Launch the packaged app, record once and let it finish normally so the mic stream is warm
   (`keep-ready` mode, the default).
2. Press the hotkey to start a second recording; while actively speaking, plug in USB headphones (or
   trigger a Bluetooth reconnect).
3. Confirm the recording either completes intact and transcribes the full utterance, or a **distinct**
   "device changed" cue/tray-state fires — never the bare `∅ no speech` outcome.
4. With `--diag` on, check the diagnostics log for the `devicechange` line and the per-recording
   fingerprint (`CaptureApp.tsx:316-320`) to confirm the release was deferred, not dropped.
5. Start a third recording immediately after; confirm it cold-acquires (i.e., the deferred release did
   eventually apply, picking up any new default device) rather than silently staying warm forever.

*Fix 5:*
1. With a warm stream (recording #2 within the idle window), toggle Windows' microphone privacy switch
   off in the ~100ms right after pressing the hotkey for a new recording.
2. Confirm the "talk now" cue does **not** fire until the mute clears (or the fallback timeout elapses),
   and confirm the result is not empty due to a premature cue.
3. Repeat with no interference (normal warm case) and read the `keypress→live Nms` diagnostic line
   (`CaptureApp.tsx:177-178`) to confirm added latency lands around the ~50-100ms estimate above, not
   the cold path's 250ms+.
