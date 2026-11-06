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
    from lsst.ts.rubintv.data.tasks import CameraScanState
from lsst.ts.rubintv.config.settings import Settings
from lsst.ts.rubintv.data.controls import ControlStore, DetectorStore
from lsst.ts.rubintv.data.metadata import MetadataCache
from lsst.ts.rubintv.data.nightreport import NightReportFetcher
from lsst.ts.rubintv.data.store import EventStore
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
    loading (the poll engine owns the flag; this reads it)."""
    s3_healthy: Callable[[], bool] = field(default=lambda: True)
    """Callable returning whether the last current-day poll cycle reached S3
    (the poll engine owns the flag; this reads it). False means the bucket
    endpoint was unreachable on the most recent cycle."""
    s3_slow: Callable[[], bool] = field(default=lambda: False)
    """Callable returning whether the last successful poll cycle was unusually
    slow (the poll engine owns the flag; this reads it). True warns of a
    degrading link before it fails the s3_healthy check outright."""
    s3_last_cycle_seconds: Callable[[], float] = field(default=lambda: 0.0)
    """Callable returning the wall-clock seconds of the last successful
    current-day poll cycle (the poll engine owns it; this reads it). Lets the
    status view show the actual latency, not just the slow/not-slow flag; 0.0
    before the first cycle completes."""
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
    configured, so admin write endpoints report 503."""
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
