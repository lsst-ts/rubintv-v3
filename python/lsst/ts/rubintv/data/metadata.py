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

"""Metadata.json fetching with a byte-bounded LRU cache.

metadata.json is a dict keyed by seq_num (string) -> {column: value}. It is
fetched on demand (not held in the structured index), cached per
(location, camera, date), and re-downloaded only when its ETag changes.
There is one way in, :meth:`MetadataCache.get`: every reader of a date (the
REST endpoints, the warmer) gets the same parsed document, and concurrent
readers share one fetch.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from dataclasses import dataclass
from typing import TYPE_CHECKING

from botocore.exceptions import ClientError
from lsst.ts.rubintv.logging import get_logger

if TYPE_CHECKING:
    from lsst.ts.rubintv.s3.client import S3ClientPool
    from mypy_boto3_s3.client import S3Client

log = get_logger(__name__)

# Metadata dict: seq_num (as string) -> {column name -> value}.
Metadata = dict[str, dict[str, object]]

_Key = tuple[str, str, str]

# How much document text the cache holds, process-wide, before the least
# recently read dates are dropped. A count would not bound memory: a busy
# LSSTCam night is over 10 MB and a quiet camera's a few kB. Each entry is
# held twice, as the text to serve and the rows to diff against, and once
# more, a tenth the size, compressed (if it has been asked for whole): the
# resident cost is about 2.5 times this.
_MAX_BYTES = 256 * 1024 * 1024

# Ceiling on concurrent S3 fetches. Each holds a default-executor thread for
# its whole transfer, and that executor is shared with the live pollers'
# scan calls: unbounded, a crowd of dates on a slow endpoint could occupy
# every thread and starve the 1s poll loop.
_FETCH_MAX_CONCURRENCY = 4

# A file this large is read as several ranges at once. One connection to
# the USDF gateway carried a 20 MB night at about 6 MB/s (3.6 s, on the
# usdf-dev pod); smaller files are done in under a second as they are.
_RANGED_MIN_BYTES = 4 * 1024 * 1024
_RANGE_BYTES = 2 * 1024 * 1024
_RANGE_WORKERS = 8

# The level a whole document is compressed at, once per version: the same as
# CompressionMiddleware's, which did it afresh for every response (0.15 s
# for a 12 MB night).
_GZIP_LEVEL = 6

# A fetch that took this long is logged at info, not debug: long enough for
# the page to have noticed, and rare (today's file, re-read at each
# exposure, comes in well under it).
_SLOW_FETCH_SECONDS = 1.0

# S3 error codes that mean the object isn't there (HEAD reports a bare 404).
_NOT_FOUND = ("404", "NoSuchKey", "NotFound")


class MetadataUnavailable(Exception):
    """A date's metadata could not be read, and no earlier copy is cached."""


class _NoObject(Exception):
    """The date has no metadata.json."""


@dataclass(frozen=True, slots=True)
class MetadataDelta:
    """What changed between two versions of a date's metadata.

    ``rows`` are the added or altered rows (seq -> row); ``removed`` the seqs
    that disappeared. ``etag`` is the version the delta brings the reader up
    to, ``since`` the version it applies on top of.
    """

    since: str | None
    etag: str | None
    rows: Metadata
    removed: list[str]


@dataclass(frozen=True, slots=True)
class MetadataDoc:
    """One version of a date's metadata.

    ``body`` is the document as JSON text, ready to serve: sending it needs
    no serialising (or validating) of ``data`` on the event loop.
    """

    etag: str | None
    data: Metadata
    body: bytes
    # The change from the version this one replaced, so a reader holding that
    # version can be brought current without the whole document (the producer
    # rewrites the file per exposure; the difference is usually one row).
    delta: MetadataDelta | None = None

    def changes_since(self, since: str | None) -> MetadataDelta | None:
        """The change from version ``since`` to this one, if known.

        ``None`` when the reader's version isn't this one or the one it
        replaced (two rewrites between reads, an evicted entry, a reader
        with nothing): the reader needs the whole document. A reader already
        current gets an empty delta.
        """
        if since is None or self.etag is None:
            return None
        if since == self.etag:
            return MetadataDelta(since=since, etag=self.etag, rows={}, removed=[])
        if self.delta is not None and self.delta.since == since:
            return self.delta
        return None

    def whole(self) -> bytes:
        """The document as a change from nothing, as JSON text.

        What a reader holding no usable version is sent: a
        ``MetadataDelta`` whose ``rows`` are every row and whose ``since``
        is null, with the stored text spliced in rather than serialised.
        """
        rest = json.dumps({"etag": self.etag, "since": None, "removed": []})
        return b'{"rows":' + self.body + b"," + rest[1:].encode()


