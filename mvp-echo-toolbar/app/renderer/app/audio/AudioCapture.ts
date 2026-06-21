/**
 * Audio recording functionality (renderer process)
 * Extracted from App.tsx for use in hidden capture window
 */
import { dlog, shortHash } from '../diag';

const RAW_PCM_SAMPLE_RATE = 16000;
// Gate high-frequency per-chunk logging. Each line round-trips IPC to the main
// process and appends to the debug log; left on, a long recording emits hundreds
// of lines. Flip to true only when debugging the capture path.
const DEBUG_AUDIO = false;

export class AudioCapture {
  private mediaRecorder?: MediaRecorder;
  private audioChunks: Blob[] = [];
  private stream?: MediaStream;
  private audioContext?: AudioContext;
  private analyser?: AnalyserNode;
  private dataArray?: Uint8Array<ArrayBuffer>;
  private onAudioLevel?: (level: number) => void;
  private animationId?: number;
  private sourceNode?: MediaStreamAudioSourceNode;

  // AudioWorklet PCM capture (WebGPU path)
  private pcmChunks: Float32Array[] = [];
  private workletNode?: AudioWorkletNode;

  // ── Persistent raw-PCM engine (WebGPU path) ──
  // Reusing ONE AudioContext + worklet module + a silent keep-alive source across
  // recordings avoids the per-cycle create/close churn that wedges the Windows
  // audio pipeline into "running but silent" capture. The mic stream is now also
  // kept warm across recordings (released after IDLE_RELEASE_MS of silence) to
  // eliminate the ~1-2s OS device cold-open that was paid on every press.
  // The context is SUSPENDED between recordings, not closed. A staleness
  // freshen-up rebuilds the engine after long uptime.
  private rawContext?: AudioContext;
  private rawContextRate: number = RAW_PCM_SAMPLE_RATE;
  private keepAliveNode?: ConstantSourceNode;
  private rawSink?: GainNode; // zero-gain sink: gives the capture worklet a path to destination
  private rawSource?: MediaStreamAudioSourceNode;
  private rawWorklet?: AudioWorkletNode;
  private rawStream?: MediaStream;
  private rawEngineStartedAt = 0;
  private lastStopAt = 0; // ms timestamp of the previous recording's stop — for idle-gap diagnostics
  private lastDeviceHash = '';            // device fingerprint of the previous recording (detect Windows device swaps)
  private workletMsgCount = 0;            // worklet quanta received this recording (detect dropped quanta)
  private startDiag: Record<string, any> = {}; // device/settings snapshot captured at start (track is live then)
  /** Optional hook fired on async source events (mute/unmute/ended). Set by CaptureApp. */
  onTrackEvent?: (kind: string) => void;

  /**
   * Fired ONCE per recording when capture is confirmed live — real frames are
   * flowing AND the track is unmuted (the headset has finished its auto-unmute).
   * The arg is ms since startRawRecording began (≈ keypress→live latency). Set by
   * CaptureApp to play the authoritative "talk now" cue, instead of cueing on
   * keypress — which fires before the device has actually engaged and is the
   * window where early speech gets lost (captured frames but no voice).
   */
  onCaptureReady?: (latencyMs: number) => void;
  private captureReadyFired = false;
  private captureReadySamples = 0;  // frames received WHILE UNMUTED (counts toward the ready threshold)
  private captureStartTs = 0;       // ms timestamp at start of this recording (≈ keypress)
  private captureReadyTimer?: ReturnType<typeof setTimeout>;

  // ── Warm-mic idle release ──
  // After stopRawRecording() the mic stream is kept open so the next recording
  // can skip the OS device cold-open (saves ~1-2s). After IDLE_RELEASE_MS of
  // inactivity the stream is released so the OS mic indicator turns off.
  private idleReleaseTimer?: ReturnType<typeof setTimeout>;
  private static readonly IDLE_RELEASE_MS = 30000; // 30s idle before releasing mic (default)
  private idleReleaseMs: number = AudioCapture.IDLE_RELEASE_MS; // instance-configurable duration
  private deviceChangeListenerAdded = false;        // guard: add listener only once

