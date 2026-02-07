// Audio Module Main Export
export * from './recorder';
export * from './wav';

// Re-export main classes and functions
export { AudioRecorder, DEFAULT_RECORDER_CONFIG, checkMicrophoneAccess, getAudioInputDevices } from './recorder';
export { 
  decodeAudioData, 
  createWAVFile, 
  readWAVFile, 
  floatTo16BitPCM, 
  pcm16BitToFloat,
  blobToAudioData,
  saveAsWAV 
} from './wav';