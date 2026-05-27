"""Sub-app mounting and failure isolation."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from rubintv.app import create_app
from rubintv.config.settings import Settings
from tests.conftest import CONFIG_PATH, LOCAL_BUCKET


def make_settings(**overrides: object) -> Settings:
    return Settings(
        site="local",
        models_path=CONFIG_PATH,
        poll_interval_seconds=0.05,
        **overrides,  # type: ignore[arg-type]
    )


@contextmanager
def run_app(settings: Settings) -> Iterator[TestClient]:
    """Run the app under a live moto mock for the client's lifetime."""
    with mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=LOCAL_BUCKET)
        with TestClient(create_app(settings)) as client:
            yield client


def test_no_subapps_by_default() -> None:
    with run_app(make_settings()) as client:
        assert client.get("/api/subapps").json() == {"mounted": []}


def test_ddv_mounted_when_assets_present(tmp_path: Path) -> None:
    (tmp_path / "index.html").write_text("<!doctype html><title>DDV</title>")
    settings = make_settings(ddv_path=tmp_path)
    with run_app(settings) as client:
        assert "/ddv" in client.get("/api/subapps").json()["mounted"]
        resp = client.get("/ddv/")
        assert resp.status_code == 200
        assert "DDV" in resp.text


def test_ddv_skipped_when_dir_missing(tmp_path: Path) -> None:
    settings = make_settings(ddv_path=tmp_path / "does-not-exist")
    with run_app(settings) as client:
        assert client.get("/api/subapps").json()["mounted"] == []
        # Main app still serves.
        assert client.get("/api/health/live").status_code == 200


def test_exp_checker_import_failure_is_isolated() -> None:
    # Enabled but the module isn't importable -> mount skipped, app survives.
    settings = make_settings(exp_checker_enabled=True)
    with run_app(settings) as client:
        assert "/exp_checker" not in client.get("/api/subapps").json()["mounted"]
        assert client.get("/api/health/live").status_code == 200


def test_exp_checker_mounted_when_importable(monkeypatch: pytest.MonkeyPatch) -> None:
    # Provide a fake exp_checker module exposing create_app().
    import sys
    import types

    from fastapi import FastAPI

    module = types.ModuleType("exp_checker")

    def create_app() -> FastAPI:
        sub = FastAPI()

        @sub.get("/ping")
        def ping() -> dict[str, str]:
            return {"pong": "ok"}

        return sub

    module.create_app = create_app  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "exp_checker", module)

    settings = make_settings(exp_checker_enabled=True)
    with run_app(settings) as client:
        assert "/exp_checker" in client.get("/api/subapps").json()["mounted"]
        assert client.get("/exp_checker/ping").json() == {"pong": "ok"}
