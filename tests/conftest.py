"""Shared test fixtures."""

from __future__ import annotations

import time
from collections.abc import Iterator
from pathlib import Path

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from rubintv.app import create_app
from rubintv.config.settings import Settings

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "models_data.yaml"

# The test site exposes a single location named "test" backed by this bucket.
# Tests never touch the production-shaped sites (usdf, summit, etc.).
TEST_SITE = "test"
TEST_LOCATION = "test"
TEST_BUCKET = "rubintv-local"

# Back-compat aliases for tests written before the rename.
LOCAL_BUCKET = TEST_BUCKET


@pytest.fixture
def settings() -> Settings:
    """Settings pointed at the repo's sample config, no Redis, no cache."""
    return Settings(
        site=TEST_SITE,
        models_path=CONFIG_PATH,
        cache_dir=None,
        redis_url=None,
        poll_interval_seconds=0.05,
    )


@pytest.fixture
def s3_bucket() -> Iterator[None]:
    """A moto-mocked S3 with the test bucket created."""
    with mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=TEST_BUCKET)
        yield


@pytest.fixture
def client(settings: Settings, s3_bucket: None) -> Iterator[TestClient]:
    """A TestClient with the lifespan run (store, poll engine started).

    Waits briefly for the first poll to flip readiness.
    """
    app = create_app(settings)
    with TestClient(app) as test_client:
        for _ in range(40):
            if test_client.get("/api/health/ready").json()["ready"]:
                break
            time.sleep(0.05)
        yield test_client
