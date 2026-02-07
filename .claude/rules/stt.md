# STT Engine Rules

**Applies to**: `app/stt/`

## Engine Interface

All engines must implement:

```javascript
async transcribe(audioPath) → { success, text, error }
async isAvailable() → boolean
async getHealth() → { gpu, model, status }
```

## Engine Manager

- `engine-manager.js` is the coordinator
- Selects engine based on availability and preference
- Implements automatic fallback

## Engine Priority

1. User preference (from `engine-config.json`)
2. Native engine (whisper-standalone.exe)
3. Python engine (whisper_service.py)
4. Error state

## Temp File Handling

- Create temp files in OS temp directory
- Use unique filenames (timestamp + random)
- **Always delete after transcription**
- Handle cleanup on errors too

## Health Reporting

- Detect GPU via `wmic` on Windows
- Report: GPU name, CUDA availability, model loaded
- Update StatusBar with health info

## Error Handling

- Never throw unhandled exceptions
- Return structured error responses
- Log errors for debugging
- Show user-friendly messages in UI

## Performance

- Keep models loaded between transcriptions
- Avoid reloading model on each request
- Use INT8 quantization for speed
