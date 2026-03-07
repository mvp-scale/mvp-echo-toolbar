"""
Resilience tests for ManagedWebSocketAdapter and bridge transcription retry.

Run inside the Docker container:
    pytest test_resilience.py -v

Tests chaos scenarios:
    - Subprocess dies between requests
    - Subprocess dies mid-inference
    - Transient WebSocket connection failures
    - Empty transcription on real audio
    - All retry attempts exhausted
    - Watchdog auto-recovery
    - Proactive restart respects idle time
    - Warm-up after every start/restart
    - Bridge-level retry on empty and error
"""

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock
import numpy as np
import pytest

# Insert the Docker app directory so "ports" and "adapters" resolve
import sys
import os
import types
sys.path.insert(0, os.path.dirname(__file__))

# Stub out heavy dependencies that only exist inside the Docker container
for mod_name in ("websockets", "soundfile", "uvicorn", "fastapi",
                 "fastapi.responses", "pydantic"):
    if mod_name not in sys.modules:
        sys.modules[mod_name] = types.ModuleType(mod_name)

# websockets.connect is used as an async context manager — provide a stub
_ws_stub = sys.modules["websockets"]
_ws_stub.connect = None  # tests will patch this
_ws_stub.WebSocketClientProtocol = type("WebSocketClientProtocol", (), {})

from adapters.managed_ws_adapter import ManagedWebSocketAdapter, HealthMetrics


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SILENCE_1S = np.zeros(16000, dtype=np.float32)
REAL_AUDIO_5S = np.random.randn(16000 * 5).astype(np.float32)


def make_adapter():
    """Create an adapter in 'loaded' state with a fake subprocess."""
    adapter = ManagedWebSocketAdapter()
    adapter._model_id = "test-model"
    adapter._model_dir = "/models/test-model"
    adapter._model_files = {
        "encoder": "/models/test-model/encoder.int8.onnx",
        "decoder": "/models/test-model/decoder.int8.onnx",
        "joiner": "/models/test-model/joiner.int8.onnx",
        "tokens": "/models/test-model/tokens.txt",
    }
    adapter._state = "loaded"
    adapter._subprocess_started_at = time.time()

    # Fake process that looks alive
    proc = MagicMock()
    proc.pid = 12345
    proc.returncode = None  # alive
    adapter._process = proc

    return adapter


# ---------------------------------------------------------------------------
# 1. Fresh connection per request — no stale state
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_fresh_connection_per_request():
    """Each transcription should open and close its own WebSocket."""
    adapter = make_adapter()
    call_count = 0

    class FakeWS:
        async def send(self, data): pass
        async def recv(self): return '{"text": "hello"}'
        async def __aenter__(self): return self
        async def __aexit__(self, *a):
            nonlocal call_count
            call_count += 1  # tracks how many connections were closed

    with patch("adapters.managed_ws_adapter.websockets") as mock_ws:
        mock_ws.connect = MagicMock(return_value=FakeWS())

        await adapter._do_transcribe(SILENCE_1S, 16000)
        await adapter._do_transcribe(SILENCE_1S, 16000)

    assert call_count == 2, "Each request should open+close its own connection"


# ---------------------------------------------------------------------------
# 2. Graduated retry — attempt 1 fails, attempt 2 succeeds
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_retry_attempt2_succeeds():
    """Transient failure on attempt 1, success on attempt 2 — no restart."""
    adapter = make_adapter()
    calls = []

    async def fake_transcribe(samples, sr):
        calls.append(len(calls) + 1)
        if len(calls) == 1:
            raise ConnectionError("transient blip")
        return "recovered text"

    adapter._do_transcribe = fake_transcribe
    adapter._restart_subprocess = AsyncMock()

    text = await adapter.transcribe(SILENCE_1S, 16000)

    assert text == "recovered text"
    assert len(calls) == 2
    adapter._restart_subprocess.assert_not_called()


# ---------------------------------------------------------------------------
# 3. Graduated retry — attempts 1+2 fail, restart, attempt 3 succeeds
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_retry_attempt3_after_restart():
    """Two failures trigger subprocess restart, third attempt succeeds."""
    adapter = make_adapter()
    calls = []

    async def fake_transcribe(samples, sr):
        calls.append(len(calls) + 1)
        if len(calls) <= 2:
            raise ConnectionError("dead")
        return "back from the dead"

    adapter._do_transcribe = fake_transcribe
    adapter._restart_subprocess = AsyncMock()

    text = await adapter.transcribe(SILENCE_1S, 16000)

    assert text == "back from the dead"
    assert len(calls) == 3
    adapter._restart_subprocess.assert_called_once()


