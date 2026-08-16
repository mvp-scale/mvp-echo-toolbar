/**
 * Parallel range downloader for large model files.
 *
 * HuggingFace throttles per CONNECTION, not per client. Measured against their
 * CDN from one machine, anonymously:
 *
 *     1 connection    4.9 MB/s
 *     8 connections  50.7 MB/s
 *
 * Same link, no credentials — an API token changes nothing, because the limit is
 * per-stream. So a 1,182 MB encoder is ~4 minutes on one stream and ~25 seconds
 * on eight. This is HuggingFace's own sanctioned pattern; their `hf_transfer`
 * tool exists to do exactly this.
 *
 * `fetchImpl` is injected rather than imported for two reasons. It makes every
 * rule here testable without a network or a gigabyte of traffic — and in
 * production it must be Electron's `net.fetch`, which uses Chromium's network
 * stack. Node's own fetch ignores system proxy settings, PAC scripts and
 * corporate certificate stores, so using it would break every user behind a
 * corporate proxy who works fine today (parakeet currently fetches from the
 * renderer, where Chromium handles all of that).
 */

const fs = require('fs');
const path = require('path');

/** Bytes per chunk below which splitting costs more in round-trips than it saves. */
const MIN_CHUNK_BYTES = 1024 * 1024;

/**
 * Split `total` bytes into at most `connections` contiguous ranges.
 *
 * Every byte lands in exactly one range: gaps truncate the model, overlaps
 * corrupt it, and both fail silently at load time rather than at download time.
 */
function planRanges(total, connections, minChunkBytes = MIN_CHUNK_BYTES) {
  if (total <= 0) return [];
  // Never emit a zero-length range — `bytes=5-4` is malformed, not a no-op.
  const n = Math.max(1, Math.min(connections, Math.ceil(total / minChunkBytes), total));
  const size = Math.ceil(total / n);

  const ranges = [];
  for (let start = 0; start < total; start += size) {
    ranges.push({ start, end: Math.min(start + size - 1, total - 1) });
  }
  return ranges;
}

/** Ask for the size and whether ranges are honoured. Null size means "unknown". */
async function probe(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, { method: 'HEAD' });
    const get = (k) => (typeof res.headers?.get === 'function' ? res.headers.get(k) : undefined);
    const len = Number(get('content-length'));
    return {
      bytes: Number.isFinite(len) && len > 0 ? len : null,
      ranges: String(get('accept-ranges') || '').includes('bytes'),
    };
  } catch {
    // A host that refuses HEAD is not a host that cannot serve the file.
    return { bytes: null, ranges: false };
  }
}

/**
 * Download `url` to `destPath`.
 *
 * Writes to `<dest>.part` and renames only after the size checks out, so an
 * interrupted or short download can never be mistaken for a complete one on the
 * next launch. That is the difference between self-healing and a permanent
 * failure loop: a corrupt file at the real path looks valid forever.
 *
 * @param {object}   opts
 * @param {number}   [opts.connections=8]
 * @param {number}   [opts.minChunkBytes] below this, splitting costs more round-trips than it saves
 * @param {number}   [opts.expectedBytes] known size; skips the download if the file already matches
 * @param {Function} opts.fetchImpl        `net.fetch` in production
 * @param {Function} [opts.onProgress]     ({loaded, total}) — must reach total
 */
async function downloadFile(url, destPath, opts = {}) {
  const { connections = 8, expectedBytes, fetchImpl, onProgress, minChunkBytes = MIN_CHUNK_BYTES } = opts;
  if (typeof fetchImpl !== 'function') throw new Error('downloadFile requires fetchImpl');

  // Already here and the right size? Nothing to do. This is the entire point of
  // the exercise — a second launch must not touch the network.
  if (expectedBytes && fs.existsSync(destPath) && fs.statSync(destPath).size === expectedBytes) {
    onProgress?.({ loaded: expectedBytes, total: expectedBytes });
    return { path: destPath, bytes: expectedBytes, fromCache: true };
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const partPath = `${destPath}.part`;
  // A leftover .part from a previous crash is not resumable yet; start clean
  // rather than append to bytes of unknown provenance.
  if (fs.existsSync(partPath)) fs.rmSync(partPath, { force: true });

  const info = await probe(url, fetchImpl);
  const total = expectedBytes || info.bytes;
  const useRanges = info.ranges && total && connections > 1;

  let loaded = 0;
  const bump = (n) => { loaded += n; onProgress?.({ loaded, total: total || loaded }); };

  const handle = await fs.promises.open(partPath, 'w');
  try {
    /**
     * Drain one response to disk at `offset`.
     *
     * Streams the body rather than buffering it, and writes ASYNCHRONOUSLY.
     * Both matter, and the first version of this got both wrong: it did
     * `fs.writeSync` of a whole `arrayBuffer()` per range, which blocked the
     * event loop and starved the very requests it was running concurrently.
     * Measured against the real CDN, that cost the entire benefit —
     * 4.5 MB/s with eight ranges, identical to a single stream, while the same
     * eight ranges fetched without the writes ran at 33 MB/s. It also held
     * `connections × chunkSize` in memory: 1.2 GB for this model.
     */
    const drain = async (res, offset) => {
      if (res.body && typeof res.body[Symbol.asyncIterator] === 'function') {
        let pos = offset;
        for await (const chunk of res.body) {
          const buf = Buffer.from(chunk);
          await handle.write(buf, 0, buf.length, pos);
          pos += buf.length;
          bump(buf.length);
        }
        return;
      }
      // No streamable body (older impls, and the test double) — one write.
      const buf = Buffer.from(await res.arrayBuffer());
      await handle.write(buf, 0, buf.length, offset);
      bump(buf.length);
    };

    if (!useRanges) {
      // One stream. Correct everywhere, just slower — and the only option when
      // the server will not do ranges.
      const res = await fetchImpl(url, {});
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
      await drain(res, 0);
    } else {
      const ranges = planRanges(total, connections, minChunkBytes);
      await Promise.all(ranges.map(async ({ start, end }) => {
        const res = await fetchImpl(url, { headers: { Range: `bytes=${start}-${end}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status} on range ${start}-${end}`);
        // Positional writes: a chunk lands at its offset regardless of the order
        // it completes in, which is the whole reason these can run concurrently.
        await drain(res, start);
      }));
    }
  } catch (err) {
    await handle.close();
    fs.rmSync(partPath, { force: true });
    throw err;
  }
  await handle.close();

  const written = fs.statSync(partPath).size;
  if (total && written !== total) {
    fs.rmSync(partPath, { force: true });
    throw new Error(`size mismatch for ${url}: expected ${total} bytes, got ${written}`);
  }

  // Atomic: the destination either does not exist or is complete. Never partial.
  fs.renameSync(partPath, destPath);
  return { path: destPath, bytes: written, fromCache: false };
}

module.exports = { planRanges, downloadFile, MIN_CHUNK_BYTES };
