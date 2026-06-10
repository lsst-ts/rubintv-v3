"""Redis-fed detector status: store + stream-entry parsing + write actions."""

from __future__ import annotations

import json

import pytest

from rubintv.data.bus import EventBus
from rubintv.data.controls import ControlStore, DetectorStore
from rubintv.data.redis_inputs import (
    RedisInputs,
    RedisUnavailable,
    apply_detector_entry,
)


def test_detector_store_replaces_set_payload() -> None:
    store = DetectorStore()
    store.set("sfmSet0", {"workers": {"w1": {"status": "busy"}}})
    store.set("sfmSet0", {"workers": {"w1": {"status": "free"}}})
    assert store.all() == {"sfmSet0": {"workers": {"w1": {"status": "free"}}}}


def test_detector_store_all_is_a_copy() -> None:
    store = DetectorStore()
    store.set("s", {"numWorkers": 4})
    snap = store.all()
    snap["s"]["numWorkers"] = 99
    # Mutating the returned snapshot must not affect the store.
    assert store.all() == {"s": {"numWorkers": 4}}


def test_apply_detector_entry_splits_workers_count_and_text() -> None:
    # The real producer wraps everything in a single ``data`` JSON field, each
    # entry being a {status, type} dict (see stream_writer_demo.py). We split by
    # type into workers / numWorkers / text, and a numeric worker status becomes
    # a queue length.
    store = DetectorStore()
    payload = {
        "189": {"status": "busy", "type": "worker_status"},
        "190": {"status": "3", "type": "worker_status"},  # queued -> length 3
        "numWorkers": {"status": "8", "type": "worker_count"},
        "queueA": {"status": "12", "type": "text_status"},
    }
    apply_detector_entry(store, "sfmSet0", {"data": json.dumps(payload)})
    assert store.all() == {
        "sfmSet0": {
            "workers": {
                "189": {"status": "busy"},
                "190": {"status": "queued", "queue_length": 3},
            },
            "numWorkers": 8,
            "text": {"queueA": "12"},
        }
    }


def test_apply_detector_entry_flat_fallback() -> None:
    # Without a ``data`` blob, flat {worker: status} fields are accepted and
    # wrapped under ``workers``.
    store = DetectorStore()
    apply_detector_entry(store, "sfmSet0", {"1": "busy", "w2": "free"})
    assert store.all() == {
        "sfmSet0": {"workers": {"1": {"status": "busy"}, "w2": {"status": "free"}}}
    }


def test_apply_detector_entry_bad_json_is_ignored() -> None:
    store = DetectorStore()
    apply_detector_entry(store, "sfmSet0", {"data": "not json{"})
    assert store.all() == {}


def _inputs() -> RedisInputs:
    return RedisInputs(None, EventBus(), ControlStore(), DetectorStore(), [])


async def test_set_value_raises_when_redis_down() -> None:
    inputs = _inputs()
    assert inputs.enabled is False
    with pytest.raises(RedisUnavailable):
        await inputs.set_value("K", "V")


async def test_flushdb_raises_when_redis_down() -> None:
    inputs = _inputs()
    with pytest.raises(RedisUnavailable):
        await inputs.flushdb()


class _FakeRedis:
    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.flushed = False

    async def set(self, key: str, value: str) -> None:
        self.store[key] = value

    async def flushdb(self) -> None:
        self.flushed = True
        self.store.clear()


async def test_set_value_and_flushdb_use_the_connection() -> None:
    inputs = _inputs()
    fake = _FakeRedis()
    inputs._redis = fake  # type: ignore[assignment]  # inject fake connection
    assert inputs.enabled is True

    await inputs.set_value("RUBINTV_CONTROL_AOS_PIPELINE", "DANISH")
    assert fake.store["RUBINTV_CONTROL_AOS_PIPELINE"] == "DANISH"

    await inputs.flushdb()
    assert fake.flushed is True
    assert fake.store == {}