_EMPTY = MetadataDoc(etag=None, data={}, body=b"{}")


class MetadataCache:
    """LRU cache of metadata.json contents, fetched from S3 on demand."""

    def __init__(
        self,
        pool: S3ClientPool,
        buckets: dict[str, str],
        max_bytes: int = _MAX_BYTES,
    ) -> None:
        self._pool = pool
        self._buckets = buckets
        self._max_bytes = max_bytes
        # Read and written on the event loop only; the worker threads are
        # handed what they need and return what they fetched.
        self._entries: OrderedDict[_Key, MetadataDoc] = OrderedDict()
        self._bytes = 0
        self._inflight: dict[_Key, asyncio.Task[MetadataDoc]] = {}
        self._fetch_sem = asyncio.Semaphore(_FETCH_MAX_CONCURRENCY)
        # Each cached version's whole() gzipped, once someone has asked for
        # it; dropped with the version.
        self._gzipped: dict[_Key, tuple[MetadataDoc, asyncio.Future[bytes]]] = {}
        # Reads the ranges of large files and compresses whole documents,
        # for whichever requests need them.
        self._workers = ThreadPoolExecutor(
            max_workers=_RANGE_WORKERS, thread_name_prefix="metadata"
        )

    def close(self) -> None:
        """Stop the worker threads."""
        self._workers.shutdown(wait=False, cancel_futures=True)

    async def get(self, location: str, camera: str, date: str) -> MetadataDoc:
        """Return a date's current metadata, fetching it if it has changed.

        Costs one HEAD when the cached copy is current. Readers that arrive
        while a fetch is under way share it, and one of them leaving doesn't
        stop it for the rest.

        Raises:
            MetadataUnavailable: S3 or the document failed, and there is no
                cached copy to serve instead.
        """
        key = (location, camera, date)
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._refresh(key))
            self._inflight[key] = task
            task.add_done_callback(lambda done: self._landed(key, done))
        return await asyncio.shield(task)

    async def gzipped(
        self, location: str, camera: str, date: str, doc: MetadataDoc
    ) -> bytes:
        """``doc.whole()``, gzipped: compressed once per version, then kept.

        ``doc`` is what :meth:`get` just returned for the date. Every page
        that opens a night asks for it whole, and compressing a large one
        costs more than fetching it; here only the first to ask waits for
        that, on a worker thread, and those that ask meanwhile share it.
        """
        key = (location, camera, date)
        held = self._gzipped.get(key)
        if held is None or held[0] is not doc:
            loop = asyncio.get_running_loop()
            held = (doc, loop.run_in_executor(self._workers, _gzip_whole, doc))
            # Kept only for the version the cache holds: a reader overtaken
            # by a rewrite gets its copy, but it isn't worth keeping.
            if self._entries.get(key) is doc:
                self._gzipped[key] = held
        return await asyncio.shield(held[1])

    def _landed(self, key: _Key, task: asyncio.Task[MetadataDoc]) -> None:
        self._inflight.pop(key, None)
        if not task.cancelled():
            # Mark a failure as seen: every reader may have left already.
            task.exception()

    async def _refresh(self, key: _Key) -> MetadataDoc:
        location, camera, date = key
        cached = self._entries.get(key)
        try:
            async with self._fetch_sem:
                doc = await asyncio.to_thread(self._fetch, key, cached)
        except _NoObject:
            # Serve a cached copy if we have one, else nothing.
            return cached if cached is not None else _EMPTY
        # Best-effort: any S3 or parse failure. Today's file is rewritten
        # continuously, so a read can catch it mid-change; the next one
        # (every rewrite prompts one) puts it right.
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "metadata.fetch.failed",
                location=location,
                camera=camera,
                date=date,
                error=str(exc),
                cached=cached is not None,
            )
            if cached is None:
                raise MetadataUnavailable(f"{camera}/{date}") from exc
            return cached
        # Also when unchanged: it is now the most recently read, and may
        # have been dropped for another date while we asked.
        self._store(key, doc)
        return doc

    def _store(self, key: _Key, doc: MetadataDoc) -> None:
        """Cache a version, dropping the least recently read past the cap."""
        previous = self._entries.pop(key, None)
        if previous is not None:
            self._bytes -= len(previous.body)
            if previous is not doc:
                self._gzipped.pop(key, None)
        self._entries[key] = doc
        self._bytes += len(doc.body)
        # The newest always stays, however large: it is about to be served.
        while self._bytes > self._max_bytes and len(self._entries) > 1:
            oldest, dropped = self._entries.popitem(last=False)
            self._bytes -= len(dropped.body)
            self._gzipped.pop(oldest, None)

    def _fetch(self, key: _Key, cached: MetadataDoc | None) -> MetadataDoc:
        """HEAD, then GET and parse if the version isn't ``cached`` (blocking).

        Lives on a worker thread and changes no shared state (``cached`` is
        only read, to diff the new version against). Returns ``cached``
        itself when the object is still that version.

        Raises:
            _NoObject: There is no metadata.json for the date.
        """
        location, camera, date = key
        s3_key = f"{camera}/{date}/metadata.json"
        bucket = self._buckets[location]
        client = self._pool.client_for(location)
        started = time.perf_counter()
        try:
            head = client.head_object(Bucket=bucket, Key=s3_key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in _NOT_FOUND:
                raise _NoObject(s3_key) from exc
            raise
        if cached is not None and head.get("ETag") == cached.etag:
            return cached
        raw, etag, requests = self._read(
            client, bucket, s3_key, head.get("ContentLength", 0), head.get("ETag")
        )
        read = time.perf_counter()
        data, body = _parse(raw)
        doc = MetadataDoc(
            etag=etag,
            data=data,
            body=body,
            delta=_diff(cached, etag, data) if cached is not None else None,
        )
        done = time.perf_counter()
        emit = log.info if done - started >= _SLOW_FETCH_SECONDS else log.debug
        emit(
            "metadata.fetch",
            location=location,
            camera=camera,
            date=date,
            rows=len(data),
            bytes=len(raw),
            requests=requests,
            s3_ms=round((read - started) * 1000, 1),
            parse_ms=round((done - read) * 1000, 1),
        )
        return doc

    def _read(
        self, client: S3Client, bucket: str, s3_key: str, size: int, etag: str | None
    ) -> tuple[bytes, str | None, int]:
        """Download the object a HEAD just described (blocking).

        Returns its bytes, the ETag they are, and how many GETs it took: one
        for a small file, one per range of a large one.
        """
        if size < _RANGED_MIN_BYTES or etag is None:
            obj = client.get_object(Bucket=bucket, Key=s3_key)
            with closing(obj["Body"]) as stream:
                # The GET's own ETag: the file may have been rewritten since
                # the HEAD.
                return stream.read(), obj.get("ETag"), 1

        def read_range(first: int) -> bytes:
            last = min(first + _RANGE_BYTES, size) - 1
            # IfMatch pins every range to the version the HEAD saw. A
            # rewrite part way through fails the read (412), which the next
            # one puts right, where two versions spliced together would not
            # even parse.
            obj = client.get_object(
                Bucket=bucket,
                Key=s3_key,
                Range=f"bytes={first}-{last}",
                IfMatch=etag,
            )
            with closing(obj["Body"]) as stream:
                return stream.read()

        parts = list(self._workers.map(read_range, range(0, size, _RANGE_BYTES)))
        return b"".join(parts), etag, len(parts)


def _gzip_whole(doc: MetadataDoc) -> bytes:
    return gzip.compress(doc.whole(), _GZIP_LEVEL)


def _parse(raw: bytes) -> tuple[Metadata, bytes]:
    """Parse a metadata.json, returning its rows and the text to serve.

    Python's ``json.dump`` writes ``NaN`` and ``Infinity``, which the
    producer can let through and a browser's ``JSON.parse`` rejects. They are
    read as null, and only then is the document re-serialised; otherwise the
    text from S3 is served as it is.
    """
    nonfinite = False

    def null(_constant: str) -> None:
        nonlocal nonfinite
        nonfinite = True

    data = json.loads(raw, parse_constant=null)
    if not isinstance(data, dict):
        raise ValueError("metadata.json is not an object")
    if not nonfinite:
        return data, raw
    return data, json.dumps(data, separators=(",", ":"), allow_nan=False).encode()


def _diff(previous: MetadataDoc, etag: str | None, data: Metadata) -> MetadataDelta:
    """Rows added or altered since ``previous``, and seqs that vanished."""
    old = previous.data
    rows = {seq: row for seq, row in data.items() if old.get(seq) != row}
    removed = [seq for seq in old if seq not in data]
    return MetadataDelta(since=previous.etag, etag=etag, rows=rows, removed=removed)
