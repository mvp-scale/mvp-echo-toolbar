# Testing Real Whisper Transcription on Ubuntu Server

## ✅ Setup Complete!

Your environment is ready to test **real Faster-Whisper transcription** in the browser without needing Electron.

---

## How to Test Real Transcription

### Step 1: Start the Development Server (Terminal 1)

```bash
cd /home/corey/projects/mvp-echo
node dev-server.js
```

You should see:
```
============================================================
🚀 MVP-Echo Development Server
============================================================

✅ Server running on http://localhost:3001
✅ Faster-Whisper ready (CPU, int8, tiny model)
```

This server bridges HTTP requests from the browser to the Python Whisper service.

---

### Step 2: Start the Vite Dev Server (Terminal 2)

```bash
cd /home/corey/projects/mvp-echo
npm run dev:renderer
# OR just: vite --port 5173
```

This starts the UI on port 5173.

---

### Step 3: Open Browser with Real Whisper Enabled

Open your browser to:
```
http://localhost:5173?realwhisper=true
```

The `?realwhisper=true` flag tells the browser to use **real transcription** instead of mock data.

---

### Step 4: Test Transcription

1. **Click the Record button** (or press Ctrl+Alt+Z)
2. **Speak into your microphone** or let it record for a few seconds
3. **Click Stop**
4. **Watch the terminal** - you'll see:
   - `[Python] Loading faster-whisper model...`
   - `[Python] Transcribing audio file...`
   - `✅ Transcription complete: [your transcribed text]`
5. **See the result** in the browser UI

---

## Modes

### Mock Mode (Default)
```
http://localhost:5173
```
- Uses fake transcription data
- Fast for UI testing
- No Whisper processing

### Real Whisper Mode
```
http://localhost:5173?realwhisper=true
```
- Uses actual Faster-Whisper
- Real speech-to-text processing
- First transcription downloads tiny model (~39MB)
- Subsequent ones use cached model

---

## Troubleshooting

### "Connection refused" error
- Make sure `node dev-server.js` is running on port 3001
- Check terminal for errors

### "Failed to parse transcription result"
- Check the dev-server terminal for Python errors
- Ensure faster-whisper is installed: `python3 test-whisper.py`

### No audio recorded
- Check browser permissions (microphone access)
- Try a different browser
- Check browser console for errors

---

## Architecture

```
Browser (localhost:5173)
    ↓ (records audio as WebM)
    ↓ HTTP POST to localhost:3001/transcribe
Dev Server (Node.js)
    ↓ (saves to temp file)
    ↓ JSON over stdin
Python Whisper Service
    ↓ (loads Faster-Whisper model)
    ↓ (transcribes audio)
    ↓ JSON response
Browser
    ↓ (displays transcription)
```

---

## Performance

- **First run**: ~5-15 seconds (model download + transcription)
- **Subsequent runs**: ~2-5 seconds (transcription only)
- **Model**: tiny (~39MB, fastest)
- **Device**: CPU with int8 quantization (optimized for speed)

---

## Next Steps

Once you're happy with the functionality:
1. Use GitHub Actions to build Windows .exe
2. Test on Windows with display
3. Real Electron app will use the same Python service automatically
