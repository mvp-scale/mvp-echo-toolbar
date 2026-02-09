"""
MVP-Bridge — HTTP-to-WebSocket bridge for sherpa-onnx ASR server.

Accepts POST /v1/audio/transcriptions (OpenAI-compatible multipart form-data),
converts audio to float32 samples, sends to the C++ WebSocket server,
and returns the transcription as JSON.
"""

import asyncio
import json
import os
import struct
import subprocess
import tempfile
import time

import numpy as np
import soundfile as sf
import uvicorn
import websockets
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager

# ── Configuration ──

WS_HOST = os.environ.get("WS_HOST", "mvp-asr")
WS_PORT = int(os.environ.get("WS_PORT", "6006"))
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "8000"))


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


async def transcribe_via_ws(samples: np.ndarray, sample_rate: int) -> str:
    """Send audio to the sherpa-onnx WebSocket server and return transcription text."""
    uri = f"ws://{WS_HOST}:{WS_PORT}"

    async with websockets.connect(uri) as ws:
        # Build header: sample_rate (4 bytes LE) + audio_byte_count (4 bytes LE)
        header = struct.pack("<ii", sample_rate, samples.size * 4)
        buf = header + samples.tobytes()

        # Send in chunks
        chunk_size = 10240
        for start in range(0, len(buf), chunk_size):
            await ws.send(buf[start:start + chunk_size])

        # Receive transcription result
        result = await ws.recv()

        # Signal end of session
        await ws.send("Done")

    # C++ server returns JSON, Python server returns plain text
    try:
        parsed = json.loads(result)
        return parsed.get("text", "").strip()
    except (json.JSONDecodeError, TypeError):
        # Plain text response
        text = result.strip() if isinstance(result, str) else result.decode().strip()
        return "" if text == "<EMPTY>" else text


# ── App Setup ──

@asynccontextmanager
async def lifespan(application):
    print(f"[mvp-bridge] Starting on port {LISTEN_PORT}")
    print(f"[mvp-bridge] WebSocket backend: ws://{WS_HOST}:{WS_PORT}")
    print("[mvp-bridge] Ready to accept requests")
    yield


app = FastAPI(title="MVP-Bridge", version="1.0.0", lifespan=lifespan)


# ── Endpoints ──

@app.get("/health")
async def health():
    """Health check — also verifies WebSocket server is reachable."""
    try:
        async with websockets.connect(
            f"ws://{WS_HOST}:{WS_PORT}",
            close_timeout=3,
            open_timeout=3,
        ) as ws:
            await ws.send("Done")
        return JSONResponse({"status": "ok"})
    except Exception:
        return JSONResponse({"status": "ok", "backend": "unreachable"})


@app.get("/v1/models")
def list_models():
    """List available models (OpenAI-compatible)."""
    return JSONResponse({
        "data": [
            {
                "id": "parakeet-tdt-0.6b-v2-int8",
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

        # Transcribe via WebSocket
        text = await transcribe_via_ws(samples.astype(np.float32), sample_rate)

        processing_time = time.time() - start_time

        print(
            f"[mvp-bridge] Transcribed {audio_duration:.1f}s audio "
            f"in {processing_time:.2f}s (RTF={processing_time/audio_duration:.2f}): "
            f'"{text[:80]}{"..." if len(text) > 80 else ""}"'
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
        print(f"[mvp-bridge] Error: {e}")
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
