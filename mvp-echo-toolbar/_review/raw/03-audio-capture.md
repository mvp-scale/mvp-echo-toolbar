# Audio Capture Pipeline & Cues — Architectural Review

Scope: `app/renderer/app/audio/AudioCapture.ts`, `start-sound.ts`, `warning-sound.ts`,
`completion-sound.ts`, `app/renderer/test-audio-capture.html`. Read in full. Caller context
(`app/renderer/app/CaptureApp.tsx`) was grepped/spot-read only to confirm or refute whether a
suspected race is actually guarded upstream — noted inline where that happened.

## Capture state machine as implemented

`AudioCapture` has **no explicit state field** — "state" is inferred from which of several
optional members happen to be set (`rawContext`, `rawStream`, `rawWorklet`, `rawSource`). Traced
states/transitions for the production raw-PCM engine (`app/renderer/app/audio/AudioCapture.ts`):

1. **UNINIT** — `rawContext` undefined. Initial, or after `cleanup()`/`teardownRawEngine()`.
2. **ENGINE_WARM_NO_MIC** — `rawContext` exists (running or suspended), `rawStream` undefined.
   Reached after `teardownRawEngine`/idle-release with the engine itself left alive.
3. **MIC_WARM_IDLE** — `rawContext` suspended, `rawStream` track `live`, no worklet connected.
   Entered after `stopRawRecording()` in `keep-ready` mode (`AudioCapture.ts:619-625`).
4. **RECORDING** — `rawWorklet` connected, `pcmChunks` accumulating. Sub-phase
   `WAITING_FOR_READY` → `READY` gated by `maybeFireCaptureReady`/`fireCaptureReady`
   (`AudioCapture.ts:501-529`) **only when the mic was cold-acquired**; when reused warm, it
   enters `READY` immediately with no gate at all (`AudioCapture.ts:474-478`) — see [P1].
5. **STOPPING** — `stopRawRecording()` executing: worklet/source disconnected, chunks
   concatenated, optional resample, context suspended.
6. **RELEASED** — mic tracks stopped, `rawStream` cleared. Reached from MIC_WARM_IDLE via the
   idle timer (`AudioCapture.ts:396-406`), `release-each` mode (`:621-622`), or a `devicechange`
   event (`:364-367`).

Traceable transitions: UNINIT → ENGINE_WARM_NO_MIC (`ensureRawEngine`, first call) →
RECORDING (`ensureMicStream` cold or warm) → STOPPING → MIC_WARM_IDLE or RELEASED → RECORDING
(next press, reusing warm mic) → … → UNINIT (`cleanup()`).

**Gap found while tracing it**: the `devicechange` listener registered in `ensureMicStream()`
(`AudioCapture.ts:364-367`) calls `releaseMicStream()` unconditionally — there is no check
anywhere in the class for "are we currently in RECORDING?" before that transition fires. So the
state machine actually permits **RECORDING → RELEASED** via `devicechange`, which is not a
transition any other part of the code expects (the worklet/source stay connected to a stream
whose tracks were just `.stop()`-ed). This is [P0] below.

There is also no internal state for "start in flight" — that concurrency guard exists only in the
caller (`CaptureApp.tsx` `isStartingRef`/`isProcessingRef`, confirmed by reading
`CaptureApp.tsx:437-523`), not in this file. Noted as an architecture point, not a standalone bug,
since the one caller that exists today does guard it correctly.

---

## Findings

### [P0] `devicechange` handler stops the live mic stream mid-recording, silently truncating/emptying the capture
- **Where:** `app/renderer/app/audio/AudioCapture.ts:361-371` (listener registration) and `:380-390` (`releaseMicStream`)
- **What:** The class-level `devicechange` listener (registered once, on the first cold mic acquisition) calls `releaseMicStream()` on *any* system audio-device change — plugging in headphones, a Bluetooth reconnect, a USB device arriving, etc. `releaseMicStream()` unconditionally stops every track on `rawStream` and clears the reference, with no check for whether a recording (`rawWorklet`/`rawSource` connected) is currently in progress.
- **Evidence:**
  ```ts
  navigator.mediaDevices.addEventListener('devicechange', () => {
    dlog('[AudioCapture] devicechange event — releasing warm mic stream');
    try { this.releaseMicStream(); } catch { /* ok */ }
  });
  ```
  ```ts
  private releaseMicStream(): void {
    if (this.idleReleaseTimer) { clearTimeout(this.idleReleaseTimer); this.idleReleaseTimer = undefined; }
    if (this.rawStream) {
      this.rawStream.getTracks().forEach(t => t.stop());
      this.rawStream = undefined;
      dlog('[AudioCapture] mic released after idle');
    }
  }
  ```
