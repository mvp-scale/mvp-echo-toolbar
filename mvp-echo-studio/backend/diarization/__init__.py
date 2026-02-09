import os
import logging
from typing import List, Optional

import torch
from pydantic import BaseModel

logger = logging.getLogger(__name__)


class SpeakerSegment(BaseModel):
    start: float
    end: float
    speaker: str


class DiarizationResult(BaseModel):
    segments: List[SpeakerSegment]
    num_speakers: int


class Diarizer:
    """Speaker diarization using pyannote.audio"""

    def __init__(self, access_token: Optional[str] = None):
        self.pipeline = None
        self.access_token = access_token
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self._initialize()

    def _initialize(self):
        try:
            from pyannote.audio import Pipeline

            if not self.access_token:
                self.access_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_ACCESS_TOKEN")

            if not self.access_token:
                logger.error("No HuggingFace token available. Diarization disabled.")
                return

            self.pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                use_auth_token=self.access_token,
            )
            self.pipeline.to(torch.device(self.device))
            logger.info(f"Diarization pipeline initialized on {self.device}")

        except ImportError:
            logger.error("pyannote.audio not installed")
        except Exception as e:
            logger.error(f"Failed to init diarization: {e}")

    def diarize(self, audio_path: str, num_speakers: Optional[int] = None) -> DiarizationResult:
        if self.pipeline is None:
            return DiarizationResult(segments=[], num_speakers=0)

        try:
            diarization = self.pipeline(audio_path, num_speakers=num_speakers)
            segments = []
            speakers = set()

            for turn, _, speaker in diarization.itertracks(yield_label=True):
                speaker_id = speaker if isinstance(speaker, str) and speaker.startswith("SPEAKER_") else f"SPEAKER_{speaker}"
                segments.append(SpeakerSegment(
                    start=turn.start, end=turn.end, speaker=f"speaker_{speaker_id}"
                ))
                speakers.add(speaker_id)

            segments.sort(key=lambda x: x.start)
            return DiarizationResult(segments=segments, num_speakers=len(speakers))

        except Exception as e:
            logger.error(f"Diarization failed: {e}")
            return DiarizationResult(segments=[], num_speakers=0)

    def merge_with_transcription(self, diarization: DiarizationResult, transcription_segments: list) -> list:
        if not diarization.segments:
            return transcription_segments

        for segment in transcription_segments:
            overlapping = []
            for spk in diarization.segments:
                overlap_start = max(segment.start, spk.start)
                overlap_end = min(segment.end, spk.end)
                if overlap_end > overlap_start:
                    overlapping.append((spk.speaker, overlap_end - overlap_start))

            if overlapping:
                overlapping.sort(key=lambda x: x[1], reverse=True)
                segment.speaker = overlapping[0][0]
            else:
                segment.speaker = "unknown"

        return transcription_segments
