"""Sub-app mounting and failure isolation."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import boto3
import pytest
from lsst.ts.rubintv.app import create_app
from lsst.ts.rubintv.config.settings import Settings
from moto import mock_aws

from tests.conftest import (
    CONFIG_PATH,
    TEST_BUCKET,
    TEST_PREFIX,
    PrefixedTestClient,
)


def make_settings(**overrides: object) -> Settings:
    # cache_dir=None: the setting defaults to the real /scratch PVC mount,
    # which tests must never read or write (hermeticity).
    return Settings(
        models_path=CONFIG_PATH,
        poll_interval_seconds=0.05,
        **{"site": "test", "cache_dir": None, **overrides},  # type: ignore[arg-type]
    )


@contextmanager
def run_app(settings: Settings) -> Iterator[PrefixedTestClient]:
    """Run the app under a live moto mock for the client's lifetime."""
    with mock_aws():
        boto3.client("s3", region_name="us-east-1").create_bucket(Bucket=TEST_BUCKET)
        with PrefixedTestClient(create_app(settings)) as client:
            yield client


def test_no_subapps_by_default() -> None:
    with run_app(make_settings()) as client:
        assert client.get("/api/subapps").json() == {"mounted": []}


def test_config_reports_the_deployment_site() -> None:
    # The SPA reads /api/config at startup to label the header (processing
    # banner, non-prod flag) by where the pod runs, not by the viewed location.
    with run_app(make_settings(site="test")) as client:
        assert client.get("/api/config").json() == {"site": "test"}
    with run_app(make_settings(site="usdf-k8s")) as client:
        assert client.get("/api/config").json() == {"site": "usdf-k8s"}


def write_ddv_build(ddv_dir: Path) -> None:
    """A finished Vite build: index.html plus a hashed bundle under assets/."""
    ddv_dir.mkdir(parents=True, exist_ok=True)
    (ddv_dir / "index.html").write_text("<!doctype html><title>DDV</title>")
    (ddv_dir / "assets").mkdir()
    (ddv_dir / "assets" / "index-Ab12Cd34.js").write_text("// bundle")


def test_ddv_mounted_when_assets_present(tmp_path: Path) -> None:
    write_ddv_build(tmp_path)
    settings = make_settings(ddv_path=tmp_path)
    with run_app(settings) as client:
        # The reported mount path is the full browser-facing (prefixed) URL.
        assert f"{TEST_PREFIX}/ddv" in client.get("/api/subapps").json()["mounted"]
        resp = client.get("/ddv/")
        assert resp.status_code == 200
        assert "DDV" in resp.text


def test_ddv_bare_path_redirects_with_spa_mounted(tmp_path: Path) -> None:
    # Production shape: DDV mounted AND the SPA catch-all installed. The
    # catch-all matches the slash-less /ddv (Starlette mounts only match
    # {path}/...), so without the explicit redirect the advertised sub-app
    # URL answered 404 on the deployed pod.
    ddv = tmp_path / "ddv"
    write_ddv_build(ddv)
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html><div id=root></div>")

    with run_app(make_settings(ddv_path=ddv, spa_dist=dist)) as client:
        resp = client.get("/ddv", follow_redirects=False)
        assert resp.status_code == 307
        assert resp.headers["location"] == f"{TEST_PREFIX}/ddv/"
        assert "DDV" in client.get("/ddv/").text


def test_ddv_skipped_when_dir_missing(tmp_path: Path) -> None:
    settings = make_settings(ddv_path=tmp_path / "does-not-exist")
    with run_app(settings) as client:
        assert client.get("/api/subapps").json()["mounted"] == []
        # Main app still serves.
        assert client.get("/api/health/live").status_code == 200


def test_ddv_skipped_when_build_incomplete(tmp_path: Path) -> None:
    # An index.html with no bundle under assets/ (a stale or partial build)
    # would serve a page that spins forever; it must be skipped instead.
    (tmp_path / "index.html").write_text("<!doctype html><title>DDV</title>")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "index-Ab12Cd34.css").write_text("/* styles */")
    with run_app(make_settings(ddv_path=tmp_path)) as client:
        assert client.get("/api/subapps").json()["mounted"] == []
        assert client.get("/api/health/live").status_code == 200


def test_exp_checker_import_failure_is_isolated() -> None:
    # Enabled but the module isn't importable -> mount skipped, app survives.
    settings = make_settings(exp_checker_enabled=True)
    with run_app(settings) as client:
        mounted = client.get("/api/subapps").json()["mounted"]
        assert f"{TEST_PREFIX}/exp_checker" not in mounted
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

    settings = make_settings(exp_checker_enabled=True, exp_checker_module="exp_checker")
    with run_app(settings) as client:
        assert (
            f"{TEST_PREFIX}/exp_checker" in client.get("/api/subapps").json()["mounted"]
        )
        assert client.get("/exp_checker/ping").json() == {"pong": "ok"}
