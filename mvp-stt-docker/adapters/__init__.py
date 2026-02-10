"""
Adapter implementations for the ModelEngine port.

Available adapters:
    - WebSocketAdapter: Relays audio to an external sherpa-onnx C++ WebSocket server.
    - SubprocessAdapter: Manages sherpa-onnx as a local child process.
    - ManagedWebSocketAdapter: Manages a sherpa-onnx WebSocket server subprocess with model switching.
"""

from adapters.websocket_adapter import WebSocketAdapter
from adapters.subprocess_adapter import SubprocessAdapter
from adapters.managed_ws_adapter import ManagedWebSocketAdapter

__all__ = ["WebSocketAdapter", "SubprocessAdapter", "ManagedWebSocketAdapter"]
