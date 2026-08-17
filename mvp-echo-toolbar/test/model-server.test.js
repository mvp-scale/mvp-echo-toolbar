/**
 * The loopback model server.
 *
 * These run against a REAL bound socket, not a mocked request object. The two
 * things that matter cannot be seen by reading the handler: that the bytes come
 * back identical (a 1.2GB encoder that is off by one byte fails late and
 * obscurely inside ORT), and that nothing outside the model directory is
 * reachable however the path is spelled.
 *
 * What these CANNOT cover is the reason this module exists: whether Chromium
 * lets a file:// worker fetch it at all. That was answered by an Electron probe
 * (_review/LOOPBACK-PROBE.md), not here.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const { createModelServer, parseRange, isLoopbackHost } = require('../app/main/model-server');

const TOKEN = 'a'.repeat(32);
let dir;
let srv;
let base;
let origin;
/** 300KB of noise — big enough to cross several socket writes, small enough to be instant. */
let payload;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-server-'));
  payload = crypto.randomBytes(300 * 1024);
  fs.writeFileSync(path.join(dir, 'encoder-model.fp16.onnx'), payload);
  fs.writeFileSync(path.join(dir, 'vocab.txt'), 'hello\n');
  fs.writeFileSync(path.join(dir, 'empty.bin'), '');
  fs.mkdirSync(path.join(dir, 'a-directory'));
  // The file traversal must not reach: one level up from the model directory.
  fs.writeFileSync(path.join(dir, '..', 'mvp-server-secret.txt'), 'do not serve me');

  srv = createModelServer({ dir, token: TOKEN });
  const addr = await srv.start();
  base = addr.base;
  origin = addr.origin;
});

after(async () => {
  await srv?.close();
  fs.rmSync(path.join(dir, '..', 'mvp-server-secret.txt'), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Raw fetch that never follows anything and never throws on a 4xx. */
async function get(url, opts = {}) {
  const res = await fetch(url, { redirect: 'manual', ...opts });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body };
}

/** A hand-written request, for the headers fetch() refuses to send. */
function rawRequest(port, raw) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(raw));
    let out = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => { out += d; });
    socket.on('end', () => resolve(out));
    socket.on('error', reject);
  });
}

describe('serving', () => {
  test('a model file comes back byte-identical', async () => {
    const res = await get(`${base}/encoder-model.fp16.onnx`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, payload.length);
    assert.ok(res.body.equals(payload), 'a single wrong byte fails deep inside ORT, not here');
  });

  test('Content-Length is exact', async () => {
    const res = await get(`${base}/encoder-model.fp16.onnx`);

    // Not cosmetic: ORT preallocates Uint8Array(Content-Length) and streams into
    // it for anything over 1GB, which the fp16 encoder is.
    assert.strictEqual(res.headers.get('content-length'), String(payload.length));
    assert.strictEqual(res.headers.get('transfer-encoding'), null, 'chunked would leave ORT with no length');
  });

  test('ranges are honoured, with the right bytes and a 206', async () => {
    const res = await get(`${base}/encoder-model.fp16.onnx`, { headers: { Range: 'bytes=100-199' } });

    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get('content-range'), `bytes 100-199/${payload.length}`);
    assert.ok(res.body.equals(payload.subarray(100, 200)));
  });

  test('an open-ended range runs to the end of the file', async () => {
    const res = await get(`${base}/vocab.txt`, { headers: { Range: 'bytes=2-' } });

    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.body.toString(), 'llo\n');
  });

  test('HEAD reports the size without sending the body', async () => {
    const res = await get(`${base}/encoder-model.fp16.onnx`, { method: 'HEAD' });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-length'), String(payload.length));
    assert.strictEqual(res.body.length, 0);
  });

  test('an empty file is a 200 with zero bytes, not a hang', async () => {
    const res = await get(`${base}/empty.bin`);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 0);
  });

  test('a missing file is 404', async () => {
    const res = await get(`${base}/not-here.onnx`);
    assert.strictEqual(res.status, 404);
  });

  test('a directory is not a file', async () => {
    const res = await get(`${base}/a-directory`);
    assert.strictEqual(res.status, 404);
  });
});

