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

Plus ``/status`` (scan progress, polled by every page) and ``/cache`` (disk
cache usage, for the Status page alone).
"""

from __future__ import annotations

import shutil
from typing import Literal

from fastapi import APIRouter, Depends, Response, status
from lsst.ts.rubintv import __version__
from lsst.ts.rubintv.api.deps import get_app_state
from lsst.ts.rubintv.data.cache import CACHE_VERSION, dir_usage
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
    location_title: str
    camera_title: str
    """Display titles from the models, so the Status page needn't fetch
    every location's detail just to label its cards."""
    recent_ready: bool
    """The recent-window scan for this camera has been applied; recent dates
    are viewable even while the full back-catalogue is still loading."""
    full_complete: bool
    """The camera's whole back-catalogue has been scanned at least once."""
    image_count: int
    """Channel images indexed so far for this camera, across every date: one
    per (channel, seq) frame plus one per per-day artifact. Climbs while the
    scans run, so the Status page shows how much each one has found."""


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
    poll_stalled: bool
    """Whether the current-day poll cycle now running has overrun, so the
    live poll has stopped. The three ``s3_`` fields describe the last cycle
    to finish and go on saying what it found; the frontend shows a 'Poll
    stalled' alert ahead of them."""
    last_poll_age_seconds: float | None
    """Seconds, when this was answered, since a current-day poll cycle last
    succeeded: how far behind the bucket today's data may be. An age, not a
    time, so the frontend can place it on its own clock whatever the
    server's says. ``None`` before the first cycle completes."""
    cameras: list[CameraStatus]
    """Per-camera cold-start scan progress, so the frontend can scope the
    'loading' affordance to the camera being viewed."""


CacheUse = Literal["index", "guide", "unused"]


class CacheEntry(BaseModel):
    path: str
    """Absolute path of a top-level entry of the cache dir."""
    use: CacheUse
    """What reads it: the S3 scan index (warm starts), the observing-block
    guide, or nothing in this version (an older cache version's slices, or
    anything else left on the volume), so its space can be reclaimed."""
    files: int
    bytes: int
    """Allocated on disk, as ``du`` reports, not the files' apparent size."""


class CacheUsageResponse(BaseModel):
    enabled: bool
    """Whether the disk cache is in use. When false, the rest is empty."""
    dir: str | None
    """Absolute path of the cache dir."""
    entries: list[CacheEntry]
    """What the cache dir holds: in-use entries first, then unused ones,
    largest first."""
    volume_total_bytes: int | None
    volume_free_bytes: int | None
    """Size and free space of the volume holding the cache dir (the PVC in
    deployments; a laptop's whole disk in dev); ``None`` if they can't be
    read. The volume holds more than the cache (other files, filesystem
    overhead, root-reserved blocks), so cache + free needn't equal total."""


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
async def app_status(state: AppState = Depends(get_app_state)) -> StatusResponse:
    """Detailed status: readiness plus per-camera history-loading progress."""
    # ``async`` for loop confinement: image_count iterates live index dicts
    # the pollers mutate, so it must not run on a threadpool worker.
    titles = {
        (loc.name, cam.name): (loc.title, cam.title)
        for loc in state.models.locations
        for cam in loc.cameras
    }
    cameras = []
    for (location, camera), st in state.camera_status().items():
        # Every scanned camera comes from the models; the names stand in
        # should one ever not.
        loc_title, cam_title = titles.get((location, camera), (location, camera))
        cameras.append(
            CameraStatus(
                location=location,
                camera=camera,
                location_title=loc_title,
                camera_title=cam_title,
                recent_ready=st.recent_ready,
                full_complete=st.full_complete,
                image_count=state.store.image_count(location, camera),
            )
        )
    return StatusResponse(
        ready=state.ready,
        cache_enabled=state.cache_enabled,
        warm_start=state.warm_start,
        historical_loading=state.historical_loading(),
        s3_healthy=state.s3_healthy(),
        s3_slow=state.s3_slow(),
        s3_last_cycle_seconds=state.s3_last_cycle_seconds(),
        poll_stalled=state.poll_stalled(),
        last_poll_age_seconds=state.last_poll_age_seconds(),
        cameras=cameras,
    )


@router.get("/cache", response_model=CacheUsageResponse)
def cache_usage(state: AppState = Depends(get_app_state)) -> CacheUsageResponse:
    """Disk cache locations and sizes, for the Status page.

    Separate from ``/status`` because it stats every cached file (thousands
    on the PVC) and every page polls that one. Sync, so the walk runs on the
    threadpool rather than stalling the event loop.
    """
    root = state.settings.cache_dir
    if not state.cache_enabled or root is None:
        return CacheUsageResponse(
            enabled=False,
            dir=None,
            entries=[],
            volume_total_bytes=None,
            volume_free_bytes=None,
        )
    root = root.absolute()
    # The observing-block guide, where deployed, keeps its own cache in a
    # ``guide`` subdirectory of the same dir.
    uses: dict[str, CacheUse] = {CACHE_VERSION: "index", "guide": "guide"}
    entries = [
        CacheEntry(
            path=str(e.path),
            use=uses.get(e.path.name, "unused"),
            files=e.files,
            bytes=e.bytes,
        )
        for e in dir_usage(root)
    ]
    # An empty stray (e.g. the volume's lost+found) is noise, not something
    # to reclaim; in-use entries show even when empty (a cold first run).
    entries = [e for e in entries if e.use != "unused" or e.files]
    entries.sort(key=lambda e: (e.use == "unused", -e.bytes))
    try:
        volume = shutil.disk_usage(root)
    except OSError:
        total = free = None
    else:
        total, free = volume.total, volume.free
    return CacheUsageResponse(
        enabled=True,
        dir=str(root),
        entries=entries,
        volume_total_bytes=total,
        volume_free_bytes=free,
    )
