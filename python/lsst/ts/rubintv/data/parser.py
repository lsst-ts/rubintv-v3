"""Parse S3 object keys into typed objects.

All bucket data follows strict naming conventions (design doc §3). Keys that
do not match are *safely ignored* (confirmed: anything not matching the
rules can be skipped) — every parse function returns ``None`` on no match
rather than raising.

Key shapes::

    channel event:    {camera}/{day_obs}/{channel}/{seq:06d}/{filename}.{ext}
    per-day event:    {camera}/{day_obs}/{channel}/{final}/{filename}.{ext}
    metadata:         {camera}/{day_obs}/metadata.json
    night report md:  {camera}/{day_obs}/night_report/{filename}_md.json
    night report plot:{camera}/{day_obs}/night_report/{group}/{filename}.{ext}
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from lsst.ts.rubintv.data.events import Event, SeqNum

# day_obs is an ISO date; seq segment is digits or a word sentinel ("final").
_DATE = r"\d{4}-\d{2}-\d{2}"

_CHANNEL_RE = re.compile(
    rf"^(?P<camera>[^/]+)/(?P<day_obs>{_DATE})/(?P<channel>[^/]+)/"
    r"(?P<seq>\d+|[a-zA-Z]+)/(?P<filename>[^/]+)\.(?P<ext>[^./]+)$"
)

_METADATA_RE = re.compile(rf"^(?P<camera>[^/]+)/(?P<day_obs>{_DATE})/metadata\.json$")

_NR_MD_RE = re.compile(
    rf"^(?P<camera>[^/]+)/(?P<day_obs>{_DATE})/night_report/"
    r"(?P<filename>[^/]+)_md\.json$"
)

_NR_PLOT_RE = re.compile(
    rf"^(?P<camera>[^/]+)/(?P<day_obs>{_DATE})/night_report/"
    r"(?P<group>[^/]+)/(?P<filename>[^/]+)\.(?P<ext>[^./]+)$"
)


@dataclass(frozen=True, slots=True)
class MetadataRef:
    """A reference to a metadata.json object (content fetched separately)."""

    camera: str
    day_obs: str
    key: str


@dataclass(frozen=True, slots=True)
class NightReportRef:
    """A reference to a night-report object (text item or plot).

    Internal/route naming stays ``night_report`` (mirrors the S3 prefix); the
    UI renders a neutral label.
    """

    camera: str
    day_obs: str
    key: str
    is_text: bool
    group: str | None = None


def parse_seq(raw: str) -> SeqNum:
    """Coerce a seq segment to int, or keep the sentinel string (e.g. final)."""
    return int(raw) if raw.isdigit() else raw


def parse_channel_event(key: str) -> Event | None:
    """Parse a channel/per-day event key, or ``None`` if it doesn't match."""
    m = _CHANNEL_RE.match(key)
    if m is None:
        return None
    # night_report keys also have a channel-like third segment; exclude them.
    if m.group("channel") == "night_report":
        return None
    return Event(
        key=key,
        camera=m.group("camera"),
        day_obs=m.group("day_obs"),
        channel=m.group("channel"),
        seq_num=parse_seq(m.group("seq")),
        filename=m.group("filename"),
        ext=m.group("ext"),
    )


def parse_metadata(key: str) -> MetadataRef | None:
    """Parse a metadata.json key, or ``None``."""
    m = _METADATA_RE.match(key)
    if m is None:
        return None
    return MetadataRef(camera=m.group("camera"), day_obs=m.group("day_obs"), key=key)


def parse_night_report(key: str) -> NightReportRef | None:
    """Parse a night-report text item or plot key, or ``None``."""
    m = _NR_MD_RE.match(key)
    if m is not None:
        return NightReportRef(
            camera=m.group("camera"),
            day_obs=m.group("day_obs"),
            key=key,
            is_text=True,
        )
    m = _NR_PLOT_RE.match(key)
    if m is not None:
        return NightReportRef(
            camera=m.group("camera"),
            day_obs=m.group("day_obs"),
            key=key,
            is_text=False,
            group=m.group("group"),
        )
    return None
