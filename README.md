# MVP-Echo Toolbar

Voice-to-text for Windows 11 that lives in your system tray. Record, transcribe, clipboard — in under a second.

![MVP-Echo Toolbar in the Windows 11 system tray](mvp-echo-toolbar/assets/toolbar-screenshot.png)

## Usage

The global keybind is **Ctrl+Alt+Z**. Hold down **Ctrl+Alt**, then:

1. **Tap Z** to start recording
2. **Talk** — say what you want transcribed
3. **Tap Z** again when you're done talking
4. **Wait for the ding** — the text is already in your clipboard
5. **Ctrl+V** to paste and you're done

The app is invisible during normal use. It sits in your notification area — the icon changes color as it records and processes. Click it to see your last transcription or adjust settings.

## Features

![MVP-Echo Toolbar Setup Guide](mvp-echo-toolbar/assets/setup-guide.png)

- **GPU Transcription** — 99% accuracy, under 300ms via hosted GPU server
- **Local CPU Mode** — Works offline with no internet, no setup required
- **Switch Models** — English (GPU), Multilingual (GPU), or English CPU
- **Privacy First** — Audio never leaves your machine or your LAN

## Getting Started

### Option 1: Local CPU (no setup)

1. Download `MVP-Echo Toolbar 3.0.2.exe` from [Releases](../../releases)
2. Run it (portable, no install needed)
3. Press **Ctrl+Alt+Z** to record — it works immediately

### Option 2: Hosted GPU (best quality)

1. Deploy the STT server on your LAN (GPU required):
   ```bash
   cd mvp-stt-docker
   docker compose up -d
   ```
   See [`mvp-stt-docker/`](mvp-stt-docker/) for full setup instructions.

2. Run `MVP-Echo Toolbar 3.0.2.exe` on Windows

3. Click the tray icon > **Settings** > set your endpoint:
   ```
   http://<server-ip>:20300/v1/audio/transcriptions
   ```
4. Enter your API key and click **Test Connection**

## How It Works

```
Windows 11                             LAN Server (Docker)
+---------------------------+          +----------------------------+
|  MVP-Echo Toolbar         |          |  mvp-stt-docker            |
|  (system tray app)        |  HTTP    |  (GPU transcription)       |
|                           | -------> |                            |
|  Ctrl+Alt+Z = record      |          |  NVIDIA GPU + CUDA         |
|  ding = clipboard          | <------- |  Parakeet TDT models       |
|                           |  text    |  Port 20300                |
|  Local CPU fallback:      |          +----------------------------+
|  sherpa-onnx (offline)    |
+---------------------------+
```

## Tray Icon States

| Color | Meaning |
|-------|---------|
| Blue | Ready |
| Red | Recording |
| Yellow | Processing |
| Green | Copied to clipboard |

## Models

| Model | Engine | Accuracy | Speed | Internet |
|-------|--------|----------|-------|----------|
| English | GPU | 99% | <300ms | Required (LAN) |
| Multilingual | GPU | 97% | <500ms | Required (LAN) |
| English CPU | Local | 80% | <2s | Not required |

## Build From Source

```bash
cd mvp-echo-toolbar
npm install
npm run dist
```

Output: `dist/MVP-Echo Toolbar 3.0.2.exe` (portable executable).

Note: Building requires `sherpa-onnx-bin/`, `sherpa_onnx_models/`, and `ffmpeg.exe` in the `mvp-echo-toolbar/` directory. These binary assets are not stored in git — see [Releases](../../releases) for the pre-built executable.

## Project Structure

```
mvp-echo-toolbar/       # Electron app (React + Vite + TypeScript)
mvp-stt-docker/         # GPU server deployment (Docker Compose)
```
