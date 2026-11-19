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

"""MetadataCache: one fetch path, shared fetches, deltas, a bounded LRU."""

from __future__ import annotations

import asyncio
import gzip
import json
import threading
from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from botocore.exceptions import ClientError, EndpointConnectionError
from lsst.ts.rubintv.data import metadata as metadata_mod
from lsst.ts.rubintv.data.metadata import (
    Metadata,
    MetadataCache,
    MetadataUnavailable,
)
from moto import mock_aws

from tests.conftest import TEST_BUCKET

DATE = "2026-04-10"
KEY = f"lsstcam/{DATE}/metadata.json"
ROWS: Metadata = {str(n): {"Exposure time": float(n)} for n in range(1, 6)}


class _FakePool:
    """Minimal S3ClientPool stand-in: one shared moto client for all locs."""

    def __init__(self, client: object) -> None:
        self._client = client

    def client_for(self, _location: str) -> object:
        return self._client


@pytest.fixture
def s3() -> Iterator[Any]:
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket=TEST_BUCKET)
        client.put_object(Bucket=TEST_BUCKET, Key=KEY, Body=json.dumps(ROWS).encode())
        yield client


@pytest.fixture
def cache(s3: Any) -> MetadataCache:
    return MetadataCache(_FakePool(s3), {"test": TEST_BUCKET})  # type: ignore[arg-type]


def _put(s3: Any, body: bytes | Metadata, date: str = DATE) -> None:
    # The producer rewrites the whole file; only the content differs.
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    s3.put_object(Bucket=TEST_BUCKET, Key=f"lsstcam/{date}/metadata.json", Body=raw)


def _count(
    s3: Any, monkeypatch: pytest.MonkeyPatch, method: str
) -> list[dict[str, object]]:
    """Record calls to an S3 client method, which still goes through."""
    calls: list[dict[str, object]] = []
    real = getattr(s3, method)

    def counted(**kwargs: object) -> object:
        calls.append(kwargs)
        return real(**kwargs)

    monkeypatch.setattr(s3, method, counted)
    return calls


def _break(s3: Any, monkeypatch: pytest.MonkeyPatch, method: str) -> None:
    def broken(**_kwargs: object) -> None:
        raise EndpointConnectionError(endpoint_url="https://s3.example")

    monkeypatch.setattr(s3, method, broken)


