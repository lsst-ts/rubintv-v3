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

Every request is also summarised as an ``http.request`` event with its
duration and response size, so the data flow can be measured from the
logs alone (``scripts/flow_summary.py`` aggregates them). It is the app's
access log, standing in for uvicorn's plain-text one (silenced in
``configure_logging``): ``info``, except for routine traffic (see
``_routine``), which logs at ``debug``.

This is a plain ASGI middleware, not Starlette's BaseHTTPMiddleware
(``@app.middleware("http")``). That one relays the body through a response
of its own, which it ends normally even when the app raises mid-stream, so
a proxied S3 object whose read broke reached the client as a short body
that looked whole (and was cacheable). Here an unfinished response stays
unfinished and the server closes the connection; see ``ResponseAborted``.
"""

from __future__ import annotations

import time
from uuid import uuid4

import structlog
from lsst.ts.rubintv.logging import get_logger
from starlette.datastructures import Headers, MutableHeaders
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

log = get_logger(__name__)


class ResponseAborted(Exception):
    """Abort a response that is already under way.

    Raised from a streaming body that can't be completed (the S3 proxy, once
    a broken upstream read can't be resumed). The status and headers are
    out, so it can't become an error response; instead the response is left
    unfinished and the server closes the connection, so the client sees a
    failed transfer rather than a truncated body passed off as complete.
    The raiser logs the cause, and ``CorrelationMiddleware`` swallows the
    exception so the server doesn't log a traceback for it as well.
    """


def response_bytes(headers: Headers) -> int | None:
    """The response body size from its headers, or ``None`` without one.

    Read inside the gzip middleware (which wraps this one), so it is the
    uncompressed size. A streamed body (the S3 proxy) is chunked, has no
    ``Content-Length``, and reports ``None``.
    """
    raw = headers.get("content-length")
    return int(raw) if raw is not None and raw.isdigit() else None


def _routine(request: Request, status: int) -> bool:
    """Whether a request is routine traffic, logged at debug, not info.

    That is the kubelet's probes (on bare ``/`` and the redirect they
    follow into the prefix) and the S3 status pill's poll of
    ``/api/health/status``, every 5 s from each open camera page. Between
    them they were nearly every line of a pod's info log. A failed one
    (400 and up) isn't routine: it stays at info.
    """
    if status >= 400:
        return False
    probe = request.headers.get("user-agent", "").startswith("kube-probe/")
    return probe or request.url.path.endswith("/api/health/status")


class CorrelationMiddleware:
    """Tag each request with an id, echo it, and log its timing."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope)
        request_id = request.headers.get("X-Request-ID") or str(uuid4())
        structlog.contextvars.bind_contextvars(request_id=request_id)
        started = time.perf_counter()
        response_started = False

        async def send_with_id(message: Message) -> None:
            nonlocal response_started
            if message["type"] == "http.response.start":
                response_started = True
                headers = MutableHeaders(scope=message)
                headers["X-Request-ID"] = request_id
                # Duration is to response headers: a streamed body (proxy,
                # large metadata) is still in flight here, so this measures
                # the handler, not the transfer.
                emit = log.debug if _routine(request, message["status"]) else log.info
                emit(
                    "http.request",
                    method=request.method,
                    path=request.url.path,
                    status=message["status"],
                    duration_ms=round((time.perf_counter() - started) * 1000, 1),
                    bytes=response_bytes(headers),
                    # Who asked: the peer (in the cluster, the ingress or an
                    # in-cluster caller), the address the proxy says it
                    # forwarded for, and the user agent, which tells the
                    # page apart from a script.
                    client=request.client.host if request.client else None,
                    forwarded_for=request.headers.get("x-forwarded-for"),
                    user_agent=request.headers.get("user-agent"),
                )
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        except ResponseAborted:
            # Before the headers it's an ordinary error: let it become a 500.
            # After them, returning with the response unfinished makes the
            # server close the connection mid-body.
            if not response_started:
                raise
        finally:
            structlog.contextvars.clear_contextvars()
