# Python/Whisper Rules

**Applies to**: `python/`, `standalone-whisper/`

## whisper_service.py

- Subprocess spawned by `whisper-engine.js`
- Reads audio file path from stdin
- Outputs JSON to stdout
- Must handle errors gracefully

## Output Format

```json
{
  "success": true,
  "text": "transcribed text",
  "language": "en",
  "duration": 3.5
}
```

## Error Handling

- Always return valid JSON even on error
- Include error message in response
- Exit with code 0 (errors in JSON, not exit code)

## Model Loading

- Use faster-whisper library
- Models auto-download from Hugging Face
- Support: tiny, base, small
- Use INT8 quantization by default

## GPU Support

- Check CUDA availability at startup
- Fallback to CPU if CUDA unavailable
- Log compute device to stderr

## PyInstaller Build

- `standalone-whisper/whisper-cli.py` is the entry point
- Bundle all dependencies
- Output: `whisper-standalone.exe`
- Test with `--version` flag after build
