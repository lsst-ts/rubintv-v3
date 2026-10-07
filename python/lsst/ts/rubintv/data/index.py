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

"""Index value types held by the EventStore.

Kept separate from the store so they can be (de)serialised by the cache
layer without importing store machinery.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from lsst.ts.rubintv.data.events import SeqNum


@dataclass(slots=True)
class ExtInfo:
    """File extensions for a channel on a date.

    Most events share a default extension; exceptions are tracked per
    seq_num so the frontend can build S3 keys without a per-object query.
    """

    default: str | None = None
    exceptions: dict[SeqNum, str] = field(default_factory=dict)

    def record(self, seq_num: SeqNum, ext: str) -> bool:
        """Record an extension; True if it changed what ``for_seq`` answers."""
        if self.default is None:
            self.default = ext
            return True
        if ext == self.default:
            return self.exceptions.pop(seq_num, None) is not None
        if self.exceptions.get(seq_num) == ext:
            return False
        self.exceptions[seq_num] = ext
        return True

    def for_seq(self, seq_num: SeqNum) -> str | None:
        return self.exceptions.get(seq_num, self.default)


@dataclass(frozen=True, slots=True)
class PerDayRef:
    """A per-day artifact's location within its channel/date prefix.

    ``seq`` is the word sentinel segment (e.g. ``"final"``); ``ext`` is the
    file type, which the UI needs to tell a movie from a still. Together with
    ``{camera}/{date}/{channel}/`` — which every caller already has — this is
    enough to build a proxy URL, so the full object key is never stored.
    """

    seq: str
    ext: str


@dataclass(slots=True)
class DateIndex:
    """Everything indexed for one (location, camera, date).

    The index records *presence*, not object identity: which (channel, seq)
    slots exist, and which channels have a per-day artifact. That is the
    whole requirement for serving the UI — the proxy resolves the actual
    object by listing the seq prefix at request time, so the index never
    needs to know a filename. Not storing them keeps the resident footprint
    proportional to observations rather than to every object ever written
    (the difference between integer seqs and full S3 key strings, which is
    what previously made this process grow without bound).

    ``channels`` is the "what exists" structured-data index. ``per_day``
    maps a channel to its artifact's seq sentinel (e.g. ``"final"``) — the
    rest of that object's key is ``{camera}/{date}/{channel}/`` , which every
    caller already has. ``night_report_keys`` keeps full object keys because
    the report fetcher GETs them directly and a plot's group segment can't
    be reconstructed from anything else; there are only a handful per date.
    """

    channels: dict[str, set[SeqNum]] = field(default_factory=dict)
    extensions: dict[str, ExtInfo] = field(default_factory=dict)
    # channel -> (seq sentinel, extension) for the per-day artifact. Kept
    # apart from ``extensions`` because a channel can carry both per-seq
    # frames and a per-day artifact (a movie of them) with different types —
    # folding both into one ExtInfo would let whichever arrived last decide.
    per_day: dict[str, PerDayRef] = field(default_factory=dict)
    night_report_keys: set[str] = field(default_factory=set)
    # ETag of the date's metadata.json as last listed. The content lives in
    # the MetadataCache; this is only so a rewrite of the file (same key,
    # new content) still registers as a change worth telling clients about.
    metadata_etag: str | None = None

    @property
    def is_empty(self) -> bool:
        """No channel data, per-day artifact or night report.

        A metadata ETag alone does not count: metadata is served only for
        dates that have data, so an index holding nothing else is gone.
        """
        return not (self.channels or self.per_day or self.night_report_keys)
