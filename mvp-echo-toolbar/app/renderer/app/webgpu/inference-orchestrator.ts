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
  /** Consecutive init failures tolerated before refusing further attempts. */
  static readonly MAX_CONSECUTIVE_FAILURES = 3;

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

  /**
   * How long init may go with NO progress before it is declared hung.
   *
   * Deliberately a STALL window, not a total budget — see sendMessage().
   * Injectable so the rule can be tested without waiting three minutes.
   */
  private readonly initStallMs: number;

  /**
   * Consecutive failed inits. Reset by a success.
   *
   * The bound lives HERE, not only in the caller. Observed on Windows: 61
   * attempts in 50 seconds, because a failed init reports readiness=false, main
   * folds that into the record, the rev bump broadcasts, and the renderer's
   * state handler re-inits on `engine === 'webgpu' && !isReady()`. The failure
   * fed the retry that produced it. CaptureApp's 3-strike guard existed but only
   * covered the hotkey path, so the loop ran around it — which is the argument
   * for the resource refusing re-entry rather than every caller remembering to.
   */
  private consecutiveFailures = 0;

  constructor(createWorker?: WorkerFactory, { initStallMs = 180000 }: { initStallMs?: number } = {}) {
    this.createWorker =
      createWorker ??
      (() => new Worker(new URL('./inference-worker.ts', import.meta.url), { type: 'module' }));
    this.initStallMs = initStallMs;
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
    appVersion?: string,
    /** Which encoder this machine can run. Decided by the caller's capability probe. */
    encoderQuant: 'fp32' | 'fp16' = 'fp32',
    /** Local model:// URLs. When present the worker skips the hub entirely. */
    urls?: Record<string, unknown>
  ): Promise<void> {
    if (this.loading) throw new AlreadyLoadingError();
    if (this.modelReady) return;
    if (this.consecutiveFailures >= InferenceOrchestrator.MAX_CONSECUTIVE_FAILURES) {
      throw new Error(
        `Inference worker failed ${this.consecutiveFailures} times in a row — giving up until the app restarts or the selection changes`,
      );
    }

    this.loading = true;
    const myEpoch = this.teardownEpoch;

    try {
      // Always prep the cache: requests persistent storage (so the ~1.2GB blob
      // survives eviction) and migrates/validates the model-cache key. Runs even
      // when appVersion is unknown — persistence must be requested regardless.
      // Keyed on the encoder variant, so switching to fp16 evicts the fp32 blobs
      // it replaces instead of leaving 2.3GB of dead weight behind.
      await prepareModelCache(encoderQuant);

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

        // A worker whose module script never LOADS — blocked by COEP, missing,
        // or failing to parse — can never send a message. Without this listener
        // the init request stayed pending for the full timeout while `loading`
        // remained true, and CaptureApp's recovery is gated on !isLoading(), so
        // the app sat with a dead hotkey and nothing in the log. That is exactly
        // what Electron 43 produced. Same supersession guard as above.
        created.addEventListener('error', (event: ErrorEvent) => {
          if (this.worker !== created) return;
          // A blocked cross-origin load is precisely the case where the browser
          // withholds detail, so `message` is routinely empty. Say something
          // useful rather than surfacing an empty string.
          const detail = event.message || 'script failed to load (blocked, missing, or failed to parse)';
          const where = event.filename ? ` [${event.filename}:${event.lineno}]` : '';
          console.error(`[InferenceOrchestrator] worker error: ${detail}${where}`);
          this.disposeSync(new Error(`Inference worker error: ${detail}`));
        });

        // The other way a worker can go quiet without an 'error': an incoming
        // message that fails structured clone.
        created.addEventListener('messageerror', () => {
          if (this.worker !== created) return;
          console.error('[InferenceOrchestrator] worker sent an undeserializable message');
          this.disposeSync(new Error('Inference worker sent an undeserializable message'));
        });
      }

      await this.sendMessage(
        { type: 'init', backend, encoderQuant, urls },
        'ready',
        // 3 min WITHOUT PROGRESS. The old 900_000ms was not a timeout, it was a
        // hang: 15 minutes of `loading === true` with recovery disabled behind
        // !isLoading(). But replacing it with a 3-minute TOTAL budget made a
        // first-run download impossible — see sendMessage().
        this.initStallMs
      );

      this.modelReady = true;
      this.consecutiveFailures = 0;
      console.log(`[InferenceOrchestrator] Model loaded and ready${appVersion ? ` (app v${appVersion})` : ''}`);
    } catch (err) {
      // Tear the worker down on failure. A half-initialized worker still holds
      // a partial ~2.5GB model in memory; reusing it on the next attempt
      // compounds RAM and never recovers. disposeSync() terminates + nulls it
      // so the next initialize() starts from a clean worker. No auto-retry —
      // the user/CaptureApp re-triggers init, avoiding a retry storm on an
      // already memory-pressured machine.
      this.consecutiveFailures += 1;
      console.error(`[InferenceOrchestrator] Init failed (${this.consecutiveFailures}) — disposing worker for clean retry:`, err);
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

    // Transfer the PCM rather than letting structured clone copy it. At the
    // 600s cap that is 38.4MB copied per transcription for no reason. Transfer
    // detaches `pcm` in this thread — safe because CaptureApp passes a trimmed
    // copy and retains the original separately for the diagnostics WAV.
    const result = await this.sendMessage(
      { type: 'transcribe', audio: pcm, sampleRate },
      'transcription-result',
      120000,
      [pcm.buffer],
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
    timeoutMs: number,
    transfer?: Transferable[]
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const worker = this.worker;
      if (!worker) { reject(new Error('Worker not available')); return; }

      /**
       * The timeout measures SILENCE, not elapsed time, and every progress
       * message rearms it.
       *
       * As a total budget this made the first-run model download impossible.
       * The encoder falls back to fp32 when `shader-f16` is unavailable, so the
       * payload is 2,322 MB; finishing inside 180s demands 12.9 MB/s. Observed
       * on a real first run at ~7 MB/s: the download reached 53% at the
       * deadline, the worker was disposed, CaptureApp re-initialised, and the
       * download restarted from 0% — forever, never once completing, while the
       * log showed steady healthy progress the whole time.
       *
       * "Nothing has happened for three minutes" is the condition actually
       * worth acting on. A genuine hang still trips it, because a hung worker
       * sends no progress either.
       */
      let timeout: ReturnType<typeof setTimeout>;
      const arm = () => {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Worker sent nothing for ${timeoutMs}ms`));
        }, timeoutMs);
      };
      arm();

      const handler = (event: MessageEvent) => {
        const data = event.data;
        if (data.type === responseType) { cleanup(); resolve(data); }
        else if (data.type === 'error') { cleanup(); reject(new Error(data.message)); }
        else if (data.type === 'download-progress') {
          arm();
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
      worker.postMessage(message, transfer ?? []);
    });
  }
}
