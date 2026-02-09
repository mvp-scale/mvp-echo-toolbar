import os
import logging
from typing import Dict, Optional, Any
from pathlib import Path

logger = logging.getLogger(__name__)

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8001
DEFAULT_MODEL_ID = "nvidia/parakeet-tdt-0.6b-v2"
DEFAULT_CHUNK_DURATION = 500


class Config:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(Config, cls).__new__(cls)
            cls._instance._initialize()
        return cls._instance

    def _initialize(self):
        self.host = os.environ.get("HOST", DEFAULT_HOST)
        self.port = int(os.environ.get("PORT", DEFAULT_PORT))
        self.debug = os.environ.get("DEBUG", "0") == "1"
        self.model_id = os.environ.get("MODEL_ID", DEFAULT_MODEL_ID)
        self.temperature = float(os.environ.get("TEMPERATURE", "0.0"))
        self.chunk_duration = int(os.environ.get("CHUNK_DURATION", DEFAULT_CHUNK_DURATION))
        self.hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_ACCESS_TOKEN")
        self.enable_diarization = os.environ.get("ENABLE_DIARIZATION", "true").lower() == "true"
        self.include_diarization_in_text = os.environ.get("INCLUDE_DIARIZATION_IN_TEXT", "true").lower() == "true"
        self.temp_dir = os.environ.get("TEMP_DIR", "/tmp/parakeet")
        Path(self.temp_dir).mkdir(parents=True, exist_ok=True)

    def get_hf_token(self) -> Optional[str]:
        return self.hf_token

    def as_dict(self) -> Dict[str, Any]:
        return {
            "host": self.host,
            "port": self.port,
            "debug": self.debug,
            "model_id": self.model_id,
            "temperature": self.temperature,
            "chunk_duration": self.chunk_duration,
            "enable_diarization": self.enable_diarization,
            "include_diarization_in_text": self.include_diarization_in_text,
            "has_hf_token": self.hf_token is not None,
        }


config = Config()


def get_config() -> Config:
    return config
