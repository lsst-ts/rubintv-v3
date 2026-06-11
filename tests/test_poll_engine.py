"""PollEngine cold-start scan ordering and per-camera readiness.

Drives the historical scan phases directly with a fake poller (no S3, no
event loop sleeps), asserting that the recent window is scanned before the
full sweep and that per-camera flags flip in the right order.
"""

from __future__ import annotations

import asyncio

from rubintv.config.models import Camera, Location, Models
from rubintv.data.dayobs import get_current_day_obs
from rubintv.data.events import ObjectEvent, ObjectKind
from rubintv.data.store import EventStore
from rubintv.data.tasks import PollEngine


class FakePoller:
    """Records scanned prefixes; emits one CREATED event per scan so the
    store registers a touched slice."""

    def __init__(self) -> None:
        self.scanned: list[tuple[str, str]] = []

    def scan(self, location: str, prefix: str) -> list[ObjectEvent]:
        self.scanned.append((location, prefix))
        # A conforming channel-event key under the scanned prefix, so the
        # store classifies and applies it. day_obs is taken from the prefix
        # when present, else a fixed historical date.
        date = prefix.split("/")[1] if prefix.count("/") >= 2 else "2026-01-01"
        key = f"{prefix.split('/')[0]}/{date}/c/000001/a.png"
        return [
            ObjectEvent(
                kind=ObjectKind.CREATED, location=location, key=key, etag="e"
            )
        ]


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


def _engine(
    window: int,
    metadata_warmer: object | None = None,
) -> tuple[PollEngine, FakePoller]:
    poller = FakePoller()
    engine = PollEngine(
        _models(),
        EventStore(),
        poller,  # type: ignore[arg-type]  # duck-typed DataSource
        recent_window_days=window,
        metadata_warmer=metadata_warmer,  # type: ignore[arg-type]
    )
    return engine, poller


async def test_recent_scanned_before_full() -> None:
    engine, poller = _engine(window=3)
    await engine._scan_recent_window()
    prefixes = [p for _, p in poller.scanned]
    # Three per-date prefixes under cam/, none the bare cam/ sweep prefix.
    assert len(prefixes) == 3
    assert all(p.startswith("cam/") and p.count("/") == 2 for p in prefixes)
    # Newest-first ordering (descending dates).
    assert prefixes == sorted(prefixes, reverse=True)
    # recent_ready flips, full_complete does not.
    st = engine.camera_status()[("loc", "cam")]
    assert st.recent_ready is True
    assert st.full_complete is False


async def test_full_sweep_marks_both_flags() -> None:
    engine, _ = _engine(window=0)
    await engine._scan_all_history()
    st = engine.camera_status()[("loc", "cam")]
    assert st.recent_ready is True
    assert st.full_complete is True


async def test_window_zero_skips_recent_phase() -> None:
    engine, poller = _engine(window=0)
    # The loop guards on the window; calling the recent scan with an empty
    # window list yields no per-date prefixes.
    await engine._scan_recent_window()
    assert poller.scanned == []
    assert engine.camera_status()[("loc", "cam")].recent_ready is True


async def test_full_sweep_scans_bare_prefix() -> None:
    engine, poller = _engine(window=0)
    await engine._scan_all_history()
    assert ("loc", "cam") in {
        (loc, "cam") for loc, _ in poller.scanned
    }
    assert [p for _, p in poller.scanned] == ["cam/"]


async def test_recent_scan_warms_metadata_per_camera() -> None:
    warmed: list[tuple[str, str]] = []

    async def warm(location: str, camera: str) -> None:
        warmed.append((location, camera))

    engine, _ = _engine(window=3, metadata_warmer=warm)
    await engine._scan_recent_window()
    # Warmed once for the camera, after its recent scan finished.
    assert warmed == [("loc", "cam")]


async def test_full_sweep_warms_only_when_recent_disabled() -> None:
    warmed: list[tuple[str, str]] = []

    async def warm(location: str, camera: str) -> None:
        warmed.append((location, camera))

    # Window 0: the full sweep is the only phase, so it warms.
    engine, _ = _engine(window=0, metadata_warmer=warm)
    await engine._scan_all_history()
    assert warmed == [("loc", "cam")]


async def test_full_sweep_skips_warm_when_recent_enabled() -> None:
    warmed: list[tuple[str, str]] = []

    async def warm(location: str, camera: str) -> None:
        warmed.append((location, camera))

    # Window > 0: the recent phase owns warming; the full sweep must not
    # re-warm the same dates.
    engine, _ = _engine(window=3, metadata_warmer=warm)
    await engine._scan_all_history()
    assert warmed == []


async def test_warm_metadata_error_does_not_break_scan() -> None:
    async def warm(location: str, camera: str) -> None:
        raise RuntimeError("boom")

    engine, poller = _engine(window=3, metadata_warmer=warm)
    # A warming failure is swallowed; the recent scan still completes and
    # flips the readiness flag.
    await engine._scan_recent_window()
    assert engine.camera_status()[("loc", "cam")].recent_ready is True


async def test_scan_date_fills_store_on_demand() -> None:
    poller = FakePoller()
    store = EventStore()
    engine = PollEngine(
        _models(), store, poller, recent_window_days=0  # type: ignore[arg-type]
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
    assert results == [1, 1]
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
        _models(), EventStore(), BoomPoller(), recent_window_days=0  # type: ignore[arg-type]
    )
    # Best-effort: an S3 failure degrades to "no events", never raises into
    # the request handler.
    assert await engine.scan_date("loc", "cam", "2026-01-05") == 0


async def test_trigger_rescan_wakes_long_sleep() -> None:
    engine, _ = _engine(window=1)
    # A long sleep that would normally block; triggering a rescan must wake it
    # near-immediately rather than waiting out the timeout.
    engine.trigger_rescan()
    await asyncio.wait_for(engine._sleep_or_rescan(3600), timeout=1.0)
    assert engine._rescan.is_set()  # caller (the loop) clears it, not the sleep


async def test_sleep_or_rescan_times_out_without_trigger() -> None:
    engine, _ = _engine(window=1)
    # Returns on timeout when neither stop nor rescan fires.
    await asyncio.wait_for(engine._sleep_or_rescan(0.01), timeout=1.0)
    assert not engine._rescan.is_set()
