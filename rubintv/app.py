"""FastAPI application factory and lifespan.

The lifespan establishes startup order once, so later phases slot their
pieces (EventStore, pollers, WebSocket bus) into a known sequence.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from rubintv import __version__
from rubintv.api import health
from rubintv.config.loader import load_models
from rubintv.config.settings import Settings, get_settings
from rubintv.logging import configure_logging, get_logger
from rubintv.s3.client import S3ClientPool
from rubintv.state import AppState

log = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Assemble and tear down application state.

    Phase 1 wires config, models, and the S3 client pool. Phase 2 will add
    the EventStore and start background pollers here; Phase 4 the WS bus.
    """
    settings: Settings = app.state.settings
    log.info("startup.begin", site=settings.site, version=__version__)

    models = load_models(settings.models_path)
    s3 = S3ClientPool(models.locations)

    app.state.app_state = AppState(settings=settings, models=models, s3=s3)
    log.info(
        "startup.ready",
        locations=[loc.name for loc in models.locations],
    )
    # Phase 1 has no data layer yet, so nothing gates readiness; mark ready
    # so the probe is meaningful in isolation. Phase 2 moves this behind the
    # first completed poll.
    app.state.app_state.ready = True

    try:
        yield
    finally:
        log.info("shutdown.begin")
        s3.close()
        log.info("shutdown.complete")


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the FastAPI app.

    Args:
        settings: Override settings (tests inject these). Defaults to the
            process settings from the environment.
    """
    settings = settings or get_settings()
    configure_logging(json_logs=settings.json_logs, level=settings.log_level)

    app = FastAPI(
        title="RubinTV",
        version=__version__,
        # The SPA is served separately in dev (Vite); in prod static assets
        # mount here in Phase 7. API lives under /api.
    )
    app.state.settings = settings
    # Re-bind the lifespan now that settings are on app.state.
    app.router.lifespan_context = lifespan

    app.include_router(health.router, prefix="/api/health", tags=["health"])

    return app
