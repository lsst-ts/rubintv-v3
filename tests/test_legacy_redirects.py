"""Legacy deep-link redirects: old URL shapes -> new SPA routes.

The previous app's HTML endpoints used a different URL shape (dates/channels in
path segments, type/visit events, reversed current/{channel}). These 301 to the
new-app equivalent under the same /rubintv prefix. Redirects are pure URL
rewriting — they don't touch S3 — so the shared ``client`` fixture (which the
PrefixedTestClient wraps to add the prefix) is enough.

Requests below are written unprefixed; the client adds the prefix, and the
asserted Location values carry it, mirroring what a browser sees.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.conftest import TEST_PREFIX


def _location(client: TestClient, path: str) -> str:
    resp = client.get(path, follow_redirects=False)
    assert resp.status_code == 301, (path, resp.status_code)
    return resp.headers["location"]


def test_admin_is_not_a_redirect(client: TestClient) -> None:
    # /admin must NOT be a legacy redirect: the old and new URLs are
    # identical, so a redirect would loop (ERR_TOO_MANY_REDIRECTS). It is
    # served by the SPA catch-all instead — so the response is anything but a
    # self-redirect 301.
    resp = client.get("/admin", follow_redirects=False)
    if resp.status_code == 301:
        assert resp.headers.get("location") != f"{TEST_PREFIX}/admin"


def test_slac_aliases_to_usdf(client: TestClient) -> None:
    assert _location(client, "/slac") == f"{TEST_PREFIX}/usdf"


def test_slac_tail_first_hop_swaps_location(client: TestClient) -> None:
    # /slac is the old usdf alias: the first hop just swaps the segment to the
    # equivalent /usdf legacy URL (same shape, query intact), landing on the
    # real legacy handler for the second hop.
    assert (
        _location(client, "/slac/lsstcam/date/2025-04-22?seq_num=7")
        == f"{TEST_PREFIX}/usdf/lsstcam/date/2025-04-22?seq_num=7"
    )


def test_slac_tail_chains_to_spa_route(client: TestClient) -> None:
    # Following both hops, a /slac deep link ends at the correct SPA URL — the
    # date moves to a query param and the location is usdf. This proves the two
    # hops chain rather than just asserting the intermediate.
    resp = client.get("/slac/lsstcam/date/2025-04-22", follow_redirects=True)
    # The SPA isn't built in tests, so the final GET 404s at the catch-all —
    # what matters is the resolved URL the redirects walked to.
    assert resp.request.url.path == f"{TEST_PREFIX}/usdf/lsstcam"
    assert resp.request.url.query == b"date=2025-04-22"


def test_cluster_status_drops_location(client: TestClient) -> None:
    # Old shape was /{location}/cluster-status (two segments); the new app's
    # cluster status is deployment-wide, so the location is discarded.
    assert _location(client, "/summit/cluster-status") == f"{TEST_PREFIX}/detectors"


def test_historical_collapses_to_bare_camera(client: TestClient) -> None:
    assert (
        _location(client, "/summit/lsstcam/historical")
        == f"{TEST_PREFIX}/summit/lsstcam"
    )


def test_date_moves_to_query(client: TestClient) -> None:
    assert (
        _location(client, "/summit/lsstcam/date/2025-04-22")
        == f"{TEST_PREFIX}/summit/lsstcam?date=2025-04-22"
    )


def test_date_historical_sentinel_dropped(client: TestClient) -> None:
    # The "historical" sentinel means newest-with-data; the new bare camera
    # route resolves that, so no date param is emitted.
    assert (
        _location(client, "/summit/lsstcam/date/historical")
        == f"{TEST_PREFIX}/summit/lsstcam"
    )


def test_date_carries_seq_num_as_seq_filter(client: TestClient) -> None:
    # The old ?seq_num= highlight list survives as the new table's
    # ?seq_filter=, alongside the moved date.
    assert (
        _location(client, "/summit/lsstcam/date/2025-04-22?seq_num=42")
        == f"{TEST_PREFIX}/summit/lsstcam?seq_filter=42&date=2025-04-22"
    )


def test_night_report_rename(client: TestClient) -> None:
    assert (
        _location(client, "/summit/lsstcam/night_report")
        == f"{TEST_PREFIX}/summit/lsstcam/night-report"
    )


def test_night_report_date_to_query(client: TestClient) -> None:
    assert (
        _location(client, "/summit/lsstcam/night_report/2025-04-22")
        == f"{TEST_PREFIX}/summit/lsstcam/night-report?date=2025-04-22"
    )


def test_current_segment_order_swaps(client: TestClient) -> None:
    assert (
        _location(client, "/summit/lsstcam/current/calexp_mosaic")
        == f"{TEST_PREFIX}/summit/lsstcam/calexp_mosaic/current"
    )


def test_event_by_type_and_visit(client: TestClient) -> None:
    # visit = day_obs (YYYYMMDD) + zero-padded seq; decoded to date + int seq.
    loc = _location(
        client,
        "/summit/lsstcam/event?type=calexp_mosaic&visit=2025042200233",
    )
    assert loc == f"{TEST_PREFIX}/summit/lsstcam/calexp_mosaic?date=2025-04-22&seq=233"


def test_event_by_split_form(client: TestClient) -> None:
    loc = _location(
        client,
        "/summit/lsstcam/event?channel_name=witness_detector"
        "&date_str=2025-04-22&seq_num=7",
    )
    assert loc == f"{TEST_PREFIX}/summit/lsstcam/witness_detector?date=2025-04-22&seq=7"


def test_event_by_key(client: TestClient) -> None:
    key = (
        "lsstcam/2025-04-22/calexp_mosaic/000233/"
        "lsstcam_calexp_mosaic_2025-04-22_000233.png"
    )
    loc = _location(client, f"/summit/lsstcam/event?key={key}")
    assert loc == f"{TEST_PREFIX}/summit/lsstcam/calexp_mosaic?date=2025-04-22&seq=233"


def test_event_without_addressing_is_404(client: TestClient) -> None:
    resp = client.get("/summit/lsstcam/event", follow_redirects=False)
    assert resp.status_code == 404


def test_event_malformed_visit_is_404(client: TestClient) -> None:
    resp = client.get(
        "/summit/lsstcam/event?type=x&visit=2025042200abc",
        follow_redirects=False,
    )
    assert resp.status_code == 404
