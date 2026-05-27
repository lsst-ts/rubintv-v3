"""Health endpoints for Kubernetes probes.

- ``/api/health/live`` — process is up (liveness).
- ``/api/health/ready`` — the data layer has loaded enough to serve
  traffic (readiness). Phase 1 reports ready once the app is assembled;
  Phase 2 gates this on the first completed poll.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status
from pydantic import BaseModel

from rubintv import __version__
from rubintv.api.deps import get_app_state
from rubintv.state import AppState

router = APIRouter()


class LiveResponse(BaseModel):
    status: str
    version: str


class ReadyResponse(BaseModel):
    ready: bool


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
