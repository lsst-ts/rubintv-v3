"""Metadata.json fetching with an LRU cache and per-key dedupe.

metadata.json is a dict keyed by seq_num (string) -> {column: value}. It is
fetched on demand (not held in the structured index), cached per
(location, camera, date), re-downloaded only when its ETag changes, and
concurrent fetches of the same key are deduped by a per-key lock.
"""

from __future__ import annotations

import asyncio
import json
import threading
from collections import OrderedDict
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from typing import TYPE_CHECKING

import ijson  # type: ignore[import-untyped]  # ijson ships no stubs
from lsst.ts.rubintv.logging import get_logger

if TYPE_CHECKING:
    from lsst.ts.rubintv.s3.client import S3ClientPool

log = get_logger(__name__)

# Metadata dict: seq_num (as string) -> {column name -> value}.
Metadata = dict[str, dict[str, object]]

# Global LRU cap: at most this many (location, camera, date) metadata dicts
# are held process-wide at once — NOT per camera. This bounds the resident
# footprint to a constant regardless of camera count (the old app cached ~60
# days for every camera, which spiked memory); demand-driven eviction keeps
# only the most recently viewed dates.
_MAX_ENTRIES = 60

# Rows per streamed batch. The S3 body trickles in on slow links (USDF dev
# measured ~80 KB/s), so emitting every N parsed rows lets the table fill
# progressively instead of after the whole transfer.
_STREAM_BATCH_ROWS = 100

# Ceiling on concurrent stream download workers. Each stream holds one
# default-executor thread for its whole transfer (minutes on a slow link),
# and that executor is shared with the live pollers' scan calls — unbounded
# per-subscribe workers could occupy every thread and starve the 1s poll
# loop (the same hazard _ON_DEMAND_MAX_CONCURRENCY guards in the engine).
_STREAM_MAX_CONCURRENCY = 4


@dataclass(slots=True)
class MetadataBatch:
    """One increment of a streamed metadata fetch.

    ``rows`` is a slice of the metadata dict (empty on the final marker).
    ``done`` is True only on the terminal event, which also carries the
    final ``etag``.
    """

    rows: Metadata
    done: bool
    etag: str | None = None


@dataclass(slots=True)
class _Entry:
    etag: str | None
    data: Metadata


