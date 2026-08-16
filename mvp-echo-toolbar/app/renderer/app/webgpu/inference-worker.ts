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
import { chunkPlanFor, dedupeOverlappingWords, joinWords } from './chunk-plan';
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
        await init(msg.backend || 'wasm', msg.encoderQuant || 'fp32');
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

async function init(
  backend: 'webgpu-hybrid' | 'wasm',
  encoderQuant: 'fp32' | 'fp16' = 'fp32',
): Promise<void> {
  console.log(`[ParakeetWorker] Loading parakeet-tdt-0.6b-v2 (${backend}, encoder=${encoderQuant})...`);

  // Self-check for the COOP/COEP fix. If this logs false in a packaged build,
  // SharedArrayBuffer is unavailable and the WASM decoder is pinned to a single
  // thread on EVERY transcription — the failure is otherwise completely silent,
  // so it is worth one log line.
  const isolated = (self as any).crossOriginIsolated === true;
  console.log(
    `[ParakeetWorker] crossOriginIsolated=${isolated} ` +
    `sharedArrayBuffer=${typeof SharedArrayBuffer !== 'undefined'}` +
    (isolated ? '' : ' — WASM decode will be single-threaded'),
  );

  // The progress callback fires once per network read chunk (~tens of thousands
  // of times for the ~1.2GB model). Throttle to whole-percent transitions so it
  // doesn't flood the console/log with thousands of lines per download.
  let lastPct = -1;
  let lastFile = '';
  model = await fromHub('parakeet-tdt-0.6b-v2', {
    backend,
    /**
     * Ask for the encoder this machine can actually run.
     *
     * This was previously left unset, which was silently expensive: the library
     * default is 'int8', WebGPU cannot execute int8, so hub.js:426 forced it all
     * the way to fp32 — logging "Forcing encoder to fp32 on WebGPU (int8
     * unsupported)" and stepping straight past the fp16 build that would have
     * worked. Every WebGPU machine downloaded 2,362 MB (a 39.8 MB graph plus a
     * 2,322 MB weights sidecar) when 1,182 MB in a single self-contained file
     * would have done.
     *
     * The caller decides from `adapter.features.has('shader-f16')` on THIS
     * machine, so a GPU without it still gets fp32 and still works.
     */
    encoderQuant,
    // Pin the decoder (which always runs on WASM in webgpu mode) to int8 — its
    // low-memory quant. This matches the current library default; making it
    // explicit guards against a future default change silently bloating load.
    decoderQuant: 'int8',
    verbose: false,
    progress: (p: { loaded: number; total: number; file: string }) => {
      const pct = p.total > 0 ? Math.round((p.loaded / p.total) * 100) : 0;
      if (pct === lastPct && p.file === lastFile) return; // throttle: whole-% only
      lastPct = pct;
      lastFile = p.file;
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

  // Drop any per-utterance scratch cache before each one-shot transcription —
  // cheap insurance against warm-worker state contamination producing an empty
  // result on otherwise-good audio (the intermittent blank-transcription bug).
  try {
    (model as any).resetMelCache?.();
    (model as any).clearIncrementalCache?.();
  } catch { /* ok */ }

  // Time it ourselves — enableProfiling is off (to avoid parakeet's per-call
  // RTF/console.table spam), which also drops its internal metrics. A plain
  // timer restores the processing-time the UI shows, with no logging flood.
  const t0 = performance.now();

  // Long audio MUST be chunked. A single one-shot transcribe() collapses to an
  // empty result somewhere above ~60-90s (see RELEASE-INSTABILITY-GAP-ANALYSIS.md),
  // so every long dictation silently failed. transcribeLongAudio() splits into
  // windows and merges them using the library's own pause-snapped word-timestamp
  // logic, which is better tested than anything we'd hand-roll here.
  //
  // Note the library only auto-chunks above 180s, which is well past where the
  // failure starts — so the window length is passed explicitly.
  const plan = chunkPlanFor(audio.length, sampleRate);
  let result: any;
  let text: string;
  if (plan.chunked) {
    // returnTimestamps gives us the word list, which we need because the
    // library's merge duplicates its 10s window overlap verbatim at every seam
    // (its dedup only compares adjacent words, so it cannot collapse a repeated
    // multi-word span). We rebuild the text from de-duplicated words.
    result = await model.transcribeLongAudio(audio, sampleRate, {
      chunkLengthS: plan.chunkLengthS,
      returnTimestamps: true,
      returnConfidences: true,
      enableProfiling: false,
    });
    const rawWords = Array.isArray(result.words) ? result.words : [];
    const deduped = dedupeOverlappingWords(rawWords);
    if (deduped.length !== rawWords.length) {
      console.log(
        `[ParakeetWorker] seam dedup: removed ${rawWords.length - deduped.length} duplicated word(s)`,
      );
    }
    // Fall back to the library's own text if timestamps came back empty, so a
    // missing word list degrades to the old behaviour rather than to silence.
    text = deduped.length > 0 ? joinWords(deduped) : (result.text || '');
  } else {
    // Short audio stays on the single-shot path: no windowing overhead, and
    // this is the overwhelmingly common case for a push-to-talk toolbar.
    result = await model.transcribe(audio, sampleRate, {
      returnTimestamps: false,  // unused downstream — saves decoder bookkeeping
      returnConfidences: true,
      enableProfiling: false,   // stop the per-transcription RTF/console.table spam
    });
    text = result.utterance_text || '';
  }
  const elapsedMs = Math.round(performance.now() - t0);
  const metrics = (result as any).metrics || {};
  const scores = (result as any).confidence_scores;
  // Correct parakeet.js confidence keys (was reading non-existent keys → always undefined).
  const confidence = scores?.word_avg ?? scores?.token_avg ?? undefined;

  self.postMessage({
    type: 'transcription-result',
    text,
    processingTime: metrics.total_ms ?? elapsedMs, // fall back to our own timer
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
