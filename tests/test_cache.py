"""DiskCache: round-trip, version mismatch, and corruption tolerance."""

from __future__ import annotations

from pathlib import Path

from lsst.ts.rubintv.data.cache import DiskCache
from lsst.ts.rubintv.data.index import DateIndex, ExtInfo


def sample_index() -> DateIndex:
    return DateIndex(
        channels={"witness_detector": {1, 2, 5}},
        extensions={"witness_detector": ExtInfo(default="png", exceptions={2: "jpg"})},
        per_day={"movies": "auxtel/2026-04-10/movies/final/m.mp4"},
        night_report_keys={"lsstcam/2026-04-10/night_report/s_md.json"},
    )


def test_disabled_when_no_dir() -> None:
    cache = DiskCache(None)
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
    assert idx.per_day["movies"].endswith("m.mp4")
    assert idx.night_report_keys == {"lsstcam/2026-04-10/night_report/s_md.json"}


def test_corrupt_file_is_skipped(tmp_path: Path) -> None:
    cache = DiskCache(tmp_path)
    cache.write("local", "lsstcam", "2026-04-10", sample_index())
    # Corrupt the slice.
    bad = next((tmp_path / "v1").glob("*/*/*.json"))
    bad.write_text("{not json")
    # Loading skips the bad slice without raising.
    assert cache.load_all() == {}


def test_version_mismatch_skipped(tmp_path: Path) -> None:
    cache = DiskCache(tmp_path)
    cache.write("local", "lsstcam", "2026-04-10", sample_index())
    slice_path = next((tmp_path / "v1").glob("*/*/*.json"))
    slice_path.write_text('{"version": "v0", "channels": {}}')
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
