# This file is part of rubintv-v3.
#
# Developed for the Vera C. Rubin Observatory Telescope and Site Systems.
# This product includes software developed by the LSST Project
# (https://www.lsst.org).
# See the COPYRIGHT file at the top-level directory of this distribution
# for details of code ownership.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

"""Request correlation and timing middleware.

Binds a per-request id into structlog's contextvars so every log line
emitted while handling a request carries it. Honours an inbound
``X-Request-ID`` (from the reverse proxy) or generates one, and echoes it
back on the response.

Every request is also summarised as an ``http.request`` debug event with
its duration and response size, so the data flow can be measured from the
logs alone (``scripts/flow_summary.py`` aggregates them).
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from uuid import uuid4

import structlog
from lsst.ts.rubintv.logging import get_logger
from starlette.requests import Request
from starlette.responses import Response

log = get_logger(__name__)

Handler = Callable[[Request], Awaitable[Response]]


def response_bytes(response: Response) -> int | None:
    """The response body size, or ``None`` when it streams without one.

    Measured before the gzip middleware (which wraps this one), so it is
    the uncompressed size. Proxied S3 objects stream with the object's
    ``Content-Length``; a chunked body has none and reports ``None``.
    """
    raw = response.headers.get("content-length")
    return int(raw) if raw is not None and raw.isdigit() else None


async def correlation_middleware(request: Request, call_next: Handler) -> Response:
    request_id = request.headers.get("X-Request-ID") or str(uuid4())
    structlog.contextvars.bind_contextvars(request_id=request_id)
    started = time.perf_counter()
    try:
        response = await call_next(request)
        # Duration is to response headers: a streamed body (proxy, large
        # metadata) is still in flight here, so this measures the handler,
        # not the transfer.
        log.debug(
            "http.request",
            method=request.method,
            path=request.url.path,
            status=response.status_code,
            duration_ms=round((time.perf_counter() - started) * 1000, 1),
            bytes=response_bytes(response),
        )
    finally:
        structlog.contextvars.clear_contextvars()
    response.headers["X-Request-ID"] = request_id
    return response