describe('confinement', () => {
  // Every spelling of "escape the model directory" a client can put on the wire.
  // fetch() normalises `..` in the path, so the encoded forms are the real test —
  // they arrive at the server intact.
  for (const escape of [
    '%2e%2e%2fmvp-server-secret.txt',
    '..%2fmvp-server-secret.txt',
    '%2e%2e/mvp-server-secret.txt',
    '..%5cmvp-server-secret.txt',        // Windows separator
    '%2e%2e%5cmvp-server-secret.txt',
  ]) {
    test(`traversal is refused: ${escape}`, async () => {
      const res = await get(`${base}/${escape}`);

      assert.strictEqual(res.status, 404, 'basename() must collapse this inside the model dir');
      assert.ok(!res.body.toString().includes('do not serve me'));
    });
  }

  test('an absolute path is refused', async () => {
    const res = await get(`${origin}/${TOKEN}/%2fetc%2fpasswd`);

    assert.strictEqual(res.status, 404);
    assert.ok(!res.body.toString().includes('root:'));
  });

  test('a wrong token is 404', async () => {
    const res = await get(`${origin}/${'b'.repeat(32)}/encoder-model.fp16.onnx`);
    assert.strictEqual(res.status, 404);
  });

  test('a token of the wrong length is 404 and does not throw', async () => {
    // timingSafeEqual throws on a length mismatch — the length check must come first,
    // or a short token is a 500 instead of a 404.
    const res = await get(`${origin}/short/encoder-model.fp16.onnx`);
    assert.strictEqual(res.status, 404);
  });

  test('no token at all is 404 — the file name alone is not a path', async () => {
    const res = await get(`${origin}/encoder-model.fp16.onnx`);
    assert.strictEqual(res.status, 404);
  });

  test('the token is not a directory to browse', async () => {
    const res = await get(`${base}/`);

    assert.strictEqual(res.status, 404);
    assert.ok(!res.body.toString().includes('vocab.txt'), 'no listing — this is not a file browser');
  });

  test('a deeper path under the token is 404', async () => {
    const res = await get(`${base}/nested/vocab.txt`);
    assert.strictEqual(res.status, 404);
  });

  test('a non-loopback Host is refused — DNS rebinding reaches this port', async () => {
    // fetch() will not let us set Host (a forbidden header name), so this goes
    // on the wire by hand — which is also exactly how an attacker would send it.
    const res = await rawRequest(srv.address.port, `GET /${TOKEN}/vocab.txt HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n`);

    assert.match(res, /^HTTP\/1\.1 403/);
    assert.ok(!res.includes('hello'), 'the file must not be served to a rebound name');
  });

  test('a loopback Host on the wire is still served', async () => {
    // The guard above is worthless if it also refuses the real client.
    const res = await rawRequest(srv.address.port, `GET /${TOKEN}/vocab.txt HTTP/1.1\r\nHost: 127.0.0.1:${srv.address.port}\r\nConnection: close\r\n\r\n`);

    assert.match(res, /^HTTP\/1\.1 200/);
    assert.ok(res.includes('hello'));
  });

  test('a write method is refused', async () => {
    const res = await get(`${base}/vocab.txt`, { method: 'DELETE' });
    assert.strictEqual(res.status, 405);
  });
});

describe('binding', () => {
  test('the port is ephemeral and the bind is loopback-only', async () => {
    const addr = srv.address;

    assert.ok(addr.port > 0 && addr.port !== 80 && addr.port !== 8080, 'port 0 = OS-assigned');
    assert.strictEqual(addr.host, '127.0.0.1', 'binding 0.0.0.0 would put the model on the LAN');
    assert.strictEqual(srv.server.address().address, '127.0.0.1');
  });

  test('start() twice returns the same address rather than a second port', async () => {
    const again = await srv.start();

    assert.strictEqual(again.port, srv.address.port);
  });

  test('concurrent start() calls share one bind', async () => {
    // A switch, a retry and a restart can all call this at once. Two servers
    // would mean two ports and URLs that outlive their server.
    const s = createModelServer({ dir });
    try {
      const [a, b, c] = await Promise.all([s.start(), s.start(), s.start()]);
      assert.strictEqual(a.port, b.port);
      assert.strictEqual(b.port, c.port);
    } finally {
      await s.close();
    }
  });

  test('the token defaults to something long and random per server', async () => {
    const a = createModelServer({ dir });
    const b = createModelServer({ dir });

    const ta = (await a.start()).token;
    const tb = (await b.start()).token;
    try {
      assert.ok(ta.length >= 32, 'the token is what stops another local process enumerating the dir');
      assert.notStrictEqual(ta, tb, 'a shared token across sessions is a fixed URL');
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('urlFor produces the shape fromUrls is handed', async () => {
    const url = srv.urlFor('encoder-model.fp16.onnx');

    assert.strictEqual(url, `${base}/encoder-model.fp16.onnx`);
    assert.ok(url.startsWith('http://127.0.0.1:'), 'http://127.0.0.1 is the one origin a file:// worker may fetch');
    // Whatever it returns has to actually serve.
    const res = await get(url);
    assert.strictEqual(res.status, 200);
  });

  test('urlFor before start() fails loudly rather than emitting a URL to nowhere', () => {
    const s = createModelServer({ dir });
    assert.throws(() => s.urlFor('vocab.txt'), /before start/);
  });

  test('a closed server stops answering', async () => {
    const s = createModelServer({ dir });
    const addr = await s.start();
    await s.close();

    await assert.rejects(fetch(`${addr.base}/vocab.txt`), 'a stale URL must fail, not hit a recycled port');
  });
});

describe('parseRange', () => {
  test('a suffix range means the LAST n bytes', () => {
    assert.deepStrictEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  });

  test('an end past the file is clamped', () => {
    assert.deepStrictEqual(parseRange('bytes=990-5000', 1000), { start: 990, end: 999 });
  });

  test('a start past the file is unsatisfiable, not a negative length', () => {
    assert.deepStrictEqual(parseRange('bytes=5000-6000', 1000), { unsatisfiable: true });
  });

  test('a multipart or malformed range is ignored, and the whole file is sent', () => {
    assert.strictEqual(parseRange('bytes=0-10,20-30', 1000), null);
    assert.strictEqual(parseRange('items=0-10', 1000), null);
    assert.strictEqual(parseRange('bytes=-', 1000), null);
    assert.strictEqual(parseRange('', 1000), null);
  });
});

describe('isLoopbackHost', () => {
  test('loopback in its several spellings', () => {
    for (const h of ['127.0.0.1', '127.0.0.1:54321', 'localhost:99', '[::1]:8080', '::1']) {
      assert.strictEqual(isLoopbackHost(h), true, h);
    }
  });

  test('anything else is not', () => {
    for (const h of ['evil.example.com', 'evil.example.com:127.0.0.1', '192.168.1.169:20300', '', undefined]) {
      assert.strictEqual(isLoopbackHost(h), false, String(h));
    }
  });
});
