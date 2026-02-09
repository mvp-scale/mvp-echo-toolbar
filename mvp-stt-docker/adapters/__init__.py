"""
Adapter implementations for the ModelEngine port.

Available adapters:
    - WebSocketAdapter: Relays audio to an external sherpa-onnx C++ WebSocket server.
    - SubprocessAdapter: Manages sherpa-onnx as a local child process.
"""

from adapters.websocket_adapter import WebSocketAdapter
from adapters.subprocess_adapter import SubprocessAdapter

__all__ = ["WebSocketAdapter", "SubprocessAdapter"]
