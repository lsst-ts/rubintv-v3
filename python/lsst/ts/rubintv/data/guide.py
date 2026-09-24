"""Observing-block guide: exposures from ConsDB grouped into blocks.

A port of the data half of Josh Meyers' RubinTV Guide
(https://github.com/jmeyers314/rubintv_guide, BSD-2). There, a cron on
USDF pulled every LSSTCam exposure from ConsDB, grouped consecutive
exposures of the same science program (with no pause longer than 15
minutes) into one block, and published ``blocks.json``. Here the same
grouping runs inside the app, incrementally:

- exposures are read in ``exposure_id`` order, paged, and only those
  newer than the last one seen are fetched on each poll;
- grouping is a one-pass state machine, so the service holds the closed
  blocks plus one open block and the last exposure, never the exposures;
- the result is persisted under the cache dir so a restart is warm.

Blocks are keyed by the ConsDB ``day_obs`` (the observatory's noon-UTC
rollover) so they line up with the rest of RubinTV's dates; the original
guide broke rows at Chilean noon instead.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from lsst.ts.rubintv.data.consdb import ConsDbClient, ConsDbError
from lsst.ts.rubintv.logging import get_logger

log = get_logger(__name__)

# ConsDB's obs_start/obs_end are TAI ISO strings; UTC has trailed TAI by
# 37 s since 2017 and no leap second is scheduled, so a constant is exact
# for every exposure the observatory has taken.
TAI_MINUS_UTC = timedelta(seconds=37)

# Instrument names flow into the SQL schema name, so they are validated
# rather than quoted: ConsDB schemas are ``cdb_<lowercase name>``.
_INSTRUMENT_RE = re.compile(r"^[a-z0-9_]+$")

_CACHE_VERSION = 1


@dataclass(frozen=True)
class Exposure:
    """The slice of a ConsDB exposure row the grouping needs."""

    exposure_id: int
    day_obs: int
    seq_num: int
    program: str
    begin: datetime
    end: datetime


@dataclass
class Block:
    """A run of consecutive exposures of one science program."""

    program: str
    begin: datetime
    end: datetime
    seq_num_0: int
    seq_num_1: int
    day_obs: int
    """day_obs of the first exposure (YYYYMMDD)."""
    day_obs_end: int
    """day_obs of the last exposure; differs from ``day_obs`` when a block
    straddles the noon-UTC rollover."""
    n_exposures: int = 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "program": self.program,
            "begin": _iso(self.begin),
            "end": _iso(self.end),
            "seq_num_0": self.seq_num_0,
            "seq_num_1": self.seq_num_1,
            "day_obs": self.day_obs,
            "day_obs_end": self.day_obs_end,
            "n_exposures": self.n_exposures,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> Block:
        return cls(
            program=str(raw["program"]),
            begin=_parse_iso(raw["begin"]),
            end=_parse_iso(raw["end"]),
            seq_num_0=int(raw["seq_num_0"]),
            seq_num_1=int(raw["seq_num_1"]),
            day_obs=int(raw["day_obs"]),
            day_obs_end=int(raw["day_obs_end"]),
            n_exposures=int(raw.get("n_exposures", 1)),
        )


def _iso(t: datetime) -> str:
    return t.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_iso(s: str) -> datetime:
    t = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=UTC)


def tai_to_utc(value: str) -> datetime:
    """Parse a ConsDB TAI timestamp (ISO, usually zone-less) as aware UTC."""
    t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if t.tzinfo is None:
        t = t.replace(tzinfo=UTC)
    return t - TAI_MINUS_UTC


def day_obs_str(day_obs: int) -> str:
    """``20250410`` -> ``2025-04-10``."""
    s = f"{day_obs:08d}"
    return f"{s[:4]}-{s[4:6]}-{s[6:]}"


def exposure_from_record(rec: dict[str, Any]) -> Exposure | None:
    """Build an :class:`Exposure` from a ConsDB row, or ``None`` if the row
    lacks the timing the grouping needs (a header without shutter times
    can't be placed on the timeline)."""
    start, end = rec.get("obs_start"), rec.get("obs_end")
    if start is None or end is None:
        return None
    program = rec.get("science_program")
    return Exposure(
        exposure_id=int(rec["exposure_id"]),
        day_obs=int(rec["day_obs"]),
        seq_num=int(rec["seq_num"]),
        program=str(program) if program else "unknown",
        begin=tai_to_utc(start),
        end=tai_to_utc(end),
    )


class BlockGrouper:
    """One-pass grouping of exposures into blocks.

    Same rule as the guide's ``group_into_blocks``: an exposure joins the
    open block when it has the same science program as the previous
    exposure and started less than ``max_gap`` after that one ended;
    otherwise the open block closes and a new one starts. Exposures must
    arrive in ``exposure_id`` order.
    """

    def __init__(self, max_gap: timedelta) -> None:
        self.max_gap = max_gap
        self.closed: list[Block] = []
        self.open: Block | None = None
        self.last: Exposure | None = None

    def add(self, exp: Exposure) -> None:
        prev, block = self.last, self.open
        self.last = exp
        if block is not None and prev is not None:
            same_program = exp.program == prev.program
            gap_ok = (exp.begin - prev.end) < self.max_gap
            if same_program and gap_ok:
                block.end = exp.end
                block.seq_num_1 = exp.seq_num
                block.day_obs_end = exp.day_obs
                block.n_exposures += 1
                return
            self.closed.append(block)
        self.open = Block(
            program=exp.program,
            begin=exp.begin,
            end=exp.end,
            seq_num_0=exp.seq_num,
            seq_num_1=exp.seq_num,
            day_obs=exp.day_obs,
            day_obs_end=exp.day_obs,
        )

    def blocks(self) -> list[Block]:
        """Every block so far, the still-open one last."""
        return self.closed + ([self.open] if self.open is not None else [])

    # -- persistence ---------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        last = self.last
        return {
            "closed": [b.to_dict() for b in self.closed],
            "open": self.open.to_dict() if self.open else None,
            "last": None
            if last is None
            else {
                "exposure_id": last.exposure_id,
                "day_obs": last.day_obs,
                "seq_num": last.seq_num,
                "program": last.program,
                "begin": _iso(last.begin),
                "end": _iso(last.end),
            },
        }

    def load_dict(self, raw: dict[str, Any]) -> None:
        self.closed = [Block.from_dict(b) for b in raw.get("closed", [])]
        open_raw = raw.get("open")
        self.open = Block.from_dict(open_raw) if open_raw else None
        last_raw = raw.get("last")
        self.last = (
            None
            if not last_raw
            else Exposure(
                exposure_id=int(last_raw["exposure_id"]),
                day_obs=int(last_raw["day_obs"]),
                seq_num=int(last_raw["seq_num"]),
                program=str(last_raw["program"]),
                begin=_parse_iso(last_raw["begin"]),
                end=_parse_iso(last_raw["end"]),
            )
        )


@dataclass
class InstrumentGuide:
    """Per-instrument state: the grouper plus its sweep bookkeeping."""

    instrument: str
    grouper: BlockGrouper
    last_exposure_id: int
    """Highest exposure_id consumed (including rows skipped for missing
    times), so the next poll never re-reads a row."""
    swept: bool = False
    """False until the first sweep has caught up with ConsDB; the API shows
    a loading state while it is false."""
    updated_at: datetime | None = None
    error: str | None = None
    exposures_seen: int = 0
    dirty: bool = field(default=False)

    def blocks(self) -> list[Block]:
        return self.grouper.blocks()


class GuideService:
    """Keep per-instrument block lists current against ConsDB.

    One background task per instrument: load the cached state, then loop
    "fetch exposures newer than the last one, page by page, until caught
    up; persist; sleep". A failed poll is logged and retried next tick —
    the blocks already built stay served.
    """

    def __init__(
        self,
        client: ConsDbClient,
        instruments: list[str],
        *,
        since_day_obs: str,
        max_gap: timedelta,
        poll_interval: float,
        page_size: int,
        cache_dir: Path | None,
    ) -> None:
        for name in instruments:
            if not _INSTRUMENT_RE.match(name):
                raise ValueError(f"invalid guide instrument name: {name!r}")
        self._client = client
        self._since_id = int(since_day_obs.replace("-", "")) * 100000 - 1
        self._poll_interval = poll_interval
        self._page_size = page_size
        self._cache_dir = cache_dir / "guide" if cache_dir else None
        self._max_gap = max_gap
        self.instruments: dict[str, InstrumentGuide] = {
            name: InstrumentGuide(name, BlockGrouper(max_gap), self._since_id)
            for name in instruments
        }
        self._tasks: list[asyncio.Task[None]] = []

    # -- lifecycle -----------------------------------------------------------

    def start(self) -> None:
        for guide in self.instruments.values():
            self._tasks.append(
                asyncio.create_task(self._run(guide), name=f"guide-{guide.instrument}")
            )

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

    def get(self, instrument: str) -> InstrumentGuide | None:
        return self.instruments.get(instrument)

    # -- the loop ------------------------------------------------------------

    async def _run(self, guide: InstrumentGuide) -> None:
        try:
            await asyncio.to_thread(self._load_cache, guide)
        except Exception:  # noqa: BLE001 - a bad cache file is a cold start
            log.exception("guide.cache.load_failed", instrument=guide.instrument)
        while True:
            try:
                await self.poll(guide)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - one bad tick must not kill it
                log.exception("guide.poll.error", instrument=guide.instrument)
            await asyncio.sleep(self._poll_interval)

    async def poll(self, guide: InstrumentGuide) -> int:
        """Consume every exposure newer than the last seen; return the
        number of rows read. Sets ``error`` on failure instead of raising
        so the API can show why the guide is stale."""
        total = 0
        try:
            while True:
                n = await self._fetch_page(guide)
                total += n
                if n < self._page_size:
                    break
        except ConsDbError as exc:
            guide.error = str(exc)
            log.warning(
                "guide.consdb.error", instrument=guide.instrument, error=str(exc)
            )
            if guide.dirty:
                await asyncio.to_thread(self._write_cache, guide)
            return total
        guide.error = None
        if not guide.swept:
            guide.swept = True
            log.info(
                "guide.swept",
                instrument=guide.instrument,
                blocks=len(guide.blocks()),
                exposures=guide.exposures_seen,
            )
        if guide.dirty:
            await asyncio.to_thread(self._write_cache, guide)
        return total

    async def _fetch_page(self, guide: InstrumentGuide) -> int:
        sql = (
            "SELECT exposure_id, day_obs, seq_num, science_program, "
            "obs_start, obs_end "
            f"FROM cdb_{guide.instrument}.exposure "
            f"WHERE exposure_id > {guide.last_exposure_id} "
            f"ORDER BY exposure_id ASC LIMIT {self._page_size}"
        )
        result = await self._client.query(sql)
        rows = result.records()
        for rec in rows:
            exp = exposure_from_record(rec)
            guide.last_exposure_id = max(
                guide.last_exposure_id, int(rec["exposure_id"])
            )
            if exp is not None:
                guide.grouper.add(exp)
                guide.exposures_seen += 1
        if rows:
            guide.updated_at = datetime.now(UTC)
            guide.dirty = True
            log.debug("guide.page", instrument=guide.instrument, rows=len(rows))
        return len(rows)

    # -- cache ---------------------------------------------------------------

    def _cache_path(self, instrument: str) -> Path | None:
        return self._cache_dir / f"{instrument}.json" if self._cache_dir else None

    def _load_cache(self, guide: InstrumentGuide) -> None:
        path = self._cache_path(guide.instrument)
        if path is None or not path.is_file():
            return
        raw = json.loads(path.read_text())
        if (
            raw.get("version") != _CACHE_VERSION
            or raw.get("since_id") != self._since_id
        ):
            log.info("guide.cache.skipped", instrument=guide.instrument, reason="stale")
            return
        guide.grouper.load_dict(raw["grouper"])
        guide.last_exposure_id = int(raw["last_exposure_id"])
        guide.exposures_seen = int(raw.get("exposures_seen", 0))
        updated = raw.get("updated_at")
        guide.updated_at = _parse_iso(updated) if updated else None
        log.info(
            "guide.cache.loaded",
            instrument=guide.instrument,
            blocks=len(guide.blocks()),
            last_exposure_id=guide.last_exposure_id,
        )

    def _write_cache(self, guide: InstrumentGuide) -> None:
        path = self._cache_path(guide.instrument)
        if path is None:
            guide.dirty = False
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "version": _CACHE_VERSION,
                "since_id": self._since_id,
                "last_exposure_id": guide.last_exposure_id,
                "exposures_seen": guide.exposures_seen,
                "updated_at": _iso(guide.updated_at) if guide.updated_at else None,
                "grouper": guide.grouper.to_dict(),
            }
            tmp = path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(payload))
            tmp.replace(path)
            guide.dirty = False
        except OSError as exc:  # best-effort, like the S3 disk cache
            log.warning("guide.cache.write_failed", path=str(path), error=str(exc))
