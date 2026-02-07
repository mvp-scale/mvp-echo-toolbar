# 🚀 Quick Start - Manual Model Setup

**Skip slow downloads! Set up MVP-Echo with manual model downloads for maximum speed.**

## ⚡ Fast Setup (Recommended)

### Step 1: Prepare Python Environment
```bash
npm run prepare:python:manual
```
This creates the Python environment but **skips model downloads**.

### Step 2: Download Models Manually

**Option A: Download tiny model only (fastest start)**
```powershell
# Create models directory if it doesn't exist
mkdir python-embedded\models

# Download just the tiny model (~39MB, ~10 seconds)
Invoke-WebRequest -Uri "https://huggingface.co/openai/whisper-tiny/resolve/main/pytorch_model.bin" -OutFile "python-embedded\models\tiny.pt"
```

**Option B: Download all models (complete offline)**
```powershell
cd python-embedded\models

# Download all models (~2.7GB total, ~10 minutes)
Invoke-WebRequest -Uri "https://huggingface.co/openai/whisper-tiny/resolve/main/pytorch_model.bin" -OutFile "tiny.pt"
Invoke-WebRequest -Uri "https://huggingface.co/openai/whisper-base/resolve/main/pytorch_model.bin" -OutFile "base.pt"
Invoke-WebRequest -Uri "https://huggingface.co/openai/whisper-small/resolve/main/pytorch_model.bin" -OutFile "small.pt"
Invoke-WebRequest -Uri "https://huggingface.co/openai/whisper-medium/resolve/main/pytorch_model.bin" -OutFile "medium.pt"
Invoke-WebRequest -Uri "https://huggingface.co/openai/whisper-large-v2/resolve/main/pytorch_model.bin" -OutFile "large-v2.pt"
```

### Step 3: Build Portable App
```bash
npm run pack:portable:manual
```

**Done!** Your portable app is ready in the `dist/` folder.

## 📁 What You Get

```
MVP-Echo-Portable.exe
├── Python Runtime (~1.7GB)
├── Your Downloaded Models (~39MB to 2.7GB)
└── Complete Offline Operation
```

## 🎯 Model Selection Guide

**Start Small, Scale Up:**

1. **tiny.pt** (~39MB) - Start here, test the system
2. **base.pt** (~74MB) - Add for better accuracy  
3. **small.pt** (~244MB) - Good for most use cases
4. **medium.pt** (~769MB) - High accuracy needs
5. **large-v2.pt** (~1550MB) - Maximum accuracy

## ⚡ Speed Comparison

| Approach | Time | Benefits |
|----------|------|----------|
| **Manual Download** | ~10 minutes | ✅ Faster, ✅ Controllable, ✅ Resumable |
| **Automated Script** | ~30-60 minutes | ❌ Slower, ❌ Can fail, ❌ Hard to resume |

## 🔧 Commands Summary

```bash
# 1. Prepare Python (skip model downloads)
npm run prepare:python:manual

# 2. Download models manually (see above)

# 3. Build portable app
npm run pack:portable:manual

# Alternative: Use existing models
npm run pack:portable:manual  # Uses any models you've already downloaded
```

## 📊 File Sizes

| Model | Size | Download Time* |
|-------|------|----------------|
| tiny.pt | 39MB | ~10 seconds |
| base.pt | 74MB | ~15 seconds |
| small.pt | 244MB | ~40 seconds |
| medium.pt | 769MB | ~2 minutes |
| large-v2.pt | 1550MB | ~5 minutes |

*With 50 Mbps connection

## 🎉 Benefits of Manual Setup

- ⚡ **Much Faster**: Direct downloads vs script overhead
- 🎯 **Choose What You Need**: Don't download all models if you only want tiny
- 🔄 **Resumable**: Browser downloads can be resumed if interrupted
- 📱 **Progress Visible**: See exact download progress
- 🛠️ **Debugging**: Easy to see what failed and retry specific models

## 🆘 Troubleshooting

**"Models directory not found"**
```bash
mkdir python-embedded\models
```

**"Model file invalid"**
- Re-download the file
- Check file size matches expected size
- Try alternative URL from the manual download guide

**"Python not prepared"**
```bash
npm run prepare:python:manual
```

## 🎯 Next Steps

After setup:
1. Test your portable app
2. Copy to USB drive or network location
3. Share with others - completely self-contained!

Your MVP-Echo is now **100% offline** and ready for air-gapped environments! 🚀