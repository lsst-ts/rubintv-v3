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

"""Redis-fed detector status: store + stream-entry parsing + write actions."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from types import SimpleNamespace
from typing import Any
from unittest.mock import ANY

import pytest
import redis.exceptions
from lsst.ts.rubintv.config.models import RedisDetector
from lsst.ts.rubintv.data.bus import EventBus
from lsst.ts.rubintv.data.controls import ControlStore, DetectorStore, RedisLink
from lsst.ts.rubintv.data.events import StoreChange
from lsst.ts.rubintv.data.redis_inputs import (
    RedisInputs,
    RedisUnavailable,
    apply_detector_entry,
    entry_time,
    redacted,
)

RedisConnectionError = redis.exceptions.ConnectionError
ResponseError = redis.exceptions.ResponseError


def _clock(
    monkeypatch: pytest.MonkeyPatch, *, time: float = 0.0, monotonic: float = 0.0
) -> None:
    """Fix the clock the stores read ages against (theirs alone: the event
    loop goes on running on the real one)."""
    monkeypatch.setattr(
        "lsst.ts.rubintv.data.controls.time",
        SimpleNamespace(time=lambda: time, monotonic=lambda: monotonic),
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


@pytest.mark.parametrize(
    "payload",
    ["null", "[1, 2]", "3", '"busy"'],
)
def test_apply_detector_entry_json_that_is_no_object_is_ignored(payload: str) -> None:
    # Left to raise, such an entry stopped the reader every time it was read
    # again: as a stream's newest, at every reconnect.
    store = DetectorStore()
    apply_detector_entry(store, "sfmSet0", {"data": payload})
    assert store.all() == {}


@pytest.mark.parametrize(
    ("entry_id", "written"),
    [
        ("1795521600123-0", 1795521600.123),
        ("1795521600123-17", 1795521600.123),
        # A hand-written counter, not a time.
        ("1-1", None),
        ("not-an-id", None),
        ("", None),
        (None, None),
    ],
)
def test_entry_time_reads_the_time_out_of_a_stream_id(
    entry_id: str | None, written: float | None
) -> None:
    assert entry_time(entry_id) == written


def test_detector_store_keeps_when_each_set_was_written(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The producer writes a set only when it changes, so the page needs the
    # entry's own time to tell an hour-old picture from a fresh one.
    _clock(monkeypatch, time=1795521700.0)
    store = DetectorStore()
    entry = {"data": json.dumps({"1": {"status": "busy", "type": "worker_status"}})}
    apply_detector_entry(store, "sfmSet0", entry, "1795521600000-0")
    apply_detector_entry(store, "sfmSet1", entry, "1795521690500-3")
    apply_detector_entry(store, "flat", {"1": "busy"}, "1795521699000-0")
    # No usable time: the set is stored, and has no age.
    apply_detector_entry(store, "untimed", entry, "7-1")
    assert store.ages() == {"sfmSet0": 100.0, "sfmSet1": 9.5, "flat": 1.0}
    assert set(store.all()) == {"sfmSet0", "sfmSet1", "flat", "untimed"}

    # A later entry without a time takes the old one away with it, and a
    # clock behind the entry's reads as no age, not a negative one.
    apply_detector_entry(store, "sfmSet0", entry, None)
    apply_detector_entry(store, "sfmSet1", entry, "1795521800000-0")
    assert store.ages() == {"sfmSet1": 0.0, "flat": 1.0}


def test_control_store_discard() -> None:
    controls = ControlStore()
    controls.set("*", "A_READBACK", "1")
    controls.discard("*", "A_READBACK")
    controls.discard("*", "NEVER_SET")
    controls.discard("nowhere", "A_READBACK")
    assert controls.all("*") == {}


def test_redis_link_reports_ages(monkeypatch: pytest.MonkeyPatch) -> None:
    assert RedisLink().report() == {
        "configured": False,
        "connected": False,
        "changed_age_seconds": None,
        "read_age_seconds": None,
    }
    _clock(monkeypatch, monotonic=500.0)
    link = RedisLink(configured=True, connected=True, changed_at=380.0, read_at=497.5)
    assert link.report() == {
        "configured": True,
        "connected": True,
        "changed_age_seconds": 120.0,
        "read_age_seconds": 2.5,
    }


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


@pytest.mark.parametrize(
    "error", [RedisConnectionError("refused"), TimeoutError("no answer")]
)
async def test_a_write_redis_does_not_take_raises_unavailable(
    error: Exception,
) -> None:
    # A Redis that drops after startup used to surface as a bare 500; the
    # admin endpoints turn RedisUnavailable into a 503 that says why.
    class _Gone:
        async def set(self, key: str, value: str) -> None:
            raise error

        async def flushdb(self) -> None:
            raise error

    inputs = _inputs()
    inputs._redis = _Gone()  # type: ignore[assignment]
    with pytest.raises(RedisUnavailable, match="write failed"):
        await inputs.set_value("K", "V")
    with pytest.raises(RedisUnavailable, match="flush failed"):
        await inputs.flushdb()


# --- start/stop lifecycle and the two reader loops (scripted fake) ---


async def _eventually(done: Callable[[], bool]) -> None:
    """Wait for ``done()``. The limit is only there to fail a test that
    would otherwise hang; nothing is timed against it."""
    async with asyncio.timeout(10):
        while not done():
            await asyncio.sleep(0.001)


def _published(bus: EventBus) -> list[str]:
    """The types of the changes published on ``bus`` from here on."""
    seen: list[str] = []
    publish = bus.publish

    def record(change: StoreChange) -> None:
        seen.append(change.type)
        publish(change)

    bus.publish = record  # type: ignore[method-assign]
    return seen


class _FakePubSub:
    """Hands out scripted keyspace messages, then waits out each timeout."""

    def __init__(self, messages: list[dict[str, str]]) -> None:
        self._pending = list(messages)
        self.patterns: list[str] = []
        self.closed = False

    async def psubscribe(self, pattern: str) -> None:
        self.patterns.append(pattern)

    async def get_message(
        self, ignore_subscribe_messages: bool = False, timeout: float = 0.0
    ) -> dict[str, str] | None:
        if self._pending:
            return self._pending.pop(0)
        await asyncio.sleep(timeout)
        return None

    async def aclose(self) -> None:
        self.closed = True


_StreamBatch = list[tuple[str, list[tuple[str, dict[str, str]]]]]


class _LoopFakeRedis:
    """Connection fake for the readers: config/pubsub/get/mget/xread/aclose.

    ``down = True`` makes every command fail as an unreachable server does.
    """

    def __init__(
        self,
        *,
        db: int = 0,
        notify: str = "",
        config_refused: bool = False,
        messages: list[dict[str, str]] | None = None,
        stream_batches: list[_StreamBatch] | None = None,
        seed_entries: dict[str, list[tuple[str, dict[str, str]]]] | None = None,
    ) -> None:
        self.store: dict[str, str] = {}
        self.pubsubs: list[_FakePubSub] = []
        self.mget_calls: list[list[str]] = []
        self.config_sets: list[str] = []
        self.xread_ids: list[dict[str, str]] = []
        self.attempts = 0
        self.down = False
        self.closed = False
        self.notify = notify
        # Mirror redis-py's connection_pool.connection_kwargs["db"] so the
        # reader can derive the keyspace-notification DB.
        self.connection_pool = SimpleNamespace(connection_kwargs={"db": db})
        self._config_refused = config_refused
        self._messages = messages or []
        self._batches = list(stream_batches or [])
        # stream name -> retained entries, newest last (as XREVRANGE expects).
        self._seed_entries = seed_entries or {}

    def _answer(self) -> None:
        self.attempts += 1
        if self.down:
            raise RedisConnectionError("Error 111 connecting to x:6379.")

    async def config_get(self, key: str) -> dict[str, str]:
        self._answer()
        if self._config_refused:
            raise ResponseError("unknown command 'CONFIG'")
        return {key: self.notify}

    async def config_set(self, key: str, value: str) -> bool:
        self._answer()
        self.config_sets.append(value)
        self.notify = value
        return True

    def pubsub(self) -> _FakePubSub:
        ps = _FakePubSub(self._messages)
        self.pubsubs.append(ps)
        return ps

    async def get(self, key: str) -> str | None:
        self._answer()
        return self.store.get(key)

    async def mget(self, keys: list[str]) -> list[str | None]:
        self._answer()
        self.mget_calls.append(list(keys))
        return [self.store.get(key) for key in keys]

    async def xread(self, last_ids: dict[str, str], block: int = 0) -> _StreamBatch:
        self._answer()
        self.xread_ids.append(dict(last_ids))
        if self._batches:
            return self._batches.pop(0)
        await asyncio.Event().wait()  # no more entries; park until cancelled
        return []

    async def xrevrange(
        self, stream_name: str, count: int = 1
    ) -> list[tuple[str, dict[str, str]]]:
        self._answer()
        entries = self._seed_entries.get(stream_name, [])
        return list(reversed(entries))[:count]

    async def aclose(self) -> None:
        self.closed = True


def _patch_from_url(monkeypatch: pytest.MonkeyPatch, fake: _LoopFakeRedis) -> None:
    monkeypatch.setattr(
        "redis.asyncio.Redis.from_url",
        classmethod(lambda cls, url, **kw: fake),
    )


def _fast(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    """Shrink one of the module's waits so a test needn't sit one out."""
    monkeypatch.setattr(f"lsst.ts.rubintv.data.redis_inputs.{name}", 0.001)


def _record_log(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    """Capture redis_inputs' log calls as (event, fields)."""
    logged: list[tuple[str, dict[str, Any]]] = []

    class Recorder:
        def __getattr__(self, level: str) -> object:
            return lambda event, **fields: logged.append((event, fields))

    monkeypatch.setattr("lsst.ts.rubintv.data.redis_inputs.log", Recorder())
    return logged


