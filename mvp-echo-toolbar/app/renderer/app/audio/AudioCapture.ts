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

  /**
   * Start recording raw PCM via AudioWorklet.
   * Captures at the system's native sample rate (48kHz on Windows),
   * resampled to 16kHz in stopRawRecording().
   *
   * AudioWorklet requires a secure context (file://, localhost, or HTTPS).
   * Electron's hidden window qualifies. No ScriptProcessorNode (crashes on Windows),
   * no MediaRecorder decode (crashes on Windows), no ffmpeg.
   */
  async startRawRecording(onAudioLevel?: (level: number) => void): Promise<void> {
    this.onAudioLevel = onAudioLevel;

    console.log('[AudioCapture] Requesting mic (raw PCM via AudioWorklet)...');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
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
    console.log(`[AudioCapture] Mic granted (raw PCM): ${this.stream.getAudioTracks().length} track(s)`);

    this.audioContext = new AudioContext();
    // A fresh AudioContext can come up 'suspended' (esp. after long idle); if it
    // stays suspended the worklet never runs and we capture silence ("recorded
    // nothing"). Resume explicitly and log the state.
    if (this.audioContext.state === 'suspended') {
      console.log('[AudioCapture] AudioContext suspended on create — resuming');
      await this.audioContext.resume();
    }
    console.log(`[AudioCapture] AudioContext state=${this.audioContext.state}, sampleRate=${this.audioContext.sampleRate}`);
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);

    // Audio level monitoring
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.sourceNode.connect(this.analyser);
    this.monitorAudioLevel();

    // Register AudioWorklet processor via blob URL
    const workletCode = `
      class PcmCaptureProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0];
          if (input && input[0] && input[0].length > 0) {
            this.port.postMessage(new Float32Array(input[0]));
          }
          return true;
        }
      }
      registerProcessor('pcm-capture', PcmCaptureProcessor);
    `;
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(blob);
    await this.audioContext.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    this.pcmChunks = [];
    this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-capture');
    this.workletNode.port.onmessage = (e: MessageEvent) => {
      this.pcmChunks.push(e.data as Float32Array);
    };

    this.sourceNode.connect(this.workletNode);

    console.log(`[AudioCapture] Raw PCM recording at ${this.audioContext.sampleRate}Hz via AudioWorklet`);
  }

  /**
   * Stop WebGPU recording: collect PCM chunks from AudioWorklet,
   * resample to 16kHz, return Float32Array.
   */
  async stopRawRecording(): Promise<{ pcm: Float32Array; sampleRate: number }> {
    const nativeSampleRate = this.audioContext?.sampleRate || RAW_PCM_SAMPLE_RATE;

    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = undefined;
    }

    // Concatenate PCM chunks from worklet
    const totalLength = this.pcmChunks.reduce((sum, c) => sum + c.length, 0);
    const rawPcm = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.pcmChunks) {
      rawPcm.set(chunk, offset);
      offset += chunk.length;
    }
    this.pcmChunks = [];

    console.log(`[AudioCapture] Raw PCM: ${rawPcm.length} samples at ${nativeSampleRate}Hz (${(rawPcm.length / nativeSampleRate).toFixed(1)}s)`);

    // Resample to 16kHz if needed
    let pcm: Float32Array;
    if (nativeSampleRate !== RAW_PCM_SAMPLE_RATE && rawPcm.length > 0) {
      console.log(`[AudioCapture] Resampling ${nativeSampleRate}Hz → ${RAW_PCM_SAMPLE_RATE}Hz...`);
      const duration = rawPcm.length / nativeSampleRate;
      const outputLength = Math.ceil(duration * RAW_PCM_SAMPLE_RATE);
      const sourceBuffer = new AudioBuffer({
        length: rawPcm.length,
        numberOfChannels: 1,
        sampleRate: nativeSampleRate,
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

    this.cleanup();
    return { pcm, sampleRate: RAW_PCM_SAMPLE_RATE };
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
  }
}
