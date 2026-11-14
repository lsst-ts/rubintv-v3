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

"""Thumbnails: shrinking a frame, the per-channel cache, and the route."""

from __future__ import annotations

import asyncio
import io
import threading
from collections.abc import Iterator
from typing import Any

import boto3
import pytest
from fastapi.testclient import TestClient
from lsst.ts.rubintv.app import create_app
from lsst.ts.rubintv.config.settings import Settings
from lsst.ts.rubintv.data.thumbs import NotAnImage, ThumbnailCache, shrink
from PIL import Image

from tests.conftest import TEST_BUCKET, PrefixedTestClient

DATE = "2026-04-10"
CHANNEL = ("test", "lsstcam", "witness_detector")


def encode(img: Image.Image, fmt: str = "PNG") -> bytes:
    out = io.BytesIO()
    img.save(out, fmt)
    return out.getvalue()


def decode(data: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(data))
    img.load()
    return img


# --- shrink ---------------------------------------------------------------


def test_shrink_fits_the_box_and_keeps_the_aspect() -> None:
    thumb = decode(shrink(encode(Image.new("RGB", (2000, 1000), "red"))))
    assert thumb.format == "JPEG"
    assert thumb.size == (640, 320)


def test_shrink_leaves_a_small_frame_its_size() -> None:
    assert decode(shrink(encode(Image.new("RGB", (300, 200))))).size == (300, 200)


def test_shrink_decodes_a_jpeg_source() -> None:
    src = encode(Image.new("RGB", (2970, 2970), "blue"), "JPEG")
    assert decode(shrink(src)).size == (640, 640)


def test_shrink_lays_transparency_over_white() -> None:
    thumb = decode(shrink(encode(Image.new("RGBA", (800, 800), (0, 0, 0, 0)))))
    assert thumb.mode == "RGB"
    assert all(c > 250 for c in thumb.getpixel((10, 10)))  # type: ignore[union-attr]


def test_shrink_expands_a_palette_frame_with_transparency() -> None:
    img = Image.new("P", (800, 800), 0)
    img.putpalette([0, 0, 0, 255, 0, 0])
    img.paste(1, (0, 0, 400, 800))
    img.info["transparency"] = 0
    thumb = decode(shrink(encode(img)))
    left = thumb.getpixel((100, 300))
    right = thumb.getpixel((500, 300))
    assert left[0] > 200 and left[1] < 60  # type: ignore[index]  # red kept
    assert all(c > 250 for c in right)  # type: ignore[union-attr]  # clear→white


def test_shrink_converts_a_greyscale_frame() -> None:
    thumb = decode(shrink(encode(Image.new("L", (900, 900), 128))))
    assert thumb.mode == "RGB"


def test_shrink_refuses_what_isnt_an_image() -> None:
    with pytest.raises(NotAnImage):
        shrink(b"not an image")


# --- ThumbnailCache -------------------------------------------------------


PNG = encode(Image.new("RGB", (1200, 900), "green"))


class Bucket:
    """A stand-in fetch that counts its calls."""

    def __init__(self, data: bytes | None = PNG) -> None:
        self.data = data
        self.calls = 0

    def fetch(self) -> bytes | None:
        self.calls += 1
        return self.data


async def test_cache_builds_a_frame_once() -> None:
    cache, bucket = ThumbnailCache(), Bucket()
    first = await cache.get(CHANNEL, (DATE, "000001"), bucket.fetch)
    again = await cache.get(CHANNEL, (DATE, "000001"), bucket.fetch)
    assert first is not None and first is again
    assert decode(first.jpeg).size == (640, 480)
    assert first.etag.startswith('"') and first.etag.endswith('"')
    assert bucket.calls == 1
    cache.close()


