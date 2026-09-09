"""Core value types for the data layer.

``Event`` is a parsed channel artifact. ``ObjectEvent`` is the normalised
created/removed signal a ``DataSource`` emits — nothing downstream cares
whether it came from a poll diff or a Kafka message. ``StoreChange`` is the
coarse "something changed" the ``EventStore`` publishes to the bus.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal

# seq_num is an int for per-seq-num channels, or the sentinel "final" (and
# similar) for per-day artifacts like movies.
SeqNum = int | str


@dataclass(frozen=True, slots=True)
class Event:
    """A single parsed data product in a channel.

    Built from an S3 key matching
    ``{camera}/{day_obs}/{channel}/{seq}/{filename}.{ext}``.
    """

    key: str
    camera: str
    day_obs: str
    channel: str
    seq_num: SeqNum
    filename: str
    ext: str

    @property
    def is_per_day(self) -> bool:
        """True if this is a per-day artifact (non-integer seq_num)."""
        return not isinstance(self.seq_num, int)


class ObjectKind(StrEnum):
    """What happened to an object in the bucket."""

    CREATED = "created"
    REMOVED = "removed"


@dataclass(frozen=True, slots=True)
class ObjectEvent:
    """A normalised object change from a ``DataSource``.

    ``etag`` lets the store detect a content change (update) vs. a no-op
    re-listing of the same object.
    """

    kind: ObjectKind
    location: str
    key: str
    etag: str | None = None
    size: int | None = None


# The kinds of data a StoreChange can concern. Used to scope notification
# fan-out (a client subscribed to one camera shouldn't hear about another).
ChangeType = Literal[
    "channelData",  # structured data / extension info for a (loc, cam, date)
    "metadata",  # metadata.json for a (loc, cam, date)
    "perDay",  # per-day channel artifact for a (loc, cam, date)
    "nightReport",  # night-report content for a (loc, cam, date)
    "calendarUpdate",  # calendar gained/lost a date for a (loc, cam)
    "dayChange",  # the current day_obs rolled over
    "detectorStatus",  # cluster-worker status changed (site-wide, from Redis)
    "controlReadback",  # admin control readback value changed (site-wide)
    "serviceStatus",  # an RA service's liveness changed (site-wide, heartbeats)
]


@dataclass(frozen=True, slots=True)
class StoreChange:
    """A coarse change notification published after the store mutates."""

    type: ChangeType
    location: str
    camera: str
    date: str | None = None
