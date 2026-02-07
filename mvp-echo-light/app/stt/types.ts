// STT Module Type Definitions
export interface STTSession {
  session: any; // ONNX Runtime InferenceSession
  mode: 'gpu' | 'cpu';
  modelName: string;
  isActive: boolean;
}

export interface TranscriptionResult {
  text: string;
  confidence: number;
  language?: string;
  isPartial?: boolean;
  timestamp?: number;
}

export interface AudioConfig {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  chunkSize: number;
}

export interface GPUInfo {
  available: boolean;
  provider: string;
  device: string;
  memory?: number;
}

export interface PerformanceMetrics {
  inferenceTime: number;
  realTimeFactor: number;
  memoryUsage: number;
  modelLoadTime: number;
}

export interface STTConfig {
  modelSize: 'tiny' | 'base' | 'small';
  useGPU: boolean;
  language?: string;
  audioConfig: AudioConfig;
}

export const DEFAULT_AUDIO_CONFIG: AudioConfig = {
  sampleRate: 16000,
  channels: 1,
  bitDepth: 16,
  chunkSize: 1024,
};