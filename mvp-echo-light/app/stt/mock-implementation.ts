// Temporary mock implementation for STT while we work on ONNX integration
import { STTSession, TranscriptionResult, STTConfig, GPUInfo, PerformanceMetrics } from './types';

/**
 * Mock GPU detection for development
 */
export async function detectGPUCapabilities(): Promise<GPUInfo> {
  // Simulate GPU detection
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // In browser/Electron, we can check for WebGL support as a proxy for GPU
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  
  if (gl) {
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : 'Unknown GPU';
    
    return {
      available: true,
      provider: 'WebGL',
      device: renderer,
    };
  }
  
  return {
    available: false,
    provider: 'CPU',
    device: 'CPU'
  };
}

/**
 * Mock transcription pipeline
 */
export class MockTranscriptionPipeline {
  private modelSize: string;
  private useGPU: boolean;
  private isInitialized = false;

  constructor(modelSize: 'tiny' | 'base' | 'small', useGPU: boolean = true) {
    this.modelSize = modelSize;
    this.useGPU = useGPU;
  }

  async initialize(): Promise<void> {
    console.log(`Initializing mock ${this.modelSize} model (GPU: ${this.useGPU})`);
    // Simulate model loading time
    await new Promise(resolve => setTimeout(resolve, 1000));
    this.isInitialized = true;
    console.log('Mock STT pipeline initialized');
  }

  async transcribe(audioData: Float32Array, inputSampleRate: number = 44100): Promise<TranscriptionResult> {
    if (!this.isInitialized) {
      throw new Error('Pipeline not initialized');
    }

    console.log(`Mock transcribing ${audioData.length} samples at ${inputSampleRate}Hz`);
    
    // Simulate processing time based on model size and GPU usage
    const processingTime = this.useGPU ? 
      (this.modelSize === 'tiny' ? 200 : this.modelSize === 'base' ? 500 : 800) :
      (this.modelSize === 'tiny' ? 800 : this.modelSize === 'base' ? 1500 : 2500);
    
    await new Promise(resolve => setTimeout(resolve, processingTime));

    const mockTranscriptions = [
      "Hello, this is a mock transcription from the MVP Echo STT engine using ONNX Runtime simulation.",
      "The speech-to-text system is working with mock Whisper model integration and GPU acceleration testing.",
      "MVP Echo successfully demonstrates real-time voice transcription capabilities on Windows 11.",
      "This is a test of the audio processing pipeline with DirectML provider simulation.",
      "The application shows GPU detection, model loading, and transcription workflow integration.",
      "ONNX Runtime integration is ready for actual Whisper model deployment and inference.",
      "Audio preprocessing, feature extraction, and text generation pipeline is functioning correctly."
    ];

    const randomText = mockTranscriptions[Math.floor(Math.random() * mockTranscriptions.length)];
    
    // Add some variation based on audio content (mock)
    const audioEnergy = audioData.reduce((sum, sample) => sum + Math.abs(sample), 0) / audioData.length;
    const confidence = Math.min(0.99, 0.85 + audioEnergy * 100);

    return {
      text: randomText,
      confidence: Number(confidence.toFixed(3)),
      language: 'en',
      isPartial: false,
      timestamp: Date.now()
    };
  }

  getSessionInfo(): { modelName: string; mode: 'gpu' | 'cpu' } {
    return {
      modelName: `whisper-${this.modelSize}`,
      mode: this.useGPU ? 'gpu' : 'cpu'
    };
  }

  async cleanup(): Promise<void> {
    console.log('Cleaning up mock transcription pipeline');
    this.isInitialized = false;
  }

  isProcessingAudio(): boolean {
    return false; // Mock implementation doesn't track processing state
  }
}

/**
 * Create mock transcription pipeline
 */
export async function createTranscriptionPipeline(
  modelSize: 'tiny' | 'base' | 'small' = 'base',
  useGPU: boolean = true
): Promise<MockTranscriptionPipeline> {
  const pipeline = new MockTranscriptionPipeline(modelSize, useGPU);
  await pipeline.initialize();
  return pipeline;
}

/**
 * Mock model availability check
 */
export function isModelAvailable(modelSize: 'tiny' | 'base' | 'small'): boolean {
  // For mock implementation, always return true
  console.log(`Checking availability of ${modelSize} model: Available (mock)`);
  return true;
}

/**
 * Mock model path function
 */
export function getModelPath(modelSize: 'tiny' | 'base' | 'small'): string {
  return `/models/whisper-${modelSize}.onnx`;
}

/**
 * Mock performance benchmark
 */
export async function benchmarkInference(
  session: any,
  sampleAudio: Float32Array
): Promise<PerformanceMetrics> {
  // Simulate benchmark
  await new Promise(resolve => setTimeout(resolve, 200));
  
  const audioLength = sampleAudio.length / 16000; // Assuming 16kHz
  const mockInferenceTime = 150 + Math.random() * 100; // 150-250ms
  const realTimeFactor = mockInferenceTime / (audioLength * 1000);
  
  return {
    inferenceTime: mockInferenceTime,
    realTimeFactor,
    memoryUsage: 50 * 1024 * 1024, // 50MB mock
    modelLoadTime: 1000
  };
}