- **Impact:** Mid-recording, an unrelated device event stops the mic track the active `MediaStreamAudioSourceNode`/`AudioWorkletNode` graph is reading from. No exception is thrown — the worklet simply stops receiving frames. `stopRawRecording()` later returns whatever PCM had accumulated up to that point (possibly near-empty), surfacing to the user only as `∅ no speech` (per `CaptureApp.tsx:350`/`354`) with no indication the mic was cut out from under them. This is exactly the "recording comes back EMPTY" failure class called out as the known historical bug, reintroduced through a different code path (device-change handling instead of the warm-up dead window).
- **Fix:** Guard the transition — if a recording is active (e.g. `this.rawWorklet` is set), either ignore the `devicechange` event until `stopRawRecording()` completes, or treat it as an abort: stop cleanly, mark the result as invalid, and surface a distinct error/cue to the user instead of a silent empty result.

### [P1] Warm-mic capture-ready cue fires with zero verification that audio is actually flowing
- **Where:** `app/renderer/app/audio/AudioCapture.ts:474-478`, contrast with the two-gate logic at `:501-517`
- **What:** For a cold mic acquisition, `fireCaptureReady` is only called after `maybeFireCaptureReady` confirms ~250ms of above-floor RMS energy AND `track.muted === false` — this is the documented fix for the historical "talk now fires into a dead window" bug. For a **warm** (reused) stream, none of that applies: `fireCaptureReady('warm')` fires immediately and unconditionally, with no check of `track.muted` and no confirmation that the newly-created worklet for this recording has received even one real frame.
- **Evidence:**
  ```ts
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
  The `wasWarm` flag only reflects `track.readyState === 'live'` at the moment of reuse
  (`AudioCapture.ts:298-303`) — it does not reflect `track.muted`, nor whether the underlying
  device (e.g. a Bluetooth headset that power-saved during the idle window, now configurable up
  to 1h per `setIdleReleaseMs`) has actually resumed delivering audio.
  ```ts
  if (this.rawStream) {
    const existingTrack = this.rawStream.getAudioTracks()[0];
    if (existingTrack && existingTrack.readyState === 'live') {
      dlog('[AudioCapture] Mic stream reused (warm)');
      return true; // wasWarm
    }
  ```
- **Impact:** For the *default* mode (`micReleaseMode = 'keep-ready'`), warm reuse is the common case for any repeat recording within the idle window. If the track is momentarily muted (OS-level privacy toggle, focus-assist) or the physical device needs to re-negotiate after being idle, the user is told "talk now" with 0ms latency while no real audio is being captured yet — reproducing the same class of bug the energy gate was built to fix, just for the warm path. `CaptureApp.tsx:174` does filter a *late* fire via `isRecordingRef.current`, but does nothing about an *on-time but false* "ready" fire.
- **Fix:** Apply the same two gates (`track.muted` check + a short energy check on the first N ms of the new worklet's frames) to the warm path too, just with a much shorter fallback than the 2s cold-path timeout (e.g. 50-100ms) so the latency win from warm-mic is mostly preserved while still confirming real signal before cueing.

### [P2] `ensureRawEngine()` leaves the engine permanently half-initialized if `audioWorklet.addModule()` fails
- **Where:** `app/renderer/app/audio/AudioCapture.ts:237-256`
- **What:** `this.rawContext = ctx` is assigned *before* `await ctx.audioWorklet.addModule(url)` is attempted. If `addModule` throws (CSP blocking `blob:` worklet URLs, a transient failure, etc.), the exception propagates out of `ensureRawEngine()`/`startRawRecording()`, but `this.rawContext` is left set to a context whose worklet module was never registered.
- **Evidence:**
  ```ts
  this.rawContext = ctx;
  this.rawContextRate = ctx.sampleRate;
  dlog(`[AudioCapture] Raw engine created: requested ${RAW_PCM_SAMPLE_RATE}Hz, got ${ctx.sampleRate}Hz, state=${ctx.state}`);

  // Register the worklet module ONCE per context (re-adding throws).
  const url = URL.createObjectURL(new Blob([AudioCapture.WORKLET_CODE], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  ```
  The guard at the top of the function then treats any non-closed context as fully ready on every
  subsequent call:
  ```ts
  private async ensureRawEngine(): Promise<void> {
    if (this.rawContext && this.rawContext.state !== 'closed') return;
  ```
- **Impact:** After one `addModule` failure, every subsequent `startRawRecording()` call reuses the broken context (`ensureRawEngine` returns early) and then throws at `new AudioWorkletNode(ctx, 'pcm-capture')` because the processor was never registered — recording is broken until something calls `cleanup()`/`teardownRawEngine()` (e.g. the caller's start-watchdog or an app restart), not just for that one attempt.
- **Fix:** Only assign `this.rawContext = ctx` after `addModule` resolves successfully, or wrap the whole block in try/catch and close+clear `ctx` on failure so the next call retries cleanly from UNINIT.

### [P2] Two structurally different capture pipelines coexist with divergent audio processing, undocumented which engine expects which
- **Where:** `app/renderer/app/audio/AudioCapture.ts:127-173` (legacy `startRecording`) vs `:313-324` (raw `ensureMicStream`)
- **What:** The legacy MediaRecorder path acquires the mic with `getUserMedia({ audio: true })` — Chromium's default constraints, which enable `echoCancellation`, `noiseSuppression`, and `autoGainControl`, and records into lossy `audio/webm` (opus). The raw-PCM path explicitly disables echo cancellation and noise suppression (documented as altering speech content, bad for ASR) but explicitly *enables* `autoGainControl`, with a comment citing an A/B test (`rms~0.006` off vs `rms~0.05` on).
- **Evidence:**
  ```ts
  this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  ...
  this.mediaRecorder = new MediaRecorder(this.stream);
  ```
  ```ts
  this.rawStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
  ```
- **Impact:** This is confirmed live (not dead) code — `CaptureApp.tsx:490-492` routes to the legacy path whenever the WebGPU orchestrator isn't ready, i.e. on app cold start or after a WebGPU failure, so real user recordings do go through the filtered/compressed path. It may be intentional (a different downstream engine consuming it — dual-engine architecture per project docs), but nothing in this file documents that distinction or why the two paths should differ, so a future edit to "harmonize" audio settings could silently break either engine's expectations.
- **Fix:** Add a comment at the top of `startRecording()` stating which downstream engine it feeds and why its constraints intentionally diverge from the raw-PCM path (or, if unintentional, align the constraints).

### [P2] Test harness does not exercise the production warm-engine/readiness-gate architecture, and tests the opposite AGC setting
- **Where:** `app/renderer/test-audio-capture.html:264-341` (`testLiveMic`) vs `app/renderer/app/audio/AudioCapture.ts:313-324`
- **What:** The harness's mic tests request `autoGainControl: false` — the exact opposite of production's `autoGainControl: true`, which production arrived at empirically after finding AGC-off produced unusably quiet audio (`rms~0.006`). None of the harness's tests build the persistent context, the silent keep-alive `ConstantSourceNode`, or the worklet→zero-gain-sink→destination routing that `AudioCapture.ts` documents as the fix for the worklet "island" bug (`AudioCapture.ts:271-280`); every harness test creates and closes a fresh plain `AudioContext()` per run.
- **Evidence:**
  ```html
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  });
  ```
  (repeated identically in `testLiveMic` at line 269 and `testMediaRecorderDecode` at line 349)
- **Impact:** A developer running this harness and seeing all green checks has validated neither the AGC setting production actually ships with, nor the warm-engine/readiness-gate/keep-alive machinery that the historical empty-recording bug and its fix live in. It gives false confidence that "capture works" while covering a materially different, older architecture. It also only exercises the *fallback* resample path (plain `AudioContext()`, then `OfflineAudioContext` resample) since it never requests a 16kHz context first the way `ensureRawEngine()` does (`AudioCapture.ts:245`).
- **Fix:** Either delete the harness (if superseded) or update it to mirror the real pipeline: `autoGainControl: true`, request a 16kHz `AudioContext`, and drive it through `AudioCapture`'s actual persistent-engine methods rather than reimplementing a simplified worklet inline.

### [P3] No internal reentrancy guard in `AudioCapture` for start/stop overlap
- **Where:** `app/renderer/app/audio/AudioCapture.ts:430-486` (`startRawRecording`), `:539-628` (`stopRawRecording`)
- **What:** Neither method checks or sets any "busy" flag on `this`. `startRawRecording` does three sequential `await`s (`ensureRawEngine`, `ctx.resume`, `ensureMicStream`) before touching `pcmChunks`/`rawWorklet`; a `stopRawRecording()` landing during that window would only see whatever was left over from the previous cycle.
- **Evidence:**
  ```ts
  await this.ensureRawEngine();
  const ctx = this.rawContext!;
  if (ctx.state === 'suspended') await ctx.resume();
  const wasWarm = await this.ensureMicStream();
  this.rawSource = ctx.createMediaStreamSource(this.rawStream!);
  this.pcmChunks = [];
  ```
- **Impact:** Confirmed **mitigated today** — `CaptureApp.tsx:437-440` (`isProcessingRef`/`isStartingRef`) and the 25s start-watchdog (`CaptureApp.tsx:494-523`) prevent the only current caller from ever invoking start and stop concurrently. Flagged as a structural gap, not a live bug: `AudioCapture` has zero defense-in-depth of its own, so correctness here depends entirely on every future caller reimplementing the same guard correctly.
- **Fix:** Add a lightweight internal state flag (e.g. `private phase: 'idle'|'starting'|'recording'|'stopping'`) so the class is safe to call from more than one place without relying on caller discipline.

### [P3] `onAudioLevel` parameter on `startRawRecording` is dead — accepted, stored, never invoked
- **Where:** `app/renderer/app/audio/AudioCapture.ts:430-431`, contrast with the only consumer at `:175-199`
- **What:** `startRawRecording(onAudioLevel?)` stores the callback (`this.onAudioLevel = onAudioLevel`) but nothing in the raw-PCM path ever calls it. The only place `this.onAudioLevel(...)` is invoked is `monitorAudioLevel()`, which is exclusively started from the legacy `startRecording()` path and reads from the legacy `analyser`/`dataArray`, neither of which the raw-PCM engine creates.
- **Evidence:**
  ```ts
  async startRawRecording(onAudioLevel?: (level: number) => void): Promise<void> {
    this.onAudioLevel = onAudioLevel;
  ```
  Confirmed the current production call site never passes one anyway:
  `CaptureApp.tsx:491`: `audioCapture.current.startRawRecording()` (no argument).
- **Impact:** No live level meter exists during WebGPU/raw-PCM recording, the app's primary path. The parameter's presence on the signature is misleading — it implies the feature exists for this path when it does not.
- **Fix:** Either wire real-time RMS (already computed per-chunk for the readiness gate at `AudioCapture.ts:464-466`) through to `onAudioLevel` for a live meter, or remove the dead parameter from `startRawRecording`'s signature.

### [P3] No recording-length/memory cap inside `AudioCapture` itself
- **Where:** `app/renderer/app/audio/AudioCapture.ts:457-468` (`pcmChunks.push` in the worklet message handler)
- **What:** `pcmChunks` grows without any bound check inside this file; nothing here stops a recording after N seconds or N bytes.
- **Evidence:**
  ```ts
  this.rawWorklet.port.onmessage = (e: MessageEvent) => {
    this.workletMsgCount++;
    const chunk = e.data as Float32Array;
    this.pcmChunks.push(chunk);
  ```
- **Impact:** Low in practice — `CaptureApp.tsx` enforces a 600s hard cap via its own countdown/auto-stop (`MAX_RECORDING_S`/`AUTO_STOP_S`), bounding worst case to ~38MB of PCM plus ~75k small `Float32Array` chunk objects. But that bound is entirely external; `AudioCapture` has no fallback of its own if the caller's timer ever fails to fire.
- **Fix:** Optional defense-in-depth: cap `pcmChunks` total length inside the worklet handler and force-stop or drop-oldest past a hard ceiling, independent of the caller's timer.

---

## Architecture assessment

- **State is implicit, not modeled.** `AudioCapture` has no state enum; "what phase are we in" is inferred by callers and by the class itself from which of ~8 optional fields (`rawContext`, `rawStream`, `rawWorklet`, `rawSource`, `captureReadyFired`, …) happen to be set. This is exactly the shape of bug class in [P0]/[P1] above — a transition (`devicechange`) that shouldn't be legal during `RECORDING` is trivially allowed because nothing encodes "we are currently recording" as a checkable fact.
- **The readiness gate is inconsistently applied.** The energy+mute two-gate check exists and is well-reasoned (`AudioCapture.ts:488-517`), but only guards the cold-acquire path. The warm-reuse path — the default, common case — bypasses it entirely ([P1]), which undercuts the fix for the very bug class this file's comments describe fighting.
- **Two capture pipelines, one file, divergent audio processing, no cross-reference.** The legacy webm/MediaRecorder path and the raw-PCM/AudioWorklet path have essentially opposite philosophies (browser-filtered+compressed vs. raw+AGC-only), live side by side, and the file gives no indication of which downstream engine each is for ([P2]).
- **Test coverage lags the production architecture.** `test-audio-capture.html` predates (or never adopted) the persistent-engine/keep-alive/silent-sink design and tests the opposite AGC setting from production ([P2]) — it currently cannot catch a regression in the mechanism most responsible for past reliability bugs.
- **Correctness safety net lives entirely in the caller.** Reentrancy ([P3]) and max-recording-length ([P3]) are both enforced only by `CaptureApp.tsx`, not by `AudioCapture` itself, despite `AudioCapture` being written as if it's meant to be a reusable, self-contained capture engine (persistent context, its own idle-release timers, its own device-change handling). The device-change hole in [P0] is a direct consequence of this: it's the one piece of external-event handling implemented *inside* the engine, and it's the one that isn't safe.
- **Cue-sound files (`start-sound.ts`, `warning-sound.ts`, `completion-sound.ts`) are clean.** Each creates a short-lived `AudioContext`, correctly ties `.close()` to the last oscillator's `onended`, and wraps everything in try/catch. No leaks found. `warning-sound.ts` ships five unused variants (V1-V5) alongside the one in production use (V6/default export) — harmless, but worth pruning if this file is touched again.
