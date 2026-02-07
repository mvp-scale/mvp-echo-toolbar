// WAV File Processing Utilities
/**
 * Convert WebM/Opus audio to PCM data for processing
 * This uses the Web Audio API to decode various audio formats
 */
export async function decodeAudioData(audioBuffer: ArrayBuffer, targetSampleRate: number = 16000): Promise<Float32Array> {
  try {
    // Create audio context with target sample rate
    const audioContext = new AudioContext({
      sampleRate: targetSampleRate
    });
    
    // Decode the audio data
    const decodedBuffer = await audioContext.decodeAudioData(audioBuffer);
    
    console.log(`Decoded audio: ${decodedBuffer.length} samples, ${decodedBuffer.numberOfChannels} channels, ${decodedBuffer.sampleRate}Hz`);
    
    // Get audio data (convert to mono if needed)
    let audioData: Float32Array;
    
    if (decodedBuffer.numberOfChannels === 1) {
      // Already mono
      audioData = decodedBuffer.getChannelData(0);
    } else {
      // Convert to mono by averaging channels
      const leftChannel = decodedBuffer.getChannelData(0);
      const rightChannel = decodedBuffer.getChannelData(1);
      audioData = new Float32Array(leftChannel.length);
      
      for (let i = 0; i < leftChannel.length; i++) {
        audioData[i] = (leftChannel[i] + rightChannel[i]) / 2;
      }
    }
    
    // Close audio context to free resources
    await audioContext.close();
    
    console.log(`Processed audio: ${audioData.length} samples, mono, ${targetSampleRate}Hz`);
    return audioData;
    
  } catch (error) {
    console.error('Failed to decode audio data:', error);
    throw new Error(`Audio decoding failed: ${error.message}`);
  }
}

/**
 * Create a WAV file header for PCM data
 */
export function createWAVHeader(
  dataLength: number,
  sampleRate: number = 16000,
  channels: number = 1,
  bitsPerSample: number = 16
): ArrayBuffer {
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  
  // WAV Header
  // "RIFF" identifier
  view.setUint32(0, 0x52494646, false);
  // File length minus 8 bytes
  view.setUint32(4, 36 + dataLength, true);
  // "WAVE" identifier
  view.setUint32(8, 0x57415645, false);
  
  // Format chunk
  // "fmt " identifier
  view.setUint32(12, 0x666d7420, false);
  // Format chunk length
  view.setUint32(16, 16, true);
  // Sample format (1 = PCM)
  view.setUint16(20, 1, true);
  // Channel count
  view.setUint16(22, channels, true);
  // Sample rate
  view.setUint32(24, sampleRate, true);
  // Byte rate
  view.setUint32(28, byteRate, true);
  // Block align
  view.setUint16(32, blockAlign, true);
  // Bits per sample
  view.setUint16(34, bitsPerSample, true);
  
  // Data chunk
  // "data" identifier
  view.setUint32(36, 0x64617461, false);
  // Data chunk length
  view.setUint32(40, dataLength, true);
  
  return buffer;
}

/**
 * Convert Float32Array to 16-bit PCM
 */
export function floatTo16BitPCM(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  
  for (let i = 0; i < input.length; i++) {
    // Clamp to [-1, 1] and convert to 16-bit
    const clamped = Math.max(-1, Math.min(1, input[i]));
    output[i] = Math.round(clamped * 32767);
  }
  
  return output;
}

/**
 * Convert 16-bit PCM to Float32Array
 */
export function pcm16BitToFloat(input: Int16Array): Float32Array {
  const output = new Float32Array(input.length);
  
  for (let i = 0; i < input.length; i++) {
    output[i] = input[i] / 32768;
  }
  
  return output;
}

/**
 * Create a complete WAV file from Float32Array audio data
 */
export function createWAVFile(
  audioData: Float32Array,
  sampleRate: number = 16000,
  channels: number = 1
): ArrayBuffer {
  // Convert to 16-bit PCM
  const pcmData = floatTo16BitPCM(audioData);
  const pcmBytes = pcmData.length * 2; // 2 bytes per 16-bit sample
  
  // Create WAV header
  const header = createWAVHeader(pcmBytes, sampleRate, channels, 16);
  
  // Combine header and data
  const wavBuffer = new ArrayBuffer(header.byteLength + pcmBytes);
  const wavView = new Uint8Array(wavBuffer);
  
  // Copy header
  wavView.set(new Uint8Array(header), 0);
  
  // Copy PCM data
  const pcmView = new Uint8Array(pcmData.buffer);
  wavView.set(pcmView, header.byteLength);
  
  return wavBuffer;
}

/**
 * Read WAV file and extract audio data
 */
export function readWAVFile(wavBuffer: ArrayBuffer): {
  audioData: Float32Array;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
} {
  const view = new DataView(wavBuffer);
  
  // Check for RIFF header
  if (view.getUint32(0, false) !== 0x52494646) {
    throw new Error('Invalid WAV file: missing RIFF header');
  }
  
  // Check for WAVE identifier
  if (view.getUint32(8, false) !== 0x57415645) {
    throw new Error('Invalid WAV file: missing WAVE identifier');
  }
  
  // Find format chunk
  let offset = 12;
  let formatChunkFound = false;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  
  while (offset < wavBuffer.byteLength && !formatChunkFound) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    
    if (chunkId === 0x666d7420) { // "fmt "
      formatChunkFound = true;
      const audioFormat = view.getUint16(offset + 8, true);
      
      if (audioFormat !== 1) {
        throw new Error('Unsupported WAV format: only PCM is supported');
      }
      
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
      
      if (bitsPerSample !== 16) {
        throw new Error('Unsupported bit depth: only 16-bit is supported');
      }
    }
    
    offset += 8 + chunkSize;
  }
  
  if (!formatChunkFound) {
    throw new Error('WAV format chunk not found');
  }
  
  // Find data chunk
  offset = 12;
  let dataChunkFound = false;
  let audioData: Float32Array = new Float32Array(0);
  
  while (offset < wavBuffer.byteLength && !dataChunkFound) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    
    if (chunkId === 0x64617461) { // "data"
      dataChunkFound = true;
      const dataOffset = offset + 8;
      const sampleCount = chunkSize / 2; // 16-bit samples
      
      const pcmData = new Int16Array(wavBuffer, dataOffset, sampleCount);
      audioData = pcm16BitToFloat(pcmData);
    }
    
    offset += 8 + chunkSize;
  }
  
  if (!dataChunkFound) {
    throw new Error('WAV data chunk not found');
  }
  
  return {
    audioData,
    sampleRate,
    channels,
    bitsPerSample
  };
}

/**
 * Convert audio blob to Float32Array
 */
export async function blobToAudioData(blob: Blob, targetSampleRate: number = 16000): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  return await decodeAudioData(arrayBuffer, targetSampleRate);
}

/**
 * Save audio data as downloadable WAV file
 */
export function saveAsWAV(audioData: Float32Array, filename: string = 'recording.wav', sampleRate: number = 16000): void {
  const wavBuffer = createWAVFile(audioData, sampleRate);
  const blob = new Blob([wavBuffer], { type: 'audio/wav' });
  
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  
  URL.revokeObjectURL(url);
}