"""
Sherpa-ONNX ASR Server — OpenAI-compatible HTTP endpoint for Parakeet TDT.

Accepts POST /v1/audio/transcriptions (multipart form-data with audio file)
and returns JSON compatible with the faster-whisper-server response format.

Converts incoming audio (WebM, MP3, OGG, etc.) to 16kHz mono WAV via ffmpeg,
then feeds it to sherpa-onnx OfflineRecognizer with Parakeet TDT 0.6B model.
"""

import os
import subprocess
import tempfile
import time

import sherpa_onnx
import soundfile as sf
import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

# ── Configuration ──

MODEL_DIR = os.environ.get("MODEL_DIR", "/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "8000"))
NUM_THREADS = int(os.environ.get("NUM_THREADS", "4"))
PROVIDER = os.environ.get("PROVIDER", "cuda")  # "cuda" or "cpu"


def resolve_model_path(base_name: str) -> str:
    """Pick int8 variant if present, otherwise float32."""
    int8 = os.path.join(MODEL_DIR, base_name.replace(".onnx", ".int8.onnx"))
    fp32 = os.path.join(MODEL_DIR, base_name)
    return int8 if os.path.exists(int8) else fp32


def create_recognizer():
    """Create and return a sherpa-onnx OfflineRecognizer configured for Parakeet TDT."""
    enc = resolve_model_path("encoder.onnx")
    dec = resolve_model_path("decoder.onnx")
    joi = resolve_model_path("joiner.onnx")
    tok = os.path.join(MODEL_DIR, "tokens.txt")

    print(f"[sherpa-server] Creating recognizer:")
    print(f"  Encoder: {enc}")
    print(f"  Decoder: {dec}")
    print(f"  Joiner:  {joi}")
    print(f"  Tokens:  {tok}")
    print(f"  Provider: {PROVIDER}")
    print(f"  Threads:  {NUM_THREADS}")

    config = sherpa_onnx.OfflineRecognizerConfig(
        feat_config=sherpa_onnx.FeatureExtractorConfig(
            sample_rate=16000,
            feature_dim=80,
        ),
        model_config=sherpa_onnx.OfflineModelConfig(
            transducer=sherpa_onnx.OfflineTransducerModelConfig(
                encoder=enc,
                decoder=dec,
                joiner=joi,
            ),
            tokens=tok,
            num_threads=NUM_THREADS,
            provider=PROVIDER,
            model_type="nemo_transducer",
        ),
    )

    recognizer = sherpa_onnx.OfflineRecognizer(config)
    print("[sherpa-server] Recognizer created successfully")
    return recognizer


def convert_to_wav(input_path: str, output_path: str) -> bool:
    """Convert any audio format to 16kHz mono 16-bit WAV using ffmpeg."""
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", input_path,
                "-ar", "16000",
                "-ac", "1",
                "-sample_fmt", "s16",
                "-f", "wav",
                output_path,
            ],
            capture_output=True,
            timeout=30,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False


# ── App Setup ──

app = FastAPI(title="Sherpa-ONNX ASR Server", version="1.0.0")
recognizer = None


@app.on_event("startup")
def startup():
    global recognizer
    print(f"[sherpa-server] Starting on port {LISTEN_PORT}")
    print(f"[sherpa-server] Model directory: {MODEL_DIR}")
    recognizer = create_recognizer()
    print("[sherpa-server] Ready to accept requests")


# ── Endpoints ──

@app.get("/health")
def health():
    """Health check endpoint."""
    return JSONResponse({"status": "ok"})


@app.get("/v1/models")
def list_models():
    """List available models (OpenAI-compatible)."""
    model_name = os.path.basename(MODEL_DIR)
    return JSONResponse({
        "data": [
            {
                "id": model_name,
                "object": "model",
                "owned_by": "local",
            }
        ]
    })


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(default=""),
    language: str = Form(default="en"),
    response_format: str = Form(default="verbose_json"),
    temperature: str = Form(default="0"),
    # Accept but ignore faster-whisper-specific params for compatibility
    vad_filter: str = Form(default=""),
    condition_on_previous_text: str = Form(default=""),
    hallucination_silence_threshold: str = Form(default=""),
    log_prob_threshold: str = Form(default=""),
    compression_ratio_threshold: str = Form(default=""),
    no_speech_threshold: str = Form(default=""),
    beam_size: str = Form(default=""),
    repetition_penalty: str = Form(default=""),
):
    """
    OpenAI-compatible transcription endpoint.

    Accepts multipart form-data with an audio file (WebM, WAV, MP3, OGG, etc.).
    Returns transcription in the requested format.
    """
    start_time = time.time()

    # Save uploaded audio to temp file
    suffix = os.path.splitext(file.filename or "audio.webm")[1] or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp_input:
        content = await file.read()
        tmp_input.write(content)
        tmp_input_path = tmp_input.name

    wav_path = None
    try:
        # Convert to WAV (16kHz mono)
        wav_path = tmp_input_path + ".wav"
        if not convert_to_wav(tmp_input_path, wav_path):
            return JSONResponse(
                status_code=400,
                content={"error": "Failed to convert audio. Ensure ffmpeg is installed."},
            )

        # Read WAV file
        samples, sample_rate = sf.read(wav_path, dtype="float32")

        # Ensure mono
        if len(samples.shape) > 1:
            samples = samples[:, 0]

        audio_duration = len(samples) / sample_rate

        # Transcribe
        stream = recognizer.create_stream()
        stream.accept_waveform(sample_rate, samples)
        recognizer.decode(stream)
        text = stream.result.text.strip()

        processing_time = time.time() - start_time

        print(
            f"[sherpa-server] Transcribed {audio_duration:.1f}s audio "
            f"in {processing_time:.2f}s (RTF={processing_time/audio_duration:.2f}): "
            f'"{text[:80]}{"..." if len(text) > 80 else ""}"'
        )

        # Build response matching faster-whisper-server format
        if response_format == "verbose_json":
            return JSONResponse({
                "text": text,
                "language": language,
                "duration": round(audio_duration, 2),
                "segments": [
                    {
                        "id": 0,
                        "start": 0.0,
                        "end": round(audio_duration, 2),
                        "text": text,
                        "no_speech_prob": 0.0,
                    }
                ],
            })
        elif response_format == "json":
            return JSONResponse({"text": text})
        else:
            # Plain text
            return text

    except Exception as e:
        print(f"[sherpa-server] Error: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": str(e)},
        )
    finally:
        # Clean up temp files
        for p in [tmp_input_path, wav_path]:
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=LISTEN_PORT)