  // ── Mic release mode ──
  // 'keep-ready'   → warm stream, instant repeat recordings, auto-release after idleReleaseMs (default)
  // 'release-each' → release mic immediately after every recording (OS indicator off between uses)
  private micReleaseMode: 'keep-ready' | 'release-each' = 'keep-ready';

  /** Update the mic release mode. Takes effect on the next stopRawRecording(). */
  setMicReleaseMode(mode: 'keep-ready' | 'release-each'): void {
    this.micReleaseMode = mode;
    dlog(`[AudioCapture] micReleaseMode set to '${mode}'`);
  }

  /**
   * Set how long the mic stream is held warm before auto-releasing in 'keep-ready' mode.
   * Takes effect on the next stopRawRecording(). Ignored if ms is non-finite or <= 0.
   */
  setIdleReleaseMs(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.idleReleaseMs = Math.max(5000, ms);
    dlog(`[AudioCapture] idleReleaseMs set to ${this.idleReleaseMs}ms`);
  }

  private static readonly WORKLET_CODE = `
    class PcmCaptureProcessor extends AudioWorkletProcessor {
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch && ch.length > 0) {
          const copy = new Float32Array(ch);
          this.port.postMessage(copy, [copy.buffer]); // transfer, avoid clone
        }
        return true;
      }
    }
    registerProcessor('pcm-capture', PcmCaptureProcessor);
  `;

  // Readiness gate energy floor: a captured chunk must carry RMS above this to
  // count as "the mic is delivering real audio". Below it = the device's
  // unmute/AGC cold-ramp (near-digital-silence quanta) that previously tripped
  // the frame-COUNT gate and fired the "talk now" cue into the dead window —
  // the user then spoke into nothing (empty result, voice lost). Conservative
  // starting value; TUNE from the logged `capture-ready via energy ... rms=`
  // distribution per device. The fallback timer guarantees a cue if energy
  // never crosses (e.g. a very quiet room), so over-waiting is the safe failure.
  private static readonly READY_ENERGY_FLOOR = 0.005;
  // Last-resort cue if the energy gate never resolves. ~2s comfortably exceeds a
  // typical headset unmute ramp, so even the fallback lands on a live device.
  private static readonly READY_FALLBACK_MS = 2000;


  getStream(): MediaStream | undefined {
    return this.stream;
  }

  async startRecording(onAudioLevel?: (level: number) => void): Promise<void> {
    this.onAudioLevel = onAudioLevel;

    console.log('[AudioCapture] Requesting microphone access...');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error('[AudioCapture] getUserMedia FAILED:', err);
      throw err;
    }

    const tracks = this.stream.getAudioTracks();
    console.log(`[AudioCapture] Microphone granted: ${tracks.length} track(s)`,
      tracks.map(t => ({ label: t.label, enabled: t.enabled, muted: t.muted, readyState: t.readyState })));

    this.mediaRecorder = new MediaRecorder(this.stream);
    console.log(`[AudioCapture] MediaRecorder created, mimeType: ${this.mediaRecorder.mimeType}`);
    this.audioChunks = [];

    // Set up Web Audio API for real-time audio level detection
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    if (this.audioContext.state === 'suspended') {
      console.log('[AudioCapture] AudioContext suspended on create — resuming');
      await this.audioContext.resume();
    }
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.sourceNode.connect(this.analyser);

    // Start monitoring audio levels
    this.monitorAudioLevel();

    this.mediaRecorder.ondataavailable = (event) => {
      this.audioChunks.push(event.data);
      if (DEBUG_AUDIO) console.log(`[AudioCapture] Chunk received: ${event.data.size} bytes (total chunks: ${this.audioChunks.length})`);
    };

    this.mediaRecorder.onerror = (event) => {
      console.error('[AudioCapture] MediaRecorder error:', event);
    };

