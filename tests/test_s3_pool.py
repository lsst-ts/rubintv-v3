"""S3 client pool against a moto-mocked S3.

Phase 1 only needs to prove the pool creates and reuses a client per
location and rejects unknown locations. Real listing/parsing arrives in
Phase 2.
"""

from __future__ import annotations

import boto3
import pytest
from moto import mock_aws

from rubintv.config.models import Location
from rubintv.s3.client import S3ClientPool


@pytest.fixture
def locations() -> list[Location]:
    return [Location(name="local", title="Local", bucket="rubintv-local")]


@mock_aws
def test_client_created_and_reused(locations: list[Location]) -> None:
    # Stand up a fake bucket with one well-formed object.
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket="rubintv-local")
    s3.put_object(
        Bucket="rubintv-local",
        Key="lsstcam/2026-04-10/witness_detector/000001/image.png",
        Body=b"x",
    )

    pool = S3ClientPool(locations)
    client_a = pool.client_for("local")
    client_b = pool.client_for("local")
    assert client_a is client_b  # reused, not recreated

    listing = client_a.list_objects_v2(Bucket="rubintv-local")
    assert listing["KeyCount"] == 1

    pool.close()


def test_unknown_location_raises(locations: list[Location]) -> None:
    pool = S3ClientPool(locations)
    with pytest.raises(KeyError, match="unknown location"):
        pool.client_for("nowhere")


@mock_aws
def test_poller_client_uses_tight_timeouts(locations: list[Location]) -> None:
    # The poller runs on a ~1s cadence, so a hung connection must fail fast
    # rather than block on botocore's 60s default. The interactive client keeps
    # the more patient default retry policy for user requests.
    pool = S3ClientPool(locations)
    poller = pool.poller_client_for("local")
    default = pool.client_for("local")

    # botocore stores the configured retry count as total attempts
    # (max_attempts=1 -> 1 initial + 1 retry = 2 total).
    pcfg = poller.meta.config
    assert pcfg.connect_timeout == 5
    assert pcfg.read_timeout == 10
    assert pcfg.retries["total_max_attempts"] == 2

    # The default client is left on botocore's standard (patient) timeouts:
    # the 60s default connect timeout and 3 retries (4 total attempts).
    dcfg = default.meta.config
    assert dcfg.connect_timeout == 60
    assert dcfg.retries["total_max_attempts"] == 4

    pool.close()
