"""
Subprocess adapter for ModelEngine port.

Manages sherpa-onnx as a child process directly, eliminating the need
for a separate WebSocket server container. Uses sherpa-onnx-offline
CLI to transcribe audio files.

Model directory layout (each model is a subdirectory of MODEL_DIR):
    /models/
        parakeet-tdt-0.6b-v2-int8/
            encoder.int8.onnx
            decoder.int8.onnx
            joiner.int8.onnx
            tokens.txt
        parakeet-tdt-0.6b-v3-int8/
            ...
"""

import asyncio
import logging
import os
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

from ports import ModelEngine

log = logging.getLogger("subprocess-adapter")


# Known Parakeet TDT models and their HuggingFace repos.
# Used for display names and download references.
KNOWN_MODELS: dict[str, dict] = {
    "parakeet-tdt-0.6b-v2-int8": {
        "hf_repo": "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
        "dir_prefix": "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
    },
    "parakeet-tdt-0.6b-v3-int8": {
        "hf_repo": "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        "dir_prefix": "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    },
}


def _find_model_dir(base_dir: str, model_id: str) -> Path | None:
    """
    Locate the model directory on disk.

    Models may live at:
        {base_dir}/{model_id}/
        {base_dir}/sherpa-onnx-nemo-{model_id}/
    """
    base = Path(base_dir)

    # Direct match: /models/parakeet-tdt-0.6b-v2-int8/
    candidate = base / model_id
    if (candidate / "tokens.txt").is_file():
        return candidate

    # Prefixed match: /models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8/
    prefixed = base / f"sherpa-onnx-nemo-{model_id}"
    if (prefixed / "tokens.txt").is_file():
        return prefixed

    # Check known models for their directory prefix
    known = KNOWN_MODELS.get(model_id)
    if known:
        aliased = base / known["dir_prefix"]
        if (aliased / "tokens.txt").is_file():
            return aliased

    return None


def _detect_model_files(model_dir: Path) -> dict[str, str]:
    """
    Detect encoder, decoder, joiner, and tokens files in a model directory.

    Returns dict with keys: encoder, decoder, joiner, tokens.
    Raises FileNotFoundError if required files are missing.
    """
    files: dict[str, str] = {}

    # tokens.txt is always required
    tokens = model_dir / "tokens.txt"
    if not tokens.is_file():
        raise FileNotFoundError(f"tokens.txt not found in {model_dir}")
    files["tokens"] = str(tokens)

    # Find encoder, decoder, joiner (prefer int8 variants)
    for component in ("encoder", "decoder", "joiner"):
        int8_path = model_dir / f"{component}.int8.onnx"
        plain_path = model_dir / f"{component}.onnx"
        if int8_path.is_file():
            files[component] = str(int8_path)
        elif plain_path.is_file():
            files[component] = str(plain_path)
        else:
            raise FileNotFoundError(
                f"{component}.onnx not found in {model_dir}"
            )

    return files


