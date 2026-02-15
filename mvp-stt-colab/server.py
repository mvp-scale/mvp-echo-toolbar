"""
MVP-Echo STT Server -- Colab Edition

Streamlined OpenAI-compatible speech-to-text server using sherpa-onnx
with GPU acceleration. Designed to run on Google Colab's free T4 GPU.

No auth, no model switching -- just transcription.

Usage:
    python server.py

Environment variables:
    MODEL_DIR     Path to model directory
    PROVIDER      cuda or cpu (default: cuda)
    NUM_THREADS   CPU threads for non-GPU ops (default: 4)
    PORT          HTTP server port (default: 8000)
    WS_PORT       Internal WebSocket server port (default: 7100)
"""

import asyncio
import json
import os
import signal
import struct
import subprocess
import tempfile
import time

import numpy as np
import soundfile as sf
import uvicorn
import websockets
from contextlib import asynccontextmanager
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MODEL_DIR = os.environ.get(
    "MODEL_DIR",
    "/content/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
)
PROVIDER = os.environ.get("PROVIDER", "cuda")
NUM_THREADS = os.environ.get("NUM_THREADS", "4")
PORT = int(os.environ.get("PORT", "8000"))
WS_PORT = int(os.environ.get("WS_PORT", "7100"))

SHERPA_BIN = "sherpa-onnx-offline-websocket-server"

# Community API key -- the toolbar requires a key to connect.
# This is a well-known public key; it provides no real security.
# It exists solely so the toolbar's "Test Connection" flow succeeds.
COMMUNITY_API_KEY = "SK-COLAB-COMMUNITY"

# ---------------------------------------------------------------------------
# Sherpa-onnx process management
# ---------------------------------------------------------------------------

_process: asyncio.subprocess.Process | None = None


async def start_sherpa() -> None:
    """Start the sherpa-onnx C++ WebSocket server and wait for it to be ready."""
    global _process

    cmd = [
        SHERPA_BIN,
        f"--port={WS_PORT}",
        f"--provider={PROVIDER}",
        f"--encoder={MODEL_DIR}/encoder.int8.onnx",
        f"--decoder={MODEL_DIR}/decoder.int8.onnx",
        f"--joiner={MODEL_DIR}/joiner.int8.onnx",
        f"--tokens={MODEL_DIR}/tokens.txt",
        f"--num-threads={NUM_THREADS}",
        "--max-utterance-length=600",
    ]

    print(f"[server] Starting: {' '.join(cmd)}")

    _process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    # Wait for the WebSocket server to accept connections
    for attempt in range(60):
        if _process.returncode is not None:
            stderr = ""
            if _process.stderr:
                try:
                    raw = await asyncio.wait_for(_process.stderr.read(4096), 1.0)
                    stderr = raw.decode(errors="replace")
                except asyncio.TimeoutError:
                    pass
            raise RuntimeError(
                f"sherpa-onnx exited with code {_process.returncode}: {stderr}"
            )
        try:
            async with websockets.connect(
                f"ws://localhost:{WS_PORT}", close_timeout=2, open_timeout=2
            ) as ws:
                await ws.send("Done")
            print(f"[server] sherpa-onnx ready (PID={_process.pid}, provider={PROVIDER})")
            return
        except Exception:
            await asyncio.sleep(0.5)

    raise RuntimeError("sherpa-onnx failed to start within 30 seconds")


async def stop_sherpa() -> None:
    """Gracefully stop the sherpa-onnx subprocess."""
    global _process
    if _process is None:
        return

    if _process.returncode is not None:
        _process = None
        return

    print(f"[server] Stopping sherpa-onnx (PID={_process.pid})")
    try:
        _process.send_signal(signal.SIGTERM)
        await asyncio.wait_for(_process.wait(), timeout=5.0)
    except (ProcessLookupError, asyncio.TimeoutError):
        try:
            _process.kill()
        except ProcessLookupError:
            pass
    _process = None


# ---------------------------------------------------------------------------
# Audio utilities
# ---------------------------------------------------------------------------

