"""Background tasks that fill the EventStore.

All tasks push into the store via the same ``DataSource``, so they share one
code path and differ only in *what* they scan and *how often*:

- current-day poller: today's prefixes, fast loop (~1s)
- historical scanner: full back-catalogue on startup, then periodic refresh
  that re-checks recent dates (data is mutable) more often than old ones
- yesterday poller: catches delayed per-day artifacts after rollover

Day rollover (UTC-12) is detected by the current-day loop and published as a
``dayChange`` so clients reset their live views.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from rubintv.config.models import Models
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
    ) -> None:
        self._models = models
        self._store = store
        self._poller = poller
        self._interval = poll_interval
        self._on_ready = on_ready
        self._cache_writer = cache_writer
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
        while not self._stop.is_set():
            try:
                await self._check_rollover()
                await self._scan_day(self._current_day)
                self._fire_ready()
            except Exception:  # noqa: BLE001 - a bad cycle must not kill loop
                log.exception("poll.current.error")
            await self._sleep(self._interval)

    async def _historical_loop(self) -> None:
        # One full scan at startup, then refresh on a slow cadence.
        while not self._stop.is_set():
            try:
                await self._scan_all_history()
                if self._cache_writer is not None:
                    await self._cache_writer()
            except Exception:  # noqa: BLE001
                log.exception("poll.historical.error")
            finally:
                if self.historical_loading:
                    self.historical_loading = False
                    log.info("poll.historical.idle")
            await self._sleep(12 * 60 * 60)  # 12h

    # -- scanning --------------------------------------------------------

    async def _scan_day(self, day: str) -> None:
        for location in self._models.locations:
            for camera in location.cameras:
                prefix = f"{camera.name}/{day}/"
                events = await asyncio.to_thread(
                    self._poller.scan, location.name, prefix
                )
                if events:
                    log.info(
                        "poll.scan",
                        scope="day",
                        location=location.name,
                        prefix=prefix,
                        events=len(events),
                    )
                    await self._store.apply(events)

    async def _scan_all_history(self) -> None:
        # Scan each camera's whole prefix; the poller diffs against last time
        # so unchanged history produces no churn. Recent dates change, so the
        # periodic re-scan is what keeps yesterday/last-week current.
        for location in self._models.locations:
            for camera in location.cameras:
                prefix = f"{camera.name}/"
                events = await asyncio.to_thread(
                    self._poller.scan, location.name, prefix
                )
                log.info(
                    "poll.scan",
                    scope="historical",
                    location=location.name,
                    prefix=prefix,
                    events=len(events),
                )
                if events:
                    await self._store.apply(events)

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
