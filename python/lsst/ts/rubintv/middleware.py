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

"""Request correlation, timing and compression middleware.

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

``CompressionMiddleware`` gzips the text responses (JSON, the SPA's assets)
and leaves media alone.
"""

from __future__ import annotations

import asyncio
import gzip
import time
import zlib
from concurrent.futures import ThreadPoolExecutor
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

    Read inside ``CompressionMiddleware`` (which wraps this one), so it is
    the uncompressed size, unless the handler sent the body compressed
    itself (a whole metadata document, from its stored compressed copy). A
    streamed body (the S3 proxy) is chunked, has no ``Content-Length``, and
    reports ``None``.
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


# What is worth compressing: the JSON API and the SPA's text assets. The
# rest of what the app serves is media that is compressed already (the S3
# proxy's PNGs, JPEGs and MP4s, the thumbnails), where gzip costs CPU and
# saves nothing.
_COMPRESSIBLE_TYPES = (
    "text/",
    "application/json",
    "application/javascript",
    "image/svg+xml",
)

# A whole body this large is compressed on a worker thread, not the event
# loop: a 16 MiB metadata response takes about 0.4 s at level 6, during
# which nothing else would be served. zlib releases the GIL while it works.
_OFFLOAD_BYTES = 64 * 1024

# The pool is this module's own, so a default executor full of slow S3 calls
# can't hold responses up behind it.
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="gzip")


def accepts_gzip(headers: Headers) -> bool:
    """Whether a request's sender takes a gzipped response."""
    return "gzip" in headers.get("accept-encoding", "")


def _compressible(message: Message) -> bool:
    """Whether a response (by its start message) is one to compress.

    Never a 206: its ``Content-Range`` counts the uncompressed bytes, so a
    compressed part can't be put back together by the client.
    """
    if message["status"] == 206:
        return False
    headers = Headers(scope=message)
    content_type = headers.get("content-type", "")
    return (
        "content-encoding" not in headers
        and content_type.startswith(_COMPRESSIBLE_TYPES)
        # A compressor holds bytes back; an event stream must not wait.
        and not content_type.startswith("text/event-stream")
    )


class CompressionMiddleware:
    """Gzip text responses, large ones off the event loop.

    Stands in for Starlette's ``GZipMiddleware``, which compresses every
    response whatever its type (media and 206 ranges included), at level 9,
    on the event loop: a 16 MiB metadata response stalled every other
    request and the WebSocket fan-out for about two seconds.

    Args:
        app: The app to wrap.
        minimum_size: Whole bodies shorter than this are sent as they are;
            the overhead outweighs the gain.
        compresslevel: zlib level. On metadata JSON, 6 comes out about 5%
            larger than 9 in a fifth of the time.
    """

    def __init__(
        self, app: ASGIApp, minimum_size: int = 1024, compresslevel: int = 6
    ) -> None:
        self.app = app
        self.minimum_size = minimum_size
        self.compresslevel = compresslevel

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        gzip_accepted = accepts_gzip(Headers(scope=scope))
        # A compressible response's start message is held until its first
        # body message, which decides the headers.
        start: Message | None = None
        deflate: zlib._Compress | None = None

        async def send_compressed(message: Message) -> None:
            nonlocal start, deflate
            if message["type"] == "http.response.start" and _compressible(message):
                start = message
                return
            if message["type"] != "http.response.body":
                # Anything else (a file sent by path, trailers) goes as is.
                if start is not None:
                    await send(start)
                    start = None
                await send(message)
                return
            body = message.get("body", b"")
            more_body = message.get("more_body", False)
            if start is not None:
                held, start = start, None
                if more_body or len(body) >= self.minimum_size:
                    headers = MutableHeaders(scope=held)
                    headers.add_vary_header("Accept-Encoding")
                    if gzip_accepted:
                        headers["Content-Encoding"] = "gzip"
                        if more_body:
                            # A stream: compressed chunk by chunk below.
                            del headers["Content-Length"]
                            deflate = zlib.compressobj(
                                self.compresslevel, zlib.DEFLATED, 31
                            )
                        else:
                            body = await self._compress(body)
                            headers["Content-Length"] = str(len(body))
                            message = {**message, "body": body}
                await send(held)
            if deflate is not None:
                body = deflate.compress(body)
                if not more_body:
                    body += deflate.flush()
                message = {**message, "body": body}
            await send(message)

        await self.app(scope, receive, send_compressed)

    async def _compress(self, body: bytes) -> bytes:
        if len(body) < _OFFLOAD_BYTES:
            return gzip.compress(body, self.compresslevel)
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            _pool, gzip.compress, body, self.compresslevel
        )
