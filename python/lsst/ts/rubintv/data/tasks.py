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
  sweep repeats every 12h: recent dates are mutable, old ones rarely are.
  The full sweep goes a date at a time, so what it holds and how long it
  keeps the event loop are a camera-day's worth whatever the bucket's size
- on-demand scan: one camera-date, for a request that hits an unindexed date

Each location has its own three loops. A location whose endpoint is down,
slow or hung fails, slows or stalls its own cycles and passes and no other
location's: the rest keep their cadence, load their history and report
themselves healthy, and the app is ready once every location's first
current-day cycle has ended, whichever way.

A day is reconciled by one loop. Reconciling drops whatever a listing
didn't see, so a slower loop's older listing of a day would drop what a
faster loop had indexed since: the historical scanner leaves today to the
current-day poller and yesterday to the previous-day poller.

Day rollover (UTC-12) is detected by the current-day loops and published
as a ``dayChange``, once, by the first to notice, so clients reset their
live views.

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
  past that buys nothing. Every location is polled at once regardless,
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
from dataclasses import dataclass, field

from lsst.ts.rubintv.config.models import Camera, Location, Models
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

# How often a location whose current-day cycles keep failing logs the
# traceback again. It retries every interval, and a line for each attempt
# would be one a second for as long as its endpoint stayed down.
_ERROR_LOG_SECONDS = 60.0

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
    ``full_complete`` flips once every date the camera has has been
    scanned at least once.
    """

    recent_ready: bool = False
    full_complete: bool = False


@dataclass(slots=True)
class LocationPoll:
    """One location's polling, as its own loops last left it.

    Every location is polled by loops of its own, so one whose endpoint is
    down, slow or hung shows here and holds up no other.
    """

    healthy: bool = True
    """Whether the last current-day cycle reached S3. Optimistic until the
    first one ends, so the frontend's 'S3 unreachable' alert waits for a
    cycle that throws (e.g. a botocore ConnectTimeout to the endpoint)."""
    slow: bool = False
    """Whether the last successful cycle was unusually slow: a degrading
    link shows as an amber 'S3 slow' ahead of the red 'unreachable'."""
    last_cycle_seconds: float = 0.0
    """Wall-clock seconds of the last successful cycle, so the status view
    can show the latency and not just slow or not. 0.0 until one completes;
    unchanged by a failed cycle."""
    cycle_started: float | None = None
    """When the cycle now running began; ``None`` between cycles. The flags
    above are only written as a cycle ends, so a cycle that never ends
    leaves them saying what the last one found; this and ``last_poll`` are
    what show it (both monotonic)."""
    last_poll: float | None = None
    """When a cycle last succeeded; ``None`` until one has."""
    stall_logged: bool = False
    polled: bool = False
    """Whether a first cycle has ended, or stalled: readiness waits for
    every location's."""
    failing_since: float | None = None
    """When the run of failed cycles now going on began."""
    error_logged: float | None = None
    """When that run's traceback was last logged."""
    historical_loading: bool = True
    """True until the location's first full historical scan completes, and
    again from a rescan until that one does."""
    rescan: asyncio.Event = field(default_factory=asyncio.Event)
    """Set to interrupt the historical loop's 12h sleep and start a fresh
    sweep at once (the admin 'flush historical cache' action)."""


