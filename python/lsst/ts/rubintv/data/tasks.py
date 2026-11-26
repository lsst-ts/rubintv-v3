# This file is part of rubintv-v3.
#
# Developed for the Vera C. Rubin Observatory Telescope and Site Systems.
# This product includes software developed by the LSST Project
# (https://www.lsst.org).
# See the COPYRIGHT file at the top-level directory of this distribution
# for details of code ownership.
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

"""Background tasks that fill the EventStore.

All tasks push into the store via the same ``DataSource``, so they share one
code path and differ only in *what* they scan and *how often*:

- current-day poller: today's prefixes, fast loop (~1s)
- previous-day poller: yesterday's prefixes every ``previous_day_refresh``
  (2 min), for what lands after rollover (final movies, analysis catching
  up, metadata rewrites)
- historical scanner: recent window then the full back-catalogue on startup;
  afterwards the recent window — plus each camera's few most recent data
  days outside it — is re-scanned every ``recent_refresh`` (2h) and the full
  sweep repeats every 12h: recent dates are mutable, old ones rarely are
- on-demand scan: one camera-date, for a request that hits an unindexed date

A day is reconciled by one loop. Reconciling drops whatever a listing
didn't see, so a slower loop's older listing of a day would drop what a
faster loop had indexed since: the historical scanner leaves today to the
current-day poller and yesterday to the previous-day poller.

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
from lsst.ts.rubintv.data.source import S3Poller, ScanResult
from lsst.ts.rubintv.data.store import EventStore, ScanScope
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

# A current-day cycle still running after this long is reported as stalled.
# A cycle that can't reach S3 fails inside the poller client's timeouts
# (about 20s) and reads as unreachable, so only one parked on something with
# no timeout of its own gets this far.
STALLED_CYCLE_SECONDS = 60.0

# How often the watchdog looks for a stalled cycle. The cycle can't log its
# own stall, and the status endpoint only works it out when asked.
_WATCHDOG_SECONDS = 10.0

# How long a scan waits for the cache volume to take the slices it changed
# before carrying on without it. A volume that hangs (a PVC whose backing
# store has gone away blocks in the kernel, it doesn't fail) then costs how
# current the next warm start is, not the live poll.
CACHE_WAIT_SECONDS = 5.0

# The same for the whole-cache rewrite that follows a full sweep, which is
# thousands of files and takes a while on a healthy volume.
CACHE_REWRITE_WAIT_SECONDS = 60.0

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

# Cadence of the periodic full-catalogue refresh after a successful sweep.
# The recent window refreshes more often (``recent_refresh``) in between.
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


class _CacheWrites:
    """One kind of write to the cache volume, waited on for only so long.

    ``write`` runs in a task of its own, one at a time. A caller that has
    waited ``wait`` seconds for it carries on, and from then until it
    finishes callers don't wait at all (``write`` picks up whatever they
    left for it when it gets there). A hung volume so holds one worker
    thread, not one per poll cycle, and stops no scan; nor does a write that
    fails, which is logged here.
    """

    def __init__(self, what: str, write: Callable[[], Awaitable[None]]) -> None:
        self._what = what
        self._write = write
        self._job: asyncio.Task[None] | None = None
        self._started = 0.0
        self._overdue = False

    def overdue_seconds(self) -> float | None:
        """How long the write now running has been, once a caller has given
        up waiting for it; ``None`` while the volume is keeping up."""
        if not self._overdue or self._job is None or self._job.done():
            return None
        return time.monotonic() - self._started

    async def flush(self, wait: float) -> None:
        job = self._job
        if job is None or job.done():
            job = self._job = asyncio.create_task(
                self._run(), name=f"poll-cache-{self._what}"
            )
        elif self._overdue:
            return
        done, _ = await asyncio.wait({job}, timeout=wait)
        if not done and not self._overdue:
            self._overdue = True
            log.warning("cache.write.stalled", what=self._what, waited_seconds=wait)

    async def _run(self) -> None:
        self._started = time.monotonic()
        try:
            await self._write()
        except Exception:  # noqa: BLE001 - the cache is best-effort
            log.exception("cache.write.error", what=self._what)
        if self._overdue:
            self._overdue = False
            log.info(
                "cache.write.resumed",
                what=self._what,
                write_seconds=round(time.monotonic() - self._started, 1),
            )

    def cancel(self) -> None:
        if self._job is not None:
            self._job.cancel()


class PollEngine:
    """Owns the background scan loops over a DataSource into the store."""

    def __init__(
        self,
        models: Models,
        store: EventStore,
        poller: S3Poller,
        *,
        poll_interval: float = 1.0,
        previous_day_refresh: float = 2 * 60,
        recent_window_days: int = 30,
        recent_refresh: float = 2 * 60 * 60,
        recent_known_days: int = 5,
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
        self._previous_day_refresh = previous_day_refresh
        self._recent_window_days = recent_window_days
        self._recent_refresh = recent_refresh
        self._recent_known_days = recent_known_days
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
        # When the current-day cycle now running began, None between cycles,
        # and when one last succeeded, None until one has (both monotonic).
        # The flags above are only written as a cycle ends, so a cycle that
        # never ends leaves them saying what the last one found; these two
        # are what show it.
        self._cycle_started: float | None = None
        self._last_poll: float | None = None
        self._stall_logged = False
        # Cache slices waiting to be written (True) or deleted (False), and
        # the two kinds of cache write. They are waited on separately, so a
        # scan's few slices don't queue behind the whole-cache rewrite.
        self._slices_pending: dict[tuple[str, str, str], bool] = {}
        self._slice_writes = _CacheWrites("slices", self._write_pending_slices)
        self._cache_rewrite = _CacheWrites("rewrite", self._rewrite_cache)

    def poll_stalled(self) -> bool:
        """Whether the current-day cycle now running has overrun
        ``STALLED_CYCLE_SECONDS``: the live poll has stopped, whatever
        ``s3_healthy`` still says of the cycle before it."""
        return self._cycle_running_seconds() > STALLED_CYCLE_SECONDS

    def cache_write_stalled_seconds(self) -> float | None:
        """How long a cache write has been outstanding, once scans have
        stopped waiting for it: the volume isn't taking writes. ``None``
        while it is keeping up."""
        overdue = [
            seconds
            for writes in (self._slice_writes, self._cache_rewrite)
            if (seconds := writes.overdue_seconds()) is not None
        ]
        return max(overdue) if overdue else None

    def _cycle_running_seconds(self) -> float:
        started = self._cycle_started
        return 0.0 if started is None else time.monotonic() - started

    def last_poll_age_seconds(self) -> float | None:
        """Seconds since a current-day cycle last succeeded: how far behind
        the bucket today's index may be. ``None`` until one has."""
        if self._last_poll is None:
            return None
        return time.monotonic() - self._last_poll

    def camera_status(self) -> dict[LocCam, CameraScanState]:
        """Snapshot of per-camera cold-start scan progress."""
        return dict(self._camera_status)

    def start(self) -> None:
        """Launch the background loops."""
        self._tasks = [
            asyncio.create_task(self._current_day_loop(), name="poll-current"),
            asyncio.create_task(self._historical_loop(), name="poll-historical"),
            asyncio.create_task(self._watchdog_loop(), name="poll-watchdog"),
        ]
        if self._previous_day_refresh > 0:
            self._tasks.append(
                asyncio.create_task(self._previous_day_loop(), name="poll-previous")
            )

    async def stop(self) -> None:
        """Signal loops to stop and await them."""
        self._stop.set()
        self._slice_writes.cancel()
        self._cache_rewrite.cancel()
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    # -- loops -----------------------------------------------------------

    async def _current_day_loop(self) -> None:
        cycle = 0
        # Cycle times since the last heartbeat, which sums them.
        timed: list[float] = []
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
            started = self._cycle_started = time.monotonic()
            try:
                await self._check_rollover()
                total = await self._scan_day(self._current_day)
                self._last_poll = time.monotonic()
                elapsed = self._last_poll - started
                cycle += 1
                timed.append(elapsed)
                # Heartbeat at info level every minute or so so operators can
                # see polling is alive even when nothing is changing. It
                # carries the spread of the cycles since the last one: a line
                # for each, one a second, was most of a debug log.
                if cycle % max(1, int(60 / max(self._interval, 0.1))) == 0:
                    log.info(
                        "poll.current.heartbeat",
                        day=self._current_day,
                        cycle=cycle,
                        cycles=len(timed),
                        keys_last_cycle=total,
                        cycle_seconds_min=round(min(timed), 3),
                        cycle_seconds_mean=round(sum(timed) / len(timed), 3),
                        cycle_seconds_max=round(max(timed), 3),
                    )
                    timed.clear()
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
            if self._stall_logged:
                self._stall_logged = False
                log.info(
                    "poll.current.resumed",
                    cycle_seconds=round(time.monotonic() - started, 1),
                )
            self._cycle_started = None
            await self._sleep(self._interval)

    async def _previous_day_loop(self) -> None:
        # Its own task, not a step of either other loop: the historical loop
        # refreshes nothing while a full sweep runs, and a cycle of the
        # current-day loop shouldn't wait on yesterday's listings. The first
        # pass runs at once: the recent window leaves yesterday to this.
        while not self._stop.is_set():
            day = recent_day_obs(2)[1]
            started = time.monotonic()
            try:
                total = await self._scan_day(day)
                log.debug(
                    "poll.previous.refresh",
                    day=day,
                    keys=total,
                    cycle_seconds=round(time.monotonic() - started, 3),
                )
            except Exception:  # noqa: BLE001 - a bad pass must not kill loop
                log.exception("poll.previous.error", day=day)
            await self._sleep(self._previous_day_refresh)

    async def _watchdog_loop(self) -> None:
        while not self._stop.is_set():
            await self._sleep(_WATCHDOG_SECONDS)
            self._check_stall()

    def _check_stall(self) -> None:
        """Log a current-day cycle that has stalled, once per stall."""
        if self._stall_logged or not self.poll_stalled():
            return
        self._stall_logged = True
        age = self.last_poll_age_seconds()
        log.error(
            "poll.current.stalled",
            day=self._current_day,
            running_seconds=round(self._cycle_running_seconds(), 1),
            threshold_seconds=STALLED_CYCLE_SECONDS,
            last_poll_age_seconds=None if age is None else round(age, 1),
        )

    async def _historical_loop(self) -> None:
        # Recent-window-first, then a full sweep. The recent phase makes the
        # last N days viewable in seconds while the full back-catalogue
        # continues to load in the background. Between full sweeps the recent
        # window is re-scanned on its own, shorter cadence.
        while not self._stop.is_set():
            try:
                cameras = sum(len(loc.cameras) for loc in self._models.locations)
                if self._recent_window_days > 0:
                    log.info(
                        "poll.recent.start",
                        cameras=cameras,
                        days=self._recent_window_days,
                    )
                    started = time.monotonic()
                    recent, listings = await self._scan_recent_window()
                    log.info(
                        "poll.recent.done",
                        events=recent,
                        listings=listings,
                        pass_seconds=round(time.monotonic() - started, 1),
                    )
                log.info("poll.historical.start", cameras=cameras)
                started = time.monotonic()
                total = await self._scan_all_history()
                log.info(
                    "poll.historical.done",
                    events=total,
                    sweep_seconds=round(time.monotonic() - started, 1),
                )
                await self._cache_rewrite.flush(CACHE_REWRITE_WAIT_SECONDS)
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
            # Until the next full sweep, an explicit rescan trigger, or
            # shutdown: keep the recent window fresh. A triggered rescan
            # loops at once.
            await self._refresh_recent_until(_HISTORICAL_REFRESH_SECONDS)

    async def _refresh_recent_until(self, seconds: float) -> None:
        """Wait ``seconds``, re-scanning the recent window every
        ``recent_refresh`` meanwhile.

        Returns early on a rescan trigger or stop. A failed recent pass is
        logged and retried at the next tick — the current-day loop already
        surfaces S3 health, and the full sweep's own retry covers the
        catalogue — so one blip can't stall the refresh cadence.
        """
        deadline = time.monotonic() + seconds
        periodic = self._recent_window_days > 0 and self._recent_refresh > 0
        while not self._stop.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            step = min(remaining, self._recent_refresh) if periodic else remaining
            if await self._pause(step) or self._stop.is_set():
                return
            if time.monotonic() >= deadline:
                return
            started = time.monotonic()
            try:
                events, listings = await self._scan_recent_window(warm=False)
                log.info(
                    "poll.recent.refresh",
                    events=events,
                    listings=listings,
                    pass_seconds=round(time.monotonic() - started, 1),
                )
            except Exception:  # noqa: BLE001 - a bad pass must not kill loop
                log.exception("poll.recent.error")

    async def _pause(self, seconds: float) -> bool:
        """Historical-loop sleep that also honours a triggered rescan.

        Returns True if a rescan was requested, so the caller can drop
        whatever it was waiting on and let the loop start a fresh sweep.
        """
        await self._sleep_or_rescan(seconds)
        if self._rescan.is_set():
            self._rescan.clear()
            self.historical_loading = True
            log.info("poll.historical.rescan")
            return True
        return False

    # -- scanning --------------------------------------------------------

    @staticmethod
    async def _gather_locations(coros: list[Awaitable[int]]) -> int:
        """Run per-location workers to completion, then raise any failure.

        A bare ``gather`` raises as soon as one location fails, leaving the
        others running detached — the next cycle would then scan the same
        prefixes concurrently with the abandoned workers, doubling S3 load
        and interleaving their store updates. Barrier first (so every
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
            result = await asyncio.to_thread(self._poller.scan, location.name, prefix)
            total += len(result.events)
            await self._apply_scan("day", location.name, prefix, result)
            # This listing is authoritative for exactly one date, so scope
            # reconciliation to it — an empty result legitimately means
            # "everything for today was deleted" and must still be applied.
            await self._reconcile_day(location.name, camera.name, day, result)
        return total

    async def _apply_scan(
        self, scope: str, location: str, prefix: str, result: ScanResult
    ) -> set[tuple[str, str, str]]:
        """Apply one listing to the store, persist what changed, and log it.

        ``poll.scan`` is info when something changed. An unchanged listing
        is the routine case, and only one made on demand is logged, at debug.
        The loops' aren't: the current-day loop re-lists every prefix each
        second and a recent pass makes hundreds of listings in a burst, so
        even at debug that was mostly lines saying nothing happened. Each
        loop's own line sums them instead (``poll.current.heartbeat``,
        ``poll.previous.refresh``, ``poll.recent.done``).
        """
        touched: set[tuple[str, str, str]] = set()
        if result.events:
            touched = await self._store.apply(result.events)
            await self._persist_slices(touched)
        if touched or scope == "on-demand":
            emit = log.info if touched else log.debug
            emit(
                "poll.scan",
                scope=scope,
                location=location,
                prefix=prefix,
                keys=len(result.keys),
                slices_touched=len(touched),
            )
        return touched

    async def _reconcile_day(
        self, location: str, camera: str, day: str, result: ScanResult
    ) -> None:
        """Reconcile a single-date listing against the store."""
        outcome = await self._store.reconcile(
            (location, camera),
            result.keys,
            ScanScope(dates=frozenset({day})),
        )
        await self._evict_slices(location, camera, outcome.dropped)
        # apply persisted the slices it inserted into; a date that only lost
        # slots is stale on disk until rewritten here.
        await self._persist_slices({(location, camera, d) for d in outcome.changed})

    def _live_days(self) -> frozenset[str]:
        """The days a faster loop than the historical one lists: today, and
        yesterday while the previous-day refresh is on."""
        return frozenset(recent_day_obs(2 if self._previous_day_refresh > 0 else 1))

    async def _scan_recent_window(self, *, warm: bool = True) -> tuple[int, int]:
        """Scan every camera's recent dates: the window, plus known data days.

        Returns the events found and the listings made.

        The window is the last N observing days whether or not they hold
        data, so new data landing on a quiet recent day is still found. On
        top of that each camera gets its ``recent_known_days`` most recent
        dates *with* data outside the window, from its calendar — a camera
        that observes rarely would otherwise list thirty empty days and never
        re-check the days that matter until the full sweep.

        Today is not listed: the current-day loop has a newer listing of it
        every second, and reconciling it from this one would drop frames
        that loop had just indexed. Nor is yesterday while the previous-day
        loop is on, for the same reason.

        Locations run in parallel, cameras serially within one (same
        client-pool reasoning as the full sweep). ``warm`` pre-fetches recent
        metadata afterwards; only the cold start wants that — the periodic
        pass would otherwise re-download today's file per camera every tick.
        """
        days = recent_day_obs(self._recent_window_days)
        live = self._live_days()
        window = [d for d in days if d not in live]
        known = {
            (loc.name, cam.name): self._known_days(loc.name, cam.name, days)
            for loc in self._models.locations
            for cam in loc.cameras
        }
        known_days = sum(len(d) for d in known.values())
        log.debug("poll.recent.plan", window_days=len(window), known_days=known_days)
        events = await self._gather_locations(
            [
                self._scan_recent_for_location(loc, window, known, warm=warm)
                for loc in self._models.locations
            ]
        )
        # One listing per camera for each day of the window, and one for
        # each of its known days.
        return events, len(window) * len(known) + known_days

    def _known_days(self, location: str, camera: str, window: list[str]) -> list[str]:
        """A camera's most recent data days that the window doesn't cover."""
        if self._recent_known_days <= 0:
            return []
        inside = set(window)
        calendar = self._store.calendar(location, camera)  # newest first
        return [d for d in calendar if d not in inside][: self._recent_known_days]

    async def _scan_recent_for_location(
        self,
        location: Location,
        window: list[str],
        known: dict[LocCam, list[str]],
        *,
        warm: bool,
    ) -> int:
        total = 0
        for camera in location.cameras:
            days = window + known.get((location.name, camera.name), [])
            for day in days:
                prefix = f"{camera.name}/{day}/"
                result = await asyncio.to_thread(
                    self._poller.scan, location.name, prefix
                )
                total += len(result.events)
                await self._apply_scan("recent", location.name, prefix, result)
                await self._reconcile_day(location.name, camera.name, day, result)
            self._mark(location.name, camera.name, "recent_ready")
            if warm:
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
        # Scan each camera's whole prefix. The poller is stateless, so every
        # sweep re-emits every key (including the recent window's, already
        # scanned by date) — harmless to the index, the store upserts. Recent
        # dates change, so the periodic re-scan is what keeps
        # yesterday/last-week current.
        total = 0
        for camera in location.cameras:
            prefix = f"{camera.name}/"
            live = self._live_days()
            result = await asyncio.to_thread(self._poller.scan, location.name, prefix)
            total += len(result.events)
            await self._apply_scan("historical", location.name, prefix, result)
            # The full {camera}/ listing is authoritative for the whole
            # camera, so reconcile with an unbounded scope: dates the listing
            # didn't see are gone (e.g. stale warm-start slices whose keys
            # were deleted while we were down). Protect the days a faster
            # loop lists — it may have inserted keys *after* this sweep
            # listed the prefix, so the listing wouldn't include them and
            # reconciliation would wrongly drop them. Those days are taken
            # both before the listing and now: a sweep that crosses rollover
            # has listed the old days while they were still live.
            outcome = await self._store.reconcile(
                (location.name, camera.name),
                result.keys,
                ScanScope(protect=live | self._live_days()),
            )
            await self._evict_slices(location.name, camera.name, outcome.dropped)
            await self._persist_slices(
                {(location.name, camera.name, d) for d in outcome.changed}
            )
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
                result = await asyncio.to_thread(self._poller.scan, location, prefix)
            await self._apply_scan("on-demand", location, prefix, result)
            await self._reconcile_day(location, camera, date, result)
        except Exception:  # noqa: BLE001 - on-demand is best-effort
            log.exception(
                "poll.scan.error", scope="on-demand", location=location, prefix=prefix
            )
            return 0
        if not result.events:
            self._remember_empty((location, camera, date))
        return len(result.events)

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
        for key in touched:
            self._slices_pending[key] = True
        await self._slice_writes.flush(CACHE_WAIT_SECONDS)

    async def _evict_slices(self, location: str, camera: str, dates: set[str]) -> None:
        """Delete cache slices for dates pruned as stale, so they don't seed
        the calendar again on the next warm start."""
        if self._cache_slice_deleter is None or not dates:
            return
        for date in dates:
            self._slices_pending[(location, camera, date)] = False
        await self._slice_writes.flush(CACHE_WAIT_SECONDS)

    async def _write_pending_slices(self) -> None:
        # Until nothing is left, so slices queued while this was writing (or
        # hung) go out as it finishes.
        while self._slices_pending:
            pending, self._slices_pending = self._slices_pending, {}
            deletes = {key for key, keep in pending.items() if not keep}
            writes = {key for key, keep in pending.items() if keep}
            if deletes and self._cache_slice_deleter is not None:
                await self._cache_slice_deleter(deletes)
            if writes and self._cache_slice_writer is not None:
                await self._cache_slice_writer(writes)

    async def _rewrite_cache(self) -> None:
        if self._cache_writer is not None:
            await self._cache_writer()
            log.info("cache.written")

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
            # One last listing of the old day for what landed in its final
            # second; the previous-day loop carries on from here.
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
