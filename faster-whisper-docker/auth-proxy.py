"""
Auth proxy for faster-whisper-server.
Validates API keys, proxies requests, tracks usage (seconds processed per key).
Local/private IPs bypass auth. Replaces nginx for CORS + auth.
"""

import http.server
import json
import os
import threading
import time
import urllib.request
import urllib.error
from io import BytesIO
from ipaddress import ip_address, ip_network

WHISPER_BACKEND = os.environ.get("WHISPER_BACKEND", "http://faster-whisper-api:8000")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "8080"))
KEYS_FILE = os.environ.get("KEYS_FILE", "/data/api-keys.json")
USAGE_FILE = os.environ.get("USAGE_FILE", "/data/usage.json")

# Private/local networks that bypass auth
PRIVATE_NETWORKS = [
    ip_network("127.0.0.0/8"),
    ip_network("10.0.0.0/8"),
    ip_network("172.16.0.0/12"),
    ip_network("192.168.0.0/16"),
]

# Lock for thread-safe usage file writes
usage_lock = threading.Lock()


def load_keys():
    """Load API keys from JSON file. Re-reads each request so you can edit live."""
    try:
        with open(KEYS_FILE, "r") as f:
            data = json.load(f)
        return {k["key"]: k for k in data.get("keys", []) if k.get("active", True)}
    except (FileNotFoundError, json.JSONDecodeError) as e:
        print(f"[auth-proxy] Warning: Could not load keys file: {e}")
        return {}


