# 📦 Manual Whisper Model Download Guide

This guide shows you how to manually download Whisper models for completely offline operation.

## 🎯 Quick Setup

1. **Create models directory:**
   ```
   mkdir python-embedded\models
   ```

2. **Download models manually** (see URLs below)

3. **Run preparation** (skips model downloads):
   ```bash
   npm run prepare:python:ps
   ```

## 📥 Model Download URLs

### **Option A: Hugging Face (Recommended - Faster)**

Download from Hugging Face (faster servers):

| Model | Size | Download URL |
|-------|------|--------------|
| **tiny** | 39MB | https://huggingface.co/openai/whisper-tiny/resolve/main/pytorch_model.bin |
| **base** | 74MB | https://huggingface.co/openai/whisper-base/resolve/main/pytorch_model.bin |
| **small** | 244MB | https://huggingface.co/openai/whisper-small/resolve/main/pytorch_model.bin |
| **medium** | 769MB | https://huggingface.co/openai/whisper-medium/resolve/main/pytorch_model.bin |
| **large** | 1550MB | https://huggingface.co/openai/whisper-large-v2/resolve/main/pytorch_model.bin |

### **Option B: OpenAI Official (Original)**

Direct from OpenAI:

| Model | Size | Download URL |
|-------|------|--------------|
| **tiny** | 39MB | https://openaipublic.azureedge.net/main/whisper/models/65147644a518d12f04e32d6f3b26facc3f8dd46e5390956a9424a650c0ce22794/tiny.pt |
| **base** | 74MB | https://openaipublic.azureedge.net/main/whisper/models/ed3a0b6b1c0edf879ad9b11b1af5a0e6ab5db9205f891f668f8b0e6c6326e34e/base.pt |
| **small** | 244MB | https://openaipublic.azureedge.net/main/whisper/models/9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794/small.pt |
| **medium** | 769MB | https://openaipublic.azureedge.net/main/whisper/models/345ae4da62f9b3d59415adc60127b97c714f32e89e936602e85993674d08dcb1/medium.pt |
| **large-v2** | 5.7GB | https://openaipublic.azureedge.net/main/whisper/models/e4b87e7e0bf463eb8e6956e646f1e277e901512310def2c24bf0e11bd3c28e9a/large-v2.pt |


base.pt      277.00
large-v2.pt 5887.63
medium.pt   2914.18
small.pt     922.29
tiny.pt      144.10

  Or download with the correct name directly:
  # Download and name correctly in one step
  Invoke-WebRequest -Uri "https://huggingface.co/openai/whisper-tiny/resolve/main/pytorch_model.bin" -OutFile "tiny.pt"
  Invoke-WebRequest -Uri "https://huggingface.co/openai/whisper-base/resolve/main/pytorch_model.bin" -OutFile "base.pt"
  Invoke-WebRequest -Uri "https://huggingface.co/openai/whisper-small/resolve/main/pytorch_model.bin" -OutFile "small.pt"
  
  Invoke-WebRequest -Uri "https://huggingface.co/openai/whisper-medium/resolve/main/pytorch_model.bin" -OutFile "medium.pt"
  Invoke-WebRequest -Uri "https://huggingface.co/openai/whisper-large-v2/resolve/main/pytorch_model.bin" -OutFile "large-v2.pt"

## 📁 File Structure After Download

```
python-embedded/
├── models/
│   ├── tiny.pt              (or pytorch_model.bin renamed)
│   ├── base.pt
│   ├── small.pt
│   ├── medium.pt
│   ├── large-v2.pt
│   └── manifest.json        (auto-generated)
├── python.exe
├── Lib/
└── whisper_service.py
```

## 🔧 Manual Download Steps

### Step 1: Create Directory
```bash
# If python-embedded doesn't exist yet
npm run prepare:python:ps

# Create models directory
mkdir python-embedded\models
```

### Step 2: Download Models

