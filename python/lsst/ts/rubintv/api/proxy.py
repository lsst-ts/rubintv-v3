"""S3 object proxy with ETag revalidation and range support.

Streams an S3 object through to the browser. The S3 key for a (channel,
date, seq) is resolved by listing the seq prefix — the bucket may store
the artifact under any filename, so we don't require the caller to know
it. The URL-provided filename is treated as a *download name suggestion*
and returned via ``Content-Disposition`` so saved files include channel,
date and seq for the user.

Caching uses ETag revalidation (honour ``If-None-Match`` -> 304) rather
than ``immutable``, since even historical images can theoretically be
replaced. Range requests are passed through for video scrubbing.
"""

from __future__ import annotations

import mimetypes
from typing import TYPE_CHECKING, TypedDict

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import Response, StreamingResponse
from lsst.ts.rubintv.api.deps import (
    get_app_state,
    get_camera,
    get_location,
    safe_segment,
    valid_date,
)
from lsst.ts.rubintv.config.models import Camera, Location
from lsst.ts.rubintv.logging import get_logger
from lsst.ts.rubintv.state import AppState
from starlette.background import BackgroundTask

if TYPE_CHECKING:
    from mypy_boto3_s3.client import S3Client
    from mypy_boto3_s3.type_defs import GetObjectOutputTypeDef as GetObjectResult

log = get_logger(__name__)

router = APIRouter()

# Cache an hour, allow serving stale for a day while revalidating.
_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400"


class ConditionalArgs(TypedDict, total=False):
    """Pass-through conditional/range headers forwarded to ``get_object``."""

    IfNoneMatch: str
    Range: str


@router.get(
    "/locations/{location}/cameras/{camera}/channels/{channel}/{date}/{seq}/{filename}"
)
def proxy_object(
    request: Request,
    channel: str,
    seq: str,
    filename: str,
    date: str = Depends(valid_date),
    location: Location = Depends(get_location),
    camera: Camera = Depends(get_camera),
    state: AppState = Depends(get_app_state),
    if_none_match: str | None = Header(default=None),
    range_header: str | None = Header(default=None, alias="Range"),
) -> Response:
    # Validate the free-form path segments before they flow into S3 key/prefix
    # construction and the Content-Disposition header: reject "/", "..", quotes
    # and control chars so a crafted URL can't traverse prefixes or corrupt the
    # response header (date/location/camera are already validated by deps).
    safe_segment(channel, field="channel")
    safe_segment(seq, field="seq")
    safe_segment(filename, field="filename")

    # Channels may override the path segment used in S3 keys (Channel.prefix);
    # the URL uses the channel *name*, but the bucket may store under a
    # different prefix.
    ch = camera.channel(channel)
    channel_segment = ch.prefix if ch is not None and ch.prefix else channel
    prefix = f"{camera.name}/{date}/{channel_segment}/{seq}/"
    client: S3Client = state.s3.client_for(location.name)
    bucket = location.bucket

    # Object keys follow a fixed convention — the seq directory holds a single
    # file named for the artifact it identifies:
    #   {camera}/{date}/{segment}/{seq}/{camera}_{channel}_{date}_{seq}.{ext}
    #   e.g. lsstcam/2026-05-28/witness_detector/000759/
    #            lsstcam_witness_detector_2026-05-28_000759.jpg
    # The filename stem uses the channel *name* (not the prefix segment). So we
    # can build the key directly from the URL's extension and GET it without a
    # LIST. The LIST is kept only as a fallback for any object that doesn't
    # follow the convention (legacy data, unexpected filename).
    conditional: ConditionalArgs = {}
    if if_none_match is not None:
        conditional["IfNoneMatch"] = if_none_match
    if range_header is not None:
        conditional["Range"] = range_header

    ext = filename.rsplit(".", 1)[-1] if "." in filename else None
    obj: GetObjectResult | None = None
    key: str | None = None
    if ext is not None:
        # Try the convention key directly (the common case): no LIST.
        key = f"{prefix}{camera.name}_{channel}_{date}_{seq}.{ext}"
        result = _get_object(client, bucket, key, conditional)
        if isinstance(result, Response):
            return result  # 304 Not Modified
        obj = result  # None on a miss -> fall through to listing

    if obj is None:
        # Convention miss (or no extension supplied): resolve by listing.
        key = _resolve_key(client, bucket, prefix)
        if key is None:
            log.info("proxy.miss", location=location.name, prefix=prefix)
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, f"no object under prefix: {prefix}"
            )
        result = _get_object(client, bucket, key, conditional)
        if isinstance(result, Response):
            return result  # 304 Not Modified
        if result is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"no object: {key}")
        obj = result

    # Build a stable download name so files saved by the browser identify
    # camera/channel/date/seq (e.g. allsky_stills_2026-05-28_000966.jpg).
    # key is set wherever obj is (fast-path convention key, or the listed key).
    assert key is not None
    out_ext = ext if ext is not None else key.rsplit(".", 1)[-1]
    download_name = f"{camera.name}_{channel}_{date}_{seq}.{out_ext}"
    return _stream_object(obj, download_name, range_header is not None)