def _events(logged: list[tuple[str, dict[str, Any]]]) -> list[str]:
    return [event for event, _ in logged]


SFM = RedisDetector(key="CLUSTER_STATUS_SFM_SET_0", name="sfmSet0")
SFM_STREAM = "stream:CLUSTER_STATUS_SFM_SET_0"
AOS = RedisDetector(key="CLUSTER_STATUS_AOS_SET_0", name="aosSet0")
AOS_STREAM = "stream:CLUSTER_STATUS_AOS_SET_0"


def _entry(status: str, worker: str = "189") -> dict[str, str]:
    return {"data": json.dumps({worker: {"status": status, "type": "worker_status"}})}


async def test_start_without_url_stays_disabled() -> None:
    inputs = _inputs()  # url=None
    await inputs.start()
    assert inputs.enabled is False
    assert inputs.link.report()["configured"] is False
    await inputs.stop()  # no tasks, no connection: still safe


async def test_start_with_an_unusable_url_stays_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # No retry mends a URL redis-py can't parse, so the readers aren't
    # started; and what is logged doesn't quote it.
    logged = _record_log(monkeypatch)
    inputs = RedisInputs(
        "nonsense://:s3cret@x", EventBus(), ControlStore(), DetectorStore(), []
    )
    await inputs.start()
    assert inputs.enabled is False
    assert inputs.link.configured is False
    assert _events(logged) == ["redis.disabled"]
    assert "s3cret" not in repr(logged)
    await inputs.stop()


