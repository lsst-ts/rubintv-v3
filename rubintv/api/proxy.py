"""S3 object proxy with ETag revalidation and range support.

Streams an S3 object through to the browser. The key is built from path
params and validated before any S3 call. Caching uses ETag revalidation
(honour ``If-None-Match`` -> 304) rather than ``immutable``, since even
historical images can theoretically be replaced. Range requests are passed
through for video scrubbing.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import Response, StreamingResponse

from rubintv.api.deps import get_app_state, get_camera, get_location, valid_date
from rubintv.config.models import Camera, Location
from rubintv.state import AppState

if TYPE_CHECKING:
    from mypy_boto3_s3.client import S3Client

router = APIRouter()

# Cache an hour, allow serving stale for a day while revalidating.
_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400"


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
    # Channels may override the path segment used in S3 keys (Channel.prefix);
    # the URL uses the channel *name*, but the bucket may store under a
    # different prefix.
    ch = camera.channel(channel)
    channel_segment = ch.prefix if ch is not None and ch.prefix else channel
    key = f"{camera.name}/{date}/{channel_segment}/{seq}/{filename}"
    client: S3Client = state.s3.client_for(location.name)
    bucket = location.bucket

    get_kwargs: dict[str, str] = {"Bucket": bucket, "Key": key}
    if if_none_match is not None:
        get_kwargs["IfNoneMatch"] = if_none_match
    if range_header is not None:
        get_kwargs["Range"] = range_header

    try:
        obj = client.get_object(**get_kwargs)  # type: ignore[arg-type]
    except client.exceptions.NoSuchKey:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"no object: {key}") from None
    except client.exceptions.ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        if code == "304":
            return Response(status_code=status.HTTP_304_NOT_MODIFIED)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "upstream S3 error") from exc

    headers = {
        "Cache-Control": _CACHE_CONTROL,
        "ETag": obj.get("ETag", ""),
        "Accept-Ranges": "bytes",
    }
    if "ContentRange" in obj:
        headers["Content-Range"] = obj["ContentRange"]
    status_code = (
        status.HTTP_206_PARTIAL_CONTENT
        if range_header is not None
        else status.HTTP_200_OK
    )
    return StreamingResponse(
        obj["Body"].iter_chunks(),
        status_code=status_code,
        media_type=obj.get("ContentType", "application/octet-stream"),
        headers=headers,
    )
