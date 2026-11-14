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

"""DiskCache: round-trip, version mismatch, and corruption tolerance."""

from __future__ import annotations

import json
from pathlib import Path

from lsst.ts.rubintv.data.cache import CACHE_VERSION, DiskCache
from lsst.ts.rubintv.data.index import DateIndex, ExtInfo, PerDayRef


def sample_index() -> DateIndex:
    return DateIndex(
        channels={"witness_detector": {1, 2, 5}},
        extensions={"witness_detector": ExtInfo(default="png", exceptions={2: "jpg"})},
        per_day={"movies": PerDayRef(seq="final", ext="mp4")},
        night_report_keys={"lsstcam/2026-04-10/night_report/s_md.json"},
        has_metadata=True,
        metadata_etag='"abc123"',
    )


def test_disabled_when_no_dir() -> None:
    cache = DiskCache(None)
    assert cache.enabled is False
    cache.write("local", "lsstcam", "2026-04-10", sample_index())  # no-op
    assert cache.load_all() == {}


def test_disabled_when_dir_unusable(tmp_path: Path) -> None:
    # cache_dir defaults to the /scratch PVC mount, which pods without a
    # PVC don't have: an uncreatable directory must disable the cache at
    # construction, not crash or warn on every write.
    blocker = tmp_path / "blocker"
    blocker.write_text("a file where the cache dir should go")
    cache = DiskCache(blocker / "cache")
    assert cache.enabled is False
    cache.write("local", "lsstcam", "2026-04-10", sample_index())  # no-op
    assert cache.load_all() == {}


def test_round_trip(tmp_path: Path) -> None:
    cache = DiskCache(tmp_path)
    cache.write("local", "lsstcam", "2026-04-10", sample_index())

    loaded = cache.load_all()
    idx = loaded[("local", "lsstcam")]["2026-04-10"]
    assert idx.channels["witness_detector"] == {1, 2, 5}
    assert idx.extensions["witness_detector"].for_seq(2) == "jpg"
    assert idx.extensions["witness_detector"].for_seq(1) == "png"
    # Seq + extension survive the round trip; the object key never does, since
    # the proxy resolves the filename by listing the prefix at request time.
    assert idx.per_day["movies"] == PerDayRef(seq="final", ext="mp4")
    assert idx.night_report_keys == {"lsstcam/2026-04-10/night_report/s_md.json"}
    assert idx.has_metadata
    assert idx.metadata_etag == '"abc123"'


def test_slice_without_has_metadata_infers_it_from_the_etag(tmp_path: Path) -> None:
    # Slices written before has_metadata held an ETag only where the date had
    # metadata, so a warm start must not forget it (or re-announce it).
    cache = DiskCache(tmp_path)
    cache.write("local", "lsstcam", "2026-04-10", sample_index())
    cache.write("local", "lsstcam", "2026-04-11", DateIndex(channels={"c": {1}}))
    for path in (tmp_path / CACHE_VERSION).glob("*/*/*.json"):
        raw = json.loads(path.read_text())
        del raw["has_metadata"]
        path.write_text(json.dumps(raw))
    loaded = cache.load_all()[("local", "lsstcam")]
    assert loaded["2026-04-10"].has_metadata
    assert not loaded["2026-04-11"].has_metadata


def test_corrupt_file_is_skipped(tmp_path: Path) -> None:
    cache = DiskCache(tmp_path)
    cache.write("local", "lsstcam", "2026-04-10", sample_index())
    # Corrupt the slice.
    bad = next((tmp_path / CACHE_VERSION).glob("*/*/*.json"))
    bad.write_text("{not json")
    # Loading skips the bad slice without raising.
    assert cache.load_all() == {}


def test_version_mismatch_skipped(tmp_path: Path) -> None:
    cache = DiskCache(tmp_path)
    cache.write("local", "lsstcam", "2026-04-10", sample_index())
    slice_path = next((tmp_path / CACHE_VERSION).glob("*/*/*.json"))
    slice_path.write_text('{"version": "v0", "channels": {}}')
    assert cache.load_all() == {}


def test_wrong_shape_file_is_skipped(tmp_path: Path) -> None:
    # Version-valid JSON of the wrong shape (here "channels" values are ints,
    # not lists) raises TypeError inside _decode. load_all runs unguarded in
    # the lifespan, so a bad slice must cost a cold rescan, never a
    # crash-looping pod.
    cache = DiskCache(tmp_path)
    cache.write("local", "lsstcam", "2026-04-10", sample_index())
    bad = next((tmp_path / CACHE_VERSION).glob("*/*/*.json"))
    bad.write_text(
        f'{{"version": "{CACHE_VERSION}", "channels": {{"c": 5}}, '
        '"extensions": {}, "per_day": {}, "night_report_keys": []}'
    )
    assert cache.load_all() == {}


def test_clear_removes_all_slices(tmp_path: Path) -> None:
    cache = DiskCache(tmp_path)
    cache.write("local", "lsstcam", "2026-04-10", sample_index())
    cache.write("local", "lsstcam", "2026-04-09", sample_index())
    assert len(cache.load_all()[("local", "lsstcam")]) == 2

    removed = cache.clear()
    assert removed == 2
    assert cache.load_all() == {}


def test_clear_disabled_is_noop() -> None:
    assert DiskCache(None).clear() == 0


def test_delete_removes_one_slice(tmp_path: Path) -> None:
    cache = DiskCache(tmp_path)
    cache.write("local", "auxtel", "1970-01-01", sample_index())
    cache.write("local", "auxtel", "2026-04-10", sample_index())
    cache.delete("local", "auxtel", "1970-01-01")
    remaining = cache.load_all()[("local", "auxtel")]
    assert set(remaining) == {"2026-04-10"}


def test_delete_missing_slice_is_noop(tmp_path: Path) -> None:
    # Deleting an already-gone slice must not raise (idempotent eviction).
    cache = DiskCache(tmp_path)
    cache.delete("local", "auxtel", "1970-01-01")


def test_delete_disabled_is_noop() -> None:
    DiskCache(None).delete("local", "auxtel", "1970-01-01")  # no raise


def test_a_failed_write_is_not_fatal(tmp_path: Path) -> None:
    # A PVC hiccup mid-scan must cost a cache slice, not the scan loop: a
    # file sitting where the camera's directory belongs makes the write fail.
    cache = DiskCache(tmp_path)
    (tmp_path / CACHE_VERSION / "local").mkdir(parents=True)
    (tmp_path / CACHE_VERSION / "local" / "lsstcam").write_text("not a dir")
    cache.write("local", "lsstcam", "2026-04-10", sample_index())
    assert cache.load_all() == {}


def test_failed_deletes_are_not_fatal(tmp_path: Path) -> None:
    # A slice that can't be unlinked (here a directory in its place) is
    # logged and skipped by both the per-date evict and the admin flush,
    # which still removes everything else.
    cache = DiskCache(tmp_path)
    cache.write("local", "lsstcam", "2026-04-10", sample_index())
    stuck = tmp_path / CACHE_VERSION / "local" / "lsstcam" / "2026-04-11.json"
    stuck.mkdir()
    cache.delete("local", "lsstcam", "2026-04-11")
    assert cache.clear() == 1
    assert stuck.is_dir()
    assert cache.load_all() == {}
