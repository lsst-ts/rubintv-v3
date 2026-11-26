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

"""PollEngine cold-start scan ordering and per-camera readiness.

Drives the historical scan phases directly with a fake poller (no S3, no
event loop sleeps), asserting that the recent window is scanned before the
full sweep and that per-camera flags flip in the right order.
"""

from __future__ import annotations

import asyncio
import threading
import time
from datetime import UTC, datetime, timedelta

import pytest
from lsst.ts.rubintv.config.models import Camera, Location, Models
from lsst.ts.rubintv.data import tasks
from lsst.ts.rubintv.data.dayobs import get_current_day_obs, recent_day_obs
from lsst.ts.rubintv.data.events import ObjectEvent, ObjectKind
from lsst.ts.rubintv.data.source import ScanResult
from lsst.ts.rubintv.data.store import EventStore
from lsst.ts.rubintv.data.tasks import PollEngine


class FakePoller:
    """Records scanned prefixes; returns one key per scan so the store
    registers a touched slice. Mirrors the real poller's contract: every scan
    reports the full contents of the prefix, and the engine reconciles the
    store against ``keys``."""

    def __init__(self) -> None:
        self.scanned: list[tuple[str, str]] = []
        # What a listing of a camera's dates reports, and each one asked for.
        self.dates: set[str] = {"2026-01-01"}
        self.listed: list[tuple[str, str]] = []

    def list_dates(self, location: str, camera: str) -> set[str]:
        self.listed.append((location, camera))
        return set(self.dates)

    def scan(self, location: str, prefix: str) -> ScanResult:
        self.scanned.append((location, prefix))
        # A conforming channel-event key under the scanned prefix, so the
        # store classifies and applies it. day_obs is taken from the prefix
        # when present, else a fixed historical date.
        date = prefix.split("/")[1] if prefix.count("/") >= 2 else "2026-01-01"
        key = f"{prefix.split('/')[0]}/{date}/c/000001/a.png"
        events = [
            ObjectEvent(kind=ObjectKind.CREATED, location=location, key=key, etag="e")
        ]
        return ScanResult(events=events, keys={key})


def _models() -> Models:
    return Models(
        locations=[
            Location(
                name="loc",
                title="Loc",
                bucket="b",
                cameras=[Camera(name="cam", title="Cam")],
            )
        ]
    )


# The one location and camera of ``_models``, for the loops and passes that
# are run for one at a time.
LOC = _models().locations[0]
CAM = LOC.cameras[0]


def _two_locations() -> Models:
    return Models(
        locations=[
            Location(name=n, title=n, bucket=n, cameras=[Camera(name="cam", title="C")])
            for n in ("one", "two")
        ]
    )


def _engine(
    window: int,
    metadata_warmer: object | None = None,
    recent_refresh: float = 2 * 60 * 60,
    poller: FakePoller | None = None,
    known_days: int = 0,
    previous_day_refresh: float = 2 * 60,
) -> tuple[PollEngine, FakePoller]:
    poller = poller or FakePoller()
    engine = PollEngine(
        _models(),
        EventStore(),
        poller,  # type: ignore[arg-type]  # duck-typed DataSource
        previous_day_refresh=previous_day_refresh,
        recent_window_days=window,
        recent_refresh=recent_refresh,
        recent_known_days=known_days,
        metadata_warmer=metadata_warmer,  # type: ignore[arg-type]
    )
    return engine, poller


async def _seed_dates(engine: PollEngine, dates: list[str]) -> None:
    # Give the store (and so the camera's calendar) data on these dates.
    await engine._store.apply(
        [
            ObjectEvent(
                kind=ObjectKind.CREATED,
                location="loc",
                key=f"cam/{d}/c/000001/a.png",
                etag="e",
            )
            for d in dates
        ]
    )


async def test_recent_scanned_before_full() -> None:
    engine, poller = _engine(window=4)
    await engine._scan_recent_window(LOC)
    prefixes = [p for _, p in poller.scanned]
    # Per-date prefixes under cam/, newest first, none the bare cam/ sweep
    # prefix. Today's and yesterday's aren't among them: each has a faster
    # loop, and this pass's older listing would reconcile away what that
    # loop had indexed since.
    assert prefixes == [f"cam/{d}/" for d in recent_day_obs(4)[2:]]
    # recent_ready flips, full_complete does not.
    st = engine.camera_status()[("loc", "cam")]
    assert st.recent_ready is True
    assert st.full_complete is False


async def test_full_sweep_marks_both_flags() -> None:
    engine, _ = _engine(window=0)
    await engine._sweep_camera(LOC, CAM)
    st = engine.camera_status()[("loc", "cam")]
    assert st.recent_ready is True
    assert st.full_complete is True


async def test_window_zero_skips_recent_phase() -> None:
    engine, poller = _engine(window=0)
    # The loop guards on the window; calling the recent scan with an empty
    # window list yields no per-date prefixes.
    await engine._scan_recent_window(LOC)
    assert poller.scanned == []
    assert engine.camera_status()[("loc", "cam")].recent_ready is True


async def test_full_sweep_prunes_stale_warm_start_date() -> None:
    # Simulate a warm start: a stale date (e.g. epoch) seeded from the disk
    # cache whose source keys are no longer in the bucket. The full sweep
    # observes only the live date, so the stale one must be pruned and its
    # cache slice evicted (else it reseeds the calendar next start).
    poller = FakePoller()
    store = EventStore()
    await store.apply(
        [ObjectEvent(ObjectKind.CREATED, "loc", "cam/1970-01-01/c/000001/x.png", "e")]
    )
    evicted: list[set[tuple[str, str, str]]] = []

    async def delete_slices(pruned: set[tuple[str, str, str]]) -> None:
        evicted.append(pruned)

    engine = PollEngine(
        _models(),
        store,
        poller,  # type: ignore[arg-type]
        recent_window_days=0,
        cache_slice_deleter=delete_slices,
    )
    assert "1970-01-01" in store.calendar("loc", "cam")
    await engine._sweep_camera(LOC, CAM)
    # The bucket has 2026-01-01 only; the epoch slice is gone from the
    # calendar and its cache file was evicted.
    assert store.calendar("loc", "cam") == ["2026-01-01"]
    assert evicted == [{("loc", "cam", "1970-01-01")}]


async def test_full_sweep_never_prunes_the_current_day() -> None:
    # Race guard: the fast current-day loop may have inserted today's first
    # keys *after* the historical sweep listed the camera's dates, so the
    # listing wouldn't include today. Today must be protected from
    # pruning, or it would be deleted the instant it appeared.
    today = get_current_day_obs()
    poller = FakePoller()
    store = EventStore()
    # Today is present in the store (from the current-day loop) but the fake
    # listing of dates only ever reports its own historical date, never
    # today.
    await store.apply(
        [ObjectEvent(ObjectKind.CREATED, "loc", f"cam/{today}/c/000001/x.png", "e")]
    )
    engine = PollEngine(
        _models(),
        store,
        poller,  # type: ignore[arg-type]
        recent_window_days=0,
    )
    assert today in store.calendar("loc", "cam")
    await engine._sweep_camera(LOC, CAM)
    # Today survived even though the sweep listing didn't observe it.
    assert today in store.calendar("loc", "cam")


