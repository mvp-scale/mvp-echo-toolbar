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

/**
 * Thrown when initialize() is called while another init is already in flight.
 *
 * This is a real, reachable race (the mount-time auto-init vs. the
 * `webgpu:init-orchestrator` IPC), NOT an init failure — callers must be able
 * to tell it apart so it isn't counted toward the re-init strike limit.
 */
export class AlreadyLoadingError extends Error {
  constructor() {
    super('Already loading');
    this.name = 'AlreadyLoadingError';
  }
}

/** Creates the inference worker. Injectable so tests can supply a fake. */
export type WorkerFactory = () => Worker;

export class InferenceOrchestrator {
  private worker: Worker | null = null;
  private modelReady = false;
  private loading = false;
  private readonly createWorker: WorkerFactory;

  /**
   * The single in-flight worker request, if any. Held so teardown can settle
   * it: terminate() makes a reply impossible, so an unsettled promise would
   * otherwise hang until its timeout (15 minutes for init).
   */
  private pending: { reject: (err: Error) => void } | null = null;

  /**
   * Bumped by every teardown. initialize() captures it and re-checks after each
   * await, so a dispose()/abort() arriving during the pre-worker phase (while
   * prepareModelCache() is running, when there is no worker or pending request
   * to cancel) still stops the init instead of silently completing.
   */
  private teardownEpoch = 0;

  constructor(createWorker?: WorkerFactory) {
    this.createWorker =
      createWorker ??
      (() => new Worker(new URL('./inference-worker.ts', import.meta.url), { type: 'module' }));
  }

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
    if (this.loading) throw new AlreadyLoadingError();
    if (this.modelReady) return;

    this.loading = true;
    const myEpoch = this.teardownEpoch;

    try {
      // Always prep the cache: requests persistent storage (so the ~1.2GB blob
      // survives eviction) and migrates/validates the model-cache key. Runs even
      // when appVersion is unknown — persistence must be requested regardless.
      await prepareModelCache();

      // A dispose()/abort() landing during the cache prep above had nothing to
      // cancel (no worker, no pending request). Honour it here rather than
      // spawning a worker and loading ~2.5GB the caller already gave up on.
      if (this.teardownEpoch !== myEpoch) throw new Error('Initialization cancelled');

      // Only create a new worker if we don't already have one
      if (!this.worker) {
        const created = this.createWorker();
        this.worker = created;
        // Persistent listener for out-of-band worker events (i.e. not tied to a
        // pending sendMessage). A lost WebGPU device — common on hybrid-GPU
        // laptops during a driver/TDR reset — surfaces here so we tear the
        // worker down and re-init cleanly on next use instead of running blind.
        created.addEventListener('message', (event: MessageEvent) => {
          if (event.data?.type !== 'device-lost') return;
          // Only act if this worker is STILL the active one. Without this, a
          // late event from a superseded worker would terminate its
          // replacement and stomp the newer init's state.
          if (this.worker !== created) return;
          console.error('[InferenceOrchestrator] WebGPU device lost — tearing down for clean re-init');
          this.disposeSync(new Error('WebGPU device lost'));
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
      // a partial ~2.5GB model in memory; reusing it on the next attempt
      // compounds RAM and never recovers. disposeSync() terminates + nulls it
      // so the next initialize() starts from a clean worker. No auto-retry —
      // the user/CaptureApp re-triggers init, avoiding a retry storm on an
      // already memory-pressured machine.
      console.error('[InferenceOrchestrator] Init failed — disposing worker for clean retry:', err);
      this.disposeSync();
      // RETHROW. Swallowing this made the failure invisible to the caller,
      // whose 3-strike backoff counter was then reset on every attempt and
      // could never trip — leaving an unbounded 15s re-init loop that reloaded
      // the model forever. It also reported a false "model ready" to main.
      throw err;
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

  private disposeSync(reason?: Error): void {
    // Signals any in-flight initialize() that it has been superseded, even if
    // it is currently in a phase with nothing concrete to cancel.
    this.teardownEpoch++;

    // Settle the in-flight request BEFORE terminating. terminate() makes a
    // reply impossible, so an unsettled promise would sit until its own
    // timeout — 900_000ms for init, which is the 15-minute wedge: `loading`
    // stays true that whole time and the recovery path is gated on !isLoading().
    const pending = this.pending;
    if (pending) {
      this.pending = null;
      pending.reject(reason ?? new Error('Inference worker torn down'));
    }

    if (this.worker) {
      try { this.worker.postMessage({ type: 'dispose' }); } catch { /* ok */ }
      this.worker.terminate();
      this.worker = null;
    }
    this.modelReady = false;

    // `loading` is deliberately NOT cleared here — it is owned by
    // initialize()'s finally block, which runs when the rejection above
    // unwinds it. Clearing it here would let a dispose() landing mid-init
    // reopen the guard, so a second initialize() could race the first and
    // spawn a second worker (~2.5GB of model each).
  }

  private sendMessage(
    message: Record<string, unknown>,
    responseType: string,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker) { reject(new Error('Worker not available')); return; }

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
        // Remove from the worker this request was posted to, not from
        // `this.worker`, which teardown may already have nulled.
        worker.removeEventListener('message', handler);
        if (this.pending === entry) this.pending = null;
      };

      // Registered so disposeSync() can settle this request instead of
      // leaving it pending until `timeoutMs`.
      const entry = { reject: (err: Error) => { cleanup(); reject(err); } };
      this.pending = entry;

      worker.addEventListener('message', handler);
      worker.postMessage(message);
    });
  }
}
