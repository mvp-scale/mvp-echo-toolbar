/**
 * A loopback HTTP server that hands the on-disk model files to the renderer.
 *
 * WHY THIS EXISTS, since a custom protocol looks like the obvious answer and was
 * tried first: `model://` cannot work. Chromium refuses a cross-origin fetch from
 * a `file://` document to any scheme outside chrome / chrome-extension /
 * chrome-untrusted / data / http / https. `supportFetchAPI` makes a scheme
 * fetchable, but the initiator-origin check runs before that ever matters.
 * `http://127.0.0.1` IS on that list, so the file layer does not change at all —
 * only the shape of the URL the store hands back.
 *
 * MEASURED, not assumed (Electron 43.4.0 / Chromium 150, probe in
 * _review/loopback-probe/): a `file://` document AND a real `file://` module
 * worker — the shape `inference-worker.ts` actually uses, whose opaque origin is
 * what COEP tripped over — both fetch this server successfully, return
 * byte-identical content, honour `Range`, and read `Content-Length`. The
 * response arrives as `type: "basic"` and Chromium sends no `Origin` header at
 * all, so CORS is not applied to these requests. A server answering with a
 * deliberately WRONG `Access-Control-Allow-Origin` was still read successfully,
 * which is how we know the header is not what makes this work.
 *
 * Three bounds, all enforced here at the resource rather than trusted to the
 * caller:
 *
 *   PATH. Every request is reduced to `basename()` before it touches the disk,
 *   so `/tok/../../secret` can only ever resolve inside the model directory.
 *
 *   TOKEN. A per-session random prefix. The port is ephemeral and any local
 *   process can scan 65535 ports; the token is what stops one enumerating the
 *   model directory. It is not a secret worth protecting — the files are a
 *   public cc-by-4.0 model — it is there so this is not an open file server.
 *
 *   HOST. A `Host` header that is not loopback is refused. Any website can
 *   point a DNS name at 127.0.0.1 and reach this port; the token already stops
 *   that, and this stops it one layer earlier and for free.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * ORT preallocates `new Uint8Array(Content-Length)` and streams into it for
 * models over 1GB — the fp16 encoder is 1,182 MB — so an absent or wrong
 * Content-Length is not a cosmetic problem, it fails the load. Every response
 * below sets it explicitly, which also keeps Node from falling back to chunked
 * transfer-encoding.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isLoopbackHost(hostHeader) {
  if (!hostHeader) return false;
  const raw = String(hostHeader).toLowerCase();
  // A bare IPv6 literal (`::1`) is not legal in a Host header — it must be
  // bracketed — but Node hands through whatever arrived, so match it before any
  // port-stripping splits it on its own colons.
  if (LOOPBACK_HOSTS.has(raw)) return true;
  // Strip the port. Bracketed IPv6 keeps its brackets; everything else splits
  // on the first colon.
  const host = raw.startsWith('[')
    ? raw.slice(0, raw.indexOf(']') + 1)
    : raw.split(':')[0];
  return LOOPBACK_HOSTS.has(host);
}

/** `bytes=<start>-<end?>` only. Anything else is ignored and the whole file is sent. */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  // A suffix range (`bytes=-500`) means the LAST 500 bytes, not the first.
  let start = rawStart === '' ? size - Number(rawEnd) : Number(rawStart);
  let end = rawStart === '' ? size - 1 : (rawEnd === '' ? size - 1 : Number(rawEnd));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  start = Math.max(0, start);
  end = Math.min(size - 1, end);
  if (start > end) return { unsatisfiable: true };
  return { start, end };
}

/**
 * Build the request handler. Exported separately from the server so the routing
 * and confinement rules can be tested without binding a port.
 */
function createHandler({ dir, token }) {
  return function handle(req, res) {
    const deny = (status, body) => {
      // No directory listing, no path echo, no reason. A 404 that explains what
      // it did not find is a directory-enumeration oracle.
      res.writeHead(status, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'method not allowed');
    if (!isLoopbackHost(req.headers.host)) return deny(403, 'forbidden');

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch {
      return deny(400, 'bad request'); // malformed percent-encoding
    }

    const segments = pathname.split('/').filter(Boolean);
    // Exactly `/<token>/<file>`. A deeper path is not a file we serve, and
    // timingSafeEqual keeps the token from being recoverable a byte at a time.
    if (segments.length !== 2) return deny(404, 'not found');
    const [given, requested] = segments;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return deny(404, 'not found');

    // basename() is the confinement. `..`, absolute paths and nested directories
    // all collapse to a single name inside `dir` — there is no traversal left to
    // attempt. Windows separators too: basename() on win32 splits on `\` as well.
    const name = path.basename(requested);
    if (!name || name === '.' || name === '..') return deny(404, 'not found');
    const target = path.join(dir, name);

    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      return deny(404, 'not found');
    }
    if (!stat.isFile()) return deny(404, 'not found');

    const size = stat.size;
    const range = req.headers.range ? parseRange(req.headers.range, size) : null;

    if (range?.unsatisfiable) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
      return res.end();
    }

    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;

    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': length,
      'Accept-Ranges': 'bytes',
      // The files are immutable — a variant is identified by its exact byte
      // count and replaced wholesale, never edited in place.
      'Cache-Control': 'no-store',
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;

    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || length === 0) return res.end();

    const stream = fs.createReadStream(target, { start, end });
    // A client that navigates away mid-1.2GB leaves a read stream attached to a
    // dead socket. Destroy it on both sides rather than leaking a file handle
    // per abandoned load.
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };
}

/**
 * Start a loopback server for `dir`.
 *
 * Idempotent per instance: `start()` twice returns the same address rather than
 * binding a second port. A model switch, a retry and a restart all call this,
 * and none of them should produce a second server.
 */
function createModelServer({ dir, token = crypto.randomBytes(16).toString('hex'), host = '127.0.0.1' } = {}) {
  if (!dir) throw new Error('createModelServer: dir is required');

  const server = http.createServer(createHandler({ dir, token }));
  // A half-open connection from a renderer that went away must not hold the
  // process open at quit.
  server.on('clientError', (_err, socket) => socket.destroy());

  let starting = null;
  let address = null;

  function start() {
    if (address) return Promise.resolve(address);
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      const onError = (err) => { starting = null; reject(err); };
      server.once('error', onError);
      // Port 0 = ephemeral. Bound to `host` only, so this is not reachable from
      // the network even before the token is considered.
      server.listen(0, host, () => {
        server.removeListener('error', onError);
        const { port } = server.address();
        address = { port, host, token, origin: `http://${host}:${port}`, base: `http://${host}:${port}/${token}` };
        resolve(address);
      });
    });
    return starting;
  }

  function close() {
    address = null;
    starting = null;
    return new Promise((resolve) => server.close(() => resolve()));
  }

  /** The URL `fromUrls` should be handed for a file already in `dir`. */
  function urlFor(name) {
    if (!address) throw new Error('createModelServer: urlFor before start()');
    return `${address.base}/${encodeURIComponent(path.basename(name))}`;
  }

  return { server, start, close, urlFor, get address() { return address; } };
}

module.exports = { createModelServer, createHandler, parseRange, isLoopbackHost };
