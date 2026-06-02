"""MetadataCache.stream: incremental batching, cache-hit fast path, dedupe."""

from __future__ import annotations

import json
from collections.abc import Iterator

import boto3
import pytest
from moto import mock_aws

from rubintv.data import metadata as metadata_mod
from rubintv.data.metadata import MetadataCache
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


async def _collect(cache: MetadataCache) -> tuple[list[dict], object]:
    chunks: list[dict] = []
    etag: object = None
    async for batch in cache.stream("test", "lsstcam", DATE):
        if batch.done:
            etag = batch.etag
        elif batch.rows:
            chunks.append(batch.rows)
    return chunks, etag


async def test_stream_batches_and_assembles(
    cache: MetadataCache, monkeypatch
) -> None:
    monkeypatch.setattr(metadata_mod, "_STREAM_BATCH_ROWS", 2)
    chunks, etag = await _collect(cache)
    # 5 rows @ batch 2 -> 3 chunks (2, 2, 1).
    assert [len(c) for c in chunks] == [2, 2, 1]
    merged: dict = {}
    for c in chunks:
        merged.update(c)
    assert merged == {str(n): {"Exposure time": float(n)} for n in range(1, 6)}
    assert etag is not None


async def test_stream_cache_hit_skips_download(
    cache: MetadataCache, monkeypatch
) -> None:
    # Prime the cache.
    await _collect(cache)
    # A second stream with the same ETag must not call get_object.
    client = cache._pool.client_for("test")  # noqa: SLF001 - test introspection

    def _boom(*_a: object, **_k: object) -> None:
        raise AssertionError("get_object should not be called on a cache hit")

    monkeypatch.setattr(client, "get_object", _boom)
    chunks, etag = await _collect(cache)
    merged: dict = {}
    for c in chunks:
        merged.update(c)
    assert len(merged) == 5
    assert etag is not None
