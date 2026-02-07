// GPU Detection and Health Monitoring
import * as ort from 'onnxruntime-web';
import { GPUInfo, PerformanceMetrics } from './types';

/**
 * Detects GPU capabilities and DirectML availability on Windows 11
 */
export async function detectGPUCapabilities(): Promise<GPUInfo> {
  try {
    // Test DirectML provider availability
    const testTensor = new ort.Tensor('float32', [1, 2, 3, 4], [1, 4]);
    
    try {
      // Attempt to create a simple session with DirectML provider
      const testSession = await ort.InferenceSession.create(
        new ArrayBuffer(0), // Empty model buffer for testing
        {
          executionProviders: ['DmlExecutionProvider'],
          graphOptimizationLevel: 'basic'
        }
      );
      
      await testSession.release();
      
      return {
        available: true,
        provider: 'DirectML',
        device: 'GPU',
        memory: await getGPUMemory()
      };
    } catch (dmlError) {
      console.warn('DirectML provider unavailable:', dmlError.message);
      
      // Fallback to CPU
      return {
        available: false,
        provider: 'CPU',
        device: 'CPU'
      };
    }
  } catch (error) {
    console.error('GPU detection failed:', error);
    return {
      available: false,
      provider: 'CPU',
      device: 'CPU'
    };
  }
}

/**
 * Get available GPU memory (Windows-specific implementation would go here)
 */
async function getGPUMemory(): Promise<number | undefined> {
  try {
    // On Windows, we could use WMI queries or DirectML APIs
    // For now, return undefined as it's not critical for MVP
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Benchmark inference performance
 */
export async function benchmarkInference(
  session: ort.InferenceSession,
  sampleAudio: Float32Array
): Promise<PerformanceMetrics> {
  const startTime = performance.now();
  const initialMemory = process.memoryUsage().heapUsed;
  
  try {
    // Create input tensor matching Whisper's expected format
    const inputTensor = new ort.Tensor('float32', sampleAudio, [1, sampleAudio.length]);
    
    const inferenceStart = performance.now();
    
    // Run inference
    const results = await session.run({
      'audio': inputTensor
    });
    
    const inferenceEnd = performance.now();
    const endTime = performance.now();
    const finalMemory = process.memoryUsage().heapUsed;
    
    const inferenceTime = inferenceEnd - inferenceStart;
    const audioLength = sampleAudio.length / 16000; // Assuming 16kHz
    const realTimeFactor = inferenceTime / (audioLength * 1000);
    
    return {
      inferenceTime,
      realTimeFactor,
      memoryUsage: finalMemory - initialMemory,
      modelLoadTime: endTime - startTime
    };
  } catch (error) {
    console.error('Benchmark failed:', error);
    throw error;
  }
}

/**
 * Monitor system health during transcription
 */
export class HealthMonitor {
  private cpuUsage: number[] = [];
  private memoryUsage: number[] = [];
  private intervalId?: NodeJS.Timeout;
  
  start() {
    this.intervalId = setInterval(() => {
      const usage = process.cpuUsage();
      const memory = process.memoryUsage();
      
      this.cpuUsage.push(usage.user + usage.system);
      this.memoryUsage.push(memory.heapUsed);
      
      // Keep only last 60 measurements (1 minute at 1s intervals)
      if (this.cpuUsage.length > 60) {
        this.cpuUsage = this.cpuUsage.slice(-60);
        this.memoryUsage = this.memoryUsage.slice(-60);
      }
    }, 1000);
  }
  
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }
  
  getAverageMetrics() {
    if (this.cpuUsage.length === 0) {
      return { cpu: 0, memory: 0 };
    }
    
    const avgCpu = this.cpuUsage.reduce((a, b) => a + b, 0) / this.cpuUsage.length;
    const avgMemory = this.memoryUsage.reduce((a, b) => a + b, 0) / this.memoryUsage.length;
    
    return {
      cpu: avgCpu / 1000000, // Convert to milliseconds
      memory: avgMemory / (1024 * 1024) // Convert to MB
    };
  }
}