class SubprocessAdapter(ModelEngine):
    """
    Adapter that manages sherpa-onnx as a local subprocess.

    Transcription is performed by writing audio to a temp WAV file,
    invoking sherpa-onnx-offline on it, and parsing the text output.

    Configuration via environment variables:
        MODEL_DIR: Base directory containing model subdirectories (default: "/models")
        SHERPA_PROVIDER: ONNX execution provider - "cuda" or "cpu" (default: "cuda")
        SHERPA_NUM_THREADS: Number of threads for inference (default: "4")
        DEFAULT_MODEL: Model to load on startup (default: "parakeet-tdt-0.6b-v2-int8")
    """

    def __init__(self) -> None:
        self._base_dir = os.environ.get("MODEL_DIR", "/models")
        self._provider = os.environ.get("SHERPA_PROVIDER", "cuda")
        self._num_threads = os.environ.get("SHERPA_NUM_THREADS", "4")
        self._default_model = os.environ.get(
            "DEFAULT_MODEL", "parakeet-tdt-0.6b-v2-int8"
        )

        self._model_id: str | None = None
        self._model_dir: Path | None = None
        self._model_files: dict[str, str] | None = None
        self._state: str = "unloaded"

    async def transcribe(self, samples: np.ndarray, sample_rate: int) -> str:
        """
        Transcribe audio by invoking sherpa-onnx-offline as a subprocess.

        Writes samples to a temporary WAV file, runs the CLI tool, and
        parses the output text.
        """
        if self._state != "loaded" or self._model_files is None:
            raise RuntimeError(
                f"Engine not ready (state={self._state}). "
                "Call load_model() first."
            )

        # Write samples to a temporary WAV file
        tmp_wav = None
        try:
            with tempfile.NamedTemporaryFile(
                suffix=".wav", delete=False
            ) as f:
                tmp_wav = f.name
                sf.write(f.name, samples, sample_rate, subtype="FLOAT")

            # Build sherpa-onnx-offline command
            cmd = [
                "sherpa-onnx-offline",
                f"--encoder={self._model_files['encoder']}",
                f"--decoder={self._model_files['decoder']}",
                f"--joiner={self._model_files['joiner']}",
                f"--tokens={self._model_files['tokens']}",
                f"--provider={self._provider}",
                f"--num-threads={self._num_threads}",
                f"--model-type=transducer",
                tmp_wav,
            ]

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=120
            )

            if proc.returncode != 0:
                error_msg = stderr.decode().strip() if stderr else "Unknown error"
                log.error("sherpa-onnx-offline failed: %s", error_msg)
                raise RuntimeError(
                    f"sherpa-onnx-offline exited with code {proc.returncode}: {error_msg}"
                )

            # Parse output: sherpa-onnx-offline prints the filename then the text
            # Format is typically:
            #   /tmp/xyz.wav
            #   recognized text here
            raw_output = stdout.decode().strip()
            lines = raw_output.splitlines()

            # The transcription text is everything after the filename line
            text_lines = []
            found_filename = False
            for line in lines:
                if not found_filename and tmp_wav in line:
                    found_filename = True
                    # If there's text after the filename on the same line, grab it
                    after = line.split(tmp_wav, 1)[1].strip()
                    if after:
                        text_lines.append(after)
                    continue
                if found_filename:
                    text_lines.append(line)

            # Fallback: if we never found the filename, take the last non-empty line
            if not text_lines and lines:
                text_lines = [lines[-1]]

            text = " ".join(text_lines).strip()
            return text

        finally:
            if tmp_wav:
                try:
                    os.unlink(tmp_wav)
                except OSError:
                    pass

    async def load_model(self, model_id: str) -> None:
        """
        Load a model by locating its directory and validating required files.

        If a different model is already loaded, it is unloaded first.
        """
        if self._model_id == model_id and self._state == "loaded":
            log.info("Model %s already loaded", model_id)
            return

        # Unload current model if switching
        if self._model_id and self._model_id != model_id:
            await self.unload_model()

        self._state = "loading"
        log.info("Loading model: %s", model_id)

        model_dir = _find_model_dir(self._base_dir, model_id)
        if model_dir is None:
            self._state = "error"
            raise FileNotFoundError(
                f"Model '{model_id}' not found in {self._base_dir}. "
                f"Searched: {model_id}/, sherpa-onnx-nemo-{model_id}/"
            )

        try:
            model_files = _detect_model_files(model_dir)
        except FileNotFoundError as e:
            self._state = "error"
            raise RuntimeError(f"Model '{model_id}' is incomplete: {e}") from e

        self._model_id = model_id
        self._model_dir = model_dir
        self._model_files = model_files
        self._state = "loaded"

        log.info(
            "Model loaded: %s (dir=%s, provider=%s)",
            model_id,
            model_dir,
            self._provider,
        )

    async def unload_model(self) -> None:
        """Unload the current model (clear references)."""
        if self._model_id:
            log.info("Unloading model: %s", self._model_id)
        self._model_id = None
        self._model_dir = None
        self._model_files = None
        self._state = "unloaded"

    async def get_status(self) -> dict:
        """Return current engine status."""
        status: dict = {
            "model_id": self._model_id,
            "state": self._state,
            "adapter": "subprocess",
            "provider": self._provider,
            "model_dir": str(self._base_dir),
        }
        if self._model_dir:
            status["model_path"] = str(self._model_dir)
        return status

    async def list_available(self) -> list[dict]:
        """
        Scan the model directory for available models.

        A valid model directory must contain a tokens.txt file.
        """
        available: list[dict] = []
        base = Path(self._base_dir)

        if not base.is_dir():
            return available

        for entry in sorted(base.iterdir()):
            if not entry.is_dir():
                continue
            if not (entry / "tokens.txt").is_file():
                continue

            # Derive a clean model ID from the directory name
            dir_name = entry.name
            model_id = dir_name

            # Strip common prefixes for cleaner IDs
            for prefix in ("sherpa-onnx-nemo-", "sherpa-onnx-"):
                if dir_name.startswith(prefix):
                    model_id = dir_name[len(prefix) :]
                    break

            available.append(
                {
                    "id": model_id,
                    "object": "model",
                    "owned_by": "local",
                    "directory": str(entry),
                }
            )

        return available
