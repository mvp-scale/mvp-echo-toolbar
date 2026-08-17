// A real file:// module worker — the same shape inference-worker.ts is loaded
// as. Its origin is opaque, which is precisely what COEP tripped over and what
// makes a blob: worker the wrong test.
self.onmessage = async (e) => {
  const { urls, expectBytes, bigUrl, bigSize } = e.data;
  const out = [];

  async function sha256Hex(buf) {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // 1-3. The three URLs the store handed back, fetched exactly as ORT would.
  for (const [key, url] of Object.entries(urls)) {
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      const buf = await res.arrayBuffer();
      out.push({
        step: `fetch:${key}`, ok: res.ok, status: res.status,
        bytes: buf.byteLength,
        contentLength: res.headers.get('Content-Length'),
        type: res.type,
        sha: key === 'encoderUrl' ? await sha256Hex(buf) : undefined,
      });
    } catch (err) {
      out.push({ step: `fetch:${key}`, ok: false, error: String((err && err.message) || err) });
    }
  }

  // 4. The >1GiB branch. onnxruntime-web preallocates Uint8Array(Content-Length)
  //    and streams into it above 1073741824 bytes; the fp32 weights sidecar is
  //    2,435 MB, so this is the path it actually takes. Reproduced here rather
  //    than trusted.
  if (bigUrl) {
    try {
      const res = await fetch(bigUrl, { credentials: 'same-origin' });
      const len = parseInt(res.headers.get('Content-Length'), 10);
      const buf = new Uint8Array(len);
      const reader = res.body.getReader();
      let at = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf.set(value, at);
        at += value.byteLength;
      }
      out.push({
        step: 'fetch:over-1GiB', ok: at === bigSize && len === bigSize,
        contentLength: len, streamed: at, expected: bigSize,
        overThreshold: bigSize > 1073741824,
      });
    } catch (err) {
      out.push({ step: 'fetch:over-1GiB', ok: false, error: String((err && err.message) || err) });
    }
  }

  out.push({ step: 'expectBytes', value: expectBytes });
  self.postMessage(out);
};
