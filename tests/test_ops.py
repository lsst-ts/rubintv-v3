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

"""Phase 7: SPA serving + catch-all, status endpoint, correlation header."""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import boto3
import pytest
from fastapi.testclient import TestClient
from lsst.ts.rubintv import middleware
from lsst.ts.rubintv.app import _resolve_models_path, create_app
from lsst.ts.rubintv.config.settings import Settings
from lsst.ts.rubintv.data.cache import CACHE_VERSION, DiskCache
from lsst.ts.rubintv.data.dayobs import get_current_day_obs
from lsst.ts.rubintv.data.index import DateIndex
from lsst.ts.rubintv.middleware import (
    CorrelationMiddleware,
    ResponseAborted,
    response_bytes,
)
from lsst.ts.rubintv.spa import render_index
from moto import mock_aws
from starlette.applications import Starlette
from starlette.datastructures import Headers
from starlette.middleware import Middleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.requests import Request
from starlette.responses import StreamingResponse
from starlette.routing import Route
from starlette.types import Message

from tests.conftest import CONFIG_PATH, TEST_BUCKET, PrefixedTestClient


@contextmanager
def run_app(
    objects: Mapping[str, bytes] | None = None, **overrides: object
) -> Iterator[PrefixedTestClient]:
    # cache_dir=None: the setting defaults to the real /scratch PVC mount,
    # which tests must never read or write (hermeticity). ``objects`` seeds
    # the bucket before the app starts, so the first scans see them.
    settings = Settings(
        models_path=CONFIG_PATH,
        poll_interval_seconds=0.05,
        **{"site": "test", "cache_dir": None, **overrides},  # type: ignore[arg-type]
    )
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=TEST_BUCKET)
        for key, body in (objects or {}).items():
            s3.put_object(Bucket=TEST_BUCKET, Key=key, Body=body)
        with PrefixedTestClient(create_app(settings)) as client:
            yield client


