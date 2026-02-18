"""
Managed WebSocket adapter for ModelEngine port.

Combines the subprocess adapter's model scanning with the WebSocket adapter's
transcription protocol. Runs sherpa-onnx-offline-websocket-server as a managed
subprocess inside the bridge container, enabling model switching by restarting
the subprocess with different model paths.

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
import json
import os
import signal
import struct
from pathlib import Path

import numpy as np
import websockets

from ports import ModelEngine

# Reuse model directory helpers from subprocess_adapter
from adapters.subprocess_adapter import _find_model_dir, _detect_model_files

# Path to the sherpa-onnx C++ WebSocket server binary
SHERPA_WS_BIN = "/opt/sherpa-onnx/bin/sherpa-onnx-offline-websocket-server"


class ManagedWebSocketAdapter(ModelEngine):
    """
    Adapter that manages a sherpa-onnx WebSocket server as a local subprocess.

    Model switching is accomplished by killing the current subprocess and
    restarting it with the new model's file paths. Transcription uses the
    same binary WebSocket protocol as the external WebSocket adapter.

    Configuration via environment variables:
        MODEL_DIR: Base directory containing model subdirectories (default: "/models")
        SHERPA_PROVIDER: ONNX execution provider - "cuda" or "cpu" (default: "cuda")
        SHERPA_NUM_THREADS: Number of threads for inference (default: "4")
        DEFAULT_MODEL: Model to load on startup (default: "parakeet-tdt-0.6b-v2-int8")
        WS_LOCAL_PORT: Local port for the managed WebSocket server (default: "7100")
        SHERPA_MAX_UTTERANCE: Max utterance length in seconds (default: "600")
    """

    def __init__(self) -> None:
        self._base_dir = os.environ.get("MODEL_DIR", "/models")
        self._provider = os.environ.get("SHERPA_PROVIDER", "cuda")
        self._num_threads = os.environ.get("SHERPA_NUM_THREADS", "4")
        self._default_model = os.environ.get(
            "DEFAULT_MODEL", "parakeet-tdt-0.6b-v2-int8"
        )
        self._port = int(os.environ.get("WS_LOCAL_PORT", "7100"))
        self._max_utterance = os.environ.get("SHERPA_MAX_UTTERANCE", "600")

        self._lock = asyncio.Lock()
        self._model_id: str | None = None
        self._model_dir: Path | None = None
        self._model_files: dict[str, str] | None = None
        self._process: asyncio.subprocess.Process | None = None
        self._state: str = "unloaded"

    @property
    def uri(self) -> str:
        return f"ws://localhost:{self._port}"

    async def transcribe(self, samples: np.ndarray, sample_rate: int) -> str:
        """Send audio to the managed WebSocket server and return transcription text."""
        async with self._lock:
            if self._state != "loaded" or self._process is None:
                raise RuntimeError(
                    f"Engine not ready (state={self._state}). "
                    "Call load_model() first."
                )

            async with websockets.connect(self.uri) as ws:
                # Header: sample_rate (4 bytes LE) + audio_byte_count (4 bytes LE)
                header = struct.pack("<ii", sample_rate, samples.size * 4)
                buf = header + samples.tobytes()

                # Send in chunks to avoid overwhelming the connection
                chunk_size = 10240
                for start in range(0, len(buf), chunk_size):
                    await ws.send(buf[start : start + chunk_size])

                # Receive transcription result
                result = await ws.recv()

                # Signal end of session
                await ws.send("Done")

            # The C++ server returns JSON; handle both JSON and plain text
            try:
                parsed = json.loads(result)
                return parsed.get("text", "").strip()
            except (json.JSONDecodeError, TypeError):
                text = (
                    result.strip()
                    if isinstance(result, str)
                    else result.decode().strip()
                )
                return "" if text == "<EMPTY>" else text

    async def load_model(self, model_id: str) -> None:
        """
        Load a model by starting the WebSocket server subprocess.

        If a different model is already loaded, the current subprocess is
        killed and a new one is started with the new model's paths.
        """
        async with self._lock:
            if self._model_id == model_id and self._state == "loaded":
                print(f"[managed-ws] Model {model_id} already loaded")
                return

            # Unload current model if switching
            if self._model_id and self._model_id != model_id:
                await self.unload_model()

            self._state = "loading"
            print(f"[managed-ws] Loading model: {model_id}")

            # Find and validate model files on disk
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

            # Start the WebSocket server subprocess
            cmd = [
                SHERPA_WS_BIN,
                f"--port={self._port}",
                f"--provider={self._provider}",
                f"--encoder={model_files['encoder']}",
                f"--decoder={model_files['decoder']}",
                f"--joiner={model_files['joiner']}",
                f"--tokens={model_files['tokens']}",
                f"--num-threads={self._num_threads}",
                f"--max-utterance-length={self._max_utterance}",
            ]

            print(f"[managed-ws] Starting subprocess: {' '.join(cmd)}")

            self._process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            # Wait for the WebSocket server to become ready
            ready = await self._wait_for_ready(timeout=30.0)
            if not ready:
                await self._kill_process()
                self._state = "error"
                raise RuntimeError(
                    f"WebSocket server failed to start within 30s "
                    f"(PID={self._process.pid if self._process else '?'})"
                )

            self._state = "loaded"
            print(
                f"[managed-ws] Model loaded: {model_id} "
                f"(PID={self._process.pid}, port={self._port}, "
                f"provider={self._provider})"
            )

    async def _wait_for_ready(self, timeout: float = 30.0) -> bool:
        """
        Wait for the WebSocket server to accept connections.

        Retries with exponential backoff up to `timeout` seconds.
        """
        deadline = asyncio.get_event_loop().time() + timeout
        delay = 0.5

        while asyncio.get_event_loop().time() < deadline:
            # Check if process died
            if self._process and self._process.returncode is not None:
                stderr = ""
                if self._process.stderr:
                    try:
                        raw = await asyncio.wait_for(
                            self._process.stderr.read(4096), timeout=1.0
                        )
                        stderr = raw.decode(errors="replace")
                    except asyncio.TimeoutError:
                        pass
                print(
                    f"[managed-ws] Process exited with code "
                    f"{self._process.returncode}: {stderr}"
                )
                return False

            try:
                async with websockets.connect(
                    self.uri, close_timeout=2, open_timeout=2
                ) as ws:
                    await ws.send("Done")
                print(f"[managed-ws] Server ready on port {self._port}")
                return True
            except Exception:
                await asyncio.sleep(delay)
                delay = min(delay * 1.5, 3.0)

        return False

    async def unload_model(self) -> None:
        """Unload the current model by stopping the subprocess."""
        if self._model_id:
            print(f"[managed-ws] Unloading model: {self._model_id}")
        await self._kill_process()
        self._model_id = None
        self._model_dir = None
        self._model_files = None
        self._state = "unloaded"

    async def _kill_process(self) -> None:
        """Terminate the subprocess, escalating to SIGKILL if needed."""
        if self._process is None:
            return

        pid = self._process.pid
        if self._process.returncode is not None:
            # Already exited
            self._process = None
            return

        print(f"[managed-ws] Sending SIGTERM to PID {pid}")
        try:
            self._process.send_signal(signal.SIGTERM)
        except ProcessLookupError:
            self._process = None
            return

        try:
            await asyncio.wait_for(self._process.wait(), timeout=5.0)
            print(f"[managed-ws] Process {pid} exited gracefully")
        except asyncio.TimeoutError:
            print(f"[managed-ws] Process {pid} didn't exit, sending SIGKILL")
            try:
                self._process.kill()
                await asyncio.wait_for(self._process.wait(), timeout=3.0)
            except (ProcessLookupError, asyncio.TimeoutError):
                pass

        self._process = None

    async def get_status(self) -> dict:
        """Return current engine status."""
        status: dict = {
            "model_id": self._model_id,
            "state": self._state,
            "adapter": "managed-websocket",
            "provider": self._provider,
            "port": self._port,
            "model_dir": str(self._base_dir),
        }
        if self._process and self._process.returncode is None:
            status["pid"] = self._process.pid
        if self._model_dir:
            status["model_path"] = str(self._model_dir)

        # Verify the server is actually reachable when we think it's loaded
        if self._state == "loaded":
            try:
                async with websockets.connect(
                    self.uri, close_timeout=3, open_timeout=3
                ) as ws:
                    await ws.send("Done")
            except Exception:
                status["state"] = "error"
                status["error"] = "WebSocket server unreachable"

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
                    model_id = dir_name[len(prefix):]
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
