"""Data sources: how objects arrive.

``DataSource`` is the only thing that knows the ingestion mechanism. It
emits normalised ``ObjectEvent``s; everything downstream is identical
whether the source polls S3 or (future) consumes a Kafka topic.

``S3Poller`` implements the interface by listing a prefix and emitting a
``CREATED`` per object found. It holds no state between scans: the store is
idempotent (inserts are upserts into presence sets), so re-emitting
unchanged keys is a no-op, and deletion is handled by the store
reconciling against the same listing rather than by a synthesised REMOVED.

That statelessness is deliberate. The previous design cached each prefix's
last listing to diff against, which meant retaining every object key in the
bucket — gigabytes, and unbounded in the bucket's size — purely to answer
"did this change?". It doesn't need answering: the store already knows what
it holds, and an object's content changing is invisible to a presence index
anyway (the browser revalidates media against S3 by ETag on its own).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from lsst.ts.rubintv.data.events import ObjectEvent, ObjectKind
from lsst.ts.rubintv.data.parser import (
    parse_channel_event,
    parse_metadata,
    parse_night_report,
)
from lsst.ts.rubintv.logging import get_logger

if TYPE_CHECKING:
    from mypy_boto3_s3.client import S3Client

log = get_logger(__name__)


class DataSource(Protocol):
    """Emits object presence for a location under a key prefix.

    ``scan`` is synchronous (it does blocking I/O); callers run it off the
    event loop via ``asyncio.to_thread``. A future push-based source (Kafka)
    would instead implement an async iterator, but the polling source is
    inherently a blocking listing.
    """

    def scan(self, location: str, prefix: str) -> ScanResult:
        """Return everything currently under ``prefix``."""
        ...


@dataclass(frozen=True, slots=True)
class ScanResult:
    """One listing: the events to apply, and the raw keys observed.

    ``keys`` is what the listing actually returned, so a caller can
    reconcile the store against it (anything indexed under the scanned
    scope but missing here has been deleted). It is consumed immediately
    and not retained.
    """

    events: list[ObjectEvent]
    keys: set[str]

    @property
    def dates(self) -> set[str]:
        """The day_obs values present in this listing."""
        return {date for key in self.keys if (date := _date_of(key)) is not None}


class S3Poller:
    """A ``DataSource`` that lists S3 prefixes.

    Stateless between scans — see the module docstring for why the previous
    listing is neither kept nor needed.
    """

    def __init__(self, client_for: ClientFactory) -> None:
        self._client_for = client_for
        # location -> bucket name, filled lazily from the client factory.
        self._buckets: dict[str, str] = {}

    def register_bucket(self, location: str, bucket: str) -> None:
        """Tell the poller which bucket backs a location."""
        self._buckets[location] = bucket

    def reset(self) -> None:
        """No-op, kept for API compatibility with the admin flush action.

        The poller holds no cross-scan state, so a flush of the store needs
        nothing undone here: the next scan re-lists the bucket and re-emits
        everything regardless.
        """

    def scan(self, location: str, prefix: str) -> ScanResult:
        """List ``prefix`` and emit a CREATED for every object under it.

        Events are emitted in sorted key order. ``ExtInfo`` treats the first
        extension it sees for a channel as that channel's default and the rest
        as exceptions, so an arbitrary iteration order would make the default
        depend on which key happened to come first — the same date could
        classify differently between two scans.
        """
        bucket = self._buckets.get(location)
        if bucket is None:
            raise KeyError(f"no bucket registered for location {location!r}")
        keys = self._list(location, bucket, prefix)
        events = [
            ObjectEvent(kind=ObjectKind.CREATED, location=location, key=key)
            for key in sorted(keys)
        ]
        return ScanResult(events=events, keys=keys)

    def _list(self, location: str, bucket: str, prefix: str) -> set[str]:
        client: S3Client = self._client_for(location)
        paginator = client.get_paginator("list_objects_v2")
        result: set[str] = set()
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                result.add(obj["Key"])
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


if TYPE_CHECKING:
    from collections.abc import Callable

    ClientFactory = Callable[[str], S3Client]
else:
    ClientFactory = object