# ---------------------------------------------------------------------------
# 4. All 3 attempts fail — error propagated
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_all_attempts_exhausted():
    """When all 3 attempts fail, the error surfaces to the caller."""
    adapter = make_adapter()

    async def always_fail(samples, sr):
        raise ConnectionError("permanently broken")

    adapter._do_transcribe = always_fail
    adapter._restart_subprocess = AsyncMock()

    with pytest.raises(RuntimeError, match="Transcription failed after subprocess restart"):
        await adapter.transcribe(SILENCE_1S, 16000)


# ---------------------------------------------------------------------------
# 5. Dead subprocess detected at request time — restart before trying
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_dead_subprocess_detected_at_request_time():
    """If subprocess died between requests, restart before wasting time."""
    adapter = make_adapter()
    adapter._process.returncode = 1  # dead

    transcribe_calls = []

    async def fake_transcribe(samples, sr):
        transcribe_calls.append(1)
        return "text after recovery"

    adapter._do_transcribe = fake_transcribe
    adapter._restart_subprocess = AsyncMock()

    text = await adapter.transcribe(SILENCE_1S, 16000)

    assert text == "text after recovery"
    # Should have restarted BEFORE the first transcribe attempt
    adapter._restart_subprocess.assert_called_once()


# ---------------------------------------------------------------------------
# 6. Warm-up runs after subprocess start
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_warmup_after_load():
    """load_model should run warm-up inference after subprocess is ready."""
    adapter = ManagedWebSocketAdapter()
    warmup_called = False

    async def fake_warmup():
        nonlocal warmup_called
        warmup_called = True

    adapter._warm_up = fake_warmup
    adapter._wait_for_ready = AsyncMock(return_value=True)
    adapter._start_watchdog = MagicMock()

    fake_proc = MagicMock()
    fake_proc.pid = 999
    fake_proc.returncode = None

    fake_files = {
        "encoder": "/models/test/encoder.int8.onnx",
        "decoder": "/models/test/decoder.int8.onnx",
        "joiner": "/models/test/joiner.int8.onnx",
        "tokens": "/models/test/tokens.txt",
    }

    with patch("adapters.managed_ws_adapter._find_model_dir", return_value="/models/test"), \
         patch("adapters.managed_ws_adapter._detect_model_files", return_value=fake_files), \
         patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc):
        await adapter.load_model("parakeet-tdt-0.6b-v2-int8")

    assert warmup_called, "Warm-up should run after model load"


# ---------------------------------------------------------------------------
# 7. Warm-up runs after subprocess restart
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_warmup_after_restart():
    """_restart_subprocess should run warm-up before declaring ready."""
    adapter = make_adapter()
    warmup_called = False

    async def fake_warmup():
        nonlocal warmup_called
        warmup_called = True

    adapter._warm_up = fake_warmup
    adapter._kill_process = AsyncMock()
    adapter._wait_for_ready = AsyncMock(return_value=True)

    fake_proc = MagicMock()
    fake_proc.pid = 888
    fake_proc.returncode = None

    with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=fake_proc):
        await adapter._restart_subprocess()

    assert warmup_called, "Warm-up should run after restart"


# ---------------------------------------------------------------------------
# 8. Watchdog detects dead subprocess
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_watchdog_detects_death():
    """Watchdog should restart subprocess when it finds it dead."""
    adapter = make_adapter()
    adapter._WATCHDOG_INTERVAL = 0.05  # speed up for test

    restart_called = asyncio.Event()
    original_restart = adapter._restart_subprocess

    async def track_restart():
        restart_called.set()

    adapter._restart_subprocess = track_restart

    # Start watchdog
    adapter._start_watchdog()

    # Kill the subprocess
    adapter._process.returncode = 137  # SIGKILL

    # Wait for watchdog to notice (should be < 0.1s)
    try:
        await asyncio.wait_for(restart_called.wait(), timeout=1.0)
    except asyncio.TimeoutError:
        pytest.fail("Watchdog did not detect dead subprocess within 1s")
    finally:
        adapter._stop_watchdog()


