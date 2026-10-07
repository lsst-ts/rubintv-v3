#!/usr/bin/env python3
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

"""Summarise the data flow from RubinTV's JSON logs.

Reads JSON-lines log output (a file, or stdin) produced with
``RUBINTV_JSON_LOGS=1 RUBINTV_LOG_LEVEL=DEBUG`` and prints, per flow:

- ``http.request``: count, p50/p95/max duration and total bytes, grouped
  by method and path (dates and numbers in the path are normalised so
  every ``/dates/2026-10-07`` folds into one row);
- ``ws.frame.sent``: frames and bytes per message type, and per-connection
  totals from ``ws.disconnect``;
- ``poll.current.cycle``: cycle time and keys listed per current-day cycle;
- ``poll.scan``: listings per scope, how many changed anything;
- ``store.apply``: events seen vs. changes published.

Usage::

    RUBINTV_JSON_LOGS=1 RUBINTV_LOG_LEVEL=DEBUG uv run uvicorn \\
        lsst.ts.rubintv.main:app 2>&1 | tee /tmp/rubintv.jsonl
    python scripts/flow_summary.py /tmp/rubintv.jsonl

Lines that are not JSON (uvicorn's own banner, tracebacks) are skipped.
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any

_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_NUM = re.compile(r"(?<=/)\d+(?=/|$)")


def normalise_path(path: str) -> str:
    """Fold dates and numeric segments so one endpoint is one row."""
    return _NUM.sub("{n}", _DATE.sub("{date}", path))


def percentile(values: list[float], pct: float) -> float:
    """Nearest-rank percentile; ``values`` need not be sorted."""
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(0, min(len(ordered) - 1, round(pct / 100 * (len(ordered) - 1))))
    return ordered[rank]


@dataclass
class Series:
    """One row of a table: a list of timings and a running byte count."""

    count: int = 0
    values: list[float] = field(default_factory=list)
    total_bytes: int = 0
    extra: int = 0


def parse_lines(lines: Iterable[str]) -> Iterator[dict[str, Any]]:
    for line in lines:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict) and "event" in record:
            yield record


def summarise(records: Iterable[dict[str, Any]]) -> str:
    http: dict[str, Series] = defaultdict(Series)
    ws_types: dict[str, Series] = defaultdict(Series)
    ws_conns: list[tuple[int, int]] = []
    cycles = Series()
    scans: dict[str, Series] = defaultdict(Series)
    applies = Series()

    for r in records:
        event = r.get("event")
        if event == "http.request":
            row = http[
                f"{r.get('method', '?')} {normalise_path(str(r.get('path', '')))}"
            ]
            row.count += 1
            row.values.append(float(r.get("duration_ms") or 0))
            row.total_bytes += int(r.get("bytes") or 0)
        elif event == "ws.frame.sent":
            row = ws_types[str(r.get("type"))]
            row.count += 1
            size = int(r.get("bytes") or 0)
            row.values.append(size)
            row.total_bytes += size
        elif event == "ws.disconnect":
            ws_conns.append(
                (int(r.get("frames_sent") or 0), int(r.get("bytes_sent") or 0))
            )
        elif event == "poll.current.cycle":
            cycles.count += 1
            cycles.values.append(float(r.get("cycle_seconds") or 0))
            cycles.extra += int(r.get("keys") or 0)
        elif event == "poll.scan":
            row = scans[str(r.get("scope"))]
            row.count += 1
            row.extra += 1 if int(r.get("slices_touched") or 0) else 0
            row.total_bytes += int(r.get("keys") or 0)
        elif event == "store.apply":
            applies.count += 1
            applies.extra += int(r.get("events") or 0)
            applies.total_bytes += int(r.get("changes") or 0)

    out: list[str] = []

    out.append("HTTP requests (duration to headers, ms; bytes uncompressed)")
    out.append(
        f"  {'count':>6} {'p50':>8} {'p95':>8} {'max':>8} {'bytes':>10}  endpoint"
    )
    for name, row in sorted(http.items(), key=lambda kv: -kv[1].count):
        out.append(
            f"  {row.count:>6} {percentile(row.values, 50):>8.1f}"
            f" {percentile(row.values, 95):>8.1f} {max(row.values):>8.1f}"
            f" {row.total_bytes:>10}  {name}"
        )
    if not http:
        out.append("  (none)")

    out.append("")
    out.append("WebSocket frames sent")
    out.append(f"  {'count':>6} {'p50 B':>8} {'max B':>8} {'bytes':>10}  type")
    for name, row in sorted(ws_types.items(), key=lambda kv: -kv[1].total_bytes):
        out.append(
            f"  {row.count:>6} {percentile(row.values, 50):>8.0f}"
            f" {max(row.values):>8.0f} {row.total_bytes:>10}  {name}"
        )
    if not ws_types:
        out.append("  (none)")
    if ws_conns:
        frames = sum(f for f, _ in ws_conns)
        total = sum(b for _, b in ws_conns)
        out.append(
            f"  {len(ws_conns)} connection(s) closed: {frames} frames, {total} bytes"
        )

    out.append("")
    out.append("Current-day poll cycles")
    if cycles.count:
        out.append(
            f"  {cycles.count} cycles; cycle_seconds p50"
            f" {percentile(cycles.values, 50):.3f}"
            f" p95 {percentile(cycles.values, 95):.3f}"
            f" max {max(cycles.values):.3f};"
            f" keys/cycle avg {cycles.extra / cycles.count:.0f}"
        )
    else:
        out.append("  (none)")

    out.append("")
    out.append("Listings (poll.scan) by scope")
    out.append(f"  {'count':>6} {'changed':>8} {'keys':>10}  scope")
    for name, row in sorted(scans.items()):
        out.append(f"  {row.count:>6} {row.extra:>8} {row.total_bytes:>10}  {name}")
    if not scans:
        out.append("  (none)")

    out.append("")
    out.append("Store applies")
    if applies.count:
        ratio = applies.total_bytes / applies.extra if applies.extra else 0.0
        out.append(
            f"  {applies.count} applies; {applies.extra} events ->"
            f" {applies.total_bytes} changes published"
            f" ({ratio:.1%} of events were new)"
        )
    else:
        out.append("  (none)")

    return "\n".join(out)


def main(argv: list[str]) -> int:
    if argv:
        lines: Iterable[str] = (
            line for path in argv for line in open(path, encoding="utf-8")
        )
    else:
        lines = sys.stdin
    print(summarise(parse_lines(lines)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
