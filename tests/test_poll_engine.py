"""PollEngine cold-start scan ordering and per-camera readiness.

Drives the historical scan phases directly with a fake poller (no S3, no
event loop sleeps), asserting that the recent window is scanned before the
full sweep and that per-camera flags flip in the right order.
"""

from __future__ import annotations

import asyncio

from rubintv.config.models import Camera, Location, Models
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


def _engine(window: int) -> tuple[PollEngine, FakePoller]:
    poller = FakePoller()
    engine = PollEngine(
        _models(),
        EventStore(),
        poller,  # type: ignore[arg-type]  # duck-typed DataSource
        recent_window_days=window,
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
