"""Shared application state held on ``app.state``.

A small typed container so request handlers and background tasks reach the
same objects without module-level globals. Phase 2 adds the EventStore and
event bus here; Phase 1 wires config, the S3 pool, and the readiness flag.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from rubintv.config.models import Models
from rubintv.config.settings import Settings
from rubintv.s3.client import S3ClientPool


@dataclass
class AppState:
    """Everything the app needs at runtime, assembled in the lifespan."""

    settings: Settings
    models: Models
    s3: S3ClientPool
    ready: bool = field(default=False)
    """Flips true once the first data poll completes (Phase 2). Drives the
    readiness probe so k8s doesn't route traffic to an empty store."""
