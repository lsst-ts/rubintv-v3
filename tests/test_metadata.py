"""MetadataCache.stream: incremental batching, cache-hit fast path, dedupe."""

from __future__ import annotations

import json
from collections.abc import Iterator

import boto3
import pytest
from lsst.ts.rubintv.data import metadata as metadata_mod
from lsst.ts.rubintv.data.metadata import Metadata, MetadataCache
from moto import mock_aws

from tests.conftest import TEST_BUCKET

DATE = "2026-04-10"


class _FakePool:
    """Minimal S3ClientPool stand-in: one shared moto client for all locs."""

    def __init__(self, client: object) -> None:
        self._client = client

    def client_for(self, _location: str) -> object:
        return self._client


@pytest.fixture
def cache() -> Iterator[MetadataCache]:
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=TEST_BUCKET)
        rows = {str(n): {"Exposure time": float(n)} for n in range(1, 6)}
        s3.put_object(
            Bucket=TEST_BUCKET,
            Key=f"lsstcam/{DATE}/metadata.json",
            Body=json.dumps(rows).encode(),
        )
        pool = _FakePool(s3)
        yield MetadataCache(pool, {"test": TEST_BUCKET})  # type: ignore[arg-type]


async def _collect(cache: MetadataCache) -> tuple[list[Metadata], object]:
    chunks: list[Metadata] = []
    etag: object = None
    async for batch in cache.stream("test", "lsstcam", DATE):
        if batch.done:
            etag = batch.etag
        elif batch.rows:
            chunks.append(batch.rows)
    return chunks, etag


async def test_stream_batches_and_assembles(
    cache: MetadataCache, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(metadata_mod, "_STREAM_BATCH_ROWS", 2)
    chunks, etag = await _collect(cache)
    # 5 rows @ batch 2 -> 3 chunks (2, 2, 1).
    assert [len(c) for c in chunks] == [2, 2, 1]
    merged: Metadata = {}
    for c in chunks:
        merged.update(c)
    assert merged == {str(n): {"Exposure time": float(n)} for n in range(1, 6)}
    assert etag is not None


async def test_stream_cache_hit_skips_download(
    cache: MetadataCache, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Prime the cache.
    await _collect(cache)
    # A second stream with the same ETag must not call get_object.
    client = cache._pool.client_for("test")  # noqa: SLF001 - test introspection

    def _boom(*_a: object, **_k: object) -> None:
        raise AssertionError("get_object should not be called on a cache hit")

    monkeypatch.setattr(client, "get_object", _boom)
    chunks, etag = await _collect(cache)
    merged: Metadata = {}
    for c in chunks:
        merged.update(c)
    assert len(merged) == 5
    assert etag is not None


async def test_get_fetches_then_serves_from_cache(cache: MetadataCache) -> None:
    data = await cache.get("test", "lsstcam", DATE)
    assert len(data) == 5
    # Second call: head-only ETag check, same data back from the cache.
    etag, again = await cache.get_with_etag("test", "lsstcam", DATE)
    assert etag is not None
    assert again == data


async def test_get_missing_object_returns_empty(cache: MetadataCache) -> None:
    etag, data = await cache.get_with_etag("test", "lsstcam", "2026-01-01")
    assert etag is None
    assert data == {}


async def test_get_serves_cached_copy_when_object_deleted(
    cache: MetadataCache,
) -> None:
    # Prime, then delete the object: the cached copy (with its etag) survives.
    data = await cache.get("test", "lsstcam", DATE)
    client = cache._pool.client_for("test")  # noqa: SLF001 - test introspection
    client.delete_object(Bucket=TEST_BUCKET, Key=f"lsstcam/{DATE}/metadata.json")
    etag, again = await cache.get_with_etag("test", "lsstcam", DATE)
    assert etag is not None
    assert again == data


async def test_stream_missing_object_yields_done_only(
    cache: MetadataCache,
) -> None:
    batches = [b async for b in cache.stream("test", "lsstcam", "2026-01-01")]
    assert len(batches) == 1
    assert batches[0].done is True
    assert batches[0].etag is None
    assert batches[0].rows == {}


async def test_stream_missing_object_serves_cached_copy(
    cache: MetadataCache,
) -> None:
    chunks, etag = await _collect(cache)
    client = cache._pool.client_for("test")  # noqa: SLF001 - test introspection
    client.delete_object(Bucket=TEST_BUCKET, Key=f"lsstcam/{DATE}/metadata.json")
    chunks, again = await _collect(cache)
    assert again == etag
    assert sum(len(c) for c in chunks) == 5


async def test_stream_propagates_worker_errors(
    cache: MetadataCache, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = cache._pool.client_for("test")  # noqa: SLF001 - test introspection

    def _boom(*_a: object, **_k: object) -> None:
        raise RuntimeError("network down")

    monkeypatch.setattr(client, "head_object", _boom)
    with pytest.raises(RuntimeError, match="network down"):
        async for _ in cache.stream("test", "lsstcam", DATE):
            pass


async def test_cache_evicts_oldest_entries(
    cache: MetadataCache, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(metadata_mod, "_MAX_ENTRIES", 1)
    other_date = "2026-04-11"
    client = cache._pool.client_for("test")  # noqa: SLF001 - test introspection
    client.put_object(
        Bucket=TEST_BUCKET,
        Key=f"lsstcam/{other_date}/metadata.json",
        Body=json.dumps({"9": {"Exposure time": 9.0}}).encode(),
    )
    await cache.get("test", "lsstcam", DATE)
    # Fetching a second date through the streaming path evicts the first.
    async for _ in cache.stream("test", "lsstcam", other_date):
        pass
    assert list(cache._entries) == [  # noqa: SLF001 - test introspection
        ("test", "lsstcam", other_date)
    ]