@dataclass(frozen=True, slots=True)
class LocationPollStatus:
    """What the status endpoint reports of one location's polling."""

    s3_healthy: bool
    s3_slow: bool
    s3_last_cycle_seconds: float
    poll_stalled: bool
    last_poll_age_seconds: float | None
    historical_loading: bool


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
        cache_writer: Callable[[str], Awaitable[None]] | None = None,
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
        # The observing day last announced to clients; each location's loop
        # keeps the day it is listing.
        self._current_day = get_current_day_obs()
        self._tasks: list[asyncio.Task[None]] = []
        self._stop = asyncio.Event()
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
        # Per-camera cold-start progress. Each camera is mutated only from
        # its location's historical loop, read by the status endpoint —
        # coarse booleans, so no lock is needed on the event loop.
        self._camera_status: dict[LocCam, CameraScanState] = {
            (loc.name, cam.name): CameraScanState()
            for loc in models.locations
            for cam in loc.cameras
        }
        # Each location's polling, written only by that location's loops.
        self._polls: dict[str, LocationPoll] = {
            loc.name: LocationPoll() for loc in models.locations
        }
        # Cache slices waiting to be written (True) or deleted (False), the
        # locations waiting for their whole cache to be rewritten, and the
        # two kinds of cache write. They are waited on separately, so a
        # scan's few slices don't queue behind a location's rewrite.
        self._slices_pending: dict[tuple[str, str, str], bool] = {}
        self._rewrites_pending: set[str] = set()
        self._slice_writes = _CacheWrites("slices", self._write_pending_slices)
        self._cache_rewrite = _CacheWrites("rewrite", self._rewrite_cache)

    # -- what the status endpoint reads ----------------------------------
    #
    # ``location_status`` is each location's own; the rest sum them for a
    # page with no location in view: the worst of each.

    def location_status(self) -> dict[str, LocationPollStatus]:
        """Snapshot of each location's polling."""
        return {
            name: LocationPollStatus(
                s3_healthy=poll.healthy,
                s3_slow=poll.slow,
                s3_last_cycle_seconds=poll.last_cycle_seconds,
                poll_stalled=self._stalled(poll),
                last_poll_age_seconds=self._last_poll_age(poll),
                historical_loading=poll.historical_loading,
            )
            for name, poll in self._polls.items()
        }

    @property
    def historical_loading(self) -> bool:
        """True until every location's first full historical scan completes.
        The frontend shows a non-blocking 'historical still loading'
        affordance while set."""
        return any(poll.historical_loading for poll in self._polls.values())

    @property
    def s3_healthy(self) -> bool:
        """Whether every location's last current-day cycle reached S3."""
        return all(poll.healthy for poll in self._polls.values())

    @property
    def s3_slow(self) -> bool:
        """Whether any location's last successful cycle was unusually slow."""
        return any(poll.slow for poll in self._polls.values())

    @property
    def s3_last_cycle_seconds(self) -> float:
        """The longest of the locations' last successful cycles."""
        return max(
            (poll.last_cycle_seconds for poll in self._polls.values()), default=0.0
        )

    def poll_stalled(self) -> bool:
        """Whether any location's current-day cycle now running has overrun
        ``STALLED_CYCLE_SECONDS``: its live poll has stopped, whatever
        ``s3_healthy`` still says of the cycle before it."""
        return any(self._stalled(poll) for poll in self._polls.values())

    def last_poll_age_seconds(self) -> float | None:
        """Seconds since the location furthest behind last finished a
        current-day cycle: how far behind the bucket today's index may be.
        ``None`` until one has."""
        ages = [
            age
            for poll in self._polls.values()
            if (age := self._last_poll_age(poll)) is not None
        ]
        return max(ages) if ages else None

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

    def camera_status(self) -> dict[LocCam, CameraScanState]:
        """Snapshot of per-camera cold-start scan progress."""
        return dict(self._camera_status)

    @staticmethod
    def _stalled(poll: LocationPoll) -> bool:
        return PollEngine._cycle_running_seconds(poll) > STALLED_CYCLE_SECONDS

    @staticmethod
    def _cycle_running_seconds(poll: LocationPoll) -> float:
        started = poll.cycle_started
        return 0.0 if started is None else time.monotonic() - started

    @staticmethod
    def _last_poll_age(poll: LocationPoll) -> float | None:
        return None if poll.last_poll is None else time.monotonic() - poll.last_poll

    def start(self) -> None:
        """Launch the background loops: a set for each location."""
        self._tasks = [
            asyncio.create_task(self._watchdog_loop(), name="poll-watchdog"),
        ]
        for location in self._models.locations:
            loops = [
                ("current", self._current_day_loop(location)),
                ("historical", self._historical_loop(location)),
            ]
            if self._previous_day_refresh > 0:
                loops.append(("previous", self._previous_day_loop(location)))
            self._tasks.extend(
                asyncio.create_task(loop, name=f"poll-{what}-{location.name}")
                for what, loop in loops
            )
        # With no location to wait for, there is nothing to be ready after.
        self._fire_ready()

    async def stop(self) -> None:
        """Signal loops to stop and await them."""
        self._stop.set()
        self._slice_writes.cancel()
        self._cache_rewrite.cancel()
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    # -- loops -----------------------------------------------------------

    async def _current_day_loop(self, location: Location) -> None:
        poll = self._polls[location.name]
        day = self._current_day
        cycle = 0
        # Cycle times since the last heartbeat, which sums them.
        timed: list[float] = []
        log.info(
            "poll.current.start",
            location=location.name,
            day=day,
            interval_seconds=self._interval,
            prefixes=[f"{cam.name}/{day}/" for cam in location.cameras],
        )
        while not self._stop.is_set():
            started = poll.cycle_started = time.monotonic()
            try:
                day = await self._check_rollover(location, day)
                total = await self._scan_day(location, day)
                poll.last_poll = time.monotonic()
                elapsed = poll.last_poll - started
                cycle += 1
                timed.append(elapsed)
                # Heartbeat at info level every minute or so so operators can
                # see polling is alive even when nothing is changing. It
                # carries the spread of the cycles since the last one: a line
                # for each, one a second, was most of a debug log.
                if cycle % max(1, int(60 / max(self._interval, 0.1))) == 0:
                    log.info(
                        "poll.current.heartbeat",
                        location=location.name,
                        day=day,
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
                if slow and not poll.slow:
                    log.warning(
                        "poll.current.slow",
                        location=location.name,
                        cycle_seconds=round(elapsed, 2),
                        threshold_seconds=SLOW_CYCLE_SECONDS,
                    )
                poll.slow = slow
                poll.last_cycle_seconds = elapsed
                self._cycle_succeeded(location.name, poll)
            except Exception:  # noqa: BLE001 - a bad cycle must not kill loop
                self._cycle_failed(location.name, poll)
            if poll.stall_logged:
                poll.stall_logged = False
                log.info(
                    "poll.current.resumed",
                    location=location.name,
                    cycle_seconds=round(time.monotonic() - started, 1),
                )
            poll.cycle_started = None
            self._cycle_ended(poll)
            await self._sleep(self._interval)

    def _cycle_failed(self, location: str, poll: LocationPoll) -> None:
        """Note a current-day cycle that threw. Called as it is handled.

        A thrown cycle means S3 was unreachable (e.g. a connect timeout to
        the bucket endpoint). The location is marked so the frontend can
        alert, and its loop keeps retrying every interval. The traceback is
        logged as the failure begins and then every ``_ERROR_LOG_SECONDS``:
        a location that stays down (revoked keys, an endpoint gone) would
        otherwise log one a second for as long as it did.
        """
        now = time.monotonic()
        if poll.failing_since is None:
            poll.failing_since = now
        poll.healthy = False
        poll.slow = False
        if poll.error_logged is None or now - poll.error_logged >= _ERROR_LOG_SECONDS:
            poll.error_logged = now
            log.exception(
                "poll.current.error",
                location=location,
                failing_seconds=round(now - poll.failing_since, 1),
            )

    def _cycle_succeeded(self, location: str, poll: LocationPoll) -> None:
        if poll.failing_since is not None:
            log.info(
                "poll.current.recovered",
                location=location,
                failed_seconds=round(time.monotonic() - poll.failing_since, 1),
            )
        poll.failing_since = poll.error_logged = None
        poll.healthy = True

    def _cycle_ended(self, poll: LocationPoll) -> None:
        """Note that a location's current-day cycle has ended, or stalled,
        and flip readiness once every location's first has.

        A cycle that failed counts: the app is ready to serve what the other
        locations have, and the one that can't be reached says so on its
        own pages. Waiting for it would hold readiness back for as long as
        its endpoint stayed down.
        """
        poll.polled = True
        self._fire_ready()

    def _fire_ready(self) -> None:
        if self._ready_fired or not all(p.polled for p in self._polls.values()):
            return
        self._ready_fired = True
        if self._on_ready is not None:
            self._on_ready()
        log.info("poll.ready")

    async def _check_rollover(self, location: Location, day: str) -> str:
        """The day this location should list now. When that has moved on
        from ``day``, the change is announced and the old day listed once
        more first."""
        now_day = get_current_day_obs()
        if now_day == day:
            return day
        self._announce_day(now_day)
        # One last listing of the old day for what landed in its final
        # second; the previous-day loop carries on from here.
        await self._scan_day(location, day)
        return now_day

    def _announce_day(self, day: str) -> None:
        """Tell clients the observing day has changed, once: the first
        location to notice announces it for them all, so no camera's pages
        wait on a location whose own cycle is stuck."""
        if day == self._current_day:
            return
        log.info("day.rollover", from_=self._current_day, to=day)
        self._current_day = day
        # Notify each camera so live views reset to the new day.
        for location in self._models.locations:
            for camera in location.cameras:
                self._store.bus.publish(
                    StoreChange("dayChange", location.name, camera.name, day)
                )

    async def _previous_day_loop(self, location: Location) -> None:
        # Its own task, not a step of either other loop: the historical loop
        # refreshes nothing while a full sweep runs, and a cycle of the
        # current-day loop shouldn't wait on yesterday's listings. The first
        # pass runs at once: the recent window leaves yesterday to this.
        while not self._stop.is_set():
            day = recent_day_obs(2)[1]
            started = time.monotonic()
            try:
                total = await self._scan_day(location, day)
                log.debug(
                    "poll.previous.refresh",
                    location=location.name,
                    day=day,
                    keys=total,
                    cycle_seconds=round(time.monotonic() - started, 3),
                )
            except Exception:  # noqa: BLE001 - a bad pass must not kill loop
                log.exception("poll.previous.error", location=location.name, day=day)
            await self._sleep(self._previous_day_refresh)

    async def _watchdog_loop(self) -> None:
        while not self._stop.is_set():
            await self._sleep(_WATCHDOG_SECONDS)
            self._check_stall()

    def _check_stall(self) -> None:
        """Log each current-day cycle that has stalled, once per stall."""
        for name, poll in self._polls.items():
            if poll.stall_logged or not self._stalled(poll):
                continue
            poll.stall_logged = True
            age = self._last_poll_age(poll)
            log.error(
                "poll.current.stalled",
                location=name,
                day=self._current_day,
                running_seconds=round(self._cycle_running_seconds(poll), 1),
                threshold_seconds=STALLED_CYCLE_SECONDS,
                last_poll_age_seconds=None if age is None else round(age, 1),
            )
            # A first cycle that never ends mustn't hold readiness back
            # either.
            self._cycle_ended(poll)

    async def _historical_loop(self, location: Location) -> None:
        # Recent-window-first, then a full sweep. The recent phase makes the
        # last N days viewable in seconds while the full back-catalogue
        # continues to load in the background. Between full sweeps the recent
        # window is re-scanned on its own, shorter cadence.
        poll = self._polls[location.name]
        # The cameras this round still owes each phase. One leaves its list
        # as it finishes, so the retry after a failure carries on from the
        # camera that failed and doesn't list the ones before it again.
        recent: list[Camera] = []
        sweep: list[Camera] = []
        fresh = True
        while not self._stop.is_set():
            if fresh:
                recent = list(location.cameras) if self._recent_window_days > 0 else []
                sweep = list(location.cameras)
            try:
                await self._recent_phase(location, recent)
                await self._sweep_phase(location, sweep)
                await self._rewrite_location(location.name)
            except Exception:  # noqa: BLE001
                # A failed sweep leaves history incomplete: keep the loading
                # flag honest (still True on a cold start, so the frontend
                # keeps showing its affordance) and retry on a short backoff
                # rather than sleeping the full refresh cadence with a gap.
                # A rescan asked for meanwhile starts the round afresh.
                log.exception("poll.historical.error", location=location.name)
                fresh = await self._pause(location.name, _HISTORICAL_RETRY_SECONDS)
                continue
            if poll.historical_loading:
                poll.historical_loading = False
                log.info("poll.historical.idle", location=location.name)
            # Until the next full sweep, an explicit rescan trigger, or
            # shutdown: keep the recent window fresh. A triggered rescan
            # loops at once.
            await self._refresh_recent_until(location, _HISTORICAL_REFRESH_SECONDS)
            fresh = True

    async def _recent_phase(self, location: Location, pending: list[Camera]) -> None:
        """List the recent dates of each camera in ``pending``, which a
        camera leaves as it finishes."""
        if not pending:
            return
        log.info(
            "poll.recent.start",
            location=location.name,
            cameras=len(pending),
            days=self._recent_window_days,
        )
        started = time.monotonic()
        events = listings = 0
        while pending:
            found, made = await self._scan_recent(location, pending[0], warm=True)
            events += found
            listings += made
            del pending[0]
        log.info(
            "poll.recent.done",
            location=location.name,
            events=events,
            listings=listings,
            pass_seconds=round(time.monotonic() - started, 1),
        )

    async def _sweep_phase(self, location: Location, pending: list[Camera]) -> None:
        """List everything each camera in ``pending`` has, which a camera
        leaves as it finishes."""
        log.info("poll.historical.start", location=location.name, cameras=len(pending))
        started = time.monotonic()
        events = listings = 0
        while pending:
            found, made = await self._sweep_camera(location, pending[0])
            events += found
            listings += made
            del pending[0]
        log.info(
            "poll.historical.done",
            location=location.name,
            events=events,
            listings=listings,
            sweep_seconds=round(time.monotonic() - started, 1),
        )

    async def _refresh_recent_until(self, location: Location, seconds: float) -> None:
        """Wait ``seconds``, re-scanning the location's recent window every
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
            if await self._pause(location.name, step) or self._stop.is_set():
                return
            if time.monotonic() >= deadline:
                return
            started = time.monotonic()
            try:
                events, listings = await self._scan_recent_window(location, warm=False)
                log.info(
                    "poll.recent.refresh",
                    location=location.name,
                    events=events,
                    listings=listings,
                    pass_seconds=round(time.monotonic() - started, 1),
                )
            except Exception:  # noqa: BLE001 - a bad pass must not kill loop
                log.exception("poll.recent.error", location=location.name)

    async def _pause(self, location: str, seconds: float) -> bool:
        """Historical-loop sleep that also honours a triggered rescan.

        Returns True if a rescan was requested, so the caller can drop
        whatever it was waiting on and let the loop start a fresh sweep.
        """
        poll = self._polls[location]
        await self._sleep_or_rescan(poll, seconds)
        if poll.rescan.is_set():
            poll.rescan.clear()
            poll.historical_loading = True
            log.info("poll.historical.rescan", location=location)
            return True
        return False

    # -- scanning --------------------------------------------------------

    async def _scan_day(self, location: Location, day: str) -> int:
        # Cameras are listed one after another: they share the location's
        # one boto3 client, and its endpoint gains nothing past a few
        # requests at once. Locations don't wait on each other at all; each
        # has loops of its own.
        total = 0
        for camera in location.cameras:
            total += await self._list_date("day", location.name, camera.name, day)
        return total

    async def _list_date(
        self, scope: str, location: str, camera: str, date: str
    ) -> int:
        """List one camera-date, apply it, and reconcile the date against
        it. Returns the events found.

        The listing is authoritative for exactly that date, so an empty one
        legitimately means everything for the date was deleted and is still
        applied.
        """
        prefix = f"{camera}/{date}/"
        result = await asyncio.to_thread(self._poller.scan, location, prefix)
        await self._apply_scan(scope, location, prefix, result)
        await self._reconcile_day(location, camera, date, result)
        return len(result.events)

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

    async def _scan_recent_window(
        self, location: Location, *, warm: bool = True
    ) -> tuple[int, int]:
        """Scan the recent dates of every camera at a location. Returns the
        events found and the listings made."""
        events = listings = 0
        for camera in location.cameras:
            found, made = await self._scan_recent(location, camera, warm=warm)
            events += found
            listings += made
        return events, listings

    async def _scan_recent(
        self, location: Location, camera: Camera, *, warm: bool
    ) -> tuple[int, int]:
        """Scan a camera's recent dates: the window, plus known data days.

        Returns the events found and the listings made.

        The window is the last N observing days whether or not they hold
        data, so new data landing on a quiet recent day is still found. On
        top of that the camera gets its ``recent_known_days`` most recent
        dates *with* data outside the window, from its calendar — a camera
        that observes rarely would otherwise list thirty empty days and never
        re-check the days that matter until the full sweep.

        Today is not listed: the current-day loop has a newer listing of it
        every second, and reconciling it from this one would drop frames
        that loop had just indexed. Nor is yesterday while the previous-day
        loop is on, for the same reason.

        ``warm`` pre-fetches recent metadata afterwards; only the cold start
        wants that — the periodic pass would otherwise re-download today's
        file per camera every tick.
        """
        loc, cam = location.name, camera.name
        days = recent_day_obs(self._recent_window_days)
        live = self._live_days()
        listed = [d for d in days if d not in live] + self._known_days(loc, cam, days)
        events = 0
        for day in listed:
            events += await self._list_date("recent", loc, cam, day)
        self._mark(loc, cam, "recent_ready")
        if warm:
            await self._warm_metadata(loc, cam)
        return events, len(listed)

    def _known_days(self, location: str, camera: str, window: list[str]) -> list[str]:
        """A camera's most recent data days that the window doesn't cover."""
        if self._recent_known_days <= 0:
            return []
        inside = set(window)
        calendar = self._store.calendar(location, camera)  # newest first
        return [d for d in calendar if d not in inside][: self._recent_known_days]

    async def _sweep_camera(
        self, location: Location, camera: Camera
    ) -> tuple[int, int]:
        """List everything a camera has, a date at a time, newest first.

        Returns the events found and the listings made.

        One listing names the camera's dates; each is then listed and
        reconciled on its own, and a date the index holds that the bucket no
        longer has is dropped (e.g. a warm-start slice whose keys were
        deleted while the app was down). Listing the whole ``{camera}/``
        prefix at once held every key the camera has, three times over, and
        then indexed them in one pass that stopped the event loop for
        seconds: a cost that grew with the bucket. A date at a time, the
        most held is one camera-day and the loop turns between dates.

        The days a faster loop lists are left to it, here as in the recent
        pass. Those days and the index's dates are taken before the listing
        of dates, so a date that turns up while the sweep runs (tomorrow, at
        rollover, or one opened on demand) isn't mistaken for one that has
        gone.
        """
        loc, cam = location.name, camera.name
        live = self._live_days()
        known = set(self._store.calendar(loc, cam))
        dates = await asyncio.to_thread(self._poller.list_dates, loc, cam)
        listed = sorted(dates - live, reverse=True)
        events = 0
        for date in listed:
            events += await self._list_date("historical", loc, cam, date)
        gone = known - dates - live - self._live_days()
        if gone:
            outcome = await self._store.reconcile(
                (loc, cam), set(), ScanScope(dates=frozenset(gone))
            )
            await self._evict_slices(loc, cam, outcome.dropped)
        # Recent may not have run (window=0); the full sweep also makes
        # recent data present, so mark both as it finishes each camera.
        self._mark(loc, cam, "recent_ready")
        self._mark(loc, cam, "full_complete")
        # Only warm here when the recent phase is disabled; otherwise the
        # recent scan already warmed these dates and re-warming is
        # redundant.
        if self._recent_window_days <= 0:
            await self._warm_metadata(loc, cam)
        return events, len(listed) + 1

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

    async def _rewrite_location(self, location: str) -> None:
        """Rewrite a location's whole cache, now its sweep has finished."""
        if self._cache_writer is None:
            return
        self._rewrites_pending.add(location)
        await self._cache_rewrite.flush(CACHE_REWRITE_WAIT_SECONDS)

    async def _rewrite_cache(self) -> None:
        # Until none is left, so a location whose sweep finished while
        # another's cache was being written follows it.
        while self._rewrites_pending and self._cache_writer is not None:
            location = self._rewrites_pending.pop()
            await self._cache_writer(location)
            log.info("cache.written", location=location)

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

    async def _sleep(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=seconds)
        except TimeoutError:
            pass

    async def _sleep_or_rescan(self, poll: LocationPoll, seconds: float) -> None:
        """Like ``_sleep`` but also wakes on the location's rescan trigger."""

        async def _wait_either() -> None:
            stop = asyncio.ensure_future(self._stop.wait())
            rescan = asyncio.ensure_future(poll.rescan.wait())
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
        """Request an immediate historical rescan of every location.

        Wakes each historical loop out of its long sleep; it then re-runs
        the recent-window and full-history sweeps. Used after the admin
        flushes the cache, so the emptied store cold-rebuilds from S3 right
        away.
        """
        # Drop the negative memo: a flush means the world may have changed, so
        # a date previously seen empty must be re-scannable on demand again.
        self._on_demand_empty.clear()
        for poll in self._polls.values():
            poll.rescan.set()
