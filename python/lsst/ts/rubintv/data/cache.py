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

"""Disk cache for warm starts — a speed-up, never a source of truth.

Layout is file-per-``(location, camera, date)`` under the cache dir, so a
single changed day rewrites one small JSON file rather than reserializing
everything (the old monolithic-pickle pain). Each file carries a version
tag; a mismatch or any corruption discards that slice and it is rebuilt
from S3. Missing cache dir disables caching silently.

    {cache_dir}/v2/{location}/{camera}/{date}.json
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from lsst.ts.rubintv.data.events import SeqNum
from lsst.ts.rubintv.data.index import DateIndex, ExtInfo, PerDayRef
from lsst.ts.rubintv.logging import get_logger

log = get_logger(__name__)

# v3 dropped seq_files/per_day_keys and reduced per_day to a seq sentinel:
# the index records presence, and the proxy resolves filenames at request
# time, so none of that per-object string data needs persisting. A version
# bump discards older slices — by design they cost a cold rescan, never a
# migration.
CACHE_VERSION = "v3"


def brief_error(exc: OSError, root: Path) -> str:
    """An OS error as the Status page words it: what went wrong and, for a
    file under ``root``, where, relative to it. The page names the cache dir
    once already; the full path in every line buries the rest."""
    what = exc.strerror or str(exc)
    if exc.filename is None:
        return what
    path = Path(os.fsdecode(exc.filename))
    if path == root:
        return what
    if path.is_relative_to(root):
        path = path.relative_to(root)
    return f"{what}: {path}"


class DiskCache:
    """Reads/writes per-date index slices as JSON. No-op if dir is None."""

    def __init__(self, cache_dir: Path | None) -> None:
        self._root = cache_dir / CACHE_VERSION if cache_dir else None
        # Probe writability once up front: cache_dir defaults to the PVC
        # mount (/scratch), which not every pod (or dev machine) has. An
        # unusable dir means "no cache", not a crash or a warning per write.
        if self._root is not None:
            try:
                self._root.mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                log.warning("cache.disabled", dir=str(self._root), error=str(exc))
                self._root = None
        self.write_error: str | None = None
        """What the most recent write or delete failed with (see
        ``brief_error``); ``None`` once one succeeds, and before any. The
        failures are only warnings in the log, so this is what lets the
        Status page say the cache isn't being kept."""

    @property
    def enabled(self) -> bool:
        return self._root is not None

    def _path(self, location: str, camera: str, date: str) -> Path:
        assert self._root is not None
        return self._root / location / camera / f"{date}.json"

    def write(self, location: str, camera: str, date: str, index: DateIndex) -> None:
        """Persist one date's index slice. Failures are non-fatal."""
        if self._root is None:
            return
        path = self._path(location, camera, date)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(_encode(index)))
            tmp.replace(path)  # atomic swap
        except OSError as exc:
            # PVC write failure mid-run must not crash the app.
            self.write_error = brief_error(exc, self._root.parent)
            log.warning("cache.write.failed", path=str(path), error=str(exc))
        else:
            self.write_error = None

    def delete(self, location: str, camera: str, date: str) -> None:
        """Remove one cached slice (e.g. a date pruned as stale). No-op if
        caching is disabled or the file is already gone; failures are logged,
        not fatal — a PVC hiccup must not crash the scan loop."""
        if self._root is None:
            return
        path = self._path(location, camera, date)
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            self.write_error = brief_error(exc, self._root.parent)
            log.warning("cache.delete.failed", path=str(path), error=str(exc))
        else:
            self.write_error = None

    def clear(self) -> int:
        """Delete every cached slice. Returns the number of files removed.

        Used by the admin 'flush historical cache' action so the next scan
        cold-rebuilds from S3. No-op (returns 0) when caching is disabled or
        the dir doesn't exist. Individual unlink failures are logged, not
        fatal — a PVC hiccup must not crash the request.
        """
        if self._root is None or not self._root.exists():
            return 0
        removed = 0
        for path in self._root.glob("*/*/*.json"):
            try:
                path.unlink()
                removed += 1
            except OSError as exc:
                log.warning("cache.clear.failed", path=str(path), error=str(exc))
        log.info("cache.cleared", files=removed)
        return removed

    def load_all(self) -> dict[tuple[str, str], dict[str, DateIndex]]:
        """Load every cached slice. Bad files are skipped, not fatal."""
        result: dict[tuple[str, str], dict[str, DateIndex]] = {}
        if self._root is None or not self._root.exists():
            return result
        for path in self._root.glob("*/*/*.json"):
            location, camera = path.parent.parent.name, path.parent.name
            date = path.stem
            try:
                index = _decode(json.loads(path.read_text()))
            except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
                # TypeError/AttributeError cover version-valid JSON of the
                # wrong shape (e.g. a corrupted slice whose "channels" is not
                # a dict) — load_all runs unguarded in the lifespan, and a
                # bad cache file must cost a cold rescan, never a crash loop.
                log.warning("cache.load.skip", path=str(path), error=str(exc))
                continue
            result.setdefault((location, camera), {})[date] = index
        return result


@dataclass(frozen=True)
class EntryUsage:
    """Disk taken by one top-level entry of the cache dir."""

    path: Path
    files: int
    bytes: int
    error: str | None = None
    """Why a directory in it couldn't be listed, if one couldn't: the counts
    then leave out whatever is under it."""


