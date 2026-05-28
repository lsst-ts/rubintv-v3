"""REST API endpoints over a moto-seeded store."""

from __future__ import annotations

import json
import time
from collections.abc import Iterator

import boto3
import pytest
from fastapi.testclient import TestClient
from moto import mock_aws

from rubintv.app import create_app
from rubintv.config.settings import Settings
from tests.conftest import TEST_BUCKET

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
                [{"type": "multiline", "key": "s", "title": "S", "content": "hi"}]
            ).encode(),
        )
        app = create_app(settings)
        with TestClient(app) as client:
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


def test_unknown_location_404(seeded_client: TestClient) -> None:
    assert seeded_client.get("/api/locations/nope").status_code == 404


def test_unknown_camera_404(seeded_client: TestClient) -> None:
    resp = seeded_client.get("/api/locations/test/cameras/ghost")
    assert resp.status_code == 404


def test_camera_detail(seeded_client: TestClient) -> None:
    resp = seeded_client.get("/api/locations/test/cameras/lsstcam")
    body = resp.json()
    assert body["has_mosaic"] is True
    assert {c["name"] for c in body["channels"]} >= {"witness_detector", "day_movie"}


def test_calendar(seeded_client: TestClient) -> None:
    resp = seeded_client.get("/api/locations/test/cameras/lsstcam/calendar")
    assert resp.json()["dates"] == [DATE]


def test_date_payload(seeded_client: TestClient) -> None:
    resp = seeded_client.get(f"/api/locations/test/cameras/lsstcam/dates/{DATE}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["channels"]["witness_detector"] == [1, 2]
    assert body["extensions"]["witness_detector"]["default"] == "png"
    assert body["extensions"]["witness_detector"]["exceptions"] == {"2": "jpg"}
    assert body["per_day"]["day_movie"].endswith("m.mp4")
    assert body["has_night_report"] is True
    assert body["metadata"]["1"]["Exposure time"] == 30.0


def test_bad_date_422(seeded_client: TestClient) -> None:
    resp = seeded_client.get("/api/locations/test/cameras/lsstcam/dates/2026-13")
    assert resp.status_code == 422


def test_night_report(seeded_client: TestClient) -> None:
    resp = seeded_client.get(
        f"/api/locations/test/cameras/lsstcam/night-report/{DATE}"
    )
    body = resp.json()
    assert body["exists"] is True
    assert body["text"][0]["content"] == "hi"


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
    resp = seeded_client.get(
        f"/api/locations/test/cameras/lsstcam/channels/witness_detector/{DATE}/000001/a.png"
    )
    assert resp.status_code == 200
    assert resp.content == b"x"
    assert "Cache-Control" in resp.headers