async def test_redis_down_at_startup_is_retried_until_it_answers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Redis that came up a few seconds after the app used to leave Cluster
    # Status and the admin controls dead until the pod was restarted: one
    # ping at startup, and no reader was ever launched. The readers now
    # start regardless and connect when they can.
    _fast(monkeypatch, "_RECONNECT_BACKOFF_MIN")
    _fast(monkeypatch, "_RECONNECT_BACKOFF_MAX")
    logged = _record_log(monkeypatch)
    bus = EventBus()
    published = _published(bus)
    controls = ControlStore()
    detectors = DetectorStore()
    inputs = RedisInputs(
        "redis://:s3cret@x", bus, controls, detectors, [SFM], control_keys=["AOS"]
    )
    fake = _LoopFakeRedis(seed_entries={SFM_STREAM: [("1-1", _entry("busy"))]})
    fake.store["AOS_READBACK"] = "DANISH"
    fake.down = True
    _patch_from_url(monkeypatch, fake)

    await inputs.start()
    # start() neither waits on Redis nor gives up on it.
    assert inputs.enabled is True
    assert inputs.link.configured is True
    await _eventually(lambda: fake.attempts >= 8)
    assert inputs.link.connected is False
    assert inputs.link.read_at is None
    assert controls.all("*") == {}
    assert published == []
    # One warning per reader however many tries have failed; the retries
    # themselves go on at debug.
    assert _events(logged).count("redis.unavailable") == 2
    assert {
        fields["reader"] for event, fields in logged if event == "redis.unavailable"
    } == {"readback", "detectors"}
    assert _events(logged).count("redis.reader.reconnect") >= 6
    assert "redis.connected" not in _events(logged)

    fake.down = False
    await _eventually(lambda: inputs.link.connected)
    assert controls.all("*") == {"AOS_READBACK": "DANISH"}
    assert detectors.all() == {"sfmSet0": {"workers": {"189": {"status": "busy"}}}}
    assert inputs.link.read_at is not None
    # Both pages are told, once: each shows whether Redis is being read.
    assert published.count("detectorStatus") == 2  # the seed, then the link
    assert published.count("controlReadback") == 2
    assert ("redis.connected", {"url": "redis://:***@x"}) in logged
    assert _events(logged).count("redis.connected") == 1
    assert "s3cret" not in repr(logged)
    await inputs.stop()
    assert fake.closed is True


