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

"""Preview-sized copies of channel frames, built on request.

The location cards and the Channels grid show each channel's latest frame
a few hundred pixels wide, but the frames run to 3000px and 2 MB. A
thumbnail is the frame shrunk to fit ``BOX`` and re-encoded as JPEG:
about a seventh of the bytes for 20-60 ms of work (measured over every
USDF channel's latest frame, 2026-11-10), done once per frame.

Only the newest frame each channel has been asked for is kept, so the
cache holds at most one thumbnail per configured channel. Builds are
shared: concurrent requests for one frame wait on one fetch and one
resize. They run on this module's own threads, so a burst of cold
previews can't take the worker threads FastAPI and the poller use.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from lsst.ts.rubintv.logging import get_logger
from PIL import Image

log = get_logger(__name__)

BOX = 640
"""Longest side of a thumbnail in pixels: twice the widest card, so it
stays sharp on a high-DPI screen."""

QUALITY = 80
"""JPEG quality of a thumbnail."""

IMAGE_EXTS = frozenset({"jpg", "jpeg", "png", "gif", "webp"})
"""Extensions a thumbnail can be made from. Anything else (a movie) is
refused before it's downloaded: it can't be decoded here, and fetching a
whole movie to find that out would be the expensive part."""

Channel = tuple[str, str, str]
"""``(location, camera, channel)``."""

Frame = tuple[str, str]
"""``(date, seq)``, which orders a channel's frames."""


class NotAnImage(Exception):
    """A frame's bytes couldn't be decoded as an image."""


@dataclass(frozen=True)
class Thumbnail:
    """A shrunk frame, ready to send."""

    frame: Frame
    jpeg: bytes
    etag: str


def shrink(data: bytes, box: int = BOX, quality: int = QUALITY) -> bytes:
    """Fit an image within ``box`` x ``box`` and encode it as a JPEG.

    Palette and 1-bit images are expanded first so they're resampled by
    colour rather than by palette index. JPEG has no alpha, so transparent
    pixels are laid over white. A JPEG source is decoded at reduced scale
    (``thumbnail`` drafts it), the main saving on the largest frames.

    Raises:
        NotAnImage: Pillow couldn't read or convert ``data``.
    """
    try:
        with Image.open(io.BytesIO(data)) as src:
            img: Image.Image = src
            if img.mode in ("P", "1"):
                img = img.convert("RGBA")
            img.thumbnail((box, box))
            if "A" in img.getbands():
                rgba = img.convert("RGBA")
                img = Image.new("RGB", rgba.size, "white")
                img.paste(rgba, mask=rgba.getchannel("A"))
            elif img.mode != "RGB":
                img = img.convert("RGB")
            out = io.BytesIO()
            img.save(out, "JPEG", quality=quality)
            return out.getvalue()
    except Exception as exc:  # noqa: BLE001 - any decode failure: no thumb
        raise NotAnImage(str(exc)) from exc


class ThumbnailCache:
    """The newest thumbnail of each channel, built on first request.

    Args:
        workers: Threads for fetching and shrinking. Fetches mostly wait
            on S3, so several run at once.
        resizers: How many shrinks may run at once. Each is CPU-bound and
            holds a decoded frame (up to ~25 MB), so fewer.
    """

    def __init__(self, *, workers: int = 8, resizers: int = 2) -> None:
        self._executor = ThreadPoolExecutor(
            max_workers=workers, thread_name_prefix="thumbs"
        )
        self._resizers = asyncio.Semaphore(resizers)
        self._newest: dict[Channel, Thumbnail] = {}
        self._building: dict[
            tuple[Channel, Frame], asyncio.Future[Thumbnail | None]
        ] = {}

    async def get(
        self,
        channel: Channel,
        frame: Frame,
        fetch: Callable[[], bytes | None],
    ) -> Thumbnail | None:
        """The thumbnail of ``frame``, built from ``fetch`` if not cached.

        ``fetch`` runs on this cache's threads and returns the frame's
        bytes, or ``None`` if it isn't in the bucket (then so is this).

        Raises:
            NotAnImage: The frame couldn't be decoded.
        """
        held = self._newest.get(channel)
        if held is not None and held.frame == frame:
            return held
        key = (channel, frame)
        build = self._building.get(key)
        if build is None:
            build = asyncio.ensure_future(self._build(channel, frame, fetch))
            self._building[key] = build
            build.add_done_callback(lambda _: self._building.pop(key, None))
        # Shielded: a viewer who leaves cancels its own wait, not the build
        # that others are waiting on and that fills the cache. (If all of
        # them leave, shield marks a failed build's exception as read.)
        return await asyncio.shield(build)

    async def _build(
        self,
        channel: Channel,
        frame: Frame,
        fetch: Callable[[], bytes | None],
    ) -> Thumbnail | None:
        loop = asyncio.get_running_loop()
        start = time.perf_counter()
        data = await loop.run_in_executor(self._executor, fetch)
        if data is None:
            return None
        fetched = time.perf_counter()
        async with self._resizers:
            shrinking = time.perf_counter()
            jpeg = await loop.run_in_executor(self._executor, shrink, data)
        done = time.perf_counter()
        thumb = Thumbnail(
            frame, jpeg, f'"{hashlib.blake2b(jpeg, digest_size=8).hexdigest()}"'
        )
        # Keep it only if it's the channel's newest: a request for an older
        # frame is served but mustn't evict the one the cards show.
        held = self._newest.get(channel)
        if held is None or frame >= held.frame:
            self._newest[channel] = thumb
        location, camera, name = channel
        log.info(
            "thumbs.built",
            location=location,
            camera=camera,
            channel=name,
            date=frame[0],
            seq=frame[1],
            bytes=len(data),
            thumb_bytes=len(jpeg),
            fetch_ms=round((fetched - start) * 1000),
            shrink_ms=round((done - shrinking) * 1000),
        )
        return thumb

    def close(self) -> None:
        """Cancel builds in progress and stop the threads.

        Cancelled rather than left to run: a build past its fetch would
        otherwise fail on the stopped threads when it went to shrink.
        """
        for build in self._building.values():
            build.cancel()
        self._executor.shutdown(wait=False, cancel_futures=True)
