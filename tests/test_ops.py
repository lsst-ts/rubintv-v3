"""Phase 7: SPA serving + catch-all, status endpoint, correlation header."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import boto3
from lsst.ts.rubintv.app import create_app
from lsst.ts.rubintv.config.settings import Settings
from moto import mock_aws

from tests.conftest import CONFIG_PATH, TEST_BUCKET, PrefixedTestClient


@contextmanager
def run_app(**overrides: object) -> Iterator[PrefixedTestClient]:
    settings = Settings(
        site="test",
        models_path=CONFIG_PATH,
        poll_interval_seconds=0.05,
        **overrides,  # type: ignore[arg-type]
    )
    with mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=TEST_BUCKET)
        with PrefixedTestClient(create_app(settings)) as client:
            yield client


def test_status_endpoint_reports_loading() -> None:
    with run_app() as client:
        body = client.get("/api/health/status").json()
        assert "ready" in body
        assert "historical_loading" in body
        # S3 connectivity is reported and healthy (fast) on a freshly-polled app.
        assert body["s3_healthy"] is True
        assert body["s3_slow"] is False
        # Per-camera readiness is present and well-formed for each camera.
        assert isinstance(body["cameras"], list)
        for cam in body["cameras"]:
            assert {"location", "camera", "recent_ready", "full_complete"} <= set(cam)


def test_status_reports_cold_start_when_cache_disabled() -> None:
    # No cache_dir: caching is off and there's nothing to warm-start from.
    with run_app() as client:
        body = client.get("/api/health/status").json()
        assert body["cache_enabled"] is False
        assert body["warm_start"] is False


def test_status_reports_warm_start_from_cached_snapshot(tmp_path: Path) -> None:
    # A populated cache directory: the v1 layout is {cache_dir}/v1/{loc}/{cam}/
    # {date}.json, and the store warm-starts from it, flipping warm_start.
    slice_dir = tmp_path / "v1" / "test" / "auxtel"
    slice_dir.mkdir(parents=True)
    (slice_dir / "2025-01-01.json").write_text(
        '{"version": "v1", "channels": {}, "extensions": {}, '
        '"per_day": {}, "night_report_keys": []}'
    )
    with run_app(cache_dir=tmp_path) as client:
        body = client.get("/api/health/status").json()
        assert body["cache_enabled"] is True
        assert body["warm_start"] is True


def test_status_reports_cold_start_with_empty_cache_dir(tmp_path: Path) -> None:
    # Caching enabled but nothing cached yet (first run): still a cold start.
    with run_app(cache_dir=tmp_path) as client:
        body = client.get("/api/health/status").json()
        assert body["cache_enabled"] is True
        assert body["warm_start"] is False


def test_correlation_header_echoed() -> None:
    with run_app() as client:
        resp = client.get("/api/health/live", headers={"X-Request-ID": "abc-123"})
        assert resp.headers["X-Request-ID"] == "abc-123"


def test_correlation_header_generated() -> None:
    with run_app() as client:
        resp = client.get("/api/health/live")
        assert resp.headers.get("X-Request-ID")


def test_spa_served_with_catch_all(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><div id=root></div>")
    (dist / "assets" / "app.js").write_text("console.log(1)")

    with run_app(spa_dist=dist) as client:
        # The prefix root ({prefix}/) serves index.html.
        assert "id=root" in client.get("/").text
        # A deep link (no matching API route) also serves index.html, so a
        # hard reload of an SPA route works.
        assert "id=root" in client.get("/summit/lsstcam/witness_detector").text
        # Hashed asset is served (under the prefix).
        assert client.get("/assets/app.js").status_code == 200
        # Nothing is served off-prefix: a bare path outside {prefix} is a 404,
        # not the SPA index — the whole app lives under the prefix.
        off_prefix = client.get(
            "http://testserver/summit/lsstcam", follow_redirects=False
        )
        assert off_prefix.status_code == 404


def test_spa_catch_all_does_not_shadow_api(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html>SPA")

    with run_app(spa_dist=dist) as client:
        # An unknown API path is a real 404, not the SPA index.
        resp = client.get("/api/locations/ghost")
        assert resp.status_code == 404
        assert "SPA" not in resp.text
        # A real API path still works.
        assert client.get("/api/locations").status_code == 200
