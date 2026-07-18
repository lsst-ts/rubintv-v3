"""EventStore: insert, update, remove-with-prune, and change publishing."""

from __future__ import annotations

import pytest
from lsst.ts.rubintv.data.bus import EventBus
from lsst.ts.rubintv.data.events import ObjectEvent, ObjectKind, StoreChange
from lsst.ts.rubintv.data.store import EventStore


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


async def test_latest_date_returns_newest_day_or_none() -> None:
    store = EventStore()
    # No data yet.
    assert store.latest_date("local", "lsstcam") is None
    await store.apply(
        [
            created("lsstcam/2026-04-09/witness_detector/000001/a.png"),
            created("lsstcam/2026-04-10/witness_detector/000002/b.png"),
        ]
    )
    assert store.latest_date("local", "lsstcam") == "2026-04-10"


async def test_calendar_counts_and_max_seq() -> None:
    store = EventStore()
    await store.apply(
        [
            created("lsstcam/2026-04-10/witness_detector/000001/a.png"),
            created("lsstcam/2026-04-10/witness_detector/000005/b.png"),
            created("lsstcam/2026-04-10/focal_plane/000005/c.png"),
            # A per-day movie (word-sentinel seq) must not affect max seq.
            created("lsstcam/2026-04-10/movies/final/m.mp4"),
        ]
    )
    # Count = distinct seqs across channels {1, 5} = 2; max integer seq = 5.
    assert store.calendar_counts("local", "lsstcam") == {"2026-04-10": 2}
    assert store.calendar_max_seq("local", "lsstcam") == {"2026-04-10": 5}


async def test_calendar_channel_latest_picks_newest_date_per_channel() -> None:
    store = EventStore()
    await store.apply(
        [
            # witness_detector last has data on 04-08; focal_plane on 04-10.
            created("lsstcam/2026-04-08/witness_detector/000001/a.png"),
            created("lsstcam/2026-04-10/witness_detector/000002/b.png"),
            created("lsstcam/2026-04-08/witness_detector/000009/x.png"),
            created("lsstcam/2026-04-10/focal_plane/000005/c.png"),
            # A per-day artifact counts as data even with no per-seq channel.
            created("lsstcam/2026-04-09/movies/final/m.mp4"),
        ]
    )
    assert store.calendar_channel_latest("local", "lsstcam") == {
        "witness_detector": "2026-04-10",
        "focal_plane": "2026-04-10",
        "movies": "2026-04-09",
    }


async def test_calendar_channel_latest_empty_for_unknown_camera() -> None:
    store = EventStore()
    assert store.calendar_channel_latest("local", "nope") == {}


async def test_calendar_max_seq_omits_days_without_numeric_seqs() -> None:
    store = EventStore()
    # A day with only a per-day artifact has no numeric channel seqs.
    await store.apply([created("auxtel/2026-04-10/movies/final/m.mp4")])
    assert store.calendar_max_seq("local", "auxtel") == {}
    # ...but it still has data and counts 0.
    assert store.calendar_counts("local", "auxtel") == {"2026-04-10": 0}


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


async def test_apply_returns_touched_slices() -> None:
    store = EventStore()
    touched = await store.apply(
        [
            created("lsstcam/2026-04-10/c/000001/a.png"),
            created("lsstcam/2026-04-11/c/000002/b.png"),
            created("auxtel/2026-04-10/movies/final/m.mp4"),
        ]
    )
    # One (loc, cam, date) per distinct date/camera, so a caller can persist
    # exactly the changed slices.
    assert touched == {
        ("local", "lsstcam", "2026-04-10"),
        ("local", "lsstcam", "2026-04-11"),
        ("local", "auxtel", "2026-04-10"),
    }


async def test_prune_dates_drops_unobserved_and_keeps_observed() -> None:
    store = EventStore()
    await store.apply(
        [
            created("auxtel/1970-01-01/monitor/000001/a.png"),  # stale
            created("auxtel/2026-04-10/monitor/000001/b.png"),  # real
        ]
    )
    # A full sweep observed only the real date; the epoch slice is stale.
    pruned = await store.prune_dates(("local", "auxtel"), {"2026-04-10"})
    assert pruned == {"1970-01-01"}
    assert store.calendar("local", "auxtel") == ["2026-04-10"]
    assert store.date_index("local", "auxtel", "1970-01-01") is None


async def test_prune_dates_publishes_calendar_change_per_dropped_date() -> None:
    bus = EventBus()
    store = EventStore(bus)
    received: list[StoreChange] = []
    async with bus.subscribe() as stream:
        await store.apply([created("auxtel/1970-01-01/monitor/000001/a.png")])
        await store.prune_dates(("local", "auxtel"), set())
        # Drain the apply's channelData, then the prune's calendar change.
        received.append(await stream.__anext__())
        received.append(await stream.__anext__())
    assert StoreChange("calendarUpdate", "local", "auxtel", "1970-01-01") in received


