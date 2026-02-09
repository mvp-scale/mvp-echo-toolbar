"""
Lightweight API key auth middleware for MVP-Echo Studio.
LAN IPs bypass auth. External requests need Bearer token from api-keys.json.
"""

import json
import logging
from ipaddress import ip_address, ip_network
from pathlib import Path

from fastapi import Request, HTTPException
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger(__name__)

PRIVATE_NETWORKS = [
    ip_network("127.0.0.0/8"),
    ip_network("10.0.0.0/8"),
    ip_network("172.16.0.0/12"),
    ip_network("192.168.0.0/16"),
]

OPEN_PATHS = {"/health", "/v1/models"}

KEYS_FILE = "/data/api-keys.json"


def _is_private_ip(addr: str) -> bool:
    try:
        ip = ip_address(addr)
        return any(ip in net for net in PRIVATE_NETWORKS)
    except ValueError:
        return False


def _load_keys() -> dict:
    try:
        with open(KEYS_FILE) as f:
            data = json.load(f)
        return {k["key"]: k for k in data.get("keys", []) if k.get("active", True)}
    except (FileNotFoundError, json.JSONDecodeError) as e:
        logger.warning(f"Could not load keys file: {e}")
        return {}


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Always allow health + models
        if request.url.path in OPEN_PATHS:
            return await call_next(request)

        # Allow OPTIONS (CORS preflight)
        if request.method == "OPTIONS":
            return await call_next(request)

        # LAN bypass
        client_ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        if not client_ip:
            client_ip = request.client.host if request.client else ""

        if _is_private_ip(client_ip):
            return await call_next(request)

        # Check Bearer token
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Missing API key")

        token = auth[7:].strip()
        keys = _load_keys()
        if token not in keys:
            logger.warning(f"Invalid API key from {client_ip}")
            raise HTTPException(status_code=401, detail="Invalid API key")

        return await call_next(request)