async def test_full_sweep_leaves_yesterday_to_the_previous_day_loop() -> None:
    # The previous-day loop may have indexed yesterday's first keys after
    # the sweep listed the camera's dates, so yesterday is protected as
    # today is. Only while that loop is on, though: without it nothing else
    # would prune yesterday between recent passes.
    yesterday = recent_day_obs(2)[1]
    for refresh, kept in ((120.0, True), (0.0, False)):
        engine, _ = _engine(window=0, previous_day_refresh=refresh)
        await _seed_dates(engine, [yesterday])
        await engine._sweep_camera(LOC, CAM)
        assert (yesterday in engine._store.calendar("loc", "cam")) is kept


async def test_full_sweep_that_crosses_rollover_protects_the_old_days(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A sweep that lists the camera's dates before noon UTC and prunes
    # after it asked while the old today and yesterday still had loops
    # adding to them: the days live at either end are protected, and no
    # others.
    clock = [datetime(2026, 3, 10, 11, 59, tzinfo=UTC)]
    monkeypatch.setattr(
        tasks, "recent_day_obs", lambda days: recent_day_obs(days, now=clock[0])
    )

    class CrossesNoon(FakePoller):
        def scan(self, location: str, prefix: str) -> ScanResult:
            result = super().scan(location, prefix)
            clock[0] += timedelta(minutes=2)
            return result

    engine, _ = _engine(window=0, poller=CrossesNoon())
    # Before noon today is 03-09 and yesterday 03-08; after it, 03-10 and
    # 03-09. The fake listing reports none of them, nor 03-07.
    await _seed_dates(engine, ["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"])
    await engine._sweep_camera(LOC, CAM)
    assert engine._store.calendar("loc", "cam") == [
        "2026-03-10",
        "2026-03-09",
        "2026-03-08",
        "2026-01-01",
    ]


async def test_full_sweep_keeps_observed_dates() -> None:
    # A live date the sweep observes must survive pruning (no spurious drop).
    poller = FakePoller()
    store = EventStore()
    engine = PollEngine(
        _models(),
        store,
        poller,  # type: ignore[arg-type]
        recent_window_days=0,
    )
    await engine._sweep_camera(LOC, CAM)
    assert store.calendar("loc", "cam") == ["2026-01-01"]


async def test_full_sweep_lists_a_cameras_dates_one_at_a_time() -> None:
    # Never the bare cam/ prefix, which is every key the camera has at once:
    # one listing names its dates, then each is listed on its own, newest
    # first. Today and yesterday are left to their own loops.
    engine, poller = _engine(window=0)
    today, yesterday = recent_day_obs(2)
    poller.dates = {"2026-01-01", "2025-06-01", "2026-01-02", today, yesterday}
    events, listings = await engine._sweep_camera(LOC, CAM)
    assert poller.listed == [("loc", "cam")]
    assert [p for _, p in poller.scanned] == [
        "cam/2026-01-02/",
        "cam/2026-01-01/",
        "cam/2025-06-01/",
    ]
    # One event from each date's listing; the listing of dates counts too.
    assert (events, listings) == (3, 4)
    assert engine._store.calendar("loc", "cam") == [
        "2026-01-02",
        "2026-01-01",
        "2025-06-01",
    ]


async def test_full_sweep_reconciles_each_date_it_lists() -> None:
    # A date the bucket still has, less a frame the index holds: the date's
    # own listing drops the frame, as the whole-camera one used to.
    engine, _ = _engine(window=0)
    await engine._store.apply(
        [
            ObjectEvent(
                ObjectKind.CREATED, "loc", f"cam/2026-01-01/c/00000{n}/a.png", "e"
            )
            for n in (1, 2)
        ]
    )
    await engine._sweep_camera(LOC, CAM)
    index = engine._store.date_index("loc", "cam", "2026-01-01")
    assert index is not None and index.channels == {"c": {1}}


async def test_full_sweep_keeps_a_date_indexed_while_it_lists_the_dates() -> None:
    # A date that reaches the index after the sweep asked which dates the
    # camera has (one opened on demand, say) isn't in the answer. It isn't
    # among the dates the sweep knew of beforehand either, so it stays.
    class HeldDates(FakePoller):
        def __init__(self) -> None:
            super().__init__()
            self.begun = threading.Event()
            self.release = threading.Event()

        def list_dates(self, location: str, camera: str) -> set[str]:
            self.begun.set()
            self.release.wait()
            return super().list_dates(location, camera)

    poller = HeldDates()
    engine, _ = _engine(window=0, poller=poller)
    await _seed_dates(engine, ["2025-05-01"])
    sweep = asyncio.ensure_future(engine._sweep_camera(LOC, CAM))
    await asyncio.to_thread(poller.begun.wait)
    await _seed_dates(engine, ["2025-06-01"])
    poller.release.set()
    await asyncio.wait_for(sweep, timeout=5.0)
    # The one known beforehand and absent from the bucket is dropped.
    assert engine._store.calendar("loc", "cam") == ["2026-01-01", "2025-06-01"]


async def test_recent_scan_warms_metadata_per_camera() -> None:
    warmed: list[tuple[str, str]] = []

    async def warm(location: str, camera: str) -> None:
        warmed.append((location, camera))

    engine, _ = _engine(window=3, metadata_warmer=warm)
    await engine._scan_recent_window(LOC)
    # Warmed once for the camera, after its recent scan finished.
    assert warmed == [("loc", "cam")]


async def test_full_sweep_warms_only_when_recent_disabled() -> None:
    warmed: list[tuple[str, str]] = []

    async def warm(location: str, camera: str) -> None:
        warmed.append((location, camera))

    # Window 0: the full sweep is the only phase, so it warms.
    engine, _ = _engine(window=0, metadata_warmer=warm)
    await engine._sweep_camera(LOC, CAM)
    assert warmed == [("loc", "cam")]


async def test_full_sweep_skips_warm_when_recent_enabled() -> None:
    warmed: list[tuple[str, str]] = []

    async def warm(location: str, camera: str) -> None:
        warmed.append((location, camera))

    # Window > 0: the recent phase owns warming; the full sweep must not
    # re-warm the same dates.
    engine, _ = _engine(window=3, metadata_warmer=warm)
    await engine._sweep_camera(LOC, CAM)
    assert warmed == []


async def test_warm_metadata_error_does_not_break_scan() -> None:
    async def warm(location: str, camera: str) -> None:
        raise RuntimeError("boom")

    engine, poller = _engine(window=3, metadata_warmer=warm)
    # A warming failure is swallowed; the recent scan still completes and
    # flips the readiness flag.
    await engine._scan_recent_window(LOC)
    assert engine.camera_status()[("loc", "cam")].recent_ready is True


async def test_rollover_publishes_day_change_and_rescans_old_day() -> None:
    engine, poller = _engine(window=0)
    engine._current_day = "2020-01-01"  # force a rollover on the next check
    async with engine._store.bus.subscribe() as stream:
        day = await engine._check_rollover(LOC, "2020-01-01")
        change = await asyncio.wait_for(anext(stream), timeout=2)
    # Cameras are told to reset their live views to the new day...
    assert change.type == "dayChange"
    assert change.date == get_current_day_obs()
    assert day == engine._current_day == get_current_day_obs()
    # ...and the old day is listed once more, for what landed at its end.
    assert ("loc", "cam/2020-01-01/") in poller.scanned


async def test_rollover_noop_when_day_unchanged() -> None:
    engine, poller = _engine(window=0)
    today = get_current_day_obs()
    assert await engine._check_rollover(LOC, today) == today
    assert poller.scanned == []


async def test_rollover_is_announced_once_for_every_location() -> None:
    # Each location's loop notices the new day for itself and lists its own
    # old day once more; the first to notice tells every camera's pages.
    poller = FakePoller()
    engine = PollEngine(_two_locations(), EventStore(), poller)  # type: ignore[arg-type]
    engine._current_day = "2020-01-01"
    published: list[tuple[str, str]] = []
    publish = engine._store.bus.publish

    def record(change: object) -> None:
        published.append((change.type, change.location))  # type: ignore[attr-defined]
        publish(change)  # type: ignore[arg-type]

    engine._store.bus.publish = record  # type: ignore[method-assign]
    for location in engine._models.locations:
        await engine._check_rollover(location, "2020-01-01")
    assert [p for p in published if p[0] == "dayChange"] == [
        ("dayChange", "one"),
        ("dayChange", "two"),
    ]
    assert poller.scanned == [("one", "cam/2020-01-01/"), ("two", "cam/2020-01-01/")]


async def test_scan_date_fills_store_on_demand() -> None:
    poller = FakePoller()
    store = EventStore()
    engine = PollEngine(
        _models(),
        store,
        poller,  # type: ignore[arg-type]
        recent_window_days=0,
    )
    applied = await engine.scan_date("loc", "cam", "2026-01-05")
    assert applied == 1
    assert store.date_index("loc", "cam", "2026-01-05") is not None
    assert [p for _, p in poller.scanned] == ["cam/2026-01-05/"]


async def test_scan_date_dedups_concurrent_requests() -> None:
    engine, poller = _engine(window=0)
    # Two concurrent requests for the same missing date share one scan: the
    # first registers the in-flight task synchronously (no await between the
    # map check and set), so the second awaits it rather than re-listing.
    results = await asyncio.gather(
        engine.scan_date("loc", "cam", "2026-01-05"),
        engine.scan_date("loc", "cam", "2026-01-05"),
    )
    assert list(results) == [1, 1]
    assert len(poller.scanned) == 1
    # The in-flight entry is cleaned up, so a later request scans afresh.
    assert engine._on_demand == {}


async def test_scan_date_skips_current_day() -> None:
    engine, poller = _engine(window=0)
    # Today is owned by the 1s current-day loop; on-demand must not add a
    # redundant listing for it.
    assert await engine.scan_date("loc", "cam", get_current_day_obs()) == 0
    assert poller.scanned == []


async def test_scan_date_error_reports_zero_events() -> None:
    class BoomPoller:
        def scan(self, location: str, prefix: str) -> list[ObjectEvent]:
            raise RuntimeError("boom")

    engine = PollEngine(
        _models(),
        EventStore(),
        BoomPoller(),  # type: ignore[arg-type]
        recent_window_days=0,
    )
    # Best-effort: an S3 failure degrades to "no events", never raises into
    # the request handler.
    assert await engine.scan_date("loc", "cam", "2026-01-05") == 0


async def test_trigger_rescan_wakes_long_sleep() -> None:
    engine, _ = _engine(window=1)
    # A long sleep that would normally block; triggering a rescan must wake it
    # near-immediately rather than waiting out the timeout.
    engine.trigger_rescan()
    poll = engine._polls["loc"]
    await asyncio.wait_for(engine._sleep_or_rescan(poll, 3600), timeout=1.0)
    assert poll.rescan.is_set()  # caller (the loop) clears it, not the sleep


async def test_sleep_or_rescan_times_out_without_trigger() -> None:
    engine, _ = _engine(window=1)
    # Returns on timeout when neither stop nor rescan fires.
    poll = engine._polls["loc"]
    await asyncio.wait_for(engine._sleep_or_rescan(poll, 0.01), timeout=1.0)
    assert not poll.rescan.is_set()


class FlakyPoller(FakePoller):
    """A FakePoller whose current-day scans can be made to raise, simulating
    an S3 connect timeout to the bucket endpoint."""

    def __init__(self) -> None:
        super().__init__()
        self.fail = False

    def scan(self, location: str, prefix: str) -> ScanResult:
        if self.fail:
            raise ConnectionError("connect timeout on endpoint URL")
        return super().scan(location, prefix)


async def _run_one_current_cycle(engine: PollEngine, location: Location = LOC) -> None:
    # Drive exactly one current-day loop iteration. The loop checks _stop at
    # the top of each pass, so we let the first body run, then stop it during
    # the post-cycle sleep (which wakes immediately on _stop).
    engine._interval = 0.01
    task = asyncio.ensure_future(engine._current_day_loop(location))
    await asyncio.sleep(0.05)  # enough for one full body + sleep
    engine._stop.set()
    await asyncio.wait_for(task, timeout=1.0)


async def test_s3_healthy_starts_true_and_survives_good_cycle() -> None:
    engine, _ = _engine(window=1)
    assert engine.s3_healthy is True
    await _run_one_current_cycle(engine)
    assert engine.s3_healthy is True


async def test_s3_healthy_flips_false_on_failed_cycle() -> None:
    poller = FlakyPoller()
    engine = PollEngine(
        _models(),
        EventStore(),
        poller,  # type: ignore[arg-type]
        recent_window_days=1,
    )
    poller.fail = True
    await _run_one_current_cycle(engine)
    assert engine.s3_healthy is False


async def test_s3_healthy_recovers_after_good_cycle() -> None:
    poller = FlakyPoller()
    engine = PollEngine(
        _models(),
        EventStore(),
        poller,  # type: ignore[arg-type]
        recent_window_days=1,
    )
    poller.fail = True
    await _run_one_current_cycle(engine)
    assert engine.s3_healthy is False
    # S3 comes back: the next completed cycle clears the alert.
    poller.fail = False
    engine._stop.clear()
    engine._ready_fired = False
    await _run_one_current_cycle(engine)
    assert engine.s3_healthy is True


class SlowPoller(FakePoller):
    """A FakePoller whose scans take a controllable wall-clock time, to drive
    the slow-cycle detection."""

    def __init__(self, delay: float = 0.0) -> None:
        super().__init__()
        self.delay = delay

    def scan(self, location: str, prefix: str) -> ScanResult:
        if self.delay:
            time.sleep(self.delay)  # blocks the worker thread, like real S3
        return super().scan(location, prefix)


async def test_s3_slow_starts_false_and_stays_on_fast_cycle() -> None:
    engine, _ = _engine(window=1)
    assert engine.s3_slow is False
    assert engine.s3_last_cycle_seconds == 0.0
    await _run_one_current_cycle(engine)
    assert engine.s3_slow is False
    # A successful cycle records its wall-clock duration for the status view.
    assert engine.s3_last_cycle_seconds > 0.0
    assert engine.s3_last_cycle_seconds < tasks.SLOW_CYCLE_SECONDS


async def test_s3_slow_flips_true_when_cycle_exceeds_threshold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Lower the threshold so a small real delay trips it (no 5s test sleep).
    monkeypatch.setattr(tasks, "SLOW_CYCLE_SECONDS", 0.05)
    poller = SlowPoller(delay=0.15)
    engine = PollEngine(
        _models(),
        EventStore(),
        poller,  # type: ignore[arg-type]
        recent_window_days=1,
    )
    await _run_one_current_cycle(engine)
    # The cycle succeeded (reachable) but was slow.
    assert engine.s3_healthy is True
    assert engine.s3_slow is True
    # The recorded latency reflects the slow cycle (past the threshold).
    assert engine.s3_last_cycle_seconds >= tasks.SLOW_CYCLE_SECONDS


async def test_s3_slow_cleared_when_cycle_fails() -> None:
    # A hard failure shows the red 'unreachable' state, not the amber 'slow'
    # one — slow must not linger over an outright failure.
    poller = FlakyPoller()
    engine = PollEngine(
        _models(),
        EventStore(),
        poller,  # type: ignore[arg-type]
        recent_window_days=1,
    )
    engine._polls["loc"].slow = True  # pretend a prior slow cycle set it
    engine._polls["loc"].last_cycle_seconds = 6.0  # ...and recorded its latency
    poller.fail = True
    await _run_one_current_cycle(engine)
    assert engine.s3_healthy is False
    assert engine.s3_slow is False
    # A failed cycle has no meaningful duration, so the last *successful*
    # latency is retained rather than zeroed.
    assert engine.s3_last_cycle_seconds == 6.0


# -- periodic recent-window refresh between full sweeps -----------------------


async def test_pause_reports_a_triggered_rescan() -> None:
    engine, _ = _engine(window=1)
    assert await engine._pause("loc", 0.01) is False
    engine.trigger_rescan()
    # Wakes at once rather than waiting out the sleep, and says why.
    assert await asyncio.wait_for(engine._pause("loc", 60), timeout=1.0) is True
    assert engine.historical_loading is True
    assert not engine._polls["loc"].rescan.is_set()  # consumed


class _StopAfter(FakePoller):
    """A poller that stops the engine after ``n`` scans.

    Lets the refresh-wait tests run for a fixed number of passes rather than
    a wall-clock budget, which a slow CI box (thread-pool spin-up, traceback
    formatting) blows through with a single pass.
    """

    def __init__(self, n: int, fail: bool = False) -> None:
        super().__init__()
        self.n = n
        self.fail = fail
        self.engine: PollEngine | None = None

    def scan(self, location: str, prefix: str) -> ScanResult:
        if len(self.scanned) + 1 >= self.n and self.engine is not None:
            self.engine._stop.set()
        if self.fail:
            self.scanned.append((location, prefix))
            raise RuntimeError("s3 blip")
        return super().scan(location, prefix)


async def _no_wait(location: str, seconds: float) -> bool:
    # Stand-in for PollEngine._pause: tick immediately, no rescan requested.
    return False


async def test_recent_refresh_rescans_the_window_between_full_sweeps() -> None:
    poller = _StopAfter(3)
    engine, _ = _engine(window=3, recent_refresh=1.0, poller=poller)
    poller.engine = engine
    engine._pause = _no_wait  # type: ignore[method-assign]
    await asyncio.wait_for(engine._refresh_recent_until(LOC, 3600), timeout=5.0)
    # Several recent passes ran, each scanning the per-date prefix only —
    # never the bare {camera}/ prefix, which is the full sweep's job. Of the
    # window's three days that is the oldest.
    assert [p for _, p in poller.scanned] == [f"cam/{recent_day_obs(3)[2]}/"] * 3


async def test_recent_pass_lists_yesterday_without_its_own_loop() -> None:
    # With the previous-day refresh off, the recent pass is all that
    # re-checks yesterday. Today still belongs to the current-day loop.
    engine, poller = _engine(window=3, previous_day_refresh=0)
    await engine._scan_recent_window(LOC)
    assert [p for _, p in poller.scanned] == [
        f"cam/{d}/" for d in recent_day_obs(3)[1:]
    ]


async def test_recent_refresh_waits_out_the_period_when_disabled() -> None:
    # recent_refresh=0 (or no window) means recent dates refresh only with
    # the full sweep: the wait is one plain sleep, no scans.
    for window, refresh in ((0, 0.01), (3, 0.0)):
        engine, poller = _engine(window=window, recent_refresh=refresh)
        await asyncio.wait_for(engine._refresh_recent_until(LOC, 0.03), timeout=1.0)
        assert poller.scanned == []


async def test_recent_refresh_returns_early_on_rescan_trigger() -> None:
    engine, poller = _engine(window=3, recent_refresh=60)
    task = asyncio.create_task(engine._refresh_recent_until(LOC, 600))
    await asyncio.sleep(0.01)
    engine.trigger_rescan()
    # Drops the wait so the loop can start the fresh cold sweep at once; the
    # recent pass is not run on the way out.
    await asyncio.wait_for(task, timeout=1.0)
    assert engine.historical_loading is True
    assert poller.scanned == []


async def test_recent_refresh_survives_a_failed_pass() -> None:
    poller = _StopAfter(3, fail=True)
    engine, _ = _engine(window=3, recent_refresh=1.0, poller=poller)
    poller.engine = engine
    engine._pause = _no_wait  # type: ignore[method-assign]
    await asyncio.wait_for(engine._refresh_recent_until(LOC, 3600), timeout=5.0)
    # Each failure is logged and the next tick tries again.
    assert len(poller.scanned) == 3


# -- the previous day's own loop ----------------------------------------------


async def test_previous_day_loop_rescans_yesterday_every_interval() -> None:
    poller = _StopAfter(3)
    engine, _ = _engine(window=0, poller=poller, previous_day_refresh=120.0)
    poller.engine = engine
    slept: list[float] = []

    async def sleep(seconds: float) -> None:
        slept.append(seconds)

    engine._sleep = sleep  # type: ignore[method-assign]
    await asyncio.wait_for(engine._previous_day_loop(LOC), timeout=5.0)
    # One listing of yesterday per pass, a full interval apart.
    assert [p for _, p in poller.scanned] == [f"cam/{recent_day_obs(2)[1]}/"] * 3
    assert slept == [120.0] * 3


async def test_previous_day_loop_survives_a_failed_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logged = _Logged()
    monkeypatch.setattr(tasks, "log", logged)
    poller = _StopAfter(3, fail=True)
    engine, _ = _engine(window=0, poller=poller)
    poller.engine = engine

    async def sleep(seconds: float) -> None:
        return None

    engine._sleep = sleep  # type: ignore[method-assign]
    await asyncio.wait_for(engine._previous_day_loop(LOC), timeout=5.0)
    # Each failure is logged and the next pass tries again.
    assert len(poller.scanned) == 3
    assert logged.events.count("poll.previous.error") == 3


async def test_previous_day_loop_lists_yesterday_at_once() -> None:
    # No wait before the first pass: the recent window leaves yesterday to
    # this loop, so at startup nothing else lists it.
    engine, poller = _engine(window=0)

    async def sleep(seconds: float) -> None:
        engine._stop.set()

    engine._sleep = sleep  # type: ignore[method-assign]
    await asyncio.wait_for(engine._previous_day_loop(LOC), timeout=5.0)
    assert [p for _, p in poller.scanned] == [f"cam/{recent_day_obs(2)[1]}/"]


async def test_previous_day_loop_runs_only_when_its_refresh_is_on() -> None:
    for refresh, running in ((120.0, True), (0.0, False)):
        engine, _ = _engine(window=0, previous_day_refresh=refresh)
        engine.start()
        names = {task.get_name() for task in engine._tasks}
        await engine.stop()
        assert ("poll-previous-loc" in names) is running


# -- known data days outside the window ---------------------------------------


async def test_recent_pass_adds_a_cameras_newest_data_days_outside_window() -> None:
    engine, poller = _engine(window=3, known_days=2)
    # Data on four old dates (well outside a 3-day window) and on all of it.
    await _seed_dates(engine, ["2020-01-01", "2020-03-01", "2020-02-01", "2020-04-01"])
    days = recent_day_obs(3)
    await _seed_dates(engine, days)
    await engine._scan_recent_window(LOC)
    prefixes = [p for _, p in poller.scanned]
    # The window's one day without a faster loop, then the two newest known
    # data days — not the older two, and not today or yesterday, which are
    # in the window though this pass doesn't list them.
    assert prefixes == [f"cam/{days[2]}/", "cam/2020-04-01/", "cam/2020-03-01/"]


async def test_known_days_skip_dates_the_window_already_covers() -> None:
    engine, poller = _engine(window=3, known_days=5, previous_day_refresh=0)
    days = recent_day_obs(3)
    # Data on a window day and on one older day: the window day must not be
    # listed twice.
    await _seed_dates(engine, [days[1], "2020-01-01"])
    await engine._scan_recent_window(LOC)
    prefixes = [p for _, p in poller.scanned]
    assert prefixes == [f"cam/{d}/" for d in days[1:]] + ["cam/2020-01-01/"]


async def test_known_days_disabled_scans_the_window_only() -> None:
    engine, poller = _engine(window=3, known_days=0)
    await _seed_dates(engine, ["2020-01-01"])
    await engine._scan_recent_window(LOC)
    assert [p for _, p in poller.scanned] == [f"cam/{recent_day_obs(3)[2]}/"]


async def test_periodic_recent_pass_does_not_rewarm_metadata() -> None:
    warmed: list[tuple[str, str]] = []

    async def warmer(location: str, camera: str) -> None:
        warmed.append((location, camera))

    engine, _ = _engine(window=1, metadata_warmer=warmer)
    await engine._scan_recent_window(LOC)  # cold start: warms
    assert warmed == [("loc", "cam")]
    await engine._scan_recent_window(LOC, warm=False)  # periodic tick: doesn't
    assert warmed == [("loc", "cam")]


# -- the historical loop, on-demand memo and failure barrier -----------------


class _EmptyPoller(FakePoller):
    """Every prefix lists nothing."""

    def scan(self, location: str, prefix: str) -> ScanResult:
        self.scanned.append((location, prefix))
        return ScanResult(events=[], keys=set())


async def test_historical_loop_retries_a_failed_sweep() -> None:
    # A failed full sweep keeps the loading flag up and retries after a
    # short pause instead of sleeping the 12h cadence with history missing.
    # Later sweeps run with the flag already down.
    class FailFirstSweep(FakePoller):
        def __init__(self) -> None:
            super().__init__()
            self.failed = False

        def list_dates(self, location: str, camera: str) -> set[str]:
            if not self.failed:
                self.failed = True
                self.listed.append((location, camera))
                raise RuntimeError("listing failed")
            return super().list_dates(location, camera)

    poller = FailFirstSweep()
    engine, _ = _engine(window=0, poller=poller)
    pauses: list[tuple[float, bool]] = []
    refreshes = 0

    async def pause(location: str, seconds: float) -> bool:
        pauses.append((seconds, engine.historical_loading))
        return False

    async def refresh(location: Location, seconds: float) -> None:
        nonlocal refreshes
        refreshes += 1
        if refreshes == 2:
            engine._stop.set()

    engine._pause = pause  # type: ignore[method-assign]
    engine._refresh_recent_until = refresh  # type: ignore[method-assign]
    await asyncio.wait_for(engine._historical_loop(LOC), timeout=5.0)
    assert pauses == [(tasks._HISTORICAL_RETRY_SECONDS, True)]
    # The sweep that failed, its retry, and the next round's.
    assert len(poller.listed) == 3
    assert engine.historical_loading is False


def _two_cameras() -> Location:
    return Location(
        name="loc",
        title="Loc",
        bucket="b",
        cameras=[Camera(name=n, title=n) for n in ("first", "second")],
    )


async def test_a_retried_round_carries_on_from_the_camera_that_failed() -> None:
    # A blip part-way through a location's cameras used to start the whole
    # recent-then-full sequence again, listing every camera before it a
    # second time, and a third, each minute it went on.
    class FailsSecondOnce(FakePoller):
        def __init__(self) -> None:
            super().__init__()
            self.failed = False

        def list_dates(self, location: str, camera: str) -> set[str]:
            if camera == "second" and not self.failed:
                self.failed = True
                raise RuntimeError("listing failed")
            return super().list_dates(location, camera)

    location = _two_cameras()
    poller = FailsSecondOnce()
    engine = PollEngine(
        Models(locations=[location]),
        EventStore(),
        poller,  # type: ignore[arg-type]
        recent_window_days=3,
    )

    async def refresh(location: Location, seconds: float) -> None:
        engine._stop.set()

    engine._pause = _no_wait  # type: ignore[method-assign]
    engine._refresh_recent_until = refresh  # type: ignore[method-assign]
    await asyncio.wait_for(engine._historical_loop(location), timeout=5.0)
    # Each camera's recent day once, then each camera's sweep once: the
    # first camera's isn't repeated for the second's retry.
    recent = f"{recent_day_obs(3)[2]}/"
    assert [p for _, p in poller.scanned] == [
        f"first/{recent}",
        f"second/{recent}",
        "first/2026-01-01/",
        "second/2026-01-01/",
    ]
    assert poller.listed == [("loc", "first"), ("loc", "second")]
    status = engine.camera_status()
    assert all(status[("loc", cam)].full_complete for cam in ("first", "second"))


async def test_a_rescan_asked_for_during_a_retry_starts_the_round_again() -> None:
    class FailsSecondOnce(FakePoller):
        def __init__(self) -> None:
            super().__init__()
            self.failed = False

        def list_dates(self, location: str, camera: str) -> set[str]:
            self.listed.append((location, camera))
            if camera == "second" and not self.failed:
                self.failed = True
                raise RuntimeError("listing failed")
            return set(self.dates)

    location = _two_cameras()
    poller = FailsSecondOnce()
    engine = PollEngine(
        Models(locations=[location]),
        EventStore(),
        poller,  # type: ignore[arg-type]
        recent_window_days=0,
    )

    async def rescan(location: str, seconds: float) -> bool:
        return True

    async def refresh(location: Location, seconds: float) -> None:
        engine._stop.set()

    engine._pause = rescan  # type: ignore[method-assign]
    engine._refresh_recent_until = refresh  # type: ignore[method-assign]
    await asyncio.wait_for(engine._historical_loop(location), timeout=5.0)
    assert [cam for _, cam in poller.listed] == ["first", "second", "first", "second"]


async def test_recent_refresh_with_no_time_left_returns_at_once() -> None:
    engine, poller = _engine(window=3, recent_refresh=1.0)
    await asyncio.wait_for(engine._refresh_recent_until(LOC, 0), timeout=1.0)
    assert poller.scanned == []


async def test_scan_date_remembers_a_date_that_listed_empty() -> None:
    # A client hammering a real-looking date with no data must not buy one
    # S3 listing per request; a flush (rescan trigger) forgets the answer.
    poller = _EmptyPoller()
    engine, _ = _engine(window=0, poller=poller)
    assert await engine.scan_date("loc", "cam", "2026-01-05") == 0
    assert await engine.scan_date("loc", "cam", "2026-01-05") == 0
    assert len(poller.scanned) == 1
    engine.trigger_rescan()
    assert await engine.scan_date("loc", "cam", "2026-01-05") == 0
    assert len(poller.scanned) == 2


async def test_empty_date_memo_is_bounded_oldest_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tasks, "_ON_DEMAND_EMPTY_MAX", 2)
    poller = _EmptyPoller()
    engine, _ = _engine(window=0, poller=poller)
    for date in ("2026-01-01", "2026-01-02", "2026-01-03"):
        await engine.scan_date("loc", "cam", date)
    poller.scanned.clear()
    for date in ("2026-01-03", "2026-01-02", "2026-01-01"):
        await engine.scan_date("loc", "cam", date)
    # Only the oldest answer was forgotten.
    assert [p for _, p in poller.scanned] == ["cam/2026-01-01/"]


