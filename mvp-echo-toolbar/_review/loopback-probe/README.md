# Loopback probe

Answers the question `npm test` cannot: does Chromium let a `file://` module worker fetch
`http://127.0.0.1`, and does onnxruntime-web load a model from it?

```bash
# optional: exercise the >1GiB streaming branch without moving 2.4GB
truncate -s 1100000000 /tmp/big.sparse

npm run build     # the ORT leg imports dist/renderer/assets/ort.bundle.min-*.js
MVP_PROBE_BIG=/tmp/big.sparse \
  node_modules/.bin/electron _review/loopback-probe \
  --ozone-platform=headless --no-sandbox --disable-gpu
```

`--ozone-platform=headless` plus `webPreferences.offscreen: true` is what makes this run on a box
with no X server. Neither touches the network stack or the origin rules.

`MVP_PROBE_NO_ORT=1` skips the ORT leg (the slow one).

The ORT leg needs `dist/win-unpacked/` present for a real .onnx file; without it the probe still
answers everything else. If the ort bundle hash in `main.js` has changed, update `ortPath`.

Findings are written up in `../LOOPBACK-PROBE.md`.
