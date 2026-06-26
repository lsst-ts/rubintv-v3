"""Redis-sourced live inputs (detector status + control readback).

Redis is just another source feeding the same EventBus — the WS handler
doesn't know or care that a change came from Redis rather than S3. Redis is
*optional*: with no configured URL (or an unreachable server) these inputs
are disabled with a clear warning, but the rest of the app serves S3 data
normally (fixing the old silent degradation).

This wires the control readback into the shared ControlStore and publishes
detector/readback changes as StoreChanges. Full stream-key parsing matches
the deployment's ``redis_detectors`` config; here we provide the connection
lifecycle and the publish path.
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

from rubintv.data.controls import ControlStore, DetectorStore
from rubintv.data.events import StoreChange
from rubintv.logging import get_logger

if TYPE_CHECKING:
    from redis.asyncio import Redis

    from rubintv.config.models import RedisDetector
    from rubintv.data.bus import EventBus

log = get_logger(__name__)

# The cluster-status producer writes to streams named ``stream:{key}`` where
# ``key`` is the ``redis_detectors`` config key (e.g.
# ``stream:CLUSTER_STATUS_SFM_SET_0``). We subscribe with the prefix but index
# under the bare key the frontend config uses.
STREAM_PREFIX = "stream:"


class RedisUnavailable(RuntimeError):
    """Raised when a Redis write is attempted but no connection is up."""


def apply_detector_entry(
    detectors: DetectorStore,
    set_name: str,
    fields: dict[str, str],
) -> None:
    """Store one cluster-status stream entry as a structured set payload.

    The producer (see ``stream_writer_demo.py``) writes each entry as a single
    ``data`` field carrying a JSON blob of ``{key: {"status", "type"}}``::

        {"189": {"status": "busy", "type": "worker_status"},
         "190": {"status": "3",   "type": "worker_status"},   # queued
         "numWorkers": {"status": "8", "type": "worker_count"},
         "queueA": {"status": "12", "type": "text_status"}}   # other-queues

    We split that by ``type`` into the shape the Cluster Status page renders::

        {"workers": {"189": {"status": "busy"},
                     "190": {"status": "queued", "queue_length": 3}},
         "numWorkers": 8,
         "text": {"queueA": "12"}}

    Stored under ``set_name`` (the config ``name``, e.g. ``sfmSet0``). A flat
    ``{worker: status}`` fields dict (no ``data`` blob) is accepted as a
    fallback for simple producers and tests.
    """
    workers: dict[str, dict[str, object]] = {}
    raw = fields.get("data")
    if raw is None:
        # Fallback: fields are already a flat worker->status map.
        for w, s in fields.items():
            workers[str(w)] = {"status": str(s)}
        log.debug(
            "redis.detector.apply",
            set_name=set_name,
            shape="flat",
            workers=len(workers),
        )
        detectors.set(set_name, {"workers": workers})
        return

    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        log.warning("redis.detector.bad_payload", set_name=set_name)
        return

    text: dict[str, str] = {}
    num_workers: int | None = None
    for key, value in parsed.items():
        entry = value if isinstance(value, dict) else {"status": value}
        kind = entry.get("type", "worker_status")
        status = str(entry.get("status", ""))
        if key == "numWorkers" or kind == "worker_count":
            num_workers = _to_int(status)
        elif kind == "text_status":
            text[str(key)] = status
        else:
            workers[str(key)] = _worker_status(status)

    payload: dict[str, object] = {"workers": workers}
    if num_workers is not None:
        payload["numWorkers"] = num_workers
    if text:
        payload["text"] = text
    log.debug(
        "redis.detector.apply",
        set_name=set_name,
        shape="data",
        workers=len(workers),
        num_workers=num_workers,
        text_keys=list(text),
    )
    detectors.set(set_name, payload)


def _worker_status(status: str) -> dict[str, object]:
    """Normalise a worker status; a numeric value means a queue length."""
    if status.isdigit():
        return {"status": "queued", "queue_length": int(status)}
    return {"status": status}


def _to_int(value: str) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


class RedisInputs:
    """Manages the optional Redis connection and its background readers."""

    def __init__(
        self,
        redis_url: str | None,
        bus: EventBus,
        controls: ControlStore,
        detectors: DetectorStore,
        detector_streams: list[RedisDetector],
    ) -> None:
        self._url = redis_url
        self._bus = bus
        self._controls = controls
        self._detectors = detectors
        self._detector_streams = detector_streams
        self._redis: Redis | None = None
        self._tasks: list[asyncio.Task[None]] = []

    @property
    def enabled(self) -> bool:
        return self._redis is not None

    async def set_value(self, key: str, value: str) -> None:
        """Write a control value as a plain Redis string key.

        Admin actions (menu sends, witness-detector value, reset-head-node,
        arbitrary key/value) all reduce to a ``SET``. Raises
        ``RedisUnavailable`` if no Redis connection is up, so the endpoint can
        report 503 rather than silently dropping a control write.
        """
        if self._redis is None:
            raise RedisUnavailable("redis is not configured")
        await self._redis.set(key, value)
        log.info("redis.set", key=key)

    async def flushdb(self) -> None:
        """Flush the entire Redis database (danger-zone admin action)."""
        if self._redis is None:
            raise RedisUnavailable("redis is not configured")
        await self._redis.flushdb()
        log.warning("redis.flushdb")

    async def start(self) -> None:
        """Connect and launch readers. No-op (warns) if disabled/unreachable."""
        if not self._url:
            log.warning("redis.disabled", reason="no RUBINTV_REDIS_URL configured")
            return
        try:
            from redis.asyncio import Redis

            self._redis = Redis.from_url(self._url, decode_responses=True)
            await self._redis.ping()
        except Exception as exc:  # noqa: BLE001 - degrade, don't crash
            log.warning("redis.unavailable", error=str(exc))
            self._redis = None
            return
        log.info("redis.connected", url=self._url)
        # Enable keyspace notifications so the readback loop receives key-change
        # events (matches the original app's startup). Best-effort: a managed
        # Redis may forbid CONFIG SET, in which case live readback degrades but
        # the rest still works.
        try:
            await self._redis.config_set("notify-keyspace-events", "KEA")
        except Exception as exc:  # noqa: BLE001 - non-fatal
            log.warning("redis.config_set.failed", error=str(exc))
        self._tasks.append(
            asyncio.create_task(self._readback_loop(), name="redis-readback")
        )
        if self._detector_streams:
            self._tasks.append(
                asyncio.create_task(self._detector_loop(), name="redis-detectors")
            )

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        if self._redis is not None:
            await self._redis.aclose()

    async def _readback_loop(self) -> None:
        """Subscribe to keyspace events for *_READBACK keys and republish.

        Keyspace notifications must be enabled on the server
        (``notify-keyspace-events KEA`` or similar). When a readback key
        changes, fetch its value, update the ControlStore, and publish a
        controlReadback StoreChange.
        """
        assert self._redis is not None
        pubsub = self._redis.pubsub()
        # Pattern covers keyspace notifications for any *_READBACK key.
        await pubsub.psubscribe("__keyspace@0__:*_READBACK")
        async for message in pubsub.listen():
            if message.get("type") != "pmessage":
                continue
            channel = str(message["channel"])
            key = channel.split(":", 1)[-1]
            value = await self._redis.get(key)
            if value is None:
                continue
            # Location is encoded in deployment config; readback is global to
            # the site here, so publish without a camera scope.
            self._controls.set("*", key, str(value))
            self._bus.publish(StoreChange("controlReadback", "*", ""))

    async def _seed_detectors(self, name_for_stream: dict[str, str]) -> None:
        """Prime the store from each stream's latest retained entry on startup.

        Covers the gap between this app starting and the producer's next change
        emit: without this, a restart during a quiet period leaves the Cluster
        Status page blank. ``XREVRANGE COUNT 1`` returns the newest entry (or
        nothing for a stream that has never been written). Best-effort per
        stream; one missing stream must not stop the others, and we publish a
        single ``detectorStatus`` change only if anything was actually seeded.
        """
        assert self._redis is not None
        # Set log_level=DEBUG to trace the cluster-status data flow end to end
        # (seed reads, live entries, store applies, publishes).
        log.debug("redis.detector.seed_start", streams=list(name_for_stream))
        seeded = False
        for stream_name, set_name in name_for_stream.items():
            try:
                entries = await self._redis.xrevrange(stream_name, count=1)
            except Exception as exc:  # noqa: BLE001 - degrade, don't crash startup
                log.warning(
                    "redis.detector.seed_failed",
                    stream=stream_name,
                    error=str(exc),
                )
                continue
            if not entries:
                log.debug("redis.detector.seed_empty", stream=stream_name)
                continue
            entry_id, fields = entries[0]
            log.debug(
                "redis.detector.seed_entry",
                stream=stream_name,
                set=set_name,
                entry_id=entry_id,
            )
            apply_detector_entry(self._detectors, set_name, fields)
            seeded = True
        if seeded:
            log.debug("redis.detector.seed_publish", sets=list(self._detectors.all()))
            self._bus.publish(StoreChange("detectorStatus", "*", ""))
        else:
            log.debug("redis.detector.seed_nothing")

    async def _detector_loop(self) -> None:
        """Tail the configured cluster-status streams and republish updates.

        Each ``redis_detectors`` entry names a cluster set. The producer writes
        to a stream named ``stream:{key}`` (see ``stream_writer_demo.py``), so
        we subscribe to the prefixed names but store under the bare config key
        the frontend looks up. We block on ``XREAD`` across all of them; every
        new entry is a fresh snapshot of that set's ``{worker: status}`` map. On
        any change we store the latest map and publish a single
        ``detectorStatus`` StoreChange so the WS handler re-pushes the site-wide
        snapshot.

        Because the producer only writes a stream on *change* (its 0.5s loop is
        change-gated), tailing from ``"$"`` alone would leave the page blank
        after a restart during a quiet period — until the next cluster change.
        The producer keeps ``maxlen=2`` precisely so the last snapshot is always
        retrievable, so we first seed from each stream's most recent entry.
        """
        assert self._redis is not None
        # stream name (stream:KEY) -> set name, so payloads are stored under the
        # config ``name`` (sfmSet0, otherQueues, ...) the frontend renders by.
        name_for_stream = {
            f"{STREAM_PREFIX}{d.key}": d.name for d in self._detector_streams
        }
        await self._seed_detectors(name_for_stream)
        # Start from new entries only ("$"); we don't replay history.
        last_ids = dict.fromkeys(name_for_stream, "$")
        while True:
            # The redis-py stub types the streams map narrowly; our str->str
            # last-id map is correct at runtime.
            streams = await self._redis.xread(last_ids, block=0)  # type: ignore[arg-type]
            changed = False
            for stream_name, entries in streams:
                for entry_id, fields in entries:
                    last_ids[stream_name] = entry_id
                    set_name = name_for_stream.get(stream_name, stream_name)
                    log.debug(
                        "redis.detector.live_entry",
                        stream=stream_name,
                        set=set_name,
                        entry_id=entry_id,
                    )
                    apply_detector_entry(self._detectors, set_name, fields)
                    changed = True
            if changed:
                log.debug(
                    "redis.detector.live_publish",
                    sets=list(self._detectors.all()),
                )
                self._bus.publish(StoreChange("detectorStatus", "*", ""))
