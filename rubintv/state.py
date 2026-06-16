"""Shared application state held on ``app.state``.

A small typed container so request handlers and background tasks reach the
same objects without module-level globals. Phase 2 adds the EventStore and
event bus here; Phase 1 wires config, the S3 pool, and the readiness flag.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from rubintv.config.models import Models

if TYPE_CHECKING:
    from rubintv.data.redis_inputs import RedisInputs
    from rubintv.data.tasks import CameraScanState
from rubintv.config.settings import Settings
from rubintv.data.controls import ControlStore, DetectorStore
from rubintv.data.heartbeats import HeartbeatStore
from rubintv.data.metadata import MetadataCache
from rubintv.data.nightreport import NightReportFetcher
from rubintv.data.store import EventStore
from rubintv.s3.client import S3ClientPool
from rubintv.ws.handler import WsService
from rubintv.ws.internal import HeartbeatService


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
    heartbeats: HeartbeatStore
    ws: WsService
    heartbeat_svc: HeartbeatService
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
