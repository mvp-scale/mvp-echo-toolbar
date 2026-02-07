# MVP-Echo Light v1.1.0

**Cloud-Based Voice-to-Text Transcription for Windows 11**

## What is MVP-Echo Light?

MVP-Echo Light is a **minimal, cloud-based** version of MVP-Echo that offloads all speech-to-text processing to a remote endpoint. This keeps the application lightweight and allows you to leverage powerful GPU servers for faster transcription.

## Key Features

- ☁️ **Cloud Processing** - Send audio to your configured endpoint
- 📦 **Minimal Size** - ~50MB installer (no AI models included)
- 🌐 **Flexible Backend** - Use any OpenAI-compatible STT API
- 🎤 **Same Great UI** - Ocean visualizer, keyboard shortcuts, clipboard integration
- 🔒 **Optional Privacy** - Choose your own hosting (self-hosted or cloud)

## Differences from Standard

| Feature | Light | Standard |
|---------|-------|----------|
| **Install Size** | ~50MB | ~250MB |
| **Processing** | Remote endpoint | Local (GPU/CPU) |
| **Internet** | Required | Not required |
| **Privacy** | Depends on endpoint | Fully local |
| **GPU** | Server-side | Client-side |

## Configuration

On first run, configure your cloud endpoint:

1. Click **⚙️ Settings** in footer
2. Enter **Endpoint URL**: `http://your-server:20300/v1/audio/transcriptions`
3. (Optional) Enter **API Key** if your endpoint requires authentication
4. Select **Model**: tiny, base, small, medium, or large variants
5. Click **Test Connection**

## Recommended Endpoints

### Self-Hosted (Unraid/Docker):
```
http://192.168.1.10:20300/v1/audio/transcriptions
```

### Commercial Services:
- OpenAI Whisper API
- Assembly AI
- Deepgram
- Or any OpenAI-compatible transcription service

## Building

```bash
# Install dependencies
npm install

# Build frontend
npm run build

# Package Windows installer
npm run dist
```

**Output**: `dist/MVP-Echo-Light-1.1.0.exe`

## Development

```bash
# Start dev mode
npm run dev

# App runs at: http://localhost:5173 (Vite) + Electron
```

## System Requirements

- **OS**: Windows 11 (Windows 10 may work)
- **RAM**: 4GB minimum
- **Disk**: 100MB free space
- **Internet**: Required for cloud processing
- **Microphone**: Required for voice input

## Support

For issues or questions, see the main MVP-Echo repository.