async def test_link_is_down_until_every_reader_is_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logged = _record_log(monkeypatch)
    bus = EventBus()
    published = _published(bus)
    inputs = RedisInputs("redis://x", bus, ControlStore(), DetectorStore(), [SFM])
    inputs._readers = {"readback", "detectors"}

    inputs._read("readback")
    assert inputs.link.connected is False
    inputs._read("detectors")
    assert inputs.link.connected is True
    assert published == ["detectorStatus", "controlReadback"]

    # One reader failing is enough to say Redis isn't being read, and the
    # other's next answer doesn't say it is again.
    inputs._lost("readback", RedisConnectionError("Connection closed by server."))
    inputs._read("detectors")
    assert inputs.link.connected is False
    assert published == ["detectorStatus", "controlReadback"] * 2
    # The same failure again says nothing more; a different one does. One
    # that isn't the connection's is an error, with its traceback.
    inputs._lost("readback", RedisConnectionError("Connection refused."))
    bug = AttributeError("'list' object has no attribute 'items'")
    inputs._lost("readback", bug)
    inputs._lost("readback", ResponseError("WRONGTYPE"))
    assert logged == [
        ("redis.connected", {"url": "redis://x"}),
        (
            "redis.unavailable",
            {"reader": "readback", "error": "Connection closed by server."},
        ),
        ("redis.reader.error", {"reader": "readback", "exc_info": bug}),
        ("redis.reader.error", {"reader": "readback", "exc_info": ANY}),
    ]

    inputs._read("readback")
    assert inputs.link.connected is True
    assert _events(logged)[-1] == "redis.connected"
    assert published == ["detectorStatus", "controlReadback"] * 3
    # Back, so the next failure is a new one.
    inputs._lost("readback", RedisConnectionError("Connection closed by server."))
    assert _events(logged)[-1] == "redis.unavailable"


async def test_readback_loop_publishes_control_changes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logged = _record_log(monkeypatch)
    bus = EventBus()
    published = _published(bus)
    controls = ControlStore()
    inputs = RedisInputs("redis://x", bus, controls, DetectorStore(), [])
    fake = _LoopFakeRedis(
        messages=[
            # Subscription confirmations are skipped.
            {"type": "psubscribe", "channel": "__keyspace@0__:*_READBACK"},
            # A readback key with no value that was never held is skipped.
            {"type": "pmessage", "channel": "__keyspace@0__:GONE_READBACK"},
            # A real change is fetched, stored, and published.
            {"type": "pmessage", "channel": "__keyspace@0__:AOS_READBACK"},
        ]
    )
    fake.store["AOS_READBACK"] = "danish"
    _patch_from_url(monkeypatch, fake)

    await inputs.start()
    await _eventually(lambda: controls.all("*") == {"AOS_READBACK": "danish"})
    assert fake.pubsubs[0].patterns == ["__keyspace@0__:*_READBACK"]
    # Connecting told both pages; then the one change.
    assert published == ["detectorStatus", "controlReadback", "controlReadback"]
    assert (
        "redis.readback.change",
        {"key": "AOS_READBACK", "value": "danish", "via": "event"},
    ) in logged
    assert "redis.readback.gone" not in _events(logged)

    await inputs.stop()
    assert fake.closed is True
    assert fake.pubsubs[0].closed is True


async def test_readback_event_for_a_deleted_key_drops_the_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A deleted or expired readback used to be skipped, so the Admin page
    # went on showing it as current.
    logged = _record_log(monkeypatch)
    bus = EventBus()
    published = _published(bus)
    controls = ControlStore()
    controls.set("*", "AOS_READBACK", "danish")
    inputs = RedisInputs("redis://x", bus, controls, DetectorStore(), [])
    inputs._redis = _LoopFakeRedis()  # type: ignore[assignment]

    await inputs._readback_event("__keyspace@0__:AOS_READBACK")
    assert controls.all("*") == {}
    assert published == ["controlReadback"]
    assert logged == [("redis.readback.gone", {"key": "AOS_READBACK"})]


async def test_readback_seeds_the_configured_controls_on_connect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Keyspace events only carry changes, so a control set before the pod
    # started would show no value until it next changed. The current
    # readbacks are read on connect instead, and browsers told.
    logged = _record_log(monkeypatch)
    bus = EventBus()
    controls = ControlStore()
    inputs = RedisInputs(
        "redis://x",
        bus,
        controls,
        DetectorStore(),
        [],
        control_keys=["RUBINTV_CONTROL_AOS", "RUBINTV_CONTROL_UNSET"],
    )
    fake = _LoopFakeRedis()
    fake.store["RUBINTV_CONTROL_AOS_READBACK"] = "DANISH"
    _patch_from_url(monkeypatch, fake)

    await inputs.start()
    await _eventually(lambda: inputs.link.connected)
    assert fake.mget_calls == [
        ["RUBINTV_CONTROL_AOS_READBACK", "RUBINTV_CONTROL_UNSET_READBACK"]
    ]
    # Only readbacks that exist are stored, under their full key.
    assert controls.all("*") == {"RUBINTV_CONTROL_AOS_READBACK": "DANISH"}
    # Whether the analysis side answered a send is otherwise invisible: the
    # seed lists what it found.
    assert (
        "redis.readback.seed",
        {
            "found": 1,
            "keys": 2,
            "readbacks": {"RUBINTV_CONTROL_AOS_READBACK": "DANISH"},
        },
    ) in logged
    assert "redis.readback.change" not in _events(logged)
    await inputs.stop()


