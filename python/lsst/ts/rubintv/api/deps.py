"""FastAPI dependencies for reaching shared application state.

Handlers depend on these rather than touching ``request.app.state``
directly, so the wiring is typed and mockable in tests.
"""

from __future__ import annotations

import re

from fastapi import Depends, HTTPException, Request, status
from lsst.ts.rubintv.config.models import Camera, Location, Models
from lsst.ts.rubintv.state import AppState

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


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
    """Validate a YYYY-MM-DD path param, 422 if malformed."""
    if not _DATE_RE.match(date):
        # 422 Unprocessable Content (the status constant name varies across
        # Starlette versions, so use the code directly).
        raise HTTPException(422, f"date must be YYYY-MM-DD, got: {date}")
    return date
