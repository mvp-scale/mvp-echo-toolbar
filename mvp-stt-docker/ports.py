"""
Hexagonal architecture ports for MVP-Bridge.

Ports define the interface contracts that adapters must implement.
The bridge (application core) depends only on these abstractions,
never on concrete adapter implementations.
"""

from abc import ABC, abstractmethod

import numpy as np


class ModelEngine(ABC):
    """
    Port for speech-to-text model engines.

    Any STT backend (WebSocket relay, subprocess, in-process library)
    must implement this interface to be usable by the bridge.
    """

    @abstractmethod
    async def transcribe(self, samples: np.ndarray, sample_rate: int) -> str:
        """
        Transcribe audio samples to text.

        Args:
            samples: Float32 numpy array of audio samples (mono).
            sample_rate: Sample rate in Hz (typically 16000).

        Returns:
            Transcribed text string. Empty string if no speech detected.

        Raises:
            RuntimeError: If the engine is not ready or transcription fails.
        """

    @abstractmethod
    async def load_model(self, model_id: str) -> None:
        """
        Load (or switch to) a specific model.

        Args:
            model_id: Identifier for the model to load (e.g. "parakeet-tdt-0.6b-v2-int8").

        Raises:
            FileNotFoundError: If the model files are not found.
            RuntimeError: If loading fails.
        """

    @abstractmethod
    async def unload_model(self) -> None:
        """
        Unload the currently loaded model, freeing resources.

        Safe to call even if no model is loaded.
        """

    @abstractmethod
    async def get_status(self) -> dict:
        """
        Return the current engine status.

        Returns:
            Dictionary with at least:
                - "model_id": str or None
                - "state": one of "loaded", "loading", "idle", "unloaded", "error"
        """

    @abstractmethod
    async def list_available(self) -> list[dict]:
        """
        List models available for loading.

        Returns:
            List of dicts, each with at least:
                - "id": model identifier string
                - "object": "model"
                - "owned_by": origin label (e.g. "local", "remote")
        """