def convert_to_wav(input_path: str, output_path: str) -> bool:
    """Convert any audio format to 16kHz mono WAV using ffmpeg."""
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-i", input_path,
                "-ar", "16000", "-ac", "1",
                "-sample_fmt", "s16", "-f", "wav",
                output_path,
            ],
            capture_output=True,
            timeout=30,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False


async def transcribe_samples(samples: np.ndarray, sample_rate: int) -> str:
    """Send audio to sherpa-onnx WebSocket server and return transcription."""
    async with websockets.connect(f"ws://localhost:{WS_PORT}") as ws:
        header = struct.pack("<ii", sample_rate, samples.size * 4)
        buf = header + samples.tobytes()

        chunk_size = 10240
        for start in range(0, len(buf), chunk_size):
            await ws.send(buf[start : start + chunk_size])

        result = await ws.recv()
        await ws.send("Done")

    try:
        parsed = json.loads(result)
        return parsed.get("text", "").strip()
    except (json.JSONDecodeError, TypeError):
        text = result.strip() if isinstance(result, str) else result.decode().strip()
        return "" if text == "<EMPTY>" else text


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(application: FastAPI):
    await start_sherpa()
    print(f"[server] Ready -- POST /v1/audio/transcriptions")
    yield
    await stop_sherpa()
    print("[server] Shut down")


app = FastAPI(title="MVP-Echo STT (Colab)", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _check_auth(request: Request) -> bool:
    """Validate the Bearer token. Accepts the community key or any non-empty key."""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        return False
    token = auth[7:].strip()
    return len(token) > 0


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": os.path.basename(MODEL_DIR),
        "provider": PROVIDER,
        "gpu": PROVIDER == "cuda",
    }


@app.get("/v1/models")
async def list_models(request: Request):
    """List available models -- toolbar calls this to test the connection."""
    if not _check_auth(request):
        return JSONResponse(
            status_code=401,
            content={"error": "Invalid or missing API key. Use: SK-COLAB-COMMUNITY"},
        )
    model_id = os.path.basename(MODEL_DIR)
    # Strip common prefix for a clean ID
    for prefix in ("sherpa-onnx-nemo-", "sherpa-onnx-"):
        if model_id.startswith(prefix):
            model_id = model_id[len(prefix):]
            break
    return JSONResponse({
        "data": [
            {
                "id": model_id,
                "object": "model",
                "owned_by": "colab",
                "label": "English",
                "group": "gpu",
                "active": True,
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
):
    """OpenAI-compatible transcription endpoint."""
    start_time = time.time()

    suffix = os.path.splitext(file.filename or "audio.webm")[1] or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name

    wav_path = tmp_path + ".wav"
    try:
        if not convert_to_wav(tmp_path, wav_path):
            return JSONResponse(
                status_code=400,
                content={"error": "Audio conversion failed. Is ffmpeg installed?"},
            )

        samples, sample_rate = sf.read(wav_path, dtype="float32")
        if len(samples.shape) > 1:
            samples = samples[:, 0]

        audio_duration = len(samples) / sample_rate
        text = await transcribe_samples(samples.astype(np.float32), sample_rate)
        processing_time = time.time() - start_time

        rtf = processing_time / audio_duration if audio_duration > 0 else 0
        print(
            f"[server] {audio_duration:.1f}s audio in {processing_time:.2f}s "
            f"(RTF={rtf:.3f}): \"{text[:80]}{'...' if len(text) > 80 else ''}\""
        )

        if response_format == "verbose_json":
            return JSONResponse({
                "text": text,
                "language": language,
                "duration": round(audio_duration, 2),
                "segments": [{
                    "id": 0,
                    "start": 0.0,
                    "end": round(audio_duration, 2),
                    "text": text,
                    "no_speech_prob": 0.0,
                }],
            })
        elif response_format == "json":
            return JSONResponse({"text": text})
        else:
            return text

    except Exception as e:
        print(f"[server] Error: {e}")
        return JSONResponse(status_code=500, content={"error": str(e)})
    finally:
        for p in [tmp_path, wav_path]:
            try:
                os.unlink(p)
            except OSError:
                pass


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)
