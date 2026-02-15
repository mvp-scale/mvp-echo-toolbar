# MVP-Echo STT — Google Colab

Try MVP-Echo's speech-to-text engine on a free GPU. No local hardware required.

## What this is

A Google Colab notebook that spins up an OpenAI-compatible transcription API
backed by a T4 GPU. Meant for developers who want to test MVP-Echo without
a local NVIDIA GPU.

- **Model**: NVIDIA Parakeet TDT 0.6b v2 (INT8) — English
- **Engine**: [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) C++ with CUDA
- **Speed**: ~20-50x faster than real-time
- **VRAM**: ~426 MiB (T4 has 16 GB — plenty of headroom)
- **API**: OpenAI Whisper-compatible (`POST /v1/audio/transcriptions`)

## Quick start

1. Open the notebook in Google Colab:

   [![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/anthropics/mvp-echo-toolbar/blob/main/mvp-stt-colab/MVP_Echo_STT_Colab.ipynb)

   > Update the link above to point to your actual GitHub repo.

2. Set the runtime to **GPU** (Runtime → Change runtime type → T4 GPU)
3. Run all cells (Runtime → Run all)
4. Copy the public URL printed at the end
5. Use it with curl, the MVP-Echo toolbar, or any OpenAI-compatible client

## Connecting from MVP-Echo toolbar

The toolbar requires an API key to complete its connection test. Use the
community key:

```
SK-COLAB-COMMUNITY
```

1. Open toolbar **Settings**
2. Set **Server URL** to your Colab public URL
3. Set **API Key** to `SK-COLAB-COMMUNITY`
4. Click **Test Connection**

Any non-empty key will work — this isn't real security, it just satisfies
the toolbar's connection flow. This is a community testing resource.

## HuggingFace token (optional)

The model downloads from a public HuggingFace repo, so no token is strictly
needed. However, anonymous downloads can be rate-limited on busy days.

To add a token:
1. Create a free account at [huggingface.co](https://huggingface.co/join)
2. Go to [Settings → Access Tokens](https://huggingface.co/settings/tokens)
3. Create a new **Read** token
4. In Colab, click the **key icon** in the left sidebar → add a secret named
   `HF_TOKEN` with your token → toggle **Notebook access** on

The notebook will pick it up automatically.

## Limitations

- **Temporary**: Colab sessions shut down after ~90 min idle (free) or ~24 hr (Pro)
- **URL changes**: Each session gets a new public URL
- **Single user**: One inference stream — requests are processed sequentially
- **English only**: The default model is English. Multilingual (v3) can be swapped in

## Files

| File | Purpose |
|------|---------|
| `MVP_Echo_STT_Colab.ipynb` | The Colab notebook — open this in Colab |
| `server.py` | Standalone server script (same code the notebook runs) |

## Testing

```bash
# Health check
curl https://YOUR-URL.trycloudflare.com/health

# Transcribe (include the API key)
curl -X POST https://YOUR-URL.trycloudflare.com/v1/audio/transcriptions \
  -H "Authorization: Bearer SK-COLAB-COMMUNITY" \
  -F "file=@recording.wav" \
  -F "response_format=verbose_json"
```
