# Faster-Whisper Server (Docker)

GPU-accelerated Whisper transcription server for MVP-Echo Toolbar. Runs on your LAN (e.g., Unraid) and provides an OpenAI-compatible API that the toolbar connects to.

## What's Included

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Two containers: faster-whisper API (GPU) + auth proxy |
| `auth-proxy.py` | CORS proxy + API key validation + usage tracking |
| `api-keys.json` | API keys for remote access (edit to add/revoke users) |
| `usage.json` | Auto-updated usage stats per API key (seconds processed) |
| `nginx.conf` | Legacy — no longer used (replaced by auth-proxy) |

Uses the pre-built [fedirz/faster-whisper-server](https://github.com/fedirz/faster-whisper-server) image. No custom Dockerfile needed.

## Deploy to Unraid

1. Copy this folder to your Unraid server:
   ```bash
   scp -r faster-whisper-docker root@192.168.1.10:/mnt/user/appdata/
   ```

2. SSH in and start:
   ```bash
   ssh root@192.168.1.10
   cd /mnt/user/appdata/faster-whisper-docker
   docker-compose up -d
   ```

3. Verify it's running:
   ```bash
   curl http://192.168.1.10:20300/health
   ```

## Connect MVP-Echo Toolbar

In the toolbar popup, open Settings and set:

- **Endpoint**: `http://192.168.1.10:20300/v1/audio/transcriptions`
- **API Key**: Leave blank for LAN access, or enter your key for remote access
- **Model**: Select any model (the server downloads it on first use)
- Click **Test Connection**

## API Key Management

Edit `api-keys.json` to add or revoke keys:

```json
{
  "keys": [
    { "key": "sk-corey-dev-2026", "name": "Corey (dev)", "active": true },
    { "key": "sk-friend-abc123",  "name": "Alex",        "active": true },
    { "key": "sk-revoked-old",    "name": "Old User",    "active": false }
  ]
}
```

Generate a new key: `openssl rand -hex 32`

Changes take effect immediately — no restart needed.

**Auth rules:**
- LAN requests (192.168.x.x, 10.x.x.x, 172.16-31.x.x) bypass auth entirely
- Remote requests (via Cloudflare tunnel, public IP) require `Authorization: Bearer <key>`
- `/health` and `/v1/models` endpoints are always open

## Usage Tracking

The auth proxy tracks cumulative seconds processed per API key in `usage.json`:

```json
{
  "sk-corey-dev-2026": {
    "name": "Corey (dev)",
    "total_seconds": 1247.3,
    "request_count": 89,
    "first_used": "2026-02-08T05:00:00Z",
    "last_used": "2026-02-08T06:30:00Z"
  }
}
```

View live: `cat usage.json | python3 -m json.tool`

## Management

```bash
docker-compose logs -f          # Watch logs (includes auth-proxy output)
docker-compose restart          # Restart
docker-compose down             # Stop
docker-compose down -v          # Stop and delete cached models
```

## Architecture

```
MVP-Echo Toolbar (Windows)
    |
    | HTTP POST audio + Bearer token → port 20300
    v
auth-proxy (CORS + key validation + usage tracking, port 20300 → 8000)
    |
    v
faster-whisper-server (GPU, port 8000)
    |
    v
NVIDIA GPU (CUDA)
```

## Requirements

- Docker + Docker Compose
- NVIDIA GPU with drivers
- nvidia-docker2 runtime

## Notes

- Models auto-download from Hugging Face on first request (~150MB for base)
- Model cache persists in a Docker volume (`whisper-models`)
- Memory limit is set to 8GB; adjust `mem_limit` in docker-compose.yml for your system
- LAN access requires no API key; remote access requires a key from `api-keys.json`
