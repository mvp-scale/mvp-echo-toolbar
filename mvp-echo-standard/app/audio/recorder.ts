// Audio Recording Utilities for Electron Renderer
export interface AudioRecorderConfig {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export const DEFAULT_RECORDER_CONFIG: AudioRecorderConfig = {
  sampleRate: 44100, // Capture at high quality, we'll downsample later
  channels: 1,
  bitDepth: 16,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export class AudioRecorder {
  private mediaRecorder?: MediaRecorder;
  private audioStream?: MediaStream;
  private audioChunks: Blob[] = [];
  private isRecording = false;
  private config: AudioRecorderConfig;
  private audioContext?: AudioContext;
  private analyser?: AnalyserNode;
  private dataArray?: Uint8Array;

  // Event callbacks
  public onDataAvailable?: (audioData: ArrayBuffer) => void;
  public onAudioLevel?: (level: number) => void;
  public onError?: (error: Error) => void;
  public onStarted?: () => void;
  public onStopped?: () => void;

  constructor(config: AudioRecorderConfig = DEFAULT_RECORDER_CONFIG) {
    this.config = config;
  }

  /**
   * Start audio recording
   */
  async startRecording(): Promise<void> {
    if (this.isRecording) {
      throw new Error('Recording is already in progress');
    }

    try {
      console.log('Starting audio recording...');
      
      // Request microphone access
      this.audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: this.config.sampleRate,
          channelCount: this.config.channels,
          echoCancellation: this.config.echoCancellation,
          noiseSuppression: this.config.noiseSuppression,
          autoGainControl: this.config.autoGainControl,
        },
        video: false
      });

      // Setup audio context for level monitoring
      await this.setupAudioAnalysis();

      // Create MediaRecorder
      this.mediaRecorder = new MediaRecorder(this.audioStream, {
        mimeType: 'audio/webm;codecs=opus', // Good compression, widely supported
        audioBitsPerSecond: this.config.sampleRate * this.config.bitDepth * this.config.channels
      });

      // Handle data availability
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      // Handle recording stop
      this.mediaRecorder.onstop = async () => {
        console.log('Recording stopped, processing audio...');
        await this.processRecordedAudio();
        this.onStopped?.();
      };

      // Handle errors
      this.mediaRecorder.onerror = (event) => {
        console.error('MediaRecorder error:', event);
        this.onError?.(new Error('Recording failed'));
      };

      // Start recording with small time slices for real-time processing
      this.mediaRecorder.start(100); // 100ms chunks
      this.isRecording = true;
      
      // Start audio level monitoring
      this.startLevelMonitoring();
      
      console.log('Recording started successfully');
      this.onStarted?.();
      
    } catch (error) {
      console.error('Failed to start recording:', error);
      this.cleanup();
      throw error;
    }
  }

  /**
   * Stop audio recording
   */
  async stopRecording(): Promise<ArrayBuffer> {
    if (!this.isRecording || !this.mediaRecorder) {
      throw new Error('No recording in progress');
    }

    console.log('Stopping recording...');
    
    return new Promise((resolve, reject) => {
      if (!this.mediaRecorder) {
        reject(new Error('MediaRecorder not available'));
        return;
      }

      // Set up one-time listener for stop event
      const originalOnStop = this.mediaRecorder.onstop;
      this.mediaRecorder.onstop = async (event) => {
        try {
          // Call original handler
          if (originalOnStop) {
            await originalOnStop.call(this.mediaRecorder, event);
          }
          
          // Process and return audio data
          const audioBuffer = await this.getFinalAudioBuffer();
          resolve(audioBuffer);
        } catch (error) {
          reject(error);
        }
      };

      this.mediaRecorder.stop();
      this.isRecording = false;
      this.stopLevelMonitoring();
    });
  }

  /**
   * Get current audio level (0-1)
   */
  getCurrentAudioLevel(): number {
    if (!this.analyser || !this.dataArray) {
      return 0;
    }

    this.analyser.getByteFrequencyData(this.dataArray);
    
    // Calculate RMS level
    let sum = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      sum += this.dataArray[i] * this.dataArray[i];
    }
    
    const rms = Math.sqrt(sum / this.dataArray.length);
    return Math.min(rms / 128, 1); // Normalize to 0-1
  }

  /**
   * Check if currently recording
   */
  getIsRecording(): boolean {
    return this.isRecording;
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    console.log('Cleaning up audio recorder...');
    
    this.stopLevelMonitoring();
    
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
    }
    
    if (this.audioStream) {
      this.audioStream.getTracks().forEach(track => track.stop());
    }
    
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
    
    this.mediaRecorder = undefined;
    this.audioStream = undefined;
    this.audioContext = undefined;
    this.analyser = undefined;
    this.dataArray = undefined;
    this.audioChunks = [];
    this.isRecording = false;
  }

  /**
   * Setup audio analysis for level monitoring
   */
  private async setupAudioAnalysis(): Promise<void> {
    if (!this.audioStream) return;

    this.audioContext = new AudioContext({
      sampleRate: this.config.sampleRate
    });
    
    const source = this.audioContext.createMediaStreamSource(this.audioStream);
    this.analyser = this.audioContext.createAnalyser();
    
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.8;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    
    source.connect(this.analyser);
  }

  /**
   * Start monitoring audio levels
   */
  private startLevelMonitoring(): void {
    const monitorLevel = () => {
      if (this.isRecording) {
        const level = this.getCurrentAudioLevel();
        this.onAudioLevel?.(level);
        requestAnimationFrame(monitorLevel);
      }
    };
    requestAnimationFrame(monitorLevel);
  }

  /**
   * Stop monitoring audio levels
   */
  private stopLevelMonitoring(): void {
    // Level monitoring will stop automatically when isRecording becomes false
  }

  /**
   * Process recorded audio chunks
   */
  private async processRecordedAudio(): Promise<void> {
    if (this.audioChunks.length === 0) return;

    try {
      const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
      const arrayBuffer = await audioBlob.arrayBuffer();
      
      // For real-time processing, you might want to send chunks as they arrive
      this.onDataAvailable?.(arrayBuffer);
      
    } catch (error) {
      console.error('Error processing audio:', error);
      this.onError?.(new Error('Failed to process audio data'));
    }
  }

  /**
   * Get final audio buffer when recording stops
   */
  private async getFinalAudioBuffer(): Promise<ArrayBuffer> {
    if (this.audioChunks.length === 0) {
      return new ArrayBuffer(0);
    }

    const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
    const arrayBuffer = await audioBlob.arrayBuffer();
    
    // Clear chunks for next recording
    this.audioChunks = [];
    
    return arrayBuffer;
  }
}

/**
 * Check if microphone is available
 */
export async function checkMicrophoneAccess(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
    return true;
  } catch (error) {
    console.error('Microphone access denied:', error);
    return false;
  }
}

/**
 * Get available audio input devices
 */
export async function getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(device => device.kind === 'audioinput');
  } catch (error) {
    console.error('Failed to enumerate audio devices:', error);
    return [];
  }
}