class MetadataCache:
    """LRU cache of metadata.json contents, fetched from S3 on demand."""

    def __init__(self, pool: S3ClientPool, buckets: dict[str, str]) -> None:
        self._pool = pool
        self._buckets = buckets
        self._entries: OrderedDict[tuple[str, str, str], _Entry] = OrderedDict()
        self._locks: dict[tuple[str, str, str], asyncio.Lock] = {}
        self._stream_sem = asyncio.Semaphore(_STREAM_MAX_CONCURRENCY)

    async def get(self, location: str, camera: str, date: str) -> Metadata:
        """Return metadata for a date, fetching/refreshing if needed."""
        _, data = await self.get_with_etag(location, camera, date)
        return data

    async def get_with_etag(
        self, location: str, camera: str, date: str
    ) -> tuple[str | None, Metadata]:
        """Return ``(etag, metadata)``; etag is the S3 ETag or ``None``."""
        cache_key = (location, camera, date)
        lock = self._locks.setdefault(cache_key, asyncio.Lock())
        async with lock:
            result = await asyncio.to_thread(self._fetch, location, camera, date)
        # Drop the lock once nobody is waiting, to bound the lock dict.
        # Another coroutine in the same race may have already popped it.
        existing = self._locks.get(cache_key)
        if existing is not None and not existing.locked():
            self._locks.pop(cache_key, None)
        return result

    async def stream(
        self, location: str, camera: str, date: str
    ) -> AsyncIterator[MetadataBatch]:
        """Yield metadata in batches as it is parsed off the S3 stream.

        On a cache hit (ETag unchanged) the cached dict is emitted in
        batches without re-downloading. Otherwise the body is parsed
        incrementally with ijson so the first rows are available long before
        the whole (slow) transfer finishes, and the assembled dict is stored
        in the cache so the REST path and later streams are fast.

        Deduped per key by the same lock as :meth:`get_with_etag`. Download
        concurrency is capped process-wide (``_STREAM_MAX_CONCURRENCY``) so a
        crowd of subscribers can't occupy every executor thread and starve
        the pollers. Cancellation (client unsubscribed/disconnected) sets the
        abort flag so the worker thread exits at its next batch boundary
        instead of running the whole transfer to completion.
        """
        cache_key = (location, camera, date)
        lock = self._locks.setdefault(cache_key, asyncio.Lock())
        async with lock, self._stream_sem:
            loop = asyncio.get_running_loop()
            queue: asyncio.Queue[MetadataBatch | Exception] = asyncio.Queue()
            abort = threading.Event()

            def produce() -> None:
                # Runs on a worker thread; hand each batch back to the loop.
                try:
                    for batch in self._stream_blocking(location, camera, date, abort):
                        loop.call_soon_threadsafe(queue.put_nowait, batch)
                except Exception as exc:  # noqa: BLE001 - surfaced to consumer
                    loop.call_soon_threadsafe(queue.put_nowait, exc)

            worker = asyncio.create_task(asyncio.to_thread(produce))
            try:
                while True:
                    item = await queue.get()
                    if isinstance(item, Exception):
                        raise item
                    yield item
                    if item.done:
                        break
            finally:
                abort.set()
                await worker
        existing = self._locks.get(cache_key)
        if existing is not None and not existing.locked():
            self._locks.pop(cache_key, None)

    def _stream_blocking(
        self, location: str, camera: str, date: str, abort: threading.Event
    ) -> Iterator[MetadataBatch]:
        """Head-check, then ijson-parse the body in batches (blocking).

        Lives on a worker thread (see :meth:`stream`). Accumulates the full
        dict to seed the cache on completion. Checks ``abort`` between
        batches so a cancelled stream releases its thread promptly; an
        aborted transfer never seeds the cache (the dict is incomplete).
        """
        cache_key = (location, camera, date)
        s3_key = f"{camera}/{date}/metadata.json"
        bucket = self._buckets[location]
        client = self._pool.client_for(location)
        cached = self._entries.get(cache_key)

        try:
            head = client.head_object(Bucket=bucket, Key=s3_key)
        except client.exceptions.ClientError:
            # No object: serve a cached copy if we have one, else nothing.
            data = cached.data if cached is not None else {}
            etag = cached.etag if cached is not None else None
            yield from self._batches(data, abort)
            yield MetadataBatch(rows={}, done=True, etag=etag)
            return

        etag = head.get("ETag")
        if cached is not None and cached.etag == etag:
            self._entries.move_to_end(cache_key)
            yield from self._batches(cached.data, abort)
            yield MetadataBatch(rows={}, done=True, etag=etag)
            return

        obj = client.get_object(Bucket=bucket, Key=s3_key)
        body = obj["Body"]
        assembled: Metadata = {}
        batch: Metadata = {}
        # kvitems over the document root yields (seq_num, row) pairs as each
        # top-level value is fully parsed — ijson holds partial state across
        # buffer boundaries, so we never see a truncated row.
        for seq_num, row in ijson.kvitems(body, ""):
            assembled[seq_num] = row
            batch[seq_num] = row
            if len(batch) >= _STREAM_BATCH_ROWS:
                if abort.is_set():
                    return
                yield MetadataBatch(rows=batch, done=False)
                batch = {}
        if abort.is_set():
            return
        if batch:
            yield MetadataBatch(rows=batch, done=False)

        self._entries[cache_key] = _Entry(etag=etag, data=assembled)
        self._entries.move_to_end(cache_key)
        while len(self._entries) > _MAX_ENTRIES:
            self._entries.popitem(last=False)
        yield MetadataBatch(rows={}, done=True, etag=etag)

    @staticmethod
    def _batches(data: Metadata, abort: threading.Event) -> Iterator[MetadataBatch]:
        """Slice an already-loaded dict into non-terminal batches."""
        items = list(data.items())
        for i in range(0, len(items), _STREAM_BATCH_ROWS):
            if abort.is_set():
                return
            yield MetadataBatch(
                rows=dict(items[i : i + _STREAM_BATCH_ROWS]), done=False
            )

    def _fetch(
        self, location: str, camera: str, date: str
    ) -> tuple[str | None, Metadata]:
        cache_key = (location, camera, date)
        s3_key = f"{camera}/{date}/metadata.json"
        bucket = self._buckets[location]
        client = self._pool.client_for(location)
        cached = self._entries.get(cache_key)

        try:
            head = client.head_object(Bucket=bucket, Key=s3_key)
        except client.exceptions.ClientError:
            if cached is not None:
                return cached.etag, cached.data
            return None, {}

        etag = head.get("ETag")
        if cached is not None and cached.etag == etag:
            self._entries.move_to_end(cache_key)
            return cached.etag, cached.data

        # The GET and parse are guarded like the HEAD above: today's
        # metadata.json is rewritten continuously by the producer, so it can
        # be deleted/replaced between the HEAD and the GET (TOCTOU) or briefly
        # hold partial/invalid JSON. Degrade to the cached-or-empty payload
        # rather than 500 — the WS stream and the next fetch will fill it in.
        try:
            obj = client.get_object(Bucket=bucket, Key=s3_key)
            data: Metadata = json.loads(obj["Body"].read())
        except Exception:  # noqa: BLE001 - best-effort: any S3/parse failure
            log.warning(
                "metadata.fetch.failed", location=location, camera=camera, date=date
            )
            if cached is not None:
                return cached.etag, cached.data
            return None, {}
        self._entries[cache_key] = _Entry(etag=etag, data=data)
        self._entries.move_to_end(cache_key)
        while len(self._entries) > _MAX_ENTRIES:
            self._entries.popitem(last=False)
        return etag, data
