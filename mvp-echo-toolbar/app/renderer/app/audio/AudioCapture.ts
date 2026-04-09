/**
 * Audio recording functionality (renderer process)
 * Extracted from App.tsx for use in hidden capture window
 */
const RAW_PCM_SAMPLE_RATE = 16000;

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
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.sourceNode.connect(this.analyser);

    // Start monitoring audio levels
    this.monitorAudioLevel();

    this.mediaRecorder.ondataavailable = (event) => {
      this.audioChunks.push(event.data);
      console.log(`[AudioCapture] Chunk received: ${event.data.size} bytes (total chunks: ${this.audioChunks.length})`);
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
   * Start recording for WebGPU path.
   * Uses the same proven MediaRecorder as the standard path — no ScriptProcessorNode
   * or AudioWorklet, which crash in Electron's hidden window on Windows.
   * The WebM is decoded to PCM in stopRawRecording() via decodeAudioData.
   */
  async startRawRecording(onAudioLevel?: (level: number) => void): Promise<void> {
    console.log('[AudioCapture] Starting recording (WebGPU mode — will decode to PCM)');
    return this.startRecording(onAudioLevel);
  }

  /**
   * Stop WebGPU recording: get WebM from MediaRecorder, send to main process
   * for ffmpeg conversion to 16kHz PCM, return Float32Array.
   *
   * CRITICAL: Audio decoding (decodeAudioData, ScriptProcessorNode, AudioWorklet)
   * ALL crash in Electron's hidden window on Windows with access violation 0xC0000005.
   * The only safe path is ffmpeg in the main process, which is already proven for
   * the local CPU adapter.
   */
  async stopRawRecording(): Promise<{ pcm: Float32Array; sampleRate: number }> {
    // Get WebM from MediaRecorder via standard stop
    const webmBuffer = await this.stopRecording();
    console.log(`[AudioCapture] WebM buffer: ${webmBuffer.byteLength} bytes, sending to main for PCM conversion...`);

    if (webmBuffer.byteLength === 0) {
      return { pcm: new Float32Array(0), sampleRate: RAW_PCM_SAMPLE_RATE };
    }

    // Send to main process for ffmpeg WebM → 16kHz mono WAV → Float32Array
    const ipc = (window as any).electronAPI;
    if (!ipc?.convertToPcm) {
      throw new Error('convertToPcm IPC not available');
    }

    const audioArray = Array.from(new Uint8Array(webmBuffer));
    const result = await ipc.convertToPcm(audioArray);

    if (!result.success) {
      throw new Error(`PCM conversion failed: ${result.error}`);
    }

    const pcm = new Float32Array(result.pcm);
    console.log(`[AudioCapture] Got PCM from main: ${pcm.length} samples at ${RAW_PCM_SAMPLE_RATE}Hz (${(pcm.length / RAW_PCM_SAMPLE_RATE).toFixed(1)}s)`);
    return { pcm, sampleRate: RAW_PCM_SAMPLE_RATE };
  }

  cleanup(): void {
    if (this.animationId !== undefined) {
      cancelAnimationFrame(this.animationId);
      this.animationId = undefined;
    }

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
