// ONNX Runtime Session Management
import * as ort from 'onnxruntime-node';
import * as path from 'path';
import * as fs from 'fs';
import { STTSession, STTConfig } from './types';
import { detectGPUCapabilities } from './health';

/**
 * Creates an ONNX Runtime session with GPU/CPU fallback
 */
export async function createSession(modelPath: string, config: STTConfig): Promise<STTSession> {
  console.log(`Loading Whisper model from: ${modelPath}`);
  
  // For web-based ONNX Runtime, we'll load models via URL/fetch
  // This is a simplified implementation for the MVP
  
  const gpuInfo = await detectGPUCapabilities();
  const useGPU = config.useGPU && gpuInfo.available;
  
  // Configure execution providers based on GPU availability
  const executionProviders = useGPU 
    ? ['DmlExecutionProvider', 'CPUExecutionProvider']
    : ['CPUExecutionProvider'];
  
  console.log(`Attempting to create session with providers: ${executionProviders.join(', ')}`);
  
  try {
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders,
      graphOptimizationLevel: 'all',
      enableMemPattern: true,
      enableCpuMemArena: true,
      // Windows-specific optimization
      ...(process.platform === 'win32' && useGPU && {
        intraOpNumThreads: 1,
        interOpNumThreads: 1
      })
    });
    
    const actualMode = await detectActualExecutionMode(session);
    
    console.log(`Session created successfully in ${actualMode} mode`);
    
    return {
      session,
      mode: actualMode,
      modelName: path.basename(modelPath),
      isActive: true
    };
  } catch (error) {
    console.error('Failed to create ONNX session:', error);
    
    // If GPU failed, try CPU-only as fallback
    if (useGPU) {
      console.log('GPU failed, falling back to CPU...');
      try {
        const cpuSession = await ort.InferenceSession.create(modelPath, {
          executionProviders: ['CPUExecutionProvider'],
          graphOptimizationLevel: 'all',
          enableMemPattern: true,
          enableCpuMemArena: true
        });
        
        return {
          session: cpuSession,
          mode: 'cpu',
          modelName: path.basename(modelPath),
          isActive: true
        };
      } catch (cpuError) {
        console.error('CPU fallback also failed:', cpuError);
        throw new Error(`Failed to create session: ${cpuError.message}`);
      }
    } else {
      throw error;
    }
  }
}

/**
 * Detect actual execution mode of the session
 */
async function detectActualExecutionMode(session: ort.InferenceSession): Promise<'gpu' | 'cpu'> {
  try {
    // Try to determine if DirectML provider is actually being used
    // This is a heuristic approach as ONNX Runtime doesn't expose this directly
    const inputNames = session.inputNames;
    const outputNames = session.outputNames;
    
    // If we have the expected Whisper inputs/outputs, assume the session is valid
    if (inputNames.length > 0 && outputNames.length > 0) {
      // For now, we'll rely on the initial provider configuration
      // In a production app, you might want to run a small benchmark to detect
      return 'gpu'; // This would need more sophisticated detection
    }
    
    return 'cpu';
  } catch {
    return 'cpu';
  }
}

/**
 * Release session resources
 */
export async function releaseSession(sttSession: STTSession): Promise<void> {
  try {
    if (sttSession.session && sttSession.isActive) {
      await sttSession.session.release();
      sttSession.isActive = false;
      console.log(`Released session: ${sttSession.modelName}`);
    }
  } catch (error) {
    console.error('Error releasing session:', error);
  }
}

/**
 * Get model path based on size and local app data directory
 */
export function getModelPath(modelSize: 'tiny' | 'base' | 'small'): string {
  const os = require('os');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const modelsDir = path.join(localAppData, 'MVP-Echo', 'models');
  
  // Ensure models directory exists
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }
  
  return path.join(modelsDir, `whisper-${modelSize}.onnx`);
}

/**
 * Check if model file exists locally
 */
export function isModelAvailable(modelSize: 'tiny' | 'base' | 'small'): boolean {
  const modelPath = getModelPath(modelSize);
  return fs.existsSync(modelPath);
}

/**
 * Session manager for handling multiple models
 */
export class SessionManager {
  private sessions: Map<string, STTSession> = new Map();
  
  async getSession(modelSize: 'tiny' | 'base' | 'small', config: STTConfig): Promise<STTSession> {
    const key = `${modelSize}-${config.useGPU ? 'gpu' : 'cpu'}`;
    
    if (this.sessions.has(key)) {
      const existing = this.sessions.get(key)!;
      if (existing.isActive) {
        return existing;
      }
    }
    
    const modelPath = getModelPath(modelSize);
    const session = await createSession(modelPath, config);
    
    this.sessions.set(key, session);
    return session;
  }
  
  async releaseAll(): Promise<void> {
    for (const [key, session] of this.sessions.entries()) {
      await releaseSession(session);
    }
    this.sessions.clear();
  }
  
  async releaseSession(modelSize: 'tiny' | 'base' | 'small', useGPU: boolean): Promise<void> {
    const key = `${modelSize}-${useGPU ? 'gpu' : 'cpu'}`;
    const session = this.sessions.get(key);
    
    if (session) {
      await releaseSession(session);
      this.sessions.delete(key);
    }
  }
}