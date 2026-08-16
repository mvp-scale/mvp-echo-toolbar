/**
 * MVP-Echo GPU / environment report.
 *
 * Paste into the DevTools console of the hidden capture window (tray popup →
 * debug button opens it). Read-only apart from the optional VRAM probe, which
 * allocates on its OWN GPUDevice and frees everything afterwards.
 *
 *   await mvpEchoReport()             // report only
 *   await mvpEchoReport({ vram: true })  // also probe allocatable VRAM
 *
 * The VRAM probe answers the question `gpu-detector.ts` currently gets wrong:
 * it reads `adapter.limits.maxBufferSize`, which is an API cap, not a
 * measurement of how much memory the card will actually hand out.
 */
window.mvpEchoReport = async function mvpEchoReport({ vram = false, chunkMB = 256, capMB = 12288 } = {}) {
  const out = {};
  const mb = (b) => (b == null ? null : +(b / 1048576).toFixed(0));
  const line = (k, v) => console.log(`  ${String(k).padEnd(28)} ${v}`);

  // ── Environment ────────────────────────────────────────────────────────────
  console.group('%cEnvironment', 'font-weight:bold');
  out.crossOriginIsolated = self.crossOriginIsolated === true;
  out.sharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined';
  out.hardwareConcurrency = navigator.hardwareConcurrency;
  out.deviceMemoryGB = navigator.deviceMemory ?? null; // Chrome only, coarse
  line('crossOriginIsolated', out.crossOriginIsolated);
  line('SharedArrayBuffer', out.sharedArrayBuffer + (out.sharedArrayBuffer ? '' : '  ← WASM decode is SINGLE-threaded'));
  line('logical cores', out.hardwareConcurrency);
  line('navigator.deviceMemory', out.deviceMemoryGB ? out.deviceMemoryGB + ' GB (coarse)' : 'n/a');
  if (performance.memory) {
    out.jsHeapUsedMB = mb(performance.memory.usedJSHeapSize);
    out.jsHeapLimitMB = mb(performance.memory.jsHeapSizeLimit);
    line('JS heap used / limit', `${out.jsHeapUsedMB} / ${out.jsHeapLimitMB} MB`);
  }
  console.groupEnd();

  // ── GPU adapter ────────────────────────────────────────────────────────────
  console.group('%cGPU adapter', 'font-weight:bold');
  if (!navigator.gpu) {
    console.warn('  navigator.gpu is undefined — WebGPU unavailable');
    out.webgpu = false;
  } else {
    out.webgpu = true;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      console.warn('  requestAdapter() returned null — no usable GPU');
      out.adapter = null;
    } else {
      // `adapter.info` is the current API; requestAdapterInfo() is deprecated
      // but is what older Chromium exposes, so try both.
      let info = adapter.info;
      if (!info && adapter.requestAdapterInfo) { try { info = await adapter.requestAdapterInfo(); } catch { /* ok */ } }
      out.adapter = {
        vendor: info?.vendor ?? '?', architecture: info?.architecture ?? '?',
        device: info?.device ?? '?', description: info?.description ?? '?',
      };
      line('vendor / architecture', `${out.adapter.vendor} / ${out.adapter.architecture}`);
      line('device / description', `${out.adapter.device} / ${out.adapter.description}`);

      out.features = [...adapter.features].sort();
      out.shaderF16 = adapter.features.has('shader-f16');
      line('shader-f16', out.shaderF16 ? 'YES — fp16 encoder viable (~1182 MB vs 2363 MB)' : 'NO  — must stay on fp32');
      line('features', out.features.join(', ') || '(none)');

      const L = adapter.limits;
      out.limits = {
        maxBufferSizeMB: mb(L.maxBufferSize),
        maxStorageBufferBindingSizeMB: mb(L.maxStorageBufferBindingSize),
        maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize,
        maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup,
      };
      line('maxBufferSize', `${out.limits.maxBufferSizeMB} MB   ← an API cap, NOT available VRAM`);
      line('maxStorageBufferBinding', `${out.limits.maxStorageBufferBindingSizeMB} MB`);

      // ── Optional: how much will the card actually hand out? ────────────────
      if (vram) {
        console.log('  probing allocatable VRAM (own device, freed afterwards)...');
        const device = await adapter.requestDevice();
        const buffers = [];
        let okMB = 0;
        try {
          const chunk = chunkMB * 1048576;
          while (okMB < capMB) {
            device.pushErrorScope('out-of-memory');
            let b = null;
            try { b = device.createBuffer({ size: chunk, usage: GPUBufferUsage.STORAGE }); } catch { /* sync throw */ }
            const err = await device.popErrorScope();
            if (err || !b) { if (b) b.destroy(); break; }
            buffers.push(b);
            okMB += chunkMB;
          }
        } finally {
          for (const b of buffers) { try { b.destroy(); } catch { /* ok */ } }
          try { device.destroy(); } catch { /* ok */ }
        }
        out.allocatableVramMB = okMB;
        const enough = okMB >= 2600;
        line('allocatable (probe)', `~${okMB} MB${okMB >= capMB ? '+ (hit cap)' : ''}  ${enough ? '— fp32 encoder fits' : '— TIGHT for the 2363 MB fp32 encoder'}`);
      }
    }
  }
  console.groupEnd();

  // ── Model cache ────────────────────────────────────────────────────────────
  console.group('%cModel cache', 'font-weight:bold');
  try {
    const est = await navigator.storage.estimate();
    out.storageUsedMB = mb(est.usage);
    out.storageQuotaMB = mb(est.quota);
    line('IndexedDB usage / quota', `${out.storageUsedMB} / ${out.storageQuotaMB} MB`);
  } catch { line('storage.estimate()', 'unavailable'); }
  try {
    out.persisted = await navigator.storage.persisted();
    line('persistent storage', out.persisted ? 'granted — cache is eviction-safe' : 'NOT granted — model may be evicted');
  } catch { /* ok */ }
  out.cacheKey = localStorage.getItem('mvp-echo:cache-version');
  line('cache key', out.cacheKey ?? '(unset)');
  console.groupEnd();

  console.log('%cCopy this object into the chat:', 'font-weight:bold');
  console.log(JSON.stringify(out, null, 1));
  return out;
};

console.log('Loaded. Run:  await mvpEchoReport({ vram: true })');
