"""Disk cache for warm starts — a speed-up, never a source of truth.

Layout is file-per-``(location, camera, date)`` under the cache dir, so a
single changed day rewrites one small JSON file rather than reserializing
everything (the old monolithic-pickle pain). Each file carries a version
tag; a mismatch or any corruption discards that slice and it is rebuilt
from S3. Missing cache dir disables caching silently.

    {cache_dir}/v1/{location}/{camera}/{date}.json
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from rubintv.data.events import SeqNum
from rubintv.data.index import DateIndex, ExtInfo
from rubintv.logging import get_logger

log = get_logger(__name__)

CACHE_VERSION = "v1"


class DiskCache:
    """Reads/writes per-date index slices as JSON. No-op if dir is None."""

    def __init__(self, cache_dir: Path | None) -> None:
        self._root = cache_dir / CACHE_VERSION if cache_dir else None

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
            log.warning("cache.write.failed", path=str(path), error=str(exc))

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
            except (OSError, ValueError, KeyError) as exc:
                log.warning("cache.load.skip", path=str(path), error=str(exc))
                continue
            result.setdefault((location, camera), {})[date] = index
        return result


def _encode(index: DateIndex) -> dict[str, object]:
    return {
        "version": CACHE_VERSION,
        "channels": {ch: sorted(seqs, key=str) for ch, seqs in index.channels.items()},
        "extensions": {
            ch: {"default": e.default, "exceptions": _str_keys(e.exceptions)}
            for ch, e in index.extensions.items()
        },
        "per_day": index.per_day,
        "night_report_keys": sorted(index.night_report_keys),
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
        per_day=dict(raw["per_day"]),
        night_report_keys=set(raw["night_report_keys"]),
    )


def _coerce_seq(raw: object) -> SeqNum:
    s = str(raw)
    return int(s) if s.isdigit() else s


def _str_keys(d: dict[SeqNum, str]) -> dict[str, str]:
    return {str(k): v for k, v in d.items()}
