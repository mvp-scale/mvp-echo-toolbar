# Parakeet ONNX + WebGPU — Implementation Guidance

> For any agent implementing Parakeet TDT models in browser or Node.js.
> Both models below are PROVEN WORKING in production. Do not reinvent — follow the patterns.

---

## The Two Models

| Model | Params | Use Case | Download (q8) | Runtime RAM |
|-------|--------|----------|---------------|-------------|
| **Parakeet TDT-CTC 110M** | 110M | Mobile + edge browser | ~169 MB | ~300 MB (WASM), ~370 MB (WebGPU) |
| **Parakeet TDT 0.6B v2** | 600M | Desktop browser + server | ~630 MB | ~300 MB (WASM int8), ~2.5 GB (WebGPU fp32+int8) |

Both use the same runtime: **parakeet.js** (npm package) wrapping ONNX Runtime Web.
Both produce: transcript + per-word timestamps + per-word confidence scores.

---

## 1. ONNX Export (GPU machine required)

Models come from NVIDIA NeMo. You export them to split ONNX (encoder + decoder) then quantize.

### Prerequisites

```bash
conda create -n asr-export python=3.10 -y
conda activate asr-export
pip install nemo_toolkit[asr] onnxruntime onnx huggingface_hub
pip install torch --index-url https://download.pytorch.org/whl/cu121
```

### Export

```bash
python export_all.py --models 110m        # Just the 110M
python export_all.py --models 0.6b-v2     # Just the 0.6B English
python export_all.py --models 110m 0.6b-v2  # Both
```

This produces fp32 ONNX in `output/parakeet-tdt-110m/` and `output/parakeet-tdt-0.6b-v2/`.
Each directory contains: `encoder-model.onnx`, `decoder_joint-model.onnx`, `vocab.txt`.

### Quantize (CPU — no GPU needed)

```bash
python gauntlet_quantize.py --models parakeet-110m parakeet-0.6b
```

Produces q8 and q4 variants. **Use q8 for production** — q4 is experimental.

### CRITICAL: Conv Node Handling

Parakeet's encoder has Conv layers. Standard int8 quantization converts these to ConvInteger ops, which **ONNX Runtime Web does NOT support**. The quantization scripts automatically detect Conv nodes and exclude them (keeps convs fp32, quantizes everything else). If you write your own quantization, you MUST do this:

```python
from onnxruntime.quantization import quantize_dynamic, QuantType
import onnx

model = onnx.load(src_path, load_external_data=False)
conv_nodes = [n.name for n in model.graph.node if n.op_type == "Conv"]

quantize_dynamic(
    model_input=src_path,
    model_output=dst_path,
    weight_type=QuantType.QInt8,
    nodes_to_exclude=conv_nodes,  # <-- THIS IS MANDATORY
)
```

### Output File Structure

```
parakeet-110m/
  encoder-model.q8.onnx
  decoder_joint-model.q8.onnx
  vocab.txt
  manifest.json

parakeet-0.6b/
  encoder-model.q8.onnx
  decoder_joint-model.q8.onnx
  vocab.txt
  manifest.json
```

---

## 2. Loading Models in the Browser

### Option A: From HuggingFace Hub (0.6B v3 only — community ONNX exists)

```typescript
import { fromHub } from 'parakeet.js';

const model = await fromHub('parakeet-tdt-0.6b-v3', {
  backend: 'webgpu-hybrid',
  encoderQuant: 'fp32',    // WebGPU cannot do int8 encoder — auto-promotes anyway
  decoderQuant: 'int8',    // Decoder runs WASM even in WebGPU mode
});
```

### Option B: From Your Own URLs (both models — self-hosted ONNX)

This is what production uses. Models are served from R2 CDN.

```typescript
import { fromUrls } from 'parakeet.js';

// 110M — edge/mobile
const model110m = await fromUrls({
  encoderUrl: 'https://your-cdn.com/parakeet-110m/encoder-model.q8.onnx',
  decoderUrl: 'https://your-cdn.com/parakeet-110m/decoder_joint-model.q8.onnx',
  tokenizerUrl: 'https://your-cdn.com/parakeet-110m/vocab.txt',
  filenames: { encoder: 'encoder-model.q8.onnx', decoder: 'decoder_joint-model.q8.onnx' },
  backend: 'webgpu-hybrid',   // or 'wasm'
  preprocessorBackend: 'js',
  subsampling: 8,
  nMels: 80,                   // 110M uses 80 mel bins (not 128)
});

// 0.6B — desktop
const model06b = await fromUrls({
  encoderUrl: 'https://your-cdn.com/parakeet-0.6b/encoder-model.q8.onnx',
  decoderUrl: 'https://your-cdn.com/parakeet-0.6b/decoder_joint-model.q8.onnx',
  tokenizerUrl: 'https://your-cdn.com/parakeet-0.6b/vocab.txt',
  filenames: { encoder: 'encoder-model.q8.onnx', decoder: 'decoder_joint-model.q8.onnx' },
  backend: 'webgpu-hybrid',
  preprocessorBackend: 'js',
  subsampling: 8,
  // 0.6B uses nMels: 128 (the default) — do NOT set nMels
});
```

