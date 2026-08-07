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
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from lsst.ts.rubintv.config.models import Location, Models
from lsst.ts.rubintv.data.dayobs import get_current_day_obs, recent_day_obs
from lsst.ts.rubintv.data.events import StoreChange
from lsst.ts.rubintv.data.source import S3Poller
from lsst.ts.rubintv.data.store import EventStore
from lsst.ts.rubintv.logging import get_logger

log = get_logger(__name__)

# Called after the first full current-day scan completes, to flip readiness.
ReadyCallback = Callable[[], None]

# Per-(location, camera) key, mirroring the store's index keying.
LocCam = tuple[str, str]

# A current-day cycle slower than this (wall-clock seconds) is flagged as
# degraded. A healthy USDF cycle is ~0.8s (see the latency table above), so
# this is well clear of normal jitter while still well under the 5-10s the
# poller client now waits before a hung connection raises outright.
SLOW_CYCLE_SECONDS = 5.0

# Ceiling on concurrent on-demand (deep-link) date scans. Deep-link backfill is
# reachable from any authenticated request, so this caps its S3 fan-out well
# below the ~4-worker endpoint ceiling to keep the live poller responsive.
_ON_DEMAND_MAX_CONCURRENCY = 3

# How many distinct (location, camera, date) empty results to remember, so a
# client repeatedly requesting valid-but-nonexistent dates doesn't re-scan S3
# every time. Bounded (FIFO eviction) so the memo itself can't grow unbounded.
_ON_DEMAND_EMPTY_MAX = 4096

# Retry delay after a failed historical sweep. A transient S3 blip during the
# cold scan must not hide the back-catalogue for the full refresh cadence —
# the current-day loop retries every second; history retries on this backoff.
_HISTORICAL_RETRY_SECONDS = 60.0

