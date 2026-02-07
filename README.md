# MVP-Echo Toolbar

Voice-to-text for Windows 11 that lives in your system tray. Speeds you up 5-10x.

![MVP-Echo Toolbar popup showing transcription result and settings, sitting in the Windows 11 system tray next to the microphone icon](mvp-echo-toolbar/docs/screenshot.png)

## Usage

The global keybind is **Ctrl+Alt+Z**. Hold down **Ctrl+Alt**, then:

1. **Tap Z** to start recording
2. **Talk** — say what you want transcribed
3. **Tap Z** again when you're done talking
4. **Wait for the ding** — once you hear it, the text is already in your clipboard
5. **Right-click > Paste** (or **Ctrl+V**) and away you go

The app is invisible during normal use. It sits in your notification area next to the microphone icon — you'll see the blue icon change color as it records and processes. Click it anytime to see your last transcription, copy it again, or adjust settings.

## Requirements

1. **Faster-Whisper server** running on your LAN with a GPU. See [`faster-whisper-docker/`](faster-whisper-docker/) for the Docker setup.
2. **Windows 11** machine running the toolbar.

## Setup

1. Deploy the Whisper server on your LAN (e.g., Unraid):
   ```bash
   cd faster-whisper-docker
   scp -r . root@192.168.1.10:/mnt/user/appdata/faster-whisper-docker/
   ssh root@192.168.1.10 "cd /mnt/user/appdata/faster-whisper-docker && docker-compose up -d"
   ```

2. Run `MVP-Echo Toolbar 2.0.0.exe` on Windows (portable, no install needed).

3. Click the tray icon, open **Settings**, and set your server endpoint:
   ```
   http://192.168.1.10:20300/v1/audio/transcriptions
   ```

## Build From Source

```bash
cd mvp-echo-toolbar
npm install
npm run dist
```

Output: `dist/MVP-Echo Toolbar 2.0.0.exe` (portable) and `dist/MVP-Echo Toolbar Setup 2.0.0.exe` (installer).

## How It Works

```
Windows 11                           LAN Server (Unraid/Docker)
+-----------------------+            +--------------------------+
|  MVP-Echo Toolbar     |   HTTP     |  faster-whisper-server   |
|  (system tray app)    | ---------> |  (GPU transcription)     |
|                       |   audio    |                          |
|  Ctrl+Alt+Z = record  | <--------- |  NVIDIA GPU + CUDA       |
|  ding = clipboard     |   text     |  Port 20300              |
+-----------------------+            +--------------------------+
```

## Tray Icon States

| Color | Meaning |
|-------|---------|
| Blue | Ready |
| Red | Recording |
| Yellow | Processing |
| Green | Copied to clipboard |

## Project Structure

```
mvp-echo-toolbar/       # Electron app (React + Vite + TypeScript)
faster-whisper-docker/   # Server deployment (Docker Compose + nginx)
```
