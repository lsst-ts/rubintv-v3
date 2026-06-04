"""Phase 7: SPA serving + catch-all, status endpoint, correlation header."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import boto3
from fastapi.testclient import TestClient
from moto import mock_aws

from rubintv.app import create_app
from rubintv.config.settings import Settings
from tests.conftest import CONFIG_PATH, TEST_BUCKET


@contextmanager
def run_app(**overrides: object) -> Iterator[TestClient]:
    settings = Settings(
        site="test",
        models_path=CONFIG_PATH,
        poll_interval_seconds=0.05,
        **overrides,  # type: ignore[arg-type]
    )
    with mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=TEST_BUCKET)
        with TestClient(create_app(settings)) as client:
            yield client


def test_status_endpoint_reports_loading() -> None:
    with run_app() as client:
        body = client.get("/api/health/status").json()
        assert "ready" in body
        assert "historical_loading" in body
        # Per-camera readiness is present and well-formed for each camera.
        assert isinstance(body["cameras"], list)
        for cam in body["cameras"]:
            assert {"location", "camera", "recent_ready", "full_complete"} <= set(cam)


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
        # Root serves index.html.
        assert "id=root" in client.get("/").text
        # A deep link (no matching API route) also serves index.html, so a
        # hard reload of an SPA route works.
        assert "id=root" in client.get("/summit/lsstcam/witness_detector").text
        # Hashed asset is served.
        assert client.get("/assets/app.js").status_code == 200


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
