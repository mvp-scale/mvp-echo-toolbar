/**
 * InferenceOrchestrator — Manages the parakeet.js Web Worker lifecycle.
 *
 * Provides a clean async API for CaptureApp:
 *   1. initialize(backend, appVersion) — prep cache, spin up worker, load model, warmup
 *   2. transcribe(pcm, sampleRate) — run inference on raw PCM audio
 *   3. dispose() — tear down worker
 */

import { prepareModelCache } from './model-cache';

export interface TranscriptionResult {
  text: string;
  processingTime: number;
  confidence?: number;
  metrics?: Record<string, number>;
}

export class InferenceOrchestrator {
  private worker: Worker | null = null;
  private modelReady = false;
  private loading = false;

  isReady(): boolean {
    return this.modelReady && this.worker !== null;
  }

  isLoading(): boolean {
    return this.loading;
  }

  /**
   * Initialize the worker, load parakeet.js model, and run warmup.
   * @param backend - 'webgpu-hybrid' or 'wasm'
   * @param appVersion - Current app version. When this changes between runs,
   *                     the cached model files are wiped and re-downloaded.
   */
  async initialize(
    backend: 'webgpu-hybrid' | 'wasm' = 'wasm',
    appVersion?: string
  ): Promise<void> {
    if (this.loading) throw new Error('Already loading');
    if (this.modelReady) return;

    this.loading = true;

    try {
      if (appVersion) {
        await prepareModelCache(appVersion);
      }

      // Only create a new worker if we don't already have one
      if (!this.worker) {
        this.worker = new Worker(
          new URL('./inference-worker.ts', import.meta.url),
          { type: 'module' }
        );
      }

      await this.sendMessage(
        { type: 'init', backend },
        'ready',
        900000 // 15 min timeout — first download is ~1.2GB + warmup
      );

      this.modelReady = true;
      console.log('[InferenceOrchestrator] Model loaded and ready');
    } catch (err) {
      // Don't kill the worker on error — it may be mid-download
      // Just log and let the user retry
      console.error('[InferenceOrchestrator] Init failed:', err);
      this.modelReady = false;
    } finally {
      this.loading = false;
    }
  }

  /**
   * Transcribe raw PCM audio.
   * @param pcm - Float32Array of 16kHz mono audio samples
   * @param sampleRate - Sample rate (should be 16000)
   */
  async transcribe(pcm: Float32Array, sampleRate: number = 16000): Promise<TranscriptionResult> {
    if (!this.worker || !this.modelReady) {
      throw new Error('Model not loaded');
    }

    const result = await this.sendMessage(
      { type: 'transcribe', audio: pcm, sampleRate },
      'transcription-result',
      120000
    );

    return {
      text: result.text as string,
      processingTime: result.processingTime as number,
      confidence: result.confidence as number | undefined,
      metrics: result.metrics as Record<string, number> | undefined,
    };
  }

  dispose(): void {
    this.disposeSync();
  }

  private disposeSync(): void {
    if (this.worker) {
      try { this.worker.postMessage({ type: 'dispose' }); } catch { /* ok */ }
      this.worker.terminate();
      this.worker = null;
    }
    this.modelReady = false;
  }

  private sendMessage(
    message: Record<string, unknown>,
    responseType: string,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.worker) { reject(new Error('Worker not available')); return; }

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Worker timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (event: MessageEvent) => {
        const data = event.data;
        if (data.type === responseType) { cleanup(); resolve(data); }
        else if (data.type === 'error') { cleanup(); reject(new Error(data.message)); }
        else if (data.type === 'download-progress') {
          console.log(`[Download] ${data.file}: ${(data.loaded / 1024 / 1024).toFixed(1)}/${(data.total / 1024 / 1024).toFixed(1)} MB (${data.pct}%)`);
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.worker?.removeEventListener('message', handler);
      };

      this.worker.addEventListener('message', handler);
      this.worker.postMessage(message);
    });
  }
}