def dir_usage(root: Path) -> list[EntryUsage]:
    """Size up each top-level entry of ``root`` (sorted by name).

    Bytes are allocated blocks — what ``du`` reports and what fills the PVC —
    not apparent sizes: thousands of small slices each round up to whole
    blocks. Unreadable parts (e.g. a root-owned ``lost+found``) are skipped,
    not fatal, and noted on their entry. Blocking I/O over every cached
    file: call it off the loop.
    """
    try:
        children = sorted(root.iterdir())
    except OSError:
        return []
    entries = []
    for child in children:
        files, size, error = _tree_usage(child)
        brief = None if error is None else brief_error(error, root)
        entries.append(EntryUsage(child, files, size, brief))
    return entries


def _tree_usage(path: Path) -> tuple[int, int, OSError | None]:
    """(file count, allocated bytes, first listing error) under ``path``, a
    file or a directory."""
    errors: list[OSError] = []
    if path.is_dir():
        walk = os.walk(path, onerror=errors.append)
        paths = [os.path.join(d, n) for d, _, names in walk for n in names]
    else:
        paths = [str(path)]
    files = size = 0
    for p in paths:
        try:
            st = os.lstat(p)
        except OSError:
            continue
        files += 1
        size += st.st_blocks * 512
    return files, size, errors[0] if errors else None


@dataclass(frozen=True)
class DirReport:
    """What a look at the cache dir found (see ``CacheInspector``)."""

    entries: list[EntryUsage]
    unreadable: str | None
    """Why the dir itself couldn't be listed, if it couldn't (``entries`` is
    then empty)."""
    writable: bool
    """Whether the server's user may write to the index's own directory. A
    check of permissions and of a read-only mount, not a write: a full
    volume passes it."""
    volume_total: int | None
    volume_free: int | None


def _inspect(root: Path) -> DirReport:
    unreadable = None
    try:
        with os.scandir(root):
            pass
    except OSError as exc:
        unreadable = brief_error(exc, root)
    try:
        volume = shutil.disk_usage(root)
    except OSError:
        total = free = None
    else:
        total, free = volume.total, volume.free
    return DirReport(
        entries=[] if unreadable else dir_usage(root),
        unreadable=unreadable,
        writable=os.access(root / CACHE_VERSION, os.W_OK | os.X_OK),
        volume_total=total,
        volume_free=free,
    )


class CacheInspector:
    """The Status page's look at the cache dir: what it holds, and whether
    it can be read and written.

    It stats every cached file, so it runs on a worker thread, one look at a
    time: requests that overlap share it. A volume that has hung would hold
    that thread for good, and one more for every later look, so a look is
    waited on for only so long, and while one is outstanding the answer is
    that the volume isn't responding, with no new look begun.
    """

    def __init__(self) -> None:
        self._look: asyncio.Task[DirReport] | None = None
        self._started = 0.0

    async def report(self, root: Path, wait: float) -> DirReport | None:
        """What a look at ``root`` finds, or ``None`` if the volume hasn't
        answered within ``wait`` seconds of the look beginning."""
        look = self._look
        if look is None or look.done():
            self._started = time.monotonic()
            look = self._look = asyncio.create_task(asyncio.to_thread(_inspect, root))
        remaining = self._started + wait - time.monotonic()
        if remaining > 0:
            await asyncio.wait({look}, timeout=remaining)
        return look.result() if look.done() else None

    def waited_seconds(self) -> float:
        """How long ago the look now outstanding began."""
        return time.monotonic() - self._started


def _encode(index: DateIndex) -> dict[str, object]:
    return {
        "version": CACHE_VERSION,
        "channels": {ch: sorted(seqs, key=str) for ch, seqs in index.channels.items()},
        "extensions": {
            ch: {"default": e.default, "exceptions": _str_keys(e.exceptions)}
            for ch, e in index.extensions.items()
        },
        "per_day": {
            ch: {"seq": ref.seq, "ext": ref.ext} for ch, ref in index.per_day.items()
        },
        "night_report_keys": sorted(index.night_report_keys),
        "has_metadata": index.has_metadata,
        "metadata_etag": index.metadata_etag,
    }


def _decode(raw: dict[str, Any]) -> DateIndex:
    if raw.get("version") != CACHE_VERSION:
        raise ValueError(f"version mismatch: {raw.get('version')}")
    channels: dict[str, set[SeqNum]] = {
        ch: {_coerce_seq(s) for s in seqs} for ch, seqs in raw["channels"].items()
    }
    extensions: dict[str, ExtInfo] = {
        ch: ExtInfo(
            default=e.get("default"),
            exceptions={_coerce_seq(k): v for k, v in e.get("exceptions", {}).items()},
        )
        for ch, e in raw["extensions"].items()
    }
    return DateIndex(
        channels=channels,
        extensions=extensions,
        per_day={
            ch: PerDayRef(seq=str(v["seq"]), ext=str(v["ext"]))
            for ch, v in raw["per_day"].items()
        },
        night_report_keys=set(raw["night_report_keys"]),
        # Both added within v3. Slices written before ``has_metadata`` held
        # an ETag only where the date had metadata, so infer it from that.
        has_metadata=raw.get("has_metadata", raw.get("metadata_etag") is not None),
        metadata_etag=raw.get("metadata_etag"),
    )


def _coerce_seq(raw: object) -> SeqNum:
    s = str(raw)
    return int(s) if s.isdigit() else s


def _str_keys(d: dict[SeqNum, str]) -> dict[str, str]:
    return {str(k): v for k, v in d.items()}