async def test_prune_dates_noop_for_unknown_camera() -> None:
    store = EventStore()
    assert await store.prune_dates(("local", "nope"), {"2026-04-10"}) == set()


async def test_prune_dates_keeps_protected_dates() -> None:
    # A protected date (e.g. today, just added by the current-day loop after
    # the sweep listed the prefix) must survive even when the sweep's observed
    # set doesn't include it.
    store = EventStore()
    await store.apply([created("auxtel/1970-01-01/monitor/000001/a.png")])
    await store.apply([created("auxtel/2026-04-10/monitor/000001/b.png")])
    pruned = await store.prune_dates(("local", "auxtel"), set(), protect={"2026-04-10"})
    assert pruned == {"1970-01-01"}
    assert store.calendar("local", "auxtel") == ["2026-04-10"]


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


async def test_non_conforming_keys_are_ignored() -> None:
    store = EventStore()
    await store.apply(
        [
            created("garbage.txt"),
            created("lsstcam/not-a-date/c/000001/a.png"),
        ]
    )
    assert store.snapshot() == {}
    assert store.calendar("local", "lsstcam") == []


async def test_apply_yields_during_large_batches() -> None:
    # Batches beyond _YIELD_EVERY hit the cooperative sleep; everything still
    # lands in the index.
    store = EventStore()
    await store.apply(
        [
            created(f"lsstcam/2026-04-10/c/{n:06d}/a.png")
            for n in range(1, EventStore._YIELD_EVERY + 2)  # noqa: SLF001
        ]
    )
    idx = store.date_index("local", "lsstcam", "2026-04-10")
    assert idx is not None
    assert len(idx.channels["c"]) == EventStore._YIELD_EVERY + 1  # noqa: SLF001


async def test_remove_per_day_artifact_prunes_date() -> None:
    store = EventStore()
    key = "auxtel/2026-04-10/movies/final/m.mp4"
    await store.apply([created(key)])
    await store.apply([removed(key)])
    assert store.date_index("local", "auxtel", "2026-04-10") is None
    assert store.calendar("local", "auxtel") == []


async def test_remove_night_report_key() -> None:
    store = EventStore()
    key = "lsstcam/2026-04-10/night_report/summary_md.json"
    await store.apply([created(key)])
    assert store.has_night_report("local", "lsstcam", "2026-04-10")
    await store.apply([removed(key)])
    assert not store.has_night_report("local", "lsstcam", "2026-04-10")


async def test_remove_for_unknown_date_is_a_noop() -> None:
    # Removing objects (metadata, channel) from a date that was never indexed
    # must not create empty structures or raise.
    store = EventStore()
    await store.apply(
        [
            removed("lsstcam/2026-04-10/metadata.json"),
            removed("lsstcam/2026-04-10/c/000001/a.png"),
        ]
    )
    assert store.snapshot() == {}


async def test_remove_one_of_two_seqs_keeps_channel() -> None:
    store = EventStore()
    await store.apply(
        [
            created("lsstcam/2026-04-10/c/000001/a.png"),
            created("lsstcam/2026-04-10/c/000002/b.png"),
        ]
    )
    await store.apply([removed("lsstcam/2026-04-10/c/000002/b.png")])
    idx = store.date_index("local", "lsstcam", "2026-04-10")
    assert idx is not None
    assert idx.channels["c"] == {1}


async def test_bus_drops_changes_for_slow_subscriber(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A subscriber whose queue is full loses the overflow (logged) instead of
    # stalling the publisher; the queued change still arrives.
    import lsst.ts.rubintv.data.bus as bus_mod

    monkeypatch.setattr(bus_mod, "_QUEUE_MAXSIZE", 1)
    bus = EventBus()
    async with bus.subscribe() as stream:
        assert bus.subscriber_count == 1
        bus.publish(StoreChange("channelData", "lsstcam", "2026-04-10"))
        bus.publish(StoreChange("perDay", "lsstcam", "2026-04-10"))  # dropped
        change = await stream.__anext__()
        assert change.type == "channelData"
    assert bus.subscriber_count == 0


async def test_clear_empties_store_and_calendar() -> None:
    store = EventStore()
    await store.apply(
        [
            created("lsstcam/2026-04-10/witness_detector/000001/a.png"),
            created("auxtel/2026-04-09/monitor/000001/m.png"),
        ]
    )
    assert store.calendar("local", "lsstcam") == ["2026-04-10"]

    store.clear()
    assert store.calendar("local", "lsstcam") == []
    assert store.calendar("local", "auxtel") == []
    assert store.date_index("local", "lsstcam", "2026-04-10") is None
    assert store.snapshot() == {}