def wait_until(predicate: Callable[[], bool], timeout: float = 30.0) -> bool:
    """Poll ``predicate`` until it holds. The budget is generous on purpose:
    it bounds a hung test, it is not a timing assertion."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


def historical_idle(client: TestClient) -> bool:
    """Whether the first full sweep (and its metadata preload) is done."""
    body = client.get("/api/health/status").json()
    return body["historical_loading"] is False


def test_root_redirects_into_the_prefix() -> None:
    # The deployment chart's readiness probe GETs bare "/", which sits
    # outside the path prefix; it must answer 2xx/3xx, not 404. The absolute
    # URL bypasses PrefixedTestClient's prefixing.
    with run_app() as client:
        resp = client.get("http://testserver/", follow_redirects=False)
        assert resp.status_code == 307
        assert resp.headers["location"] == "/rubintv/"


def test_status_endpoint_reports_loading() -> None:
    with run_app() as client:
        body = client.get("/api/health/status").json()
        assert "ready" in body
        assert "historical_loading" in body
        # S3 connectivity is reported and healthy (fast) on a
        # freshly-polled app.
        assert body["s3_healthy"] is True
        assert body["s3_slow"] is False
        # Last-cycle latency is reported as a number (0.0 if no cycle has run).
        assert isinstance(body["s3_last_cycle_seconds"], (int, float))
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
    # A populated cache directory: the layout is {cache_dir}/{version}/{loc}/
    # {cam}/{date}.json, and the store warm-starts from it, flipping
    # warm_start.
    slice_dir = tmp_path / CACHE_VERSION / "test" / "auxtel"
    slice_dir.mkdir(parents=True)
    (slice_dir / "2025-01-01.json").write_text(
        f'{{"version": "{CACHE_VERSION}", "channels": {{}}, '
        '"extensions": {}, "per_day": {}, "night_report_keys": []}'
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


def test_models_path_defaults_to_the_packaged_copy(tmp_path: Path) -> None:
    # An installed app finds its models YAML inside the package, from any
    # working directory; RUBINTV_MODELS_PATH still wins when a site sets it.
    assert _resolve_models_path(None).read_text() == CONFIG_PATH.read_text()
    mounted = tmp_path / "site.yaml"
    assert _resolve_models_path(mounted) == mounted


def test_scans_keep_the_cache_in_step_with_the_bucket(tmp_path: Path) -> None:
    # Frames found by the current-day loop are persisted as they land, not
    # only by the full snapshot (every 12h and at shutdown), so a restart
    # mid-night warm-starts with tonight's data. A date whose objects are
    # all deleted loses its slice the same way, so it can't seed the next
    # warm start.
    today = get_current_day_obs()
    key = f"lsstcam/{today}/witness_detector/000001/a.png"
    cached = tmp_path / CACHE_VERSION / "test" / "lsstcam" / f"{today}.json"
    with run_app(cache_dir=tmp_path, recent_window_days=0) as client:
        s3 = boto3.client("s3", region_name="us-east-1")
        assert wait_until(lambda: historical_idle(client))
        assert not cached.exists()
        s3.put_object(Bucket=TEST_BUCKET, Key=key, Body=b"x")
        assert wait_until(cached.exists)
        assert json.loads(cached.read_text())["channels"] == {"witness_detector": [1]}
        s3.delete_object(Bucket=TEST_BUCKET, Key=key)
        assert wait_until(lambda: not cached.exists())


@pytest.mark.parametrize("dry_run", [False, True])
def test_full_sweep_evicts_cached_dates_the_bucket_lost(
    tmp_path: Path, dry_run: bool
) -> None:
    # A slice cached for a date whose objects were deleted while the app was
    # down: the warm start seeds it, the full sweep finds nothing there, and
    # both the store and the cache file drop it, or the next warm start would
    # offer it again. Dry-run reconciliation only reports what it would drop.
    DiskCache(tmp_path).write(
        "test", "lsstcam", "2025-01-01", DateIndex(channels={"witness_detector": {1}})
    )
    stale = tmp_path / CACHE_VERSION / "test" / "lsstcam" / "2025-01-01.json"
    with run_app(
        cache_dir=tmp_path, recent_window_days=0, reconcile_dry_run=dry_run
    ) as client:
        assert wait_until(lambda: historical_idle(client))
        calendar = client.get("/api/locations/test/cameras/lsstcam/calendar").json()
    if dry_run:
        assert calendar["dates"] == ["2025-01-01"]
        assert stale.exists()
    else:
        assert calendar["dates"] == []
        assert not stale.exists()


@pytest.mark.parametrize("preload_days", [3, 0])
def test_full_sweep_preloads_recent_metadata(preload_days: int) -> None:
    # After a camera's scan its most recent dates' metadata is fetched into
    # memory, so the first table view is a warm hit. Proven by taking the
    # file away afterwards: only a copy fetched during the scan can answer.
    # A preload window of 0 turns it off.
    date = "2026-04-10"
    rows = {"1": {"Exposure time": 30.0}}
    objects = {
        f"lsstcam/{date}/witness_detector/000001/a.png": b"x",
        f"lsstcam/{date}/metadata.json": json.dumps(rows).encode(),
    }
    with run_app(
        objects, recent_window_days=0, metadata_preload_days=preload_days
    ) as client:
        assert wait_until(lambda: historical_idle(client))
        boto3.client("s3", region_name="us-east-1").delete_object(
            Bucket=TEST_BUCKET, Key=f"lsstcam/{date}/metadata.json"
        )
        got = client.get(f"/api/locations/test/cameras/lsstcam/metadata/{date}")
    assert got.json() == (rows if preload_days else {})


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


def test_spa_serves_public_assets_from_dist_root(tmp_path: Path) -> None:
    # Vite copies web/public/* verbatim into dist/ (logos, rubin-mark.png).
    # These must come back as the actual files — the catch-all previously
    # answered them with index.html, which broke every logo image.
    dist = tmp_path / "dist"
    (dist / "logos").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><div id=root></div>")
    (dist / "logos" / "Summit.jpg").write_bytes(b"\xff\xd8jpegbytes")

    with run_app(spa_dist=dist) as client:
        resp = client.get("/logos/Summit.jpg")
        assert resp.status_code == 200
        assert resp.content == b"\xff\xd8jpegbytes"
        # A path that names no real file still falls back to the SPA index.
        assert "id=root" in client.get("/logos/missing.jpg").text


# The shape of Vite's index.html with the relative base the build uses: every
# URL is page-relative ("./").
VITE_INDEX = (
    "<!doctype html><html><head>"
    '<link rel="icon" href="./favicon.ico" />'
    '<script type="module" crossorigin src="./assets/index-Ab12.js"></script>'
    '<link rel="stylesheet" crossorigin href="./assets/index-Cd34.css">'
    "</head><body><div id=root></div></body></html>"
)


def deployment_block(page: str) -> dict[str, str]:
    match = re.search(
        r'<script id="rubintv-deployment" type="application/json">(.*?)</script>',
        page,
    )
    assert match, "no deployment block in the page"
    return json.loads(match.group(1))  # type: ignore[no-any-return]


def test_spa_under_a_dev_prefix_gets_its_prefix_and_env(tmp_path: Path) -> None:
    # One image serves every deployment, so the build's "./" URLs are pointed
    # at the deployment's prefix as index.html is served, and the SPA is told
    # its prefix (router basename, fetch/WS roots) and declared env. Summit
    # dev is the case: /rubintv-dev on the same host as prod.
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(VITE_INDEX)
    (dist / "assets" / "index-Ab12.js").write_text("console.log(1)")

    with run_app(spa_dist=dist, path_prefix="/rubintv-dev", instance_env="dev") as c:
        # Absolute URLs: the client's own prefixing assumes /rubintv.
        root = "http://testserver/rubintv-dev"
        for path in (root, f"{root}/", f"{root}/summit/lsstcam/witness_detector"):
            page = c.get(path).text
            assert 'src="/rubintv-dev/assets/index-Ab12.js"' in page, path
            assert 'href="/rubintv-dev/assets/index-Cd34.css"' in page
            assert 'href="/rubintv-dev/favicon.ico"' in page
            assert "./" not in page
            assert deployment_block(page) == {"prefix": "/rubintv-dev", "env": "dev"}
        # The rewritten asset URL is the one actually served.
        assert c.get(f"{root}/assets/index-Ab12.js").status_code == 200
        assert c.get("http://testserver/rubintv/summit/lsstcam").status_code == 404


def test_spa_defaults_to_prod_under_the_default_prefix(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text(VITE_INDEX)

    with run_app(spa_dist=dist) as client:
        page = client.get("/summit/lsstcam").text
        assert 'src="/rubintv/assets/index-Ab12.js"' in page
        assert deployment_block(page) == {"prefix": "/rubintv", "env": "prod"}


def test_render_index_at_the_root_and_escapes_the_prefix() -> None:
    # An empty prefix serves at the root: "./" becomes "/".
    page = render_index(VITE_INDEX, "", "prod")
    assert 'src="/assets/index-Ab12.js"' in page
    assert deployment_block(page) == {"prefix": "", "env": "prod"}
    # The prefix is operator-set, but still never breaks out of the attribute
    # or the data block.
    page = render_index(VITE_INDEX, '/a"</script>', "prod")
    assert 'src="/a&quot;&lt;/script&gt;/assets/index-Ab12.js"' in page
    assert deployment_block(page)["prefix"] == '/a"</script>'


def test_spa_catch_all_does_not_shadow_api(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html>SPA")

    with run_app(spa_dist=dist) as client:
        # An unknown API path is a real 404, not the SPA index.
        resp = client.get("/api/locations/ghost")
        assert resp.status_code == 404
        assert "SPA" not in resp.text
        # So is an API path no router claims, which only the catch-all sees.
        resp = client.get("/api/no-such-route")
        assert resp.status_code == 404
        assert "SPA" not in resp.text
        # A real API path still works.
        assert client.get("/api/locations").status_code == 200


def test_empty_prefix_serves_everything_from_the_root(tmp_path: Path) -> None:
    # With no prefix the SPA owns "/" itself: no redirect into a prefix, and
    # the API sits at /api.
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<!doctype html>SPA")

    with run_app(spa_dist=dist, path_prefix="") as client:
        root = client.get("http://testserver/", follow_redirects=False)
        assert root.status_code == 200
        assert "SPA" in root.text
        live = client.get("http://testserver/api/health/live")
        assert live.status_code == 200


def test_response_bytes_reads_content_length_or_none() -> None:
    assert response_bytes(Headers({"content-length": "3"})) == 3
    # A chunked stream has no Content-Length: reported as unknown, not 0.
    assert response_bytes(Headers({"transfer-encoding": "chunked"})) is None


def _stream_app(fail: Exception | None, before_headers: bool = False) -> Starlette:
    """A one-route app streaming b"ab" and then raising ``fail`` (if any),
    behind the real app's middleware in its order: gzip outermost, then
    correlation (Starlette's error middleware sits outside both)."""

    async def endpoint(request: Request) -> StreamingResponse:
        if before_headers and fail is not None:
            raise fail

        def body() -> Iterator[bytes]:
            yield b"ab"
            if fail is not None:
                raise fail

        return StreamingResponse(body(), media_type="video/mp4")

    return Starlette(
        routes=[Route("/", endpoint)],
        middleware=[
            Middleware(GZipMiddleware, minimum_size=1024),
            Middleware(CorrelationMiddleware),
        ],
    )


async def _drive(app: Starlette) -> list[Message]:
    """Run one GET through ``app`` at the ASGI level; return what it sent.

    A test client can't tell a finished response from one left unfinished,
    which is the whole difference here, so the messages are read directly.
    """
    sent: list[Message] = []
    scope: dict[str, Any] = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/",
        "raw_path": b"/",
        "root_path": "",
        "query_string": b"",
        "headers": [(b"accept-encoding", b"identity")],
        "client": ("test", 1),
        "server": ("test", 80),
    }

    async def receive() -> Message:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: Message) -> None:
        sent.append(message)

    await app(scope, receive, send)
    return sent