async def test_get_fetches_then_serves_from_cache(
    cache: MetadataCache, s3: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    gets = _count(s3, monkeypatch, "get_object")
    doc = await cache.get("test", "lsstcam", DATE)
    assert doc.data == ROWS and doc.etag is not None
    # The text to serve is the object's own: nothing to re-serialise.
    assert doc.body == json.dumps(ROWS).encode()
    # Second read: a HEAD says it is current, and the same document is back.
    assert await cache.get("test", "lsstcam", DATE) is doc
    assert len(gets) == 1


async def test_a_missing_object_is_an_empty_document(cache: MetadataCache) -> None:
    doc = await cache.get("test", "lsstcam", "2026-01-01")
    assert (doc.etag, doc.data, doc.body) == (None, {}, b"{}")
    # Nothing to bring a reader forward from, whatever version it names.
    assert doc.changes_since('"v1"') is None


async def test_a_deleted_object_leaves_its_cached_copy(
    cache: MetadataCache, s3: Any
) -> None:
    doc = await cache.get("test", "lsstcam", DATE)
    s3.delete_object(Bucket=TEST_BUCKET, Key=KEY)
    assert await cache.get("test", "lsstcam", DATE) is doc


@pytest.mark.parametrize("method", ["head_object", "get_object"])
async def test_a_failed_read_with_nothing_cached_is_unavailable(
    cache: MetadataCache, s3: Any, monkeypatch: pytest.MonkeyPatch, method: str
) -> None:
    # Not an empty document: the page would show a night with no metadata
    # and call it loaded.
    _break(s3, monkeypatch, method)
    with pytest.raises(MetadataUnavailable):
        await cache.get("test", "lsstcam", DATE)
    # Nothing is remembered of the failure: the next read tries again.
    monkeypatch.undo()
    assert (await cache.get("test", "lsstcam", DATE)).data == ROWS


async def test_an_s3_error_that_is_not_a_404_is_a_failure(
    cache: MetadataCache, s3: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A 503 from the gateway must not read as "this date has no metadata".
    def slow_down(**_kwargs: object) -> None:
        raise ClientError({"Error": {"Code": "SlowDown"}}, "HeadObject")

    monkeypatch.setattr(s3, "head_object", slow_down)
    with pytest.raises(MetadataUnavailable):
        await cache.get("test", "lsstcam", DATE)


@pytest.mark.parametrize(
    "body",
    [b'{"1": {"Exposure time": 1.0}, "2": {"Expo', b'[{"Exposure time": 1.0}]'],
    ids=["cut-short", "not-an-object"],
)
async def test_a_failed_refresh_serves_the_cached_copy(
    cache: MetadataCache, s3: Any, body: bytes
) -> None:
    # Today's file is rewritten continuously; a read can catch it broken.
    doc = await cache.get("test", "lsstcam", DATE)
    _put(s3, body)
    assert await cache.get("test", "lsstcam", DATE) is doc
    # Once the file is whole again the cache moves on, with a delta from the
    # version it kept.
    _put(s3, {**ROWS, "6": {"Exposure time": 6.0}})
    fresh = await cache.get("test", "lsstcam", DATE)
    delta = fresh.changes_since(doc.etag)
    assert delta is not None and delta.rows == {"6": {"Exposure time": 6.0}}


async def test_nan_and_infinity_are_read_as_null(cache: MetadataCache, s3: Any) -> None:
    # Python's json.dump writes these; a browser's JSON.parse rejects them.
    _put(s3, b'{"1": {"psf": NaN, "sky": Infinity, "bias": -Infinity, "exp": 30.0}}')
    doc = await cache.get("test", "lsstcam", DATE)
    assert doc.data == {"1": {"psf": None, "sky": None, "bias": None, "exp": 30.0}}
    # And the text served is rewritten to match, as strict JSON.
    assert json.loads(doc.body, parse_constant=pytest.fail) == doc.data


async def test_numbers_stay_numbers(cache: MetadataCache, s3: Any) -> None:
    _put(s3, b'{"1": {"psf": 0.30000000000000004, "exp": 30.0, "n": 3}}')
    row = (await cache.get("test", "lsstcam", DATE)).data["1"]
    assert row == {"psf": 0.30000000000000004, "exp": 30.0, "n": 3}
    assert [type(v) for v in row.values()] == [float, float, int]


async def test_readers_arriving_together_share_one_fetch(
    cache: MetadataCache, s3: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    heads = _count(s3, monkeypatch, "head_object")
    gets = _count(s3, monkeypatch, "get_object")
    docs = await asyncio.gather(*(cache.get("test", "lsstcam", DATE) for _ in range(5)))
    assert all(doc is docs[0] for doc in docs)
    assert (len(heads), len(gets)) == (1, 1)


async def test_a_reader_leaving_does_not_stop_the_fetch_for_the_rest(
    cache: MetadataCache, s3: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    release = threading.Event()
    real = s3.get_object

    def held(**kwargs: object) -> object:
        release.wait(30)
        return real(**kwargs)

    monkeypatch.setattr(s3, "get_object", held)
    first = asyncio.create_task(cache.get("test", "lsstcam", DATE))
    second = asyncio.create_task(cache.get("test", "lsstcam", DATE))
    await asyncio.sleep(0)
    first.cancel()
    release.set()
    assert (await second).data == ROWS
    assert first.cancelled()


async def test_a_failure_nobody_waited_for_is_not_left_unretrieved(
    cache: MetadataCache, s3: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The only reader leaves, then the shared fetch fails: asyncio would
    # report "Task exception was never retrieved" at garbage collection.
    release = threading.Event()

    def held(**_kwargs: object) -> None:
        release.wait(30)
        raise EndpointConnectionError(endpoint_url="https://s3.example")

    monkeypatch.setattr(s3, "head_object", held)
    reader = asyncio.create_task(cache.get("test", "lsstcam", DATE))
    await asyncio.sleep(0)
    (fetch,) = cache._inflight.values()  # noqa: SLF001 - test introspection
    reader.cancel()
    release.set()
    await asyncio.wait([fetch])
    await asyncio.sleep(0)  # let its done callback run
    assert fetch._log_traceback is False  # type: ignore[attr-defined]  # noqa: SLF001
    assert cache._inflight == {}  # noqa: SLF001


async def test_a_cancelled_fetch_is_forgotten(
    cache: MetadataCache, s3: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # At shutdown the loop cancels what is in flight; the reader is cancelled
    # with it, and nothing is left behind for the key.
    release = threading.Event()
    real = s3.head_object

    def held(**kwargs: object) -> object:
        release.wait(30)
        return real(**kwargs)

    monkeypatch.setattr(s3, "head_object", held)
    reader = asyncio.create_task(cache.get("test", "lsstcam", DATE))
    await asyncio.sleep(0)
    (fetch,) = cache._inflight.values()  # noqa: SLF001 - test introspection
    fetch.cancel()
    with pytest.raises(asyncio.CancelledError):
        await reader
    release.set()
    assert cache._inflight == {}  # noqa: SLF001
    # The next reader starts afresh.
    assert (await cache.get("test", "lsstcam", DATE)).data == ROWS


async def test_the_cache_is_bounded_by_bytes_not_entries(s3: Any) -> None:
    dates = ["2026-04-11", "2026-04-12", "2026-04-13"]
    for date in dates:
        _put(s3, {"1": {"note": "x" * 100}}, date)
    size = len(json.dumps({"1": {"note": "x" * 100}}))
    cache = MetadataCache(
        _FakePool(s3),  # type: ignore[arg-type]
        {"test": TEST_BUCKET},
        max_bytes=2 * size,
    )
    for date in dates:
        await cache.get("test", "lsstcam", date)
    # Room for two: the least recently read went.
    assert [key[2] for key in cache._entries] == dates[1:]  # noqa: SLF001
    # Reading one makes it the most recent, so the other goes next.
    await cache.get("test", "lsstcam", dates[1])
    await cache.get("test", "lsstcam", dates[0])
    assert [key[2] for key in cache._entries] == [dates[1], dates[0]]  # noqa: SLF001
    assert cache._bytes == 2 * size  # noqa: SLF001


async def test_a_document_larger_than_the_cap_is_still_cached(s3: Any) -> None:
    # It is about to be served, and the next read of it should cost a HEAD.
    cache = MetadataCache(_FakePool(s3), {"test": TEST_BUCKET}, max_bytes=1)  # type: ignore[arg-type]
    doc = await cache.get("test", "lsstcam", DATE)
    assert await cache.get("test", "lsstcam", DATE) is doc
    # A rewrite replaces it, and its size, rather than adding to it.
    _put(s3, {"1": {}})
    await cache.get("test", "lsstcam", DATE)
    assert cache._bytes == len(json.dumps({"1": {}}))  # noqa: SLF001


async def test_changes_since_the_replaced_version_are_the_difference(
    cache: MetadataCache, s3: Any
) -> None:
    first = await cache.get("test", "lsstcam", DATE)
    # One row added, one altered, one removed: the usual per-exposure shape
    # plus the rarer reprocessing cases.
    rewritten = {**ROWS, "6": {"Exposure time": 6.0}}
    rewritten["3"] = {"Exposure time": 3.5}
    del rewritten["1"]
    _put(s3, rewritten)

    doc = await cache.get("test", "lsstcam", DATE)
    assert doc.data == rewritten
    delta = doc.changes_since(first.etag)
    assert delta is not None
    assert delta.since == first.etag and delta.etag == doc.etag != first.etag
    assert delta.rows == {"6": {"Exposure time": 6.0}, "3": {"Exposure time": 3.5}}
    assert delta.removed == ["1"]


async def test_changes_since_the_current_version_are_empty(
    cache: MetadataCache,
) -> None:
    doc = await cache.get("test", "lsstcam", DATE)
    delta = doc.changes_since(doc.etag)
    assert delta is not None
    assert (delta.rows, delta.removed, delta.etag) == ({}, [], doc.etag)


async def test_changes_since_an_unknown_version_are_not_known(
    cache: MetadataCache, s3: Any
) -> None:
    # Two rewrites between reads: the reader's version is not the one just
    # replaced, so it needs the whole document. So does a reader with none.
    first = await cache.get("test", "lsstcam", DATE)
    _put(s3, {**ROWS, "6": {"Exposure time": 6.0}})
    await cache.get("test", "lsstcam", DATE)
    _put(s3, {**ROWS, "7": {"Exposure time": 7.0}})
    doc = await cache.get("test", "lsstcam", DATE)
    assert doc.changes_since(first.etag) is None
    assert doc.changes_since("never-seen") is None
    assert doc.changes_since(None) is None


async def test_the_version_is_the_one_the_body_came_with(
    cache: MetadataCache, s3: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Rewritten between the HEAD and the GET: the etag kept must be the
    # GET's, or the next HEAD would match a body the cache doesn't hold.
    real = s3.head_object

    def head_then_rewrite(**kwargs: object) -> object:
        head = real(**kwargs)
        _put(s3, {"9": {"Exposure time": 9.0}})
        return head

    monkeypatch.setattr(s3, "head_object", head_then_rewrite)
    doc = await cache.get("test", "lsstcam", DATE)
    monkeypatch.undo()
    assert doc.data == {"9": {"Exposure time": 9.0}}
    assert doc.etag == s3.head_object(Bucket=TEST_BUCKET, Key=KEY)["ETag"]


@pytest.fixture
def small_ranges(monkeypatch: pytest.MonkeyPatch) -> None:
    """Shrink the ranged-read sizes so the fixture's file counts as large."""
    monkeypatch.setattr(metadata_mod, "_RANGED_MIN_BYTES", 50)
    monkeypatch.setattr(metadata_mod, "_RANGE_BYTES", 40)


@pytest.mark.usefixtures("small_ranges")
@pytest.mark.parametrize("size", [130, 160], ids=["short-last-range", "whole-ranges"])
async def test_a_large_file_is_read_as_ranges_at_once(
    cache: MetadataCache, s3: Any, monkeypatch: pytest.MonkeyPatch, size: int
) -> None:
    # One connection carried a 20 MB night at about 6 MB/s on the pod.
    rows = {"1": {"note": "x" * (size - len(json.dumps({"1": {"note": ""}})))}}
    _put(s3, rows)
    gets = _count(s3, monkeypatch, "get_object")
    doc = await cache.get("test", "lsstcam", DATE)
    assert doc.data == rows and len(doc.body) == size
    etag = s3.head_object(Bucket=TEST_BUCKET, Key=KEY)["ETag"]
    assert doc.etag == etag
    # Every byte once, each range pinned to the version the HEAD saw.
    assert sorted(str(get["Range"]) for get in gets) == sorted(
        f"bytes={first}-{min(first + 40, size) - 1}" for first in range(0, size, 40)
    )
    assert {get["IfMatch"] for get in gets} == {etag}


async def test_a_small_file_is_read_in_one_request(
    cache: MetadataCache, s3: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    gets = _count(s3, monkeypatch, "get_object")
    await cache.get("test", "lsstcam", DATE)
    assert gets == [{"Bucket": TEST_BUCKET, "Key": KEY}]


@pytest.mark.usefixtures("small_ranges")
async def test_a_rewrite_between_ranges_fails_the_read_not_the_document(
    cache: MetadataCache, s3: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Ranges of two versions joined would be nonsense. The read fails
    # instead (the cached copy stands in), and the next one is whole.
    first = {"1": {"note": "a" * 100}}
    second = {"1": {"note": "b" * 100}, "2": {"note": "c" * 100}}
    third = {"3": {"note": "d" * 100}}
    _put(s3, first)
    doc = await cache.get("test", "lsstcam", DATE)
    _put(s3, second)
    real = s3.head_object

    def head_then_rewrite(**kwargs: object) -> object:
        head = real(**kwargs)
        _put(s3, third)
        return head

    monkeypatch.setattr(s3, "head_object", head_then_rewrite)
    assert await cache.get("test", "lsstcam", DATE) is doc
    monkeypatch.undo()
    assert (await cache.get("test", "lsstcam", DATE)).data == third


class _LogRecorder:
    """Stands in for the module's logger: records (level, event, fields)."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, Any]]] = []

    def __getattr__(self, level: str) -> Any:
        def record(event: str, **fields: Any) -> None:
            self.calls.append((level, event, fields))

        return record


@pytest.mark.parametrize(
    ("slow_after", "level"), [(0.0, "info"), (3600.0, "debug")], ids=["slow", "quick"]
)
async def test_a_fetch_logs_where_its_time_went(
    cache: MetadataCache,
    monkeypatch: pytest.MonkeyPatch,
    slow_after: float,
    level: str,
) -> None:
    # At info only when it was slow enough for the page to notice: today's
    # file is re-read at every exposure.
    recorder = _LogRecorder()
    monkeypatch.setattr(metadata_mod, "log", recorder)
    monkeypatch.setattr(metadata_mod, "_SLOW_SECONDS", slow_after)
    await cache.get("test", "lsstcam", DATE)
    ((logged_at, event, fields),) = recorder.calls
    assert (logged_at, event) == (level, "metadata.fetch")
    assert fields["rows"] == 5 and fields["requests"] == 1
    assert fields["bytes"] == len(json.dumps(ROWS))
    assert fields["s3_ms"] >= 0 and fields["parse_ms"] >= 0
    # An unchanged file is a HEAD, and not worth a line.
    await cache.get("test", "lsstcam", DATE)
    assert len(recorder.calls) == 1


@pytest.mark.parametrize(
    ("slow_after", "level"), [(0.0, "info"), (3600.0, "debug")], ids=["slow", "quick"]
)
async def test_a_compression_logs_how_long_it_took(
    cache: MetadataCache,
    monkeypatch: pytest.MonkeyPatch,
    slow_after: float,
    level: str,
) -> None:
    # The first page to open a night waits for this, so its share of that
    # wait should be readable from the log, not worked out by subtraction.
    doc = await cache.get("test", "lsstcam", DATE)
    recorder = _LogRecorder()
    monkeypatch.setattr(metadata_mod, "log", recorder)
    monkeypatch.setattr(metadata_mod, "_SLOW_SECONDS", slow_after)
    gzipped = await cache.gzipped("test", "lsstcam", DATE, doc)
    ((logged_at, event, fields),) = recorder.calls
    assert (logged_at, event) == (level, "metadata.compress")
    assert (fields["location"], fields["camera"], fields["date"]) == (
        "test",
        "lsstcam",
        DATE,
    )
    assert fields["bytes"] == len(doc.whole())
    assert fields["gzipped_bytes"] == len(gzipped)
    assert fields["duration_ms"] >= 0
    # Served again from the kept copy: nothing compressed, nothing logged.
    await cache.gzipped("test", "lsstcam", DATE, doc)
    assert len(recorder.calls) == 1


async def test_close_stops_the_worker_threads(cache: MetadataCache) -> None:
    cache.close()
    with pytest.raises(RuntimeError):
        cache._workers.submit(print)  # noqa: SLF001 - test introspection


def _count_compressions(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """Record the size of everything gzipped, which still goes through."""
    sizes: list[int] = []
    real = gzip.compress

    def counted(data: bytes, level: int) -> bytes:
        sizes.append(len(data))
        return real(data, level)

    monkeypatch.setattr(gzip, "compress", counted)
    return sizes


async def test_a_whole_document_is_compressed_once_per_version(
    cache: MetadataCache, s3: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    compressions = _count_compressions(monkeypatch)
    doc = await cache.get("test", "lsstcam", DATE)
    assert json.loads(doc.whole()) == {
        "rows": ROWS,
        "etag": doc.etag,
        "since": None,
        "removed": [],
    }
    # Readers arriving together share the one compression...
    first, second = await asyncio.gather(
        cache.gzipped("test", "lsstcam", DATE, doc),
        cache.gzipped("test", "lsstcam", DATE, doc),
    )
    assert gzip.decompress(first) == doc.whole()
    # ...and one arriving later is handed the same bytes.
    assert await cache.gzipped("test", "lsstcam", DATE, doc) is first is second
    assert compressions == [len(doc.whole())]

    # A rewrite is a new version: compressed afresh, the old copy dropped.
    _put(s3, {**ROWS, "6": {"Exposure time": 6.0}})
    rewritten = await cache.get("test", "lsstcam", DATE)
    again = await cache.gzipped("test", "lsstcam", DATE, rewritten)
    assert gzip.decompress(again) == rewritten.whole()
    assert len(compressions) == 2
    assert [held for held, _ in cache._gzipped.values()] == [rewritten]  # noqa: SLF001


async def test_a_reader_overtaken_by_a_rewrite_gets_its_version_compressed(
    cache: MetadataCache, s3: Any
) -> None:
    # Its copy isn't kept: the cache has moved on, and holds the newer one.
    doc = await cache.get("test", "lsstcam", DATE)
    _put(s3, {"9": {"Exposure time": 9.0}})
    newer = await cache.get("test", "lsstcam", DATE)
    kept = await cache.gzipped("test", "lsstcam", DATE, newer)
    assert gzip.decompress(await cache.gzipped("test", "lsstcam", DATE, doc)) == (
        doc.whole()
    )
    assert await cache.gzipped("test", "lsstcam", DATE, newer) is kept


async def test_a_dropped_document_takes_its_compressed_copy_with_it(s3: Any) -> None:
    _put(s3, {"1": {"note": "x" * 100}}, "2026-04-11")
    cache = MetadataCache(_FakePool(s3), {"test": TEST_BUCKET}, max_bytes=1)  # type: ignore[arg-type]
    doc = await cache.get("test", "lsstcam", DATE)
    await cache.gzipped("test", "lsstcam", DATE, doc)
    await cache.get("test", "lsstcam", "2026-04-11")
    assert cache._gzipped == {}  # noqa: SLF001 - test introspection
