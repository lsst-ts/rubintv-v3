"""FastAPI application factory and lifespan.

The lifespan establishes startup order once, so later phases slot their
pieces (EventStore, pollers, WebSocket bus) into a known sequence.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket

from rubintv import __version__
from rubintv.api import admin, data, health, nightreport, proxy
from rubintv.config.loader import load_models
from rubintv.config.settings import Settings, get_settings
from rubintv.data.cache import DiskCache
from rubintv.data.controls import ControlStore
from rubintv.data.metadata import MetadataCache
from rubintv.data.nightreport import NightReportFetcher
from rubintv.data.redis_inputs import RedisInputs
from rubintv.data.source import S3Poller
from rubintv.data.store import EventStore
from rubintv.data.tasks import PollEngine
from rubintv.logging import configure_logging, get_logger
from rubintv.s3.client import S3ClientPool
from rubintv.state import AppState
from rubintv.ws.handler import WsService

log = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Assemble and tear down application state.

    Order: config -> S3 pool -> store/bus -> warm-start from cache ->
    metadata cache -> start the poll engine. Readiness flips after the first
    current-day poll completes (the poll engine fires the callback).
    """
    settings: Settings = app.state.settings
    log.info("startup.begin", site=settings.site, version=__version__)

    models = load_models(settings.models_path)
    s3 = S3ClientPool(models.locations)
    buckets = {loc.name: loc.bucket for loc in models.locations}

    store = EventStore()
    poller = S3Poller(s3.client_for)
    for loc in models.locations:
        poller.register_bucket(loc.name, loc.bucket)

    # Warm start: seed from disk cache if present (never trusted as truth —
    # the historical scan reconciles against S3).
    cache = DiskCache(settings.cache_dir)
    if cache.enabled:
        snapshot = cache.load_all()
        store.load_snapshot(snapshot)
        log.info("cache.loaded", slices=sum(len(d) for d in snapshot.values()))

    metadata = MetadataCache(s3, buckets)
    controls = ControlStore()
    ws_service = WsService(store)
    state = AppState(
        settings=settings,
        models=models,
        s3=s3,
        store=store,
        metadata=metadata,
        nightreport=NightReportFetcher(s3, buckets),
        controls=controls,
        ws=ws_service,
    )
    app.state.app_state = state

    redis_inputs = RedisInputs(settings.redis_url, store.bus, controls)

    async def write_cache() -> None:
        if not cache.enabled:
            return
        for (location, camera), dates in store.snapshot().items():
            for date, index in dates.items():
                cache.write(location, camera, date, index)

    engine = PollEngine(
        models,
        store,
        poller,
        poll_interval=settings.poll_interval_seconds,
        on_ready=lambda: setattr(state, "ready", True),
        cache_writer=write_cache,
    )
    engine.start()
    ws_service.start()
    await redis_inputs.start()
    log.info("startup.complete", locations=[loc.name for loc in models.locations])

    try:
        yield
    finally:
        log.info("shutdown.begin")
        await redis_inputs.stop()
        await ws_service.stop()
        await engine.stop()
        await write_cache()
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
    app.include_router(data.router, prefix="/api", tags=["data"])
    app.include_router(nightreport.router, prefix="/api", tags=["night-report"])
    app.include_router(admin.router, prefix="/api", tags=["admin"])
    app.include_router(proxy.router, prefix="/api", tags=["proxy"])

    @app.websocket("/ws")
    async def ws_endpoint(socket: WebSocket) -> None:
        state: AppState = app.state.app_state
        await state.ws.handle(socket)

    return app
