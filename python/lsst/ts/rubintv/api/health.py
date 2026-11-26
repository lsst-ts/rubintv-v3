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

from typing import Literal

from fastapi import APIRouter, Depends, Response, status
from lsst.ts.rubintv import __version__
from lsst.ts.rubintv.api.deps import get_app_state
from lsst.ts.rubintv.data.cache import CACHE_VERSION
from lsst.ts.rubintv.data.controls import RedisLink
from lsst.ts.rubintv.state import AppState
from pydantic import BaseModel

router = APIRouter()

# How long the Status page's check of the cache dir is waited on before the
# answer is that the volume isn't responding. The check is a few calls,
# whatever the dir holds, so only a volume that has hung keeps it this long.
CACHE_LOOK_WAIT_SECONDS = 10.0

# How old the cache entries' sizes may get before they are measured again.
# Sizing stats every cached file: about 6 s for the USDF PVC's 6,000 when
# the volume is quiet, and up to a minute while a sweep is writing to it.
CACHE_SIZES_MAX_AGE_SECONDS = 5 * 60.0


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


class LocationStatus(BaseModel):
    """One location's polling. Each location is polled on its own, so one
    whose bucket can't be reached says so here and the others don't."""

    location: str
    location_title: str
    s3_healthy: bool
    """Whether the location's last current-day poll cycle reached S3."""
    s3_slow: bool
    """Whether its last successful cycle was unusually slow."""
    s3_last_cycle_seconds: float
    """Wall-clock seconds of its last successful cycle; 0.0 before one."""
    poll_stalled: bool
    """Whether its cycle now running has overrun, so its live poll has
    stopped."""
    last_poll_age_seconds: float | None
    """Seconds, when this was answered, since one of its cycles last
    succeeded; ``None`` before one has."""
    historical_loading: bool
    """True while its back-catalogue is still being scanned."""


class RedisStatus(BaseModel):
    """Whether Redis (cluster status, control readbacks) is being read."""

    configured: bool
    """A Redis URL is set. When false the rest says nothing."""
    connected: bool
    """Redis is answering every reader. False from startup until it first
    does, and whenever a reader has failed and not yet got back through; the
    readers keep trying."""
    changed_age_seconds: float | None
    """Seconds since ``connected`` last changed: how long Redis has been
    read without a break, or how long it has been unreachable."""
    read_age_seconds: float | None
    """Seconds, when this was answered, since Redis last answered a reader;
    ``None`` if it never has. A few seconds while connected (the readers ask
    at least that often); while not, the age of everything the Cluster
    Status and Admin pages show."""


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
    """True while any location's back-catalogue is still being scanned; the
    frontend shows a non-blocking 'still loading' affordance rather than an
    error."""
    s3_healthy: bool
    """Whether every location's last current-day poll cycle reached S3.
    False means some bucket endpoint was unreachable (e.g. a connect
    timeout); the frontend shows an 'S3 unreachable' alert beside the live
    indicator. This and the five fields around it sum ``locations`` for a
    page with no location in view: the worst of each."""
    s3_slow: bool
    """Whether any location's last successful poll cycle was unusually slow.
    True warns of a degrading link before it fails outright; the frontend
    shows an amber 'S3 slow' warning. Ignored when s3_healthy is false."""
    s3_last_cycle_seconds: float
    """Wall-clock seconds of the longest of the locations' last successful
    current-day poll cycles. The frontend shows this in the 'S3 slow'
    tooltip and the status view so the actual latency is visible (and can
    be watched trending toward the slow threshold). 0.0 before the first
    cycle completes."""
    poll_stalled: bool
    """Whether any location's current-day poll cycle now running has
    overrun, so its live poll has stopped. The three ``s3_`` fields describe
    the last cycle to finish and go on saying what it found; the frontend
    shows a 'Poll stalled' alert ahead of them."""
    last_poll_age_seconds: float | None
    """Seconds, when this was answered, since the location furthest behind
    last finished a current-day poll cycle: how far behind the bucket
    today's data may be. An age, not a time, so the frontend can place it on
    its own clock whatever the server's says. ``None`` before the first
    cycle completes."""
    locations: list[LocationStatus]
    """Each location's own polling: what a page on one location shows."""
    redis: RedisStatus
    """Whether Redis is being read, and how long ago it last answered."""
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
    unreadable: bool
    """Part of it couldn't be listed, so ``files`` and ``bytes`` leave out
    whatever is there."""


class CacheProblem(BaseModel):
    kind: Literal["not_responding", "unreadable", "not_writable"]
    """``not_responding``: a write to the volume, or this check of it,
    hasn't returned (the rest of the answer is then empty: the volume isn't
    asked again while it holds one call). ``unreadable``: the cache dir or
    the scan index in it can't be listed. ``not_writable``: the last write
    failed, or the server's user may not write there."""
    detail: str
    """The specifics, as a phrase for a person: the operating system's
    error, with any path relative to the cache dir, or how long the volume
    has been silent."""