def _finished(sent: list[Message]) -> bool:
    return any(
        m["type"] == "http.response.body" and not m.get("more_body", False)
        for m in sent
    )


async def test_a_stream_completes_with_its_request_id() -> None:
    sent = await _drive(_stream_app(fail=None))
    assert sent[0]["status"] == 200
    assert Headers(raw=sent[0]["headers"]).get("x-request-id")
    assert _finished(sent)


async def test_an_aborted_stream_is_left_unfinished() -> None:
    # Mid-body, ResponseAborted must leave the response unfinished (no final
    # body message), so the server closes the connection and the client sees
    # a failed transfer. The old BaseHTTPMiddleware sent that final message
    # itself, passing the short body off as whole. Nothing escapes either, so
    # the server logs no traceback.
    sent = await _drive(_stream_app(fail=ResponseAborted("k")))
    assert sent[0]["status"] == 200
    assert [m.get("body") for m in sent[1:]] == [b"ab"]
    assert not _finished(sent)


async def test_an_abort_before_the_headers_is_an_ordinary_error() -> None:
    # Nothing sent yet: it's re-raised and becomes a 500 like any error.
    app = _stream_app(fail=ResponseAborted("k"), before_headers=True)
    sent: list[Message] = []
    with pytest.raises(ResponseAborted):
        sent = await _drive(app)
    assert not sent or sent[0]["status"] == 500


