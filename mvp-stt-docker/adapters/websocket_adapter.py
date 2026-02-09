"""
WebSocket adapter for ModelEngine port.

Preserves the original bridge.py behavior: connects to an external
sherpa-onnx C++ WebSocket server (typically mvp-asr:6006) and relays
audio for transcription.

The remote server manages its own model lifecycle, so load_model /
unload_model are no-ops in this adapter.
"""

import json
import os
import struct

import numpy as np
import websockets

from ports import ModelEngine


class WebSocketAdapter(ModelEngine):
    """
    Relay adapter that forwards audio to a sherpa-onnx WebSocket server.

    Configuration via environment variables:
        WS_HOST: Hostname of the WebSocket server (default: "mvp-asr")
        WS_PORT: Port of the WebSocket server (default: 6006)
    """

    def __init__(self) -> None:
        self._ws_host = os.environ.get("WS_HOST", "mvp-asr")
        self._ws_port = int(os.environ.get("WS_PORT", "6006"))
        self._model_id = os.environ.get(
            "WS_MODEL_ID", "parakeet-tdt-0.6b-v2-int8"
        )

    @property
    def uri(self) -> str:
        return f"ws://{self._ws_host}:{self._ws_port}"

    async def transcribe(self, samples: np.ndarray, sample_rate: int) -> str:
        """Send audio to the WebSocket server and return transcription text."""
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
        """No-op: the C++ WebSocket server manages its own model."""
        self._model_id = model_id

    async def unload_model(self) -> None:
        """No-op: the C++ WebSocket server manages its own model."""

    async def get_status(self) -> dict:
        """Check WebSocket connectivity and report status."""
        try:
            async with websockets.connect(
                self.uri, close_timeout=3, open_timeout=3
            ) as ws:
                await ws.send("Done")
            return {
                "model_id": self._model_id,
                "state": "loaded",
                "adapter": "websocket",
                "backend": self.uri,
            }
        except Exception:
            return {
                "model_id": self._model_id,
                "state": "error",
                "adapter": "websocket",
                "backend": self.uri,
                "error": "WebSocket server unreachable",
            }

    async def list_available(self) -> list[dict]:
        """Return the single model the remote server is configured with."""
        return [
            {
                "id": self._model_id,
                "object": "model",
                "owned_by": "remote",
            }
        ]