---

## 3. Model-Specific Quirks

### 110M — Three patches required after loading

The 110M has different dimensions than what parakeet.js hardcodes. After `fromUrls()`:

1. **nMels = 80** (not 128). Pass `nMels: 80` in the config.
2. **predLayers = 1** (not 2). The LSTM prediction network has 1 layer, not 2. You must patch the internal state tensors after loading:

```typescript
// After model = await fromUrls({...})
const pm = model as any;
const layers = 1;  // 110M has 1 pred layer
const hidden = pm.predHidden || 640;
const z = new Float32Array(layers * 1 * hidden);
const TensorCls = pm._combState1.constructor;
pm._combState1 = new TensorCls('float32', z, [layers, 1, hidden]);
pm._combState2 = new TensorCls('float32', z.slice(), [layers, 1, hidden]);
pm.predLayers = layers;
```

3. **Conv exclusion from quantization** — handled at export time (see Section 1). If your q8 ONNX was built without Conv exclusion, it will fail at runtime with "ConvInteger not supported."

### 0.6B — Mostly works out of the box

- Uses `nMels: 128` (the default in parakeet.js).
- Uses `predLayers: 2` (the default).
- No special patches needed.
- v2 is English-only, more accurate (6.05% WER). v3 is multilingual, slightly worse (6.32% WER).

---

## 4. WebGPU vs WASM — Decision Matrix

### How parakeet.js backends actually work

| Backend | Encoder | Decoder | Notes |
|---------|---------|---------|-------|
| `'wasm'` | WASM (int8 or fp32) | WASM (int8 or fp32) | Works everywhere. Needs COOP/COEP headers for multi-threading. |
| `'webgpu-hybrid'` | **WebGPU (fp32 only)** | **WASM (int8)** | Fastest on desktop. Encoder on GPU, decoder on CPU. |
| `'webgpu'` / `'webgpu-strict'` | WebGPU | WebGPU | Both on GPU. Less tested. |

**Key rule:** If you request `encoderQuant: 'int8'` with a `webgpu*` backend, parakeet.js auto-promotes to fp32. WebGPU does NOT support int8 execution. This means the WebGPU path always downloads the fp32 encoder (~2x larger than int8).

### When to use which

| Scenario | Backend | Encoder Quant | Decoder Quant | Why |
|----------|---------|---------------|---------------|-----|
| **Mobile (110M)** | `wasm` | `int8` | `int8` | No WebGPU on most mobile. Smallest download. |
| **Mobile (110M) with WebGPU** | `webgpu-hybrid` | `fp32` | `int8` | Faster if device has GPU. Larger download. |
| **Desktop (0.6B)** | `webgpu-hybrid` | `fp32` | `int8` | Best performance. ~2.5GB RAM. |
| **Desktop fallback** | `wasm` | `int8` | `int8` | If no WebGPU. ~300MB RAM. |

### WebGPU Detection

```typescript
async function detectBackend(): Promise<'webgpu-hybrid' | 'wasm'> {
  const nav = navigator as any;
  if (nav?.gpu) {
    try {
      const adapter = await nav.gpu.requestAdapter();
      if (adapter) return 'webgpu-hybrid';
    } catch { /* not available */ }
  }
  return 'wasm';
}
```

### WebGPU Warmup (MANDATORY for benchmarks, recommended for production)

First WebGPU inference compiles shaders (1-5 seconds). Run a throwaway inference first:

```typescript
const warmup = new Float32Array(16000); // 1 second of silence at 16kHz
await model.transcribe(warmup, 16000);  // Discard result
// Now real inference is fast
```

---

## 5. Transcription

Both models use the same transcription API:

```typescript
const audio: Float32Array = /* 16kHz mono PCM */;

const result = await model.transcribe(audio, 16000, {
  returnTimestamps: true,
  returnConfidences: true,
});

// result.utterance_text — full transcript string
// result.words[] — { text, start_time, end_time, confidence }
// result.confidence_scores — token-level, word-level, frame-level
// result.metrics — { preprocess_ms, encode_ms, decode_ms, total_ms, rtf }
```

### Audio Input Requirements

- **Sample rate:** 16,000 Hz (mandatory — models are trained on 16kHz)
- **Channels:** 1 (mono)
- **Format:** Float32Array, values -1.0 to 1.0
- **Capture:** Raw PCM via AudioWorklet. **Do NOT use MediaRecorder/Opus** — lossy codec costs 4-5% WER.

