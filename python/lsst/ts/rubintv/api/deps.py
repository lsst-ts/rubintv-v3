"""FastAPI dependencies for reaching shared application state.

Handlers depend on these rather than touching ``request.app.state``
directly, so the wiring is typed and mockable in tests.
"""

from __future__ import annotations

import datetime
import re

from fastapi import Depends, HTTPException, Request, status
from lsst.ts.rubintv.config.models import Camera, Location, Models
from lsst.ts.rubintv.state import AppState

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# A conservative allow-list for path segments that flow into S3 keys/prefixes
# and response headers (channel, seq, night-report group/filename). Permit
# only characters that appear in real keys — no "/", no "..", no control
# chars — so a crafted segment can't traverse to another prefix or corrupt a
# header.
_SAFE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def safe_segment(value: str, *, field: str) -> str:
    """Validate one path segment against the safe allow-list, 422 if not.

    ``..`` is rejected explicitly (it matches the char class) so a segment can
    never walk up a prefix, and control/quote characters that would break the
    ``Content-Disposition`` header can't reach it.
    """
    if value == ".." or not _SAFE_SEGMENT_RE.match(value):
        raise HTTPException(422, f"invalid {field}: {value!r}")
    return value


def get_app_state(request: Request) -> AppState:
    """Return the assembled application state."""
    return request.app.state.app_state  # type: ignore[no-any-return]


def get_models(request: Request) -> Models:
    """Return the validated config model tree."""
    state: AppState = request.app.state.app_state
    return state.models


def get_location(location: str, models: Models = Depends(get_models)) -> Location:
    """Resolve a location path param, 404 if unknown."""
    loc = models.location(location)
    if loc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"unknown location: {location}")
    return loc


def get_camera(camera: str, location: Location = Depends(get_location)) -> Camera:
    """Resolve a camera path param within a location, 404 if unknown."""
    cam = location.camera(camera)
    if cam is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"unknown camera {camera!r} at location {location.name!r}",
        )
    return cam


def valid_date(date: str) -> str:
    """Validate a YYYY-MM-DD path param, 422 if malformed.

    The shape check alone would admit calendar-impossible dates like
    2026-99-99 — and every *distinct* unindexed date can trigger an on-demand
    S3 listing (see ``PollEngine.scan_date``), so enumeration of impossible
    dates would amplify cheap requests into S3 load. Require a real date.
    """
    if not _DATE_RE.match(date):
        # 422 Unprocessable Content (the status constant name varies across
        # Starlette versions, so use the code directly).
        raise HTTPException(422, f"date must be YYYY-MM-DD, got: {date}")
    try:
        datetime.date(int(date[0:4]), int(date[5:7]), int(date[8:10]))
    except ValueError:
        raise HTTPException(422, f"not a real calendar date: {date}") from None
    return date