async def test_requests_for_one_frame_share_a_build() -> None:
    cache = ThumbnailCache()
    release = threading.Event()
    calls = 0

    def fetch() -> bytes:
        nonlocal calls
        calls += 1
        release.wait(5)
        return PNG

    waits = [
        asyncio.create_task(cache.get(CHANNEL, (DATE, "000001"), fetch))
        for _ in range(5)
    ]
    await asyncio.sleep(0)  # every request is now waiting on the build
    release.set()
    thumbs = await asyncio.gather(*waits)
    assert calls == 1
    assert len({id(t) for t in thumbs}) == 1
    cache.close()


async def test_an_older_frame_is_served_but_not_kept() -> None:
    cache, bucket = ThumbnailCache(), Bucket()
    await cache.get(CHANNEL, (DATE, "000002"), bucket.fetch)
    older = await cache.get(CHANNEL, (DATE, "000001"), bucket.fetch)
    assert older is not None and older.frame == (DATE, "000001")
    await cache.get(CHANNEL, (DATE, "000002"), bucket.fetch)
    assert bucket.calls == 2  # the newest stayed cached
    await cache.get(CHANNEL, (DATE, "000003"), bucket.fetch)
    await cache.get(CHANNEL, (DATE, "000002"), bucket.fetch)
    assert bucket.calls == 4  # a newer frame replaced it
    cache.close()


async def test_channels_are_kept_apart() -> None:
    cache, bucket = ThumbnailCache(), Bucket()
    other = ("test", "lsstcam", "focal_plane_mosaic")
    await cache.get(CHANNEL, (DATE, "000005"), bucket.fetch)
    await cache.get(other, (DATE, "000001"), bucket.fetch)
    await cache.get(CHANNEL, (DATE, "000005"), bucket.fetch)
    assert bucket.calls == 2
    cache.close()


async def test_a_missing_frame_is_none_and_not_kept() -> None:
    cache, bucket = ThumbnailCache(), Bucket(data=None)
    assert await cache.get(CHANNEL, (DATE, "000001"), bucket.fetch) is None
    assert await cache.get(CHANNEL, (DATE, "000001"), bucket.fetch) is None
    assert bucket.calls == 2
    cache.close()


async def test_an_unreadable_frame_raises() -> None:
    cache = ThumbnailCache()
    with pytest.raises(NotAnImage):
        await cache.get(CHANNEL, (DATE, "000001"), Bucket(data=b"x").fetch)
    cache.close()


async def test_a_viewer_leaving_doesnt_cancel_the_build() -> None:
    cache = ThumbnailCache()
    release = threading.Event()
    calls = 0

    def fetch() -> bytes:
        nonlocal calls
        calls += 1
        release.wait(5)
        return PNG

    leaving = asyncio.create_task(cache.get(CHANNEL, (DATE, "000001"), fetch))
    await asyncio.sleep(0)
    leaving.cancel()
    staying = asyncio.create_task(cache.get(CHANNEL, (DATE, "000001"), fetch))
    await asyncio.sleep(0)
    release.set()
    assert await staying is not None
    assert calls == 1
    with pytest.raises(asyncio.CancelledError):
        await leaving
    cache.close()


async def test_close_cancels_builds_running_and_queued() -> None:
    cache = ThumbnailCache(workers=1)
    started, release = threading.Event(), threading.Event()
    queued_bucket = Bucket()

    def blocking() -> bytes:
        started.set()
        release.wait(5)
        return PNG

    running = asyncio.create_task(cache.get(CHANNEL, (DATE, "000001"), blocking))
    queued = asyncio.create_task(
        cache.get(("test", "lsstcam", "imexam"), (DATE, "000001"), queued_bucket.fetch)
    )
    # Once the one thread is busy, the second build is queued behind it.
    await asyncio.to_thread(started.wait, 5)
    cache.close()
    release.set()
    for wait in (running, queued):
        with pytest.raises(asyncio.CancelledError):
            await wait
    assert queued_bucket.calls == 0


# --- the route ------------------------------------------------------------


