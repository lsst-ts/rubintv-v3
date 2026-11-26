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

"""Shared application state held on ``app.state``.

A small typed container so request handlers and background tasks reach the
same objects without module-level globals. Phase 2 adds the EventStore and
event bus here; Phase 1 wires config, the S3 pool, and the readiness flag.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from lsst.ts.rubintv.config.models import Models

if TYPE_CHECKING:
    from lsst.ts.rubintv.data.redis_inputs import RedisInputs
    from lsst.ts.rubintv.data.tasks import CameraScanState, LocationPollStatus
from lsst.ts.rubintv.config.settings import Settings
from lsst.ts.rubintv.data.cache import CacheInspector
from lsst.ts.rubintv.data.controls import ControlStore, DetectorStore
from lsst.ts.rubintv.data.metadata import MetadataCache
from lsst.ts.rubintv.data.nightreport import NightReportFetcher
from lsst.ts.rubintv.data.store import EventStore
from lsst.ts.rubintv.data.thumbs import ThumbnailCache
from lsst.ts.rubintv.s3.client import S3ClientPool
from lsst.ts.rubintv.ws.handler import WsService


@dataclass
class AppState:
    """Everything the app needs at runtime, assembled in the lifespan."""

    settings: Settings
    models: Models
    s3: S3ClientPool
    store: EventStore
    metadata: MetadataCache
    nightreport: NightReportFetcher
    controls: ControlStore
    detectors: DetectorStore
    ws: WsService
    thumbs: ThumbnailCache
    ready: bool = field(default=False)
    cache_enabled: bool = field(default=False)
    """Whether a disk cache is configured. When false, every restart is a
    full cold load from S3 (no warm start is possible)."""
    warm_start: bool = field(default=False)
    """Whether a cached snapshot was loaded at boot. When true, the calendar
    was already populated at startup and the ongoing scan is a refresh; when
    false, older dates only appear as the cold sweep discovers them."""
    historical_loading: Callable[[], bool] = field(default=lambda: True)
    """Callable returning whether the historical back-catalogue is still
    loading at any location (the poll engine owns the flags; this reads
    them)."""
    s3_healthy: Callable[[], bool] = field(default=lambda: True)
    """Callable returning whether every location's last current-day poll
    cycle reached S3 (the poll engine owns the flags; this reads them).
    False means some location's bucket endpoint was unreachable on its most
    recent cycle."""
    s3_slow: Callable[[], bool] = field(default=lambda: False)
    """Callable returning whether any location's last successful poll cycle
    was unusually slow (the poll engine owns the flags; this reads them).
    True warns of a degrading link before it fails the s3_healthy check
    outright."""
    s3_last_cycle_seconds: Callable[[], float] = field(default=lambda: 0.0)
    """Callable returning the wall-clock seconds of the longest of the
    locations' last successful current-day poll cycles (the poll engine owns
    them; this reads them). Lets the status view show the actual latency,
    not just the slow/not-slow flag; 0.0 before the first cycle completes."""
    poll_stalled: Callable[[], bool] = field(default=lambda: False)
    """Callable returning whether any location's current-day poll cycle now
    running has overrun (the poll engine works it out; this reads it). The
    flags above describe the last cycle to finish, so they can't show one
    that hasn't."""
    last_poll_age_seconds: Callable[[], float | None] = field(default=lambda: None)
    """Callable returning the seconds since the location furthest behind
    last finished a current-day poll cycle (the poll engine owns the clock;
    this reads it); ``None`` until one has."""
    location_status: Callable[[], dict[str, LocationPollStatus]] = field(default=dict)
    """Callable returning each location's own polling, keyed by location
    (the poll engine owns it; this reads it). The six callables above sum
    it."""
    cache_write_error: Callable[[], str | None] = field(default=lambda: None)
    """Callable returning what the disk cache's most recent write failed
    with, ``None`` if it succeeded (the cache owns it; this reads it)."""
    cache_write_stalled_seconds: Callable[[], float | None] = field(
        default=lambda: None
    )
    """Callable returning how long a cache write has been outstanding, once
    scans have stopped waiting for it; ``None`` while the volume keeps up
    (the poll engine owns it; this reads it)."""
    cache_inspector: CacheInspector = field(default_factory=CacheInspector)
    """Looks over the cache dir for the Status page."""
    camera_status: Callable[[], dict[tuple[str, str], CameraScanState]] = field(
        default=dict
    )
    """Callable returning per-camera cold-start scan progress, keyed by
    ``(location, camera)`` (the poll engine owns it; this reads it)."""
    """Flips true once the first data poll completes. Drives the readiness
    probe so k8s doesn't route traffic to an empty store."""
    redis: RedisInputs | None = field(default=None)
    """The Redis input manager (set in the lifespan). Admin control writes and
    the danger-zone flush go through it; ``None``/disabled when no Redis URL is
    configured, so admin write endpoints report 503. Its ``link`` says whether
    a configured Redis is answering."""
    flush_historical: Callable[[], Awaitable[int]] | None = field(default=None)
    """Admin action: clear the disk + in-memory historical cache and trigger a
    cold rescan. Returns the number of disk slices removed. Wired in the
    lifespan where the cache/store/engine handles live."""
    backfill_date: Callable[[str, str, str], Awaitable[int]] | None = field(
        default=None
    )
    """On-demand scan of one (location, camera, date) prefix into the store,
    for deep-linked dates the scanner hasn't indexed yet. Returns the number
    of events applied. Wired in the lifespan to the poll engine."""
