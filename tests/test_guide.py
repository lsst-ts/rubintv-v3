"""Observing-block guide: grouping, incremental polling, and the cache."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from lsst.ts.rubintv.data.consdb import ConsDbClient, ConsDbError, QueryResult
from lsst.ts.rubintv.data.guide import (
    TAI_MINUS_UTC,
    BlockGrouper,
    Exposure,
    GuideService,
    day_obs_str,
    exposure_from_record,
    tai_to_utc,
)

T0 = datetime(2025, 4, 12, 0, 30, tzinfo=UTC)
MAX_GAP = timedelta(minutes=15)
COLUMNS = [
    "exposure_id",
    "day_obs",
    "seq_num",
    "science_program",
    "obs_start",
    "obs_end",
]


def exp(
    seq: int,
    program: str,
    begin_min: float,
    *,
    day_obs: int = 20250411,
    dur_s: float = 30,
) -> Exposure:
    begin = T0 + timedelta(minutes=begin_min)
    return Exposure(
        exposure_id=day_obs * 100000 + seq,
        day_obs=day_obs,
        seq_num=seq,
        program=program,
        begin=begin,
        end=begin + timedelta(seconds=dur_s),
    )


def reference_group(exposures: list[Exposure]) -> list[tuple[str, int, int]]:
    """The original guide's ``group_into_blocks`` (scrape_blocks.py), kept
    as the oracle: (program, seq0, seq1) per block."""
    if not exposures:
        return []
    blocks = []
    begin_row = exposures[0]
    for i, row in enumerate(exposures):
        if i == 0:
            continue
        previous = exposures[i - 1]
        same_program = row.program == previous.program
        gap_ok = (row.begin - previous.end) < MAX_GAP
        not_last = i != len(exposures) - 1
        if same_program and gap_ok and not_last:
            continue
        end_row = row if i == len(exposures) - 1 else previous
        blocks.append((end_row.program, begin_row.seq_num, end_row.seq_num))
        begin_row = row
    return blocks


def group_all(exposures: list[Exposure]) -> list[tuple[str, int, int]]:
    g = BlockGrouper(MAX_GAP)
    for e in exposures:
        g.add(e)
    return [(b.program, b.seq_num_0, b.seq_num_1) for b in g.blocks()]


def test_grouping_matches_the_original_guide() -> None:
    exposures = [
        exp(1, "BLOCK-T1", 0),
        exp(2, "BLOCK-T1", 1),
        exp(3, "BLOCK-T1", 2),
        exp(4, "BLOCK-T2", 3),  # program change closes the block
        exp(5, "BLOCK-T2", 4),
        exp(6, "BLOCK-T2", 30),  # 26 min pause: same program, new block
        exp(7, "BLOCK-T2", 31),
        exp(8, "unknown", 32),
    ]
    assert group_all(exposures) == [
        ("BLOCK-T1", 1, 3),
        ("BLOCK-T2", 4, 5),
        ("BLOCK-T2", 6, 7),
        ("unknown", 8, 8),
    ]
    # Every closed block agrees with the oracle. The tail differs on purpose:
    # the original folds a final exposure that *starts* a new block into the
    # previous block (and relabels it with the new program) — a quirk of its
    # "last row closes" shortcut that a cron re-run papered over. Here the
    # tail is the open block and is grouped like any other.
    ref = reference_group(exposures)
    assert ref[-1] == ("unknown", 6, 8)
    assert group_all(exposures)[:-2] == ref[:-1]


def test_gap_exactly_at_the_limit_starts_a_new_block() -> None:
    # The guide compares delay < max_gap, so a pause of exactly 15 minutes
    # (measured from the previous shutter close) splits the run.
    a = exp(1, "P", 0, dur_s=60)
    b = Exposure(
        exposure_id=a.exposure_id + 1,
        day_obs=a.day_obs,
        seq_num=2,
        program="P",
        begin=a.end + MAX_GAP,
        end=a.end + MAX_GAP + timedelta(seconds=60),
    )
    assert group_all([a, b]) == [("P", 1, 1), ("P", 2, 2)]
    just_under = Exposure(
        **{**b.__dict__, "begin": a.end + MAX_GAP - timedelta(seconds=1)}
    )
    assert group_all([a, just_under]) == [("P", 1, 2)]


def test_short_series_group_sensibly() -> None:
    # The original returned nothing for a single exposure and merged a
    # two-exposure, two-program series into one block; neither is wanted.
    one = [exp(1, "P", 0)]
    two = [exp(1, "P", 0), exp(2, "Q", 1)]
    assert reference_group(one) == []
    assert group_all(one) == [("P", 1, 1)]
    assert group_all(two) == [("P", 1, 1), ("Q", 2, 2)]


def test_block_records_span_and_exposure_count() -> None:
    g = BlockGrouper(MAX_GAP)
    g.add(exp(1, "P", 0, day_obs=20250411))
    g.add(exp(2, "P", 1, day_obs=20250411))
    g.add(exp(3, "P", 2, day_obs=20250412))  # rolled over mid-block
    (block,) = g.blocks()
    assert (block.day_obs, block.day_obs_end, block.n_exposures) == (
        20250411,
        20250412,
        3,
    )
    assert block.begin == T0
    assert block.end == T0 + timedelta(minutes=2, seconds=30)


def test_grouper_round_trips_through_its_dict_form() -> None:
    g = BlockGrouper(MAX_GAP)
    for e in [exp(1, "P", 0), exp(2, "Q", 1), exp(3, "Q", 2)]:
        g.add(e)
    h = BlockGrouper(MAX_GAP)
    h.load_dict(json.loads(json.dumps(g.to_dict())))
    assert [b.to_dict() for b in h.blocks()] == [b.to_dict() for b in g.blocks()]
    assert h.last == g.last
    # Continues the open block seamlessly after reload.
    h.add(exp(4, "Q", 3))
    assert [(b.program, b.seq_num_0, b.seq_num_1) for b in h.blocks()] == [
        ("P", 1, 1),
        ("Q", 2, 4),
    ]


def test_tai_timestamps_become_utc() -> None:
    utc = tai_to_utc("2025-04-12T00:30:37.000")
    assert utc == datetime(2025, 4, 12, 0, 30, tzinfo=UTC)
    assert TAI_MINUS_UTC == timedelta(seconds=37)
    assert day_obs_str(20250412) == "2025-04-12"


def test_records_without_shutter_times_are_skipped_and_nulls_are_unknown() -> None:
    base = {"exposure_id": 2025041200001, "day_obs": 20250412, "seq_num": 1}
    assert exposure_from_record({**base, "obs_start": None, "obs_end": "x"}) is None
    e = exposure_from_record(
        {
            **base,
            "science_program": None,
            "obs_start": "2025-04-12T00:30:37",
            "obs_end": "2025-04-12T00:31:07",
        }
    )
    assert e is not None and e.program == "unknown"


# --- the service against a fake ConsDB ---------------------------------------


class FakeConsDb(ConsDbClient):
    """Answers the guide's paged ``exposure_id > N ... LIMIT M`` query from
    an in-memory row list, recording every SQL it sees."""

    def __init__(self, rows: list[list[Any]]) -> None:
        super().__init__("http://fake/consdb/query")
        self.rows = rows
        self.queries: list[str] = []
        self.fail = False

    def query_sync(self, sql: str) -> QueryResult:
        self.queries.append(sql)
        if self.fail:
            raise ConsDbError("ConsDB HTTP 503")
        m = re.search(r"exposure_id > (\d+) ORDER BY exposure_id ASC LIMIT (\d+)", sql)
        assert m, sql
        after, limit = int(m.group(1)), int(m.group(2))
        rows = [r for r in self.rows if r[0] > after][:limit]
        return QueryResult(COLUMNS, rows)


def row(seq: int, program: str, begin_min: float, day_obs: int = 20250411) -> list[Any]:
    e = exp(seq, program, begin_min, day_obs=day_obs)
    tai = lambda t: (t + TAI_MINUS_UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")  # noqa: E731
    return [e.exposure_id, e.day_obs, e.seq_num, program, tai(e.begin), tai(e.end)]


def make_service(
    client: FakeConsDb, cache_dir: Path | None, page_size: int = 2
) -> GuideService:
    return GuideService(
        client,
        ["lsstcam"],
        since_day_obs="2025-04-01",
        max_gap=MAX_GAP,
        poll_interval=3600,
        page_size=page_size,
        cache_dir=cache_dir,
    )


async def test_poll_pages_until_caught_up_and_persists(tmp_path: Path) -> None:
    client = FakeConsDb([row(1, "P", 0), row(2, "P", 1), row(3, "Q", 2)])
    svc = make_service(client, tmp_path)
    guide = svc.get("lsstcam")
    assert guide is not None and not guide.swept

    n = await svc.poll(guide)

    assert n == 3
    assert len(client.queries) == 2  # a full page of 2, then a short page of 1
    assert guide.swept and guide.error is None
    assert [(b.program, b.seq_num_0, b.seq_num_1) for b in guide.blocks()] == [
        ("P", 1, 2),
        ("Q", 3, 3),
    ]
    assert guide.last_exposure_id == 2025041100003
    cached = json.loads((tmp_path / "guide" / "lsstcam.json").read_text())
    assert cached["last_exposure_id"] == 2025041100003
    assert len(cached["grouper"]["closed"]) == 1 and cached["grouper"]["open"]


async def test_warm_start_only_fetches_newer_exposures(tmp_path: Path) -> None:
    client = FakeConsDb([row(1, "P", 0), row(2, "P", 1)])
    svc = make_service(client, tmp_path, page_size=10)
    await svc.poll(svc.instruments["lsstcam"])

    client.rows.append(row(3, "P", 2))
    client.queries.clear()
    fresh = make_service(client, tmp_path, page_size=10)
    guide = fresh.instruments["lsstcam"]
    fresh._load_cache(guide)
    assert guide.last_exposure_id == 2025041100002
    await fresh.poll(guide)

    assert "exposure_id > 2025041100002" in client.queries[0]
    (block,) = guide.blocks()
    assert (block.seq_num_0, block.seq_num_1, block.n_exposures) == (1, 3, 3)


async def test_stale_cache_is_ignored(tmp_path: Path) -> None:
    client = FakeConsDb([row(1, "P", 0)])
    svc = make_service(client, tmp_path)
    await svc.poll(svc.instruments["lsstcam"])
    path = tmp_path / "guide" / "lsstcam.json"
    raw = json.loads(path.read_text())
    raw["version"] = 99
    path.write_text(json.dumps(raw))

    fresh = make_service(client, tmp_path)
    guide = fresh.instruments["lsstcam"]
    fresh._load_cache(guide)
    assert guide.blocks() == [] and guide.last_exposure_id == 2025040100000 - 1


async def test_consdb_failure_keeps_blocks_and_reports_error(tmp_path: Path) -> None:
    client = FakeConsDb([row(1, "P", 0)])
    svc = make_service(client, None)
    guide = svc.instruments["lsstcam"]
    await svc.poll(guide)
    client.fail = True
    await svc.poll(guide)
    assert guide.error and "503" in guide.error
    assert len(guide.blocks()) == 1
    client.fail = False
    await svc.poll(guide)
    assert guide.error is None


def test_instrument_names_are_validated() -> None:
    with pytest.raises(ValueError):
        GuideService(
            FakeConsDb([]),
            ["lsstcam; drop"],
            since_day_obs="2025-04-01",
            max_gap=MAX_GAP,
            poll_interval=1,
            page_size=1,
            cache_dir=None,
        )
