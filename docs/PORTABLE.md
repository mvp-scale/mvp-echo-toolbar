# MVP-Echo Portable Application Guide

This guide explains how to build and use the portable version of MVP-Echo with embedded Python support.

## Overview

The portable version of MVP-Echo includes:
- Complete Python 3.11 runtime environment
- All required ML dependencies (faster-whisper, PyTorch, etc.)
- Automatic temporary extraction and cleanup
- No installation required - runs from any location
- Zero system dependencies

## Building the Portable Application

### Prerequisites

- Windows 10/11 (64-bit)
- Node.js 18+
- PowerShell (for Python preparation)
- Internet connection (for downloading Python and packages)

### Step 1: Prepare Python Environment

Run one of these commands to download and prepare the embedded Python distribution:

```bash
# Using PowerShell (Recommended)
npm run prepare:python:ps

# Using Node.js
npm run prepare:python
```

This will:
- Download Python 3.11.8 embedded distribution (~25MB)
- Install required packages: faster-whisper, numpy, torch, onnxruntime
- Create portable configuration
- Total size: ~200-350MB

### Step 2: Build Portable Application

```bash
# Build portable version with embedded Python
npm run pack:portable
```

This will:
- Build the Electron application
- Include the Python embedded distribution
- Create `MVP-Echo-Portable-{version}.exe` in the `dist` folder

## How Portable Mode Works

### Startup Process

1. **Detection**: App detects it's running in portable mode
2. **Extraction**: Python runtime is extracted to `%TEMP%/mvp-echo-python-{sessionId}/`
3. **Initialization**: Python environment is prepared (10-30 seconds)
4. **Ready**: Application is ready for transcription

### Session Management

Each time you run the portable app:
- A unique session ID is generated
- Python is extracted to a temporary directory
- Environment variables are set for embedded Python
- Whisper service starts using the extracted Python

### Cleanup Process

The app automatically cleans up when:
- **Normal Exit**: Complete removal of temp Python directory
- **Force Quit**: Emergency cleanup on next startup
- **Crash Recovery**: Orphaned sessions are cleaned after 24 hours

## File Structure

```
MVP-Echo-Portable.exe (150-200MB)
│
├── Electron App (~50MB)
├── Python Embedded (~100-150MB compressed)
│   ├── python.exe
│   ├── python311.dll
│   ├── Lib/
│   └── site-packages/
│       ├── faster_whisper/
│       ├── torch/
│       └── other dependencies/
└── Whisper Service Script
```

When running:
```
%TEMP%/mvp-echo-python-{sessionId}/
├── python/
│   ├── python.exe
│   ├── python311.dll
│   ├── Lib/
│   └── site-packages/
├── whisper_service.py
└── (temporary models and cache)
```

## Performance Characteristics

### First Launch
- **Extraction Time**: 10-30 seconds (depends on disk speed)
- **Memory Usage**: ~500MB-1GB during operation
- **Disk Space**: ~400MB temporary space required

### Subsequent Launches
- **No Caching**: Fresh extraction each time (ensures clean environment)
- **Consistent Performance**: No accumulated temporary files
- **Startup Time**: Similar to first launch

## Troubleshooting

### "Python extraction failed"
- **Cause**: Insufficient disk space in TEMP directory
- **Solution**: Free up space in `%TEMP%` (need ~400MB)

### "Permission denied during cleanup"
- **Cause**: Windows Defender or antivirus scanning extracted files
- **Solution**: Add temp directory to antivirus exclusions

### "Extraction timeout"
- **Cause**: Slow disk or antivirus interference
- **Solution**: Run from SSD, exclude from real-time scanning

### "Python service startup failed"
- **Cause**: Python environment corruption during extraction
- **Solution**: Restart app (triggers fresh extraction)

## Development Mode

For testing portable functionality during development:

```bash
# Enable portable mode in development
npm run dev:portable
```

This sets `PORTABLE_MODE=true` environment variable.

## Manual Cleanup

If automatic cleanup fails:

```bash
# Clean up Python embedded distribution
npm run clean:python

# Manual temp directory cleanup
# Navigate to %TEMP% and delete folders starting with "mvp-echo-python-"
```

## Security Considerations

### Temporary File Security
- Python is extracted to user's TEMP directory
- Files are automatically cleaned on exit
- No permanent system modifications
- No registry changes

### Windows Defender
- May flag portable Python extraction initially
- Add exclusion for MVP-Echo executable if needed
- Temporary files are automatically cleaned

## Size Optimization Tips

### Reducing Bundle Size
1. **Minimize Python Packages**: Only include essential packages
2. **Use Quantized Models**: Prefer INT8 over FP16 models
3. **Compression**: Use 7z compression for Python bundle

### Runtime Optimization
1. **Lazy Loading**: Only extract files as needed
2. **Parallel Processing**: Extract during splash screen
3. **Memory Management**: Clean up temporary files promptly

## Comparison: Portable vs Installer

| Feature | Portable | Installer |
|---------|----------|-----------|
| **Size** | 150-200MB | 50-80MB + download |
| **Dependencies** | None | System Python or ONNX |
| **Startup** | 10-30s first time | 2-5s |
| **System Impact** | Zero | Registry entries |
| **Flexibility** | Run anywhere | Fixed installation |
| **Updates** | Replace exe | Installer required |

## Best Practices

### For Users
1. **Run from SSD**: Faster extraction and operation
2. **Ensure Disk Space**: Keep 500MB+ free in TEMP
3. **Antivirus Exclusions**: Add MVP-Echo to exclusions
4. **Clean Shutdown**: Use File > Exit for proper cleanup

### For Deployment
1. **Test Thoroughly**: Verify on clean Windows VMs
2. **Document Requirements**: Specify disk space needs
3. **Provide Alternatives**: Offer both portable and installer versions
4. **Monitor Performance**: Track startup times and resource usage

## Advanced Configuration

### Custom Python Location
Set environment variable to override extraction location:
```
set MVP_ECHO_PYTHON_DIR=C:\Custom\Path
```

### Debug Mode
Enable verbose logging:
```
set MVP_ECHO_DEBUG=true
```

### Disable Cleanup (Development)
Preserve temp files for debugging:
```
set MVP_ECHO_NO_CLEANUP=true
```

## Future Enhancements

### Planned Features
- **Session Caching**: Optional 24-hour temp file retention
- **Progressive Extraction**: Extract only needed files initially
- **Compression**: Better compression for smaller bundle size
- **Auto-Update**: In-place portable app updates

### Migration Path
- **ONNX Runtime**: Eventually migrate to ONNX for smaller size
- **WebAssembly**: Browser-based inference for ultimate portability
- **Cloud Processing**: Optional server-side processing

This portable approach provides maximum compatibility and zero installation requirements, making MVP-Echo accessible to users who cannot install software or prefer portable applications.