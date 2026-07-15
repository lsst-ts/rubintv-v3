"""Redis-fed detector status: store + stream-entry parsing + write actions."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from types import SimpleNamespace

import pytest
from lsst.ts.rubintv.config.models import RedisDetector
from lsst.ts.rubintv.data.bus import EventBus
from lsst.ts.rubintv.data.controls import ControlStore, DetectorStore
from lsst.ts.rubintv.data.redis_inputs import (
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
    # The real producer wraps everything in a single ``data`` JSON field,
    # each entry being a {status, type} dict (see stream_writer_demo.py). We
    # split by type into workers / numWorkers / text, and a numeric worker
    # status becomes a queue length.
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


def test_apply_detector_entry_non_numeric_worker_count_is_dropped() -> None:
    # A worker_count whose status isn't an int is dropped rather than crashing
    # the reader; the workers it arrived with are still stored.
    store = DetectorStore()
    payload = {
        "numWorkers": {"status": "lots", "type": "worker_count"},
        "189": {"status": "busy", "type": "worker_status"},
    }
    apply_detector_entry(store, "sfmSet0", {"data": json.dumps(payload)})
    assert store.all() == {"sfmSet0": {"workers": {"189": {"status": "busy"}}}}


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


# --- start/stop lifecycle and the two reader loops (scripted fake) ---


class _FakePubSub:
    """Yields scripted keyspace messages, then parks until cancelled."""

    def __init__(self, messages: list[dict[str, str]]) -> None:
        self.messages = messages
        self.patterns: list[str] = []
        self.closed = False

    async def psubscribe(self, pattern: str) -> None:
        self.patterns.append(pattern)

    async def listen(self) -> AsyncIterator[dict[str, str]]:
        for message in self.messages:
            yield message
        await asyncio.Event().wait()  # park; the reader task is cancelled

    async def aclose(self) -> None:
        self.closed = True


_StreamBatch = list[tuple[str, list[tuple[str, dict[str, str]]]]]


class _LoopFakeRedis:
    """Connection fake for start(): ping/config_set/pubsub/get/xread/aclose."""

    def __init__(
        self,
        *,
        ping_ok: bool = True,
        db: int = 0,
        messages: list[dict[str, str]] | None = None,
        stream_batches: list[_StreamBatch] | None = None,
        seed_entries: dict[str, list[tuple[str, dict[str, str]]]] | None = None,
    ) -> None:
        self.store: dict[str, str] = {}
        self.pubsubs: list[_FakePubSub] = []
        self.closed = False
        # Mirror redis-py's connection_pool.connection_kwargs["db"] so the
        # reader can derive the keyspace-notification DB.
        self.connection_pool = SimpleNamespace(connection_kwargs={"db": db})
        self._ping_ok = ping_ok
        self._messages = messages or []
        self._batches = list(stream_batches or [])
        # stream name -> retained entries, newest last (as XREVRANGE expects).
        self._seed_entries = seed_entries or {}

    async def ping(self) -> None:
        if not self._ping_ok:
            raise ConnectionError("unreachable")

    async def config_set(self, key: str, value: str) -> None:
        # Managed Redis refusing CONFIG SET must be non-fatal.
        raise RuntimeError("CONFIG SET forbidden")

    def pubsub(self) -> _FakePubSub:
        ps = _FakePubSub(self._messages)
        self.pubsubs.append(ps)
        return ps

    async def get(self, key: str) -> str | None:
        return self.store.get(key)

    async def xread(self, last_ids: dict[str, str], block: int = 0) -> _StreamBatch:
        if self._batches:
            return self._batches.pop(0)
        await asyncio.Event().wait()  # no more entries; park until cancelled
        return []

    async def xrevrange(
        self, stream_name: str, count: int = 1
    ) -> list[tuple[str, dict[str, str]]]:
        entries = self._seed_entries.get(stream_name, [])
        return list(reversed(entries))[:count]

    async def aclose(self) -> None:
        self.closed = True


def _patch_from_url(monkeypatch: pytest.MonkeyPatch, fake: _LoopFakeRedis) -> None:
    monkeypatch.setattr(
        "redis.asyncio.Redis.from_url",
        classmethod(lambda cls, url, **kw: fake),
    )


async def test_start_without_url_stays_disabled() -> None:
    inputs = _inputs()  # url=None
    await inputs.start()
    assert inputs.enabled is False
    await inputs.stop()  # no tasks, no connection: still safe


async def test_start_degrades_when_redis_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    inputs = RedisInputs("redis://x", EventBus(), ControlStore(), DetectorStore(), [])
    _patch_from_url(monkeypatch, _LoopFakeRedis(ping_ok=False))
    await inputs.start()
    # Unreachable Redis disables the inputs but must not raise.
    assert inputs.enabled is False
    await inputs.stop()


async def test_readback_loop_publishes_control_changes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bus = EventBus()
    controls = ControlStore()
    inputs = RedisInputs("redis://x", bus, controls, DetectorStore(), [])
    fake = _LoopFakeRedis(
        messages=[
            # Subscription confirmations are skipped.
            {"type": "psubscribe", "channel": "__keyspace@0__:*_READBACK"},
            # A readback key with no value (deleted) is skipped.
            {"type": "pmessage", "channel": "__keyspace@0__:GONE_READBACK"},
            # A real change is fetched, stored, and published.
            {"type": "pmessage", "channel": "__keyspace@0__:AOS_READBACK"},
        ]
    )
    fake.store["AOS_READBACK"] = "danish"
    _patch_from_url(monkeypatch, fake)

    async with bus.subscribe() as stream:
        await inputs.start()
        assert inputs.enabled is True
        change = await asyncio.wait_for(anext(stream), timeout=2)
    assert change.type == "controlReadback"
    assert controls.all("*") == {"AOS_READBACK": "danish"}
    assert fake.pubsubs[0].patterns == ["__keyspace@0__:*_READBACK"]

    await inputs.stop()
    assert fake.closed is True


async def test_readback_loop_reconnects_after_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A Redis blip must not permanently kill the reader: the supervisor
    # restarts it (after backoff) and it re-subscribes on a fresh pubsub, then
    # keeps delivering. Without the supervisor the first raise ended live
    # readback forever. We shrink the backoff so the test doesn't wait a real
    # second.
    monkeypatch.setattr(
        "lsst.ts.rubintv.data.redis_inputs._RECONNECT_BACKOFF_MIN", 0.01
    )
    bus = EventBus()
    controls = ControlStore()
    inputs = RedisInputs("redis://x", bus, controls, DetectorStore(), [])

    # First pubsub's listen() raises (connection dropped); the second delivers.
    class _FlakyPubSub:
        def __init__(self, raise_first: bool) -> None:
            self.patterns: list[str] = []
            self.closed = False
            self._raise = raise_first

        async def psubscribe(self, pattern: str) -> None:
            self.patterns.append(pattern)

        async def listen(self):  # type: ignore[no-untyped-def]
            if self._raise:
                raise ConnectionError("dropped")
            yield {"type": "pmessage", "channel": "__keyspace@0__:AOS_READBACK"}
            await asyncio.Event().wait()

        async def aclose(self) -> None:
            self.closed = True

    pubsubs = [_FlakyPubSub(raise_first=True), _FlakyPubSub(raise_first=False)]
    made: list[_FlakyPubSub] = []

    class _ReconnectFake(_LoopFakeRedis):
        def pubsub(self):  # type: ignore[no-untyped-def]
            ps = pubsubs[len(made)]
            made.append(ps)
            return ps

    fake = _ReconnectFake()
    fake.store["AOS_READBACK"] = "danish"
    _patch_from_url(monkeypatch, fake)

    async with bus.subscribe() as stream:
        await inputs.start()
        # The change only arrives after the loop restarts on the second pubsub.
        change = await asyncio.wait_for(anext(stream), timeout=2)
    assert change.type == "controlReadback"
    assert controls.all("*") == {"AOS_READBACK": "danish"}
    assert len(made) == 2  # reconnected
    assert made[0].closed is True  # the broken pubsub was released

    await inputs.stop()


async def test_readback_keyspace_pattern_uses_configured_db(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Keyspace notifications are published on __keyspace@{db}__; a non-zero DB
    # in the URL must be reflected in the psubscribe pattern or every readback
    # is silently missed.
    bus = EventBus()
    inputs = RedisInputs("redis://x/2", bus, ControlStore(), DetectorStore(), [])
    fake = _LoopFakeRedis(db=2, messages=[])
    _patch_from_url(monkeypatch, fake)

    await inputs.start()
    # Give the reader a tick to subscribe.
    await asyncio.sleep(0.05)
    assert fake.pubsubs[0].patterns == ["__keyspace@2__:*_READBACK"]

    await inputs.stop()


async def test_detector_loop_resumes_from_seed_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The live XREAD must resume from the seeded entry id, not "$": an entry
    # written between the seed and the first read (id "1-2" here, newer than
    # the seed's "1-1") must still be delivered. Anchoring at "$" would skip
    # it.
    bus = EventBus()
    detectors = DetectorStore()
    inputs = RedisInputs(
        "redis://x",
        bus,
        ControlStore(),
        detectors,
        [RedisDetector(key="CLUSTER_STATUS_AOS_SET_0", name="aosSet0")],
    )
    seed = {"data": json.dumps({"4": {"status": "idle", "type": "worker_status"}})}
    live = {"data": json.dumps({"4": {"status": "busy", "type": "worker_status"}})}
    stream_name = "stream:CLUSTER_STATUS_AOS_SET_0"
    captured_last_ids: list[dict[str, str]] = []

    class _ResumeFake(_LoopFakeRedis):
        async def xread(self, last_ids, block=0):  # type: ignore[no-untyped-def]
            captured_last_ids.append(dict(last_ids))
            if self._batches:
                return self._batches.pop(0)
            await asyncio.Event().wait()
            return []

    fake = _ResumeFake(
        seed_entries={stream_name: [("1-1", seed)]},
        stream_batches=[[(stream_name, [("1-2", live)])]],
    )
    _patch_from_url(monkeypatch, fake)

    async with bus.subscribe() as stream:
        await inputs.start()
        # First change is the seed snapshot; second is the live "1-2" entry.
        await asyncio.wait_for(anext(stream), timeout=2)
        change = await asyncio.wait_for(anext(stream), timeout=2)
    assert change.type == "detectorStatus"
    assert detectors.all() == {"aosSet0": {"workers": {"4": {"status": "busy"}}}}
    # The first XREAD resumed from the seed id, not "$".
    assert captured_last_ids[0] == {stream_name: "1-1"}

    await inputs.stop()


async def test_detector_loop_seeds_from_last_retained_entry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The producer only writes on change, so after a restart during a quiet
    # period the only data is each stream's retained last entry. We must seed
    # from XREVRANGE so the Cluster Status page isn't blank until the next
    # change. Here xread has no new batches (parks), proving the snapshot the
    # client sees came purely from the seed.
    bus = EventBus()
    detectors = DetectorStore()
    inputs = RedisInputs(
        "redis://x",
        bus,
        ControlStore(),
        detectors,
        [RedisDetector(key="CLUSTER_STATUS_AOS_SET_0", name="aosSet0")],
    )
    entry = {"data": json.dumps({"4": {"status": "busy", "type": "worker_status"}})}
    fake = _LoopFakeRedis(
        seed_entries={"stream:CLUSTER_STATUS_AOS_SET_0": [("1-1", entry)]},
    )
    _patch_from_url(monkeypatch, fake)

    async with bus.subscribe() as stream:
        await inputs.start()
        change = await asyncio.wait_for(anext(stream), timeout=2)
    assert change.type == "detectorStatus"
    assert detectors.all() == {"aosSet0": {"workers": {"4": {"status": "busy"}}}}

    await inputs.stop()
    assert fake.closed is True


async def test_detector_loop_no_seed_when_streams_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A stream that has never been written yields nothing from XREVRANGE; we
    # must not publish a spurious empty snapshot. The first change the client
    # sees comes from a later live entry instead.
    bus = EventBus()
    detectors = DetectorStore()
    inputs = RedisInputs(
        "redis://x",
        bus,
        ControlStore(),
        detectors,
        [RedisDetector(key="CLUSTER_STATUS_SFM_SET_0", name="sfmSet0")],
    )
    entry = {"data": json.dumps({"189": {"status": "free", "type": "worker_status"}})}
    fake = _LoopFakeRedis(
        stream_batches=[
            [("stream:CLUSTER_STATUS_SFM_SET_0", [("2-1", entry)])],
        ],
    )
    _patch_from_url(monkeypatch, fake)

    async with bus.subscribe() as stream:
        await inputs.start()
        change = await asyncio.wait_for(anext(stream), timeout=2)
    # Only the live entry produced a change; the empty seed published nothing.
    assert change.type == "detectorStatus"
    assert detectors.all() == {"sfmSet0": {"workers": {"189": {"status": "free"}}}}

    await inputs.stop()
    assert fake.closed is True


async def test_detector_loop_emits_debug_trace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The DEBUG trace (enabled via log_level=DEBUG) should follow the data
    # from seed read -> store apply -> publish so a streaming issue can be
    # located. We capture by recording the module logger's debug() events
    # directly, which is independent of structlog's process-wide
    # configuration/cache.
    events: list[str] = []
    monkeypatch.setattr(
        "lsst.ts.rubintv.data.redis_inputs.log.debug",
        lambda event, **kw: events.append(event),
    )

    bus = EventBus()
    detectors = DetectorStore()
    inputs = RedisInputs(
        "redis://x",
        bus,
        ControlStore(),
        detectors,
        [RedisDetector(key="CLUSTER_STATUS_AOS_SET_0", name="aosSet0")],
    )
    entry = {"data": json.dumps({"4": {"status": "busy", "type": "worker_status"}})}
    fake = _LoopFakeRedis(
        seed_entries={"stream:CLUSTER_STATUS_AOS_SET_0": [("1-1", entry)]},
    )
    _patch_from_url(monkeypatch, fake)

    async with bus.subscribe() as stream:
        await inputs.start()
        await asyncio.wait_for(anext(stream), timeout=2)
    await inputs.stop()

    assert "redis.detector.seed_start" in events
    assert "redis.detector.seed_entry" in events
    assert "redis.detector.apply" in events
    assert "redis.detector.seed_publish" in events


async def test_detector_loop_applies_stream_entries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bus = EventBus()
    detectors = DetectorStore()
    inputs = RedisInputs(
        "redis://x",
        bus,
        ControlStore(),
        detectors,
        [RedisDetector(key="CLUSTER_STATUS_SFM_SET_0", name="sfmSet0")],
    )
    entry = {"data": json.dumps({"189": {"status": "busy", "type": "worker_status"}})}
    fake = _LoopFakeRedis(
        stream_batches=[
            [("stream:CLUSTER_STATUS_SFM_SET_0", [("1-1", entry)])],
        ]
    )
    _patch_from_url(monkeypatch, fake)

    async with bus.subscribe() as stream:
        await inputs.start()
        # The readback loop has no messages, so the first change is the
        # detector snapshot; payloads are stored under the config *name*.
        change = await asyncio.wait_for(anext(stream), timeout=2)
    assert change.type == "detectorStatus"
    assert detectors.all() == {"sfmSet0": {"workers": {"189": {"status": "busy"}}}}

    await inputs.stop()
    assert fake.closed is True
