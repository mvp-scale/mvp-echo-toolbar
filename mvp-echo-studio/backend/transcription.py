import logging
from typing import List, Optional, Tuple

import torch
import soundfile as sf

from models import WhisperSegment

logger = logging.getLogger(__name__)


def load_model(model_id: str = "nvidia/parakeet-tdt-0.6b-v2"):
    """Load the NeMo Parakeet-TDT ASR model."""
    try:
        import nemo.collections.asr as nemo_asr

        logger.info(f"Loading model {model_id}")
        model = nemo_asr.models.ASRModel.from_pretrained(model_name=model_id)

        if torch.cuda.is_available():
            model = model.cuda()
            logger.info(f"Model loaded on GPU: {torch.cuda.get_device_name(0)}")
        else:
            logger.warning("CUDA not available, running on CPU")

        model.eval()
        return model
    except Exception as e:
        logger.error(f"Error loading model: {e}")
        raise


def _format_timestamp(seconds: float, always_include_hours: bool = False,
                      decimal_marker: str = ".") -> str:
    hours = int(seconds / 3600)
    seconds = seconds % 3600
    minutes = int(seconds / 60)
    seconds = seconds % 60

    hours_marker = f"{hours:02d}:" if always_include_hours or hours > 0 else ""
    return f"{hours_marker}{minutes:02d}:{seconds:06.3f}".replace(".", decimal_marker) \
        if decimal_marker == "," else f"{hours_marker}{minutes:02d}:{seconds:06.3f}"


def format_srt(segments: List[WhisperSegment]) -> str:
    srt = ""
    for i, seg in enumerate(segments):
        start = _format_timestamp(seg.start, always_include_hours=True, decimal_marker=",")
        end = _format_timestamp(seg.end, always_include_hours=True, decimal_marker=",")
        text = seg.text.strip().replace("-->", "->")
        speaker = f"[{seg.speaker}] " if seg.speaker else ""
        srt += f"{i + 1}\n{start} --> {end}\n{speaker}{text}\n\n"
    return srt.strip()


def format_vtt(segments: List[WhisperSegment]) -> str:
    vtt = "WEBVTT\n\n"
    for seg in segments:
        start = _format_timestamp(seg.start, always_include_hours=True)
        end = _format_timestamp(seg.end, always_include_hours=True)
        text = seg.text.strip()
        speaker = f"<v {seg.speaker}>" if seg.speaker else ""
        vtt += f"{start} --> {end}\n{speaker}{text}\n\n"
    return vtt.strip()


def _get_audio_duration(audio_path: str) -> float:
    """Get audio duration in seconds using soundfile."""
    try:
        info = sf.info(audio_path)
        return info.duration
    except Exception:
        return 0.0


def transcribe_audio_chunk(model, audio_path: str, language: Optional[str] = None,
                           word_timestamps: bool = False) -> Tuple[str, List[WhisperSegment]]:
    """Transcribe a single audio chunk using NeMo ASR.

    Uses the model card API:
        output = model.transcribe([path], timestamps=True)
        output[0].timestamp['segment']  ->  [{'start': 0.0, 'end': 1.5, 'segment': 'Hello'}, ...]
    """
    try:
        audio_duration = _get_audio_duration(audio_path)

        with torch.no_grad():
            output = model.transcribe([audio_path], timestamps=True)

        if not output:
            logger.warning(f"No transcription for {audio_path}")
            return "", []

        result = output[0]
        text = result.text if hasattr(result, "text") else str(result)

        if not text or not text.strip():
            return "", []

        segments = []

        # Extract segment timestamps (per model card: result.timestamp['segment'])
        if hasattr(result, "timestamp") and result.timestamp and "segment" in result.timestamp:
            for i, stamp in enumerate(result.timestamp["segment"]):
                seg_text = stamp.get("segment", "")
                if seg_text:
                    segments.append(WhisperSegment(
                        id=i,
                        start=stamp["start"],
                        end=stamp["end"],
                        text=seg_text,
                    ))

        if segments:
            logger.info(f"Transcribed with {len(segments)} timestamped segments")
            return text, segments

        # No segment timestamps available - single segment for whole chunk
        logger.info(f"Transcribed (no segment timestamps): {len(text)} chars")
        segments = [WhisperSegment(id=0, start=0.0, end=audio_duration, text=text)]
        return text, segments

    except Exception as e:
        logger.error(f"Error transcribing chunk: {e}", exc_info=True)
        return "", []