# Cadence of the periodic historical refresh after a successful sweep.
_HISTORICAL_REFRESH_SECONDS = 12 * 60 * 60


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
        cache_slice_deleter: (
            Callable[[set[tuple[str, str, str]]], Awaitable[None]] | None
        ) = None,
        metadata_warmer: Callable[[str, str], Awaitable[None]] | None = None,
    ) -> None:
        self._models = models
        self._store = store
        self._poller = poller
        self._interval = poll_interval
        self._recent_window_days = recent_window_days
        self._on_ready = on_ready
        self._cache_writer = cache_writer
        self._cache_slice_writer = cache_slice_writer
        self._cache_slice_deleter = cache_slice_deleter
        self._metadata_warmer = metadata_warmer
        self._current_day = get_current_day_obs()
        self._tasks: list[asyncio.Task[None]] = []
        self._stop = asyncio.Event()
        # Set to interrupt the historical loop's 12h sleep and start a fresh
        # sweep immediately (the admin 'flush historical cache' action).
        self._rescan = asyncio.Event()
        # In-flight on-demand date scans, keyed (location, camera, date), so
        # concurrent requests for the same missing date share one S3 listing.
        self._on_demand: dict[tuple[str, str, str], asyncio.Task[int]] = {}
        # On-demand backfill is reachable from any authenticated request; bound
        # its S3 fan-out so a flood of distinct dates can't saturate the thread
        # pool / S3 connection pool and starve the live poller.
        self._on_demand_sem = asyncio.Semaphore(_ON_DEMAND_MAX_CONCURRENCY)
        # Dates a recent on-demand scan found empty, so a client hammering a
        # valid-but-nonexistent date doesn't buy one S3 listing per request.
        # A later real change is still picked up by the periodic sweep.
        self._on_demand_empty: OrderedDict[tuple[str, str, str], None] = OrderedDict()
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
        shows a non-blocking 'historical still loading' affordance while
        set."""
        # Whether the most recent current-day poll cycle reached S3. Starts
        # True (optimistic) and flips on the first failed/succeeded cycle, so
        # the frontend can show an 'S3 unreachable' alert when a cycle throws
        # (e.g. a botocore ConnectTimeout to the bucket endpoint).
        self.s3_healthy = True
        # Whether the most recent successful cycle was unusually slow. A
        # degrading link (high latency before it fails outright) shows up here
        # as an amber 'S3 slow' warning ahead of the red 'unreachable' alert.
        self.s3_slow = False
        # Wall-clock seconds of the most recent successful current-day cycle,
        # so the status view can show the actual latency (and watch it trend
        # toward SLOW_CYCLE_SECONDS) rather than just the slow/not-slow flag.
        # 0.0 until the first cycle completes; unchanged by a failed cycle.
        self.s3_last_cycle_seconds = 0.0

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
                started = time.monotonic()
                await self._check_rollover()
                total = await self._scan_day(self._current_day)
                elapsed = time.monotonic() - started
                cycle += 1
                # Heartbeat at info level every minute or so so operators can
                # see polling is alive even when nothing is changing.
                if cycle % max(1, int(60 / max(self._interval, 0.1))) == 0:
                    log.info(
                        "poll.current.heartbeat",
                        day=self._current_day,
                        cycle=cycle,
                        events_last_cycle=total,
                        cycle_seconds=round(elapsed, 2),
                    )
                # A slow-but-successful cycle warns of a degrading link before
                # it fails outright — log the transition into the slow state.
                slow = elapsed > SLOW_CYCLE_SECONDS
                if slow and not self.s3_slow:
                    log.warning(
                        "poll.current.slow",
                        cycle_seconds=round(elapsed, 2),
                        threshold_seconds=SLOW_CYCLE_SECONDS,
                    )
                self.s3_slow = slow
                self.s3_last_cycle_seconds = elapsed
                self.s3_healthy = True
                self._fire_ready()
            except Exception:  # noqa: BLE001 - a bad cycle must not kill loop
                # A thrown cycle means S3 was unreachable (e.g. a connect
                # timeout to the bucket endpoint). Surface it so the frontend
                # can alert; the loop keeps retrying every interval.
                self.s3_healthy = False
                self.s3_slow = False
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
                # A failed sweep leaves history incomplete: keep the loading
                # flag honest (still True on a cold start, so the frontend
                # keeps showing its affordance) and retry on a short backoff
                # rather than sleeping the full refresh cadence with a gap.
                log.exception("poll.historical.error")
                await self._pause(_HISTORICAL_RETRY_SECONDS)
                continue
            if self.historical_loading:
                self.historical_loading = False
                log.info("poll.historical.idle")
            # Sleep until the next refresh cycle, an explicit rescan trigger,
            # or shutdown. A triggered rescan clears the flag and loops at
            # once.
            await self._pause(_HISTORICAL_REFRESH_SECONDS)

    async def _pause(self, seconds: float) -> None:
        """Historical-loop sleep that also honours a triggered rescan."""
        await self._sleep_or_rescan(seconds)
        if self._rescan.is_set():
            self._rescan.clear()
            self.historical_loading = True
            log.info("poll.historical.rescan")

    # -- scanning --------------------------------------------------------

    @staticmethod
    async def _gather_locations(coros: list[Awaitable[int]]) -> int:
        """Run per-location workers to completion, then raise any failure.

        A bare ``gather`` raises as soon as one location fails, leaving the
        others running detached — the next cycle would then scan the same
        prefixes concurrently with the abandoned workers, racing on the
        poller's diff state and doubling S3 load. Barrier first (so every
        worker has finished), then propagate.
        """
        results = await asyncio.gather(*coros, return_exceptions=True)
        errors = [r for r in results if isinstance(r, BaseException)]
        for extra in errors[1:]:
            # Only the first failure propagates (and gets a traceback from
            # the loop's handler); don't let the rest vanish silently.
            log.error("poll.scan.location_error", error=repr(extra))
        if errors:
            raise errors[0]
        return sum(r for r in results if isinstance(r, int))

    async def _scan_day(self, day: str) -> int:
        # Per-location workers run concurrently; each location stays serial
        # internally so it doesn't fan-out onto its single boto3 client's
        # connection pool. With N locations each holding the slowest camera
        # ~10s, this cuts the cycle from sum() to max().
        return await self._gather_locations(
            [self._scan_day_for_location(loc, day) for loc in self._models.locations]
        )

    async def _scan_day_for_location(self, location: Location, day: str) -> int:
        total = 0
        for camera in location.cameras:
            prefix = f"{camera.name}/{day}/"
            events = await asyncio.to_thread(self._poller.scan, location.name, prefix)
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
        return await self._gather_locations(
            [
                self._scan_recent_for_location(loc, days)
                for loc in self._models.locations
            ]
        )

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
            await self._warm_metadata(location.name, camera.name)
        return total

    async def _scan_all_history(self) -> int:
        # Same shape as _scan_day: locations in parallel, cameras serial
        # within a location so a single S3 client's connection pool isn't
        # fanned out across cameras.
        return await self._gather_locations(
            [self._scan_history_for_location(loc) for loc in self._models.locations]
        )

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
            # scan_full returns the dates from *this* listing, so the prune
            # below can't be poisoned by a concurrent reset()/on-demand scan
            # mutating the poller's shared _seen between the listing and the
            # prune.
            events, observed = await asyncio.to_thread(
                self._poller.scan_full, location.name, prefix
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
            # The full {camera}/ listing is authoritative for which dates
            # exist: prune any indexed date it didn't observe (stale warm-start
            # cache slices whose keys were deleted while we were down — the
            # poller diff can't emit REMOVED for keys it never saw). Protect
            # the current observing day: the fast current-day loop may have
            # inserted today's first keys after this sweep listed the prefix,
            # so the listing wouldn't include them and prune would wrongly drop
            # today.
            pruned = await self._store.prune_dates(
                (location.name, camera.name),
                observed,
                protect={get_current_day_obs()},
            )
            await self._evict_slices(location.name, camera.name, pruned)
            # Recent may not have run (window=0); the full sweep also makes
            # recent data present, so mark both as it finishes each camera.
            self._mark(location.name, camera.name, "recent_ready")
            self._mark(location.name, camera.name, "full_complete")
            # Only warm here when the recent phase is disabled; otherwise the
            # recent scan already warmed these dates and re-warming is
            # redundant.
            if self._recent_window_days <= 0:
                await self._warm_metadata(location.name, camera.name)
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

        A date a recent scan found empty is remembered and answered 0 without
        re-listing S3, so a client hammering a nonexistent date can't amplify
        into one listing per request. The scan is also concurrency-capped
        (``_ON_DEMAND_MAX_CONCURRENCY``) so a burst of distinct dates can't
        saturate the S3/thread pools and starve the live poller.
        """
        if date == get_current_day_obs():
            return 0
        key = (location, camera, date)
        if key in self._on_demand_empty:
            log.debug("poll.scan.empty_cached", location=location, prefix=key)
            return 0
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
            async with self._on_demand_sem:
                events = await asyncio.to_thread(self._poller.scan, location, prefix)
            if events:
                touched = await self._store.apply(events)
                await self._persist_slices(touched)
        except Exception:  # noqa: BLE001 - on-demand is best-effort
            log.exception(
                "poll.scan.error", scope="on-demand", location=location, prefix=prefix
            )
            return 0
        if not events:
            self._remember_empty((location, camera, date))
        log.info(
            "poll.scan",
            scope="on-demand",
            location=location,
            prefix=prefix,
            events=len(events),
        )
        return len(events)

    def _remember_empty(self, key: tuple[str, str, str]) -> None:
        """Record a date that scanned empty (bounded FIFO)."""
        self._on_demand_empty[key] = None
        self._on_demand_empty.move_to_end(key)
        while len(self._on_demand_empty) > _ON_DEMAND_EMPTY_MAX:
            self._on_demand_empty.popitem(last=False)

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

    async def _evict_slices(self, location: str, camera: str, dates: set[str]) -> None:
        """Delete cache slices for dates pruned as stale, so they don't seed
        the calendar again on the next warm start."""
        if self._cache_slice_deleter is None or not dates:
            return
        await self._cache_slice_deleter({(location, camera, date) for date in dates})

    async def _warm_metadata(self, location: str, camera: str) -> None:
        """Pre-fetch recent metadata for a camera once its recent scan is done.

        Best-effort: a warming failure must not interrupt the scan loop (the
        metadata is still fetchable on demand), so errors are logged and
        swallowed. The warmer itself decides how many recent dates to load.
        """
        if self._metadata_warmer is None:
            return
        try:
            await self._metadata_warmer(location, camera)
        except Exception:  # noqa: BLE001 - warming is best-effort
            log.exception("poll.metadata.warm.error", location=location, camera=camera)

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
                await asyncio.wait({stop, rescan}, return_when=asyncio.FIRST_COMPLETED)
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
        # Drop the negative memo: a flush means the world may have changed, so
        # a date previously seen empty must be re-scannable on demand again.
        self._on_demand_empty.clear()
        self._rescan.set()