# -- a location that fails, and the ones that don't ---------------------------


class _OneDown(FakePoller):
    """A poller for which location ``two`` can't be reached, and which says
    when location ``one`` has been listed enough to have got somewhere."""

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        super().__init__()
        self._loop = loop
        self.enough = asyncio.Event()

    def _reach(self, location: str) -> None:
        if location == "two":
            raise ConnectionError("endpoint unreachable")

    def list_dates(self, location: str, camera: str) -> set[str]:
        self._reach(location)
        return super().list_dates(location, camera)

    def scan(self, location: str, prefix: str) -> ScanResult:
        self._reach(location)
        result = super().scan(location, prefix)
        if sum(1 for loc, _ in self.scanned if loc == "one") >= 20:
            self._loop.call_soon_threadsafe(self.enough.set)
        return result


async def test_a_location_that_cant_be_reached_holds_up_no_other(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # One barrier used to gather every location's listings: a location
    # whose endpoint was down failed every cycle and pass for them all, so
    # readiness never fired, no location's full sweep ever ran, and "S3
    # unreachable" showed everywhere. Each location now has loops of its
    # own.
    monkeypatch.setattr(tasks, "log", _Logged())
    ready: list[bool] = []
    poller = _OneDown(asyncio.get_running_loop())
    engine = PollEngine(
        _two_locations(),
        EventStore(),
        poller,  # type: ignore[arg-type]
        poll_interval=0.0,
        recent_window_days=3,
        on_ready=lambda: ready.append(True),
    )
    engine.start()
    await asyncio.wait_for(poller.enough.wait(), timeout=10.0)
    await engine.stop()

    # Ready, though one location never managed a cycle.
    assert ready == [True]
    status = engine.location_status()
    assert status["one"].s3_healthy is True
    assert status["one"].historical_loading is False
    assert status["one"].last_poll_age_seconds is not None
    assert status["two"].s3_healthy is False
    assert status["two"].historical_loading is True
    assert status["two"].last_poll_age_seconds is None
    cameras = engine.camera_status()
    assert cameras[("one", "cam")].full_complete is True
    assert cameras[("two", "cam")].recent_ready is False
    # What a page with no location in view goes by: the worst of each.
    assert engine.s3_healthy is False
    assert engine.historical_loading is True
    assert engine.last_poll_age_seconds() is not None


async def test_ready_waits_for_every_locations_first_cycle() -> None:
    # ...whichever way it ends: a location that can't be reached mustn't
    # keep the app from serving the ones that can.
    ready: list[bool] = []
    poller = FlakyPoller()
    engine = PollEngine(
        _two_locations(),
        EventStore(),
        poller,  # type: ignore[arg-type]
        on_ready=lambda: ready.append(True),
    )
    one, two = engine._models.locations
    await _run_one_current_cycle(engine, one)
    assert ready == []
    poller.fail = True
    engine._stop.clear()
    await _run_one_current_cycle(engine, two)
    assert ready == [True]
    assert engine.location_status()["two"].s3_healthy is False


async def test_an_app_with_no_locations_is_ready_at_once() -> None:
    ready: list[bool] = []
    engine = PollEngine(
        Models(locations=[]),
        EventStore(),
        FakePoller(),  # type: ignore[arg-type]
        on_ready=lambda: ready.append(True),
    )
    engine.start()
    await engine.stop()
    assert ready == [True]


async def test_a_location_that_stays_down_logs_its_traceback_now_and_then(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Its loop retries every interval. A traceback for each attempt was one
    # a second for as long as the endpoint stayed down.
    logged = _Logged()
    monkeypatch.setattr(tasks, "log", logged)
    poller = FlakyPoller()
    poller.fail = True
    engine, _ = _engine(window=0, poller=poller)
    cycles = 0

    async def sleep(seconds: float) -> None:
        nonlocal cycles
        cycles += 1
        if cycles == 3:
            # Long enough since the last traceback for another.
            monkeypatch.setattr(tasks, "_ERROR_LOG_SECONDS", 0.0)
        if cycles == 4:
            poller.fail = False
        if cycles == 5:
            engine._stop.set()

    engine._sleep = sleep  # type: ignore[method-assign]
    await asyncio.wait_for(engine._current_day_loop(LOC), timeout=5.0)
    # Four failed cycles: the first logged, the next two not, the fourth
    # logged again; then one that reached S3, which says it is back.
    assert logged.events.count("poll.current.error") == 2
    (back,) = logged.of("poll.current.recovered")
    assert back["location"] == "loc" and "failed_seconds" in back
    assert engine.s3_healthy is True


async def test_a_loops_unchanged_listing_is_not_logged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The current-day loop re-lists every prefix each second and a recent
    # pass makes hundreds of listings at once: an unchanged one of theirs
    # isn't logged, their own summary lines count them. One made on demand
    # still is, at debug; a change is info whatever made the listing.
    logged: list[tuple[str, str]] = []

    class Recorder:
        def __getattr__(self, level: str) -> object:
            return lambda event, **fields: logged.append((level, fields["scope"]))

    monkeypatch.setattr(tasks, "log", Recorder())
    engine, poller = _engine(window=0)
    prefix = "cam/2026-01-05/"
    result = poller.scan("loc", prefix)
    await engine._apply_scan("day", "loc", prefix, result)  # new: info
    await engine._apply_scan("day", "loc", prefix, result)  # unchanged: nothing
    for scope in ("recent", "historical"):  # unchanged: nothing
        await engine._apply_scan(scope, "loc", prefix, result)
    await engine._apply_scan("on-demand", "loc", prefix, result)  # debug
    assert logged == [("info", "day"), ("debug", "on-demand")]


# -- a cycle that never ends, and the cache volume that could cause one -------


class _Logged:
    """Stands in for the module's logger, keeping each event's name and
    fields."""

    def __init__(self) -> None:
        self.events: list[str] = []
        self.fields: list[dict[str, object]] = []

    def __getattr__(self, level: str) -> object:
        def record(event: str, **fields: object) -> None:
            self.events.append(event)
            self.fields.append(fields)

        return record

    def of(self, event: str) -> list[dict[str, object]]:
        """The fields of each line logged for ``event``."""
        pairs = zip(self.events, self.fields, strict=True)
        return [fields for name, fields in pairs if name == event]


# -- one line for a run of cycles, and for a pass -----------------------------


async def test_heartbeat_sums_the_cycles_since_the_last(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # No line per cycle, at any level: every so many cycles, one line with
    # how many it covers and the spread of their times.
    logged = _Logged()
    monkeypatch.setattr(tasks, "log", logged)
    engine, _ = _engine(window=0)
    engine._interval = 30.0  # a heartbeat every two cycles
    cycles = 0

    async def sleep(seconds: float) -> None:
        nonlocal cycles
        cycles += 1
        if cycles == 4:
            engine._stop.set()

    engine._sleep = sleep  # type: ignore[method-assign]
    await asyncio.wait_for(engine._current_day_loop(LOC), timeout=5.0)
    beats = logged.of("poll.current.heartbeat")
    assert [(b["cycle"], b["cycles"]) for b in beats] == [(2, 2), (4, 2)]
    for beat in beats:
        assert (
            beat["cycle_seconds_min"]  # type: ignore[operator]
            <= beat["cycle_seconds_mean"]
            <= beat["cycle_seconds_max"]
        )
    assert "poll.current.cycle" not in logged.events


async def test_recent_pass_counts_the_listings_it_made() -> None:
    engine, poller = _engine(window=4, known_days=2)
    await _seed_dates(engine, ["2020-01-01", "2020-02-01", "2020-03-01"])
    events, listings = await engine._scan_recent_window(LOC)
    # The window's two days without a faster loop and the two newest known
    # data days, for the one camera.
    assert listings == len(poller.scanned) == 4
    assert events == 4


async def test_recent_refresh_logs_one_line_for_the_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logged = _Logged()
    monkeypatch.setattr(tasks, "log", logged)
    poller = _StopAfter(1)
    engine, _ = _engine(window=3, recent_refresh=1.0, poller=poller)
    poller.engine = engine
    await _seed_dates(engine, [recent_day_obs(3)[2]])
    engine._pause = _no_wait  # type: ignore[method-assign]
    await asyncio.wait_for(engine._refresh_recent_until(LOC, 3600), timeout=5.0)
    # The listing found nothing new, so it has no line of its own: the
    # pass's says how many there were and how long they took.
    assert "poll.scan" not in logged.events
    (line,) = logged.of("poll.recent.refresh")
    assert (line["events"], line["listings"]) == (1, 1)
    assert "pass_seconds" in line


async def test_startup_passes_log_how_long_they_took(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logged = _Logged()
    monkeypatch.setattr(tasks, "log", logged)
    engine, _ = _engine(window=3)

    async def refresh(location: Location, seconds: float) -> None:
        engine._stop.set()

    engine._refresh_recent_until = refresh  # type: ignore[method-assign]
    await asyncio.wait_for(engine._historical_loop(LOC), timeout=5.0)
    (recent,) = logged.of("poll.recent.done")
    assert recent["listings"] == 1 and "pass_seconds" in recent
    (sweep,) = logged.of("poll.historical.done")
    assert "sweep_seconds" in sweep


class _HeldPoller(FakePoller):
    """A FakePoller whose scans wait to be released, like a listing that
    never returns, and say when one has begun."""

    def __init__(self) -> None:
        super().__init__()
        self.begun = threading.Event()
        self.release = threading.Event()

    def scan(self, location: str, prefix: str) -> ScanResult:
        self.begun.set()
        self.release.wait()
        return super().scan(location, prefix)


async def test_a_cycle_that_never_ends_is_reported_stalled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The health flags are written as a cycle ends, so one that never ends
    # leaves them saying "healthy". Its running time is what shows it.
    logged = _Logged()
    monkeypatch.setattr(tasks, "log", logged)
    # Any cycle still running counts as overrun: no real minute to wait out.
    monkeypatch.setattr(tasks, "STALLED_CYCLE_SECONDS", 0.0)
    poller = _HeldPoller()
    ready: list[bool] = []
    engine = PollEngine(
        _models(),
        EventStore(),
        poller,  # type: ignore[arg-type]
        recent_window_days=0,
        on_ready=lambda: ready.append(True),
    )
    assert engine.poll_stalled() is False
    assert engine.last_poll_age_seconds() is None

    loop = asyncio.ensure_future(engine._current_day_loop(LOC))
    await asyncio.to_thread(poller.begun.wait)
    assert engine.poll_stalled() is True
    assert engine.s3_healthy is True and engine.s3_slow is False
    assert engine.last_poll_age_seconds() is None
    # The cycle can't log its own stall; the watchdog does, once.
    engine._check_stall()
    engine._check_stall()
    assert logged.events.count("poll.current.stalled") == 1
    assert engine.location_status()["loc"].poll_stalled is True
    # A first cycle that never ends doesn't hold readiness back either.
    assert ready == [True]

    engine._stop.set()  # so the loop ends with this cycle
    poller.release.set()
    await asyncio.wait_for(loop, timeout=5.0)
    assert engine.poll_stalled() is False
    age = engine.last_poll_age_seconds()
    assert age is not None and age >= 0.0
    assert logged.events.count("poll.current.resumed") == 1


async def test_watchdog_looks_for_a_stall_until_stopped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tasks, "_WATCHDOG_SECONDS", 0.0)
    engine, _ = _engine(window=0)
    checks = 0

    def check() -> None:
        nonlocal checks
        checks += 1
        if checks == 3:
            engine._stop.set()

    engine._check_stall = check  # type: ignore[method-assign]
    await asyncio.wait_for(engine._watchdog_loop(), timeout=5.0)
    assert checks == 3


class _HeldCache:
    """Cache writers that record their calls; the slice writer waits to be
    released, like a write to a volume that has hung."""

    def __init__(self) -> None:
        self.begun = asyncio.Event()
        self.release = asyncio.Event()
        self.written: list[set[tuple[str, str, str]]] = []
        self.deleted: list[set[tuple[str, str, str]]] = []

    async def write(self, touched: set[tuple[str, str, str]]) -> None:
        self.written.append(touched)
        self.begun.set()
        await self.release.wait()

    async def delete(self, pruned: set[tuple[str, str, str]]) -> None:
        self.deleted.append(pruned)


def _cached_engine(cache: _HeldCache) -> PollEngine:
    return PollEngine(
        _models(),
        EventStore(),
        FakePoller(),  # type: ignore[arg-type]
        recent_window_days=0,
        cache_slice_writer=cache.write,
        cache_slice_deleter=cache.delete,
    )


async def test_a_hung_cache_write_holds_up_no_scan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A hung volume used to park the poll on its first write. Now a scan
    # waits only so long, later ones don't wait at all, and one write is
    # outstanding however many scans pass.
    logged = _Logged()
    monkeypatch.setattr(tasks, "log", logged)
    monkeypatch.setattr(tasks, "CACHE_WAIT_SECONDS", 0.01)
    cache = _HeldCache()
    engine = _cached_engine(cache)
    a, b, c = (("loc", "cam", f"2026-01-0{n}") for n in (1, 2, 3))

    assert engine.cache_write_stalled_seconds() is None
    await asyncio.wait_for(engine._persist_slices({a}), timeout=5.0)
    assert logged.events == ["cache.write.stalled"]
    # What the Status page goes by to say the volume isn't responding.
    stalled = engine.cache_write_stalled_seconds()
    assert stalled is not None and stalled > 0.0
    await asyncio.wait_for(engine._persist_slices({b, c}), timeout=5.0)
    # A slice dropped while it waits to be written is deleted instead.
    await asyncio.wait_for(engine._evict_slices("loc", "cam", {b[2]}), timeout=5.0)
    assert cache.written == [{a}] and cache.deleted == []
    assert logged.events == ["cache.write.stalled"]

    # The volume comes back: what queued up goes out, and it says so.
    cache.release.set()
    job = engine._slice_writes._job
    assert job is not None
    await asyncio.wait_for(job, timeout=5.0)
    assert cache.written == [{a}, {c}] and cache.deleted == [{b}]
    assert logged.events == ["cache.write.stalled", "cache.write.resumed"]
    assert engine.cache_write_stalled_seconds() is None
    # ...and the next write is waited on as before.
    await engine._persist_slices({a})
    assert cache.written[-1] == {a}


async def test_scans_that_overlap_share_one_cache_write() -> None:
    # The live poll and the history sweep both persist slices. The second to
    # ask while a write is under way waits for that one, which takes its
    # slices too, and starts no write of its own beside it.
    cache = _HeldCache()
    engine = _cached_engine(cache)
    a, b = (("loc", "cam", f"2026-01-0{n}") for n in (1, 2))
    first = asyncio.ensure_future(engine._persist_slices({a}))
    await asyncio.wait_for(cache.begun.wait(), timeout=5.0)
    second = asyncio.ensure_future(engine._persist_slices({b}))
    await asyncio.sleep(0)  # the second caller reaches its wait
    assert cache.written == [{a}] and not first.done() and not second.done()
    cache.release.set()
    await asyncio.wait_for(asyncio.gather(first, second), timeout=5.0)
    assert cache.written == [{a}, {b}]


async def test_each_locations_cache_is_rewritten_after_its_own_sweep() -> None:
    # A location's rewrite asked for while another's is being written
    # follows it in the same job; none is written twice or left out.
    begun = asyncio.Event()
    release = asyncio.Event()
    written: list[str] = []

    async def rewrite(location: str) -> None:
        written.append(location)
        begun.set()
        await release.wait()

    engine = PollEngine(
        _two_locations(),
        EventStore(),
        FakePoller(),  # type: ignore[arg-type]
        cache_writer=rewrite,
    )
    first = asyncio.ensure_future(engine._rewrite_location("one"))
    await asyncio.wait_for(begun.wait(), timeout=5.0)
    second = asyncio.ensure_future(engine._rewrite_location("two"))
    await asyncio.sleep(0)  # the second caller reaches its wait
    assert written == ["one"] and not second.done()
    release.set()
    await asyncio.wait_for(asyncio.gather(first, second), timeout=5.0)
    assert written == ["one", "two"]


async def test_stop_gives_up_on_a_hung_cache_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(tasks, "CACHE_WAIT_SECONDS", 0.01)
    cache = _HeldCache()
    engine = _cached_engine(cache)
    await engine._persist_slices({("loc", "cam", "2026-01-01")})
    job = engine._slice_writes._job
    assert job is not None and not job.done()
    await asyncio.wait_for(engine.stop(), timeout=5.0)
    await asyncio.gather(job, return_exceptions=True)
    assert job.cancelled()


async def test_a_failed_cache_write_fails_no_scan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # It used to fail the poll cycle that made it, which read as "S3
    # unreachable"; after a full sweep, it had the whole sweep run again.
    logged = _Logged()
    monkeypatch.setattr(tasks, "log", logged)
    rewrites: list[str] = []

    async def write(touched: set[tuple[str, str, str]]) -> None:
        raise RuntimeError("dictionary changed size during iteration")

    async def rewrite(location: str) -> None:
        rewrites.append(location)

    engine = PollEngine(
        _models(),
        EventStore(),
        FakePoller(),  # type: ignore[arg-type]
        recent_window_days=0,
        cache_writer=rewrite,
        cache_slice_writer=write,
    )

    async def refresh(location: Location, seconds: float) -> None:
        engine._stop.set()

    engine._refresh_recent_until = refresh  # type: ignore[method-assign]
    await asyncio.wait_for(engine._historical_loop(LOC), timeout=5.0)
    assert "cache.write.error" in logged.events
    assert "poll.historical.error" not in logged.events
    # The sweep went on to rewrite its location's cache, and finished.
    assert rewrites == ["loc"] and "cache.written" in logged.events
    assert engine.historical_loading is False
