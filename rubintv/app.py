"""FastAPI application factory and lifespan.

The lifespan establishes startup order once, so later phases slot their
pieces (EventStore, pollers, WebSocket bus) into a known sequence.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.middleware.gzip import GZipMiddleware

from rubintv import __version__
from rubintv.api import admin, data, health, internal, nightreport, proxy
from rubintv.config.loader import load_models
from rubintv.config.settings import Settings, get_settings
from rubintv.data.cache import DiskCache
from rubintv.data.controls import ControlStore, DetectorStore
from rubintv.data.heartbeats import HeartbeatStore
from rubintv.data.metadata import MetadataCache
from rubintv.data.nightreport import NightReportFetcher
from rubintv.data.redis_inputs import RedisInputs
from rubintv.data.source import S3Poller
from rubintv.data.store import EventStore
from rubintv.data.tasks import PollEngine
from rubintv.logging import configure_logging, get_logger
from rubintv.middleware import correlation_middleware
from rubintv.s3.client import S3ClientPool
from rubintv.spa import mount_spa
from rubintv.state import AppState
from rubintv.subapps import mount_subapps
from rubintv.ws.handler import WsService
from rubintv.ws.internal import HeartbeatService

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

    _project_root = Path(__file__).resolve().parent.parent
    models_path = (
        settings.models_path
        if settings.models_path.is_absolute()
        else _project_root / settings.models_path
    )
    models = load_models(models_path, site=settings.site)
    s3 = S3ClientPool(models.locations)
    # Cold-init every client up front in parallel so the first poll cycle
    # (and the first API request that lands during it) doesn't pay the
    # boto3 session-creation cost for each location serially.
    await s3.warm_up()
    log.info("s3.pool.ready", locations=[loc.name for loc in models.locations])
    buckets = {loc.name: loc.bucket for loc in models.locations}

    store = EventStore()
    # The poller uses a dedicated client per location so its sustained
    # list_objects_v2 traffic doesn't share an HTTP connection pool with
    # the interactive handlers (metadata fetches, proxy GETs).
    poller = S3Poller(s3.poller_client_for)
    for loc in models.locations:
        poller.register_bucket(loc.name, loc.bucket)

    # Warm start: seed from disk cache if present (never trusted as truth —
    # the historical scan reconciles against S3).
    cache = DiskCache(settings.cache_dir)
    warm_start = False
    if cache.enabled:
        snapshot = cache.load_all()
        store.load_snapshot(snapshot)
        loc_cams = len(snapshot)
        slices = sum(len(d) for d in snapshot.values())
        # A warm start means the calendar is already populated from cache, so
        # the ongoing scan is a refresh rather than a cold load. An enabled
        # cache that loaded nothing (empty/first run) is still effectively a
        # cold start, hence gating on slices rather than cache.enabled alone.
        warm_start = slices > 0
        log.info(
            "cache.loaded",
            dir=str(settings.cache_dir),
            location_cameras=loc_cams,
            date_slices=slices,
        )
    else:
        log.info("cache.disabled", reason="no cache_dir configured")

    metadata = MetadataCache(s3, buckets)
    controls = ControlStore()
    detectors = DetectorStore()
    heartbeats = HeartbeatStore()
    ws_service = WsService(store, metadata, controls, detectors, heartbeats)
    heartbeat_svc = HeartbeatService(store.bus, heartbeats)
    state = AppState(
        settings=settings,
        models=models,
        s3=s3,
        store=store,
        metadata=metadata,
        nightreport=NightReportFetcher(s3, buckets),
        controls=controls,
        detectors=detectors,
        heartbeats=heartbeats,
        ws=ws_service,
        heartbeat_svc=heartbeat_svc,
        cache_enabled=cache.enabled,
        warm_start=warm_start,
    )
    app.state.app_state = state

    redis_inputs = RedisInputs(
        settings.redis_url,
        store.bus,
        controls,
        detectors,
        models.redis_detectors,
    )

    async def write_cache() -> None:
        if not cache.enabled:
            return
        for (location, camera), dates in store.snapshot().items():
            for date, index in dates.items():
                cache.write(location, camera, date, index)

    async def write_slices(touched: set[tuple[str, str, str]]) -> None:
        # Persist just the slices a scan changed, so the disk cache fills in
        # as history is discovered rather than only every 12h / at shutdown.
        if not cache.enabled:
            return
        for location, camera, date in touched:
            index = store.date_index(location, camera, date)
            if index is not None:
                cache.write(location, camera, date, index)

    async def delete_slices(pruned: set[tuple[str, str, str]]) -> None:
        # Evict cache slices for dates the full sweep pruned as stale, so a
        # vanished date doesn't reseed the calendar on the next warm start.
        if not cache.enabled:
            return
        for location, camera, date in pruned:
            cache.delete(location, camera, date)

    async def warm_metadata(location: str, camera: str) -> None:
        # Pre-fetch the most recent dates' metadata into the LRU after the
        # recent scan, so the first table view of a recent date is a warm hit.
        # Capped by the configured window and by the dates actually present;
        # get_with_etag populates the cache as a side effect.
        n = settings.metadata_preload_days
        if n <= 0:
            return
        dates = store.calendar(location, camera)[:n]
        for date in dates:
            await metadata.get_with_etag(location, camera, date)
        if dates:
            log.info(
                "metadata.preloaded",
                location=location,
                camera=camera,
                dates=len(dates),
            )

    engine = PollEngine(
        models,
        store,
        poller,
        poll_interval=settings.poll_interval_seconds,
        recent_window_days=settings.recent_window_days,
        on_ready=lambda: setattr(state, "ready", True),
        cache_writer=write_cache,
        cache_slice_writer=write_slices,
        cache_slice_deleter=delete_slices,
        metadata_warmer=warm_metadata,
    )
    # Expose the engine's scan-progress to the status endpoint: the global
    # loading flag plus the per-camera readiness map.
    state.historical_loading = lambda: engine.historical_loading
    state.camera_status = engine.camera_status
    state.s3_healthy = lambda: engine.s3_healthy
    state.s3_slow = lambda: engine.s3_slow

    # Admin handles: the Redis manager (control writes / flush) and the
    # flush-historical action that clears the disk + in-memory cache and kicks
    # an immediate cold rescan.
    state.redis = redis_inputs

    async def flush_historical() -> int:
        removed = cache.clear()
        store.clear()
        # Drop the poller's diff state with the store it described — without
        # this the rescan diffs against the retained listings, emits nothing,
        # and the store stays empty until a restart.
        poller.reset()
        engine.trigger_rescan()
        log.warning("admin.flush_historical", slices_removed=removed)
        return removed

    state.flush_historical = flush_historical
    state.backfill_date = engine.scan_date

    engine.start()
    ws_service.start()
    heartbeat_svc.start()
    await redis_inputs.start()
    log.info("startup.complete", locations=[loc.name for loc in models.locations])

    try:
        yield
    finally:
        log.info("shutdown.begin")
        await redis_inputs.stop()
        await heartbeat_svc.stop()
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

    app = FastAPI(title="RubinTV", version=__version__)
    app.state.settings = settings
    # Re-bind the lifespan now that settings are on app.state.
    app.router.lifespan_context = lifespan

    app.middleware("http")(correlation_middleware)
    # metadata.json responses can exceed 10 MB; gzip drops that ~10–20x for
    # the wire. minimum_size skips short responses where compression overhead
    # outweighs the gain.
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    # The whole app is served under this prefix (default /rubintv), so external
    # deep links from the previous app resolve. The prefix carries no trailing
    # slash, so f"{prefix}/api" yields "/rubintv/api"; an empty prefix serves
    # everything at the root.
    prefix = settings.path_prefix

    app.include_router(health.router, prefix=f"{prefix}/api/health", tags=["health"])
    app.include_router(data.router, prefix=f"{prefix}/api", tags=["data"])
    app.include_router(
        nightreport.router, prefix=f"{prefix}/api", tags=["night-report"]
    )
    app.include_router(admin.router, prefix=f"{prefix}/api", tags=["admin"])
    app.include_router(proxy.router, prefix=f"{prefix}/api", tags=["proxy"])
    # GET {prefix}/api/health/services for probes; the internal heartbeat
    # ingest stays pod-local under {prefix}/internal.
    app.include_router(internal.status_router, prefix=f"{prefix}/api")
    app.include_router(internal.internal_router, prefix=prefix)

    @app.websocket(f"{prefix}/ws")
    async def ws_endpoint(socket: WebSocket) -> None:
        state: AppState = app.state.app_state
        await state.ws.handle(socket)

    @app.websocket(f"{prefix}/internal/heartbeats")
    async def heartbeat_endpoint(socket: WebSocket) -> None:
        state: AppState = app.state.app_state
        await state.heartbeat_svc.handle(socket)

    # Optional sub-apps (DDV, exp_checker). Each is isolated: a failure to
    # mount is logged and skipped, never blocking the main app.
    mounted = mount_subapps(app, settings)
    app.state.subapps = mounted

    @app.get(f"{prefix}/api/subapps", tags=["subapps"])
    def list_subapps() -> dict[str, list[str]]:
        """Mounted sub-app paths, for the frontend nav."""
        return {"mounted": app.state.subapps}

    # Serve the built SPA last so its deep-link catch-all never shadows the
    # API, WebSocket, or sub-app routes registered above.
    mount_spa(app, settings.spa_dist, prefix)

    return app
