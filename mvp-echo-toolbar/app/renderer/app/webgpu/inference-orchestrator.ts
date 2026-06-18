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
   * @param appVersion - Current app version, for logging only. The model cache is
   *                     NO LONGER keyed on it (that forced a needless re-download
   *                     on every update); it's keyed on the model identity and
   *                     cleared only when the model itself changes.
   */
  async initialize(
    backend: 'webgpu-hybrid' | 'wasm' = 'wasm',
    appVersion?: string
  ): Promise<void> {
    if (this.loading) throw new Error('Already loading');
    if (this.modelReady) return;

    this.loading = true;

    try {
      // Always prep the cache: requests persistent storage (so the ~1.2GB blob
      // survives eviction) and migrates/validates the model-cache key. Runs even
      // when appVersion is unknown — persistence must be requested regardless.
      await prepareModelCache();

      // Only create a new worker if we don't already have one
      if (!this.worker) {
        this.worker = new Worker(
          new URL('./inference-worker.ts', import.meta.url),
          { type: 'module' }
        );
        // Persistent listener for out-of-band worker events (i.e. not tied to a
        // pending sendMessage). A lost WebGPU device — common on hybrid-GPU
        // laptops during a driver/TDR reset — surfaces here so we tear the
        // worker down and re-init cleanly on next use instead of running blind.
        this.worker.addEventListener('message', (event: MessageEvent) => {
          if (event.data?.type === 'device-lost') {
            console.error('[InferenceOrchestrator] WebGPU device lost — tearing down for clean re-init');
            this.disposeSync();
          }
        });
      }

      await this.sendMessage(
        { type: 'init', backend },
        'ready',
        900000 // 15 min timeout — first download is ~1.2GB + warmup
      );

      this.modelReady = true;
      console.log(`[InferenceOrchestrator] Model loaded and ready${appVersion ? ` (app v${appVersion})` : ''}`);
    } catch (err) {
      // Tear the worker down on failure. A half-initialized worker still holds
      // a partial ~1.2GB model in memory; reusing it on the next attempt
      // compounds RAM and never recovers. disposeSync() terminates + nulls it
      // so the next initialize() starts from a clean worker. No auto-retry —
      // the user/CaptureApp re-triggers init, avoiding a retry storm on an
      // already memory-pressured machine.
      console.error('[InferenceOrchestrator] Init failed — disposing worker for clean retry:', err);
      this.disposeSync();
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

  /**
   * Hard-cancel any in-flight inference by terminating the worker.
   * parakeet.js's model.transcribe() has no cooperative cancel, so terminate is
   * the only true abort — and it prevents a timed-out job from corrupting the
   * next transcription via the shared, single-in-flight worker. The caller is
   * responsible for re-initializing (lazily, on next use) before transcribing
   * again; this stays warm-by-default and only pays the reload cost after an
   * abnormal timeout.
   */
  abort(): void {
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