    this.mediaRecorder.start();
    console.log('[AudioCapture] Recording started');
  }

  private monitorAudioLevel(): void {
    if (!this.analyser || !this.dataArray) return;

    const updateLevel = () => {
      if (!this.analyser || !this.dataArray || !this.onAudioLevel) return;

      this.analyser.getByteFrequencyData(this.dataArray);

      // Calculate RMS (Root Mean Square) for audio level
      let sum = 0;
      for (let i = 0; i < this.dataArray.length; i++) {
        sum += this.dataArray[i] * this.dataArray[i];
      }
      const rms = Math.sqrt(sum / this.dataArray.length);
      const level = rms / 255; // Normalize to 0-1

      this.onAudioLevel(level);

      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        this.animationId = requestAnimationFrame(updateLevel);
      }
    };

    updateLevel();
  }

  async stopRecording(): Promise<ArrayBuffer> {
    return new Promise((resolve) => {
      if (!this.mediaRecorder) {
        console.warn('[AudioCapture] stopRecording called but no MediaRecorder exists');
        this.cleanup();
        resolve(new ArrayBuffer(0));
        return;
      }

      console.log(`[AudioCapture] Stopping recording (state: ${this.mediaRecorder.state}, chunks so far: ${this.audioChunks.length})`);

      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.audioChunks, { type: 'audio/webm' });
        const arrayBuffer = await blob.arrayBuffer();
        console.log(`[AudioCapture] Recording stopped. ${this.audioChunks.length} chunks, ${arrayBuffer.byteLength} bytes total`);
        this.cleanup();
        resolve(arrayBuffer);
      };

      this.mediaRecorder.stop();
    });
  }

  /** Age of the persistent raw engine in ms (0 if not built). */
  rawEngineAgeMs(): number {
    return this.rawContext ? Date.now() - this.rawEngineStartedAt : 0;
  }

  /**
   * Ensure the persistent raw-PCM engine exists (context + worklet module +
   * silent keep-alive source). Rebuilds it if stale (freshen-up) or closed.
   */
  private async ensureRawEngine(): Promise<void> {
    // Reuse the warm engine whenever it's alive. No periodic "freshen-up"
    // rebuild — rebuilding resets the engine to a cold state, which captures
    // worse, not better. Only a real error/cleanup tears it down.
    if (this.rawContext && this.rawContext.state !== 'closed') return;

    // Capture in a 16kHz context (browser auto-resamples the mic). UNDER
    // INVESTIGATION: whether this real-time resample degrades speech vs the
    // offline resample — the min/max/rms signal stats logged at stop will tell
    // us, rather than guessing. Falls back to native rate if 16kHz isn't honored.
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: RAW_PCM_SAMPLE_RATE });
    } catch {
      ctx = new AudioContext();
    }
    this.rawContext = ctx;
    this.rawContextRate = ctx.sampleRate;
    dlog(`[AudioCapture] Raw engine created: requested ${RAW_PCM_SAMPLE_RATE}Hz, got ${ctx.sampleRate}Hz, state=${ctx.state}`);

    // Register the worklet module ONCE per context (re-adding throws).
    const url = URL.createObjectURL(new Blob([AudioCapture.WORKLET_CODE], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    // Silent keep-alive: a zero-gain ConstantSourceNode keeps the audio graph
    // active so Chromium can't throttle/sleep the pipeline into silent capture.
    try {
      const keep = ctx.createConstantSource();
      const g = ctx.createGain();
      g.gain.value = 0;
      keep.connect(g).connect(ctx.destination);
      keep.start();
      this.keepAliveNode = keep;
    } catch (e) {
      console.warn('[AudioCapture] keep-alive source failed (non-fatal):', e);
    }

    // Silent sink for the capture worklet. ROOT-CAUSE FIX: a capture worklet
    // whose output reaches NOTHING is an "island" — Web Audio is pull-based from
    // the destination, so the graph doesn't reliably render the mic into it, and
    // process() receives intermittent frames of zeros (full-length buffer, but
    // near-zero RMS with the odd real spike = the blank/low-energy captures).
    // Routing worklet → zero-gain Gain → destination puts the mic→worklet branch
    // on an active path so it's pulled every quantum, while staying inaudible.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    this.rawSink = sink;

    this.rawEngineStartedAt = Date.now();
  }

  /**
   * Ensure the mic stream is open and live. Reuses the existing stream if the
   * track is still live (warm-mic path — no OS round-trip). Acquires a fresh
   * stream otherwise (first acquisition, or after an idle release / device change).
   *
   * Returns true  → stream was already warm (device is delivering audio now).
   * Returns false → fresh acquisition (cold start; energy-gate readiness applies).
   *
   * Also registers the device-change listener the first time (once per instance).
   */
  private async ensureMicStream(): Promise<boolean> {
    // Reuse the warm stream if its audio track is still live.
    if (this.rawStream) {
      const existingTrack = this.rawStream.getAudioTracks()[0];
      if (existingTrack && existingTrack.readyState === 'live') {
        dlog('[AudioCapture] Mic stream reused (warm)');
        return true; // wasWarm
      }
      // Track ended unexpectedly — fall through to re-acquire.
      dlog('[AudioCapture] Warm stream track ended; re-acquiring mic');
      this.rawStream.getTracks().forEach(t => t.stop());
      this.rawStream = undefined;
    }

    // ── Cold acquire ──
    dlog('[AudioCapture] Requesting mic (raw PCM via AudioWorklet)...');
    try {
      this.rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,  // off: alters speech content (bad for ASR)
          noiseSuppression: false,  // off: alters speech content (bad for ASR)
          // AutoGain ON. This is the real fix for the intermittent blanks: with it
          // OFF we captured the device's raw level, which drifts and is often far
          // too quiet for Parakeet (rms ~0.006 = blank). AGC is *gain* (volume)
          // normalization, NOT a content filter — it keeps the level in Parakeet's
          // hearable range. A/B-proven: AGC off rms~0.006 → AGC on rms~0.05.
          autoGainControl: true,
        }
      });
    } catch (err) {
      console.error('[AudioCapture] getUserMedia FAILED (raw PCM):', err);
      throw err;
    }

    // ── Diagnostics: device fingerprint + settings captured at START ──
    const track = this.rawStream.getAudioTracks()[0];
    const st: MediaTrackSettings = track ? track.getSettings() : {};
    const idStr = `${st.deviceId || ''}|${(st as any).groupId || ''}|${track?.label || ''}`;
    const hash = shortHash(idStr);
    const deviceChanged = !!this.lastDeviceHash && hash !== this.lastDeviceHash;
    this.lastDeviceHash = hash;
    const idleGapMs = this.lastStopAt ? Date.now() - this.lastStopAt : -1;
    this.startDiag = {
      dev: (track?.label || 'unknown').slice(0, 18),
      hash,
      chg: deviceChanged,
      gapS: idleGapMs < 0 ? -1 : Math.round(idleGapMs / 1000),
      ageS: Math.round(this.rawEngineAgeMs() / 1000),
      rate: st.sampleRate,
      ch: st.channelCount,
      agc: (st as any).autoGainControl,
      ns: (st as any).noiseSuppression,
      ec: st.echoCancellation,
    };
    if (track) {
      track.onmute = () => { this.onTrackEvent?.('mute'); };
      track.onunmute = () => { this.onTrackEvent?.('unmute'); };
      track.onended = () => { this.onTrackEvent?.('ended'); };
    }
    dlog(`[AudioCapture] Mic granted: dev=${this.startDiag.dev}·${hash}${deviceChanged ? ' CHANGED' : ''} gap=${this.startDiag.gapS}s age=${this.startDiag.ageS}s rate=${st.sampleRate} agc=${(st as any).autoGainControl}`);

    // Register the device-change listener exactly once per instance.
    // On a device change we release the warm stream so the next recording
    // re-acquires the (possibly new default) device.
    if (!this.deviceChangeListenerAdded) {
      this.deviceChangeListenerAdded = true;
      try {
        navigator.mediaDevices.addEventListener('devicechange', () => {
          dlog('[AudioCapture] devicechange event — releasing warm mic stream');
          try { this.releaseMicStream(); } catch { /* ok */ }
        });
      } catch (e) {
        console.warn('[AudioCapture] Could not add devicechange listener (non-fatal):', e);
      }
    }

    return false; // wasWarm
  }

  /**
   * Stop all tracks on the warm mic stream and clear it so the OS mic
   * indicator turns off. Called by the idle-release timer and on device change.
   */
  private releaseMicStream(): void {
    if (this.idleReleaseTimer) {
      clearTimeout(this.idleReleaseTimer);
      this.idleReleaseTimer = undefined;
    }
    if (this.rawStream) {
      this.rawStream.getTracks().forEach(t => t.stop());
      this.rawStream = undefined;
      dlog('[AudioCapture] mic released after idle');
    }
  }

  /**
   * Schedule the mic stream to be released after IDLE_RELEASE_MS of inactivity.
   * Clears any existing timer first so repeated calls reset the countdown.
   */
  private scheduleIdleRelease(): void {
    if (this.idleReleaseTimer) {
      clearTimeout(this.idleReleaseTimer);
      this.idleReleaseTimer = undefined;
    }
    this.idleReleaseTimer = setTimeout(() => {
      this.idleReleaseTimer = undefined;
      this.releaseMicStream();
    }, this.idleReleaseMs);
    dlog(`[AudioCapture] idle-release timer set (${this.idleReleaseMs / 1000}s)`);
  }

  /** Fully tear down the persistent raw engine (recovery / unmount). */
  async teardownRawEngine(): Promise<void> {
    if (this.idleReleaseTimer) { clearTimeout(this.idleReleaseTimer); this.idleReleaseTimer = undefined; }
    if (this.rawWorklet) { this.rawWorklet.port.onmessage = null; try { this.rawWorklet.disconnect(); } catch { /* ok */ } this.rawWorklet = undefined; }
    if (this.rawSource) { try { this.rawSource.disconnect(); } catch { /* ok */ } this.rawSource = undefined; }
    if (this.keepAliveNode) { try { this.keepAliveNode.stop(); this.keepAliveNode.disconnect(); } catch { /* ok */ } this.keepAliveNode = undefined; }
    if (this.rawSink) { try { this.rawSink.disconnect(); } catch { /* ok */ } this.rawSink = undefined; }
    if (this.rawStream) { this.rawStream.getTracks().forEach(t => t.stop()); this.rawStream = undefined; }
    if (this.rawContext && this.rawContext.state !== 'closed') { try { await this.rawContext.close(); } catch { /* ok */ } }
    this.rawContext = undefined;
    this.pcmChunks = [];
    dlog('[AudioCapture] Raw engine torn down');
  }

  /**
   * Start recording raw PCM via AudioWorklet on the persistent engine.
   * The context+worklet+keep-alive persist across recordings (suspended between);
   * the mic stream is now ALSO kept warm between recordings (released after
   * IDLE_RELEASE_MS idle). If the stream was already warm, the capture-ready cue
   * fires immediately — no dead window. If cold (first use or after idle release),
   * the existing energy-gate path applies unchanged.
   */
  async startRawRecording(onAudioLevel?: (level: number) => void): Promise<void> {
    this.onAudioLevel = onAudioLevel;

    // Clear any pending idle-release timer — we're about to use the mic again.
    if (this.idleReleaseTimer) {
      clearTimeout(this.idleReleaseTimer);
      this.idleReleaseTimer = undefined;
    }

    // Reset capture-ready tracking for this recording (timestamp ≈ keypress).
    this.captureReadyFired = false;
    this.captureReadySamples = 0;
    this.captureStartTs = Date.now();

    await this.ensureRawEngine();
    const ctx = this.rawContext!;
    if (ctx.state === 'suspended') await ctx.resume();

    // Reuse the warm mic stream if possible; otherwise acquire fresh (cold).
    const wasWarm = await this.ensureMicStream();

    this.rawSource = ctx.createMediaStreamSource(this.rawStream!);

    this.pcmChunks = [];
    this.workletMsgCount = 0;
    const readySamplesNeeded = Math.round(ctx.sampleRate * 0.25); // ~250ms of unmuted frames = "really flowing"
    this.rawWorklet = new AudioWorkletNode(ctx, 'pcm-capture');
    this.rawWorklet.port.onmessage = (e: MessageEvent) => {
      this.workletMsgCount++;
      const chunk = e.data as Float32Array;
      this.pcmChunks.push(chunk);
      // Per-chunk RMS for the readiness gate. Cheap (~128 samples/quantum).
      // ENERGY — not mere frame arrival — is what tells us the mic is actually
      // delivering audio rather than streaming cold-ramp silence.
      let sumSq = 0;
      for (let i = 0; i < chunk.length; i++) { const v = chunk[i]; sumSq += v * v; }
      const rms = chunk.length ? Math.sqrt(sumSq / chunk.length) : 0;
      if (!wasWarm) this.maybeFireCaptureReady(chunk.length, rms, readySamplesNeeded);
    };
    this.rawSource.connect(this.rawWorklet);
    // Give the worklet a path to the destination (silent sink) so the graph
    // reliably pulls the mic through it every quantum. Worklet writes no output → silent.
    if (this.rawSink) this.rawWorklet.connect(this.rawSink);

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

    dlog(`[AudioCapture] Raw PCM recording at ${ctx.sampleRate}Hz (persistent engine, worklet→sink→destination, warm=${wasWarm})`);
  }

  /**
   * Fire the capture-ready cue once ~250ms of ENERGY-BEARING frames have flowed
   * while the track is unmuted. TWO gates, both required:
   *   1. track.muted === false       — the headset cleared its mute transition.
   *   2. per-chunk RMS > floor        — the mic is actually delivering audio,
   *                                     not streaming the unmute/AGC cold-ramp.
   * Gate #2 is the fix for the dead-window empties: frame ARRIVAL alone tripped
   * the old gate during the silent ramp, so "talk now" fired before the device
   * was live and the user's speech was lost. Counting only above-floor frames
   * means "ready" == genuinely-live audio. The fallback timer still guarantees a
   * cue if energy never crosses (very quiet room), so over-waiting is the safe
   * failure — never an early false "go".
   */
  private maybeFireCaptureReady(n: number, rms: number, needed: number): void {
    if (this.captureReadyFired) return;
    const track = this.rawStream?.getAudioTracks?.()[0];
    if (track && track.muted) return;                    // still mid-unmute
    if (rms < AudioCapture.READY_ENERGY_FLOOR) {
      // Below the floor = cold-ramp silence, or a gap after a stray transient.
      // RESET so "ready" requires ~250ms of CONTIGUOUS above-floor audio — a
      // record-keypress click plus scattered ramp energy can't sum their way to
      // ready; only the device steadily delivering real audio (past the ramp)
      // can. This is the guard against low-level/transient energy firing the cue
      // early, which a plain absolute floor alone would miss.
      this.captureReadySamples = 0;
      return;
    }
    this.captureReadySamples += n;
    if (this.captureReadySamples >= needed) this.fireCaptureReady('energy', rms);
  }

  /** Mark capture live, clear the fallback timer, notify CaptureApp exactly once. */
  private fireCaptureReady(via: string, rms = 0): void {
    if (this.captureReadyFired) return;
    this.captureReadyFired = true;
    if (this.captureReadyTimer) { clearTimeout(this.captureReadyTimer); this.captureReadyTimer = undefined; }
    const latencyMs = Date.now() - this.captureStartTs;
    // Log via + rms so the energy floor can be tuned from real-device data
    // (and so a 'timeout' fire — the device never crossed the floor — is visible).
    dlog(`[AudioCapture] capture-ready via ${via} after ${latencyMs}ms (rms=${rms.toFixed(4)})`);
    try { this.onCaptureReady?.(latencyMs); } catch { /* ok */ }
  }

  /**
   * Stop WebGPU recording: collect PCM chunks, resample to 16kHz only if the
   * context didn't honor 16kHz. Returns the PCM plus the peak amplitude (so the
   * caller can detect a silent/wedged capture). Keeps the engine alive
   * (suspended) — does NOT close the context. Does NOT stop the mic stream;
   * instead schedules an idle-release timer so the stream stays warm for the
   * next recording but turns off after IDLE_RELEASE_MS of inactivity.
   */
  async stopRawRecording(): Promise<{ pcm: Float32Array; sampleRate: number; peak: number; rms: number; diag: Record<string, any> }> {
    const rate = this.rawContextRate || RAW_PCM_SAMPLE_RATE;

    // ── Diagnostics: read mutable track + engine state BEFORE teardown ──
    const track = this.rawStream?.getAudioTracks?.()[0];
    const diag: Record<string, any> = {
      ...this.startDiag,
      ready: track?.readyState,
      muted: track?.muted,
      ctx: this.rawContext?.state,
      ctxRate: this.rawContext?.sampleRate,
      refs: !!(this.rawContext && this.rawSource && this.rawWorklet && this.rawSink),
      msgs: this.workletMsgCount,
    };

    // Release per-recording nodes, but keep context/worklet/keep-alive AND the
    // mic stream (warm-mic optimisation). The stream is released by the idle
    // timer (scheduleIdleRelease below) after IDLE_RELEASE_MS of inactivity.
    if (this.captureReadyTimer) { clearTimeout(this.captureReadyTimer); this.captureReadyTimer = undefined; }
    if (this.rawWorklet) { this.rawWorklet.port.onmessage = null; try { this.rawWorklet.disconnect(); } catch { /* ok */ } this.rawWorklet = undefined; }
    if (this.rawSource) { try { this.rawSource.disconnect(); } catch { /* ok */ } this.rawSource = undefined; }
    // NOTE: rawStream is intentionally NOT stopped here — kept warm for next recording.

    // Concatenate captured chunks
    const totalLength = this.pcmChunks.reduce((sum, c) => sum + c.length, 0);
    const rawPcm = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.pcmChunks) {
      rawPcm.set(chunk, offset);
      offset += chunk.length;
    }
    this.pcmChunks = [];

    // Signal stats — answer "is there REAL, varying audio here?" without guessing.
    // peak = loudest point; min/max = does it swing both ways (peaks AND valleys);
    // rms = average energy (real speech: rms << peak; flat/degenerate: rms ≈ peak).
    let peak = 0, min = 0, max = 0, sumSq = 0;
    for (let i = 0; i < rawPcm.length; i++) {
      const s = rawPcm[i];
      if (s > max) max = s;
      if (s < min) min = s;
      const a = s < 0 ? -s : s;
      if (a > peak) peak = a;
      sumSq += s * s;
    }
    const rms = rawPcm.length ? Math.sqrt(sumSq / rawPcm.length) : 0;

    dlog(`[AudioCapture] Raw PCM: ${rawPcm.length} samples at ${rate}Hz (${(rawPcm.length / rate).toFixed(1)}s) — peak=${peak.toFixed(4)} min=${min.toFixed(4)} max=${max.toFixed(4)} rms=${rms.toFixed(4)}`);

    // Resample only if the context did NOT honor 16kHz.
    let pcm: Float32Array;
    if (rate !== RAW_PCM_SAMPLE_RATE && rawPcm.length > 0) {
      dlog(`[AudioCapture] Resampling ${rate}Hz → ${RAW_PCM_SAMPLE_RATE}Hz...`);
      const duration = rawPcm.length / rate;
      const outputLength = Math.ceil(duration * RAW_PCM_SAMPLE_RATE);
      const sourceBuffer = new AudioBuffer({
        length: rawPcm.length,
        numberOfChannels: 1,
        sampleRate: rate,
      });
      sourceBuffer.getChannelData(0).set(rawPcm);
      const offlineCtx = new OfflineAudioContext(1, outputLength, RAW_PCM_SAMPLE_RATE);
      const source = offlineCtx.createBufferSource();
      source.buffer = sourceBuffer;
      source.connect(offlineCtx.destination);
      source.start();
      const rendered = await offlineCtx.startRendering();
      pcm = rendered.getChannelData(0);
      dlog(`[AudioCapture] Resampled: ${pcm.length} samples`);
    } else {
      pcm = rawPcm;
    }

    // Suspend (not close) the persistent context between recordings.
    if (this.rawContext && this.rawContext.state === 'running') {
      this.rawContext.suspend().catch(() => {});
    }

    this.lastStopAt = Date.now(); // mark for next recording's idle-gap calc

    // Release mode: 'release-each' turns off the OS mic indicator immediately;
    // 'keep-ready' keeps the stream warm and releases after IDLE_RELEASE_MS.
    if (this.micReleaseMode === 'release-each') {
      this.releaseMicStream();
    } else {
      this.scheduleIdleRelease();
    }

    return { pcm, sampleRate: RAW_PCM_SAMPLE_RATE, peak, rms, diag };
  }

  cleanup(): void {
    if (this.captureReadyTimer) { clearTimeout(this.captureReadyTimer); this.captureReadyTimer = undefined; }
    if (this.idleReleaseTimer) { clearTimeout(this.idleReleaseTimer); this.idleReleaseTimer = undefined; }
    this.captureReadyFired = false;
    if (this.animationId !== undefined) {
      cancelAnimationFrame(this.animationId);
      this.animationId = undefined;
    }

    // Release the AudioWorklet and any buffered PCM. Without this, a cleanup
    // that isn't preceded by stopRawRecording() (e.g. a failed start, or the
    // standard stop path after a raw start) leaves the worklet node connected
    // and the accumulated PCM chunks referenced — leaking across record cycles.
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = undefined;
    }
    this.pcmChunks = [];

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = undefined;
    }

    if (this.stream) {
      this.stream.getTracks().forEach(track => {
        track.stop();
      });
      this.stream = undefined;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().catch(() => {});
      this.audioContext = undefined;
    }

    this.mediaRecorder = undefined;
    this.analyser = undefined;
    this.dataArray = undefined;
    this.onAudioLevel = undefined;
    this.audioChunks = [];

    // Fully tear down the persistent raw engine too. cleanup() is the "reset
    // everything" path (errors, start-watchdog, unmount, silent-capture
    // recovery), so the next startRawRecording() rebuilds a fresh engine.
    if (this.rawWorklet) { this.rawWorklet.port.onmessage = null; try { this.rawWorklet.disconnect(); } catch { /* ok */ } this.rawWorklet = undefined; }
    if (this.rawSource) { try { this.rawSource.disconnect(); } catch { /* ok */ } this.rawSource = undefined; }
    if (this.keepAliveNode) { try { this.keepAliveNode.stop(); this.keepAliveNode.disconnect(); } catch { /* ok */ } this.keepAliveNode = undefined; }
    if (this.rawSink) { try { this.rawSink.disconnect(); } catch { /* ok */ } this.rawSink = undefined; }
    if (this.rawStream) { this.rawStream.getTracks().forEach(t => t.stop()); this.rawStream = undefined; }
    if (this.rawContext && this.rawContext.state !== 'closed') { this.rawContext.close().catch(() => {}); }
    this.rawContext = undefined;
  }
}
