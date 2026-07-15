"""Shared test fixtures."""

from __future__ import annotations

import os
import tempfile
import time
from collections.abc import Iterator
from importlib.resources import files
from pathlib import Path
from typing import Any

import boto3
import httpx
import pytest
import yaml
from fastapi.testclient import TestClient
from lsst.ts.rubintv.app import create_app
from lsst.ts.rubintv.config.settings import Settings
from moto import mock_aws

# The models YAML now ships inside the package; point tests at the packaged
# copy so there is a single source of truth. It's a real file on disk in a
# checkout, so a plain Path is fine (no zip-import materialisation needed
# for tests).
CONFIG_PATH = Path(str(files("lsst.ts.rubintv.models").joinpath("models_data.yaml")))

# The whole app is served under this prefix (settings.path_prefix). Tests
# address routes by their unprefixed path (e.g. "/api/health/ready") and the
# client below prepends the prefix, so both the prefix wiring and the routes
# stay covered without threading it through every call site.
TEST_PREFIX = "/rubintv"


class PrefixedTestClient(TestClient):
    """TestClient that prepends ``TEST_PREFIX`` to same-app request paths.

    Absolute URLs (``http://...``) pass through untouched; anything starting
    ``/`` is treated as an in-app path and gets the prefix. Covers the HTTP
    verbs and ``websocket_connect``.
    """

    def request(self, method: str, url: Any, *args: Any, **kwargs: Any) -> Any:
        return super().request(method, self._prefixed(url), *args, **kwargs)

    def websocket_connect(self, url: str, *args: Any, **kwargs: Any) -> Any:
        return super().websocket_connect(self._prefixed(url), *args, **kwargs)

    @staticmethod
    def _prefixed(url: Any) -> Any:
        if isinstance(url, str) and url.startswith("/"):
            return f"{TEST_PREFIX}{url}"
        if isinstance(url, httpx.URL) and url.path.startswith("/"):
            return url.copy_with(path=f"{TEST_PREFIX}{url.path}")
        return url


# The test site exposes a single location named "test" backed by this bucket.
# Tests never touch the production-shaped sites (usdf, summit, etc.).
TEST_SITE = "test"
TEST_LOCATION = "test"
TEST_BUCKET = "rubintv-local"

# Back-compat aliases for tests written before the rename.
LOCAL_BUCKET = TEST_BUCKET


@pytest.fixture(scope="session", autouse=True)
def aws_profiles() -> Iterator[None]:
    """Hermetic AWS config declaring every profile the models YAML names.

    Deployments mount an AWS config that defines these profiles; without
    one, building a boto3 session for a real location raises
    ProfileNotFound. Write a stand-in config and point boto3 at it, so the
    suite neither requires nor reads the developer's ~/.aws and behaves
    the same locally and on CI.
    """
    raw = yaml.safe_load(CONFIG_PATH.read_text())
    profiles = sorted(
        {loc["profile_name"] for loc in raw["locations"] if loc.get("profile_name")}
    )
    with tempfile.TemporaryDirectory() as tmp:
        config = Path(tmp) / "config"
        config.write_text(
            "".join(f"[profile {p}]\nregion = us-east-1\n" for p in profiles)
        )
        (Path(tmp) / "credentials").touch()
        saved = {
            var: os.environ.get(var)
            for var in ("AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE")
        }
        os.environ["AWS_CONFIG_FILE"] = str(config)
        os.environ["AWS_SHARED_CREDENTIALS_FILE"] = str(Path(tmp) / "credentials")
        try:
            yield
        finally:
            for var, value in saved.items():
                if value is None:
                    del os.environ[var]
                else:
                    os.environ[var] = value


@pytest.fixture
def settings() -> Settings:
    """Settings pointed at the repo's sample config, no Redis, no cache.

    The ``test`` site's ``admin_for`` is the ``["*"]`` wildcard, which is now
    fail-closed by default; enable it here so admin-path tests exercise the
    open-admin behaviour they mean to.
    """
    return Settings(
        site=TEST_SITE,
        models_path=CONFIG_PATH,
        cache_dir=None,
        redis_url=None,
        poll_interval_seconds=0.05,
        allow_admin_wildcard=True,
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
    with PrefixedTestClient(app) as test_client:
        for _ in range(40):
            if test_client.get("/api/health/ready").json()["ready"]:
                break
            time.sleep(0.05)
        yield test_client
