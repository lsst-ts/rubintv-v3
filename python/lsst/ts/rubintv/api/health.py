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

"""Health endpoints for Kubernetes probes.

- ``/api/health/live`` — process is up (liveness).
- ``/api/health/ready`` — the data layer has loaded enough to serve
  traffic (readiness). Phase 1 reports ready once the app is assembled;
  Phase 2 gates this on the first completed poll.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status
from lsst.ts.rubintv import __version__
from lsst.ts.rubintv.api.deps import get_app_state
from lsst.ts.rubintv.state import AppState
from pydantic import BaseModel

router = APIRouter()


class LiveResponse(BaseModel):
    status: str
    version: str


class ReadyResponse(BaseModel):
    ready: bool


class CameraStatus(BaseModel):
    location: str
    camera: str
    recent_ready: bool
    """The recent-window scan for this camera has been applied; recent dates
    are viewable even while the full back-catalogue is still loading."""
    full_complete: bool
    """The camera's whole back-catalogue has been scanned at least once."""


class StatusResponse(BaseModel):
    ready: bool
    cache_enabled: bool
    """Whether a disk cache is configured. When false, every restart reloads
    all history from S3 — the frontend surfaces this as a misconfiguration."""
    warm_start: bool
    """Whether a cached snapshot populated the calendar at boot. When true,
    an in-progress scan is a refresh (older dates already showing); when
    false it is a cold load (older dates appear only as the sweep finds
    them)."""
    historical_loading: bool
    """True while the back-catalogue is still being scanned; the frontend
    shows a non-blocking 'still loading' affordance rather than an error."""
    s3_healthy: bool
    """Whether the last current-day poll cycle reached S3. False means the
    bucket endpoint was unreachable (e.g. a connect timeout); the frontend
    shows an 'S3 unreachable' alert beside the live indicator."""
    s3_slow: bool
    """Whether the last successful poll cycle was unusually slow. True warns of
    a degrading link before it fails outright; the frontend shows an amber
    'S3 slow' warning. Ignored when s3_healthy is false."""
    s3_last_cycle_seconds: float
    """Wall-clock seconds of the last successful current-day poll cycle. The
    frontend shows this in the 'S3 slow' tooltip and the status view so the
    actual latency is visible (and can be watched trending toward the slow
    threshold). 0.0 before the first cycle completes."""
    cameras: list[CameraStatus]
    """Per-camera cold-start scan progress, so the frontend can scope the
    'loading' affordance to the camera being viewed."""


@router.get("/live", response_model=LiveResponse)
def live() -> LiveResponse:
    """Liveness: the process is running."""
    return LiveResponse(status="ok", version=__version__)


@router.get("/ready", response_model=ReadyResponse)
def ready(
    response: Response, state: AppState = Depends(get_app_state)
) -> ReadyResponse:
    """Readiness: the app is ready to serve traffic."""
    if not state.ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return ReadyResponse(ready=state.ready)


@router.get("/status", response_model=StatusResponse)
def app_status(state: AppState = Depends(get_app_state)) -> StatusResponse:
    """Detailed status: readiness plus per-camera history-loading progress."""
    cameras = [
        CameraStatus(
            location=location,
            camera=camera,
            recent_ready=st.recent_ready,
            full_complete=st.full_complete,
        )
        for (location, camera), st in state.camera_status().items()
    ]
    return StatusResponse(
        ready=state.ready,
        cache_enabled=state.cache_enabled,
        warm_start=state.warm_start,
        historical_loading=state.historical_loading(),
        s3_healthy=state.s3_healthy(),
        s3_slow=state.s3_slow(),
        s3_last_cycle_seconds=state.s3_last_cycle_seconds(),
        cameras=cameras,
    )
