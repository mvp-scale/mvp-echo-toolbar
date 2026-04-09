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
    verbose: false,
    progress: (p: { loaded: number; total: number; file: string }) => {
      const pct = p.total > 0 ? Math.round((p.loaded / p.total) * 100) : 0;
      const mb = (p.loaded / 1024 / 1024).toFixed(1);
      const totalMb = (p.total / 1024 / 1024).toFixed(1);
      console.log(`[ParakeetWorker] Downloading ${p.file}: ${mb}/${totalMb} MB (${pct}%)`);
      self.postMessage({ type: 'download-progress', file: p.file, loaded: p.loaded, total: p.total, pct });
    },
  });

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
  console.log('[ParakeetWorker] Disposed');
}
