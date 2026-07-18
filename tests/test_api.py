"""REST API endpoints over a moto-seeded store."""

from __future__ import annotations

import json
import time
from collections.abc import Iterator

import boto3
import pytest
from fastapi.testclient import TestClient
from lsst.ts.rubintv.app import create_app
from lsst.ts.rubintv.config.settings import Settings
from moto import mock_aws

from tests.conftest import TEST_BUCKET, PrefixedTestClient

DATE = "2026-04-10"


@pytest.fixture
def seeded_client(settings: Settings) -> Iterator[TestClient]:
    """A client whose bucket is pre-seeded, then polled into the store."""
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=TEST_BUCKET)
        for key in [
            f"lsstcam/{DATE}/witness_detector/000001/a.png",
            f"lsstcam/{DATE}/witness_detector/000002/b.jpg",
            f"lsstcam/{DATE}/day_movie/final/m.mp4",
            f"lsstcam/{DATE}/night_report/summary_md.json",
            f"lsstcam/{DATE}/night_report/Coverage/elana_coverage.png",
        ]:
            s3.put_object(Bucket=TEST_BUCKET, Key=key, Body=b"x")
        s3.put_object(
            Bucket=TEST_BUCKET,
            Key=f"lsstcam/{DATE}/metadata.json",
            Body=json.dumps({"1": {"Exposure time": 30.0}}).encode(),
        )
        s3.put_object(
            Bucket=TEST_BUCKET,
            Key=f"lsstcam/{DATE}/night_report/summary_md.json",
            Body=json.dumps(
                [
                    {"type": "multiline", "key": "s", "title": "S", "content": "hi"},
                    {
                        "type": "keyvalues",
                        "title": "Conditions",
                        "content": {"seeing": "0.8"},
                    },
                    {
                        "type": "links",
                        "title": "Refs",
                        "content": [{"text": "Logbook", "url": "https://x/log"}],
                    },
                ]
            ).encode(),
        )
        app = create_app(settings)
        with PrefixedTestClient(app) as client:
            for _ in range(60):
                cal = client.get("/api/locations/test/cameras/lsstcam/calendar").json()
                if cal["dates"]:
                    break
                time.sleep(0.05)
            yield client


def test_list_locations(seeded_client: TestClient) -> None:
    resp = seeded_client.get("/api/locations")
    assert resp.status_code == 200
    assert {loc["name"] for loc in resp.json()} == {"test"}


def test_location_detail_groups(seeded_client: TestClient) -> None:
    resp = seeded_client.get("/api/locations/test")
    assert resp.status_code == 200
    labels = {g["label"] for g in resp.json()["camera_groups"]}
    assert labels == {"Main", "Auxiliary"}


def test_location_detail_includes_camera_latest_date(
    seeded_client: TestClient,
) -> None:
    cams = {
        c["name"]: c
        for g in seeded_client.get("/api/locations/test").json()["camera_groups"]
        for c in g["cameras"]
    }
    # lsstcam was seeded with data at DATE; an un-seeded camera has none.
    assert cams["lsstcam"]["latest_date"] == DATE
    assert cams["auxtel"]["latest_date"] is None


def test_unknown_location_404(seeded_client: TestClient) -> None:
    assert seeded_client.get("/api/locations/nope").status_code == 404


def test_unknown_camera_404(seeded_client: TestClient) -> None:
    resp = seeded_client.get("/api/locations/test/cameras/ghost")
    assert resp.status_code == 404


def test_camera_detail(seeded_client: TestClient) -> None:
    resp = seeded_client.get("/api/locations/test/cameras/lsstcam")
    body = resp.json()
    assert {c["name"] for c in body["channels"]} >= {"witness_detector", "day_movie"}


def test_detectors_config_lists_configured_streams(seeded_client: TestClient) -> None:
    resp = seeded_client.get("/api/detectors/config")
    assert resp.status_code == 200
    names = {d["name"] for d in resp.json()["detectors"]}
    # From the packaged models_data.yaml's redis_detectors.
    assert {"sfmSet0", "aosSet0"} <= names


