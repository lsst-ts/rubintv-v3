"""The EventStore — the single source of truth for indexed data.

It consumes ``ObjectEvent``s (from any ``DataSource``), maintains the
per-``(location, camera)`` indexes the API reads, and publishes coarse
``StoreChange``s to the ``EventBus`` so listeners refetch/repush the right
slice. Nothing else mutates the indexes.

Concurrency: a poller writes while the API reads. A per-``(loc, cam)``
asyncio lock guards mutations; reads take copies of the small index slices
they need, so the API never observes a half-applied update.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict

from rubintv.data.bus import EventBus
from rubintv.data.events import ObjectEvent, ObjectKind, StoreChange
from rubintv.data.index import DateIndex, ExtInfo
from rubintv.data.parser import (
    parse_channel_event,
    parse_metadata,
    parse_night_report,
)
from rubintv.logging import get_logger

log = get_logger(__name__)

# Key into the per-(location, camera) indexes.
LocCam = tuple[str, str]


class EventStore:
    """In-memory index of all channel data, keyed by (location, camera)."""

    def __init__(self, bus: EventBus | None = None) -> None:
        self._bus = bus or EventBus()
        # (loc, cam) -> date -> DateIndex
        self._dates: dict[LocCam, dict[str, DateIndex]] = defaultdict(dict)
        # (loc, cam) -> sorted set of dates (calendar)
        self._calendar: dict[LocCam, set[str]] = defaultdict(set)
        self._locks: dict[LocCam, asyncio.Lock] = defaultdict(asyncio.Lock)

    @property
    def bus(self) -> EventBus:
        return self._bus

    # -- warm start ------------------------------------------------------

    def load_snapshot(self, snapshot: dict[LocCam, dict[str, DateIndex]]) -> None:
        """Seed the indexes from a cached snapshot (warm start).

        Replaces any existing slices for the given keys. Reconciliation
        against S3 happens on the next scan — the cache is never trusted as
        truth, only as a head start.
        """
        for loc_cam, dates in snapshot.items():
            self._dates[loc_cam] = dict(dates)
            self._calendar[loc_cam] = set(dates.keys())

    def snapshot(self) -> dict[LocCam, dict[str, DateIndex]]:
        """Return the full index, for persistence."""
        return {loc_cam: dict(dates) for loc_cam, dates in self._dates.items()}

    # -- ingestion -------------------------------------------------------

    async def apply(self, events: list[ObjectEvent]) -> None:
        """Apply a batch of object events and publish resulting changes.

        Batched so a poll cycle's worth of changes are applied under the
        lock once per affected (loc, cam), and duplicate StoreChanges are
        coalesced before publishing.
        """
        changes: set[StoreChange] = set()
        for event in events:
            parsed = self._classify(event)
            if parsed is None:
                continue  # non-conforming key — safely ignored
            loc_cam, change = parsed
            async with self._locks[loc_cam]:
                self._mutate(event.kind, loc_cam, event)
            if change is not None:
                changes.add(change)
        for change in changes:
            self._bus.publish(change)

    def _classify(self, event: ObjectEvent) -> tuple[LocCam, StoreChange | None] | None:
        """Route an object event to a (loc, cam) and the change it implies."""
        loc = event.location
        if (ev := parse_channel_event(event.key)) is not None:
            loc_cam = (loc, ev.camera)
            change: StoreChange = (
                StoreChange("perDay", loc, ev.camera, ev.day_obs)
                if ev.is_per_day
                else StoreChange("channelData", loc, ev.camera, ev.day_obs)
            )
            return loc_cam, change
        if (md := parse_metadata(event.key)) is not None:
            return (loc, md.camera), StoreChange("metadata", loc, md.camera, md.day_obs)
        if (nr := parse_night_report(event.key)) is not None:
            return (loc, nr.camera), StoreChange(
                "nightReport", loc, nr.camera, nr.day_obs
            )
        return None

    def _mutate(self, kind: ObjectKind, loc_cam: LocCam, event: ObjectEvent) -> None:
        """Insert or remove a single object from the indexes (lock held)."""
        if kind is ObjectKind.CREATED:
            self._insert(loc_cam, event)
        else:
            self._remove(loc_cam, event)

    def _insert(self, loc_cam: LocCam, event: ObjectEvent) -> None:
        key = event.key
        if (ev := parse_channel_event(key)) is not None:
            idx = self._date_index(loc_cam, ev.day_obs)
            if ev.is_per_day:
                idx.per_day[ev.channel] = key
            else:
                idx.channels.setdefault(ev.channel, set()).add(ev.seq_num)
                idx.extensions.setdefault(ev.channel, ExtInfo()).record(
                    ev.seq_num, ev.ext
                )
            self._calendar[loc_cam].add(ev.day_obs)
        elif (nr := parse_night_report(key)) is not None:
            idx = self._date_index(loc_cam, nr.day_obs)
            idx.night_report_keys.add(key)
            self._calendar[loc_cam].add(nr.day_obs)
        # metadata.json content is fetched separately; its presence alone
        # doesn't change the structured index.

    def _remove(self, loc_cam: LocCam, event: ObjectEvent) -> None:
        key = event.key
        date = _date_of(key)
        if date is None:
            return
        dates = self._dates.get(loc_cam)
        if not dates or date not in dates:
            return
        idx = dates[date]
        if (ev := parse_channel_event(key)) is not None:
            if ev.is_per_day:
                idx.per_day.pop(ev.channel, None)
            else:
                seqs = idx.channels.get(ev.channel)
                if seqs is not None:
                    seqs.discard(ev.seq_num)
                    if not seqs:
                        del idx.channels[ev.channel]
                        idx.extensions.pop(ev.channel, None)
        elif parse_night_report(key) is not None:
            idx.night_report_keys.discard(key)
        # Prune now-empty dates so the calendar stays accurate.
        if idx.is_empty:
            del dates[date]
            self._calendar[loc_cam].discard(date)

    def _date_index(self, loc_cam: LocCam, date: str) -> DateIndex:
        dates = self._dates[loc_cam]
        if date not in dates:
            dates[date] = DateIndex()
        return dates[date]

    # -- reads (copy-on-read snapshots) ----------------------------------

    def calendar(self, location: str, camera: str) -> list[str]:
        """Return all dates with data for a camera, newest first."""
        return sorted(self._calendar.get((location, camera), set()), reverse=True)

    def date_index(self, location: str, camera: str, date: str) -> DateIndex | None:
        """Return the index for one date, or ``None`` if absent."""
        return self._dates.get((location, camera), {}).get(date)

    def has_night_report(self, location: str, camera: str, date: str) -> bool:
        idx = self.date_index(location, camera, date)
        return bool(idx and idx.night_report_keys)


def _date_of(key: str) -> str | None:
    """Extract the day_obs from any conforming key, without full parsing."""
    if (ev := parse_channel_event(key)) is not None:
        return ev.day_obs
    if (nr := parse_night_report(key)) is not None:
        return nr.day_obs
    if (md := parse_metadata(key)) is not None:
        return md.day_obs
    return None
