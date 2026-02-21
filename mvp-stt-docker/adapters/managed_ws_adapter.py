"""
Managed WebSocket adapter for ModelEngine port.

Combines the subprocess adapter's model scanning with the WebSocket adapter's
transcription protocol. Runs sherpa-onnx-offline-websocket-server as a managed
subprocess inside the bridge container, enabling model switching by restarting
the subprocess with different model paths.

Resilience features:
    - Persistent WebSocket connection (reused across requests)
    - Timeouts on all blocking operations (recv, connect, lock)
    - Auto-retry with subprocess restart on failure
    - In-memory health metrics (request count, errors, restarts)
    - Proactive periodic restart (configurable, default 12h)

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
import logging
import os
import signal
import struct
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import websockets

from ports import ModelEngine

# Reuse model directory helpers from subprocess_adapter
from adapters.subprocess_adapter import _find_model_dir, _detect_model_files

log = logging.getLogger("managed-ws")

# Path to the sherpa-onnx C++ WebSocket server binary
SHERPA_WS_BIN = "/opt/sherpa-onnx/bin/sherpa-onnx-offline-websocket-server"

# Timeout constants
RECV_TIMEOUT = 120.0        # seconds to wait for transcription result
CONNECT_TIMEOUT = 10.0      # seconds to wait for WebSocket connect
LOCK_TIMEOUT = 130.0        # seconds to wait for lock acquisition

# Proactive restart: hours before subprocess is preemptively restarted
PROACTIVE_RESTART_HOURS = float(
    os.environ.get("PROACTIVE_RESTART_HOURS", "12")
)


@dataclass
class HealthMetrics:
    """In-memory health metrics for the managed WebSocket adapter."""
    request_count: int = 0
    error_count: int = 0
    consecutive_errors: int = 0
    last_restart_time: float = 0.0
    subprocess_restart_count: int = 0

    def record_success(self) -> None:
        self.request_count += 1
        self.consecutive_errors = 0

    def record_error(self) -> None:
        self.request_count += 1
        self.error_count += 1
        self.consecutive_errors += 1

    def record_restart(self) -> None:
        self.subprocess_restart_count += 1
        self.last_restart_time = time.time()

    def reset(self) -> None:
        self.request_count = 0
        self.error_count = 0
        self.consecutive_errors = 0
        self.last_restart_time = 0.0
        self.subprocess_restart_count = 0

    def to_dict(self) -> dict:
        return {
            "request_count": self.request_count,
            "error_count": self.error_count,
            "consecutive_errors": self.consecutive_errors,
            "last_restart_time": self.last_restart_time,
            "subprocess_restart_count": self.subprocess_restart_count,
        }


class ManagedWebSocketAdapter(ModelEngine):
    """
    Adapter that manages a sherpa-onnx WebSocket server as a local subprocess.

    Model switching is accomplished by killing the current subprocess and
    restarting it with the new model's file paths. Transcription uses the
    same binary WebSocket protocol as the external WebSocket adapter.

    A single persistent WebSocket connection is maintained and reused across
    requests. On any failure, the subprocess is restarted and the request
    is retried once before returning an error.

    Configuration via environment variables:
        MODEL_DIR: Base directory containing model subdirectories (default: "/models")
        SHERPA_PROVIDER: ONNX execution provider - "cuda" or "cpu" (default: "cuda")
        SHERPA_NUM_THREADS: Number of threads for inference (default: "4")
        DEFAULT_MODEL: Model to load on startup (default: "parakeet-tdt-0.6b-v2-int8")
        WS_LOCAL_PORT: Local port for the managed WebSocket server (default: "7100")
        SHERPA_MAX_UTTERANCE: Max utterance length in seconds (default: "600")
        PROACTIVE_RESTART_HOURS: Hours before proactive subprocess restart (default: "12")
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
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._subprocess_started_at: float = 0.0
        self._metrics = HealthMetrics()

    @property
    def uri(self) -> str:
        return f"ws://localhost:{self._port}"

    # -- Persistent connection management --

    async def _ensure_connection(self) -> websockets.WebSocketClientProtocol:
        """Return the existing persistent connection, or open a new one."""
        if self._ws is not None:
            try:
                # Quick liveness check -- pong timeout is fast
                await asyncio.wait_for(self._ws.ping(), timeout=5.0)
                return self._ws
            except Exception:
                # Connection is dead, close and reopen
                await self._close_connection()

        ws = await asyncio.wait_for(
            websockets.connect(self.uri),
            timeout=CONNECT_TIMEOUT,
        )
        self._ws = ws
        log.info("WebSocket connection established")
        return ws

    async def _close_connection(self) -> None:
        """Safely close the persistent WebSocket connection."""
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None

    # -- Wire protocol --

    async def _do_transcribe(
        self, samples: np.ndarray, sample_rate: int
    ) -> str:
        """
        Execute the WebSocket wire protocol for one transcription request.

        Opens/reuses the persistent connection, sends header + audio chunks,
        receives the result with a timeout, then sends "Done" to reset
        server state for the next request.
        """
        ws = await self._ensure_connection()

        # Header: sample_rate (4 bytes LE) + audio_byte_count (4 bytes LE)
        header = struct.pack("<ii", sample_rate, samples.size * 4)
        buf = header + samples.tobytes()

        # Send in chunks to avoid overwhelming the connection
        chunk_size = 10240
        for start in range(0, len(buf), chunk_size):
            await ws.send(buf[start : start + chunk_size])

        # Receive transcription result with timeout
        result = await asyncio.wait_for(ws.recv(), timeout=RECV_TIMEOUT)

        # Signal end of session so server resets state for next request
        await ws.send("Done")

        # Parse result -- the C++ server returns JSON; handle both formats
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

    # -- Subprocess restart --

    async def _restart_subprocess(self) -> None:
        """Kill the current subprocess, close the connection, and restart."""
        model_id = self._model_id
        log.warning(
            "Restarting subprocess for model %s (PID=%s)",
            model_id,
            self._process.pid if self._process else "?",
        )

        await self._close_connection()
        await self._kill_process()

        # Restart with the same model config
        cmd = self._build_command()
        self._process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        ready = await self._wait_for_ready(timeout=30.0)
        if not ready:
            await self._kill_process()
            self._state = "error"
            raise RuntimeError(
                f"Subprocess restart failed: server not ready within 30s "
                f"(model={model_id})"
            )

        self._subprocess_started_at = time.time()
        self._metrics.record_restart()
        self._state = "loaded"
        log.info(
            "Subprocess restarted successfully (PID=%s, model=%s)",
            self._process.pid,
            model_id,
        )

    # -- Proactive restart --

    async def _maybe_proactive_restart(self) -> None:
        """Restart the subprocess if it has been running too long."""
        if PROACTIVE_RESTART_HOURS <= 0:
            return
        if self._subprocess_started_at == 0:
            return

        elapsed_hours = (time.time() - self._subprocess_started_at) / 3600.0
        if elapsed_hours >= PROACTIVE_RESTART_HOURS:
            log.info(
                "Proactive restart: subprocess running for %.1fh (threshold=%.1fh)",
                elapsed_hours,
                PROACTIVE_RESTART_HOURS,
            )
            await self._restart_subprocess()

    # -- Public interface --

    async def transcribe(self, samples: np.ndarray, sample_rate: int) -> str:
        """Send audio to the managed WebSocket server and return transcription text."""
        try:
            await asyncio.wait_for(
                self._lock.acquire(), timeout=LOCK_TIMEOUT
            )
        except asyncio.TimeoutError:
            raise RuntimeError(
                f"Transcription lock acquisition timed out after {LOCK_TIMEOUT}s. "
                "Another request may be stuck."
            )

        try:
            if self._state != "loaded" or self._process is None:
                raise RuntimeError(
                    f"Engine not ready (state={self._state}). "
                    "Call load_model() first."
                )

            # Proactive restart if subprocess has been running too long
            await self._maybe_proactive_restart()

            # Attempt 1
            try:
                text = await self._do_transcribe(samples, sample_rate)
                self._metrics.record_success()
                return text
            except Exception as e:
                self._metrics.record_error()
                log.warning(
                    "Attempt 1 failed (%s: %s), restarting subprocess",
                    type(e).__name__,
                    e,
                )
                await self._close_connection()

                # Restart subprocess and retry
                await self._restart_subprocess()

                # Attempt 2
                try:
                    text = await self._do_transcribe(samples, sample_rate)
                    self._metrics.record_success()
                    return text
                except Exception as e2:
                    self._metrics.record_error()
                    await self._close_connection()
                    raise RuntimeError(
                        f"Transcription failed after retry: "
                        f"{type(e2).__name__}: {e2}"
                    ) from e2
        finally:
            self._lock.release()

    async def load_model(self, model_id: str) -> None:
        """
        Load a model by starting the WebSocket server subprocess.

        If a different model is already loaded, the current subprocess is
        killed and a new one is started with the new model's paths.
        """
        async with self._lock:
            if self._model_id == model_id and self._state == "loaded":
                log.info("Model %s already loaded", model_id)
                return

            # Unload current model if switching
            if self._model_id and self._model_id != model_id:
                await self._do_unload()

            self._state = "loading"
            self._metrics.reset()
            log.info("Loading model: %s", model_id)

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
            cmd = self._build_command()
            log.info("Starting subprocess: %s", " ".join(cmd))

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

            self._subprocess_started_at = time.time()
            self._state = "loaded"
            log.info(
                "Model loaded: %s (PID=%s, port=%d, provider=%s)",
                model_id,
                self._process.pid,
                self._port,
                self._provider,
            )

    def _build_command(self) -> list[str]:
        """Build the subprocess command using current model config."""
        return [
            SHERPA_WS_BIN,
            f"--port={self._port}",
            f"--provider={self._provider}",
            f"--encoder={self._model_files['encoder']}",
            f"--decoder={self._model_files['decoder']}",
            f"--joiner={self._model_files['joiner']}",
            f"--tokens={self._model_files['tokens']}",
            f"--num-threads={self._num_threads}",
            f"--max-utterance-length={self._max_utterance}",
        ]

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
                log.error(
                    "Process exited with code %s: %s",
                    self._process.returncode,
                    stderr,
                )
                return False

            try:
                async with websockets.connect(
                    self.uri, close_timeout=2, open_timeout=2
                ) as ws:
                    await ws.send("Done")
                log.info("Server ready on port %d", self._port)
                return True
            except Exception:
                await asyncio.sleep(delay)
                delay = min(delay * 1.5, 3.0)

        return False

    async def unload_model(self) -> None:
        """Unload the current model by stopping the subprocess."""
        async with self._lock:
            await self._do_unload()

    async def _do_unload(self) -> None:
        """Inner unload without acquiring the lock (caller must hold it)."""
        if self._model_id:
            log.info("Unloading model: %s", self._model_id)
        await self._close_connection()
        await self._kill_process()
        self._model_id = None
        self._model_dir = None
        self._model_files = None
        self._state = "unloaded"
        self._subprocess_started_at = 0.0

    async def _kill_process(self) -> None:
        """Terminate the subprocess, escalating to SIGKILL if needed."""
        if self._process is None:
            return

        pid = self._process.pid
        if self._process.returncode is not None:
            # Already exited
            self._process = None
            return

        log.info("Sending SIGTERM to PID %s", pid)
        try:
            self._process.send_signal(signal.SIGTERM)
        except ProcessLookupError:
            self._process = None
            return

        try:
            await asyncio.wait_for(self._process.wait(), timeout=5.0)
            log.info("Process %s exited gracefully", pid)
        except asyncio.TimeoutError:
            log.warning("Process %s didn't exit, sending SIGKILL", pid)
            try:
                self._process.kill()
                await asyncio.wait_for(self._process.wait(), timeout=3.0)
            except (ProcessLookupError, asyncio.TimeoutError):
                pass

        self._process = None

    async def get_status(self) -> dict:
        """Return current engine status using in-memory state (no probe connection)."""
        status: dict = {
            "model_id": self._model_id,
            "state": self._state,
            "adapter": "managed-websocket",
            "provider": self._provider,
            "port": self._port,
            "model_dir": str(self._base_dir),
            "health": self._metrics.to_dict(),
        }
        if self._process and self._process.returncode is None:
            status["pid"] = self._process.pid
        elif self._state == "loaded":
            # Process died unexpectedly
            status["state"] = "error"
            status["error"] = "Subprocess exited unexpectedly"
        if self._model_dir:
            status["model_path"] = str(self._model_dir)
        if self._ws is not None:
            status["persistent_connection"] = "open"
        else:
            status["persistent_connection"] = "closed"
        if self._subprocess_started_at > 0:
            status["subprocess_uptime_hours"] = round(
                (time.time() - self._subprocess_started_at) / 3600.0, 2
            )

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
