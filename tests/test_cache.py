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

import asyncio
import json
import os
import threading
from pathlib import Path

import pytest
from lsst.ts.rubintv.data import cache as cache_mod
from lsst.ts.rubintv.data.cache import (
    CACHE_VERSION,
    CacheInspector,
    DirReport,
    DiskCache,
    EntryUsage,
    brief_error,
    dir_usage,
)
from lsst.ts.rubintv.data.index import DateIndex, ExtInfo, PerDayRef


def sample_index() -> DateIndex:
    return DateIndex(
        channels={"witness_detector": {1, 2, 5}},
        extensions={"witness_detector": ExtInfo(default="png", exceptions={2: "jpg"})},
        per_day={"movies": PerDayRef(seq="final", ext="mp4")},
        night_report_keys={"lsstcam/2026-04-10/night_report/s_md.json"},
        night_report_etags={"lsstcam/2026-04-10/night_report/s_md.json": '"n1"'},
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
    assert idx.night_report_etags == {
        "lsstcam/2026-04-10/night_report/s_md.json": '"n1"'
    }
    assert idx.has_metadata
    assert idx.metadata_etag == '"abc123"'


def test_slice_without_night_report_etags_loads_with_none(tmp_path: Path) -> None:
    # Slices written before the night report's ETags were kept: the keys
    # load, and the first listing supplies the ETags.
    cache = DiskCache(tmp_path)
    cache.write("local", "lsstcam", "2026-04-10", sample_index())
    (path,) = (tmp_path / CACHE_VERSION).glob("*/*/*.json")
    raw = json.loads(path.read_text())
    del raw["night_report_etags"]
    path.write_text(json.dumps(raw))
    idx = cache.load_all()[("local", "lsstcam")]["2026-04-10"]
    assert idx.night_report_keys == {"lsstcam/2026-04-10/night_report/s_md.json"}
    assert idx.night_report_etags == {}


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


def test_the_last_write_or_delete_to_fail_is_remembered(tmp_path: Path) -> None:
    # The failures are only warnings in the log; this is what the Status
    # page goes by. It clears when a write next succeeds.
    cache = DiskCache(tmp_path)
    assert cache.write_error is None
    (tmp_path / CACHE_VERSION / "local").mkdir(parents=True)
    (tmp_path / CACHE_VERSION / "local" / "lsstcam").write_text("not a dir")
    cache.write("local", "lsstcam", "2026-04-10", sample_index())
    # Where it failed is given from the cache dir, not the filesystem root.
    assert cache.write_error is not None
    assert cache.write_error.endswith(f": {CACHE_VERSION}/local/lsstcam")
    cache.write("local", "auxtel", "2026-04-10", sample_index())
    assert cache.write_error is None

    stuck = tmp_path / CACHE_VERSION / "local" / "auxtel" / "2026-04-11.json"
    stuck.mkdir()
    cache.delete("local", "auxtel", "2026-04-11")
    assert cache.write_error is not None and "2026-04-11" in cache.write_error
    cache.delete("local", "auxtel", "2026-04-10")
    assert cache.write_error is None


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


def test_dir_usage_sizes_each_top_level_entry(tmp_path: Path) -> None:
    # Files in nested dirs count toward their top-level entry; a loose file
    # is an entry of its own. Random bytes, so no filesystem stores them
    # inline or compressed: each allocates at least its own length.
    (tmp_path / "v3" / "local" / "lsstcam").mkdir(parents=True)
    (tmp_path / "v3" / "local" / "lsstcam" / "a.json").write_bytes(os.urandom(8192))
    (tmp_path / "v3" / "local" / "b.json").write_bytes(os.urandom(8192))
    (tmp_path / "stray.tmp").write_bytes(os.urandom(8192))
    (tmp_path / "empty").mkdir()
    usage = {e.path.name: (e.files, e.bytes) for e in dir_usage(tmp_path)}
    assert {name: files for name, (files, _) in usage.items()} == {
        "empty": 0,
        "stray.tmp": 1,
        "v3": 2,
    }
    assert usage["empty"][1] == 0
    assert usage["stray.tmp"][1] >= 8192
    assert usage["v3"][1] >= 2 * 8192
    assert [e.path for e in dir_usage(tmp_path)][0] == tmp_path / "empty"


def test_dir_usage_of_a_missing_dir_is_empty(tmp_path: Path) -> None:
    assert dir_usage(tmp_path / "absent") == []


def test_dir_usage_skips_files_it_cannot_stat(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A slice deleted between the walk listing it and the stat (the scan
    # evicting a date) is skipped, not fatal.
    (tmp_path / "v3").mkdir()
    (tmp_path / "v3" / "kept.json").write_text("{}")
    (tmp_path / "v3" / "gone.json").write_text("{}")
    real_lstat = os.lstat

    def lstat(path: str) -> os.stat_result:
        if path.endswith("gone.json"):
            raise FileNotFoundError(path)
        return real_lstat(path)

    monkeypatch.setattr(os, "lstat", lstat)
    [entry] = dir_usage(tmp_path)
    assert entry.files == 1


def test_brief_error_names_a_file_from_the_cache_dir(tmp_path: Path) -> None:
    inside = PermissionError(13, "Permission denied", str(tmp_path / "v3" / "a"))
    assert brief_error(inside, tmp_path) == "Permission denied: v3/a"
    # The dir itself needs no naming, and an error may name no file at all.
    assert (
        brief_error(PermissionError(13, "Permission denied", str(tmp_path)), tmp_path)
        == "Permission denied"
    )
    assert (
        brief_error(OSError(28, "No space left on device"), tmp_path)
        == "No space left on device"
    )
    assert brief_error(OSError("odd"), tmp_path) == "odd"
    # Anything outside it keeps its whole path.
    assert (
        brief_error(
            FileNotFoundError(2, "No such file or directory", "/elsewhere/x"), tmp_path
        )
        == "No such file or directory: /elsewhere/x"
    )


def _deny_listing(monkeypatch: pytest.MonkeyPatch, denied: Path) -> None:
    """Make listing ``denied`` fail as it does without permission. Not a
    chmod: that stops nothing when the tests run as root."""
    real_scandir = os.scandir

    def scandir(path: object) -> object:
        if Path(str(path)) == denied:
            raise PermissionError(13, "Permission denied", str(path))
        return real_scandir(path)  # type: ignore[call-overload]

    monkeypatch.setattr(os, "scandir", scandir)


def test_dir_usage_notes_a_directory_it_cannot_list(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # It used to come back as 0 files and 0 bytes, like an empty one.
    (tmp_path / "v3" / "local").mkdir(parents=True)
    (tmp_path / "v3" / "a.json").write_text("{}")
    (tmp_path / "guide").mkdir()
    _deny_listing(monkeypatch, tmp_path / "v3" / "local")
    usage = {e.path.name: e for e in dir_usage(tmp_path)}
    assert usage["guide"].error is None
    assert usage["v3"].files == 1
    assert usage["v3"].error == "Permission denied: v3/local"


def test_inspect_reports_what_the_dir_allows(tmp_path: Path) -> None:
    DiskCache(tmp_path).write("local", "lsstcam", "2026-04-10", sample_index())
    report = cache_mod._inspect(tmp_path)
    assert report.unreadable is None
    assert report.writable is True
    assert report.volume_total is not None and report.volume_free is not None
    # Sizing what the dir holds is the inspector's, done less often.
    assert report.entries == [] and report.sized_age is None


def test_inspect_says_why_the_dir_cannot_be_listed_or_written(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    DiskCache(tmp_path)
    _deny_listing(monkeypatch, tmp_path)
    monkeypatch.setattr(os, "access", lambda path, mode: False)
    report = cache_mod._inspect(tmp_path)
    assert report.unreadable == "Permission denied"
    assert report.writable is False


CHECKED = DirReport([], None, None, True, None, None)


class _Held:
    """Stands in for a call on the cache volume: counts its calls, and holds
    each until released."""

    def __init__(self, result: object) -> None:
        self.calls = 0
        self.entered = threading.Event()
        self.release = threading.Event()
        self._result = result

    def __call__(self, root: Path) -> object:
        self.calls += 1
        self.entered.set()
        self.release.wait()
        return self._result


async def test_the_inspector_reports_the_check_and_the_sizes(tmp_path: Path) -> None:
    DiskCache(tmp_path).write("local", "lsstcam", "2026-04-10", sample_index())
    report = await CacheInspector().report(tmp_path, 5.0, 60.0)
    assert report is not None
    assert [(e.path.name, e.files) for e in report.entries] == [(CACHE_VERSION, 1)]
    assert report.sized_age is not None and report.sized_age >= 0.0
    assert report.unreadable is None and report.writable is True


async def test_a_check_that_does_not_return_is_waited_on_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A hung volume holds the check's thread for good. The first request
    # waits out the limit; later ones are answered at once, and none starts
    # another check (and another held thread) beside it.
    check = _Held(CHECKED)
    monkeypatch.setattr(cache_mod, "_inspect", check)
    monkeypatch.setattr(cache_mod, "dir_usage", lambda root: [])
    inspector = CacheInspector()
    try:
        assert await inspector.report(tmp_path, 0.01, 60.0) is None
        # The limit counts from when the check began, so it has already run
        # out for whoever asks next.
        again = inspector.report(tmp_path, 0.0, 60.0)
        assert await asyncio.wait_for(again, 5.0) is None
        assert check.calls == 1
        assert inspector.waited_seconds() > 0.0
    finally:
        check.release.set()
    # The volume answers: the next request makes a check of its own.
    held = inspector._check
    assert held is not None
    await asyncio.wait_for(held, 5.0)
    assert await inspector.report(tmp_path, 5.0, 60.0) is not None
    assert check.calls == 2


async def test_requests_that_overlap_share_one_check_and_one_sizing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    check = _Held(CHECKED)
    sizing = _Held([])
    monkeypatch.setattr(cache_mod, "_inspect", check)
    monkeypatch.setattr(cache_mod, "dir_usage", sizing)
    inspector = CacheInspector()
    first = asyncio.ensure_future(inspector.report(tmp_path, 5.0, 60.0))
    second = asyncio.ensure_future(inspector.report(tmp_path, 5.0, 60.0))
    await asyncio.sleep(0)  # both reach their wait
    check.release.set()
    sizing.release.set()
    reports = await asyncio.wait_for(asyncio.gather(first, second), 5.0)
    assert [r is not None and r.sized_age is not None for r in reports] == [True, True]
    assert (check.calls, sizing.calls) == (1, 1)


async def test_a_slow_sizing_is_not_a_volume_in_trouble(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Sizing 6,000 slices on the USDF PVC took up to a minute while a sweep
    # was writing to it. That used to be waited on for 10 s and then thrown
    # away, sizing after sizing, so the page said the volume had stopped
    # responding for as long as the sweep ran.
    sized = [EntryUsage(tmp_path / CACHE_VERSION, 7, 4096)]
    sizing = _Held(sized)
    monkeypatch.setattr(cache_mod, "dir_usage", sizing)
    inspector = CacheInspector()
    first = asyncio.ensure_future(inspector.report(tmp_path, 30.0, 60.0))
    try:
        assert await asyncio.to_thread(sizing.entered.wait, 5.0)
        # The sizing has now run past the limit (its start is put back, not
        # waited out): a request is answered at once, without the sizes and
        # with no alarm, and doesn't start a second sizing.
        inspector._sizing_started -= 60.0
        report = await asyncio.wait_for(inspector.report(tmp_path, 30.0, 60.0), 5.0)
        assert report is not None
        assert report.entries == [] and report.sized_age is None
        assert sizing.calls == 1
    finally:
        sizing.release.set()
    # However late it finishes, its result is what is served from then on.
    await asyncio.wait_for(first, 5.0)
    report = await inspector.report(tmp_path, 5.0, 60.0)
    assert report is not None
    assert report.entries == sized and report.sized_age is not None
    assert sizing.calls == 1


async def test_sizes_are_kept_until_they_age(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    old = [EntryUsage(tmp_path / CACHE_VERSION, 1, 4096)]
    new = [EntryUsage(tmp_path / CACHE_VERSION, 2, 8192)]
    results = [old, new]
    hold = threading.Event()
    hold.set()

    def dir_usage(root: Path) -> list[EntryUsage]:
        hold.wait()
        return results.pop(0)

    monkeypatch.setattr(cache_mod, "dir_usage", dir_usage)
    inspector = CacheInspector()
    for _ in range(2):
        report = await inspector.report(tmp_path, 5.0, 60.0)
        assert report is not None and report.entries == old
    assert results == [new]
    # Once aged they are sized again, behind the answer: the request gets
    # the sizes there are without waiting for the new ones.
    hold.clear()
    try:
        report = await asyncio.wait_for(inspector.report(tmp_path, 5.0, -1.0), 5.0)
        assert report is not None and report.entries == old
        assert inspector._sizing is not None and not inspector._sizing.done()
    finally:
        hold.set()
    await asyncio.wait_for(inspector._sizing, 5.0)
    report = await inspector.report(tmp_path, 5.0, 60.0)
    assert report is not None and report.entries == new


async def test_a_dir_that_cannot_be_listed_is_not_sized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def dir_usage(root: Path) -> list[EntryUsage]:
        raise AssertionError("sized a dir that can't be listed")

    _deny_listing(monkeypatch, tmp_path)
    monkeypatch.setattr(cache_mod, "dir_usage", dir_usage)
    report = await CacheInspector().report(tmp_path, 5.0, 60.0)
    assert report is not None
    assert report.unreadable == "Permission denied"
    assert report.entries == [] and report.sized_age is None
