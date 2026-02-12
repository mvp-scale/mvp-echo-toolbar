# MVP-Echo Toolbar

**Industry-grade voice-to-text for Windows 11.** Record, transcribe, clipboard — in under a second. No accounts, no cloud, no subscriptions.

MVP-Echo sits in your system tray and turns speech into text with a single keyboard shortcut. GPU transcription hits 99% accuracy in under 300ms. Local CPU mode works offline with zero setup. Your audio never leaves your machine.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Platform: Windows 11](https://img.shields.io/badge/Platform-Windows%2011-0078D4.svg)]()
[![Latest Release](https://img.shields.io/github/v/release/mvp-scale/mvp-echo-toolbar)](../../releases/latest)

---

## Quick Start

**Download and run.** No installer, no setup, no account required.

1. Grab `MVP-Echo Toolbar 3.0.3.exe` from [Releases](../../releases/latest)
2. Run it — it's a portable executable
3. Press **Ctrl+Alt+Z** to start recording
4. Talk, then press **Ctrl+Alt+Z** again to stop
5. Wait for the ding — your text is already in the clipboard
6. **Ctrl+V** to paste anywhere

That's it. The app is invisible during normal use. It lives in your notification area — the icon changes color as it records and processes. Click it to see your last transcription or adjust settings.

## Why MVP-Echo

- **Fast** — GPU transcription returns in under 300ms. Local CPU under 2 seconds.
- **Accurate** — Powered by NVIDIA Parakeet TDT models. 99% accuracy on English speech.
- **Private** — Audio stays on your machine or your LAN. No telemetry. No cloud. No data collection.
- **Simple** — One keyboard shortcut. One portable exe. No Python, no dependencies, no configuration.
- **Free and open source** — Apache 2.0 licensed. Use it, modify it, share it — just give credit.

## Features

- **GPU Transcription** — 99% accuracy, under 300ms via a hosted GPU server on your LAN
- **Local CPU Mode** — Works offline with no internet and no setup required
- **Model Switching** — Choose between English (GPU), Multilingual (GPU), or English CPU
- **Auto-Clipboard** — Transcriptions are copied automatically with an audio confirmation
- **Privacy Mode** — One-click toggle to disable the microphone entirely
- **System Tray** — Minimal footprint, always accessible, never in the way

## Tray Icon States

| Color | Meaning |
|-------|---------|
| Blue | Ready |
| Red | Recording |
| Yellow | Processing |
| Green | Copied to clipboard |

## Models

| Model | Engine | Accuracy | Speed | Internet Required |
|-------|--------|----------|-------|-------------------|
| English | GPU (Parakeet TDT) | 99% | <300ms | LAN only |
| Multilingual | GPU (Whisper) | 97% | <500ms | LAN only |
| English CPU | Local (sherpa-onnx) | 80% | <2s | No |

## Architecture

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

MVP-Echo works in two modes:

- **Local CPU** — Uses [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) bundled directly in the app. No server, no internet, no setup. Good for quick notes and offline use.
- **Hosted GPU** — Connects to a GPU transcription server running on your local network. Deploy the included Docker stack on any machine with an NVIDIA GPU for the best accuracy and speed available.

## Setting Up GPU Transcription

The portable exe works immediately with local CPU. For GPU quality:

1. Deploy the STT server on any machine with an NVIDIA GPU:
   ```bash
   cd mvp-stt-docker
   docker compose up -d
   ```
   See [`mvp-stt-docker/`](mvp-stt-docker/) for full setup instructions.

2. Run MVP-Echo Toolbar on your Windows machine

3. Click the tray icon > **Settings** > set your server endpoint:
   ```
   http://<server-ip>:20300/v1/audio/transcriptions
   ```

4. Enter your API key and click **Test Connection**

5. Select the **English** GPU model — it persists across restarts

## Build From Source

```bash
cd mvp-echo-toolbar
npm install
npm run dev          # Development mode (Vite + Electron)
npm run dist         # Build portable exe
```

Output: `dist/MVP-Echo Toolbar 3.0.3.exe`

**Note:** Building requires binary assets (`sherpa-onnx-bin/`, `sherpa_onnx_models/`, `ffmpeg.exe`) that are too large for git. See [Releases](../../releases/latest) for the pre-built executable, or contact us for build asset instructions.

### Tech Stack

- **Desktop:** Electron 28 + React 18 + TypeScript + Vite
- **STT Engines:** NVIDIA Parakeet TDT (GPU), sherpa-onnx (CPU)
- **Styling:** Tailwind CSS
- **Packaging:** electron-builder (portable exe)

## Project Structure

```
mvp-echo-toolbar/       # Electron app (React + Vite + TypeScript)
  app/main/             # Electron main process
  app/renderer/         # React UI
  app/stt/              # Speech-to-text engine adapters
  app/audio/            # Audio capture utilities
mvp-stt-docker/         # GPU server deployment (Docker Compose)
```

## Contributing

Contributions are welcome. Fork the repo, make your changes on a branch, and open a pull request.

If you find a bug or have a feature request, [open an issue](../../issues).

If you build something on top of MVP-Echo, we'd genuinely love to hear about it. We're building more tools in this space and your use case might shape what comes next. Start a thread in [Discussions](../../discussions) or reach out at [mvp-scale.com](https://mvp-scale.com).

## License

[Apache License 2.0](LICENSE) -- Copyright 2026 MVP-Scale.com

Use it, modify it, distribute it. Just keep the attribution and let people know what you changed. See [NOTICE](NOTICE) for details.
