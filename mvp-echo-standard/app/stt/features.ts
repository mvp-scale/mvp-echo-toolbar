// Audio Preprocessing and Feature Extraction for Whisper
import { DEFAULT_AUDIO_CONFIG } from './types';

/**
 * Convert audio to the format expected by Whisper models
 * Input: Raw audio data (various formats)
 * Output: Float32Array normalized to [-1, 1] at 16kHz mono
 */
export function preprocessAudio(audioData: ArrayBuffer | Float32Array | Int16Array): Float32Array {
  let floatArray: Float32Array;
  
  if (audioData instanceof Float32Array) {
    floatArray = audioData;
  } else if (audioData instanceof Int16Array) {
    // Convert 16-bit PCM to float
    floatArray = new Float32Array(audioData.length);
    for (let i = 0; i < audioData.length; i++) {
      floatArray[i] = audioData[i] / 32768.0;
    }
  } else if (audioData instanceof ArrayBuffer) {
    // Assume 16-bit PCM from ArrayBuffer
    const int16Array = new Int16Array(audioData);
    floatArray = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      floatArray[i] = int16Array[i] / 32768.0;
    }
  } else {
    throw new Error('Unsupported audio data format');
  }
  
  // Normalize audio to [-1, 1] range
  return normalizeAudio(floatArray);
}

/**
 * Normalize audio amplitude to [-1, 1] range
 */
function normalizeAudio(audio: Float32Array): Float32Array {
  const maxVal = Math.max(...Array.from(audio).map(Math.abs));
  if (maxVal === 0) return audio; // Silence
  
  const normalized = new Float32Array(audio.length);
  const scale = 1.0 / maxVal;
  
  for (let i = 0; i < audio.length; i++) {
    normalized[i] = audio[i] * scale;
  }
  
  return normalized;
}

/**
 * Resample audio to target sample rate (basic implementation)
 * For production use, consider using a proper resampling library
 */
export function resampleAudio(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number = DEFAULT_AUDIO_CONFIG.sampleRate
): Float32Array {
  if (inputSampleRate === outputSampleRate) {
    return input;
  }
  
  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);
  
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcIndexFloor = Math.floor(srcIndex);
    const srcIndexCeil = Math.min(srcIndexFloor + 1, input.length - 1);
    const fraction = srcIndex - srcIndexFloor;
    
    // Linear interpolation
    output[i] = input[srcIndexFloor] * (1 - fraction) + input[srcIndexCeil] * fraction;
  }
  
  return output;
}

/**
 * Apply padding or trimming to match Whisper's expected input length
 * Whisper expects 30-second chunks (480,000 samples at 16kHz)
 */
export function padOrTrimAudio(audio: Float32Array, targetLength: number = 480000): Float32Array {
  if (audio.length === targetLength) {
    return audio;
  }
  
  const result = new Float32Array(targetLength);
  
  if (audio.length > targetLength) {
    // Trim - take the first targetLength samples
    result.set(audio.subarray(0, targetLength));
  } else {
    // Pad with zeros
    result.set(audio);
    // The rest remains zeros (default for Float32Array)
  }
  
  return result;
}

/**
 * Generate mel-spectrogram features for Whisper
 * This is a simplified version - production would use a proper FFT library
 */
export function generateMelSpectrogram(audio: Float32Array): Float32Array {
  // For MVP, we'll pass the raw audio and let ONNX model handle mel-spectrogram
  // In production, you might want to pre-compute this for better control
  
  // Whisper models typically expect [1, 80, 3000] mel-spectrogram input
  // but some ONNX exports take raw audio [1, N] and compute mel internally
  
  return audio;
}

/**
 * Apply pre-emphasis filter to audio (common in speech processing)
 */
export function applyPreEmphasis(audio: Float32Array, coefficient: number = 0.97): Float32Array {
  if (audio.length < 2) return audio;
  
  const filtered = new Float32Array(audio.length);
  filtered[0] = audio[0];
  
  for (let i = 1; i < audio.length; i++) {
    filtered[i] = audio[i] - coefficient * audio[i - 1];
  }
  
  return filtered;
}

/**
 * Convert stereo to mono by averaging channels
 */
export function stereoToMono(stereoData: Float32Array): Float32Array {
  const monoLength = Math.floor(stereoData.length / 2);
  const monoData = new Float32Array(monoLength);
  
  for (let i = 0; i < monoLength; i++) {
    monoData[i] = (stereoData[i * 2] + stereoData[i * 2 + 1]) / 2;
  }
  
  return monoData;
}

/**
 * Complete audio preprocessing pipeline for Whisper
 */
export function processAudioForWhisper(
  rawAudio: ArrayBuffer | Float32Array | Int16Array,
  inputSampleRate: number = 44100,
  maxLength: number = 480000 // 30 seconds at 16kHz
): Float32Array {
  console.log(`Processing audio: ${rawAudio.length} samples at ${inputSampleRate}Hz`);
  
  // Step 1: Convert to Float32Array and normalize
  let audio = preprocessAudio(rawAudio);
  
  // Step 2: Convert stereo to mono if needed
  if (inputSampleRate === 44100 && audio.length % 2 === 0) {
    // Assume stereo if even length at common sample rate
    // This is a heuristic - in production, you'd know the channel count
    const possibleMono = stereoToMono(audio);
    if (possibleMono.length * 2 === audio.length) {
      audio = possibleMono;
      console.log('Converted stereo to mono');
    }
  }
  
  // Step 3: Resample to 16kHz if needed
  if (inputSampleRate !== DEFAULT_AUDIO_CONFIG.sampleRate) {
    audio = resampleAudio(audio, inputSampleRate, DEFAULT_AUDIO_CONFIG.sampleRate);
    console.log(`Resampled from ${inputSampleRate}Hz to ${DEFAULT_AUDIO_CONFIG.sampleRate}Hz`);
  }
  
  // Step 4: Apply pre-emphasis (optional, improves some Whisper models)
  audio = applyPreEmphasis(audio);
  
  // Step 5: Pad or trim to expected length
  audio = padOrTrimAudio(audio, maxLength);
  
  console.log(`Processed audio: ${audio.length} samples, range [${Math.min(...audio)}, ${Math.max(...audio)}]`);
  
  return audio;
}

/**
 * Detect if audio contains speech (simple energy-based VAD)
 */
export function detectSpeech(audio: Float32Array, threshold: number = 0.01): boolean {
  const energy = audio.reduce((sum, sample) => sum + sample * sample, 0) / audio.length;
  return energy > threshold;
}

/**
 * Split long audio into chunks for processing
 */
export function chunkAudio(
  audio: Float32Array,
  chunkSize: number = 480000, // 30 seconds
  overlapSize: number = 80000 // 5 seconds overlap
): Float32Array[] {
  if (audio.length <= chunkSize) {
    return [audio];
  }
  
  const chunks: Float32Array[] = [];
  let start = 0;
  
  while (start < audio.length) {
    const end = Math.min(start + chunkSize, audio.length);
    const chunk = audio.slice(start, end);
    
    // Pad the last chunk if it's too short
    if (chunk.length < chunkSize) {
      const paddedChunk = new Float32Array(chunkSize);
      paddedChunk.set(chunk);
      chunks.push(paddedChunk);
    } else {
      chunks.push(chunk);
    }
    
    start += chunkSize - overlapSize;
  }
  
  return chunks;
}