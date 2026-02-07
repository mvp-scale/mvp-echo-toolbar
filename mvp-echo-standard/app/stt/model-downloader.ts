// Model Download and Management
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { createHash } from 'crypto';

/**
 * Real Whisper ONNX model URLs from Hugging Face Hub
 * These are actual working models optimized for ONNX Runtime
 */
const MODEL_URLS = {
  'tiny': 'https://huggingface.co/openai/whisper-tiny/resolve/main/onnx/model.onnx',
  'base': 'https://huggingface.co/openai/whisper-base/resolve/main/onnx/model.onnx',
  'small': 'https://huggingface.co/openai/whisper-small/resolve/main/onnx/model.onnx'
};

/**
 * Expected file sizes (approximate) for progress tracking
 */
const MODEL_SIZES = {
  'tiny': 41 * 1024 * 1024,   // ~41MB
  'base': 148 * 1024 * 1024,  // ~148MB  
  'small': 250 * 1024 * 1024  // ~250MB
};

export interface DownloadProgress {
  bytesDownloaded: number;
  totalBytes: number;
  percentage: number;
  modelSize: string;
}

export interface ModelInfo {
  name: string;
  size: 'tiny' | 'base' | 'small';
  path: string;
  exists: boolean;
  fileSize?: number;
}

/**
 * Get the local models directory path
 */
export function getModelsDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
  const modelsDir = path.join(localAppData, 'MVP-Echo', 'models');
  
  // Ensure directory exists
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }
  
  return modelsDir;
}

/**
 * Get the full path for a model file
 */
export function getModelPath(modelSize: 'tiny' | 'base' | 'small'): string {
  const modelsDir = getModelsDirectory();
  return path.join(modelsDir, `whisper-${modelSize}.onnx`);
}

/**
 * Check if a model exists locally
 */
export function isModelAvailable(modelSize: 'tiny' | 'base' | 'small'): boolean {
  const modelPath = getModelPath(modelSize);
  return fs.existsSync(modelPath);
}

/**
 * Get information about all available models
 */
export function getAvailableModels(): ModelInfo[] {
  const sizes: ('tiny' | 'base' | 'small')[] = ['tiny', 'base', 'small'];
  
  return sizes.map(size => {
    const modelPath = getModelPath(size);
    const exists = fs.existsSync(modelPath);
    let fileSize: number | undefined;
    
    if (exists) {
      try {
        const stats = fs.statSync(modelPath);
        fileSize = stats.size;
      } catch (error) {
        console.warn(`Could not get size for ${modelPath}:`, error);
      }
    }
    
    return {
      name: `whisper-${size}`,
      size,
      path: modelPath,
      exists,
      fileSize
    };
  });
}

/**
 * Download a model with progress tracking
 */
export async function downloadModel(
  modelSize: 'tiny' | 'base' | 'small',
  onProgress?: (progress: DownloadProgress) => void
): Promise<string> {
  const url = MODEL_URLS[modelSize];
  const modelPath = getModelPath(modelSize);
  
  if (!url) {
    throw new Error(`No URL available for model size: ${modelSize}`);
  }
  
  console.log(`Downloading ${modelSize} model from: ${url}`);
  console.log(`Saving to: ${modelPath}`);
  
  // Check if file already exists
  if (fs.existsSync(modelPath)) {
    console.log(`Model ${modelSize} already exists at: ${modelPath}`);
    return modelPath;
  }
  
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        return;
      }
      
      const totalBytes = parseInt(response.headers['content-length'] || '0') || MODEL_SIZES[modelSize];
      let downloadedBytes = 0;
      
      const fileStream = fs.createWriteStream(modelPath);
      
      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        
        if (onProgress) {
          onProgress({
            bytesDownloaded: downloadedBytes,
            totalBytes,
            percentage: Math.round((downloadedBytes / totalBytes) * 100),
            modelSize
          });
        }
      });
      
      response.pipe(fileStream);
      
      fileStream.on('finish', () => {
        fileStream.close();
        console.log(`✅ Model ${modelSize} downloaded successfully to: ${modelPath}`);
        
        // Verify the file exists and has content
        if (fs.existsSync(modelPath) && fs.statSync(modelPath).size > 0) {
          resolve(modelPath);
        } else {
          reject(new Error('Downloaded file is empty or missing'));
        }
      });
      
      fileStream.on('error', (error) => {
        fs.unlink(modelPath, () => {}); // Clean up partial file
        reject(error);
      });
    });
    
    request.on('error', (error) => {
      reject(error);
    });
    
    request.setTimeout(60000, () => {
      request.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

/**
 * Verify model file integrity (basic size check)
 */
export function verifyModel(modelSize: 'tiny' | 'base' | 'small'): boolean {
  const modelPath = getModelPath(modelSize);
  
  if (!fs.existsSync(modelPath)) {
    return false;
  }
  
  try {
    const stats = fs.statSync(modelPath);
    const minSize = MODEL_SIZES[modelSize] * 0.8; // Allow 20% variance
    
    if (stats.size < minSize) {
      console.warn(`Model ${modelSize} file size ${stats.size} is smaller than expected ${minSize}`);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error(`Error verifying model ${modelSize}:`, error);
    return false;
  }
}

/**
 * Delete a model file
 */
export function deleteModel(modelSize: 'tiny' | 'base' | 'small'): boolean {
  const modelPath = getModelPath(modelSize);
  
  try {
    if (fs.existsSync(modelPath)) {
      fs.unlinkSync(modelPath);
      console.log(`Deleted model: ${modelPath}`);
      return true;
    }
    return true; // Already doesn't exist
  } catch (error) {
    console.error(`Error deleting model ${modelSize}:`, error);
    return false;
  }
}

/**
 * Get total disk space used by models
 */
export function getModelsSize(): number {
  const models = getAvailableModels();
  return models.reduce((total, model) => {
    return total + (model.fileSize || 0);
  }, 0);
}

/**
 * Ensure at least one model is available for immediate use
 */
export async function ensureModelAvailable(
  preferredSize: 'tiny' | 'base' | 'small' = 'tiny',
  onProgress?: (progress: DownloadProgress) => void
): Promise<string> {
  // Check if preferred model is available
  if (isModelAvailable(preferredSize)) {
    return getModelPath(preferredSize);
  }
  
  // Check if any model is available
  const availableModels = getAvailableModels().filter(m => m.exists);
  if (availableModels.length > 0) {
    console.log(`Using existing model: ${availableModels[0].name}`);
    return availableModels[0].path;
  }
  
  // Download the preferred model
  console.log(`No models available. Downloading ${preferredSize} model...`);
  return await downloadModel(preferredSize, onProgress);
}