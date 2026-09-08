"""S3Poller listing behaviour against a moto bucket.

The poller is stateless: every scan reports what is currently under the
prefix, and deletion is detected by the store reconciling against the same
listing (see test_store.py) rather than by a synthesised REMOVED event.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

import boto3
import pytest
from lsst.ts.rubintv.config.models import Location
from lsst.ts.rubintv.data.events import ObjectKind
from lsst.ts.rubintv.data.source import S3Poller
from lsst.ts.rubintv.s3.client import S3ClientPool
from moto import mock_aws

BUCKET = "rubintv-local"


@dataclass
class PollerFixture:
    poller: S3Poller
    put: object  # boto3 client; typed loosely to avoid stub gymnastics
    delete: object


@pytest.fixture
def poller() -> Iterator[PollerFixture]:
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=BUCKET)
        pool = S3ClientPool([Location(name="local", title="L", bucket=BUCKET)])
        p = S3Poller(pool.client_for)
        p.register_bucket("local", BUCKET)

        def put(key: str) -> None:
            s3.put_object(Bucket=BUCKET, Key=key, Body=b"x")

        def delete(key: str) -> None:
            s3.delete_object(Bucket=BUCKET, Key=key)

        yield PollerFixture(poller=p, put=put, delete=delete)


def test_scan_reports_everything_as_created(poller: PollerFixture) -> None:
    poller.put("lsstcam/2026-04-10/c/000001/a.png")  # type: ignore[operator]
    result = poller.poller.scan("local", "lsstcam/")
    assert len(result.events) == 1
    assert result.events[0].kind is ObjectKind.CREATED


def test_repeat_scan_re_emits_the_same_keys(poller: PollerFixture) -> None:
    key = "lsstcam/2026-04-10/c/000001/a.png"
    poller.put(key)  # type: ignore[operator]
    poller.poller.scan("local", "lsstcam/")
    # No diff state, so an unchanged bucket still reports its contents. The
    # store upserts into presence sets, making the repeat a no-op there.
    assert [c.key for c in poller.poller.scan("local", "lsstcam/").events] == [key]


def test_reset_is_a_noop(poller: PollerFixture) -> None:
    key = "lsstcam/2026-04-10/c/000001/a.png"
    poller.put(key)  # type: ignore[operator]
    poller.poller.scan("local", "lsstcam/")
    # The flush-historical path calls reset(); with no cross-scan state there
    # is nothing to undo, and the next scan rebuilds the cleared store anyway.
    poller.poller.reset()
    assert [c.key for c in poller.poller.scan("local", "lsstcam/").events] == [key]


def test_deleted_object_absent_from_next_listing(poller: PollerFixture) -> None:
    key = "lsstcam/2026-04-10/c/000001/a.png"
    poller.put(key)  # type: ignore[operator]
    poller.poller.scan("local", "lsstcam/")
    poller.delete(key)  # type: ignore[operator]
    result = poller.poller.scan("local", "lsstcam/")
    # No REMOVED event is synthesised — the key's absence from `keys` is what
    # the store reconciles against.
    assert result.events == []
    assert result.keys == set()


def test_keys_carry_the_whole_listing(poller: PollerFixture) -> None:
    poller.put("auxtel/2026-04-10/monitor/000001/a.png")  # type: ignore[operator]
    poller.put("auxtel/2026-04-11/metadata.json")  # type: ignore[operator]
    result = poller.poller.scan("local", "auxtel/")
    assert result.keys == {
        "auxtel/2026-04-10/monitor/000001/a.png",
        "auxtel/2026-04-11/metadata.json",
    }


def test_dates_reflect_the_listing(poller: PollerFixture) -> None:
    poller.put("auxtel/2026-04-10/monitor/000001/a.png")  # type: ignore[operator]
    poller.put("auxtel/2026-04-11/monitor/000001/b.png")  # type: ignore[operator]
    poller.put("auxtel/2026-04-11/metadata.json")  # type: ignore[operator]
    result = poller.poller.scan("local", "auxtel/")
    # Dates present in the bucket, deduped across keys; metadata counts too.
    assert result.dates == {"2026-04-10", "2026-04-11"}


def test_dates_empty_for_an_empty_prefix(poller: PollerFixture) -> None:
    assert poller.poller.scan("local", "auxtel/").dates == set()


def test_events_are_emitted_in_sorted_key_order(poller: PollerFixture) -> None:
    # ExtInfo takes the first extension it sees for a channel as the default,
    # so emission order decides how a date's extensions are classified. A set
    # iterates arbitrarily; sorting keeps the lowest seq authoritative and the
    # result stable across scans.
    poller.put("lsstcam/2026-04-10/c/000002/b.jpg")  # type: ignore[operator]
    poller.put("lsstcam/2026-04-10/c/000001/a.png")  # type: ignore[operator]
    poller.put("lsstcam/2026-04-10/c/000003/c.png")  # type: ignore[operator]
    emitted = [e.key for e in poller.poller.scan("local", "lsstcam/").events]
    assert emitted == sorted(emitted)