def load_usage():
    """Load usage tracking data."""
    try:
        with open(USAGE_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_usage(usage):
    """Save usage tracking data."""
    try:
        with open(USAGE_FILE, "w") as f:
            json.dump(usage, f, indent=2)
    except OSError as e:
        print(f"[auth-proxy] Warning: Could not save usage: {e}")


def format_duration(total_seconds):
    """Format seconds into human-readable duration like '2 hours 9 seconds' or '1 day 2 hours 35 seconds'."""
    total = int(total_seconds)
    days = total // 86400
    hours = (total % 86400) // 3600
    minutes = (total % 3600) // 60
    seconds = total % 60

    parts = []
    if days > 0:
        parts.append(f"{days} day{'s' if days != 1 else ''}")
    if hours > 0:
        parts.append(f"{hours} hour{'s' if hours != 1 else ''}")
    if minutes > 0:
        parts.append(f"{minutes} minute{'s' if minutes != 1 else ''}")
    if seconds > 0 or not parts:
        parts.append(f"{seconds} second{'s' if seconds != 1 else ''}")
    return " ".join(parts)


def record_usage(api_key, name, duration_seconds):
    """Record seconds processed for an API key."""
    with usage_lock:
        usage = load_usage()
        if api_key not in usage:
            usage[api_key] = {
                "name": name,
                "total_seconds": 0.0,
                "request_count": 0,
                "first_used": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "last_used": None,
            }
        usage[api_key]["total_seconds"] += duration_seconds
        usage[api_key]["request_count"] += 1
        usage[api_key]["last_used"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        # Keep name in sync with keys file
        usage[api_key]["name"] = name
        save_usage(usage)

        used_str = format_duration(duration_seconds)
        total_str = format_duration(usage[api_key]["total_seconds"])
        print(f"[auth-proxy] {name} +{used_str}  >>>  cumulative: {total_str}")


def is_private_ip(addr):
    """Check if an IP address is in a private/local range."""
    try:
        ip = ip_address(addr)
        return any(ip in net for net in PRIVATE_NETWORKS)
    except ValueError:
        return False


class AuthProxyHandler(http.server.BaseHTTPRequestHandler):
    """HTTP handler that validates API keys and proxies to Whisper backend."""

    def log_message(self, format, *args):
        """Override to prefix log messages."""
        print(f"[auth-proxy] {args[0]}")

    def send_cors_headers(self):
        """Add CORS headers to response."""
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE, PUT")
        self.send_header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization")
        self.send_header("Access-Control-Max-Age", "1728000")

    def do_OPTIONS(self):
        """Handle CORS preflight."""
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def authenticate(self):
        """
        Validate the request. Returns (api_key, name) tuple or None if unauthorized.
        Local IPs bypass auth and return ("local", "Local Network").
        """
        # Get client IP (check X-Forwarded-For for proxied requests)
        client_ip = self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
        if not client_ip:
            client_ip = self.client_address[0]

        # Local IPs bypass auth
        if is_private_ip(client_ip):
            return ("local", "Local Network")

        # Extract Bearer token
        auth_header = self.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return None

        token = auth_header[7:].strip()
        if not token:
            return None

        # Validate against keys file
        keys = load_keys()
        key_info = keys.get(token)
        if key_info:
            return (token, key_info.get("name", "Unknown"))

        return None

    def proxy_request(self, method):
        """Proxy the request to the Whisper backend."""
        # Authenticate (skip for health endpoint)
        auth_result = None
        if self.path not in ("/health", "/v1/models"):
            auth_result = self.authenticate()
            if auth_result is None:
                client_ip = self.headers.get("X-Forwarded-For", "").split(",")[0].strip() or self.client_address[0]
                print(f"[auth-proxy] DENIED {method} {self.path} from {client_ip} (invalid or missing key)")
                self.send_response(401)
                self.send_cors_headers()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Invalid or missing API key"}).encode())
                return
        else:
            auth_result = ("health", "Health Check")

        # Log the request with user name
        if "/audio/transcriptions" in self.path:
            content_length = int(self.headers.get("Content-Length", 0))
            size_kb = content_length / 1024
            print(f"[auth-proxy] {auth_result[1]} transcribing ({size_kb:.0f} KB audio)")
        elif self.path not in ("/health",):
            print(f"[auth-proxy] {auth_result[1]} {method} {self.path}")

        # Read request body
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length) if content_length > 0 else None

        # Build backend request
        url = f"{WHISPER_BACKEND}{self.path}"
        req = urllib.request.Request(url, data=body, method=method)

        # Forward headers (except Host)
        for header, value in self.headers.items():
            if header.lower() not in ("host", "authorization"):
                req.add_header(header, value)

        # Make request to backend
        try:
            resp = urllib.request.urlopen(req, timeout=300)
            response_body = resp.read()

            # Send response
            self.send_response(resp.status)
            self.send_cors_headers()
            for header, value in resp.getheaders():
                if header.lower() not in ("transfer-encoding", "connection", "access-control-allow-origin"):
                    self.send_header(header, value)
            self.end_headers()
            self.wfile.write(response_body)

            # Track usage for transcription requests
            if "/audio/transcriptions" in self.path and auth_result:
                try:
                    result = json.loads(response_body)
                    duration = float(result.get("duration", 0))
                    record_usage(auth_result[0], auth_result[1], duration)
                except (json.JSONDecodeError, ValueError, TypeError):
                    # Still count the request even if we can't parse duration
                    record_usage(auth_result[0], auth_result[1], 0)

        except urllib.error.HTTPError as e:
            error_body = e.read()
            self.send_response(e.code)
            self.send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(error_body)

        except urllib.error.URLError as e:
            self.send_response(502)
            self.send_cors_headers()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"Backend unavailable: {str(e)}"}).encode())

    def do_GET(self):
        self.proxy_request("GET")

    def do_POST(self):
        self.proxy_request("POST")

    def do_PUT(self):
        self.proxy_request("PUT")

    def do_DELETE(self):
        self.proxy_request("DELETE")


class ThreadedHTTPServer(http.server.ThreadingHTTPServer):
    """Threaded HTTP server for concurrent requests."""
    allow_reuse_address = True


if __name__ == "__main__":
    print(f"[auth-proxy] Starting on port {LISTEN_PORT}")
    print(f"[auth-proxy] Backend: {WHISPER_BACKEND}")
    print(f"[auth-proxy] Keys file: {KEYS_FILE}")
    print(f"[auth-proxy] Usage file: {USAGE_FILE}")
    print(f"[auth-proxy] Private IPs bypass auth")

    keys = load_keys()
    print(f"[auth-proxy] Loaded {len(keys)} active API key(s)")

    server = ThreadedHTTPServer(("0.0.0.0", LISTEN_PORT), AuthProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[auth-proxy] Shutting down")
        server.shutdown()
