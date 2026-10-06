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

"""S3 client pool against a moto-mocked S3.

Phase 1 only needs to prove the pool creates and reuses a client per
location and rejects unknown locations. Real listing/parsing arrives in
Phase 2.
"""

from __future__ import annotations

import boto3
import pytest
from lsst.ts.rubintv.config.models import Location
from lsst.ts.rubintv.s3.client import S3ClientPool
from moto import mock_aws


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


def test_default_endpoint_fills_only_locations_without_their_own() -> None:
    # The chart's S3_ENDPOINT_URL is a fallback: a location that declares an
    # endpoint keeps it; one that doesn't would otherwise hit real AWS.
    pool = S3ClientPool(
        [
            Location(name="bare", title="Bare", bucket="b"),
            Location(
                name="own", title="Own", bucket="b", endpoint="https://own.example"
            ),
        ],
        default_endpoint="https://fallback.example",
    )
    assert pool.client_for("bare").meta.endpoint_url == "https://fallback.example"
    assert pool.poller_client_for("bare").meta.endpoint_url == (
        "https://fallback.example"
    )
    assert pool.client_for("own").meta.endpoint_url == "https://own.example"


def test_empty_default_endpoint_counts_as_unset() -> None:
    pool = S3ClientPool(
        [Location(name="bare", title="Bare", bucket="b")], default_endpoint=""
    )
    assert "amazonaws.com" in pool.client_for("bare").meta.endpoint_url
