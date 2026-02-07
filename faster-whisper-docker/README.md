# Faster-Whisper Server (Docker)

GPU-accelerated Whisper transcription server for MVP-Echo Toolbar. Runs on your LAN (e.g., Unraid) and provides an OpenAI-compatible API that the toolbar connects to.

## What's Included

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Two containers: faster-whisper API (GPU) + nginx (CORS proxy) |
| `nginx.conf` | Reverse proxy adding CORS headers, exposed on port 20300 |

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
- **Model**: Select any model (the server downloads it on first use)
- Click **Test Connection**

## Management

```bash
docker-compose logs -f          # Watch logs
docker-compose restart          # Restart
docker-compose down             # Stop
docker-compose down -v          # Stop and delete cached models
```

## Architecture

```
MVP-Echo Toolbar (Windows)
    |
    | HTTP POST audio → port 20300
    v
nginx (CORS proxy, port 20300 → 8000)
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
- No authentication by default; keep on your local network only