### Silence Trimming (recommended — Parakeet is VAD-sensitive)

```typescript
function trimSilence(audio: Float32Array, threshold = 0.01): Float32Array {
  let start = 0, end = audio.length - 1;
  while (start < end && Math.abs(audio[start]) < threshold) start++;
  while (end > start && Math.abs(audio[end]) < threshold) end--;
  const pad = 1600; // 100ms at 16kHz
  return audio.slice(Math.max(0, start - pad), Math.min(audio.length, end + pad + 1));
}
```

### Confidence Routing (production pattern)

Parakeet CTC/TDT confidence is real and calibrated. Use it to decide whether to trust edge output:

| Confidence | WER Observed | Action |
|------------|-------------|--------|
| 95%+ | 0-5% | Trust edge output |
| 85-95% | 5-15% | Usable, flag for optional server re-transcription |
| Below 85% | 15%+ | Route audio to server GPU |

---

## 6. Web Worker Pattern (production)

**Always run in a Web Worker.** Parakeet blocks the main thread during inference.

```typescript
// main thread
const worker = new Worker(new URL('./parakeet-worker.ts', import.meta.url));
worker.postMessage({ type: 'init', forceBackend: 'webgpu-hybrid', modelId: 'parakeet-110m' });
worker.postMessage({ type: 'transcribe', audio: pcmBuffer }, [pcmBuffer.buffer]);

// worker thread
import { fromUrls, fromHub } from 'parakeet.js';

self.addEventListener('message', async (event) => {
  const { type, audio, forceBackend, modelId } = event.data;
  if (type === 'init') {
    model = await loadModel(forceBackend, modelId);
    self.postMessage({ type: 'ready' });
  }
  if (type === 'transcribe') {
    const result = await model.transcribe(trimSilence(audio), 16000, {
      returnTimestamps: true,
      returnConfidences: true,
    });
    self.postMessage({ type: 'transcription', data: result });
  }
});
```

### Cleanup

Parakeet has no `dispose()`. Clean up with:

```typescript
if (model.resetMelCache) model.resetMelCache();
if (model.clearIncrementalCache) model.clearIncrementalCache();
model = null;
worker.terminate(); // Kills entire WASM/GPU context
```

---

## 7. Required HTTP Headers (WASM multi-threading)

Without these, WASM runs single-threaded (2-3x slower):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These enable `SharedArrayBuffer`. WebGPU path is NOT affected by these headers.

**Caveat:** COEP `require-corp` can break third-party resources that don't set `Cross-Origin-Resource-Policy`. Test thoroughly.

---

## 8. Things That Do NOT Work (proven by gauntlet testing)

Do not waste time on any of these:

1. **Audio filters (RNNoise, high-pass, browser NS multi-pass)** — All degrade WER. Higher confidence from filtered audio ≠ higher accuracy. Raw PCM → single Parakeet pass is optimal.

2. **Opus/MediaRecorder capture** — Lossy codec destroys 4-5% WER. Use AudioWorklet PCM capture.

3. **Encoder-decoder confidence (Whisper, Moonshine, Distil)** — Reports ~100% confidence on garbage. Only Parakeet CTC/TDT confidence is real. Do not use other models for confidence-based routing.

4. **`temperature: 0.0` on 110M** — Causes `<unk>` output (div-by-zero in logits). TDT decoder is greedy by default. Do not set temperature.

5. **Int8 encoder on WebGPU** — Not supported. Gets auto-promoted to fp32. Don't fight it.

6. **ROVER (multi-model merge) at edge** — Removed. Single model is sufficient. ROVER only relevant if a second model is added later.

---

## 9. Cost at Scale

| Path | Cost per recording | Cost per 1M voices |
|------|-------------------|-------------------|
| Edge (browser, either model) | $0.00 | $0.00 |
| Server GPU (0.6B on A100) | ~$0.00002 | ~$0.50 |

Server GPU processes a 2-minute recording in ~35ms. 100K recordings/hour on a single A100.

---

## Summary: Minimum Viable Setup

For either model, you need:

1. **ONNX artifacts**: encoder q8 + decoder q8 + vocab.txt (exported with Conv exclusion)
2. **parakeet.js**: `npm i parakeet.js`
3. **Load via `fromUrls`** (self-hosted) or `fromHub` (HuggingFace, 0.6B v3 only)
4. **Web Worker** wrapping `model.transcribe()`
5. **PCM audio** at 16kHz mono Float32Array
6. **WebGPU detection** with WASM fallback
7. **110M only:** nMels=80 + predLayers=1 patch after loading

That's it. No filters, no ROVER, no second model, no complex preprocessing.
