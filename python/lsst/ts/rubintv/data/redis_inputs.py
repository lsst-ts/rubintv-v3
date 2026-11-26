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

"""Redis-sourced live inputs (detector status + control readback).

Redis is just another source feeding the same EventBus — the WS handler
doesn't know or care that a change came from Redis rather than S3. Redis is
*optional*: with no configured URL these inputs are disabled with a clear
warning, and with a server that can't be reached they keep trying to
connect, while the rest of the app serves S3 data normally (fixing the old
silent degradation).

This wires the control readback into the shared ControlStore and publishes
detector/readback changes as StoreChanges. Full stream-key parsing matches
the deployment's ``redis_detectors`` config; here we provide the connection
lifecycle and the publish path.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import TYPE_CHECKING, cast
from urllib.parse import urlsplit, urlunsplit

from lsst.ts.rubintv.data.controls import ControlStore, DetectorStore, RedisLink
from lsst.ts.rubintv.data.events import StoreChange
from lsst.ts.rubintv.logging import get_logger
from redis.exceptions import RedisError, ResponseError

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from lsst.ts.rubintv.config.models import RedisDetector
    from lsst.ts.rubintv.data.bus import EventBus
    from redis.asyncio import Redis

log = get_logger(__name__)


def redacted(url: str) -> str:
    """The Redis URL with any password masked, for logs.

    The URL built from ``RA_REDIS_*`` carries the password
    (``redis://:<password>@host:port``); logging it whole put the password
    in every pod's startup log.
    """
    parts = urlsplit(url)
    if parts.password is None:
        return url
    host = parts.netloc.rsplit("@", 1)[1]
    return urlunsplit(parts._replace(netloc=f"{parts.username or ''}:***@{host}"))


# The cluster-status producer writes to streams named ``stream:{key}`` where
# ``key`` is the ``redis_detectors`` config key (e.g.
# ``stream:CLUSTER_STATUS_SFM_SET_0``). We subscribe with the prefix but index
# under the bare key the frontend config uses.
STREAM_PREFIX = "stream:"

# How often a reader that can't read Redis tries again (seconds): after _MIN,
# doubling up to _MAX, for as long as the app runs. A try costs one refused
# or timed-out connect, so the cap is set by how long a recovered Redis may
# go unnoticed, not by load: the first tries (1, 2, 4, 8, 16 s) catch a Redis
# that starts moments after the app, and one that is down for hours is asked
# twice a minute.
_RECONNECT_BACKOFF_MIN = 1.0
_RECONNECT_BACKOFF_MAX = 30.0

# A reader that read for this long before failing starts again from _MIN; one
# that fails sooner keeps doubling, so a server that accepts connections and
# drops them isn't hammered.
_HEALTHY_SECONDS = 30.0

# Bound the connect so a firewalled/DROP-ing Redis URL fails fast instead of
# hanging on the kernel TCP timeout.
_CONNECT_TIMEOUT = 5.0

# How long the detector reader waits on its streams before asking again. The
# producer writes only on change, so most waits end empty; each one that
# ends at all shows that Redis is still answering.
_XREAD_BLOCK_MS = 5000

# A reply this late means the connection is dead: a server that vanished
# without closing it would otherwise leave a reader waiting for ever, with
# nothing logged. Longer than the XREAD wait above, which it also bounds.
_SOCKET_TIMEOUT = 15.0

# How often the configured readbacks are read outright, whatever the keyspace
# events say: those are lost when Redis restarts (the setting isn't saved),
# say nothing of a deleted key, and stop without a sound if their connection
# goes quiet. The poll bounds how wrong the Admin page can be to this.
_READBACK_POLL_SECONDS = 10.0

# The server setting keyspace events hang on, and the least it must hold:
# keyspace channels (K) for string commands ($, or A for every class).
_NOTIFY = "notify-keyspace-events"

# Stream entry ids are ``<ms since the epoch>-<n>``. A smaller first part
# (before 2001) is a hand-written counter, not a time.
_EARLIEST_ENTRY_SECONDS = 1_000_000_000


class RedisUnavailable(RuntimeError):
    """Raised when a Redis write can't be made: no Redis is configured, or
    it didn't take the write."""


def entry_time(entry_id: str | None) -> float | None:
    """When a stream entry was written (epoch seconds), from its id."""
    ms = (entry_id or "").partition("-")[0]
    if not ms.isdigit():
        return None
    seconds = int(ms) / 1000
    return seconds if seconds >= _EARLIEST_ENTRY_SECONDS else None


def apply_detector_entry(
    detectors: DetectorStore,
    set_name: str,
    fields: dict[str, str],
    entry_id: str | None = None,
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

    Stored under ``set_name`` (the config ``name``, e.g. ``sfmSet0``), with
    the time the entry was written (from ``entry_id``). A flat
    ``{worker: status}`` fields dict (no ``data`` blob) is accepted as a
    fallback for simple producers and tests.
    """
    written_at = entry_time(entry_id)
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
        detectors.set(set_name, {"workers": workers}, written_at)
        return

    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        parsed = None
    # Valid JSON that isn't an object (``null``, a list) is as unusable as
    # text that isn't JSON; left to raise, it stopped the reader each time
    # it was read again.
    if not isinstance(parsed, dict):
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
    detectors.set(set_name, payload, written_at)


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


# The analysis side acknowledges a control key ``K`` by writing ``K_READBACK``.
READBACK_SUFFIX = "_READBACK"


class RedisInputs:
    """Manages the optional Redis connection and its background readers.

    ``control_keys`` are the control keys whose readbacks are read straight
    from Redis, on each (re)connect and every few seconds after, so the
    Admin page shows current values without waiting for the next change
    (keyspace events only carry changes, and can be lost).

    ``link`` is where the readers record whether Redis is answering; the
    pages that show what Redis said read it from there.
    """

    def __init__(
        self,
        redis_url: str | None,
        bus: EventBus,
        controls: ControlStore,
        detectors: DetectorStore,
        detector_streams: list[RedisDetector],
        control_keys: list[str] | None = None,
        link: RedisLink | None = None,
    ) -> None:
        self._url = redis_url
        self._bus = bus
        self._controls = controls
        self._detectors = detectors
        self._detector_streams = detector_streams
        self._readback_keys = [k + READBACK_SUFFIX for k in control_keys or []]
        self.link = link if link is not None else RedisLink()
        self._redis: Redis | None = None
        self._tasks: list[asyncio.Task[None]] = []
        self._stop = asyncio.Event()
        # The readers launched, and those whose last exchange with Redis
        # succeeded: Redis counts as connected while they are the same.
        self._readers: set[str] = set()
        self._reading: set[str] = set()
        # The kind of error each failing reader last failed with, so a long
        # outage is logged once rather than at every retry.
        self._failing: dict[str, str] = {}
        self._keyspace_refused = False

    @property
    def enabled(self) -> bool:
        """Whether a Redis is configured. It may not be answering: see
        ``link.connected``."""
        return self._redis is not None

    async def set_value(self, key: str, value: str) -> None:
        """Write a control value as a plain Redis string key.

        Admin actions (menu sends, witness-detector value, reset-head-node,
        arbitrary key/value) all reduce to a ``SET``. Raises
        ``RedisUnavailable`` if no Redis is configured or the write fails,
        so the endpoint can report 503 rather than silently dropping a
        control write.
        """
        if self._redis is None:
            raise RedisUnavailable("redis is not configured")
        try:
            await self._redis.set(key, value)
        except (RedisError, OSError) as exc:
            raise RedisUnavailable(f"redis write failed: {exc}") from exc
        log.info("redis.set", key=key)

    async def flushdb(self) -> None:
        """Flush the entire Redis database (danger-zone admin action)."""
        if self._redis is None:
            raise RedisUnavailable("redis is not configured")
        try:
            await self._redis.flushdb()
        except (RedisError, OSError) as exc:
            raise RedisUnavailable(f"redis flush failed: {exc}") from exc
        log.warning("redis.flushdb")

    async def start(self) -> None:
        """Launch the readers. No-op (warns) if no Redis is configured.

        Nothing is sent to Redis here: the readers connect in the
        background and keep trying for as long as the app runs, so a Redis
        that is down when the app starts (or comes up a few seconds after
        it) is picked up when it answers, and a URL that never answers
        can't hold up the lifespan — uvicorn won't accept traffic until
        that returns.
        """
        if not self._url:
            log.warning(
                "redis.disabled",
                reason="no RUBINTV_REDIS_URL or RA_REDIS_HOST configured",
            )
            return
        from redis.asyncio import Redis

        try:
            # socket_timeout bounds every reply, the blocking XREAD's
            # included (see _SOCKET_TIMEOUT); the health check pings a
            # connection that has sat idle, which is how a dropped pubsub
            # connection is found out.
            self._redis = Redis.from_url(
                self._url,
                decode_responses=True,
                socket_connect_timeout=_CONNECT_TIMEOUT,
                socket_timeout=_SOCKET_TIMEOUT,
                socket_keepalive=True,
                health_check_interval=_READBACK_POLL_SECONDS,
            )
        except ValueError as exc:
            # No retry will mend a URL that can't be parsed. The error's
            # text isn't logged: it may quote the URL, password and all.
            log.warning(
                "redis.disabled",
                reason="the configured Redis URL is not usable",
                error=type(exc).__name__,
            )
            return
        self.link.configured = True
        self.link.changed_at = time.monotonic()
        readers = {"readback": self._readback_loop}
        if self._detector_streams:
            readers["detectors"] = self._detector_loop
        self._readers = set(readers)
        for name, loop in readers.items():
            self._tasks.append(
                asyncio.create_task(self._supervise(name, loop), name=f"redis-{name}")
            )

    async def stop(self) -> None:
        self._stop.set()
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        if self._redis is not None:
            await self._redis.aclose()

    async def _supervise(self, name: str, loop: Callable[[], Awaitable[None]]) -> None:
        """Run a reader loop, restarting it after any error with backoff.

        A reader connects by its first command, so this is also what
        retries a Redis that was down at startup. A Redis restart or
        network blip raises out of a running loop. Without this, the task
        would die once and the Cluster Status / control readback views
        would freeze on stale data forever with nothing logged. Here each
        failure is recorded (see ``_lost``) and the loop is restarted after
        a bounded backoff, mirroring the S3 poll loops' per-cycle
        resilience. Exits cleanly only when ``stop()`` sets the stop event
        (or the task is cancelled).
        """
        backoff = _RECONNECT_BACKOFF_MIN
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                await loop()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - a dead reader must self-heal
                if self._stop.is_set():
                    # stop() closing the connection under a waiting reader:
                    # shutdown, not a failure.
                    return
                self._lost(name, exc)
            if self._stop.is_set():
                return
            if time.monotonic() - started >= _HEALTHY_SECONDS:
                backoff = _RECONNECT_BACKOFF_MIN
            log.debug("redis.reader.reconnect", reader=name, backoff_seconds=backoff)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=backoff)
            except TimeoutError:
                pass
            backoff = min(backoff * 2, _RECONNECT_BACKOFF_MAX)

    def _read(self, name: str) -> None:
        """Record that Redis just answered reader ``name``."""
        self.link.read_at = time.monotonic()
        if name in self._reading:
            return
        self._reading.add(name)
        self._failing.pop(name, None)
        self._set_connected(self._reading >= self._readers)

    def _lost(self, name: str, exc: Exception) -> None:
        """Record that reader ``name`` failed, logging it once per kind of
        failure: the retries of a long outage go on at debug."""
        kind = type(exc).__name__
        if self._failing.get(name) != kind:
            if isinstance(exc, ResponseError) or not isinstance(
                exc, RedisError | OSError
            ):
                # Not the connection: a reply the reader can't use, or a
                # fault of its own.
                log.error("redis.reader.error", reader=name, exc_info=exc)
            else:
                log.warning("redis.unavailable", reader=name, error=str(exc))
        self._failing[name] = kind
        self._reading.discard(name)
        self._set_connected(False)

    def _set_connected(self, connected: bool) -> None:
        if self.link.connected == connected:
            return
        self.link.connected = connected
        self.link.changed_at = time.monotonic()
        if connected:
            log.info("redis.connected", url=redacted(self._url or ""))
        # Both pages show whether what they hold is still being read.
        self._bus.publish(StoreChange("detectorStatus", "*", ""))
        self._bus.publish(StoreChange("controlReadback", "*", ""))

    def _keyspace_pattern(self) -> str:
        """Keyspace-notification pattern for the configured Redis DB.

        Keyspace events are published on ``__keyspace@{db}__:*``; hardcoding DB
        0 silently drops every readback when ``RUBINTV_REDIS_URL`` selects
        another DB (e.g. ``redis://host/1``). Derive the DB from the live
        connection instead.
        """
        assert self._redis is not None
        db = self._redis.connection_pool.connection_kwargs.get("db", 0)
        return f"__keyspace@{db}__:*{READBACK_SUFFIX}"

    async def _ensure_keyspace_events(self) -> None:
        """Turn keyspace notifications on if they are off.

        The readback events need them, and neither Redis chart sets them, so
        the app does; a ``CONFIG SET`` isn't saved, so they are off again
        whenever Redis restarts. Hence this runs on every (re)connect and
        before every poll, not once at startup: redis-py can reconnect a
        subscription by itself, so a restart needn't show as an error here.
        Only what is missing is added, leaving any other flags the server
        holds. Best-effort: a managed Redis may forbid ``CONFIG``, in which
        case changes are picked up by the poll alone.
        """
        assert self._redis is not None
        try:
            # redis-py types these as ResponseT (Awaitable | value) for the
            # shared sync/async signature; on the asyncio client they are
            # always awaitable, so cast to satisfy the checker.
            config = await cast(
                "Awaitable[dict[str, str]]", self._redis.config_get(_NOTIFY)
            )
            flags = str(config.get(_NOTIFY) or "")
            missing = "" if "K" in flags else "K"
            if "$" not in flags and "A" not in flags:
                missing += "$"
            if missing:
                await cast(
                    "Awaitable[bool]", self._redis.config_set(_NOTIFY, flags + missing)
                )
                log.info("redis.keyspace.enabled", was=flags)
        except ResponseError as exc:
            if not self._keyspace_refused:
                log.warning("redis.config_set.failed", error=str(exc))
            self._keyspace_refused = True
            return
        self._keyspace_refused = False

    async def _read_readbacks(self, *, seed: bool) -> None:
        """Read the configured controls' current readbacks into the store.

        Keyspace events only carry changes, so without the read on connect
        (``seed``) a control that hasn't changed since the pod started (or
        since a reconnect) shows no value. That one runs after subscribing,
        so a change landing in between is still delivered as an event. The
        later reads are the poll: they find a change whose event was lost,
        and a readback that has gone (deleted, expired, or flushed with the
        rest of the database), which is dropped rather than shown as
        current.
        """
        assert self._redis is not None
        if not self._readback_keys:
            return
        values = await self._redis.mget(self._readback_keys)
        held = self._controls.all("*")
        found: dict[str, str] = {}
        changed = False
        for key, raw in zip(self._readback_keys, values, strict=True):
            if raw is None:
                if key in held:
                    self._forget_readback(key)
                    changed = True
                continue
            value = found[key] = str(raw)
            if held.get(key) == value:
                continue
            if not seed:
                log.info("redis.readback.change", key=key, value=value, via="poll")
            self._controls.set("*", key, value)
            changed = True
        if seed:
            log.info(
                "redis.readback.seed",
                found=len(found),
                keys=len(values),
                readbacks=found,
            )
        if changed:
            self._bus.publish(StoreChange("controlReadback", "*", ""))

    def _forget_readback(self, key: str) -> None:
        log.info("redis.readback.gone", key=key)
        self._controls.discard("*", key)

    async def _readback_event(self, channel: str) -> None:
        """Apply one keyspace event: fetch the key it names and republish."""
        assert self._redis is not None
        key = channel.split(":", 1)[-1]
        raw = await self._redis.get(key)
        if raw is None:
            if key not in self._controls.all("*"):
                return
            self._forget_readback(key)
        else:
            # Location is encoded in deployment config; readback is global
            # to the site here, so publish without a camera scope.
            # Rare (one per acknowledged control change), and the only
            # record of whether the analysis side answered a send.
            log.info("redis.readback.change", key=key, value=str(raw), via="event")
            self._controls.set("*", key, str(raw))
        self._bus.publish(StoreChange("controlReadback", "*", ""))

    async def _readback_loop(self) -> None:
        """Keep the ControlStore's readbacks in step with Redis.

        Two ways, both republished as a controlReadback StoreChange: keyspace
        events for ``*_READBACK`` keys, which answer a send at once, and a
        read of the configured keys every ``_READBACK_POLL_SECONDS``, which
        doesn't depend on the events arriving (see ``_read_readbacks``) and
        shows that Redis is still answering.
        """
        assert self._redis is not None
        await self._ensure_keyspace_events()
        pubsub = self._redis.pubsub()
        try:
            # Pattern covers keyspace notifications for any *_READBACK key on
            # the connection's DB (not just DB 0).
            await pubsub.psubscribe(self._keyspace_pattern())
            await self._read_readbacks(seed=True)
            self._read("readback")
            clock = asyncio.get_running_loop().time
            next_poll = clock() + _READBACK_POLL_SECONDS
            while not self._stop.is_set():
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=max(0.0, next_poll - clock()),
                )
                if message is not None and message.get("type") == "pmessage":
                    await self._readback_event(str(message["channel"]))
                if clock() >= next_poll:
                    await self._ensure_keyspace_events()
                    await self._read_readbacks(seed=False)
                    self._read("readback")
                    next_poll = clock() + _READBACK_POLL_SECONDS
        finally:
            # Release the pubsub connection so a supervised restart
            # re-subscribes on a fresh one rather than leaking the old
            # (possibly broken) one. redis-py's PubSub.aclose is untyped.
            await pubsub.aclose()  # type: ignore[no-untyped-call]

    async def _seed_detectors(self, name_for_stream: dict[str, str]) -> dict[str, str]:
        """Prime the store from each stream's latest retained entry on startup.

        Covers the gap between this app starting and the producer's next change
        emit: without this, a restart during a quiet period leaves the Cluster
        Status page blank. ``XREVRANGE COUNT 1`` returns the newest entry (or
        nothing for a stream that has never been written). One stream that
        can't be read (a key of the wrong type) must not stop the others, and
        we publish a single ``detectorStatus`` change only if anything was
        actually seeded. A Redis that doesn't answer at all is not caught
        here: that is the supervisor's to retry.

        Returns where the live ``XREAD`` resumes each readable stream: from
        the entry just seeded, or from the start (``0-0``) for one that was
        empty. Either way an entry written between the seed and the first
        XREAD is not skipped. (``"$"`` would skip it, and is re-read as
        "now" on every XREAD call, so it would go on dropping whatever was
        written to a still-empty stream between one call and the next.)
        """
        assert self._redis is not None
        # Set log_level=DEBUG to trace the cluster-status data flow end to end
        # (seed reads, live entries, store applies, publishes).
        log.debug("redis.detector.seed_start", streams=list(name_for_stream))
        seeded = False
        resume_ids: dict[str, str] = {}
        for stream_name, set_name in name_for_stream.items():
            try:
                entries = await self._redis.xrevrange(stream_name, count=1)
            except ResponseError as exc:
                log.warning(
                    "redis.detector.seed_failed",
                    stream=stream_name,
                    error=str(exc),
                )
                continue
            if not entries:
                log.debug("redis.detector.seed_empty", stream=stream_name)
                resume_ids[stream_name] = "0-0"
                continue
            entry_id, fields = entries[0]
            resume_ids[stream_name] = entry_id
            log.debug(
                "redis.detector.seed_entry",
                stream=stream_name,
                set=set_name,
                entry_id=entry_id,
            )
            apply_detector_entry(self._detectors, set_name, fields, entry_id)
            seeded = True
        if seeded:
            log.debug("redis.detector.seed_publish", sets=list(self._detectors.all()))
            self._bus.publish(StoreChange("detectorStatus", "*", ""))
        else:
            log.debug("redis.detector.seed_nothing")
        return resume_ids

    async def _detector_loop(self) -> None:
        """Tail the configured cluster-status streams and republish updates.

        Each ``redis_detectors`` entry names a cluster set. The producer writes
        to a stream named ``stream:{key}`` (see ``stream_writer_demo.py``), so
        we subscribe to the prefixed names but store under the bare config key
        the frontend looks up. We wait on ``XREAD`` across all of them; every
        new entry is a fresh snapshot of that set's ``{worker: status}`` map.
        On any change we store the latest map and publish a single
        ``detectorStatus`` StoreChange so the WS handler re-pushes the
        site-wide snapshot.

        Because the producer only writes a stream on *change* (its 0.5s
        loop is change-gated), tailing new entries alone would leave the
        page blank after a restart during a quiet period — until the next
        cluster change. The producer keeps ``maxlen=2`` precisely so the
        last snapshot is always retrievable, so we first seed from each
        stream's most recent entry.

        For the same reason most waits end with nothing to read. They are
        kept short (``_XREAD_BLOCK_MS``) so that each one ending records
        that Redis is still there.
        """
        assert self._redis is not None
        # stream name (stream:KEY) -> set name, so payloads are stored under
        # the config ``name`` (sfmSet0, otherQueues, ...) the frontend
        # renders by.
        name_for_stream = {
            f"{STREAM_PREFIX}{d.key}": d.name for d in self._detector_streams
        }
        # A stream the seed couldn't read is left out: one bad key in an
        # XREAD fails the whole call. It is tried again on the next connect.
        last_ids = await self._seed_detectors(name_for_stream)
        if not last_ids:
            raise RedisUnavailable("none of the detector streams can be read")
        self._read("detectors")
        while not self._stop.is_set():
            # The redis-py stub types the streams map narrowly; our str->str
            # last-id map is correct at runtime.
            streams = await self._redis.xread(last_ids, block=_XREAD_BLOCK_MS)  # type: ignore[arg-type]
            self._read("detectors")
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
                    apply_detector_entry(self._detectors, set_name, fields, entry_id)
                    changed = True
            if changed:
                log.debug(
                    "redis.detector.live_publish",
                    sets=list(self._detectors.all()),
                )
                self._bus.publish(StoreChange("detectorStatus", "*", ""))
