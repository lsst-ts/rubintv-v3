"""Index value types held by the EventStore.

Kept separate from the store so they can be (de)serialised by the cache
layer without importing store machinery.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from rubintv.data.events import SeqNum


@dataclass(slots=True)
class ExtInfo:
    """File extensions for a channel on a date.

    Most events share a default extension; exceptions are tracked per
    seq_num so the frontend can build S3 keys without a per-object query.
    """

    default: str | None = None
    exceptions: dict[SeqNum, str] = field(default_factory=dict)

    def record(self, seq_num: SeqNum, ext: str) -> None:
        if self.default is None:
            self.default = ext
        elif ext != self.default:
            self.exceptions[seq_num] = ext

    def for_seq(self, seq_num: SeqNum) -> str | None:
        return self.exceptions.get(seq_num, self.default)


@dataclass(slots=True)
class DateIndex:
    """Everything indexed for one (location, camera, date).

    ``channels`` is the "what exists" structured-data index. ``per_day``
    holds per-day artifacts keyed by channel. ``night_report_keys`` tracks
    night-report object keys (content fetched on demand).
    """

    channels: dict[str, set[SeqNum]] = field(default_factory=dict)
    extensions: dict[str, ExtInfo] = field(default_factory=dict)
    per_day: dict[str, str] = field(default_factory=dict)
    night_report_keys: set[str] = field(default_factory=set)

    @property
    def is_empty(self) -> bool:
        return not (self.channels or self.per_day or self.night_report_keys)
