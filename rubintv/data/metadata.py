"""Metadata.json fetching with an LRU cache and per-key dedupe.

metadata.json is a dict keyed by seq_num (string) -> {column: value}. It is
fetched on demand (not held in the structured index), cached per
(location, camera, date), re-downloaded only when its ETag changes, and
concurrent fetches of the same key are deduped by a per-key lock.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import TYPE_CHECKING

from rubintv.logging import get_logger

if TYPE_CHECKING:
    from rubintv.s3.client import S3ClientPool

log = get_logger(__name__)

# Metadata dict: seq_num (as string) -> {column name -> value}.
Metadata = dict[str, dict[str, object]]

_MAX_ENTRIES = 60  # ~60 days per (location, camera), as in the old app


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

        # Timing probe (DEBUG): split the GET latency into time-to-first-byte
        # / transfer / parse so we know whether incremental parsing would help.
        t0 = time.perf_counter()
        obj = client.get_object(Bucket=bucket, Key=s3_key)
        t_get = time.perf_counter()
        body = obj["Body"].read()
        t_read = time.perf_counter()
        data: Metadata = json.loads(body)
        t_parse = time.perf_counter()
        log.debug(
            "metadata.fetch.timing",
            camera=camera,
            date=date,
            bytes=len(body),
            rows=len(data),
            get_object_s=round(t_get - t0, 3),
            read_body_s=round(t_read - t_get, 3),
            json_parse_s=round(t_parse - t_read, 3),
        )
        self._entries[cache_key] = _Entry(etag=etag, data=data)
        self._entries.move_to_end(cache_key)
        while len(self._entries) > _MAX_ENTRIES:
            self._entries.popitem(last=False)
        return etag, data
