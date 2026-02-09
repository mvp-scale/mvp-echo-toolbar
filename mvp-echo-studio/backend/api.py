import os
import logging
from typing import List, Optional
from pathlib import Path

from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, FileResponse
import torch

from models import WhisperSegment, TranscriptionResponse, ModelInfo, ModelList
from audio import convert_audio_to_wav, split_audio_into_chunks
from transcription import load_model, format_srt, format_vtt, transcribe_audio_chunk
from diarization import Diarizer
from config import get_config
from auth import AuthMiddleware

logger = logging.getLogger(__name__)

asr_model = None
diarizer_instance = None
config = get_config()


def create_app() -> FastAPI:
    app = FastAPI(title="MVP-Echo Studio")

    # Auth middleware (LAN bypass + Bearer token)
    app.add_middleware(AuthMiddleware)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.on_event("startup")
    async def startup_event():
        global asr_model, diarizer_instance

        try:
            if torch.cuda.is_available():
                logger.info(f"CUDA available: {torch.cuda.get_device_name(0)}")
            else:
                logger.warning("CUDA not available, using CPU")

            asr_model = load_model(config.model_id)
            logger.info(f"Model {config.model_id} loaded")

            # Initialize diarizer once at startup (pipeline load is slow)
            hf_token = config.get_hf_token()
            if hf_token:
                logger.info("Initializing diarization pipeline...")
                diarizer_instance = Diarizer(access_token=hf_token)
                logger.info("Diarization pipeline ready")
            else:
                logger.info("No HF token, diarization disabled")

        except Exception as e:
            logger.error(f"Startup error: {e}")

    @app.post("/v1/audio/transcriptions")
    async def transcribe_audio(
        file: UploadFile = File(...),
        model: str = Form("whisper-1"),
        language: Optional[str] = Form(None),
        prompt: Optional[str] = Form(None),
        response_format: str = Form("json"),
        temperature: float = Form(0.0),
        timestamps: bool = Form(False),
        vad_filter: bool = Form(False),
        word_timestamps: bool = Form(False),
        diarize: bool = Form(True),
        include_diarization_in_text: Optional[bool] = Form(None),
    ):
        global asr_model, diarizer_instance

        if not asr_model:
            raise HTTPException(status_code=503, detail="Model not loaded yet")

        filename = file.filename or "audio"
        logger.info(f"Transcription: {filename}, format={response_format}, diarize={diarize}")

        try:
            temp_dir = Path(config.temp_dir)
            temp_dir.mkdir(parents=True, exist_ok=True)

            suffix = Path(filename).suffix or ".wav"
            temp_file = temp_dir / f"upload_{os.urandom(8).hex()}{suffix}"
            with open(temp_file, "wb") as f:
                content = await file.read()
                f.write(content)

            wav_file = convert_audio_to_wav(str(temp_file))
            audio_chunks = split_audio_into_chunks(wav_file, chunk_duration=config.chunk_duration)

            # Diarization (uses pre-loaded pipeline)
            diarization_result = None
            if diarize and diarizer_instance and diarizer_instance.pipeline:
                logger.info("Running speaker diarization")
                diarization_result = diarizer_instance.diarize(wav_file)
                logger.info(f"Found {diarization_result.num_speakers} speakers")

            # Transcribe chunks
            all_text = []
            all_segments = []

            for i, chunk_path in enumerate(audio_chunks):
                logger.info(f"Processing chunk {i + 1}/{len(audio_chunks)}")
                chunk_text, chunk_segments = transcribe_audio_chunk(
                    asr_model, chunk_path, language=language, word_timestamps=word_timestamps
                )

                if i > 0:
                    offset = i * config.chunk_duration
                    for seg in chunk_segments:
                        seg.start += offset
                        seg.end += offset

                all_text.append(chunk_text)
                all_segments.extend(chunk_segments)

            full_text = " ".join(all_text)

            # Merge diarization
            if diarizer_instance and diarization_result and diarization_result.segments:
                all_segments = diarizer_instance.merge_with_transcription(diarization_result, all_segments)

                use_in_text = include_diarization_in_text if include_diarization_in_text is not None else config.include_diarization_in_text

                if use_in_text:
                    previous_speaker = None
                    seen = set()
                    for seg in all_segments:
                        if seg.speaker and seg.speaker.startswith("speaker_"):
                            parts = seg.speaker.split("_")
                            try:
                                num = int(parts[-1]) + 1
                                if seg.speaker != previous_speaker:
                                    prefix = f"Speaker {num}: " if seg.speaker not in seen else f"{num}: "
                                    seen.add(seg.speaker)
                                    seg.text = f"{prefix}{seg.text}"
                                previous_speaker = seg.speaker
                            except (ValueError, IndexError):
                                pass

                    full_text = " ".join(seg.text for seg in all_segments)

            # Compute duration from audio (last segment end time)
            duration = all_segments[-1].end if all_segments else 0.0

            response = TranscriptionResponse(
                text=full_text,
                segments=all_segments if timestamps or response_format == "verbose_json" else None,
                language=language,
                duration=duration,
                model="parakeet-tdt-0.6b-v2",
            )

            # Cleanup
            if os.path.exists(temp_file):
                os.unlink(temp_file)
            if wav_file != str(temp_file) and os.path.exists(wav_file):
                os.unlink(wav_file)
            for chunk in audio_chunks:
                if chunk != wav_file and os.path.exists(chunk):
                    os.unlink(chunk)

            if response_format == "json":
                return response.dict()
            elif response_format == "text":
                return PlainTextResponse(full_text)
            elif response_format == "srt":
                return PlainTextResponse(format_srt(all_segments))
            elif response_format == "vtt":
                return PlainTextResponse(format_vtt(all_segments))
            elif response_format == "verbose_json":
                return response.dict()
            else:
                raise HTTPException(status_code=400, detail=f"Unsupported format: {response_format}")

        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Transcription error: {e}")
            raise HTTPException(status_code=500, detail=str(e))

    @app.get("/health")
    async def health_check():
        global asr_model, diarizer_instance
        gpu_mem = None
        if torch.cuda.is_available():
            gpu_mem = {
                "allocated_mb": round(torch.cuda.memory_allocated() / 1024 / 1024),
                "reserved_mb": round(torch.cuda.memory_reserved() / 1024 / 1024),
            }
        return {
            "status": "ok",
            "model_loaded": asr_model is not None,
            "model_id": config.model_id,
            "cuda_available": torch.cuda.is_available(),
            "gpu_name": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
            "gpu_memory": gpu_mem,
            "diarization_available": diarizer_instance is not None and diarizer_instance.pipeline is not None,
        }

    @app.get("/v1/models")
    async def list_models():
        return ModelList(data=[
            ModelInfo(
                id="whisper-1", created=1677649963, owned_by="parakeet",
                root="whisper-1", permission=[]
            )
        ])

    # Mount frontend static files (if built)
    static_dir = Path("/app/static").resolve()
    if static_dir.exists():
        @app.get("/{full_path:path}")
        async def serve_spa(full_path: str):
            file_path = (static_dir / full_path).resolve()
            # Prevent path traversal outside static directory
            if file_path.is_relative_to(static_dir) and file_path.is_file():
                return FileResponse(file_path)
            return FileResponse(static_dir / "index.html")

    return app