@router.get(
    "/locations/{location}/cameras/{camera}/night-report/{date}/plot/{group}/{filename}"
)
def proxy_night_report_plot(
    group: str,
    filename: str,
    date: str = Depends(valid_date),
    location: Location = Depends(get_location),
    camera: Camera = Depends(get_camera),
    state: AppState = Depends(get_app_state),
    if_none_match: str | None = Header(default=None),
    range_header: str | None = Header(default=None, alias="Range"),
) -> Response:
    # Validate the free-form segments before building the key — otherwise a
    # crafted group/filename (encoded "/", "..") could read arbitrary objects
    # under the bucket rather than just night-report plots.
    safe_segment(group, field="group")
    safe_segment(filename, field="filename")

    # Night-report plot keys are fully known (no resolution by listing): the
    # key shape is {camera}/{date}/night_report/{group}/{filename} (parser §3).
    # We GET that exact key directly.
    key = f"{camera.name}/{date}/night_report/{group}/{filename}"
    client: S3Client = state.s3.client_for(location.name)
    bucket = location.bucket

    conditional: ConditionalArgs = {}
    if if_none_match is not None:
        conditional["IfNoneMatch"] = if_none_match
    if range_header is not None:
        conditional["Range"] = range_header

    result = _get_object(client, bucket, key, conditional)
    if isinstance(result, Response):
        return result  # 304 Not Modified
    if result is None:
        log.info("proxy.nr_plot.miss", location=location.name, key=key)
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"no object: {key}")
    return _stream_object(result, filename, range_header is not None)


def _media_type_for(obj: GetObjectResult, download_name: str) -> str:
    """Pick the response content type.

    S3 objects are often stored with a generic ``application/octet-stream``
    ContentType (the uploader didn't set one), which makes browsers *download*
    an image rather than render it inline. Prefer a type guessed from the
    filename extension so images/videos open in a new tab; fall back to S3's
    stored type only when the extension is unknown.
    """
    guessed, _ = mimetypes.guess_type(download_name)
    stored = obj.get("ContentType", "")
    # S3/moto report an unset type as "application/octet-stream" or
    # "binary/octet-stream"; both make browsers download rather than render.
    if stored and not stored.endswith("octet-stream"):
        return stored
    return guessed or stored or "application/octet-stream"


def _stream_object(
    obj: GetObjectResult, download_name: str, is_range: bool
) -> StreamingResponse:
    """Stream a fetched S3 object to the browser with caching headers.

    ``download_name`` is offered via ``Content-Disposition`` so saved files
    have a meaningful name. The status is 206 only when S3 actually honoured
    the range (it returned a ``ContentRange``); a request that carried a Range
    header S3 ignored — e.g. a syntactically-odd range on a full-body reply —
    must be a plain 200, not a 206 with no ``Content-Range`` (which is
    protocol-invalid and breaks range-aware clients).
    """
    headers = {
        "Cache-Control": _CACHE_CONTROL,
        "ETag": obj.get("ETag", ""),
        "Accept-Ranges": "bytes",
        "Content-Disposition": f'inline; filename="{download_name}"',
    }
    served_partial = "ContentRange" in obj
    if served_partial:
        headers["Content-Range"] = obj["ContentRange"]
    status_code = (
        status.HTTP_206_PARTIAL_CONTENT
        if is_range and served_partial
        else status.HTTP_200_OK
    )
    body = obj["Body"]
    return StreamingResponse(
        body.iter_chunks(),
        status_code=status_code,
        media_type=_media_type_for(obj, download_name),
        headers=headers,
        # Explicitly release the S3 streaming body when the response
        # finishes — including when the browser aborts (video scrub / tab
        # close, the common case for movies). Without this the connection
        # stays checked out of the per-location client pool (shared with
        # interactive metadata fetches) until GC finalises it, so heavy
        # scrubbing can transiently exhaust it.
        background=BackgroundTask(body.close),
    )


def _get_object(
    client: S3Client, bucket: str, key: str, conditional: ConditionalArgs
) -> GetObjectResult | Response | None:
    """Fetch an object, mapping S3 outcomes to the proxy's control flow.

    Returns the object on success, ``None`` if the key is absent (caller may
    fall back to listing), or a 304 ``Response`` when the client's
    ``If-None-Match`` matched. An unsatisfiable Range maps to 416 (so a player
    scrubbing past EOF gets a clamp signal, not a 502). Any other S3 error
    becomes a 502.
    """
    try:
        return client.get_object(Bucket=bucket, Key=key, **conditional)
    except client.exceptions.NoSuchKey:
        return None
    except client.exceptions.ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        if code == "304":
            return Response(status_code=status.HTTP_304_NOT_MODIFIED)
        if code in ("NoSuchKey", "404"):
            return None
        if code in ("InvalidRange", "416"):
            # Range past EOF (e.g. the object was replaced by a shorter file):
            # a proper 416 lets the client re-request, unlike an opaque 502.
            return Response(status_code=status.HTTP_416_RANGE_NOT_SATISFIABLE)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "upstream S3 error") from exc


def _resolve_key(client: S3Client, bucket: str, prefix: str) -> str | None:
    """Return the single object key under ``prefix``, or ``None`` if absent.

    The seq directory should contain exactly one artifact; if S3 returns
    more (legacy data), the first is used.
    """
    resp = client.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=1)
    contents = resp.get("Contents") or []
    if not contents:
        return None
    return contents[0]["Key"]
