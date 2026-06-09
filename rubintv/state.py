"""Shared application state held on ``app.state``.

A small typed container so request handlers and background tasks reach the
same objects without module-level globals. Phase 2 adds the EventStore and
event bus here; Phase 1 wires config, the S3 pool, and the readiness flag.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from rubintv.config.models import Models

if TYPE_CHECKING:
    from rubintv.data.tasks import CameraScanState
from rubintv.config.settings import Settings
from rubintv.data.controls import ControlStore
from rubintv.data.metadata import MetadataCache
from rubintv.data.nightreport import NightReportFetcher
from rubintv.data.store import EventStore
from rubintv.s3.client import S3ClientPool
from rubintv.ws.handler import WsService


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
    camera_status: Callable[[], dict[tuple[str, str], CameraScanState]] = field(
        default=dict
    )
    """Callable returning per-camera cold-start scan progress, keyed by
    ``(location, camera)`` (the poll engine owns it; this reads it)."""
    """Flips true once the first data poll completes. Drives the readiness
    probe so k8s doesn't route traffic to an empty store."""