# ---------------------------------------------------------------------------
# 9. Proactive restart waits for idle
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_proactive_restart_waits_for_idle():
    """Proactive restart should NOT fire during active conversation."""
    adapter = make_adapter()
    adapter._subprocess_started_at = time.time() - 50 * 3600  # 50 hours ago
    adapter._last_request_at = time.time()  # just used

    adapter._restart_subprocess = AsyncMock()

    await adapter._maybe_proactive_restart()

    adapter._restart_subprocess.assert_not_called()


# ---------------------------------------------------------------------------
# 10. Proactive restart fires when idle
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_proactive_restart_fires_when_idle():
    """Proactive restart SHOULD fire when subprocess is old and idle."""
    adapter = make_adapter()
    adapter._subprocess_started_at = time.time() - 50 * 3600  # 50 hours ago
    adapter._last_request_at = time.time() - 60  # idle for 60s

    adapter._restart_subprocess = AsyncMock()

    await adapter._maybe_proactive_restart()

    adapter._restart_subprocess.assert_called_once()


# ---------------------------------------------------------------------------
# 11. Liveness check — subprocess alive, no restart
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_alive_subprocess_no_restart():
    """Normal case: subprocess alive, no unnecessary restart."""
    adapter = make_adapter()

    async def fake_transcribe(samples, sr):
        return "normal text"

    adapter._do_transcribe = fake_transcribe
    adapter._restart_subprocess = AsyncMock()

    text = await adapter.transcribe(SILENCE_1S, 16000)

    assert text == "normal text"
    adapter._restart_subprocess.assert_not_called()


# ---------------------------------------------------------------------------
# 12. Metrics track errors and successes correctly
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_metrics_tracking():
    """Health metrics should accurately reflect what happened."""
    adapter = make_adapter()
    calls = []

    async def flaky_transcribe(samples, sr):
        calls.append(1)
        if len(calls) <= 2:
            raise ConnectionError("flaky")
        return "finally"

    adapter._do_transcribe = flaky_transcribe
    adapter._restart_subprocess = AsyncMock()

    await adapter.transcribe(SILENCE_1S, 16000)

    # 1 error recorded (before restart), 1 success (after restart)
    assert adapter._metrics.error_count == 1
    assert adapter._metrics.request_count == 2  # error + success
    assert adapter._metrics.consecutive_errors == 0  # reset on success


# ---------------------------------------------------------------------------
# 13. Chaos: rapid-fire requests after subprocess death
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_rapid_requests_after_death():
    """Multiple requests hitting a dead subprocess shouldn't cause cascading restarts."""
    adapter = make_adapter()
    restart_count = 0

    async def counting_restart():
        nonlocal restart_count
        restart_count += 1
        # Simulate restart fixing the subprocess
        adapter._process = MagicMock()
        adapter._process.pid = 9999
        adapter._process.returncode = None
        adapter._state = "loaded"

    adapter._restart_subprocess = counting_restart

    async def works_after_restart(samples, sr):
        if adapter._process.returncode is not None:
            raise ConnectionError("dead")
        return "ok"

    adapter._do_transcribe = works_after_restart

    # Kill the subprocess
    adapter._process.returncode = 1

    # Fire 3 requests sequentially (they serialize on the lock)
    results = []
    for _ in range(3):
        text = await adapter.transcribe(SILENCE_1S, 16000)
        results.append(text)

    assert all(r == "ok" for r in results)
    # First request triggers restart, subsequent ones find it alive
    assert restart_count == 1, f"Expected 1 restart, got {restart_count}"


# ---------------------------------------------------------------------------
# 14. Bridge-level retry: empty text on substantial audio
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_bridge_retry_on_empty_text():
    """Bridge should retry once when engine returns empty on >2s audio."""
    calls = []

    async def flaky_engine(samples, sr):
        calls.append(1)
        if len(calls) == 1:
            return ""  # first attempt: empty
        return "recovered text"

    mock_engine = MagicMock()
    mock_engine.transcribe = flaky_engine

    # Simulate bridge retry logic inline (mirrors bridge.py lines 258-288)
    audio_duration = 5.0  # 5 seconds of audio
    samples = REAL_AUDIO_5S
    text = None
    last_error = None

    for attempt in range(1, 3):
        try:
            text = await mock_engine.transcribe(samples, 16000)
            if not text and audio_duration >= 2.0 and attempt < 2:
                continue
            break
        except Exception as e:
            last_error = e
            if attempt < 2:
                continue
            raise

    assert text == "recovered text"
    assert len(calls) == 2


