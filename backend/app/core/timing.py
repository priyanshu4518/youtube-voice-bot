"""Per-request latency tracking.

`stage("name")` records how long a block took. The middleware logs every request with its
stages and returns them in a standard `Server-Timing` header (visible in Chrome DevTools ->
Network -> Timing, or with `curl -i`).
"""
import logging
import time
from contextlib import contextmanager
from contextvars import ContextVar

log = logging.getLogger("app.timing")
_stages: ContextVar[dict[str, float] | None] = ContextVar("stages", default=None)


@contextmanager
def stage(name: str):
    t0 = time.perf_counter()
    try:
        yield
    finally:
        stages = _stages.get()
        if stages is not None:
            stages[name] = stages.get(name, 0.0) + (time.perf_counter() - t0) * 1000


def record(name: str, ms: float) -> None:
    stages = _stages.get()
    if stages is not None:
        stages[name] = ms


class TimingMiddleware:
    """Pure ASGI middleware, so it works with streaming responses. `total` is the time until
    the response starts (time to first byte); the log line also has `complete`, the time until
    the last byte was sent."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        stages: dict[str, float] = {}
        token = _stages.set(stages)
        t0 = time.perf_counter()
        status = 500

        async def send_with_timing(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                stages["total"] = (time.perf_counter() - t0) * 1000
                value = ", ".join(f"{k};dur={v:.1f}" for k, v in stages.items())
                message["headers"] = [*message.get("headers", []), (b"server-timing", value.encode())]
            await send(message)

        try:
            await self.app(scope, receive, send_with_timing)
        finally:
            _stages.reset(token)
            stages["complete"] = (time.perf_counter() - t0) * 1000  # includes the streamed body
            parts = " ".join(f"{k}={v:.0f}ms" for k, v in stages.items())
            log.info("%s %s -> %s  %s", scope["method"], scope["path"], status, parts)
