"""EventStore: insert, update, remove-with-prune, and change publishing."""

from __future__ import annotations

import pytest

from rubintv.data.bus import EventBus
from rubintv.data.events import ObjectEvent, ObjectKind, StoreChange
from rubintv.data.store import EventStore


def created(key: str, etag: str = "e1", location: str = "local") -> ObjectEvent:
    return ObjectEvent(ObjectKind.CREATED, location, key, etag=etag)


def removed(key: str, location: str = "local") -> ObjectEvent:
    return ObjectEvent(ObjectKind.REMOVED, location, key)


async def test_insert_builds_structured_index() -> None:
    store = EventStore()
    await store.apply(
        [
            created("lsstcam/2026-04-10/witness_detector/000001/a.png"),
            created("lsstcam/2026-04-10/witness_detector/000002/b.png"),
        ]
    )
    idx = store.date_index("local", "lsstcam", "2026-04-10")
    assert idx is not None
    assert idx.channels["witness_detector"] == {1, 2}
    assert store.calendar("local", "lsstcam") == ["2026-04-10"]


async def test_extension_default_and_exception() -> None:
    store = EventStore()
    await store.apply(
        [
            created("lsstcam/2026-04-10/c/000001/a.png"),
            created("lsstcam/2026-04-10/c/000002/b.jpg"),
        ]
    )
    ext = store.date_index("local", "lsstcam", "2026-04-10").extensions["c"]  # type: ignore[union-attr]
    assert ext.default == "png"
    assert ext.for_seq(2) == "jpg"


async def test_per_day_artifact_indexed_separately() -> None:
    store = EventStore()
    await store.apply([created("auxtel/2026-04-10/movies/final/m.mp4")])
    idx = store.date_index("local", "auxtel", "2026-04-10")
    assert idx is not None
    assert idx.per_day["movies"].endswith("m.mp4")
    assert "movies" not in idx.channels


async def test_remove_prunes_empty_date_from_calendar() -> None:
    store = EventStore()
    key = "lsstcam/2026-04-10/c/000001/a.png"
    await store.apply([created(key)])
    assert store.calendar("local", "lsstcam") == ["2026-04-10"]
    await store.apply([removed(key)])
    assert store.calendar("local", "lsstcam") == []
    assert store.date_index("local", "lsstcam", "2026-04-10") is None


async def test_night_report_presence() -> None:
    store = EventStore()
    await store.apply([created("lsstcam/2026-04-10/night_report/summary_md.json")])
    assert store.has_night_report("local", "lsstcam", "2026-04-10")


@pytest.mark.asyncio
async def test_apply_publishes_coalesced_changes() -> None:
    bus = EventBus()
    store = EventStore(bus)
    received: list[StoreChange] = []

    async with bus.subscribe() as stream:
        await store.apply(
            [
                created("lsstcam/2026-04-10/c/000001/a.png"),
                created("lsstcam/2026-04-10/c/000002/b.png"),
            ]
        )
        # Two events, same (loc, cam, date, type) -> one coalesced change.
        change = await stream.__anext__()
        received.append(change)

    assert received[0].type == "channelData"
    assert received[0].camera == "lsstcam"
    assert received[0].date == "2026-04-10"