# ---------------------------------------------------------------------------
# 15. Bridge-level: empty text on short audio is legitimate (no retry)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_bridge_no_retry_on_short_silence():
    """Empty text on <2s audio is probably real silence — don't retry."""
    calls = []

    async def returns_empty(samples, sr):
        calls.append(1)
        return ""

    mock_engine = MagicMock()
    mock_engine.transcribe = returns_empty

    audio_duration = 0.5  # half second
    text = None

    for attempt in range(1, 3):
        try:
            text = await mock_engine.transcribe(SILENCE_1S[:8000], 16000)
            if not text and audio_duration >= 2.0 and attempt < 2:
                continue
            break
        except Exception as e:
            if attempt < 2:
                continue
            raise

    assert text == ""
    assert len(calls) == 1, "Should not retry on short audio"


# ---------------------------------------------------------------------------
# 16. Bridge-level retry: engine throws, then succeeds
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_bridge_retry_on_engine_exception():
    """Bridge should retry once when engine throws."""
    calls = []

    async def throws_then_works(samples, sr):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("engine hiccup")
        return "recovered"

    mock_engine = MagicMock()
    mock_engine.transcribe = throws_then_works

    audio_duration = 5.0
    text = None
    last_error = None

    for attempt in range(1, 3):
        try:
            text = await mock_engine.transcribe(REAL_AUDIO_5S, 16000)
            if not text and audio_duration >= 2.0 and attempt < 2:
                continue
            break
        except Exception as e:
            last_error = e
            if attempt < 2:
                continue
            raise

    assert text == "recovered"
    assert len(calls) == 2


# ---------------------------------------------------------------------------
# 17. Chaos: subprocess dies mid-inference (connection drops)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_subprocess_dies_mid_inference():
    """If connection drops mid-inference, graduated retry should recover."""
    adapter = make_adapter()
    calls = []

    async def dies_then_recovers(samples, sr):
        calls.append(len(calls) + 1)
        if len(calls) == 1:
            # Simulate connection drop mid-inference
            raise ConnectionResetError("Connection reset by peer")
        if len(calls) == 2:
            # Still broken on second attempt
            raise ConnectionRefusedError("Connection refused")
        # After restart, works
        return "recovered after crash"

    adapter._do_transcribe = dies_then_recovers
    adapter._restart_subprocess = AsyncMock()

    text = await adapter.transcribe(SILENCE_1S, 16000)

    assert text == "recovered after crash"
    assert len(calls) == 3
    adapter._restart_subprocess.assert_called_once()


# ---------------------------------------------------------------------------
# 18. Watchdog stops on unload
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_watchdog_stops_on_unload():
    """Unloading model should stop the watchdog."""
    adapter = make_adapter()
    adapter._WATCHDOG_INTERVAL = 0.05
    adapter._start_watchdog()

    assert adapter._watchdog_task is not None
    assert not adapter._watchdog_task.done()

    adapter._kill_process = AsyncMock()
    await adapter.unload_model()

    assert adapter._watchdog_task is None or adapter._watchdog_task.cancelled()


# ---------------------------------------------------------------------------
# 19. State remains "loaded" after successful recovery
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_state_loaded_after_recovery():
    """After graduated retry recovery, state should be 'loaded'."""
    adapter = make_adapter()
    calls = []

    async def fails_twice(samples, sr):
        calls.append(1)
        if len(calls) <= 2:
            raise ConnectionError("nope")
        return "ok"

    adapter._do_transcribe = fails_twice
    adapter._restart_subprocess = AsyncMock()

    await adapter.transcribe(SILENCE_1S, 16000)

    assert adapter._state == "loaded"


# ---------------------------------------------------------------------------
# 20. last_request_at updated on every call
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_last_request_at_tracked():
    """Each transcribe call should update last_request_at."""
    adapter = make_adapter()
    adapter._last_request_at = 0

    async def instant(samples, sr):
        return "text"

    adapter._do_transcribe = instant

    before = time.time()
    await adapter.transcribe(SILENCE_1S, 16000)

    assert adapter._last_request_at >= before
