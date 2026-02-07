// STT Module Main Export
export * from './types';
export * from './features';

// Use mock implementation for now while we develop the full ONNX integration
export { 
  MockTranscriptionPipeline as TranscriptionPipeline,
  createTranscriptionPipeline,
  detectGPUCapabilities,
  benchmarkInference,
  isModelAvailable,
  getModelPath
} from './mock-implementation';

// Audio processing functions
export { processAudioForWhisper, preprocessAudio, resampleAudio } from './features';