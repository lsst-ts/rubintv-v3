"""S3Poller diff behaviour against a moto bucket."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

import boto3
import pytest
from moto import mock_aws

from rubintv.config.models import Location
from rubintv.data.events import ObjectKind
from rubintv.data.source import S3Poller
from rubintv.s3.client import S3ClientPool

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


def test_first_scan_reports_all_as_created(poller: PollerFixture) -> None:
    poller.put("lsstcam/2026-04-10/c/000001/a.png")  # type: ignore[operator]
    changes = poller.poller.scan("local", "lsstcam/")
    assert len(changes) == 1
    assert changes[0].kind is ObjectKind.CREATED


def test_unchanged_second_scan_reports_nothing(poller: PollerFixture) -> None:
    poller.put("lsstcam/2026-04-10/c/000001/a.png")  # type: ignore[operator]
    poller.poller.scan("local", "lsstcam/")
    assert poller.poller.scan("local", "lsstcam/") == []


def test_reset_re_emits_everything(poller: PollerFixture) -> None:
    key = "lsstcam/2026-04-10/c/000001/a.png"
    poller.put(key)  # type: ignore[operator]
    poller.poller.scan("local", "lsstcam/")
    # Settled: a repeat scan is silent. After reset (the flush-historical
    # path), the same unchanged key must be re-emitted so the cleared store
    # can be rebuilt.
    assert poller.poller.scan("local", "lsstcam/") == []
    poller.poller.reset()
    changes = poller.poller.scan("local", "lsstcam/")
    assert [c.key for c in changes] == [key]
    assert changes[0].kind is ObjectKind.CREATED


def test_scan_spanning_a_reset_does_not_rearm_stale_state(
    poller: PollerFixture,
) -> None:
    key = "lsstcam/2026-04-10/c/000001/a.png"
    poller.put(key)  # type: ignore[operator]
    p = poller.poller
    p.scan("local", "lsstcam/")
    # Simulate a reset landing while a scan is in flight (between its listing
    # and its state write-back) by resetting from inside the listing call.
    original_list = p._list

    def list_then_reset(location: str, bucket: str, prefix: str) -> dict[str, str]:
        result = original_list(location, bucket, prefix)
        p.reset()
        return result

    p._list = list_then_reset  # type: ignore[method-assign]
    p.scan("local", "lsstcam/")
    p._list = original_list  # type: ignore[method-assign]
    # The spanning scan must not have written its listing back: the next
    # scan still re-emits everything for the cleared store.
    changes = p.scan("local", "lsstcam/")
    assert [c.key for c in changes] == [key]


def test_removed_object_reported(poller: PollerFixture) -> None:
    key = "lsstcam/2026-04-10/c/000001/a.png"
    poller.put(key)  # type: ignore[operator]
    poller.poller.scan("local", "lsstcam/")
    poller.delete(key)  # type: ignore[operator]
    changes = poller.poller.scan("local", "lsstcam/")
    assert len(changes) == 1
    assert changes[0].kind is ObjectKind.REMOVED
    assert changes[0].key == key


def test_observed_dates_reflects_last_listing(poller: PollerFixture) -> None:
    poller.put("auxtel/2026-04-10/monitor/000001/a.png")  # type: ignore[operator]
    poller.put("auxtel/2026-04-11/monitor/000001/b.png")  # type: ignore[operator]
    poller.put("auxtel/2026-04-11/metadata.json")  # type: ignore[operator]
    poller.poller.scan("local", "auxtel/")
    # Dates present in the bucket, deduped across keys; metadata counts too.
    assert poller.poller.observed_dates("local", "auxtel/") == {
        "2026-04-10",
        "2026-04-11",
    }


def test_observed_dates_drops_a_vanished_date(poller: PollerFixture) -> None:
    poller.put("auxtel/2026-04-10/monitor/000001/a.png")  # type: ignore[operator]
    poller.poller.scan("local", "auxtel/")
    poller.delete("auxtel/2026-04-10/monitor/000001/a.png")  # type: ignore[operator]
    poller.poller.scan("local", "auxtel/")
    # A re-listing with the key gone leaves no observed dates, so a sweep
    # treats the date as stale and prunes it.
    assert poller.poller.observed_dates("local", "auxtel/") == set()


def test_observed_dates_unscanned_prefix_is_empty(poller: PollerFixture) -> None:
    assert poller.poller.observed_dates("local", "auxtel/") == set()
