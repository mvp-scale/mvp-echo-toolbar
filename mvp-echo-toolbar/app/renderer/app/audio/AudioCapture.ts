/**
 * Audio recording functionality (renderer process)
 * Extracted from App.tsx for use in hidden capture window
 */
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
  private rawSource?: MediaStreamAudioSourceNode;
  private rawWorklet?: AudioWorkletNode;
  private rawStream?: MediaStream;
  private rawEngineStartedAt = 0;

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
  private static readonly MAX_ENGINE_AGE_MS = 10 * 60 * 1000; // freshen-up after 10 min uptime


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
    if (this.rawContext && this.rawContext.state !== 'closed') {
      if (this.rawEngineAgeMs() < AudioCapture.MAX_ENGINE_AGE_MS) return;
      console.log('[AudioCapture] Raw engine stale — rebuilding (freshen-up)');
      await this.teardownRawEngine();
    }

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
    console.log(`[AudioCapture] Raw engine created: requested ${RAW_PCM_SAMPLE_RATE}Hz, got ${ctx.sampleRate}Hz, state=${ctx.state}`);

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

    this.rawEngineStartedAt = Date.now();
  }

  /** Fully tear down the persistent raw engine (recovery / unmount). */
  async teardownRawEngine(): Promise<void> {
    if (this.rawWorklet) { this.rawWorklet.port.onmessage = null; try { this.rawWorklet.disconnect(); } catch { /* ok */ } this.rawWorklet = undefined; }
    if (this.rawSource) { try { this.rawSource.disconnect(); } catch { /* ok */ } this.rawSource = undefined; }
    if (this.keepAliveNode) { try { this.keepAliveNode.stop(); this.keepAliveNode.disconnect(); } catch { /* ok */ } this.keepAliveNode = undefined; }
    if (this.rawStream) { this.rawStream.getTracks().forEach(t => t.stop()); this.rawStream = undefined; }
    if (this.rawContext && this.rawContext.state !== 'closed') { try { await this.rawContext.close(); } catch { /* ok */ } }
    this.rawContext = undefined;
    this.pcmChunks = [];
    console.log('[AudioCapture] Raw engine torn down');
  }

  /**
   * Start recording raw PCM via AudioWorklet on the persistent engine.
   * The context+worklet+keep-alive persist across recordings (suspended between);
   * only the mic stream + per-recording nodes are (re)created here.
   */
  async startRawRecording(onAudioLevel?: (level: number) => void): Promise<void> {
    this.onAudioLevel = onAudioLevel;

    await this.ensureRawEngine();
    const ctx = this.rawContext!;
    if (ctx.state === 'suspended') await ctx.resume();

    console.log('[AudioCapture] Requesting mic (raw PCM via AudioWorklet)...');
    try {
      this.rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      });
    } catch (err) {
      console.error('[AudioCapture] getUserMedia FAILED (raw PCM):', err);
      throw err;
    }
    console.log(`[AudioCapture] Mic granted (raw PCM): ${this.rawStream.getAudioTracks().length} track(s); ctx.state=${ctx.state}, rate=${ctx.sampleRate}, engineAge=${Math.round(this.rawEngineAgeMs() / 1000)}s`);

    this.rawSource = ctx.createMediaStreamSource(this.rawStream);

    this.pcmChunks = [];
    this.rawWorklet = new AudioWorkletNode(ctx, 'pcm-capture');
    this.rawWorklet.port.onmessage = (e: MessageEvent) => {
      this.pcmChunks.push(e.data as Float32Array);
    };
    this.rawSource.connect(this.rawWorklet);

    console.log(`[AudioCapture] Raw PCM recording at ${ctx.sampleRate}Hz (persistent engine)`);
  }

  /**
   * Stop WebGPU recording: collect PCM chunks, resample to 16kHz only if the
   * context didn't honor 16kHz. Returns the PCM plus the peak amplitude (so the
   * caller can detect a silent/wedged capture). Keeps the engine alive
   * (suspended) — does NOT close the context.
   */
  async stopRawRecording(): Promise<{ pcm: Float32Array; sampleRate: number; peak: number }> {
    const rate = this.rawContextRate || RAW_PCM_SAMPLE_RATE;

    // Release per-recording nodes + mic, but keep context/worklet/keep-alive.
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

    console.log(`[AudioCapture] Raw PCM: ${rawPcm.length} samples at ${rate}Hz (${(rawPcm.length / rate).toFixed(1)}s) — peak=${peak.toFixed(4)} min=${min.toFixed(4)} max=${max.toFixed(4)} rms=${rms.toFixed(4)}`);

    // Resample only if the context did NOT honor 16kHz.
    let pcm: Float32Array;
    if (rate !== RAW_PCM_SAMPLE_RATE && rawPcm.length > 0) {
      console.log(`[AudioCapture] Resampling ${rate}Hz → ${RAW_PCM_SAMPLE_RATE}Hz...`);
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
      console.log(`[AudioCapture] Resampled: ${pcm.length} samples`);
    } else {
      pcm = rawPcm;
    }

    // Suspend (not close) the persistent context between recordings.
    if (this.rawContext && this.rawContext.state === 'running') {
      this.rawContext.suspend().catch(() => {});
    }

    return { pcm, sampleRate: RAW_PCM_SAMPLE_RATE, peak };
  }

  cleanup(): void {
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
    if (this.rawStream) { this.rawStream.getTracks().forEach(t => t.stop()); this.rawStream = undefined; }
    if (this.rawContext && this.rawContext.state !== 'closed') { this.rawContext.close().catch(() => {}); }
    this.rawContext = undefined;
  }
}