def frame_key(seq: str) -> str:
    """A PNG frame's key under the bucket's naming convention."""
    return (
        f"lsstcam/{DATE}/witness_detector/{seq}/"
        f"lsstcam_witness_detector_{DATE}_{seq}.png"
    )


def thumb_url(
    seq: str, filename: str = "image.png", channel: str = "witness_detector"
) -> str:
    return (
        f"/api/locations/test/cameras/lsstcam/channels/{channel}/{DATE}/{seq}"
        f"/thumb/{filename}"
    )


@pytest.fixture
def client(settings: Settings, s3_bucket: None) -> Iterator[TestClient]:
    """An app over a bucket holding a frame, a legacy-named one and junk."""
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.put_object(
        Bucket=TEST_BUCKET,
        Key=frame_key("000001"),
        Body=encode(Image.new("RGBA", (1600, 1200), (0, 0, 255, 255))),
    )
    s3.put_object(
        Bucket=TEST_BUCKET,
        Key=f"lsstcam/{DATE}/witness_detector/000002/legacy.jpg",
        Body=encode(Image.new("RGB", (1200, 1200), "red"), "JPEG"),
    )
    s3.put_object(Bucket=TEST_BUCKET, Key=frame_key("000003"), Body=b"x")
    with PrefixedTestClient(create_app(settings)) as c:
        yield c


def test_thumbnail_is_a_shrunk_jpeg(client: TestClient) -> None:
    resp = client.get(thumb_url("000001"))
    assert resp.status_code == 200
    assert resp.headers["Content-Type"] == "image/jpeg"
    assert "max-age" in resp.headers["Cache-Control"]
    assert decode(resp.content).size == (640, 480)


def test_thumbnail_revalidates_by_etag(client: TestClient) -> None:
    etag = client.get(thumb_url("000001")).headers["ETag"]
    resp = client.get(thumb_url("000001"), headers={"If-None-Match": etag})
    assert resp.status_code == 304
    assert resp.content == b""
    assert resp.headers["ETag"] == etag


def test_thumbnail_finds_a_legacy_name_by_listing(client: TestClient) -> None:
    resp = client.get(thumb_url("000002", "image.jpg"))
    assert resp.status_code == 200
    assert decode(resp.content).size == (640, 640)


def test_thumbnail_404_when_the_frame_is_missing(client: TestClient) -> None:
    assert client.get(thumb_url("000009")).status_code == 404


def test_thumbnail_404_for_an_unconfigured_channel(client: TestClient) -> None:
    assert client.get(thumb_url("000001", channel="nope")).status_code == 404


@pytest.mark.parametrize("filename", ["image.mp4", "noextension"])
def test_thumbnail_refuses_a_movie_without_fetching_it(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, filename: str
) -> None:
    import lsst.ts.rubintv.api.proxy as proxy

    def fetched(*_a: Any) -> None:
        raise AssertionError("fetched")

    monkeypatch.setattr(proxy, "_read_frame", fetched)
    assert client.get(thumb_url("000001", filename)).status_code == 404


def test_thumbnail_sends_the_browser_to_a_frame_it_cant_read(
    client: TestClient,
) -> None:
    resp = client.get(thumb_url("000003"), follow_redirects=False)
    assert resp.status_code == 307
    assert resp.headers["Location"] == "../image.png"
    followed = client.get(thumb_url("000003"))
    assert followed.status_code == 200
    assert followed.content == b"x"  # the full frame, from the proxy


def test_thumbnail_needs_no_worker_thread(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Like the page data (see test_api), a thumbnail must not queue on the
    # worker-thread pool the full-size proxy fills.
    def no_threads(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("handed to the worker-thread pool")

    monkeypatch.setattr("fastapi.routing.run_in_threadpool", no_threads)
    monkeypatch.setattr("fastapi.dependencies.utils.run_in_threadpool", no_threads)
    assert client.get(thumb_url("000001")).status_code == 200