class CacheUsageResponse(BaseModel):
    enabled: bool
    """Whether the disk cache is in use. When false, the rest is empty."""
    problems: list[CacheProblem]
    """What is wrong with the cache volume, if anything. None of it stops
    the app, which reads the cache once at startup and otherwise only writes
    to it, so nothing else reports it: the cost is a next start from an
    older index, or a cold one."""
    dir: str | None
    """Absolute path of the cache dir."""
    entries: list[CacheEntry]
    """What the cache dir holds: in-use entries first, then unused ones,
    largest first."""
    entries_age_seconds: float | None
    """Seconds since ``entries`` were sized. Sizing stats every cached file,
    so it is repeated only every few minutes and its last result is served
    in between. ``None`` when they haven't been sized: the first sizing is
    still running, or a problem with the volume stops it. ``entries`` is
    then empty, which says nothing of the cache."""
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
    polls = state.location_status()
    locations = [
        LocationStatus(
            location=loc.name,
            location_title=loc.title,
            s3_healthy=poll.s3_healthy,
            s3_slow=poll.s3_slow,
            s3_last_cycle_seconds=poll.s3_last_cycle_seconds,
            poll_stalled=poll.poll_stalled,
            last_poll_age_seconds=poll.last_poll_age_seconds,
            historical_loading=poll.historical_loading,
        )
        for loc in state.models.locations
        if (poll := polls.get(loc.name)) is not None
    ]
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
        locations=locations,
        redis=RedisStatus.model_validate(
            (state.redis.link if state.redis is not None else RedisLink()).report()
        ),
        cameras=cameras,
    )


@router.get("/cache", response_model=CacheUsageResponse)
async def cache_usage(state: AppState = Depends(get_app_state)) -> CacheUsageResponse:
    """Disk cache locations, sizes and troubles, for the Status page.

    Separate from ``/status`` because every page polls that one, and this
    asks the volume. The check of it is waited on for only so long, and the
    sizes, which take a stat of every cached file (thousands on the PVC),
    are measured every few minutes (see ``CacheInspector``).
    """
    root = state.settings.cache_dir
    if not state.cache_enabled or root is None:
        return CacheUsageResponse(
            enabled=False,
            problems=[],
            dir=None,
            entries=[],
            entries_age_seconds=None,
            volume_total_bytes=None,
            volume_free_bytes=None,
        )
    root = root.absolute()
    problems: list[CacheProblem] = []
    report = None
    stalled = state.cache_write_stalled_seconds()
    if stalled is not None:
        # The scans are already waiting on this volume; don't queue a check
        # behind their write.
        silent = f"A write has not returned for {stalled:.0f} s"
    else:
        inspector = state.cache_inspector
        report = await inspector.report(
            root, CACHE_LOOK_WAIT_SECONDS, CACHE_SIZES_MAX_AGE_SECONDS
        )
        silent = f"A read has not returned for {inspector.waited_seconds():.0f} s"
    if report is None:
        return CacheUsageResponse(
            enabled=True,
            problems=[CacheProblem(kind="not_responding", detail=silent)],
            dir=str(root),
            entries=[],
            entries_age_seconds=None,
            volume_total_bytes=None,
            volume_free_bytes=None,
        )
    # The observing-block guide, where deployed, keeps its own cache in a
    # ``guide`` subdirectory of the same dir.
    uses: dict[str, CacheUse] = {CACHE_VERSION: "index", "guide": "guide"}
    entries = [
        CacheEntry(
            path=str(e.path),
            use=uses.get(e.path.name, "unused"),
            files=e.files,
            bytes=e.bytes,
            unreadable=e.error is not None,
        )
        for e in report.entries
    ]
    # An empty stray (e.g. the volume's lost+found) is noise, not something
    # to reclaim; in-use entries show even when empty (a cold first run).
    entries = [e for e in entries if e.use != "unused" or e.files]
    entries.sort(key=lambda e: (e.use == "unused", -e.bytes))
    # A stray the server can't list (lost+found is root's) is no trouble;
    # the dir itself or the index in it is.
    unreadable = report.unreadable or next(
        (e.error for e in report.entries if e.path.name == CACHE_VERSION), None
    )
    if unreadable is not None:
        problems.append(CacheProblem(kind="unreadable", detail=unreadable))
    write_error = state.cache_write_error()
    if write_error is not None:
        problems.append(
            CacheProblem(
                kind="not_writable", detail=f"The last write failed: {write_error}"
            )
        )
    elif not report.writable:
        problems.append(
            CacheProblem(
                kind="not_writable",
                detail=f"No write permission on {CACHE_VERSION}",
            )
        )
    return CacheUsageResponse(
        enabled=True,
        problems=problems,
        dir=str(root),
        entries=entries,
        entries_age_seconds=report.sized_age,
        volume_total_bytes=report.volume_total,
        volume_free_bytes=report.volume_free,
    )
