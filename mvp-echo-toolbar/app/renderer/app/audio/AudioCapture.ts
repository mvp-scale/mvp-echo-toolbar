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
  // audio pipeline into "running but silent" capture. The mic is still acquired
  // per recording (privacy); the context is SUSPENDED between recordings, not
  // closed. A staleness freshen-up rebuilds the engine after long uptime.
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

  /** Fully tear down the persistent raw engine (recovery / unmount). */
  async teardownRawEngine(): Promise<void> {
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
   * only the mic stream + per-recording nodes are (re)created here.
   */
  async startRawRecording(onAudioLevel?: (level: number) => void): Promise<void> {
    this.onAudioLevel = onAudioLevel;

    // Reset capture-ready tracking for this recording (timestamp ≈ keypress).
    this.captureReadyFired = false;
    this.captureReadySamples = 0;
    this.captureStartTs = Date.now();

    await this.ensureRawEngine();
    const ctx = this.rawContext!;
    if (ctx.state === 'suspended') await ctx.resume();

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

    // ── Diagnostics: device fingerprint + settings captured at START (track is
    // live now; at stop it's been stopped). The hash detects a Windows device/
    // default swap between recordings; idleGap detects a cold-after-gap device.
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

    this.rawSource = ctx.createMediaStreamSource(this.rawStream);

    this.pcmChunks = [];
    this.workletMsgCount = 0;
    const readySamplesNeeded = Math.round(ctx.sampleRate * 0.25); // ~250ms of unmuted frames = "really flowing"
    this.rawWorklet = new AudioWorkletNode(ctx, 'pcm-capture');
    this.rawWorklet.port.onmessage = (e: MessageEvent) => {
      this.workletMsgCount++;
      const chunk = e.data as Float32Array;
      this.pcmChunks.push(chunk);
      this.maybeFireCaptureReady(chunk.length, readySamplesNeeded);
    };
    this.rawSource.connect(this.rawWorklet);
    // Give the worklet a path to the destination (silent sink) so the graph
    // reliably pulls the mic through it every quantum. Worklet writes no output → silent.
    if (this.rawSink) this.rawWorklet.connect(this.rawSink);

    // Safety net: always emit a "talk now" cue even if the readiness gate never
    // resolves (e.g. a device that never clears track.muted) — better a slightly
    // early cue than none. Cleared the instant the real signal fires (or on stop).
    this.captureReadyTimer = setTimeout(() => this.fireCaptureReady('timeout'), 1500);

    dlog(`[AudioCapture] Raw PCM recording at ${ctx.sampleRate}Hz (persistent engine, worklet→sink→destination)`);
  }

  /**
   * Fire the capture-ready cue once enough frames have flowed WHILE UNMUTED.
   * Frames received while the track reports muted (the headset's auto-unmute
   * transition) are NOT counted — so "ready" means ~250ms of genuinely-live
   * audio, which is exactly the dead window we don't want the user speaking into.
   */
  private maybeFireCaptureReady(n: number, needed: number): void {
    if (this.captureReadyFired) return;
    const track = this.rawStream?.getAudioTracks?.()[0];
    if (track && track.muted) return; // still mid-unmute — don't say "talk now" yet
    this.captureReadySamples += n;
    if (this.captureReadySamples >= needed) this.fireCaptureReady('frames');
  }

  /** Mark capture live, clear the fallback timer, notify CaptureApp exactly once. */
  private fireCaptureReady(via: string): void {
    if (this.captureReadyFired) return;
    this.captureReadyFired = true;
    if (this.captureReadyTimer) { clearTimeout(this.captureReadyTimer); this.captureReadyTimer = undefined; }
    const latencyMs = Date.now() - this.captureStartTs;
    dlog(`[AudioCapture] capture-ready via ${via} after ${latencyMs}ms`);
    try { this.onCaptureReady?.(latencyMs); } catch { /* ok */ }
  }

  /**
   * Stop WebGPU recording: collect PCM chunks, resample to 16kHz only if the
   * context didn't honor 16kHz. Returns the PCM plus the peak amplitude (so the
   * caller can detect a silent/wedged capture). Keeps the engine alive
   * (suspended) — does NOT close the context.
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

    // Release per-recording nodes + mic, but keep context/worklet/keep-alive.
    if (this.captureReadyTimer) { clearTimeout(this.captureReadyTimer); this.captureReadyTimer = undefined; }
    if (this.rawWorklet) { this.rawWorklet.port.onmessage = null; try { this.rawWorklet.disconnect(); } catch { /* ok */ } this.rawWorklet = undefined; }
    if (this.rawSource) { try { this.rawSource.disconnect(); } catch { /* ok */ } this.rawSource = undefined; }
    if (this.rawStream) { this.rawStream.getTracks().forEach(t => t.stop()); this.rawStream = undefined; }

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
    return { pcm, sampleRate: RAW_PCM_SAMPLE_RATE, peak, rms, diag };
  }

  cleanup(): void {
    if (this.captureReadyTimer) { clearTimeout(this.captureReadyTimer); this.captureReadyTimer = undefined; }
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