**Option A: Using Browser**
1. Right-click each URL above → "Save Link As"
2. Save to `python-embedded\models\` 
3. Rename if needed:
   - `pytorch_model.bin` → `tiny.pt`, `base.pt`, etc.

**Option B: Using PowerShell**
```powershell
cd python-embedded\models

# Download tiny model
Invoke-WebRequest -Uri "https://huggingface.co/openai/whisper-tiny/resolve/main/pytorch_model.bin" -OutFile "tiny.pt"

# Download base model  
Invoke-WebRequest -Uri "https://huggingface.co/openai/whisper-base/resolve/main/pytorch_model.bin" -OutFile "base.pt"

# Download small model
Invoke-WebRequest -Uri "https://huggingface.co/openai/whisper-small/resolve/main/pytorch_model.bin" -OutFile "small.pt"

# Download medium model
Invoke-WebRequest -Uri "https://huggingface.co/openai/whisper-medium/resolve/main/pytorch_model.bin" -OutFile "medium.pt"

# Download large model
Invoke-WebRequest -Uri "https://huggingface.co/openai/whisper-large-v2/resolve/main/pytorch_model.bin" -OutFile "large-v2.pt"
```

**Option C: Using curl**
```bash
cd python-embedded/models

curl -L "https://huggingface.co/openai/whisper-tiny/resolve/main/pytorch_model.bin" -o tiny.pt
curl -L "https://huggingface.co/openai/whisper-base/resolve/main/pytorch_model.bin" -o base.pt
curl -L "https://huggingface.co/openai/whisper-small/resolve/main/pytorch_model.bin" -o small.pt
curl -L "https://huggingface.co/openai/whisper-medium/resolve/main/pytorch_model.bin" -o medium.pt
curl -L "https://huggingface.co/openai/whisper-large-v2/resolve/main/pytorch_model.bin" -o large-v2.pt
```

### Step 3: Verify Downloads
```bash
# Check file sizes
ls -la python-embedded\models\

# Expected sizes:
# tiny.pt: ~39MB
# base.pt: ~74MB  
# small.pt: ~244MB
# medium.pt: ~769MB
# large-v2.pt: ~1550MB
```

## 🎯 Recommended Download Order

1. **Start with tiny** (~39MB) - Test the system works
2. **Add base** (~74MB) - Good general purpose model
3. **Add small** (~244MB) - Better accuracy
4. **Add medium/large** - Only if you need maximum accuracy

## ⚡ Performance Comparison

| Model | Speed | Accuracy | Use Case |
|-------|-------|----------|----------|
| **tiny** | Fastest | Basic | Real-time, quick notes |
| **base** | Fast | Good | General transcription |
| **small** | Medium | Better | Important documents |
| **medium** | Slow | High | Professional transcription |
| **large** | Slowest | Best | Critical accuracy needed |

## 🔧 Troubleshooting

### "Model not found" error
- Check file names match exactly: `tiny.pt`, `base.pt`, etc.
- Ensure files are in `python-embedded\models\` directory
- Check file sizes match expected values

### "Invalid model" error
- Re-download the model file
- Try the alternative download URL (Hugging Face vs OpenAI)
- Check file wasn't corrupted during download

### Download too slow
- Use Hugging Face URLs (usually faster)
- Use a download manager for large files
- Download during off-peak hours

## 🚀 After Manual Download

Once you've manually downloaded the models:

```bash
# Build portable app with your models
npm run pack:portable

# Your app will now be 100% offline!
```

The portable app will include:
- ✅ Python runtime (~1.7GB)
- ✅ Your downloaded models (~2.7GB total)
- ✅ Complete offline operation
- ✅ No internet required EVER

## 📊 Download Time Estimates

**With good internet (50 Mbps):**
- tiny: ~10 seconds
- base: ~15 seconds
- small: ~40 seconds  
- medium: ~2 minutes
- large: ~5 minutes
- **Total: ~8 minutes**

**With slower internet (10 Mbps):**
- All models: ~30-40 minutes

Much faster than the automated script! 🎉