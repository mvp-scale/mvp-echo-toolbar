/**
 * Inference Worker — Runs parakeet.js in a Web Worker for non-blocking
 * speech-to-text inference via WebGPU or WASM.
 *
 * Messages IN:
 *   { type: 'init', backend?: 'webgpu-hybrid' | 'wasm' }
 *   { type: 'transcribe', audio: Float32Array, sampleRate: number }
 *   { type: 'dispose' }
 *
 * Messages OUT:
 *   { type: 'ready' }
 *   { type: 'transcription-result', text, processingTime, confidence, metrics }
 *   { type: 'error', message }
 */

import { fromHub } from 'parakeet.js';
import type { ParakeetModel } from 'parakeet.js';

let model: ParakeetModel | null = null;
// Held reference to the device we watch for loss — keeps it from being GC'd
// (a GC'd device resolves `.lost` with reason 'destroyed', which we ignore).
let lossWatchDevice: any = null;

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case 'init':
        await init(msg.backend || 'wasm');
        break;
      case 'transcribe':
        await transcribe(msg.audio, msg.sampleRate);
        break;
      case 'dispose':
        dispose();
        break;
    }
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

async function init(backend: 'webgpu-hybrid' | 'wasm'): Promise<void> {
  console.log(`[ParakeetWorker] Loading parakeet-tdt-0.6b-v2 (${backend})...`);

  model = await fromHub('parakeet-tdt-0.6b-v2', {
    backend,
    // Pin the decoder (which always runs on WASM in webgpu mode) to int8 — its
    // low-memory quant. This matches the current library default; making it
    // explicit guards against a future default change silently bloating load.
    // Note: the encoder is force-loaded as fp32 on any webgpu backend by
    // parakeet.js itself, so no encoderQuant is set (it would be ignored).
    decoderQuant: 'int8',
    verbose: false,
    progress: (p: { loaded: number; total: number; file: string }) => {
      const pct = p.total > 0 ? Math.round((p.loaded / p.total) * 100) : 0;
      const mb = (p.loaded / 1024 / 1024).toFixed(1);
      const totalMb = (p.total / 1024 / 1024).toFixed(1);
      console.log(`[ParakeetWorker] Downloading ${p.file}: ${mb}/${totalMb} MB (${pct}%)`);
      self.postMessage({ type: 'download-progress', file: p.file, loaded: p.loaded, total: p.total, pct });
    },
  });

  // Watch for WebGPU device loss. On hybrid-GPU laptops the device can be lost
  // on a driver/TDR reset; without this it surfaces as an opaque hung session.
  // onnxruntime-web (which owns the inference device) is nested under
  // parakeet.js and not importable here, so we watch a device acquired from
  // navigator.gpu — a true hardware/driver reset invalidates the whole adapter,
  // so this device's loss is a reliable proxy. Best-effort, gated to webgpu.
  if (backend.startsWith('webgpu') && (navigator as any).gpu) {
    try {
      const adapter = await (navigator as any).gpu.requestAdapter();
      lossWatchDevice = adapter ? await adapter.requestDevice() : null;
      lossWatchDevice?.lost?.then((info: any) => {
        // 'destroyed' = intentional/GC teardown — ignore. Only react to an
        // unexpected loss (the driver/TDR reset case).
        if (info?.reason === 'destroyed') return;
        console.error(`[ParakeetWorker] WebGPU device lost: reason=${info?.reason} ${info?.message || ''}`);
        model = null;
        self.postMessage({ type: 'device-lost', reason: info?.reason, message: info?.message });
      });
    } catch {
      /* couldn't acquire a watch device — skip, recovery still happens reactively */
    }
  }

  // Warmup: first WebGPU inference compiles shaders (1-5s)
  console.log('[ParakeetWorker] Running warmup...');
  const warmup = new Float32Array(16000); // 1s silence
  await model.transcribe(warmup, 16000);
  console.log('[ParakeetWorker] Ready');

  self.postMessage({ type: 'ready' });
}

async function transcribe(audio: Float32Array, sampleRate: number): Promise<void> {
  if (!model) {
    self.postMessage({ type: 'error', message: 'Model not loaded' });
    return;
  }

  const result = await model.transcribe(audio, sampleRate, {
    returnTimestamps: true,
    returnConfidences: true,
  });

  const text = result.utterance_text || '';
  const metrics = (result as any).metrics || {};
  const scores = (result as any).confidence_scores;
  const confidence = scores?.word_confidence_avg ?? scores?.utterance ?? undefined;

  self.postMessage({
    type: 'transcription-result',
    text,
    processingTime: metrics.total_ms ?? 0,
    confidence,
    metrics,
  });
}

function dispose(): void {
  if (model) {
    if ((model as any).resetMelCache) (model as any).resetMelCache();
    if ((model as any).clearIncrementalCache) (model as any).clearIncrementalCache();
    model = null;
  }
  if (lossWatchDevice) {
    try { lossWatchDevice.destroy(); } catch { /* ok */ }
    lossWatchDevice = null;
  }
  console.log('[ParakeetWorker] Disposed');
}
