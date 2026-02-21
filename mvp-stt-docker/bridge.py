"""
MVP-Bridge -- Hexagonal HTTP bridge for sherpa-onnx ASR.

Accepts POST /v1/audio/transcriptions (OpenAI-compatible multipart form-data),
converts audio to float32 samples, delegates to the active ModelEngine adapter,
and returns the transcription as JSON.

Adapter selection (via ADAPTER_TYPE env var):
    "subprocess" (default)    -- manages sherpa-onnx as a child process
    "websocket"               -- relays to an external C++ WebSocket server
    "managed-websocket"       -- manages a sherpa-onnx WebSocket server subprocess
"""

import logging
import os
import subprocess
import tempfile
import time

import numpy as np
import soundfile as sf
import uvicorn
from contextlib import asynccontextmanager
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ports import ModelEngine
from adapters import SubprocessAdapter, WebSocketAdapter, ManagedWebSocketAdapter

# -- Logging --

LOG_FORMAT = "%(asctime)s [%(name)s] %(levelname)s  %(message)s"
LOG_DATEFMT = "%Y-%m-%d %H:%M:%S"

logging.basicConfig(format=LOG_FORMAT, datefmt=LOG_DATEFMT, level=logging.INFO)
log = logging.getLogger("mvp-bridge")

# -- Model Metadata --

MODEL_METADATA = {
    "parakeet-tdt-0.6b-v2-int8": {"label": "English", "group": "gpu"},
    "parakeet-tdt-0.6b-v3-int8": {"label": "Multilingual", "group": "gpu"},
}

# -- Configuration --

ADAPTER_TYPE = os.environ.get("ADAPTER_TYPE", "subprocess")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "8000"))


# -- Audio Utilities --

def convert_to_wav(input_path: str, output_path: str) -> bool:
    """Convert any audio format to 16kHz mono 16-bit WAV using ffmpeg."""
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
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


# -- Adapter Factory --

def create_engine(adapter_type: str) -> ModelEngine:
    """
    Instantiate the appropriate ModelEngine adapter.

    Args:
        adapter_type: One of "subprocess" or "websocket".

    Returns:
        A ModelEngine implementation ready for use.

    Raises:
        ValueError: If the adapter type is not recognized.
    """
    if adapter_type == "subprocess":
        return SubprocessAdapter()
    elif adapter_type == "websocket":
        return WebSocketAdapter()
    elif adapter_type == "managed-websocket":
        return ManagedWebSocketAdapter()
    else:
        raise ValueError(
            f"Unknown ADAPTER_TYPE: '{adapter_type}'. "
            "Valid options: 'subprocess', 'websocket', 'managed-websocket'"
        )


# -- Request/Response Models --

class ModelSwitchRequest(BaseModel):
    model_id: str


# -- Application --

engine: ModelEngine = create_engine(ADAPTER_TYPE)


@asynccontextmanager
async def lifespan(application: FastAPI):
    """Application startup and shutdown lifecycle."""
    log.info("Starting on port %d", LISTEN_PORT)
    log.info("Adapter: %s", ADAPTER_TYPE)

    # Auto-load default model for adapters that manage their own model lifecycle
    if ADAPTER_TYPE in ("subprocess", "managed-websocket"):
        default_model = os.environ.get(
            "DEFAULT_MODEL", "parakeet-tdt-0.6b-v2-int8"
        )
        try:
            await engine.load_model(default_model)
            log.info("Default model loaded: %s", default_model)
        except Exception as e:
            log.warning("Failed to load default model: %s", e)
            log.warning("Server will start but transcription will fail until a model is loaded.")
    elif ADAPTER_TYPE == "websocket":
        ws_host = os.environ.get("WS_HOST", "mvp-asr")
        ws_port = os.environ.get("WS_PORT", "6006")
        log.info("WebSocket backend: ws://%s:%s", ws_host, ws_port)

    log.info("Ready to accept requests")
    yield
    log.info("Shutting down")
    await engine.unload_model()


app = FastAPI(title="MVP-Bridge", version="3.0.0", lifespan=lifespan)


# -- Endpoints --

@app.get("/health")
async def health():
    """Health check -- reports engine status."""
    status = await engine.get_status()
    response = {
        "status": "ok" if status.get("state") == "loaded" else "degraded",
        "engine": status,
    }
    return JSONResponse(response)


@app.get("/v1/models")
async def list_models():
    """List available models (OpenAI-compatible)."""
    available = await engine.list_available()
    status = await engine.get_status()
    loaded_id = status.get("model_id")

    # Mark which model is currently loaded and add metadata
    for model in available:
        model["active"] = model["id"] == loaded_id
        meta = MODEL_METADATA.get(model["id"], {})
        model["label"] = meta.get("label", model["id"])
        model["group"] = meta.get("group", "gpu")

    return JSONResponse({"data": available})


@app.post("/v1/models/switch")
async def switch_model(request: ModelSwitchRequest):
    """Switch to a different model."""
    model_id = request.model_id

    # Check if model is available
    available = await engine.list_available()
    available_ids = [m["id"] for m in available]

    if model_id not in available_ids:
        return JSONResponse(
            status_code=404,
            content={
                "error": f"Model '{model_id}' not found.",
                "available": available_ids,
            },
        )

    try:
        await engine.load_model(model_id)
        status = await engine.get_status()
        return JSONResponse({
            "status": "ok",
            "message": f"Switched to model: {model_id}",
            "engine": status,
        })
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Failed to switch model: {e}"},
        )


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(default=""),
    language: str = Form(default="en"),
    response_format: str = Form(default="verbose_json"),
    temperature: str = Form(default="0"),
    # Accept Whisper-specific params for backward compatibility
    vad_filter: str = Form(default=""),
    condition_on_previous_text: str = Form(default=""),
    hallucination_silence_threshold: str = Form(default=""),
    log_prob_threshold: str = Form(default=""),
    compression_ratio_threshold: str = Form(default=""),
    no_speech_threshold: str = Form(default=""),
    beam_size: str = Form(default=""),
    repetition_penalty: str = Form(default=""),
):
    """OpenAI-compatible transcription endpoint."""
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

        # Read WAV as float32 samples
        samples, sample_rate = sf.read(wav_path, dtype="float32")

        # Ensure mono
        if len(samples.shape) > 1:
            samples = samples[:, 0]

        audio_duration = len(samples) / sample_rate

        # Transcribe via the active engine adapter
        text = await engine.transcribe(samples.astype(np.float32), sample_rate)

        processing_time = time.time() - start_time

        rtf = processing_time / audio_duration if audio_duration > 0 else 0
        log.info(
            'Transcribed %.1fs audio in %.2fs (RTF=%.2f): "%s"',
            audio_duration,
            processing_time,
            rtf,
            text[:80] + ("..." if len(text) > 80 else ""),
        )

        # Build response matching OpenAI verbose_json format
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
            return text

    except Exception as e:
        log.error("%s: %s", type(e).__name__, e)
        return JSONResponse(
            status_code=500,
            content={"error": str(e)},
        )
    finally:
        for p in [tmp_input_path, wav_path]:
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=LISTEN_PORT)
