# mvp-stt-docker — research notes

_2026-08-16. Read-only investigation; **nothing in `mvp-stt-docker` was changed.** Two Sonnet passes
over the source plus live measurement against `192.168.1.169:20300`._

Written because the toolbar work kept running into the server, and the answers should not have to be
rediscovered. **None of this is required for the toolbar to work** — it already works against the
server exactly as deployed.

---

## 1. Performance: change nothing

Measured on the live server, best of three, WAV upload:

| Audio | Response | vs realtime |
|---|---|---|
| 1 s | 86 ms | 11.5× |
| 5 s | 180 ms | 27.7× |
| 30 s | 662 ms | 45.3× |
| 120 s | 3.34 s | 35.9× |

Typical dictation is 1–8 s, so the real-world number is **under 250 ms**. Four simultaneous 5 s
requests completed in 0.44 s wall clock — each slowed from 0.18 s to ~0.35 s, none failed.

The thing that actually matters for latency is already right: **the model is loaded once at startup
and stays resident.** `bridge.py:120-129` starts the sherpa websocket server via FastAPI's
`lifespan`, and `managed_ws_adapter.py:397-468` keeps that subprocess alive across requests. Only a
lightweight WS session is per-request. The 86 ms floor for a 1 s clip is that warmth showing.

`managed-websocket` is the correct adapter and should stay the default. `subprocess`
(`subprocess_adapter.py:170-177`) spawns a fresh `sherpa-onnx-offline` per request and reloads the
0.6B ONNX graph and CUDA context every time — seconds, not milliseconds. `websocket` needs a second
separately-deployed container that this compose file no longer defines.

**One thing worth fixing eventually, and it is not about speed.** `convert_to_wav`
(`bridge.py:54-72`) calls `subprocess.run(ffmpeg)` — synchronous — from inside an `async def`
handler, so it stalls the entire uvicorn event loop for the duration, including health checks and
the watchdog. `asyncio.create_subprocess_exec` is a small change. For one LAN user it is insurance,
not a response to any observed problem.

Explicitly **not** worth doing: removing the per-request ffmpeg spawn (~10–30 ms for real effort and
regression risk); reusing the WS connection (~1–5 ms on loopback, and it deliberately discards the
"no stale state" guarantee documented at `managed_ws_adapter.py:9-13`); optimising model-switch cost
(rare and user-initiated).

Note the perf analysis above reads the **repo** source (v3.0.0). The live box runs v1.0.0 with an
older architecture. The measurements are of what is actually running; the citations describe what
you would get after a redeploy. Both say "fast enough".

---

## 2. Authentication: the live server enforces nothing

```
POST /v1/audio/transcriptions   no key    -> 200
                                wrong key -> 200
GET  /v1/models                 no key    -> 200
```

Anyone who can reach that host can spend the GPU. `/docs` is public too.

**A plausible explanation was investigated and REFUTED.** The repo's history does contain a removed
auth bypass — commit `cd6afcb` (2026-02-09) deleted this from `authenticate()`:

```python
-        client_ip = self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
-        if not client_ip:
-            client_ip = self.client_address[0]
-        if is_private_ip(client_ip):
-            return ("local", "Local Network")
```

`PRIVATE_NETWORKS` (`auth-proxy.py:31-36`) and `is_private_ip()` (`:114-120`) are still defined and
now have **zero call sites** — the giveaway that this was removed rather than never present. Since
the host is `192.168.1.169`, a stale build carrying that code would explain the 200s exactly.

It does not. That bypass keyed on a **client-supplied** `X-Forwarded-For` before falling back to the
socket address, so a public IP in that header should have forced a key check. It does not:

```
XFF: 192.168.1.50, no key -> 200
XFF: 8.8.8.8,      no key -> 200      <- would be 401 if the old bypass were the cause
XFF: 8.8.8.8,      wrong  -> 200
```

So the deployed proxy is not enforcing on **any** path from **any** source. It predates even that
commit, or is something else entirely. Determining which needs a look at the host — `docker compose
ps`, and the actual `auth-proxy.py` on that machine. Not answerable from outside.

**Current source is correct and fails closed.** `authenticate()` (`auth-proxy.py:143-161`) requires
`Authorization: Bearer <key>` against an active key; only `/health` is exempt (`:166-168`);
`load_keys()` returns `{}` on a missing or corrupt file (`:48-50`), so a broken keyfile denies
everything rather than admitting everyone. There is no env var, debug flag, or allowlist that turns
enforcement off.

### The fix is cheaper than a redeploy

`mvp-auth` has **no `build:` directive.** It runs stock `python:3.12-slim` (`docker-compose.yml:48`)
and bind-mounts the script read-only (`:53`), running `python -u auth-proxy.py` (`:57`). The code is
not baked into an image — it is read off the host filesystem at container start.

So: get the current `auth-proxy.py` onto that host, then `docker compose restart mvp-auth`. No
`--build`, no image rebuild, no touching `mvp-bridge`, no model re-download.

The caveat that cannot be checked from here: this assumes the host's deployment directory is this
tree, or is synced to it. If that machine has its own stale copy on disk, restarting alone changes
nothing — the file has to get there first.

API keys need no restart at all: `load_keys()` re-reads on every request (`auth-proxy.py:43-50`).

### Acceptance test after the fix

```
no key                    -> 401
XFF: 192.168.1.50, no key -> 401
XFF: 8.8.8.8,      no key -> 401
wrong key                 -> 401
sk-test                   -> 200
/health, no key           -> 200   (exempt by design)
```

All five of the first six currently return 200.

---

## 3. Redeploying, if you choose to

**Models do not re-download.** `entrypoint.sh:26-29` returns early when `tokens.txt` exists, and
`/models` is the named volume `mvp-models` (`docker-compose.yml:21-22`, `:73-75`), which survives
`up -d --build`. Only `docker compose down -v` destroys it.

What redeploying buys: `/v1/models/switch` starts working, `/health` gains its `engine` block, and
`/v1/models` gains `active`/`label`/`group`. The toolbar needs none of it — it handles the older
shapes — but a working switch route is the difference between one model and two.

What could break, from the compose history:

- The old deployment had a **third container**, `mvp-asr`, running the C++ ASR server separately.
  Commit `a3444ba` deleted it; the bridge now runs that binary as an internal subprocess. Anything
  external referencing `mvp-asr` — scripts, monitoring, firewall rules — stops resolving.
- `ADAPTER_TYPE` moved `websocket` → `managed-websocket` (`docker-compose.yml:24`). Anything still
  forcing `websocket` would point at `WS_HOST`/`WS_PORT`, which no longer exist in the compose file.
- CUDA is pinned to `12.6.3-cudnn-runtime-ubuntu22.04` (`Dockerfile.bridge:9`) with sherpa-onnx
  `v1.12.23` (`:33-34`), needing driver 550+. Worth checking the host's driver **before** rebuilding.
- Port mapping is unchanged at `20300:8080` (`:51`), so nothing client-facing moves.

Persisting across a redeploy: models (named volume), `api-keys.json`, `usage.json` and
`auth-proxy.py` (all host bind mounts). Logs are capped and rotated.

---

## 4. Confirmed for the toolbar

The hosted path sends WebM/Opus from `MediaRecorder`. The live server **decodes it correctly** —
a real ffmpeg-encoded WebM returned `duration: 5.0`, so the codec round-trip is proven, not just the
transport. Earlier probes had used WAV bytes labelled as WebM and did not establish this.

`convert_to_wav` runs ffmpeg on every upload regardless of format (`bridge.py:238-243`), so there is
no WAV fast path — irrelevant in practice, since the client always sends WebM.
