"""Background tasks that fill the EventStore.

All tasks push into the store via the same ``DataSource``, so they share one
code path and differ only in *what* they scan and *how often*:

- current-day poller: today's prefixes, fast loop (~1s)
- historical scanner: full back-catalogue on startup, then periodic refresh
  that re-checks recent dates (data is mutable) more often than old ones
- yesterday poller: catches delayed per-day artifacts after rollover

Day rollover (UTC-12) is detected by the current-day loop and published as a
``dayChange`` so clients reset their live views.

Polling latency floor (USDF measurement, 2026-05-29)
----------------------------------------------------
Benchmarked against the live ``rubin-rubintv-data-usdf`` bucket from
``sdfianaNN`` with ``scripts/benchmarks/bench_s3_poll.py``. Numbers are
ms, 4 representative prefixes, 10 samples each:

============================== =========== ===========
strategy                       call.p50    cycle.p50
============================== =========== ===========
serial-shared                  340         823
paginator-shared               337         804
raw-shared                     336         800
parallel-2-shared              528         677
parallel-4-shared              526         665
parallel-8-shared              528         658
parallel-4-per-worker          1290        3050
head-during-list (shared)      4.6         —
head-during-list (separate)    4.2         —
============================== =========== ===========

Conclusions encoded in this module:

- Parallel-across-locations is the right shape — it gets cycle time
  down ~20%, and a fresh client per worker is ~5× *slower* (boto3
  session cold-start dominates), so the location-shared client model
  is correct.
- The S3 endpoint serialises beyond ~4 concurrent requests; going
  past that buys nothing. We gather across all locations regardless,
  which is fine — typical deployments have ~4 locations.
- ``head_object`` is unaffected by concurrent listings on the same or
  a separate client (~4ms either way) on-network, so the separate
  poller client added for laptop-dev contention is essentially free
  insurance on the pod.
- The floor is upstream-bound: ~660ms per cycle is the minimum the
  endpoint will allow, so the current-day ``poll_interval_seconds=1.0``
  is already close to the upstream limit. Lowering it further has
  diminishing returns until cycle time itself drops.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from rubintv.config.models import Location, Models
from rubintv.data.dayobs import get_current_day_obs, recent_day_obs
from rubintv.data.events import StoreChange
from rubintv.data.source import S3Poller
from rubintv.data.store import EventStore
from rubintv.logging import get_logger

log = get_logger(__name__)

# Called after the first full current-day scan completes, to flip readiness.
ReadyCallback = Callable[[], None]

# Per-(location, camera) key, mirroring the store's index keying.
LocCam = tuple[str, str]


@dataclass(slots=True)
class CameraScanState:
    """Cold-start scan progress for one camera.

    ``recent_ready`` flips once the recent-window scan has been applied, so
    recent dates are viewable while the full sweep runs in the background.
    ``full_complete`` flips once the whole ``{camera}/`` prefix has been
    scanned at least once.
    """

    recent_ready: bool = False
    full_complete: bool = False


class PollEngine:
    """Owns the background scan loops over a DataSource into the store."""

    def __init__(
        self,
        models: Models,
        store: EventStore,
        poller: S3Poller,
        *,
        poll_interval: float = 1.0,
        recent_window_days: int = 30,
        on_ready: ReadyCallback | None = None,
        cache_writer: Callable[[], Awaitable[None]] | None = None,
        cache_slice_writer: (
            Callable[[set[tuple[str, str, str]]], Awaitable[None]] | None
        ) = None,
    ) -> None:
        self._models = models
        self._store = store
        self._poller = poller
        self._interval = poll_interval
        self._recent_window_days = recent_window_days
        self._on_ready = on_ready
        self._cache_writer = cache_writer
        self._cache_slice_writer = cache_slice_writer
        self._current_day = get_current_day_obs()
        self._tasks: list[asyncio.Task[None]] = []
        self._stop = asyncio.Event()
        # Set to interrupt the historical loop's 12h sleep and start a fresh
        # sweep immediately (the admin 'flush historical cache' action).
        self._rescan = asyncio.Event()
        # In-flight on-demand date scans, keyed (location, camera, date), so
        # concurrent requests for the same missing date share one S3 listing.
        self._on_demand: dict[tuple[str, str, str], asyncio.Task[int]] = {}
        self._ready_fired = False
        # Per-camera cold-start progress. Mutated only from the historical
        # loop (single task), read by the status endpoint — coarse booleans,
        # so no lock is needed on the event loop.
        self._camera_status: dict[LocCam, CameraScanState] = {
            (loc.name, cam.name): CameraScanState()
            for loc in models.locations
            for cam in loc.cameras
        }
        self.historical_loading = True
        """True until the first full historical scan completes. The frontend
        shows a non-blocking 'historical still loading' affordance while set."""

    def camera_status(self) -> dict[LocCam, CameraScanState]:
        """Snapshot of per-camera cold-start scan progress."""
        return dict(self._camera_status)

    def start(self) -> None:
        """Launch the background loops."""
        self._tasks = [
            asyncio.create_task(self._current_day_loop(), name="poll-current"),
            asyncio.create_task(self._historical_loop(), name="poll-historical"),
        ]

    async def stop(self) -> None:
        """Signal loops to stop and await them."""
        self._stop.set()
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    # -- loops -----------------------------------------------------------

    async def _current_day_loop(self) -> None:
        cycle = 0
        log.info(
            "poll.current.start",
            day=self._current_day,
            interval_seconds=self._interval,
            prefixes=[
                f"{cam.name}/{self._current_day}/"
                for loc in self._models.locations
                for cam in loc.cameras
            ],
        )
        while not self._stop.is_set():
            try:
                await self._check_rollover()
                total = await self._scan_day(self._current_day)
                cycle += 1
                # Heartbeat at info level every minute or so so operators can
                # see polling is alive even when nothing is changing.
                if cycle % max(1, int(60 / max(self._interval, 0.1))) == 0:
                    log.info(
                        "poll.current.heartbeat",
                        day=self._current_day,
                        cycle=cycle,
                        events_last_cycle=total,
                    )
                self._fire_ready()
            except Exception:  # noqa: BLE001 - a bad cycle must not kill loop
                log.exception("poll.current.error")
            await self._sleep(self._interval)

    async def _historical_loop(self) -> None:
        # Recent-window-first, then a full sweep, then refresh on a slow
        # cadence. The recent phase makes the last N days viewable in seconds
        # while the full back-catalogue continues to load in the background.
        while not self._stop.is_set():
            try:
                cameras = sum(len(loc.cameras) for loc in self._models.locations)
                if self._recent_window_days > 0:
                    log.info(
                        "poll.recent.start",
                        cameras=cameras,
                        days=self._recent_window_days,
                    )
                    recent = await self._scan_recent_window()
                    log.info("poll.recent.done", events=recent)
                log.info("poll.historical.start", cameras=cameras)
                total = await self._scan_all_history()
                log.info("poll.historical.done", events=total)
                if self._cache_writer is not None:
                    await self._cache_writer()
                    log.info("cache.written")
            except Exception:  # noqa: BLE001
                log.exception("poll.historical.error")
            finally:
                if self.historical_loading:
                    self.historical_loading = False
                    log.info("poll.historical.idle")
            # Sleep until the next 12h cycle, an explicit rescan trigger, or
            # shutdown. A triggered rescan clears the flag and loops at once.
            await self._sleep_or_rescan(12 * 60 * 60)
            if self._rescan.is_set():
                self._rescan.clear()
                self.historical_loading = True
                log.info("poll.historical.rescan")

    # -- scanning --------------------------------------------------------

    async def _scan_day(self, day: str) -> int:
        # Per-location workers run concurrently; each location stays serial
        # internally so it doesn't fan-out onto its single boto3 client's
        # connection pool. With N locations each holding the slowest camera
        # ~10s, this cuts the cycle from sum() to max().
        per_location = await asyncio.gather(
            *(self._scan_day_for_location(loc, day) for loc in self._models.locations)
        )
        return sum(per_location)

    async def _scan_day_for_location(
        self, location: Location, day: str
    ) -> int:
        total = 0
        for camera in location.cameras:
            prefix = f"{camera.name}/{day}/"
            events = await asyncio.to_thread(
                self._poller.scan, location.name, prefix
            )
            total += len(events)
            if events:
                log.info(
                    "poll.scan",
                    scope="day",
                    location=location.name,
                    prefix=prefix,
                    events=len(events),
                )
                touched = await self._store.apply(events)
                await self._persist_slices(touched)
            else:
                log.debug(
                    "poll.scan.empty",
                    scope="day",
                    location=location.name,
                    prefix=prefix,
                )
        return total

    async def _scan_recent_window(self) -> int:
        # The recent window per camera: scan {camera}/{date}/ for the last N
        # observing-days first so recent history is viewable while the full
        # sweep runs. Locations parallel, cameras serial (same client-pool
        # reasoning as the full sweep).
        days = recent_day_obs(self._recent_window_days)
        per_location = await asyncio.gather(
            *(
                self._scan_recent_for_location(loc, days)
                for loc in self._models.locations
            )
        )
        return sum(per_location)

    async def _scan_recent_for_location(
        self, location: Location, days: list[str]
    ) -> int:
        total = 0
        for camera in location.cameras:
            for day in days:
                prefix = f"{camera.name}/{day}/"
                events = await asyncio.to_thread(
                    self._poller.scan, location.name, prefix
                )
                total += len(events)
                if events:
                    log.info(
                        "poll.scan",
                        scope="recent",
                        location=location.name,
                        prefix=prefix,
                        events=len(events),
                    )
                    touched = await self._store.apply(events)
                    await self._persist_slices(touched)
            self._mark(location.name, camera.name, "recent_ready")
        return total

    async def _scan_all_history(self) -> int:
        # Same shape as _scan_day: locations in parallel, cameras serial
        # within a location so a single S3 client's connection pool isn't
        # fanned out across cameras.
        per_location = await asyncio.gather(
            *(self._scan_history_for_location(loc) for loc in self._models.locations)
        )
        return sum(per_location)

    async def _scan_history_for_location(self, location: Location) -> int:
        # Scan each camera's whole prefix; the poller diffs against last time
        # so unchanged history produces no churn. The recent window uses
        # {camera}/{date}/ prefixes, which the poller tracks independently of
        # this {camera}/ prefix, so the first full sweep re-emits those recent
        # keys once — harmless, the store upserts. Recent dates change, so the
        # periodic re-scan is what keeps yesterday/last-week current.
        total = 0
        for camera in location.cameras:
            prefix = f"{camera.name}/"
            events = await asyncio.to_thread(
                self._poller.scan, location.name, prefix
            )
            total += len(events)
            log.info(
                "poll.scan",
                scope="historical",
                location=location.name,
                prefix=prefix,
                events=len(events),
            )
            if events:
                touched = await self._store.apply(events)
                await self._persist_slices(touched)
            # Recent may not have run (window=0); the full sweep also makes
            # recent data present, so mark both as it finishes each camera.
            self._mark(location.name, camera.name, "recent_ready")
            self._mark(location.name, camera.name, "full_complete")
        return total

    async def scan_date(self, location: str, camera: str, date: str) -> int:
        """Scan one camera-date prefix on demand and apply it to the store.

        Serves deep links to dates the store hasn't indexed yet (cold start
        before the full sweep completes, or data that landed between 12h
        refreshes). Cost is one prefix listing (~0.4-1s). Concurrent calls
        for the same (location, camera, date) share a single scan via the
        in-flight map. The current observing day is excluded: the 1s
        current-day loop owns it, so an extra listing buys nothing.

        Best-effort like the loops: an S3 failure is logged and reported as
        zero events so callers degrade to an empty payload rather than 500.
        """
        if date == get_current_day_obs():
            return 0
        key = (location, camera, date)
        task = self._on_demand.get(key)
        if task is None:
            task = asyncio.create_task(
                self._scan_date_once(location, camera, date),
                name=f"poll-on-demand-{camera}-{date}",
            )
            self._on_demand[key] = task
            task.add_done_callback(lambda _t: self._on_demand.pop(key, None))
        return await task

    async def _scan_date_once(self, location: str, camera: str, date: str) -> int:
        prefix = f"{camera}/{date}/"
        try:
            events = await asyncio.to_thread(self._poller.scan, location, prefix)
            if events:
                touched = await self._store.apply(events)
                await self._persist_slices(touched)
        except Exception:  # noqa: BLE001 - on-demand is best-effort
            log.exception(
                "poll.scan.error", scope="on-demand", location=location, prefix=prefix
            )
            return 0
        log.info(
            "poll.scan",
            scope="on-demand",
            location=location,
            prefix=prefix,
            events=len(events),
        )
        return len(events)

    def _mark(self, location: str, camera: str, flag: str) -> None:
        """Flip a per-camera scan-progress flag (idempotent)."""
        state = self._camera_status.get((location, camera))
        if state is not None:
            setattr(state, flag, True)

    async def _persist_slices(self, touched: set[tuple[str, str, str]]) -> None:
        """Write just the slices a scan changed, so history is durable as it
        is discovered rather than only after a full 12h cycle or shutdown."""
        if self._cache_slice_writer is None or not touched:
            return
        await self._cache_slice_writer(touched)

    async def _check_rollover(self) -> None:
        now_day = get_current_day_obs()
        if now_day != self._current_day:
            log.info("day.rollover", from_=self._current_day, to=now_day)
            old = self._current_day
            self._current_day = now_day
            # Notify each camera so live views reset to the new day.
            for location in self._models.locations:
                for camera in location.cameras:
                    self._store.bus.publish(
                        StoreChange("dayChange", location.name, camera.name, now_day)
                    )
            # Keep scanning yesterday for delayed per-day artifacts.
            await self._scan_day(old)

    def _fire_ready(self) -> None:
        if not self._ready_fired:
            self._ready_fired = True
            if self._on_ready is not None:
                self._on_ready()
            log.info("poll.ready")

    async def _sleep(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=seconds)
        except TimeoutError:
            pass

    async def _sleep_or_rescan(self, seconds: float) -> None:
        """Like ``_sleep`` but also wakes on a rescan trigger."""

        async def _wait_either() -> None:
            stop = asyncio.ensure_future(self._stop.wait())
            rescan = asyncio.ensure_future(self._rescan.wait())
            try:
                await asyncio.wait(
                    {stop, rescan}, return_when=asyncio.FIRST_COMPLETED
                )
            finally:
                stop.cancel()
                rescan.cancel()

        try:
            await asyncio.wait_for(_wait_either(), timeout=seconds)
        except TimeoutError:
            pass

    def trigger_rescan(self) -> None:
        """Request an immediate historical rescan.

        Wakes the historical loop out of its long sleep; it then re-runs the
        recent-window and full-history sweeps. Used after the admin flushes
        the cache, so the emptied store cold-rebuilds from S3 right away.
        """
        self._rescan.set()
