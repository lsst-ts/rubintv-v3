"""Request correlation middleware.

Binds a per-request id into structlog's contextvars so every log line
emitted while handling a request carries it. Honours an inbound
``X-Request-ID`` (from the reverse proxy) or generates one, and echoes it
back on the response.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from uuid import uuid4

import structlog
from starlette.requests import Request
from starlette.responses import Response

Handler = Callable[[Request], Awaitable[Response]]


async def correlation_middleware(request: Request, call_next: Handler) -> Response:
    request_id = request.headers.get("X-Request-ID") or str(uuid4())
    structlog.contextvars.bind_contextvars(request_id=request_id)
    try:
        response = await call_next(request)
    finally:
        structlog.contextvars.clear_contextvars()
    response.headers["X-Request-ID"] = request_id
    return response
