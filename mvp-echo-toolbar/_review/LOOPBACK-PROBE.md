# Phase 1.1 — the loopback file server

_Written 2026-08-17 on `electron-43`. The evidence behind replacing `model://` with a loopback
server. Reproduce with the probe in `_review/loopback-probe/`._

## Bottom line

A `file://` module worker under Electron 43 fetches `http://127.0.0.1` successfully, gets
byte-identical content, and streams a file over 1 GiB with an exact `Content-Length`. The store,
downloader, manifest and pruning are untouched — only the URL shape changed.

**Still off by default** behind `--model-store`. A probe is not a Windows build.

## What was wrong with `model://`

Chromium refuses a cross-origin fetch from a `file://` document to any scheme outside `chrome`,
`chrome-extension`, `chrome-untrusted`, `data`, `http`, `https`. `supportFetchAPI` makes a scheme
fetchable, but the initiator-origin check runs first, so no set of privileges rescues it.
`http://127.0.0.1` is on that list.

## What the probe measured

Electron 43.4.0 / Chromium 150.0.7871.224, run headlessly with
`--ozone-platform=headless` and `webPreferences.offscreen: true` (the box has no X server;
neither switch touches the network stack or the origin rules).

The worker is a **real `file://` module worker**, not a `blob:` one. A blob worker inherits the
document's origin; the real `inference-worker.ts` gets an opaque origin, and that difference is
exactly what COEP tripped over previously.

| Question | Answer |
|---|---|
| `file://` document → `http://127.0.0.1` | 200, full body |
| `file://` **module worker** → `http://127.0.0.1` | 200, full body |
| Bytes identical | SHA-256 matches |
| `Range` request from the worker | 206, correct slice |
| File **over 1 GiB** (1,100,000,000 B) | `Content-Length` exact, 1,100,000,000 streamed |
| Wrong path token | 404 |
| Real `ensureModel` with files present | zero network calls |
| **`onnxruntime-web` `InferenceSession.create()` off a loopback URL** | **session created, 3.0 s** |

That last row is the one that matters most. A plain `fetch()` succeeding does not prove ORT will —
ORT issues its own request and is the actual consumer. The probe loaded a real 131 MB ONNX model
(the bundled sherpa parakeet-tdt encoder) through `InferenceSession.create()` pointed at
`http://127.0.0.1:<port>/<token>/real-model.onnx` and got back a working session with the expected
IO names (`audio_signal`, `length` → `logprobs`).

### CORS is not applied to these requests

Worth recording because it is counter-intuitive and it decided the header policy. Chromium sends
**no `Origin` header** and the response arrives as `type: "basic"`, not `"cors"`. A server answering
with a deliberately **wrong** `Access-Control-Allow-Origin: https://example.com` was still read
successfully — so CORS is not what makes this work, and an `Access-Control-Allow-Origin: *` would
buy nothing while widening who else could read the port.

The server therefore sends no ACAO at all. If a future Chromium starts enforcing this, the symptom
is a clean transport error, not data loss.

### The 1 GiB branch is not academic

`onnxruntime-web` loads a model with `fetch(url, {credentials: 'same-origin'})` and, for external
data, branches at `1073741824` bytes into a path that preallocates `Uint8Array(Content-Length)` and
streams into it. The fp32 weights sidecar is 2,435 MB, so that is the path it actually takes: an
absent or wrong `Content-Length` is a failed load, not a cosmetic problem. Every response from the
server sets it explicitly, which also stops Node falling back to chunked transfer-encoding.

## The server

`app/main/model-server.js`. Ephemeral port, bound to `127.0.0.1`, serving one directory.

Three bounds, all at the resource rather than trusted to callers:

- **Path** — every request is reduced to `basename()` before touching disk, so `/tok/../../secret`
  can only resolve inside the model directory. Percent-encoded, backslash and absolute-path forms
  are all covered by tests, because `fetch()` normalises `..` away and only the encoded spellings
  reach the wire.
- **Token** — a per-session 32-hex-char prefix, compared with `timingSafeEqual`. Any local process
  can scan 65535 ports; this is what stops one enumerating the model directory. The files are a
  public cc-by-4.0 model, so this is not a secret worth protecting — it is there so this is not an
  open file server.
- **Host** — a non-loopback `Host` header is refused, since any DNS name can be pointed at
  127.0.0.1. `fetch()` will not set `Host`, so that test goes on the wire by hand.

`start()` is idempotent and single-flight: a switch, a retry and a restart share one port rather
than binding three. The listener closes on `before-quit` — quit is one of the things a user can do
during a 1.2 GB load.

## The one change to the store

`ensureModel` no longer builds URLs. It takes a `urlFor(name)` function, supplied by whoever owns
the port and the token, and there is deliberately **no default** — it throws *before downloading*
if one is missing. A default would let a caller who forgot to start the server move 1.2 GB and then
produce URLs that fail deep inside ORT, in the shape of a capability error. That misreading is what
deleted a user's encoder last time.

## Tests

`test/model-server.test.js`, 35 tests against a real bound socket. Suite total 212 → 248.
`npm run typecheck && npm test && npm run build` all green.

What the tests **cannot** cover is the reason the module exists — whether Chromium permits the
fetch. That is what the probe is for.

## Still open

- **Not verified on Windows.** No build has loaded a model this way. Until one has, `--model-store`
  stays opt-in; Phase 1.2 is that flip and nothing else.
- The acceptance check is unchanged: log shows `source=disk`, the worker loads, transcription
  succeeds, and a second launch downloads nothing.