def test_requests_still_carry_the_correlation_id_when_timed() -> None:
    with run_app(log_level="DEBUG") as client:
        resp = client.get("/api/health/live", headers={"X-Request-ID": "t-1"})
        assert resp.status_code == 200
        assert resp.headers["X-Request-ID"] == "t-1"


def test_requests_log_at_info_and_routine_traffic_at_debug(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # http.request is the pod's access log. The kubelet's probes and the S3
    # pill's 5 s status poll were nearly every line of it, so they drop to
    # debug; anything that fails stays at info, probe or not.
    logged: list[tuple[str, str, int]] = []

    class Recorder:
        def __getattr__(self, level: str) -> object:
            return lambda event, **f: logged.append((level, f["path"], f["status"]))

    monkeypatch.setattr(middleware, "log", Recorder())
    probe = {"User-Agent": "kube-probe/1.30"}
    with run_app() as client:
        client.get("/api/health/live")
        client.get("/api/health/status")
        client.get("http://testserver/", headers=probe, follow_redirects=False)
        client.get("/api/health/live", headers=probe)
        client.get("/api/no-such-route", headers=probe)
    assert logged == [
        ("info", "/rubintv/api/health/live", 200),
        ("debug", "/rubintv/api/health/status", 200),
        ("debug", "/", 307),
        ("debug", "/rubintv/api/health/live", 200),
        ("info", "/rubintv/api/no-such-route", 404),
    ]