async def test_readback_seed_with_nothing_set_stores_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bus = EventBus()
    published = _published(bus)
    controls = ControlStore()
    inputs = RedisInputs(
        "redis://x", bus, controls, DetectorStore(), [], control_keys=["K"]
    )
    fake = _LoopFakeRedis()
    _patch_from_url(monkeypatch, fake)

    await inputs.start()
    await _eventually(lambda: inputs.link.connected)
    assert fake.mget_calls == [["K_READBACK"]]
    assert controls.all("*") == {}
    # Nothing but the link coming up.
    assert published == ["detectorStatus", "controlReadback"]
    await inputs.stop()


async def test_readbacks_are_polled_so_a_lost_event_is_only_late(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Keyspace events stop without a sound (Redis restarted and lost the
    # setting, or their connection went quiet), and never say a key was
    # flushed away. The Admin page then showed its last value for good. The
    # configured readbacks are read outright every few seconds as well.
    _fast(monkeypatch, "_READBACK_POLL_SECONDS")
    logged = _record_log(monkeypatch)
    bus = EventBus()
    published = _published(bus)
    controls = ControlStore()
    inputs = RedisInputs(
        "redis://x", bus, controls, DetectorStore(), [], control_keys=["AOS", "CHIP"]
    )
    fake = _LoopFakeRedis()
    fake.store["AOS_READBACK"] = "DANISH"
    _patch_from_url(monkeypatch, fake)

    await inputs.start()
    await _eventually(lambda: len(fake.mget_calls) >= 4)
    # Polls that find nothing new say nothing.
    assert published == ["controlReadback", "detectorStatus", "controlReadback"]
    assert _events(logged).count("redis.readback.seed") == 1

    # Changed with no event to say so.
    fake.store["AOS_READBACK"] = "TIE"
    await _eventually(lambda: controls.all("*") == {"AOS_READBACK": "TIE"})
    assert (
        "redis.readback.change",
        {"key": "AOS_READBACK", "value": "TIE", "via": "poll"},
    ) in logged
    assert published.count("controlReadback") == 3

    # Gone (deleted, expired, or flushed with everything else).
    fake.store.clear()
    await _eventually(lambda: controls.all("*") == {})
    assert ("redis.readback.gone", {"key": "AOS_READBACK"}) in logged
    assert published.count("controlReadback") == 4
    # Each poll is also proof that Redis still answers.
    before = inputs.link.read_at
    polls = len(fake.mget_calls)
    await _eventually(lambda: len(fake.mget_calls) > polls + 1)
    assert inputs.link.read_at is not None and before is not None
    assert inputs.link.read_at > before
    await inputs.stop()


async def test_keyspace_events_are_turned_back_on_when_redis_loses_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # CONFIG SET isn't saved, so a restarted Redis has them off again, and
    # redis-py may reconnect the subscription without the reader ever seeing
    # an error. Set once at startup, they stayed off: readbacks froze. They
    # are checked on connect and before each poll.
    _fast(monkeypatch, "_READBACK_POLL_SECONDS")
    logged = _record_log(monkeypatch)
    inputs = RedisInputs("redis://x", EventBus(), ControlStore(), DetectorStore(), [])
    fake = _LoopFakeRedis()
    _patch_from_url(monkeypatch, fake)

    await inputs.start()
    await _eventually(lambda: inputs.link.connected)
    assert fake.config_sets == ["K$"]
    assert ("redis.keyspace.enabled", {"was": ""}) in logged

    fake.notify = ""  # Redis restarted
    await _eventually(lambda: len(fake.config_sets) == 2)
    assert fake.notify == "K$"
    assert _events(logged).count("redis.keyspace.enabled") == 2
    await inputs.stop()


@pytest.mark.parametrize(
    ("held", "set_to"),
    [
        ("", "K$"),
        # What the server already holds is kept, and only what's missing
        # added.
        ("Ex", "ExK$"),
        ("AE", "AEK"),
        ("K", "K$"),
        ("xK", "xK$"),
        # Enough already (A covers every class of command): left alone.
        ("AKE", None),
        ("$K", None),
    ],
)
async def test_keyspace_events_add_only_the_missing_flags(
    held: str, set_to: str | None
) -> None:
    inputs = RedisInputs("redis://x", EventBus(), ControlStore(), DetectorStore(), [])
    fake = _LoopFakeRedis(notify=held)
    inputs._redis = fake  # type: ignore[assignment]
    await inputs._ensure_keyspace_events()
    assert fake.config_sets == ([] if set_to is None else [set_to])


async def test_a_redis_that_forbids_config_is_read_by_poll_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A managed Redis refusing CONFIG must not stop the reader: said once,
    # not at every poll.
    _fast(monkeypatch, "_READBACK_POLL_SECONDS")
    logged = _record_log(monkeypatch)
    controls = ControlStore()
    inputs = RedisInputs(
        "redis://x", EventBus(), controls, DetectorStore(), [], control_keys=["AOS"]
    )
    fake = _LoopFakeRedis(config_refused=True)
    fake.store["AOS_READBACK"] = "DANISH"
    _patch_from_url(monkeypatch, fake)

    await inputs.start()
    await _eventually(lambda: len(fake.mget_calls) >= 3)
    assert controls.all("*") == {"AOS_READBACK": "DANISH"}
    assert inputs.link.connected is True
    assert _events(logged).count("redis.config_set.failed") == 1
    assert fake.config_sets == []

    # Allowed again (and then refused again): it is said afresh.
    fake._config_refused = False
    await _eventually(lambda: fake.config_sets == ["K$"])
    fake._config_refused = True
    await _eventually(lambda: _events(logged).count("redis.config_set.failed") == 2)
    await inputs.stop()


@pytest.mark.parametrize(
    ("url", "logged"),
    [
        ("redis://:s3cret@redis.example:6379", "redis://:***@redis.example:6379"),
        (
            "redis://ra:s3cret@redis.example:6379/2",
            "redis://ra:***@redis.example:6379/2",
        ),
        ("redis://redis.example:6379", "redis://redis.example:6379"),
        ("redis://ra@redis.example:6379", "redis://ra@redis.example:6379"),
    ],
)
def test_redacted_masks_only_the_password(url: str, logged: str) -> None:
    assert redacted(url) == logged


async def test_connect_log_keeps_the_password_out(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The RA_REDIS_* URL carries the password; it was logged whole at every
    # startup.
    logged = _record_log(monkeypatch)
    inputs = RedisInputs(
        "redis://:s3cret@redis.example:6379",
        EventBus(),
        ControlStore(),
        DetectorStore(),
        [],
    )
    _patch_from_url(monkeypatch, _LoopFakeRedis())
    await inputs.start()
    await _eventually(lambda: inputs.link.connected)
    await inputs.stop()
    assert ("redis.connected", {"url": "redis://:***@redis.example:6379"}) in logged
    assert "s3cret" not in repr(logged)


async def test_readback_loop_reconnects_after_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A Redis blip must not permanently kill the reader: the supervisor
    # restarts it (after backoff) and it re-subscribes on a fresh pubsub, then
    # keeps delivering. Without the supervisor the first raise ended live
    # readback forever. We shrink the backoff so the test doesn't wait a real
    # second.
    _fast(monkeypatch, "_RECONNECT_BACKOFF_MIN")
    bus = EventBus()
    controls = ControlStore()
    inputs = RedisInputs("redis://x", bus, controls, DetectorStore(), [])

    # First pubsub's read raises (connection dropped); the second delivers.
    class _FlakyPubSub(_FakePubSub):
        def __init__(self, raise_first: bool) -> None:
            super().__init__(
                [{"type": "pmessage", "channel": "__keyspace@0__:AOS_READBACK"}]
            )
            self._raise = raise_first

        async def get_message(
            self, ignore_subscribe_messages: bool = False, timeout: float = 0.0
        ) -> dict[str, str] | None:
            if self._raise:
                raise ConnectionError("dropped")
            return await super().get_message(ignore_subscribe_messages, timeout)

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

    await inputs.start()
    # The change only arrives after the loop restarts on the second pubsub.
    await _eventually(lambda: controls.all("*") == {"AOS_READBACK": "danish"})
    assert len(made) == 2  # reconnected
    assert made[0].closed is True  # the broken pubsub was released
    assert inputs.link.connected is True

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
    await _eventually(lambda: inputs.link.connected)
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
    published = _published(bus)
    detectors = DetectorStore()
    inputs = RedisInputs("redis://x", bus, ControlStore(), detectors, [AOS])
    fake = _LoopFakeRedis(
        seed_entries={AOS_STREAM: [("1-1", _entry("idle", "4"))]},
        stream_batches=[[(AOS_STREAM, [("1-2", _entry("busy", "4"))])]],
    )
    _patch_from_url(monkeypatch, fake)

    await inputs.start()
    await _eventually(
        lambda: detectors.all() == {"aosSet0": {"workers": {"4": {"status": "busy"}}}}
    )
    await _eventually(lambda: len(fake.xread_ids) == 2)
    # The first XREAD resumed from the seed id, not "$"; the next from the
    # entry it brought.
    assert fake.xread_ids == [{AOS_STREAM: "1-1"}, {AOS_STREAM: "1-2"}]
    # The seed, the link coming up, and the live entry.
    assert published.count("detectorStatus") == 3

    await inputs.stop()


async def test_detector_loop_seeds_from_last_retained_entry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The producer only writes on change, so after a restart during a quiet
    # period the only data is each stream's retained last entry. We must seed
    # from XREVRANGE so the Cluster Status page isn't blank until the next
    # change. Here xread has no new batches (parks), proving the snapshot the
    # client sees came purely from the seed. The entry's own time comes with
    # it, so a picture retained from hours ago isn't shown as fresh.
    _clock(monkeypatch, time=1795521660.0)
    bus = EventBus()
    detectors = DetectorStore()
    inputs = RedisInputs("redis://x", bus, ControlStore(), detectors, [AOS])
    fake = _LoopFakeRedis(
        seed_entries={AOS_STREAM: [("1795521600000-0", _entry("busy", "4"))]},
    )
    _patch_from_url(monkeypatch, fake)

    await inputs.start()
    await _eventually(lambda: inputs.link.connected)
    assert detectors.all() == {"aosSet0": {"workers": {"4": {"status": "busy"}}}}
    assert detectors.ages() == {"aosSet0": 60.0}

    await inputs.stop()
    assert fake.closed is True


async def test_detector_loop_reads_an_empty_stream_from_its_start(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A stream that has never been written yields nothing from XREVRANGE; we
    # must not publish a spurious empty snapshot. The first change the client
    # sees comes from a later live entry instead, read from the stream's
    # start: "$" means "from now" afresh on every XREAD, so an entry written
    # between two of them was skipped, and the set stayed blank until it
    # next changed.
    bus = EventBus()
    published = _published(bus)
    detectors = DetectorStore()
    inputs = RedisInputs("redis://x", bus, ControlStore(), detectors, [SFM])
    fake = _LoopFakeRedis(
        stream_batches=[
            # A wait that ends with nothing to read, as most do.
            [],
            [(SFM_STREAM, [("2-1", _entry("free"))])],
        ],
    )
    _patch_from_url(monkeypatch, fake)

    await inputs.start()
    await _eventually(
        lambda: detectors.all() == {"sfmSet0": {"workers": {"189": {"status": "free"}}}}
    )
    assert fake.xread_ids[:2] == [{SFM_STREAM: "0-0"}, {SFM_STREAM: "0-0"}]
    # The link coming up and the live entry; the empty seed and the empty
    # wait published nothing.
    assert published.count("detectorStatus") == 2

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
    inputs = RedisInputs("redis://x", bus, ControlStore(), detectors, [AOS, SFM])
    fake = _LoopFakeRedis(
        seed_entries={AOS_STREAM: [("1-1", _entry("busy", "4"))]},
        stream_batches=[[(SFM_STREAM, [("2-1", _entry("free"))])]],
    )
    _patch_from_url(monkeypatch, fake)

    await inputs.start()
    await _eventually(lambda: len(detectors.all()) == 2)
    await inputs.stop()

    assert "redis.detector.seed_start" in events
    assert "redis.detector.seed_entry" in events
    assert "redis.detector.seed_empty" in events
    assert "redis.detector.apply" in events
    assert "redis.detector.seed_publish" in events
    assert "redis.detector.live_entry" in events
    assert "redis.detector.live_publish" in events


async def test_detector_seed_survives_an_unreadable_stream() -> None:
    # One stream that can't be read (a WRONGTYPE key after a producer bug)
    # must not stop the others seeding the Cluster Status page, nor fail the
    # XREAD they share, so it is left out of that; an XREAD that brings
    # nothing publishes nothing; and the reader returns cleanly once
    # stopped.
    bus = EventBus()
    published = _published(bus)
    detectors = DetectorStore()
    inputs = RedisInputs(
        "redis://x",
        bus,
        ControlStore(),
        detectors,
        [RedisDetector(key="BROKEN", name="broken"), SFM],
    )
    asked: list[dict[str, str]] = []

    class _Fake:
        async def xrevrange(
            self, stream_name: str, count: int = 1
        ) -> list[tuple[str, dict[str, str]]]:
            if stream_name == "stream:BROKEN":
                raise ResponseError("WRONGTYPE")
            return [("1-1", _entry("busy"))]

        async def xread(self, last_ids: dict[str, str], block: int = 0) -> list[object]:
            asked.append(dict(last_ids))
            inputs._stop.set()
            return []

    inputs._redis = _Fake()  # type: ignore[assignment]
    await asyncio.wait_for(
        inputs._supervise("detectors", inputs._detector_loop), timeout=5
    )
    assert detectors.all() == {"sfmSet0": {"workers": {"189": {"status": "busy"}}}}
    assert asked == [{SFM_STREAM: "1-1"}]
    # The seed, and the link coming up.
    assert published.count("detectorStatus") == 2


async def test_detector_reader_with_no_readable_stream_keeps_trying(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logged = _record_log(monkeypatch)
    inputs = RedisInputs(
        "redis://x", EventBus(), ControlStore(), DetectorStore(), [SFM]
    )
    tries = 0

    class _Fake:
        async def xrevrange(self, stream_name: str, count: int = 1) -> list[object]:
            nonlocal tries
            tries += 1
            if tries == 2:
                inputs._stop.set()
            raise ResponseError("WRONGTYPE")

    _fast(monkeypatch, "_RECONNECT_BACKOFF_MIN")
    inputs._redis = _Fake()  # type: ignore[assignment]
    await asyncio.wait_for(
        inputs._supervise("detectors", inputs._detector_loop), timeout=5
    )
    assert tries == 2
    assert inputs.link.connected is False
    # Said once: the second try failed during shutdown.
    assert _events(logged).count("redis.reader.error") == 1
    assert _events(logged).count("redis.detector.seed_failed") == 2


async def test_detector_seed_leaves_an_unreachable_redis_to_the_supervisor() -> None:
    # Caught per stream, a Redis that was down logged a warning for every
    # stream at every retry.
    inputs = RedisInputs(
        "redis://x", EventBus(), ControlStore(), DetectorStore(), [SFM]
    )
    fake = _LoopFakeRedis()
    fake.down = True
    inputs._redis = fake  # type: ignore[assignment]
    with pytest.raises(RedisConnectionError):
        await inputs._seed_detectors({SFM_STREAM: "sfmSet0"})


async def test_readback_reader_returns_cleanly_once_stopped() -> None:
    # A stop seen between two waits ends the loop without a restart, and
    # the subscription's connection is released.
    inputs = RedisInputs("redis://x", EventBus(), ControlStore(), DetectorStore(), [])

    class _StoppingPubSub(_FakePubSub):
        async def get_message(
            self, ignore_subscribe_messages: bool = False, timeout: float = 0.0
        ) -> dict[str, str] | None:
            inputs._stop.set()
            return None

    class _Fake(_LoopFakeRedis):
        def pubsub(self) -> _FakePubSub:
            self.pubsubs.append(_StoppingPubSub([]))
            return self.pubsubs[-1]

    fake = _Fake()
    inputs._redis = fake  # type: ignore[assignment]
    await asyncio.wait_for(
        inputs._supervise("readback", inputs._readback_loop), timeout=5
    )
    assert inputs.link.connected is True
    assert fake.pubsubs[0].closed is True


async def test_reader_failing_during_shutdown_is_not_restarted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # stop() closing the connection makes a blocked reader raise; that is
    # shutdown, not a failure to report or a blip to reconnect from.
    logged = _record_log(monkeypatch)
    bus = EventBus()
    published = _published(bus)
    inputs = RedisInputs("redis://x", bus, ControlStore(), DetectorStore(), [])
    runs = 0

    async def reader() -> None:
        nonlocal runs
        runs += 1
        inputs._stop.set()
        raise ConnectionError("connection closed")

    await asyncio.wait_for(inputs._supervise("readback", reader), timeout=5)
    assert runs == 1
    assert logged == []
    assert published == []


async def test_stop_during_the_reconnect_backoff_ends_the_reader(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A reader whose stream simply ends is restarted after a backoff; a stop
    # arriving during that backoff ends supervision without another run.
    logged = _record_log(monkeypatch)
    inputs = RedisInputs("redis://x", EventBus(), ControlStore(), DetectorStore(), [])
    runs = 0

    async def reader() -> None:
        nonlocal runs
        runs += 1
        # Lands once the supervisor is waiting out the backoff.
        asyncio.get_running_loop().call_soon(inputs._stop.set)

    await asyncio.wait_for(inputs._supervise("readback", reader), timeout=5)
    assert runs == 1
    assert _events(logged) == ["redis.reader.reconnect"]


@pytest.mark.parametrize(
    ("healthy_after", "waits"),
    [
        # Failing straight away each time: the wait doubles, up to the cap.
        (3600.0, [1.0, 2.0, 4.0, 4.0]),
        # Each run counted as a healthy one: every failure is a first one.
        (0.0, [1.0, 1.0, 1.0, 1.0]),
    ],
)
async def test_reconnect_backoff_doubles_unless_the_reader_had_been_healthy(
    monkeypatch: pytest.MonkeyPatch, healthy_after: float, waits: list[float]
) -> None:
    # The backoff used only ever to grow, so after a few blips over the
    # weeks every reconnect waited the full 30 s.
    module = "lsst.ts.rubintv.data.redis_inputs"
    monkeypatch.setattr(f"{module}._RECONNECT_BACKOFF_MAX", 4.0)
    monkeypatch.setattr(f"{module}._HEALTHY_SECONDS", healthy_after)
    logged = _record_log(monkeypatch)
    inputs = RedisInputs("redis://x", EventBus(), ControlStore(), DetectorStore(), [])
    asked: list[float] = []

    async def no_wait(awaitable: Any, timeout: float) -> None:
        asked.append(timeout)
        awaitable.close()
        raise TimeoutError

    monkeypatch.setattr(f"{module}.asyncio.wait_for", no_wait)
    runs = 0

    async def reader() -> None:
        nonlocal runs
        runs += 1
        if runs == 5:
            inputs._stop.set()
        raise RedisConnectionError("refused")

    await inputs._supervise("readback", reader)
    assert asked == waits
    assert [
        fields["backoff_seconds"]
        for event, fields in logged
        if event == "redis.reader.reconnect"
    ] == waits
