"""The EventStore — the single source of truth for indexed data.

It consumes ``ObjectEvent``s (from any ``DataSource``), maintains the
per-``(location, camera)`` indexes the API reads, and publishes coarse
``StoreChange``s to the ``EventBus`` so listeners refetch/repush the right
slice. Nothing else mutates the indexes.

Deletion is handled by *reconciliation*, not per-key removal events. A
listing of a prefix is authoritative for that prefix: anything indexed
under it but absent from the listing is gone. ``reconcile`` applies that as
a set difference, which makes deletion detection independent of event
ordering — a rename (put new name, delete old) lands as "the slot still
exists", because presence is keyed by (channel, seq) rather than by
filename. Callers must pass the scope their listing actually covered
(:class:`ScanScope`), so a single-date listing can never prune dates it
didn't examine.

Concurrency: a poller writes while the API reads. A per-``(loc, cam)``
asyncio lock guards mutations; reads take copies of the small index slices
they need, so the API never observes a half-applied update.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from dataclasses import dataclass

from lsst.ts.rubintv.data.bus import EventBus
from lsst.ts.rubintv.data.events import ObjectEvent, ObjectKind, SeqNum, StoreChange
from lsst.ts.rubintv.data.index import DateIndex, ExtInfo, PerDayRef
from lsst.ts.rubintv.data.parser import (
    parse_channel_event,
    parse_metadata,
    parse_night_report,
)
from lsst.ts.rubintv.logging import get_logger

log = get_logger(__name__)

# Key into the per-(location, camera) indexes.
LocCam = tuple[str, str]


@dataclass(frozen=True, slots=True)
class ScanScope:
    """What a listing actually covered, so reconciliation can't over-prune.

    A listing is authoritative only for the prefix it enumerated. ``dates``
    of ``None`` means the whole camera was listed (a full ``{camera}/``
    sweep), so every indexed date is in scope; otherwise only the named
    dates are, and anything else is left untouched.

    ``protect`` names dates that must survive even when in scope and absent
    from the listing — the current observing day, whose fast poll loop may
    have inserted keys *after* a slow sweep enumerated the prefix. Without
    it, a full sweep could delete today's data the instant it appeared.
    """

    dates: frozenset[str] | None = None
    protect: frozenset[str] = frozenset()

    def covers(self, date: str) -> bool:
        return self.dates is None or date in self.dates


class EventStore:
    """In-memory index of all channel data, keyed by (location, camera)."""

    def __init__(
        self, bus: EventBus | None = None, *, reconcile_dry_run: bool = False
    ) -> None:
        self._bus = bus or EventBus()
        # (loc, cam) -> date -> DateIndex
        self._dates: dict[LocCam, dict[str, DateIndex]] = defaultdict(dict)
        # (loc, cam) -> sorted set of dates (calendar)
        self._calendar: dict[LocCam, set[str]] = defaultdict(set)
        self._locks: dict[LocCam, asyncio.Lock] = defaultdict(asyncio.Lock)
        # When set, reconcile() computes and logs what it *would* remove but
        # leaves the index untouched. Lets a deployment be observed against a
        # live bucket before deletion is trusted; see reconcile().
        self._dry_run = reconcile_dry_run

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

    def clear(self) -> None:
        """Drop every indexed slice and calendar entry.

        Used by the admin 'flush historical cache' action: after this the
        store is empty and a triggered rescan cold-rebuilds it from S3. The
        per-(loc, cam) locks are retained (they're cheap and may be held by an
        in-flight apply); only the data is cleared. Callers that also want the
        live UI to refresh should publish a calendar/dayChange afterwards.
        """
        self._dates.clear()
        self._calendar.clear()

    # -- ingestion -------------------------------------------------------

    # Yield to the event loop every N events so a large poll batch (the
    # current-day scan can return 6000+ events for a busy camera) doesn't
    # monopolise the loop and starve in-flight API requests.
    _YIELD_EVERY = 200

    async def apply(self, events: list[ObjectEvent]) -> set[tuple[str, str, str]]:
        """Apply a batch of object events and publish resulting changes.

        Batched so a poll cycle's worth of changes are applied under the
        lock once per affected (loc, cam), and duplicate StoreChanges are
        coalesced before publishing.

        Returns the set of ``(location, camera, date)`` slices touched, so a
        caller (e.g. the poll engine) can persist exactly those to disk.
        """
        changes: set[StoreChange] = set()
        for i, event in enumerate(events):
            parsed = self._classify(event)
            if parsed is None:
                continue  # non-conforming key — safely ignored
            loc_cam, change = parsed
            async with self._locks[loc_cam]:
                self._mutate(event.kind, loc_cam, event)
            if change is not None:
                changes.add(change)
            if i and i % self._YIELD_EVERY == 0:
                await asyncio.sleep(0)
        for change in changes:
            self._bus.publish(change)
        return {(c.location, c.camera, c.date) for c in changes if c.date is not None}

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
        """Insert a single object into the indexes (lock held).

        Only CREATED does anything. Deletion is reconciliation's job (see
        :meth:`reconcile`) — a per-key REMOVED can't be applied safely on its
        own, because within one diff batch a rename emits CREATED(new) before
        REMOVED(old) and both name the same logical slot.
        """
        if kind is ObjectKind.CREATED:
            self._insert(loc_cam, event)

    def _insert(self, loc_cam: LocCam, event: ObjectEvent) -> None:
        key = event.key
        if (ev := parse_channel_event(key)) is not None:
            idx = self._date_index(loc_cam, ev.day_obs)
            if ev.is_per_day:
                # Presence + seq + extension is the whole payload: the rest of
                # the key is {camera}/{date}/{channel}/, which every caller
                # already has, and the proxy lists that prefix to find the
                # actual filename.
                idx.per_day[ev.channel] = PerDayRef(seq=str(ev.seq_num), ext=ev.ext)
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

    async def reconcile(
        self, loc_cam: LocCam, observed: set[str], scope: ScanScope
    ) -> set[str]:
        """Drop indexed data absent from an authoritative listing.

        ``observed`` is every object key the listing returned. Within
        ``scope``, anything indexed but not present in ``observed`` is gone
        from the bucket and is removed: stale slots inside a date, and whole
        dates that no longer exist at all (e.g. a warm-start cache slice whose
        source keys were deleted while the process was down).

        Set-difference reconciliation is what makes deletion correct without
        per-object bookkeeping. A rename lands as CREATED(new) + REMOVED(old)
        in one batch, but both keys resolve to the same (channel, seq) slot,
        so the slot survives on the strength of the new key alone.

        Every removal is logged (``store.reconcile.stale``), because this is
        the only path that deletes indexed data and it acts on the strength of
        a listing: a truncated or mis-scoped listing would otherwise silently
        erase live data with no trace of what went. In ``dry_run`` mode the
        same difference is computed and logged but nothing is mutated, so a
        deployment can be watched before it is trusted.

        Publishes a ``calendarUpdate`` per dropped date so listeners refresh,
        and returns the dropped dates so the caller can evict cache slices.
        Takes the per-(loc, cam) lock, like ``apply``.
        """
        wanted = _index_keys(observed)
        dropped: set[str] = set()
        changed: set[str] = set()
        async with self._locks[loc_cam]:
            dates = self._dates.get(loc_cam)
            if not dates:
                return set()
            for date in list(dates):
                if not scope.covers(date) or date in scope.protect:
                    continue
                idx = dates[date]
                stale = _stale_entries(idx, wanted.get(date, _EMPTY_SLICE))
                if stale.is_empty:
                    continue
                # Log before mutating, so a crash mid-apply still leaves a
                # record of what was about to go.
                log.info(
                    "store.reconcile.stale",
                    location=loc_cam[0],
                    camera=loc_cam[1],
                    date=date,
                    entries=stale.total,
                    dry_run=self._dry_run,
                    **stale.summary(),
                )
                if self._dry_run:
                    continue
                _apply_stale(idx, stale)
                changed.add(date)
                if idx.is_empty:
                    del dates[date]
                    self._calendar[loc_cam].discard(date)
                    dropped.add(date)
        for date in dropped:
            log.info(
                "store.reconcile.date_dropped",
                location=loc_cam[0],
                camera=loc_cam[1],
                date=date,
            )
            self._bus.publish(
                StoreChange("calendarUpdate", loc_cam[0], loc_cam[1], date)
            )
        # A date that lost slots but still exists needs a data refresh too.
        for date in changed - dropped:
            self._bus.publish(StoreChange("channelData", loc_cam[0], loc_cam[1], date))
        return dropped

    def _date_index(self, loc_cam: LocCam, date: str) -> DateIndex:
        dates = self._dates[loc_cam]
        if date not in dates:
            dates[date] = DateIndex()
        return dates[date]

    # -- reads (copy-on-read snapshots) ----------------------------------

    def calendar(self, location: str, camera: str) -> list[str]:
        """Return all dates with data for a camera, newest first."""
        return sorted(self._calendar.get((location, camera), set()), reverse=True)

    def latest_date(self, location: str, camera: str) -> str | None:
        """The most recent date with data for a camera, or None if it has none.

        Drives the location/sidebar freshness dot without materialising the
        whole calendar.
        """
        dates = self._calendar.get((location, camera))
        return max(dates) if dates else None

    def calendar_counts(self, location: str, camera: str) -> dict[str, int]:
        """Per-date exposure count (distinct seq_nums across all channels).

        Feeds the date picker's activity overview (heatmap tint). A day with
        only per-day artifacts or a night report (no per-seq channels) counts
        as 0.
        """
        dates = self._dates.get((location, camera), {})
        counts: dict[str, int] = {}
        for date, idx in dates.items():
            seqs: set[object] = set()
            for chan_seqs in idx.channels.values():
                seqs |= chan_seqs
            counts[date] = len(seqs)
        return counts

    def calendar_max_seq(self, location: str, camera: str) -> dict[str, int]:
        """Per-date highest integer seq_num across all channels.

        Shown in the calendar's month-grid cells. Word-sentinel seqs (e.g.
        ``"final"``) and days with no numeric seqs are omitted.
        """
        dates = self._dates.get((location, camera), {})
        max_seq: dict[str, int] = {}
        for date, idx in dates.items():
            highest = -1
            for chan_seqs in idx.channels.values():
                for s in chan_seqs:
                    if isinstance(s, int) and s > highest:
                        highest = s
            if highest >= 0:
                max_seq[date] = highest
        return max_seq

    def calendar_channel_latest(self, location: str, camera: str) -> dict[str, str]:
        """Most recent date with data, per channel, newest first.

        The per-date calendar tells the channel grid which dates the *camera*
        has data on, but not which dates a given *channel* does. A channel that
        is quiet on the newest date (the grid's "no recent frame" state) needs
        its own last-known date so its card can link to that plot instead of a
        live view that would render nothing. Both per-seq channels
        (``idx.channels``) and per-day artifacts (``idx.per_day``) count as
        data. Single in-memory pass over the already-hydrated index — no scan.
        """
        dates = self._dates.get((location, camera), {})
        latest: dict[str, str] = {}
        for date in sorted(dates, reverse=True):
            idx = dates[date]
            for channel in (*idx.channels, *idx.per_day):
                if channel not in latest:
                    latest[channel] = date
        return latest

    def latest_channel_image(
        self, location: str, camera: str, channel: str
    ) -> tuple[str, int, str] | None:
        """Newest per-seq frame for one channel, as ``(date, seq, ext)``.

        Drives the camera-card thumbnail on location pages: the location
        endpoint turns this into a proxied image URL for the camera's primary
        channel. Walks dates newest-first and, on the first date where the
        channel has an integer seq, returns that date's highest seq with its
        file extension. Per-day artifacts (movies/stills, no comparable seq)
        and word-sentinel seqs are skipped — a card thumbnail needs a concrete
        still frame. ``None`` if the channel has no such frame anywhere.
        """
        dates = self._dates.get((location, camera), {})
        for date in sorted(dates, reverse=True):
            idx = dates[date]
            seqs = [s for s in idx.channels.get(channel, ()) if isinstance(s, int)]
            if not seqs:
                continue
            seq = max(seqs)
            ext = idx.extensions.get(channel)
            file_ext = (ext.for_seq(seq) if ext else None) or "png"
            return date, seq, file_ext
        return None

    def date_index(self, location: str, camera: str, date: str) -> DateIndex | None:
        """Return the index for one date, or ``None`` if absent."""
        return self._dates.get((location, camera), {}).get(date)

    def has_night_report(self, location: str, camera: str, date: str) -> bool:
        idx = self.date_index(location, camera, date)
        return bool(idx and idx.night_report_keys)


@dataclass(frozen=True, slots=True)
class _IndexSlice:
    """The presence an observed listing implies for one date."""

    channels: dict[str, set[SeqNum]]
    per_day: set[str]
    night_report_keys: set[str]


_EMPTY_SLICE = _IndexSlice(channels={}, per_day=set(), night_report_keys=set())


def _index_keys(observed: set[str]) -> dict[str, _IndexSlice]:
    """Project raw object keys onto the shape the index stores.

    Parsing the listing into the same (channel, seq) presence the index holds
    is what lets reconciliation be a plain set difference — filenames never
    enter the comparison, so a renamed object matches the slot it backs.
    """
    slices: dict[str, _IndexSlice] = {}

    def slice_for(date: str) -> _IndexSlice:
        if date not in slices:
            slices[date] = _IndexSlice(
                channels={}, per_day=set(), night_report_keys=set()
            )
        return slices[date]

    for key in observed:
        if (ev := parse_channel_event(key)) is not None:
            sl = slice_for(ev.day_obs)
            if ev.is_per_day:
                sl.per_day.add(ev.channel)
            else:
                sl.channels.setdefault(ev.channel, set()).add(ev.seq_num)
        elif (nr := parse_night_report(key)) is not None:
            slice_for(nr.day_obs).night_report_keys.add(key)
    return slices


@dataclass(frozen=True, slots=True)
class StaleEntries:
    """What a reconciliation would remove from one date's index.

    Computed without mutating anything, so the same pass can drive a dry run
    (log what *would* go) and the real application. ``total`` is the count
    used for logging; ``is_empty`` says the index is already consistent with
    the listing.
    """

    seqs: dict[str, set[SeqNum]]
    per_day: set[str]
    night_report_keys: set[str]

    @property
    def total(self) -> int:
        return (
            sum(len(s) for s in self.seqs.values())
            + len(self.per_day)
            + len(self.night_report_keys)
        )

    @property
    def is_empty(self) -> bool:
        return not (self.seqs or self.per_day or self.night_report_keys)

    def summary(self) -> dict[str, object]:
        """Compact, log-friendly description of what would be dropped."""
        return {
            "seqs": {ch: sorted(s, key=str) for ch, s in self.seqs.items()},
            "per_day": sorted(self.per_day),
            "night_report_keys": sorted(self.night_report_keys),
        }


def _stale_entries(idx: DateIndex, wanted: _IndexSlice) -> StaleEntries:
    """What in ``idx`` is absent from ``wanted``. Pure — mutates nothing."""
    seqs: dict[str, set[SeqNum]] = {}
    for channel, indexed in idx.channels.items():
        stale = indexed - wanted.channels.get(channel, set())
        if stale:
            seqs[channel] = stale
    return StaleEntries(
        seqs=seqs,
        per_day={ch for ch in idx.per_day if ch not in wanted.per_day},
        night_report_keys=idx.night_report_keys - wanted.night_report_keys,
    )


def _apply_stale(idx: DateIndex, stale: StaleEntries) -> None:
    """Remove the entries ``_stale_entries`` identified (lock held)."""
    for channel, gone in stale.seqs.items():
        idx.channels[channel] -= gone
        ext = idx.extensions.get(channel)
        if ext is not None:
            for seq in gone:
                ext.exceptions.pop(seq, None)
        if not idx.channels[channel]:
            del idx.channels[channel]
            idx.extensions.pop(channel, None)
    for channel in stale.per_day:
        del idx.per_day[channel]
    idx.night_report_keys -= stale.night_report_keys


def _date_of(key: str) -> str | None:
    """Extract the day_obs from any conforming key, without full parsing."""
    if (ev := parse_channel_event(key)) is not None:
        return ev.day_obs
    if (nr := parse_night_report(key)) is not None:
        return nr.day_obs
    if (md := parse_metadata(key)) is not None:
        return md.day_obs
    return None
