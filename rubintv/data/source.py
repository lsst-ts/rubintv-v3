"""Data sources: how objects arrive.

``DataSource`` is the only thing that knows the ingestion mechanism. It
emits normalised ``ObjectEvent``s; everything downstream is identical
whether the source polls S3 or (future) consumes a Kafka topic.

``S3Poller`` implements the interface by listing a prefix and *diffing*
against the previous listing to synthesise created / removed / updated
events. ETag change on a still-present key is an update (emitted as
``CREATED`` — the store treats created and updated identically: upsert).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

from rubintv.data.events import ObjectEvent, ObjectKind
from rubintv.data.parser import (
    parse_channel_event,
    parse_metadata,
    parse_night_report,
)
from rubintv.logging import get_logger

if TYPE_CHECKING:
    from mypy_boto3_s3.client import S3Client

log = get_logger(__name__)


class DataSource(Protocol):
    """Emits object changes for a location under a key prefix.

    ``scan`` is synchronous (it does blocking I/O); callers run it off the
    event loop via ``asyncio.to_thread``. A future push-based source (Kafka)
    would instead implement an async iterator, but the polling source is
    inherently a blocking listing.
    """

    def scan(self, location: str, prefix: str) -> list[ObjectEvent]:
        """Return the object changes observed since the last scan of prefix."""
        ...


class S3Poller:
    """A ``DataSource`` that diffs successive S3 listings.

    State is kept per ``(location, prefix)`` so each watched prefix (e.g.
    today's data per camera) diffs independently.
    """

    def __init__(self, client_for: ClientFactory) -> None:
        self._client_for = client_for
        # (location, prefix) -> {key: etag}
        self._seen: dict[tuple[str, str], dict[str, str]] = {}
        # location -> bucket name, filled lazily from the client factory.
        self._buckets: dict[str, str] = {}
        # Bumped by reset(); scans started before a reset must not write
        # their listing back, or the post-reset rescan would diff against
        # stale state and re-emit nothing into the freshly cleared store.
        self._generation = 0

    def register_bucket(self, location: str, bucket: str) -> None:
        """Tell the poller which bucket backs a location."""
        self._buckets[location] = bucket

    def reset(self) -> None:
        """Forget all previous listings so the next scans re-emit everything.

        Pairs with clearing the EventStore (the admin flush-historical
        action): the diff state must be dropped with the data it described,
        otherwise the triggered rescan sees no changes and the store stays
        empty until keys actually change upstream.
        """
        self._generation += 1
        self._seen.clear()

    def scan(self, location: str, prefix: str) -> list[ObjectEvent]:
        """List ``prefix`` and return changes vs. the previous scan."""
        bucket = self._buckets.get(location)
        if bucket is None:
            raise KeyError(f"no bucket registered for location {location!r}")

        generation = self._generation
        current = self._list(location, bucket, prefix)
        previous = self._seen.get((location, prefix), {})
        changes = _diff(location, previous, current)
        if generation == self._generation:
            self._seen[(location, prefix)] = current
        return changes

    def observed_dates(self, location: str, prefix: str) -> set[str]:
        """Dates present in the most recent listing of ``prefix``.

        Derived from the keys captured by the last ``scan`` of this prefix,
        so callers can treat a full ``{camera}/`` sweep as authoritative for
        which dates exist in the bucket (and prune the rest). Keys that don't
        parse to a day_obs are ignored, matching the store's ingestion. An
        unscanned prefix yields the empty set.
        """
        seen = self._seen.get((location, prefix), {})
        return {date for key in seen if (date := _date_of(key)) is not None}

    def _list(self, location: str, bucket: str, prefix: str) -> dict[str, str]:
        client: S3Client = self._client_for(location)
        paginator = client.get_paginator("list_objects_v2")
        result: dict[str, str] = {}
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                result[obj["Key"]] = obj.get("ETag", "")
        return result


def _date_of(key: str) -> str | None:
    """Extract the day_obs from any conforming key, without full parsing."""
    if (ev := parse_channel_event(key)) is not None:
        return ev.day_obs
    if (nr := parse_night_report(key)) is not None:
        return nr.day_obs
    if (md := parse_metadata(key)) is not None:
        return md.day_obs
    return None


def _diff(
    location: str, previous: dict[str, str], current: dict[str, str]
) -> list[ObjectEvent]:
    """Compute created/updated (CREATED) and removed events between listings."""
    changes: list[ObjectEvent] = []
    for key, etag in current.items():
        if key not in previous or previous[key] != etag:
            changes.append(
                ObjectEvent(
                    kind=ObjectKind.CREATED, location=location, key=key, etag=etag
                )
            )
    for key in previous:
        if key not in current:
            changes.append(
                ObjectEvent(kind=ObjectKind.REMOVED, location=location, key=key)
            )
    return changes


if TYPE_CHECKING:
    from collections.abc import Callable

    ClientFactory = Callable[[str], S3Client]
else:
    ClientFactory = object
