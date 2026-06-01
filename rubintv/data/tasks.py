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

from rubintv.config.models import Location, Models
from rubintv.data.dayobs import get_current_day_obs
from rubintv.data.events import StoreChange
from rubintv.data.source import S3Poller
from rubintv.data.store import EventStore
from rubintv.logging import get_logger

log = get_logger(__name__)

# Called after the first full current-day scan completes, to flip readiness.
ReadyCallback = Callable[[], None]


class PollEngine:
    """Owns the background scan loops over a DataSource into the store."""

    def __init__(
        self,
        models: Models,
        store: EventStore,
        poller: S3Poller,
        *,
        poll_interval: float = 1.0,
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
        self._on_ready = on_ready
        self._cache_writer = cache_writer
        self._cache_slice_writer = cache_slice_writer
        self._current_day = get_current_day_obs()
        self._tasks: list[asyncio.Task[None]] = []
        self._stop = asyncio.Event()
        self._ready_fired = False
        self.historical_loading = True
        """True until the first full historical scan completes. The frontend
        shows a non-blocking 'historical still loading' affordance while set."""

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
        # One full scan at startup, then refresh on a slow cadence.
        while not self._stop.is_set():
            try:
                log.info(
                    "poll.historical.start",
                    cameras=sum(len(loc.cameras) for loc in self._models.locations),
                )
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
            await self._sleep(12 * 60 * 60)  # 12h

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
        # so unchanged history produces no churn. Recent dates change, so the
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
        return total

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
