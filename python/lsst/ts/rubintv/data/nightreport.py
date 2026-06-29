"""Assemble night-report content for a date from S3.

The store holds the set of night-report object keys (presence); the content
— structured text items (``*_md.json``) and plot objects grouped by folder
— is fetched here on demand. Internal naming stays ``night_report`` (mirrors
the S3 prefix); the UI renders a neutral label.

Historical night reports do not mutate; the current day's can gain/update
text and plots through the night, so this is fetched live (no long cache).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from lsst.ts.rubintv.data.nrtext import NightReportTextItem, parse_text_items
from lsst.ts.rubintv.data.parser import parse_night_report

if TYPE_CHECKING:
    from lsst.ts.rubintv.s3.client import S3ClientPool


@dataclass
class NightReportPlot:
    key: str
    group: str
    filename: str


@dataclass
class NightReport:
    """Assembled content: structured text items and grouped plots."""

    text: list[NightReportTextItem] = field(default_factory=list)
    plots: list[NightReportPlot] = field(default_factory=list)


class NightReportFetcher:
    """Fetches and assembles night-report content from S3."""

    def __init__(self, pool: S3ClientPool, buckets: dict[str, str]) -> None:
        self._pool = pool
        self._buckets = buckets

    def fetch(self, location: str, keys: set[str]) -> NightReport:
        """Assemble a NightReport from the given object keys."""
        report = NightReport()
        client = self._pool.client_for(location)
        bucket = self._buckets[location]
        for key in sorted(keys):
            ref = parse_night_report(key)
            if ref is None:
                continue
            if ref.is_text:
                obj = client.get_object(Bucket=bucket, Key=key)
                raw = json.loads(obj["Body"].read())
                report.text.extend(
                    parse_text_items(raw, day_obs=ref.day_obs, source=key)
                )
            else:
                report.plots.append(
                    NightReportPlot(
                        key=key,
                        group=ref.group or "",
                        filename=key.rsplit("/", 1)[-1],
                    )
                )
        return report