def test_admin_menus_lists_configured_menus(seeded_client: TestClient) -> None:
    resp = seeded_client.get("/api/admin/menus")
    assert resp.status_code == 200
    titles = {m["title"] for m in resp.json()["menus"]}
    assert "AOS Pipeline" in titles
    aos = next(m for m in resp.json()["menus"] if m["title"] == "AOS Pipeline")
    assert {item["label"] for item in aos["items"]} >= {"DANISH", "TIE"}


def test_site_controls_readback(seeded_client: TestClient) -> None:
    state = seeded_client.app.state.app_state  # type: ignore[attr-defined]
    state.controls.set("*", "AOS_READBACK", "danish")
    resp = seeded_client.get("/api/admin/controls")
    assert resp.status_code == 200
    assert resp.json()["values"]["AOS_READBACK"] == "danish"


def test_admin_status_reports_version_and_flags(seeded_client: TestClient) -> None:
    resp = seeded_client.get("/api/admin/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["version"]
    # Build provenance for the Admin page. In the test tree git resolves live;
    # both are non-empty (real value or the "unknown" fallback), never blank.
    assert body["git_sha"]
    assert body["commit_date"]
    # Tests run in a live checkout, not a built image (RUBINTV_GIT_SHA unset),
    # so this is not a release build. The Admin header uses this to drop the
    # noisy setuptools-scm version locally.
    assert body["is_release"] is False
    # The seeded client has no Redis and no cache dir configured.
    assert body["redis_enabled"] is False
    assert body["cache_enabled"] is False
    assert body["witness_detector_key"]
    # No X-Auth-User header -> not an admin (the frontend hides admin
    # controls).
    assert body["is_admin"] is False


def test_is_release_tracks_baked_in_git_sha(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # is_release() keys off RUBINTV_GIT_SHA, which the Dockerfile bakes into
    # deployed images and a local checkout leaves unset. The lru_cache must be
    # cleared around each read since other tests resolve it live.
    from lsst.ts.rubintv import build_info

    build_info.is_release.cache_clear()
    monkeypatch.setenv("RUBINTV_GIT_SHA", "deadbeef")
    assert build_info.is_release() is True

    build_info.is_release.cache_clear()
    monkeypatch.delenv("RUBINTV_GIT_SHA", raising=False)
    assert build_info.is_release() is False
    build_info.is_release.cache_clear()


def test_admin_status_reports_is_admin_for_authed_user(
    seeded_client: TestClient,
) -> None:
    # The test site's admin_for is "*", so any authenticated user is a site
    # admin; is_admin should flip true once the reverse-proxy header is
    # present.
    resp = seeded_client.get("/api/admin/status", headers={"X-Auth-User": "tester"})
    assert resp.status_code == 200
    assert resp.json()["is_admin"] is True


def test_admin_write_requires_auth(seeded_client: TestClient) -> None:
    # No X-Auth-User header -> 403, regardless of Redis state.
    resp = seeded_client.post(
        "/api/admin/controls/set", json={"key": "K", "value": "V"}
    )
    assert resp.status_code == 403


def test_admin_control_set_503_without_redis(seeded_client: TestClient) -> None:
    # Authed (test site admin_for is "*"), permitted key, but no Redis -> 503.
    resp = seeded_client.post(
        "/api/admin/controls/set",
        json={"key": "RUBINTV_CONTROL_AOS_PIPELINE", "value": "V"},
        headers={"X-Auth-User": "tester"},
    )
    assert resp.status_code == 503


def test_admin_control_set_rejects_unknown_key(seeded_client: TestClient) -> None:
    # An arbitrary (non-config) control key is rejected 400 before any Redis
    # write, so the endpoint can't set keys outside the configured namespace.
    resp = seeded_client.post(
        "/api/admin/controls/set",
        json={"key": "RUBINTV_CONTROL_ARBITRARY_INJECTED", "value": "x"},
        headers={"X-Auth-User": "tester"},
    )
    assert resp.status_code == 400


def test_admin_reset_head_node_503_without_redis(seeded_client: TestClient) -> None:
    resp = seeded_client.post(
        "/api/admin/reset-head-node", headers={"X-Auth-User": "tester"}
    )
    assert resp.status_code == 503


def test_admin_flush_redis_503_without_redis(seeded_client: TestClient) -> None:
    resp = seeded_client.post(
        "/api/admin/flush-redis", headers={"X-Auth-User": "tester"}
    )
    assert resp.status_code == 503


def test_restart_workers_unknown_set_404(seeded_client: TestClient) -> None:
    resp = seeded_client.post(
        "/api/detectors/nope/restart", headers={"X-Auth-User": "tester"}
    )
    assert resp.status_code == 404


def test_restart_workers_requires_auth(seeded_client: TestClient) -> None:
    resp = seeded_client.post("/api/detectors/sfmSet0/restart")
    assert resp.status_code == 403


def test_restart_workers_503_without_redis(seeded_client: TestClient) -> None:
    # Known set (from config), authed, but no Redis -> 503 from the write.
    resp = seeded_client.post(
        "/api/detectors/sfmSet0/restart", headers={"X-Auth-User": "tester"}
    )
    assert resp.status_code == 503


def test_admin_flush_historical_succeeds(seeded_client: TestClient) -> None:
    # Precondition: the seeded date is in the calendar.
    cal = seeded_client.get("/api/locations/test/cameras/lsstcam/calendar").json()
    assert DATE in cal["dates"]

    resp = seeded_client.post(
        "/api/admin/flush-historical", headers={"X-Auth-User": "tester"}
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    # The flush also resets the poller's diff state, so the triggered rescan
    # re-emits the unchanged keys and the store rebuilds from S3. Without the
    # reset the rescan diffs against retained listings and the calendar would
    # stay empty until restart (the bug this guards against).
    for _ in range(100):
        cal = seeded_client.get("/api/locations/test/cameras/lsstcam/calendar").json()
        if DATE in cal["dates"]:
            break
        time.sleep(0.05)
    assert DATE in cal["dates"]


def test_calendar(seeded_client: TestClient) -> None:
    resp = seeded_client.get("/api/locations/test/cameras/lsstcam/calendar")
    body = resp.json()
    assert body["dates"] == [DATE]
    # Per-date exposure count = distinct seq_nums across channels. The seeded
    # witness_detector channel has seqs {1, 2}, so the day counts 2 and its
    # highest integer seq is 2.
    assert body["counts"][DATE] == 2
    assert body["max_seq"][DATE] == 2
    # The seeded witness_detector channel's most recent date, so a card with no
    # current frame can link straight to its last known plot.
    assert body["channel_latest"]["witness_detector"] == DATE


def test_date_payload(seeded_client: TestClient) -> None:
    resp = seeded_client.get(f"/api/locations/test/cameras/lsstcam/dates/{DATE}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["channels"]["witness_detector"] == [1, 2]
    assert body["extensions"]["witness_detector"]["default"] == "png"
    assert body["extensions"]["witness_detector"]["exceptions"] == {"2": "jpg"}
    assert body["per_day"]["day_movie"].endswith("m.mp4")
    assert body["has_night_report"] is True
    # Metadata is no longer bundled here — it's fetched separately so the grid
    # never waits on the (slow, live-from-S3) metadata download.
    assert "metadata" not in body


def test_date_payload_backfills_unindexed_date(seeded_client: TestClient) -> None:
    state = seeded_client.app.state.app_state  # type: ignore[attr-defined]
    # Wait out the startup sweep so the key seeded below can only reach the
    # store via the on-demand backfill, not a racing background scan.
    for _ in range(60):
        if state.camera_status()[("test", "lsstcam")].full_complete:
            break
        time.sleep(0.05)
    other = "2026-02-02"
    boto3.client("s3", region_name="us-east-1").put_object(
        Bucket=TEST_BUCKET,
        Key=f"lsstcam/{other}/witness_detector/000001/a.png",
        Body=b"x",
    )
    resp = seeded_client.get(f"/api/locations/test/cameras/lsstcam/dates/{other}")
    assert resp.status_code == 200
    assert resp.json()["channels"]["witness_detector"] == [1]
    # The backfilled date is now indexed: it appears in the calendar and a
    # second request is served straight from the store.
    cal = seeded_client.get("/api/locations/test/cameras/lsstcam/calendar")
    assert other in cal.json()["dates"]


def test_date_payload_empty_for_truly_absent_date(seeded_client: TestClient) -> None:
    # A date with no objects still returns the empty-but-valid payload (the
    # backfill scan finds nothing), so the table can render metadata rows.
    resp = seeded_client.get("/api/locations/test/cameras/lsstcam/dates/2026-03-03")
    assert resp.status_code == 200
    body = resp.json()
    assert body["channels"] == {}
    assert body["has_night_report"] is False


def test_metadata_endpoint(seeded_client: TestClient) -> None:
    resp = seeded_client.get(f"/api/locations/test/cameras/lsstcam/metadata/{DATE}")
    assert resp.status_code == 200
    assert resp.json()["1"]["Exposure time"] == 30.0


def test_bad_date_422(seeded_client: TestClient) -> None:
    resp = seeded_client.get("/api/locations/test/cameras/lsstcam/dates/2026-13")
    assert resp.status_code == 422


def test_night_report(seeded_client: TestClient) -> None:
    resp = seeded_client.get(f"/api/locations/test/cameras/lsstcam/night-report/{DATE}")
    body = resp.json()
    assert body["exists"] is True
    by_type = {item["type"]: item for item in body["text"]}
    assert by_type["multiline"]["content"] == "hi"
    assert by_type["keyvalues"]["content"] == {"seeing": "0.8"}
    assert by_type["links"]["content"] == [{"text": "Logbook", "url": "https://x/log"}]
    plot = next(p for p in body["plots"] if p["filename"] == "elana_coverage.png")
    assert plot["group"] == "Coverage"


def test_night_report_backfills_unindexed_date(seeded_client: TestClient) -> None:
    state = seeded_client.app.state.app_state  # type: ignore[attr-defined]
    # Wait out the startup sweep so the report seeded below can only reach the
    # store via the on-demand backfill, not a racing background scan.
    for _ in range(60):
        if state.camera_status()[("test", "lsstcam")].full_complete:
            break
        time.sleep(0.05)
    # A deep-linked historical date, with an old-format (object) report, that
    # the sweep never indexed. The night-report handler must backfill it.
    other = "2025-08-23"
    boto3.client("s3", region_name="us-east-1").put_object(
        Bucket=TEST_BUCKET,
        Key=f"lsstcam/{other}/night_report/auxtel_night_report_{other}_md.json",
        Body=json.dumps({"text_010": "started at seqNum 94"}).encode(),
    )
    resp = seeded_client.get(
        f"/api/locations/test/cameras/lsstcam/night-report/{other}"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["exists"] is True
    # Old object format converted to a multiline item keyed by the map key.
    assert body["text"][0]["type"] == "multiline"
    assert body["text"][0]["title"] == "text_010"
    assert body["text"][0]["content"] == "started at seqNum 94"


def test_night_report_absent_after_backfill(seeded_client: TestClient) -> None:
    # A date with no report stays exists=False after the (empty) backfill scan.
    resp = seeded_client.get(
        "/api/locations/test/cameras/lsstcam/night-report/2025-09-09"
    )
    assert resp.status_code == 200
    assert resp.json()["exists"] is False


def test_night_report_plot_streams_object(seeded_client: TestClient) -> None:
    # The plot key is fully known, so the dedicated route GETs it directly
    # (no prefix listing) and streams it back.
    resp = seeded_client.get(
        f"/api/locations/test/cameras/lsstcam/night-report/{DATE}"
        "/plot/Coverage/elana_coverage.png"
    )
    assert resp.status_code == 200
    assert resp.content == b"x"
    assert "Cache-Control" in resp.headers
    assert (
        resp.headers["Content-Disposition"] == 'inline; filename="elana_coverage.png"'
    )


def test_night_report_plot_404_when_missing(seeded_client: TestClient) -> None:
    resp = seeded_client.get(
        f"/api/locations/test/cameras/lsstcam/night-report/{DATE}"
        "/plot/Coverage/nope.png"
    )
    assert resp.status_code == 404


def test_event_by_key(seeded_client: TestClient) -> None:
    key = f"lsstcam/{DATE}/witness_detector/000001/a.png"
    resp = seeded_client.get(
        "/api/locations/test/cameras/lsstcam/events", params={"key": key}
    )
    assert resp.status_code == 200
    assert resp.json()["seq_num"] == 1


def test_admin_requires_user(seeded_client: TestClient) -> None:
    # No X-Auth-User header -> forbidden.
    resp = seeded_client.post(
        "/api/locations/test/admin/controls",
        json={"key": "AOS_PIPELINE", "value": "default"},
    )
    assert resp.status_code == 403


def test_admin_set_and_get(seeded_client: TestClient) -> None:
    resp = seeded_client.post(
        "/api/locations/test/admin/controls",
        json={"key": "AOS_PIPELINE", "value": "default"},
        headers={"X-Auth-User": "testadmin"},
    )
    assert resp.status_code == 200
    got = seeded_client.get("/api/locations/test/admin/controls").json()
    assert got["values"]["AOS_PIPELINE"] == "default"


def test_proxy_streams_object(seeded_client: TestClient) -> None:
    # The seeded object (a.png) does NOT follow the filename convention, so
    # the proxy's direct-key GET misses and it falls back to listing the seq
    # prefix. This exercises the fallback path and confirms it still serves
    # correctly.
    resp = seeded_client.get(
        f"/api/locations/test/cameras/lsstcam/channels/witness_detector/{DATE}/000001/image.png"
    )
    assert resp.status_code == 200
    assert resp.content == b"x"
    assert "Cache-Control" in resp.headers
    # The download name is the canonical convention name regardless of the real
    # key, so saved files identify camera/channel/date/seq.
    assert (
        resp.headers["Content-Disposition"]
        == f'inline; filename="lsstcam_witness_detector_{DATE}_000001.png"'
    )
    # The seeded object has no stored ContentType (moto defaults it to a
    # generic octet-stream), which would make a browser download rather than
    # render it. The proxy guesses image/png from the .png name so it opens
    # inline.
    assert resp.headers["Content-Type"] == "image/png"


def test_proxy_fast_path_skips_listing(
    seeded_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A convention-named object is served by a direct GET without any LIST.
    # We seed the convention key into the already-mocked bucket, then make
    # _resolve_key explode so any fallback to listing fails the test.
    import lsst.ts.rubintv.api.proxy as proxy

    s3 = boto3.client("s3", region_name="us-east-1")
    conv_key = (
        f"lsstcam/{DATE}/witness_detector/000003/"
        f"lsstcam_witness_detector_{DATE}_000003.png"
    )
    s3.put_object(Bucket=TEST_BUCKET, Key=conv_key, Body=b"direct")

    def _no_list(*_args: object, **_kwargs: object) -> str:
        raise AssertionError("fast path must not list the prefix")

    monkeypatch.setattr(proxy, "_resolve_key", _no_list)

    resp = seeded_client.get(
        f"/api/locations/test/cameras/lsstcam/channels/witness_detector/{DATE}/000003/image.png"
    )
    assert resp.status_code == 200
    assert resp.content == b"direct"


def test_proxy_404_when_seq_missing(seeded_client: TestClient) -> None:
    resp = seeded_client.get(
        f"/api/locations/test/cameras/lsstcam/channels/witness_detector/{DATE}/999999/image.png"
    )
    assert resp.status_code == 404


def test_proxy_etag_revalidation_304_on_fallback_path(
    seeded_client: TestClient,
) -> None:
    # The seeded a.png is non-convention, so this exercises the listed-key GET:
    # a matching If-None-Match comes back as 304 with no body.
    url = (
        f"/api/locations/test/cameras/lsstcam/channels/witness_detector/"
        f"{DATE}/000001/image.png"
    )
    first = seeded_client.get(url)
    etag = first.headers["ETag"]
    assert etag
    resp = seeded_client.get(url, headers={"If-None-Match": etag})
    assert resp.status_code == 304
    assert resp.content == b""


def test_proxy_etag_revalidation_304_on_fast_path(
    seeded_client: TestClient,
) -> None:
    # A convention-named object revalidates on the direct-key GET (no LIST).
    s3 = boto3.client("s3", region_name="us-east-1")
    conv_key = (
        f"lsstcam/{DATE}/witness_detector/000004/"
        f"lsstcam_witness_detector_{DATE}_000004.png"
    )
    s3.put_object(Bucket=TEST_BUCKET, Key=conv_key, Body=b"direct")
    url = (
        f"/api/locations/test/cameras/lsstcam/channels/witness_detector/"
        f"{DATE}/000004/image.png"
    )
    etag = seeded_client.get(url).headers["ETag"]
    resp = seeded_client.get(url, headers={"If-None-Match": etag})
    assert resp.status_code == 304


def test_proxy_range_request_returns_partial_content(
    seeded_client: TestClient,
) -> None:
    s3 = boto3.client("s3", region_name="us-east-1")
    conv_key = (
        f"lsstcam/{DATE}/witness_detector/000005/"
        f"lsstcam_witness_detector_{DATE}_000005.mp4"
    )
    s3.put_object(Bucket=TEST_BUCKET, Key=conv_key, Body=b"0123456789")
    resp = seeded_client.get(
        f"/api/locations/test/cameras/lsstcam/channels/witness_detector/"
        f"{DATE}/000005/video.mp4",
        headers={"Range": "bytes=0-3"},
    )
    assert resp.status_code == 206
    assert resp.content == b"0123"
    assert resp.headers["Content-Range"] == "bytes 0-3/10"


def test_proxy_unsatisfiable_range_returns_416(seeded_client: TestClient) -> None:
    # A Range past EOF must clamp to 416, not surface as an opaque 502.
    s3 = boto3.client("s3", region_name="us-east-1")
    conv_key = (
        f"lsstcam/{DATE}/witness_detector/000005/"
        f"lsstcam_witness_detector_{DATE}_000005.mp4"
    )
    s3.put_object(Bucket=TEST_BUCKET, Key=conv_key, Body=b"0123456789")
    resp = seeded_client.get(
        f"/api/locations/test/cameras/lsstcam/channels/witness_detector/"
        f"{DATE}/000005/video.mp4",
        headers={"Range": "bytes=9999-10000"},
    )
    assert resp.status_code == 416


def test_proxy_rejects_unsafe_seq_segment(seeded_client: TestClient) -> None:
    # A seq segment carrying a quote (header-injection attempt) reaches the
    # handler and is rejected 422 before any S3 key or Content-Disposition is
    # built. (A "/"-bearing traversal is already stopped earlier by routing.)
    resp = seeded_client.get(
        f"/api/locations/test/cameras/lsstcam/channels/witness_detector/"
        f"{DATE}/0%2200/x.jpg"
    )
    assert resp.status_code == 422


def test_night_report_plot_rejects_unsafe_segment(seeded_client: TestClient) -> None:
    # group flows into the S3 key directly; a quote-bearing group is 422.
    resp = seeded_client.get(
        f"/api/locations/test/cameras/lsstcam/night-report/{DATE}/plot/gr%22oup/x.png"
    )
    assert resp.status_code == 422


def test_proxy_no_extension_resolves_by_listing(
    seeded_client: TestClient,
) -> None:
    # Without an extension the convention fast path is skipped entirely; the
    # object is found by listing and the download name takes the real key's
    # extension.
    resp = seeded_client.get(
        f"/api/locations/test/cameras/lsstcam/channels/witness_detector/"
        f"{DATE}/000001/download"
    )
    assert resp.status_code == 200
    assert resp.content == b"x"
    assert (
        resp.headers["Content-Disposition"]
        == f'inline; filename="lsstcam_witness_detector_{DATE}_000001.png"'
    )


def test_proxy_404_when_listed_key_vanishes(
    seeded_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The LIST finds a key but the GET misses (object deleted in between):
    # that's a 404, not a crash.
    import lsst.ts.rubintv.api.proxy as proxy

    monkeypatch.setattr(
        proxy, "_resolve_key", lambda *_a, **_k: "lsstcam/gone/nothing.png"
    )
    resp = seeded_client.get(
        f"/api/locations/test/cameras/lsstcam/channels/witness_detector/"
        f"{DATE}/000001/download"
    )
    assert resp.status_code == 404


def test_admin_gate_rejects_unlisted_user() -> None:
    # Direct dependency check: the seeded test site uses the "*" wildcard, so
    # the named-user branch is exercised against a hand-built location.
    from fastapi import HTTPException
    from lsst.ts.rubintv.api.admin import require_admin
    from lsst.ts.rubintv.config.models import Location

    loc = Location(name="x", title="X", bucket="b", admin_users=["alice"])
    assert require_admin(location=loc, x_auth_user="alice") == "alice"
    with pytest.raises(HTTPException) as excinfo:
        require_admin(location=loc, x_auth_user="bob")
    assert excinfo.value.status_code == 403


def test_site_admin_gate_rejects_unlisted_user() -> None:
    from types import SimpleNamespace
    from typing import cast

    from fastapi import HTTPException
    from lsst.ts.rubintv.api.admin import is_site_admin, require_site_admin
    from lsst.ts.rubintv.config.models import Location
    from lsst.ts.rubintv.state import AppState

    loc = Location(name="x", title="X", bucket="b", admin_users=["alice"])
    state = cast("AppState", SimpleNamespace(models=SimpleNamespace(locations=[loc])))
    assert require_site_admin(state=state, x_auth_user="alice") == "alice"
    with pytest.raises(HTTPException) as excinfo:
        require_site_admin(state=state, x_auth_user="bob")
    assert excinfo.value.status_code == 403
    # The non-raising helper backing /admin/status agrees with the gate.
    assert is_site_admin(state, "alice") is True
    assert is_site_admin(state, "bob") is False
    assert is_site_admin(state, None) is False


class _FakeAdminRedis:
    """The two coroutines RedisInputs calls on a live connection."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}
        self.flushed = False

    async def set(self, key: str, value: str) -> None:
        self.store[key] = value

    async def flushdb(self) -> None:
        self.flushed = True

    async def aclose(self) -> None:  # called by RedisInputs.stop at shutdown
        pass


def test_admin_actions_write_through_redis(seeded_client: TestClient) -> None:
    # Enable the (normally unconfigured) Redis with a fake connection, then
    # drive the site-wide admin actions end to end.
    state = seeded_client.app.state.app_state  # type: ignore[attr-defined]
    fake = _FakeAdminRedis()
    state.redis._redis = fake  # noqa: SLF001 - test injection
    headers = {"X-Auth-User": "testadmin"}

    resp = seeded_client.post(
        "/api/admin/controls/set",
        json={"key": "RUBINTV_CONTROL_AOS_PIPELINE", "value": "danish"},
        headers=headers,
    )
    assert resp.status_code == 200
    assert fake.store["RUBINTV_CONTROL_AOS_PIPELINE"] == "danish"

    resp = seeded_client.post(
        "/api/admin/witness-detector",
        json={"key": "", "value": "203"},
        headers=headers,
    )
    assert resp.status_code == 200
    assert fake.store[state.settings.witness_detector_key] == "203"

    resp = seeded_client.post("/api/admin/flush-redis", headers=headers)
    assert resp.status_code == 200
    assert fake.flushed is True


def test_admin_action_503_when_redis_drops_mid_request(
    seeded_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from lsst.ts.rubintv.data.redis_inputs import RedisUnavailable

    state = seeded_client.app.state.app_state  # type: ignore[attr-defined]
    state.redis._redis = _FakeAdminRedis()  # noqa: SLF001 - enables the gate

    async def _gone(_key: str, _value: str) -> None:
        raise RedisUnavailable("connection lost")

    monkeypatch.setattr(state.redis, "set_value", _gone)
    resp = seeded_client.post(
        "/api/admin/controls/set",
        json={"key": "RUBINTV_CONTROL_AOS_PIPELINE", "value": "V"},
        headers={"X-Auth-User": "testadmin"},
    )
    assert resp.status_code == 503


def test_proxy_502_on_upstream_error(
    seeded_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from botocore.exceptions import ClientError

    # TestClient types .app as a bare ASGIApp; FastAPI's .state is real.
    state = seeded_client.app.state.app_state  # type: ignore[attr-defined]
    client = state.s3.client_for("test")

    def _boom(*_a: object, **_k: object) -> None:
        raise ClientError({"Error": {"Code": "AccessDenied"}}, "GetObject")

    monkeypatch.setattr(client, "get_object", _boom)
    resp = seeded_client.get(
        f"/api/locations/test/cameras/lsstcam/channels/witness_detector/"
        f"{DATE}/000001/image.png"
    )
    assert resp.status_code == 502
