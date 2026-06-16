"""RA-service liveness: store, internal endpoints, and UI fan-out."""

from __future__ import annotations

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from rubintv.app import create_app
from rubintv.config.settings import Settings
from rubintv.data.heartbeats import HeartbeatStore
from rubintv.ws.internal import Heartbeat
from tests.conftest import TEST_BUCKET


def test_store_live_within_ttl_then_stale() -> None:
    store = HeartbeatStore()
    revived = store.beat("auxtel_metadata", ttl=30, location="summit")
    # First beat for an unknown service counts as a revive (stale -> live).
    assert revived is True
    snap = store.all()["auxtel_metadata"]
    assert snap["live"] is True
    assert snap["location"] == "summit"

    # A re-beat while still live is not a revive.
    assert store.beat("auxtel_metadata", ttl=30) is False


def test_store_newly_stale_reports_once() -> None:
    store = HeartbeatStore()
    store.beat("svc", ttl=30)
    # Age the beat past its ttl deterministically (no wall-clock sleep).
    store._beats["svc"].last_seen -= 31  # noqa: SLF001 - test setup
    # Now stale: reported exactly once, then the lapsed beat is dropped so it
    # isn't reported again until it beats anew.
    assert store.newly_stale() == ["svc"]
    assert store.newly_stale() == []
    assert "svc" not in store.all()


@pytest.fixture
def hb_client(settings: Settings):  # type: ignore[no-untyped-def]
    with mock_aws():
        s3 = boto3.client("s3", region_name="us-east-1")
        s3.create_bucket(Bucket=TEST_BUCKET)
        app = create_app(settings)
        with TestClient(app) as client:
            yield client


def test_post_heartbeat_records_and_surfaces(hb_client) -> None:  # type: ignore[no-untyped-def]
    resp = hb_client.post(
        "/internal/heartbeats",
        json={"service": "auxtel_isr_runner", "ttl": 30, "location": "summit"},
    )
    assert resp.status_code == 202

    status = hb_client.get("/api/health/services")
    assert status.status_code == 200
    services = status.json()["services"]
    assert services["auxtel_isr_runner"]["live"] is True


def test_post_heartbeat_rejects_bad_body(hb_client) -> None:  # type: ignore[no-untyped-def]
    # Missing the required service name.
    assert hb_client.post("/internal/heartbeats", json={"ttl": 5}).status_code == 422
    # ttl must be positive.
    bad_ttl = hb_client.post(
        "/internal/heartbeats", json={"service": "x", "ttl": 0}
    )
    assert bad_ttl.status_code == 422


def test_internal_ws_beat_marks_service_live(hb_client) -> None:  # type: ignore[no-untyped-def]
    with hb_client.websocket_connect("/internal/heartbeats") as ws:
        ws.send_json({"service": "allsky", "ttl": 30})
        # No reply expected for a good beat; verify via the status read.
        services = hb_client.get("/api/health/services").json()["services"]
        assert services["allsky"]["live"] is True


def test_internal_ws_bad_frame_gets_error(hb_client) -> None:  # type: ignore[no-untyped-def]
    with hb_client.websocket_connect("/internal/heartbeats") as ws:
        ws.send_json({"ttl": 5})  # missing service name
        assert "error" in ws.receive_json()


def test_browser_services_snapshot_and_delta(hb_client) -> None:  # type: ignore[no-untyped-def]
    state = hb_client.app.state.app_state
    state.heartbeats.beat("comcam", ttl=30, location="summit")
    with hb_client.websocket_connect("/ws") as ws:
        ws.send_json({"action": "subscribe", "topic": "services", "location": ""})
        snap = ws.receive_json()
        assert snap["type"] == "serviceStatus"
        assert snap["data"]["services"]["comcam"]["live"] is True

        # A fresh beat that revives a service fans out the site-wide snapshot.
        state.heartbeat_svc.record(Heartbeat(service="tma", ttl=30))
        delta = ws.receive_json()
        assert delta["type"] == "serviceStatus"
        assert "tma" in delta["data"]["services"]
